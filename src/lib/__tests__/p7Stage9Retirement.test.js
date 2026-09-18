import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));

import {
  __projectionCountersForTests,
  __resetProjectionCountersForTests,
  localTripRepository,
  queryTripHistoryPage,
} from '@/lib/localTripRepository';
import { P7_BROAD_INVENTORY, P7_RETIREMENT_PLAN } from '@/lib/tripQueryContracts';
import {
  EXCLUDE_DEFINITIONS,
  SRC_ROOT,
  findSymbolCallEdges,
  isRoutineEdge,
  withoutComments,
} from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 9 — retiring the routine legacy call edges.
 *
 * The stage's own law is that a retirement must be **proven**, not asserted:
 * a symbol is retired when no routine caller can reach it, and the proof is a
 * detector that would still find one. Nothing here is made green by relaxing a
 * check — the two places the classifier changed, it was taught to see *more*.
 */

const source = (relative) => withoutComments(
  readFileSync(path.join(SRC_ROOT, relative), 'utf8')
);

describe('P7-V23 — the retirement plan is carried out, entry by entry', () => {
  it('deletes tripSummaryQueryOptions', () => {
    const api = source('api/trips.js');
    expect(api).not.toContain('tripSummaryQueryOptions = ');
    // The bounded option it aliased survives, because pages still need one.
    expect(api).toContain('limitedTripSummaryQueryOptions');

    const plan = P7_RETIREMENT_PLAN.find((row) => row.path === 'tripSummaryQueryOptions');
    expect(plan.proof).toContain('assert absence');
  });

  it('typed-refuses list on the browser authority, as the native one already did', async () => {
    await expect(localTripRepository.list({ limit: 10 })).rejects.toMatchObject({
      code: 'UNBOUNDED_QUERY_FORBIDDEN',
    });

    const native = source('lib/nativeTripRepository.js');
    expect(native).toContain('UNBOUNDED_QUERY_FORBIDDEN');
    // Both authorities agree, so no selection can reach an unbounded page read.
  });

  it('leaves no routine caller for any frozen legacy symbol', () => {
    for (const symbol of ['tripService.list', 'listAllSummaries', 'getScoreMigrationSummary', 'tripSummaryQueryOptions']) {
      const edges = findSymbolCallEdges([symbol], { exclude: EXCLUDE_DEFINITIONS });
      expect(edges.filter(isRoutineEdge), symbol).toEqual([]);
    }
  });

  it('preserves the explicit reads Annex B retains, and only those', () => {
    // B7, B8, B10 and B6's v1 rebuild survive; each one must still be present
    // and still classified explicit. A retirement that removed them would be
    // as wrong as one that left a routine edge behind.
    for (const symbol of ['listAllForExport', 'eraseAll', 'rescoreCompletedTrips', 'listForSpeedMap']) {
      const edges = findSymbolCallEdges([symbol], { exclude: EXCLUDE_DEFINITIONS });
      expect(edges.length, symbol).toBeGreaterThan(0);
      expect(edges.filter(isRoutineEdge), symbol).toEqual([]);
    }

    const explicitOnly = P7_BROAD_INVENTORY.filter((row) => row.scope.startsWith('EXPLICIT'));
    expect(explicitOnly.map((row) => row.id).sort()).toEqual(['B10', 'B7', 'B8']);
  });
});

describe('P7 Stage 9 — no mutation performs a hidden list read', () => {
  it('serves save-time tag inference from bounded Q7', () => {
    const api = source('api/trips.js');
    // Every create used to run `listSummaries({limit:50})` purely to infer
    // tags — a list query hidden inside a write.
    expect(api).not.toMatch(/listSummaries\(\{ sort: "-start_time", limit: 50 \}\)/);
    expect(api).toContain('p7TripQueries.tagContext');

    const contract = source('lib/queryContracts/composition.js');
    expect(contract).toContain('no mutation may perform a hidden broad or list query');
  });

  it('gives the tag context the fields the inference actually reads', () => {
    // `inferTripTags` groups by repeated route, so the route key is part of
    // tag context. It is an existing projection field; none was added.
    const repository = source('lib/localTripRepository.js');
    expect(repository).toContain('route_key: row.route_key,');

    const schema = source('lib/tripProjectionSchema.js');
    expect(schema).toContain('route_key');
    // The one projection addition P7 is allowed remains the only one.
    expect(schema).toContain('driver_metric_eligible');
  });
});

describe('P7-V19 — the retired counters stay at zero on a routine read', () => {
  let indexedDb;
  let observer;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    __resetProjectionCountersForTests();
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('a refused read does no work at all before it refuses', async () => {
    await expect(localTripRepository.list({ limit: 10 })).rejects.toThrow();

    // The old `list` ran a retention sweep, an event migration, a version
    // tagging pass and a rescore pass over every decrypted record before it
    // sliced anything. The refusal happens first, so none of that runs.
    expect(__projectionCountersForTests().historySorts).toBe(0);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
    expect(observer.counts.transactions).toBe(0);
  });

  it('a bounded page never sorts the history', async () => {
    const page = await queryTripHistoryPage({ limit: 5 });

    expect(page.unavailable ?? null).toBeNull();
    // `historySorts` counts the degraded whole-history sort. A bounded read
    // must never reach it, whatever the store holds.
    expect(__projectionCountersForTests().historySorts).toBe(0);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  });
});

describe('P7 Stage 9 — the audit was strengthened, not relaxed', () => {
  it('adds the retired shape to the source sweep rather than removing a check', () => {
    const audit = source('lib/__tests__/wholeHistoryReleaseAudit.test.js');
    // `tripService.list(` is now one of the unbounded shapes the sweep refuses.
    expect(audit).toContain('tripService\\.list\\s*\\(/');
    // And the browser `list` moved from category A to a typed refusal, D.
    expect(audit).toContain("category: 'D'");
    expect(audit).toContain('lib/localTripRepository.js#list');
  });

  it('classifies a useCallback handler, which it used to be blind to', () => {
    const helper = source('lib/__tests__/helpers/p7ReleaseAudit.js');
    // Without this, `const onThing = useCallback(() => {` bound no name and
    // every call inside it attributed to the component — which always holds a
    // `useQuery`, so genuinely explicit handlers were reported routine.
    expect(helper).toContain('useCallback|useMemo');
    expect(helper).toContain('resolveCrossFileContext');
  });

  it('never downgrades a routine verdict', () => {
    const helper = source('lib/__tests__/helpers/p7ReleaseAudit.js');
    // The cross-file resolver runs only for an UNCLASSIFIED edge, and returns
    // EXPLICIT only when every importing call site is itself explicit.
    expect(helper).toContain('CALLER_CONTEXT.UNCLASSIFIED && options.crossFile !== false');
    expect(helper).toContain('return sawCall ? CALLER_CONTEXT.EXPLICIT : CALLER_CONTEXT.UNCLASSIFIED;');
    // And the gate still treats anything not proven explicit as routine.
    expect(helper).toContain("export const isRoutineEdge = (edge) => edge.context !== CALLER_CONTEXT.EXPLICIT;");
  });
});
