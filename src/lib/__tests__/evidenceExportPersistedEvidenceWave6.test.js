import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from './helpers/fakeTripIndexedDb';

/**
 * HPR-019 RED B2 (mandatory) — the event discriminator, on real persisted events.
 *
 * WHY THIS FILE EXISTS. The earlier synthetic event experiment was ruled
 * inconclusive, and tracing showed why: `localTripRepository.create` runs the
 * scoring pipeline and **recomputes `driving_events` from the route**. A caller
 * that hands `create` a hand-written event array gets it back in the return
 * value and then finds `driving_events: []` in canonical storage — which is
 * exactly the shape of an inconclusive experiment. Persistence does not reject
 * the invented object loudly; it replaces it.
 *
 * SO THE TRIPS HERE CARRY ROUTES, NOT EVENTS. Each fixture is a route whose
 * speeds genuinely contain the behaviour, and the engine detects, scores and
 * persists the event itself. The resulting record is the production shape,
 * because production produced it:
 *
 *   {type, severity, lat, lng, timestamp, point_index, value, speed_kmh, ...}
 *
 * Every assertion below first proves the event is in canonical storage, and only
 * then compares that storage with the P7 projection row the export consumed.
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
    values,
    get length() { return values.size; },
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
  };
};

const settings = { units: 'metric' };

const START_MS = Date.UTC(2026, 3, 2, 8, 0, 0);
const at = (second) => new Date(START_MS + (second * 1000)).toISOString();

/**
 * A completed trip whose ROUTE contains a hard deceleration above the posted
 * limit. The engine detects the harsh brake and the speeding during `create`;
 * nothing here hands it a pre-made event.
 */
const tripWithDetectableEvidence = (id) => {
  const points = [];
  for (let second = 0; second < 20; second += 1) {
    points.push({
      lat: 43.65 + (second * 0.0009), lng: -79.38, speed_kmh: 60, speed_limit_kmh: 50, timestamp: at(second),
    });
  }
  // 60 km/h to 12 km/h in one second: a real harsh-brake signature.
  points.push({ lat: 43.65 + (20 * 0.0009), lng: -79.38, speed_kmh: 12, speed_limit_kmh: 50, timestamp: at(20) });
  for (let second = 21; second < 40; second += 1) {
    points.push({
      lat: 43.65 + (second * 0.0009), lng: -79.38, speed_kmh: 12, speed_limit_kmh: 50, timestamp: at(second),
    });
  }
  return {
    id,
    status: 'completed',
    start_time: at(0),
    end_time: at(40),
    distance_km: 3.2,
    duration_seconds: 40,
    route_points: points,
  };
};

/** A completed trip driven steadily under the limit: a route, and no events. */
const tripWithoutDetectableEvidence = (id) => ({
  id,
  status: 'completed',
  start_time: at(0),
  end_time: at(30),
  distance_km: 0.25,
  duration_seconds: 30,
  route_points: Array.from({ length: 30 }, (_, second) => ({
    lat: 43.70 + (second * 0.00008),
    lng: -79.40,
    speed_kmh: 30,
    speed_limit_kmh: 50,
    timestamp: at(second),
  })),
});

describe('HPR-019 RED B2 — a persisted event survives storage but not the projection', () => {
  let repository;
  let exportLab;
  let evidenceStream;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'hpr019' }) },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
    repository = await import('@/lib/localTripRepository');
    exportLab = await import('@/lib/trackingExportLab');
    evidenceStream = await import('@/lib/trackingEvidenceExport');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a hand-written event array does not survive the canonical write', async () => {
    // The precondition the earlier experiment missed, stated as a fact about
    // current production rather than as an assumption. `create` recomputes
    // `driving_events` from the route, so an invented event is replaced, and any
    // export RED built on one proves nothing.
    const saved = await repository.localTripRepository.create({
      ...tripWithoutDetectableEvidence('trip-invented'),
      driving_events: [{
        type: 'harsh_brake', timestamp: at(1), value: 4.8, speed_kmh: 52,
        severity: 'medium', source: 'gps_events', point_index: 1,
      }],
    });
    expect(saved.driving_events).toHaveLength(1);

    const canonical = await repository.localTripRepository.getFullById('trip-invented');
    expect(canonical.driving_events).toEqual([]);
  });

  it('a route with real behaviour persists real, engine-detected evidence', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));

    const canonical = await repository.localTripRepository.getFullById('trip-evidence-1');

    expect(Array.isArray(canonical.driving_events)).toBe(true);
    const brake = canonical.driving_events.find((event) => event.type === 'harsh_brake');
    expect(brake).toBeTruthy();
    expect(brake.severity).toBe('high');
    expect(brake.point_index).toBe(19);
    expect(brake.value).toBeGreaterThan(0);
    const speeding = canonical.driving_events.find((event) => event.type === 'speeding');
    expect(speeding).toBeTruthy();
    expect(speeding.speed_limit_kmh).toBe(50);
    expect(canonical.harsh_brakes_count).toBe(1);
    expect(Array.isArray(canonical.route_points)).toBe(true);
    expect(canonical.route_points.length).toBe(40);
  });

  it('the P7 projection row that the export consumed carries neither payload', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));

    const page = await repository.queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 200,
    });
    const row = page.data.find((entry) => entry.id === 'trip-evidence-1');

    expect(row).toBeTruthy();
    // Not "empty" — absent. That distinction is the whole defect.
    expect('driving_events' in row).toBe(false);
    expect('route_points' in row).toBe(false);
    // The projection declares an event-count field, and even that is not the
    // evidence. (It reads `null` here for a trip whose canonical record holds a
    // detected harsh brake; that is a projection-fidelity observation recorded
    // as a non-blocking follow-up, not something this export path may paper
    // over by reading the projection instead of the record.)
    expect('harsh_brakes_count' in row).toBe(true);
    expect(row.harsh_brakes_count).not.toBe(
      (await repository.localTripRepository.getFullById('trip-evidence-1')).harsh_brakes_count
    );
    expect(exportLab.tripEvidenceRepresentation(row))
      .toBe(exportLab.TRIP_EVIDENCE_REPRESENTATION.SUMMARY);
  });

  it('RED: feeding the projection row to the event builder loses the event', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));
    const page = await repository.queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 200,
    });
    const row = page.data.find((entry) => entry.id === 'trip-evidence-1');
    const canonical = await repository.localTripRepository.getFullById('trip-evidence-1');

    const fromCanonical = exportLab.buildTripEventExportRows([canonical], settings);
    const fromProjection = exportLab.buildTripEventExportRows([row], settings);

    // The canonical record yields the recorded event.
    const brakeRow = fromCanonical.find((entry) => entry.event_type === 'harsh_brake');
    expect(brakeRow).toBeTruthy();
    expect(brakeRow.trip_id).toBe('trip-evidence-1');

    // The projection row yields no recorded event. Before the correction it
    // yielded nothing at all, which a reader could only take as "no events".
    expect(fromProjection.some((entry) => entry.event_type === 'harsh_brake')).toBe(false);
    expect(fromProjection).toHaveLength(1);
    expect(fromProjection[0].event_type).toBe(evidenceStream.EVIDENCE_NOT_INCLUDED);
  });

  it('RED: feeding the projection row to the route builder loses the route', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));
    const page = await repository.queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 200,
    });
    const row = page.data.find((entry) => entry.id === 'trip-evidence-1');
    const canonical = await repository.localTripRepository.getFullById('trip-evidence-1');

    const [fromCanonical] = exportLab.buildRouteQualityRows([canonical], settings);
    const [fromProjection] = exportLab.buildRouteQualityRows([row], settings);

    expect(fromCanonical.route_evidence).toBe('recorded');
    expect(fromCanonical.retained_route_points).toBe(40);
    expect(fromCanonical.speed_limit_samples).toBe(40);

    expect(fromProjection.route_evidence).toBe('not included');
    expect(fromProjection.retained_route_points).not.toBe(0);
    expect(fromProjection.speed_limit_samples).not.toBe(0);
  });

  it('the corrected export walk recovers the evidence the projection could not carry', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-2'));

    const accumulator = evidenceStream.createEvidenceSummaryAccumulator();
    const result = await evidenceStream.streamTripEvidence({
      readPage: (request) => repository.queryTripHistoryPage(request),
      readTrip: (id) => repository.localTripRepository.readFullByIdForExport(id),
      readSourceSnapshot: () => repository.readP7QuerySnapshot(),
      chunkSize: 1,
      onChunk: ({ trips }) => {
        accumulator.addChunk({
          routeQualityRows: exportLab.buildRouteQualityRows(trips, settings),
          eventRows: exportLab.buildTripEventExportRows(trips, settings),
        });
      },
    });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(2);

    const totals = accumulator.totals();
    expect(totals.trip_count).toBe(2);
    expect(totals.route_evidence_trip_count).toBe(2);
    expect(totals.route_evidence_unavailable_trip_count).toBe(0);
    expect(totals.retained_route_point_total).toBe(80);
    expect(totals.event_row_count).toBeGreaterThanOrEqual(2);
    expect(totals.trips_with_events_count).toBe(2);
    expect(totals.event_evidence_unavailable_trip_count).toBe(0);
  });

  it('the artifact built from that walk claims exactly the population it read', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-2'));
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-3'));

    const accumulator = evidenceStream.createEvidenceSummaryAccumulator();
    const scan = await evidenceStream.streamTripEvidence({
      readPage: (request) => repository.queryTripHistoryPage(request),
      readTrip: (id) => repository.localTripRepository.readFullByIdForExport(id),
      readSourceSnapshot: () => repository.readP7QuerySnapshot(),
      onChunk: ({ trips }) => {
        accumulator.addChunk({
          routeQualityRows: exportLab.buildRouteQualityRows(trips, settings),
          eventRows: exportLab.buildTripEventExportRows(trips, settings),
        });
      },
    });

    const payload = exportLab.buildTechnicalReportPayload({
      summary: {
        population: { complete: scan.complete, source: scan.snapshot },
        totals: accumulator.totals(),
        extracts: accumulator.extracts(),
      },
      settings,
      now: '2026-04-02T09:00:00.000Z',
    });

    // The number the manifest card shows and the number inside the signed bytes
    // are the same number, and both came from this walk.
    expect(payload.population.represented_trip_count).toBe(3);
    expect(payload.counts.trip_count).toBe(3);
    expect(payload.population.complete).toBe(true);
    expect(payload.counts.event_row_count).toBeGreaterThanOrEqual(3);
    expect(payload.evidence_totals.route_evidence_trip_count).toBe(3);
    // And the artifact still carries no coordinates.
    expect(JSON.stringify(payload)).not.toContain('43.65');
    expect(JSON.stringify(payload)).not.toContain('-79.38');
  });

  it('a deleted trip stops the export rather than shrinking it silently', async () => {
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-1'));
    await repository.localTripRepository.create(tripWithDetectableEvidence('trip-evidence-2'));

    const seen = [];
    const result = await evidenceStream.streamTripEvidence({
      readPage: (request) => repository.queryTripHistoryPage(request),
      // The population still lists the trip; the per-id read no longer finds it.
      readTrip: (id) => (id === 'trip-evidence-1'
        ? Promise.reject(new Error('Trip not found'))
        : repository.localTripRepository.readFullByIdForExport(id)),
      readSourceSnapshot: () => repository.readP7QuerySnapshot(),
      chunkSize: 1,
      onChunk: ({ trips }) => seen.push(...trips.map((trip) => trip.id)),
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(evidenceStream.EVIDENCE_FAILURE.DETAIL_READ_FAILED);
    expect(result.failure.detail).toBe('trip-evidence-1');
    expect(seen).not.toContain('trip-evidence-1');
  });

  it('an empty store produces a complete, honest, zero-trip walk', async () => {
    const accumulator = evidenceStream.createEvidenceSummaryAccumulator();
    const result = await evidenceStream.streamTripEvidence({
      readPage: (request) => repository.queryTripHistoryPage(request),
      readTrip: (id) => repository.localTripRepository.readFullByIdForExport(id),
      readSourceSnapshot: () => repository.readP7QuerySnapshot(),
      onChunk: ({ trips }) => accumulator.addChunk({
        routeQualityRows: exportLab.buildRouteQualityRows(trips, settings),
        eventRows: exportLab.buildTripEventExportRows(trips, settings),
      }),
    });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(0);
    expect(accumulator.totals().trip_count).toBe(0);
  });
});
