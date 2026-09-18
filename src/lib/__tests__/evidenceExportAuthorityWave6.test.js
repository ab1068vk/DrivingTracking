import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildRouteQualityRows,
  buildSpeedSourceAuditRows,
  buildSpeedSourceCoverageRows,
  buildTechnicalReportPayload,
  buildTechnicalTripCsvStream,
  buildTripEventExportRows,
  EXTRACT_ROW_LIMIT,
  TECHNICAL_ARTIFACT_KIND,
  TRIP_EVIDENCE_REPRESENTATION,
  tripEvidenceRepresentation,
} from '@/lib/trackingExportLab';
import {
  createEvidenceSummaryAccumulator,
  EVIDENCE_FAILURE,
  EVIDENCE_HYDRATION_CHUNK,
  EVIDENCE_NOT_INCLUDED,
  streamTripEvidence,
} from '@/lib/trackingEvidenceExport';

/**
 * Evidence / Export Authority — Wave 6 (HPR-019).
 *
 * TWO LIMBS, ONE INVARIANT: an artifact describes the population it actually
 * read. Limb A is the signed manifest, which authenticated evidence for zero
 * trips while the card beside it advertised the real lifetime count. Limb B is
 * the evidence builders, which were handed P7 projection rows — rows that carry
 * no `route_points` and no `driving_events` — and printed the resulting zeros as
 * measurements.
 *
 * The persistence-backed half of Limb B lives in
 * `evidenceExportPersistedEvidenceWave6.test.js`, because the mandatory event
 * discriminator has to prove a production-valid event survives a real canonical
 * write before it can prove the export loses it.
 */

const settings = { units: 'metric' };

/** A canonical detail record: payload-only fields present. */
const fullTrip = (id, overrides = {}) => ({
  id,
  status: 'completed',
  start_time: '2026-05-04T09:00:00.000Z',
  end_time: '2026-05-04T09:30:00.000Z',
  distance_km: 21,
  score_overall: 74,
  route_points_raw_count: 5,
  route_points_map_count: 4,
  route_points: [
    { lat: 51.5, lng: -0.1, speed_kmh: 30, speed_limit_kmh: 50, timestamp: '2026-05-04T09:00:00.000Z' },
    { lat: 51.501, lng: -0.101, speed_kmh: 44, speed_limit_kmh: 50, timestamp: '2026-05-04T09:01:00.000Z' },
    { lat: 51.502, lng: -0.102, speed_kmh: 51, timestamp: '2026-05-04T09:05:00.000Z', route_gap: true },
    { lat: 51.503, lng: -0.103, speed_kmh: 38, timestamp: '2026-05-04T09:06:00.000Z' },
  ],
  driving_events: [{
    type: 'harsh_brake',
    timestamp: '2026-05-04T09:01:00.000Z',
    value: 4.8,
    speed_kmh: 44,
    severity: 'medium',
    source: 'gps_events',
    point_index: 1,
  }],
  ...overrides,
});

/**
 * The P7 projection row for the same trip.
 *
 * It carries the aggregate counters the schema declares and, deliberately, no
 * payload keys at all — which is exactly why an evidence builder must not read
 * `trip.route_points?.length` from one.
 */
const projectionRow = (id, overrides = {}) => ({
  id,
  status: 'completed',
  start_time: '2026-05-04T09:00:00.000Z',
  end_time: '2026-05-04T09:30:00.000Z',
  distance_km: 21,
  score_overall: 74,
  route_points_map_count: 4,
  harsh_brakes_count: 1,
  ...overrides,
});

const page = (rows, continuation = null, snapshot = { authority: 'browser', generation: 'g1', revision: 7 }) => ({
  data: rows, completeness: 'EXACT', continuation, snapshot,
});

// ---------------------------------------------------------------------------
// Representation authority
// ---------------------------------------------------------------------------

describe('HPR-019 — a record states which representation it is', () => {
  it('separates a canonical record from a projection row and from an external payload', () => {
    expect(tripEvidenceRepresentation(fullTrip('t1'))).toBe(TRIP_EVIDENCE_REPRESENTATION.FULL);
    expect(tripEvidenceRepresentation(projectionRow('t1'))).toBe(TRIP_EVIDENCE_REPRESENTATION.SUMMARY);
    expect(tripEvidenceRepresentation({ id: 't1', route_payload_storage: 'browser_rsas_v1', route_points: [] }))
      .toBe(TRIP_EVIDENCE_REPRESENTATION.EXTERNAL);
  });

  it('treats an empty route on a canonical record as a measurement', () => {
    // The distinction the whole wave rests on: `route_points: []` is an answer,
    // a missing `route_points` key is the absence of the question.
    expect(tripEvidenceRepresentation({ id: 't1', route_points: [] }))
      .toBe(TRIP_EVIDENCE_REPRESENTATION.FULL);
  });
});

// ---------------------------------------------------------------------------
// RED B1 — route evidence
// ---------------------------------------------------------------------------

describe('HPR-019 RED B1 — route evidence, projection versus canonical', () => {
  it('measures the canonical record', () => {
    const [row] = buildRouteQualityRows([fullTrip('trip-A')], settings);

    expect(row.route_evidence).toBe('recorded');
    expect(row.retained_route_points).toBe(4);
    expect(row.route_gap_count).toBeGreaterThan(0);
    expect(row.speed_samples).toBe(4);
    expect(row.speed_limit_samples).toBe(2);
    expect(row.privacy_status).toBe('retained');
  });

  it('refuses to report a projection row as a measured zero', () => {
    const [row] = buildRouteQualityRows([projectionRow('trip-A')], settings);

    // Before the correction every one of these was the number `0`, and
    // `privacy_status` claimed `retained` — a confident statement about a route
    // nothing had looked at.
    expect(row.route_evidence).toBe('not included');
    expect(row.retained_route_points).toBe('not included');
    expect(row.route_gap_count).toBe('not included');
    expect(row.speed_samples).toBe('not included');
    expect(row.speed_limit_samples).toBe('not included');
    expect(row.privacy_masked_samples).toBe('not included');
    expect(row.privacy_status).toBe('not included');
    expect(row.retained_route_points).not.toBe(0);
  });

  it('keeps the projection counter the projection genuinely owns', () => {
    const [row] = buildRouteQualityRows([projectionRow('trip-A')], settings);
    // `route_points_map_count` IS in the projection schema, so it is reported.
    expect(row.map_playback_points).toBe('4');
  });

  it('reports an externally stored route payload as not included, not as empty', () => {
    const [row] = buildRouteQualityRows([
      fullTrip('trip-A', { route_payload_storage: 'browser_rsas_v1', route_points: [] }),
    ], settings);

    expect(row.route_evidence).toBe('not included');
    expect(row.retained_route_points).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RED B3 — speed-source evidence
// ---------------------------------------------------------------------------

describe('HPR-019 RED B3 — per-trip speed-source evidence', () => {
  it('the knowledge-base audit rows never depended on trips at all', () => {
    // The settled wording expected projection feeding to zero this builder. It
    // does not: `buildSpeedSourceAuditRows` maps the speed-knowledge rows only,
    // so the trips it was handed never reached its output. The export therefore
    // scanned the whole history and discarded it.
    const knowledge = { cells: {}, corrections: [] };
    const fromFull = buildSpeedSourceAuditRows({ trips: [fullTrip('trip-A')], settings, speedKnowledgeData: knowledge });
    const fromProjection = buildSpeedSourceAuditRows({ trips: [projectionRow('trip-A')], settings, speedKnowledgeData: knowledge });

    expect(fromFull).toEqual(fromProjection);
  });

  it('adds per-trip coverage rows that come from the canonical route', () => {
    const [row] = buildSpeedSourceCoverageRows([fullTrip('trip-A')], settings);

    expect(row.row_kind).toBe('trip_coverage');
    expect(row.trip_id).toBe('trip-A');
    expect(row.authority).toBe('trip_route_evidence');
    expect(row.confidence_percent).not.toBe('not included');
  });

  it('reports a projection row as not read rather than as zero coverage', () => {
    const [row] = buildSpeedSourceCoverageRows([projectionRow('trip-A')], settings);

    expect(row.row_kind).toBe('trip_coverage');
    expect(row.authority).toBe('not included');
    expect(row.confidence_percent).toBe('not included');
    expect(row.source_label).toMatch(/was not read/);
  });
});

// ---------------------------------------------------------------------------
// RED B4 — mixed population
// ---------------------------------------------------------------------------

describe('HPR-019 RED B4 — three evidence states stay three', () => {
  const tripA = fullTrip('trip-A');
  const tripB = fullTrip('trip-B', { driving_events: [], route_points: [
    { lat: 51.5, lng: -0.1, timestamp: '2026-05-04T09:00:00.000Z' },
  ] });
  const tripC = projectionRow('trip-C');

  it('distinguishes recorded evidence, legitimately absent evidence, and evidence not read', () => {
    const rows = buildRouteQualityRows([tripA, tripB, tripC], settings);
    const events = buildTripEventExportRows([tripA, tripB, tripC], settings);

    // A: measured and non-empty. B: measured and (for events) genuinely empty.
    expect(rows[0].route_evidence).toBe('recorded');
    expect(rows[1].route_evidence).toBe('recorded');
    expect(rows[1].retained_route_points).toBe(1);
    // C: never read.
    expect(rows[2].route_evidence).toBe('not included');

    const byTrip = (id) => events.filter((row) => row.trip_id === id);
    expect(byTrip('trip-A').length).toBeGreaterThan(0);
    expect(byTrip('trip-A')[0].event_type).not.toBe(EVIDENCE_NOT_INCLUDED);
    // B has no events, and that is a fact the file may state by saying nothing.
    expect(byTrip('trip-B')).toHaveLength(0);
    // C has one explicit row, so a reader of the event file alone is not told
    // that trip C had no events.
    expect(byTrip('trip-C')).toHaveLength(1);
    expect(byTrip('trip-C')[0].event_type).toBe(EVIDENCE_NOT_INCLUDED);
  });

  it('counts the three states separately in the summary totals', () => {
    const accumulator = createEvidenceSummaryAccumulator();
    accumulator.addChunk({
      routeQualityRows: buildRouteQualityRows([tripA, tripB, tripC], settings),
      eventRows: buildTripEventExportRows([tripA, tripB, tripC], settings),
    });
    const totals = accumulator.totals();

    expect(totals.trip_count).toBe(3);
    expect(totals.route_evidence_trip_count).toBe(2);
    expect(totals.route_evidence_unavailable_trip_count).toBe(1);
    expect(totals.event_evidence_unavailable_trip_count).toBe(1);
    expect(totals.trips_with_events_count).toBe(1);
    expect(totals.event_row_count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RED A1 / A2 / A3 — the signed population
// ---------------------------------------------------------------------------

describe('HPR-019 RED A — the artifact claims the population it read', () => {
  const summaryFor = (trips, { complete = true } = {}) => {
    const accumulator = createEvidenceSummaryAccumulator();
    accumulator.addChunk({
      routeQualityRows: buildRouteQualityRows(trips, settings),
      eventRows: buildTripEventExportRows(trips, settings),
    });
    return {
      population: { complete, source: { authority: 'browser', generation: 'g1', revision: 7 } },
      totals: accumulator.totals(),
      extracts: accumulator.extracts(),
    };
  };

  it('RED A1: the signed population and the counts are one number', () => {
    const payload = buildTechnicalReportPayload({
      summary: summaryFor([fullTrip('trip-A'), fullTrip('trip-B')]),
      settings,
      now: '2026-05-04T10:00:00.000Z',
    });

    // Before the correction this payload was built from `trips: []` while the
    // card beside it advertised the lifetime count: `trip_count` was 0 and the
    // screen said N.
    expect(payload.population.represented_trip_count).toBe(2);
    expect(payload.counts.trip_count).toBe(2);
    expect(payload.counts.route_quality_row_count).toBe(2);
    expect(payload.evidence_totals.event_row_count).toBeGreaterThan(0);
    expect(payload.artifact.kind).toBe(TECHNICAL_ARTIFACT_KIND.POPULATION_SUMMARY);
  });

  it('RED A1b: an artifact built from zero trips says zero and claims nothing more', () => {
    const payload = buildTechnicalReportPayload({ trips: [], settings, now: '2026-05-04T10:00:00.000Z' });

    expect(payload.population.represented_trip_count).toBe(0);
    expect(payload.counts.trip_count).toBe(0);
    // A supplied array is not a population read, and never claims to be one.
    expect(payload.population.complete).toBe(false);
    expect(payload.artifact.kind).toBe(TECHNICAL_ARTIFACT_KIND.SUPPLIED_ROWS);
  });

  it('RED A3: an empty history is a complete, truthful, zero-trip artifact', () => {
    const payload = buildTechnicalReportPayload({
      summary: summaryFor([]),
      settings,
      now: '2026-05-04T10:00:00.000Z',
    });

    expect(payload.population.represented_trip_count).toBe(0);
    expect(payload.population.complete).toBe(true);
    expect(payload.evidence_totals.route_evidence_trip_count).toBe(0);
    expect(payload.evidence_totals.event_row_count).toBe(0);
    expect(payload.route_quality_rows).toEqual([]);
  });

  it('says what it embeds rather than implying it embeds everything', () => {
    const many = Array.from({ length: EXTRACT_ROW_LIMIT + 5 }, (_, index) => fullTrip(`trip-${index}`));
    const payload = buildTechnicalReportPayload({ summary: summaryFor(many), settings });

    expect(payload.population.represented_trip_count).toBe(EXTRACT_ROW_LIMIT + 5);
    expect(payload.route_quality_rows).toHaveLength(EXTRACT_ROW_LIMIT);
    expect(payload.artifact.embeds_every_trip).toBe(false);
    expect(payload.artifact.route_quality_extract_truncated).toBe(true);
    expect(payload.artifact.extract_row_limit).toBe(EXTRACT_ROW_LIMIT);
    // The totals still describe every trip, which is what makes the extract safe.
    expect(payload.evidence_totals.trip_count).toBe(EXTRACT_ROW_LIMIT + 5);
  });

  it('records the source the population was read from', () => {
    const payload = buildTechnicalReportPayload({ summary: summaryFor([fullTrip('trip-A')]), settings });

    expect(payload.population.source_authority).toBe('browser');
    expect(payload.population.source_generation).toBe('g1');
    expect(payload.population.source_revision).toBe(7);
  });

  it('carries no coordinates into the artifact', () => {
    const payload = buildTechnicalReportPayload({ summary: summaryFor([fullTrip('trip-A')]), settings });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('"lat"');
    expect(serialized).not.toContain('"lng"');
    expect(serialized).not.toContain('51.5');
    expect(payload.privacy.coordinate_columns_exported).toEqual([]);
    expect(payload.privacy.private_coordinates_exported).toBe(false);
  });
});

describe('HPR-019 RED A2 — the signature binds the population claim', () => {
  let signExport;
  let verifyExport;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/lib/nativePlatform', () => ({ isAndroid: () => false, isNativePlatform: () => false }));
    // No IndexedDB and no secure-storage plugin: the browser signing key is held
    // in memory for the life of the module, which is what a test needs.
    vi.stubGlobal('indexedDB', undefined);
    ({ signExport, verifyExport } = await import('@/lib/exportIntegrity'));
  });

  afterEach(() => {
    vi.doUnmock('@/lib/nativePlatform');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const payloadFor = (tripCount) => {
    const accumulator = createEvidenceSummaryAccumulator();
    const trips = Array.from({ length: tripCount }, (_, index) => fullTrip(`trip-${index}`));
    accumulator.addChunk({
      routeQualityRows: buildRouteQualityRows(trips, settings),
      eventRows: buildTripEventExportRows(trips, settings),
    });
    return buildTechnicalReportPayload({
      summary: {
        population: { complete: true, source: { authority: 'browser', generation: 'g1', revision: 1 } },
        totals: accumulator.totals(),
        extracts: accumulator.extracts(),
      },
      settings,
      now: '2026-05-04T10:00:00.000Z',
    });
  };

  it('two different population claims produce two different signatures', async () => {
    const one = await signExport(payloadFor(1));
    const two = await signExport(payloadFor(2));

    expect(one.signature).not.toBe(two.signature);
    await expect(verifyExport(one)).resolves.toMatchObject({ valid: true });
    await expect(verifyExport(two)).resolves.toMatchObject({ valid: true });
  });

  it('editing the represented population after signing fails verification', async () => {
    const signed = await signExport(payloadFor(2));
    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: true });

    signed.payload.population.represented_trip_count = 500;

    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: false });
  });

  it('editing an evidence total after signing fails verification', async () => {
    const signed = await signExport(payloadFor(2));
    signed.payload.evidence_totals.event_row_count = 9999;

    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: false });
  });

  it('editing the completeness marker after signing fails verification', async () => {
    const signed = await signExport(payloadFor(2));
    signed.payload.artifact.embeds_every_trip = true;

    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: false });
  });

  it('editing the scan-completeness claim after signing fails verification', async () => {
    const signed = await signExport(payloadFor(2));
    signed.payload.population.complete = false;

    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: false });
  });
});

// ---------------------------------------------------------------------------
// The bounded stream: enumeration, failure semantics, and the memory law
// ---------------------------------------------------------------------------

describe('HPR-019 — the export walk is bounded and finishes or fails', () => {
  const walk = ({ pages, readTrip, onChunk = () => {}, snapshots = null, ...rest }) => {
    let index = 0;
    let snapshotIndex = 0;
    return streamTripEvidence({
      readPage: async () => pages[index++],
      readTrip,
      // The source identity the coherence check reads. Unless a case supplies a
      // sequence, it stays exactly where the first page found it.
      readSourceSnapshot: async () => (snapshots
        ? (snapshots[Math.min(snapshotIndex++, snapshots.length - 1)])
        : { authority: 'browser', generation: 'g1', revision: 7 }),
      onChunk,
      ...rest,
    });
  };

  it('walks every page and hands over canonical records', async () => {
    const seen = [];
    const result = await walk({
      pages: [page([projectionRow('a'), projectionRow('b')], 'c1'), page([projectionRow('c')])],
      readTrip: async (id) => fullTrip(id),
      onChunk: ({ trips }) => seen.push(...trips.map((trip) => trip.id)),
    });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(3);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.snapshot).toMatchObject({ authority: 'browser', generation: 'g1', revision: 7 });
  });

  it('resolves each trip by its own id, never by position', async () => {
    const asked = [];
    await walk({
      pages: [page([projectionRow('a'), projectionRow('b')])],
      readTrip: async (id) => { asked.push(id); return fullTrip(id); },
    });

    expect(asked).toEqual(['a', 'b']);
  });

  it('never holds more than one hydration chunk of canonical records', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => projectionRow(`t${index}`));
    let widest = 0;
    const result = await walk({
      pages: [page(rows)],
      readTrip: async (id) => fullTrip(id),
      chunkSize: 10,
      onChunk: ({ trips }) => { widest = Math.max(widest, trips.length); },
    });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(120);
    expect(widest).toBe(10);
    expect(EVIDENCE_HYDRATION_CHUNK).toBeLessThanOrEqual(50);
  });

  it('RED — a page that cannot be read ends the export', async () => {
    const result = await walk({
      pages: [page([projectionRow('a')], 'c1'), { unavailable: { code: 'STORAGE_UNAVAILABLE' }, data: null }],
      readTrip: async (id) => fullTrip(id),
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(EVIDENCE_FAILURE.PAGE_UNAVAILABLE);
  });

  it('RED — a cursor rejected because the source moved ends the export', async () => {
    const result = await walk({
      pages: [page([projectionRow('a')], 'c1'), { unavailable: { code: 'CURSOR_RESTART_REQUIRED' }, data: null }],
      readTrip: async (id) => fullTrip(id),
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(EVIDENCE_FAILURE.PAGE_UNAVAILABLE);
    expect(result.failure.detail).toBe('CURSOR_RESTART_REQUIRED');
  });

  it('RED — two pages from two different sources are never combined', async () => {
    const result = await walk({
      pages: [
        page([projectionRow('a')], 'c1', { authority: 'browser', generation: 'g1', revision: 7 }),
        page([projectionRow('b')], null, { authority: 'browser', generation: 'g1', revision: 8 }),
      ],
      readTrip: async (id) => fullTrip(id),
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(EVIDENCE_FAILURE.SOURCE_MOVED);
  });

  it('RED — one unreadable trip ends the export instead of being left out', async () => {
    const seen = [];
    const result = await walk({
      pages: [page([projectionRow('a'), projectionRow('b')])],
      chunkSize: 1,
      readTrip: async (id) => {
        if (id === 'b') throw new Error('Trip not found');
        return fullTrip(id);
      },
      onChunk: ({ trips }) => seen.push(...trips.map((trip) => trip.id)),
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(EVIDENCE_FAILURE.DETAIL_READ_FAILED);
    expect(result.failure.detail).toBe('b');
    // A complete-looking artifact missing trip b is the outcome this forbids.
    expect(seen).toEqual(['a']);
  });

  it('RED — a scan that runs out of turns is not a finished export', async () => {
    const result = await streamTripEvidence({
      readPage: async () => page([projectionRow('a')], 'never-ends'),
      readTrip: async (id) => fullTrip(id),
      readSourceSnapshot: async () => ({ authority: 'browser', generation: 'g1', revision: 7 }),
      onChunk: () => {},
      maxTurns: 3,
    });

    expect(result.complete).toBe(false);
    expect(result.failure.code).toBe(EVIDENCE_FAILURE.SCAN_LIMIT_REACHED);
  });

  it('an empty population completes with nothing in it', async () => {
    const result = await walk({ pages: [page([])], readTrip: async (id) => fullTrip(id) });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The scale law
// ---------------------------------------------------------------------------

describe('HPR-019 — cost is bounded by the chunk, not by the history', () => {
  it.each([0, 1, 10, 200, 201, 1_000, 10_000])('holds %i trips with O(1) summary state', async (retained) => {
    const pages = [];
    for (let offset = 0; offset < retained; offset += 200) {
      const rows = Array.from(
        { length: Math.min(200, retained - offset) },
        (_, index) => projectionRow(`t${offset + index}`),
      );
      pages.push(page(rows, offset + 200 < retained ? `c${offset}` : null));
    }
    if (!pages.length) pages.push(page([]));

    const accumulator = createEvidenceSummaryAccumulator({ extractLimit: 10 });
    let widest = 0;
    let index = 0;
    const result = await streamTripEvidence({
      readPage: async () => pages[index++],
      readTrip: async (id) => fullTrip(id),
      readSourceSnapshot: async () => ({ authority: 'browser', generation: 'g1', revision: 7 }),
      chunkSize: 25,
      onChunk: ({ trips }) => {
        widest = Math.max(widest, trips.length);
        accumulator.addChunk({
          routeQualityRows: buildRouteQualityRows(trips, settings),
          eventRows: buildTripEventExportRows(trips, settings),
        });
      },
    });

    expect(result.complete).toBe(true);
    expect(result.tripCount).toBe(retained);
    expect(accumulator.totals().trip_count).toBe(retained);
    // Residency never grows with the population.
    expect(widest).toBeLessThanOrEqual(25);
    // Nor does what the summary keeps.
    const extracts = accumulator.extracts();
    expect(extracts.route_quality_rows.length).toBeLessThanOrEqual(10);
    expect(extracts.event_rows.length).toBeLessThanOrEqual(10);
    expect(Object.keys(accumulator.totals())).toHaveLength(12);
  });

  it('a very large single trip is serialised once, not copied per evidence pass', () => {
    for (const points of [10, 1_000, 100_000]) {
      const trip = fullTrip('huge', {
        route_points: Array.from({ length: points }, (_, index) => ({
          lat: 51.5 + (index / 1e6),
          lng: -0.1,
          speed_kmh: 40,
          timestamp: new Date(Date.UTC(2026, 4, 4, 9, 0, index % 60)).toISOString(),
        })),
        route_points_raw_count: points,
        route_points_map_count: points,
      });
      const [row] = buildRouteQualityRows([trip], settings);

      expect(row.retained_route_points, `points=${points}`).toBe(points);
      // The artifact keeps the counts, never the route.
      expect(JSON.stringify(row)).not.toContain('51.5');
    }
  });

  it('the trip table streams its lines instead of holding the population', () => {
    const csv = buildTechnicalTripCsvStream(settings);
    csv.addChunk([fullTrip('trip-A')]);
    csv.addChunk([fullTrip('trip-B')]);
    const output = csv.csv();

    expect(output.split('\n').filter(Boolean).length).toBeGreaterThan(2);
    expect(output).toContain('trip-A');
    expect(output).toContain('trip-B');
  });
});

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe('HPR-019 — what this wave must not have changed', () => {
  const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('ordinary Settings backup still exports full inline records', () => {
    // The allegation that ordinary backup loses route/event evidence is
    // falsified at current source and stays that way: it reads whole records,
    // not projection rows, and it does not go through the Reports Lab builders.
    const settingsPage = read('src/pages/Settings.jsx');
    expect(settingsPage).toMatch(/tripService\.listAllForExport\(/);
    expect(settingsPage).not.toMatch(/trackingEvidenceExport/);
    expect(settingsPage).not.toMatch(/buildTechnicalReportPayload/);

    const repository = read('src/lib/localTripRepository.js');
    const listAll = repository.slice(
      repository.indexOf('async listAllForExport('),
      repository.indexOf('async listAll('),
    );
    expect(listAll).toMatch(/getAllTrips\(/);
  });

  it('the Reports Lab no longer accumulates the population as projection rows', () => {
    const page = read('src/pages/TrackingReportsLab.jsx');

    expect(page).not.toMatch(/collectExportTrips/);
    expect(page).not.toMatch(/collected\.push/);
    expect(page).toMatch(/streamTripEvidence/);
    // The Wave 6 correction moved the export onto the read that does not persist
    // its own preparation, so the walk cannot move the source it will claim.
    expect(page).toMatch(/tripService\.readFullByIdForExport/);
    expect(page).toMatch(/tripService\.readQuerySnapshot/);
  });

  it('the signed manifest is no longer built from an empty trip array', () => {
    const page = read('src/pages/TrackingReportsLab.jsx');
    const manifest = page.slice(page.indexOf("id: 'manifest'"), page.indexOf("id: 'portability'"));

    expect(manifest).toMatch(/buildPopulationSummaryPayload/);
    expect(manifest).not.toMatch(/signExport\(payload\)/);
    expect(manifest).not.toMatch(/signExport\(diagnosticsPayload\)/);
  });

  it('signing still covers the whole payload with the existing envelope', () => {
    const integrity = read('src/lib/exportIntegrity.js');
    expect(integrity).toMatch(/SIGNED_EXPORT_ALGORITHM = 'HMAC-SHA256'/);
    expect(integrity).toMatch(/new TextEncoder\(\)\.encode\(JSON\.stringify\(payload\)\)/);
  });
});
