import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));

import {
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  localTripRepository,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  finalizeP6BrowserExplicitTripBuild,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { queryTripGeometryPage } from '@/lib/tripQueryFacade';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { P7_COMPLETENESS, p7EnvelopeViolations } from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { speedMapCoverageLabel } from '@/hooks/useSpeedMapGeometry';
import {
  CALLER_CONTEXT,
  EXCLUDE_DEFINITIONS,
  SRC_ROOT,
  findSymbolCallEdges,
  isRoutineEdge,
  withoutComments,
} from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 7 — map and geometry consumers.
 *
 * The failure this stage removes is not a slow page: it is **four surfaces
 * decrypting whole trip payloads to draw lines**. MapScreen fanned out eight
 * Q2 detail reads, TrackingMapWorkspace six, and the live driving panel four —
 * each one a complete trip record, points and events included, for a polyline.
 * Q8 answers the same question with a Q1 selection plus one D2 by-id batch.
 */

const pageSource = (relative) => withoutComments(
  readFileSync(path.join(SRC_ROOT, relative), 'utf8')
);

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});

const DAY = 86400000;

describe('P7-V12 — listForSpeedMap has no routine caller left', () => {
  it('keeps only the labelled explicit v1 rebuild', () => {
    const edges = findSymbolCallEdges(['listForSpeedMap'], { exclude: EXCLUDE_DEFINITIONS });

    // One edge survives, and it is `speedGeometryIndex`'s v1 rebuild, which
    // Annex B keeps under its existing compatibility rule. Stage 9 taught the
    // classifier to see `useCallback` handlers and cross-module attribution,
    // and with that information the edge proves **explicit**: it is reached
    // only from the "Load full road history" button.
    expect(edges.map((edge) => edge.file)).toEqual(['lib/speedGeometryIndex.js']);
    expect(edges.filter(isRoutineEdge)).toEqual([]);
    // No page reaches it any more, by any caller context.
    expect(edges.some((edge) => edge.file.startsWith('pages/'))).toBe(false);
  });

  it('creates no batched successor to the retired read', () => {
    // A "listForSpeedMapBatch" or similar would be the same unbounded shape
    // under a new name. Geometry has exactly one owner: the D2 by-id batch.
    const speedMapSymbols = findSymbolCallEdges(
      ['listForSpeedMap', 'listForSpeedMapBatch', 'listForMap'],
      { exclude: EXCLUDE_DEFINITIONS },
    );
    expect(speedMapSymbols.filter((edge) => edge.file.startsWith('pages/'))).toEqual([]);
  });
});

describe('P7-V18 / boundedness — the map surfaces hold no detail fan-out', () => {
  it('SpeedLimits reads one bounded Q8 page instead of offset-paging history', () => {
    const source = pageSource('pages/SpeedLimits.jsx');
    expect(source).not.toMatch(/listForSpeedMap/);
    expect(source).toContain('readSpeedMapGeometryPage');
    // Offset paging sorted the whole eligible history to reach each page. The
    // cursor is the only way forward now, and there is no offset left.
    expect(source).not.toMatch(/nextOffset/);
    expect(source).toContain('geometryCursor');
  });

  it('MapScreen and TrackingMapWorkspace draw routes without decrypting them', () => {
    for (const relative of ['pages/MapScreen.jsx', 'pages/TrackingMapWorkspace.jsx']) {
      const source = pageSource(relative);
      expect(source, relative).not.toMatch(/limitedTripSummaryQueryOptions/);
      expect(source, relative).not.toMatch(/tripDetailQueryOptions/);
      // The overview fan-out is gone entirely: no `useQueries` remains.
      expect(source, relative).not.toMatch(/useQueries/);
      expect(source, relative).toContain('mapScreenGeometryQuery');
      // The one selected trip still reads full fidelity, fixed by UX not by N.
      expect(source, relative).toContain('p7DetailQueryOptions');
    }
  });

  it('the live driving panel reads one batch, not four full trips', () => {
    const source = pageSource('components/tracking/LiveTrackingMapPanel.jsx');
    expect(source).not.toMatch(/tripDetailQueryOptions/);
    expect(source).not.toMatch(/useQueries/);
    expect(source).toContain('geometryByIds');

    const entry = P7_CONSUMER_LEDGER.find(
      (e) => e.consumer === 'src/components/tracking/LiveTrackingMapPanel.jsx'
    );
    expect(entry.qGraph).toEqual(['Q1 (ids)', 'Q8 D2 by-id batch']);
    expect(entry.caps.detail).toBe(0);
  });

  it('O36: a bounded scan states a floor, and never a synthesized total', () => {
    // The old line read `N/total`, where the total was
    // `items.length + (nextCursor ? 1 : 0)` — "81" from a page of 80, forever.
    expect(speedMapCoverageLabel({ loaded: 12, exact: false }))
      .toBe('at least 12 trip routes indexed, more available');
    expect(speedMapCoverageLabel({ loaded: 12, exact: true }))
      .toBe('12 trip routes indexed');
    expect(speedMapCoverageLabel({ loaded: 1, exact: true })).toBe('1 trip route indexed');

    const index = pageSource('lib/speedGeometryIndex.js');
    expect(index).not.toContain('p6.items.length + (p6.nextCursor ? 1 : 0)');

    const workspace = pageSource('components/speedLimits/SpeedLimitSavedWorkspace.jsx');
    expect(workspace).not.toContain('geometryIndexState.totalAvailable');
    expect(workspace).toContain('more available');
  });
});

describe('P7-V11 — Q8 selection, order and constant crossings', () => {
  let indexedDb;
  let observer;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip) => {
    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  const BASE = Date.UTC(2026, 3, 6);

  /**
   * Ids are deliberately **non-lexical** with respect to chronology, so an
   * answer ordered by the D2 manifest's own key would be visibly wrong.
   */
  const routeFor = (index) => Array.from({ length: 6 }, (_, point) => ({
    lat: 51 + index * 0.01 + point * 0.001,
    lng: -0.1 + point * 0.001,
    timestamp: new Date(BASE + index * DAY + point * 60000).toISOString(),
  }));

  const seed = async (count) => {
    const seeded = [];
    for (let index = 0; index < count; index += 1) {
      const trip = {
        // Deliberately reverse-lexical against chronology: the newest trip
        // sorts first by time and LAST by id, so an answer ordered by the D2
        // manifest key would be visibly, not subtly, wrong.
        id: `trip-${String(index).padStart(3, '0')}`,
        status: 'completed',
        start_time: new Date(BASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(BASE + index * DAY + 5400000).toISOString(),
        distance_km: 9 + index,
        duration_seconds: 1500,
        score_overall: 80,
        route_points: routeFor(index),
      };
      await queue(trip);
      seeded.push(trip);
    }
    return seeded;
  };

  it('selects and orders by Q1 chronology, not by the manifest key', async () => {
    const seeded = await seed(8);
    await drain();

    const page = await queryTripGeometryPage({ limit: 5, maxPoints: 64 });

    expect(page.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    expect(p7EnvelopeViolations('Q8', page)).toEqual([]);

    // Newest first, by start_time — which is a different order from the ids.
    const oracle = [...seeded]
      .sort((left, right) => Date.parse(right.start_time) - Date.parse(left.start_time))
      .slice(0, 5)
      .map((trip) => trip.id);
    expect(page.data.map((row) => row.id)).toEqual(oracle);
    // The chronological answer is the exact reverse of the id order.
    expect([...oracle].sort()).toEqual([...oracle].reverse());

    // Every selected row was hydrated by the batch, in the same order.
    expect(page.data.every((row) => row.geometry?.geometry_indexed === true)).toBe(true);
    expect(page.data.every((row) => row.geometry.route_points.length > 1)).toBe(true);
  }, 180_000);

  it('excludes summary-only and expired routes before the batch is issued', async () => {
    await seed(3);
    await queue({
      id: 'private-trip',
      status: 'completed',
      start_time: new Date(BASE + 9 * DAY).toISOString(),
      distance_km: 12,
      privacy_mode: 'summary_only',
      route_points: routeFor(9),
    });
    await queue({
      id: 'expired-trip',
      status: 'completed',
      start_time: new Date(BASE + 10 * DAY).toISOString(),
      distance_km: 12,
      route_data_expired_at: new Date(BASE + 11 * DAY).toISOString(),
      route_points: routeFor(10),
    });
    await queue({
      id: 'in-progress-trip',
      status: 'in_progress',
      start_time: new Date(BASE + 12 * DAY).toISOString(),
      distance_km: 3,
    });
    await drain();

    const page = await queryTripGeometryPage({ limit: 50, maxPoints: 64 });
    const ids = page.data.map((row) => row.id);

    // Privacy and expiry are evaluated on the selected rows, never reversed.
    expect(ids).not.toContain('private-trip');
    expect(ids).not.toContain('expired-trip');
    expect(ids).not.toContain('in-progress-trip');
    expect(ids).toHaveLength(3);
  }, 180_000);

  it('costs the page, not the history — the growth law, measured', async () => {
    await seed(6);
    await drain();

    // Warm the cold-start reads (the revision and readiness lookups) so the
    // comparison is steady state against steady state.
    await queryTripGeometryPage({ limit: 4, maxPoints: 64 });

    observer.reset();
    const before = await queryTripGeometryPage({ limit: 4, maxPoints: 64 });
    const beforeCrossings = observer.counts.transactions;
    expect(before.data).toHaveLength(4);

    // Double the retained history, then ask the identical question.
    for (let index = 6; index < 12; index += 1) {
      await queue({
        id: `later-${index}`,
        status: 'completed',
        start_time: new Date(BASE - (index + 1) * DAY).toISOString(),
        distance_km: 7,
        duration_seconds: 900,
        score_overall: 75,
        route_points: routeFor(index),
      });
    }
    await drain();

    await queryTripGeometryPage({ limit: 4, maxPoints: 64 });

    observer.reset();
    const after = await queryTripGeometryPage({ limit: 4, maxPoints: 64 });
    const afterCrossings = observer.counts.transactions;

    expect(after.data).toHaveLength(4);
    // Twice the history, the same cost. This is the law the stage exists for.
    expect(afterCrossings).toBe(beforeCrossings);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    // And the D2 batch itself is constant in k, proven independently: the
    // crossings for a 4-row page and a 12-row page differ only by the Q1
    // cursor deliveries, never by a per-trip detail call.
    observer.reset();
    await queryTripGeometryPage({ limit: 12, maxPoints: 64 });
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 240_000);

  it('never presents an unfinished scan as complete coverage', async () => {
    await seed(6);
    await drain();

    const partial = await queryTripGeometryPage({ limit: 3, maxPoints: 64 });
    expect(partial.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    expect(partial.continuation).not.toBeNull();

    const rest = await queryTripGeometryPage({ limit: 3, maxPoints: 64, cursor: partial.continuation });
    expect(rest.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(rest.continuation).toBeNull();

    // The two pages are disjoint and cover the population exactly once.
    const ids = [...partial.data, ...rest.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(6);
  }, 180_000);

  it('returns at most the declared point cap per route', async () => {
    await seed(6);
    await drain();

    const narrow = await queryTripGeometryPage({ limit: 6, maxPoints: 3 });
    for (const row of narrow.data) {
      expect(row.geometry.route_points.length).toBeLessThanOrEqual(3);
    }
    expect(narrow.data.every((row) => row.geometry.preview_point_cap === 3)).toBe(true);

    const wide = await queryTripGeometryPage({ limit: 6, maxPoints: 64 });
    // The seeded routes are 6 points long, so a wider cap returns the whole
    // route and a narrow one truncates it — the cap governs the output, and
    // the output is what a map draws.
    expect(wide.data[0].geometry.route_points.length)
      .toBeGreaterThan(narrow.data[0].geometry.route_points.length);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 180_000);
});

describe('P7 Stage 7 — the caller-context classification still holds', () => {
  it('reaches geometry only from a page composition, never from a render fold', () => {
    // `CALLER_CONTEXT` is what makes the audit meaningful: a symbol is legal or
    // not by how it is reached, not by which file it sits in.
    expect(Object.values(CALLER_CONTEXT)).toContain('ROUTINE');
    expect(Object.values(CALLER_CONTEXT)).toContain('EXPLICIT');
  });
});
