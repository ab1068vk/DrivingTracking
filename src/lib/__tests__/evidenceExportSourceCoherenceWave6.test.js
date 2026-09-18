import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from './helpers/fakeTripIndexedDb';

/**
 * HPR-019, Wave 6 correction — source coherence through detail hydration.
 *
 * THE SURVIVING DEFECT. `streamTripEvidence` compared source identity when it
 * read each Q1 page, then hydrated that page's ids with unversioned canonical
 * detail reads. A population that fits in one ordinary page has no *second* page
 * request, so nothing ever rejected a source that moved while those details were
 * being read. The walk returned `complete: true` under the first page's
 * snapshot, and the manifest signed `population.complete: true` over evidence
 * assembled from more than one canonical state — with a valid signature.
 *
 * CODEX reproduced it with the real repository: 26 trips, 52 route points before,
 * 60 after, and an exported total of 57 — a number that never existed.
 *
 * THE INVARIANT. No evidence derived from a changed canonical source may be
 * offered as part of an artifact claiming the earlier snapshot. So coherence is
 * checked after every hydration chunk, **before** that chunk reaches the artifact,
 * and once more before completion is claimed.
 *
 * WHY THE CHECK CANNOT BE A NAIVE BEFORE/AFTER REVISION COMPARE. Ordinary read
 * preparation persists a rescore, so `getFullById` advances the query revision on
 * every call — a walk's own hydration would trip such a check on every export.
 * The correction therefore also gives the export a read that does not write. Both
 * halves are pinned below; neither works alone.
 */

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));

const storageDouble = () => {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
  };
};

const route = (count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.7 + (index * 0.00008),
  lng: -79.4,
  speed_kmh: 30,
  speed_limit_kmh: 50,
  timestamp: new Date(Date.UTC(2026, 8, 17, 8, 0, index)).toISOString(),
}));

const trip = (id, points = 2) => ({
  id,
  status: 'completed',
  start_time: '2026-09-17T08:00:00.000Z',
  end_time: '2026-09-17T08:01:00.000Z',
  distance_km: 0.25,
  duration_seconds: 60,
  route_points: route(points),
});

describe('HPR-019 Wave 6 correction — an artifact cannot span two canonical states', () => {
  let repository;
  let lab;
  let stream;
  let integrity;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'wave6-correction' }) },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
    repository = await import('@/lib/localTripRepository');
    lab = await import('@/lib/trackingExportLab');
    stream = await import('@/lib/trackingEvidenceExport');
    integrity = await import('@/lib/exportIntegrity');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The export's own reads, wired the way production wires them. */
  const walk = (overrides = {}) => stream.streamTripEvidence({
    readPage: (request) => repository.queryTripHistoryPage(request),
    readTrip: (id) => repository.localTripRepository.readFullByIdForExport(id),
    readSourceSnapshot: () => repository.readP7QuerySnapshot(),
    onChunk: () => {},
    ...overrides,
  });

  const seed = async (count, points = 2) => {
    const ids = Array.from({ length: count }, (_, index) => `w6-${String(index).padStart(2, '0')}`);
    for (const id of ids) await repository.localTripRepository.create(trip(id, points));
    return ids;
  };

  // -------------------------------------------------------------------------
  // The two halves of the correction, pinned separately.
  // -------------------------------------------------------------------------

  it('an export read does not write, so it cannot move the source itself', async () => {
    await seed(1);

    // The ordinary detail read persists a rescore, which advances the query
    // revision on EVERY call. A coherence check built on that read would refuse
    // every export it was asked to protect.
    const beforeOrdinary = await repository.readP7QuerySnapshot();
    await repository.localTripRepository.getFullById('w6-00');
    const afterOrdinary = await repository.readP7QuerySnapshot();
    expect(afterOrdinary.revision).toBeGreaterThan(beforeOrdinary.revision);

    // The export read returns the same prepared evidence and leaves the source
    // exactly where it found it.
    const beforeExport = await repository.readP7QuerySnapshot();
    const exported = await repository.localTripRepository.readFullByIdForExport('w6-00');
    const afterExport = await repository.readP7QuerySnapshot();

    expect(afterExport.revision).toBe(beforeExport.revision);
    expect(afterExport.generation).toBe(beforeExport.generation);
    expect(exported.id).toBe('w6-00');
    expect(exported.route_points).toHaveLength(2);
    expect(Array.isArray(exported.driving_events)).toBe(true);
  });

  it('the export read still applies current scoring preparation', async () => {
    await seed(1);
    const ordinary = await repository.localTripRepository.getFullById('w6-00');
    const exported = await repository.localTripRepository.readFullByIdForExport('w6-00');

    expect(exported.route_points).toEqual(ordinary.route_points);
    expect(exported.driving_events).toEqual(ordinary.driving_events);
    expect(exported.score_provenance?.scoring_version)
      .toBe(ordinary.score_provenance?.scoring_version);
  });

  // -------------------------------------------------------------------------
  // The CODEX scenario, as a permanent regression.
  // -------------------------------------------------------------------------

  it('RED: a mutation during terminal-page hydration refuses instead of signing mixed evidence', async () => {
    // 26 trips: one ordinary Q1 page (limit 200), two hydration chunks (size 25).
    // There is no second page, so no later cursor request can reject anything.
    const ids = await seed(26);

    const accumulator = stream.createEvidenceSummaryAccumulator();
    let mutated = false;
    const released = [];

    const scan = await walk({
      onChunk: async ({ trips }) => {
        released.push(...trips.map((entry) => entry.id));
        accumulator.addChunk({
          routeQualityRows: lab.buildRouteQualityRows(trips),
          eventRows: lab.buildTripEventExportRows(trips),
        });
        if (mutated) return;
        mutated = true;
        expect(trips).toHaveLength(25);
        const unread = ids.find((id) => !trips.some((entry) => entry.id === id));
        await repository.localTripRepository.update(trips[0].id, { route_points: route(5) });
        await repository.localTripRepository.update(unread, { route_points: route(7) });
      },
    });

    // The walk refuses. It does not report a complete population under a
    // snapshot that no longer describes the evidence it collected.
    expect(scan.complete).toBe(false);
    expect(scan.failure.code).toBe(stream.EVIDENCE_FAILURE.SOURCE_MOVED);

    // And the second chunk — the one that would have carried post-mutation
    // evidence — never reached the artifact at all. The accumulator therefore
    // holds exactly the 25 trips read before the source moved, at their
    // pre-mutation two points each.
    expect(released).toHaveLength(25);
    expect(accumulator.totals().trip_count).toBe(25);
    expect(accumulator.totals().retained_route_point_total).toBe(50);

    let canonicalRouteTotal = 0;
    for (const id of ids) {
      canonicalRouteTotal += (await repository.localTripRepository.readFullByIdForExport(id)).route_points.length;
    }
    expect(canonicalRouteTotal).toBe(60);
    // 57 was the mixed number the frozen source produced: neither 52 nor 60.
    expect(accumulator.totals().retained_route_point_total).not.toBe(57);
  });

  it('RED: the refused walk can never become a signed complete artifact', async () => {
    const ids = await seed(26);
    const accumulator = stream.createEvidenceSummaryAccumulator();
    let mutated = false;

    const scan = await walk({
      onChunk: async ({ trips }) => {
        accumulator.addChunk({
          routeQualityRows: lab.buildRouteQualityRows(trips),
          eventRows: lab.buildTripEventExportRows(trips),
        });
        if (mutated) return;
        mutated = true;
        await repository.localTripRepository.update(trips[0].id, { route_points: route(5) });
        await repository.localTripRepository.update(
          ids.find((id) => !trips.some((entry) => entry.id === id)),
          { route_points: route(7) },
        );
      },
    });

    const payload = lab.buildTechnicalReportPayload({
      summary: {
        population: { complete: scan.complete, source: scan.snapshot },
        totals: accumulator.totals(),
        extracts: accumulator.extracts(),
      },
    });
    const signed = await integrity.signExport(payload);

    // The signature is still real; what it authenticates is now truthful.
    await expect(integrity.verifyExport(signed)).resolves.toMatchObject({ valid: true });
    expect(signed.payload.population.complete).toBe(false);
  });

  it('control 9: a one-trip population is protected without a second chunk or page', async () => {
    await seed(1);
    let mutated = false;

    const scan = await walk({
      onChunk: async ({ trips }) => {
        if (mutated) return;
        mutated = true;
        expect(trips).toHaveLength(1);
        await repository.localTripRepository.update(trips[0].id, { route_points: route(9) });
      },
    });

    // Correctness must not depend on there being a later chunk to catch it.
    expect(scan.complete).toBe(false);
    expect(scan.failure.code).toBe(stream.EVIDENCE_FAILURE.SOURCE_MOVED);
  });

  it('control 3: a mutation after the last detail but before completion is refused', async () => {
    await seed(3);
    let chunks = 0;

    const scan = await walk({
      chunkSize: 3,
      onChunk: async () => {
        chunks += 1;
        // Every id is hydrated and released; the source then moves before the
        // walk is allowed to call itself complete.
        await repository.localTripRepository.update('w6-00', { route_points: route(11) });
      },
    });

    expect(chunks).toBe(1);
    expect(scan.complete).toBe(false);
    expect(scan.failure.code).toBe(stream.EVIDENCE_FAILURE.SOURCE_MOVED);
  });

  it('control 1: a mutation during a non-terminal page is refused too', async () => {
    const ids = await seed(6);
    let mutated = false;

    const scan = await walk({
      pageLimit: 2,
      chunkSize: 1,
      onChunk: async () => {
        if (mutated) return;
        mutated = true;
        await repository.localTripRepository.update(ids[5], { route_points: route(13) });
      },
    });

    expect(scan.complete).toBe(false);
    // Whichever guard fires first, the export stops; it never combines states.
    expect([
      stream.EVIDENCE_FAILURE.SOURCE_MOVED,
      stream.EVIDENCE_FAILURE.PAGE_UNAVAILABLE,
    ]).toContain(scan.failure.code);
  });

  // -------------------------------------------------------------------------
  // Controls that must keep working
  // -------------------------------------------------------------------------

  it('control 4: an unchanged source completes normally', async () => {
    const ids = await seed(26);
    const accumulator = stream.createEvidenceSummaryAccumulator();
    const released = [];

    const scan = await walk({
      onChunk: ({ trips }) => {
        released.push(...trips.map((entry) => entry.id));
        accumulator.addChunk({
          routeQualityRows: lab.buildRouteQualityRows(trips),
          eventRows: lab.buildTripEventExportRows(trips),
        });
      },
    });

    expect(scan.complete).toBe(true);
    expect(scan.failure).toBeNull();
    expect(released).toHaveLength(ids.length);
    expect(accumulator.totals().trip_count).toBe(26);
    expect(accumulator.totals().retained_route_point_total).toBe(52);
  });

  it('control 7: bounded residency survives the coherence check', async () => {
    await seed(26);
    let widest = 0;

    const scan = await walk({
      onChunk: ({ trips }) => { widest = Math.max(widest, trips.length); },
    });

    expect(scan.complete).toBe(true);
    expect(widest).toBe(25);
  });

  it('control 8: an empty history still completes', async () => {
    const scan = await walk();

    expect(scan.complete).toBe(true);
    expect(scan.tripCount).toBe(0);
    expect(scan.failure).toBeNull();
  });

  it('control 6: a detail failure is still fatal, and is not reported as source movement', async () => {
    await seed(2);
    const scan = await walk({
      chunkSize: 1,
      readTrip: (id) => (id === 'w6-00'
        ? Promise.reject(new Error('Trip not found'))
        : repository.localTripRepository.readFullByIdForExport(id)),
    });

    expect(scan.complete).toBe(false);
    expect(scan.failure.code).toBe(stream.EVIDENCE_FAILURE.DETAIL_READ_FAILED);
  });

  it('the ordinary detail read cannot be used here, because reading with it moves the source', async () => {
    await seed(4);

    // Nothing else mutates anything. The walk still refuses, because
    // `getFullById` persists its own preparation and so advances the very
    // identity the coherence check is comparing. This is why the correction
    // needed a non-writing read as well as a check.
    const scan = await walk({
      chunkSize: 2,
      readTrip: (id) => repository.localTripRepository.getFullById(id),
    });

    expect(scan.complete).toBe(false);
    expect(scan.failure.code).toBe(stream.EVIDENCE_FAILURE.SOURCE_MOVED);
  });

  it('the production page wires the export read and the snapshot authority', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const page = readFileSync(resolve(process.cwd(), 'src/pages/TrackingReportsLab.jsx'), 'utf8');

    expect(page).toMatch(/readFullByIdForExport/);
    expect(page).toMatch(/readSourceSnapshot/);
    // The writing read must not be the one an export uses.
    expect(page).not.toMatch(/readTrip: \(id\) => tripService\.getFullById\(id\)/);
  });
});
