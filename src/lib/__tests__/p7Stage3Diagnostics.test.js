import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { localTripRepository } from '@/lib/localTripRepository';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { P7_COMPLETENESS } from '@/lib/tripQueryContracts';
import { findDuplicateHistoryAcquisitions, SRC_ROOT, withoutComments } from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 3 — Diagnostics proves the architecture end to end.
 *
 * Diagnostics is the proof page because its defect was the degenerate one: two
 * **identical** `listSummaries({limit:20})` queries under different keys, so
 * neither shared the other's cache and every open paid for the same page twice.
 * It also carries no analytics semantics to preserve, so a behaviour difference
 * here would be unambiguous.
 *
 * Composition counting is done at the IndexedDB boundary, outside the page and
 * outside the repository's own counters.
 */

let observer;

const installStorage = () => {
  const fake = new FakeIndexedDb();
  observer = observeIndexedDb(fake);
  vi.stubGlobal('indexedDB', observer.factory);
  const values = new Map([[
    'drivesense_settings',
    JSON.stringify({
      settings_defaults_version: 11,
      data_retention_days: 3650,
      raw_gps_retention_days: 3650,
      privacy_zones: [],
    }),
  ]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
};

const DAY = 86400000;
const BASE = Date.UTC(2026, 6, 2, 8);

const seed = async (count) => {
  for (let index = 0; index < count; index += 1) {
    await localTripRepository.create({
      id: `diag-${String(index).padStart(3, '0')}`,
      status: 'completed',
      start_time: new Date(BASE + index * DAY).toISOString(),
      end_time: new Date(BASE + index * DAY + 900000).toISOString(),
      distance_km: 6 + index,
      duration_seconds: 900,
      score_overall: 82,
      route_points: [{ lat: 43.6, lng: -79.4 }],
    });
  }
};

const pageSource = () => withoutComments(
  readFileSync(path.join(SRC_ROOT, 'pages', 'Diagnostics.jsx'), 'utf8')
);

describe('P7 Stage 3 — Diagnostics composition', () => {
  it('no longer performs a duplicate history acquisition', () => {
    const duplicates = findDuplicateHistoryAcquisitions().map((entry) => entry.file);
    // The V18 negative-control baseline recorded this page at 3 acquisitions.
    expect(duplicates).not.toContain('pages/Diagnostics.jsx');
  });

  it('reaches trip data only through the P7 composition, not the legacy list API', () => {
    const source = pageSource();
    // The two identical `listSummaries({limit:20})` reads and the 200-row test
    // sweep are gone from the page: they are the composition's business now.
    expect(source).not.toMatch(/tripService\.listSummaries\s*\(/);
    expect(source).toContain('useDiagnosticsPageData');
    // The selected trip keeps its own canonical detail family, which is a
    // declared secondary read rather than a second history acquisition.
    expect(source).toContain('tripDetailQueryOptions');
  });

  it('matches the Q graph its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((item) => item.consumer === 'src/pages/Diagnostics.jsx');
    expect(entry.qGraph).toEqual(['Q1', 'Q2 (1 selected trip)']);
    expect(entry.caps.detail).toBe(1);
    expect(entry.caps.secondary).toBe('Q1 1 + Q2 1');
    expect(entry.legacy).toBe('duplicate (20)+(20) -> retire');
  });
});

describe('P7 Stage 3 — one composition, observed independently', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('serves the page rows and the data profile from a single bounded read', async () => {
    await seed(30);
    const { p7TripQueries } = await import('@/api/trips');

    observer.reset();
    const page = await p7TripQueries.historyPage({ sort: '-start_time', limit: 20 });

    expect(page.unavailable).toBeUndefined();
    expect(page.data).toHaveLength(20);
    // One page of rows, read once. Before the migration this page issued the
    // same request twice under two keys.
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(20 + 1);
    expect(observer.counts.openCursorCalls).toBe(1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 120_000);

  it('keeps the composition bounded as history grows', async () => {
    // Both tiers must exceed the page size, so both include the single
    // look-ahead row that proves `hasMore` without reading another page.
    // Comparing a saturated page against an unsaturated one would compare
    // k against k+1 and say nothing about growth.
    await seed(30);
    const { p7TripQueries } = await import('@/api/trips');

    observer.reset();
    await p7TripQueries.historyPage({ sort: '-start_time', limit: 20 });
    const small = observer.counts.sourceRowsVisited;
    expect(small).toBe(21);

    await seed(60);
    observer.reset();
    await p7TripQueries.historyPage({ sort: '-start_time', limit: 20 });

    // The page's cost is its page size, not the retained history behind it.
    expect(observer.counts.sourceRowsVisited).toBe(small);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 120_000);

  it('reports a genuinely empty profile as EXACT and empty, not as unavailable', async () => {
    const { p7TripQueries } = await import('@/api/trips');
    const page = await p7TripQueries.historyPage({ sort: '-start_time', limit: 20 });

    expect(page.data).toEqual([]);
    expect(page.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(page.unavailable).toBeUndefined();
  }, 60_000);
});
