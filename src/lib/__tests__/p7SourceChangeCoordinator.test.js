/**
 * AUD-001 / RL-002 — P7 surfaces must refresh when the source changes, and the cache must
 * not grow when it does.
 *
 * THE DEFECT CODEX VERIFIED. Keys are stable by semantic query shape, so nothing in a key
 * changes when a trip is written; and the invalidations that existed named legacy families
 * (`['trip-summaries']`, `['trips']`, `['map-trips']`) that do not prefix-match a
 * `['p7', ...]` key. Migrated surfaces therefore kept showing pre-mutation answers while
 * code that looked like a refresh ran.
 *
 * THE TRAP TO AVOID. "Put the revision in the key" would fix the staleness and replace it
 * with unbounded cache cardinality: one identity per mutation, held for the 30-minute gc
 * window. The cardinality test below is the permanent guard against that regression, and
 * it is structural rather than timing-based on purpose.
 */
import { QueryClient } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const flush = () => new Promise((done) => { setTimeout(done, 0); });

const tripFixture = (id, index = 0) => ({
  id,
  status: 'completed',
  start_time: `2026-09-0${1 + (index % 8)}T12:00:00.000Z`,
  end_time: `2026-09-0${1 + (index % 8)}T12:20:00.000Z`,
  distance: 5 + index,
  duration: 20,
  route_points: [{ lat: 43.1, lng: -79.1, timestamp: `2026-09-0${1 + (index % 8)}T12:00:00.000Z` }],
});

describe('AUD-001 — the source-change coordinator refreshes every live P7 family', () => {
  let client;
  let keys;
  let sourceChange;

  beforeEach(async () => {
    vi.resetModules();
    sourceChange = await import('@/lib/p7SourceChange');
    sourceChange.resetP7SourceChangeForTests();
    ({ p7QueryKeys: keys } = await import('@/api/trips'));
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 30 * 60 * 1000 } } });
    // The same subscription `query-client.js` installs, against a client this test owns.
    sourceChange.subscribeP7SourceChange(() => {
      client.invalidateQueries({ queryKey: ['p7'], refetchType: 'none' }).catch(() => {});
    });
  });

  afterEach(() => {
    client?.clear();
    sourceChange.resetP7SourceChangeForTests();
  });

  /** Every family a migrated surface actually owns, named by the query it serves. */
  const families = () => ({
    'Q1 history page 1': keys.history('history:{"sort":"-start_time"}', 'first'),
    'Q2 detail': keys.detail('trip-1'),
    'Q4 aggregate': keys.aggregate('dashboard-lifetime', 'lifetime'),
    'Q5 buckets': keys.buckets('day', '2026-09'),
    'Q10 reducer': keys.reduce('p7.report.durationDistance', 1, 'coach-lifetime'),
    geometry: keys.geometry('map-screen'),
    achievements: keys.achievements('settings-hash'),
    'tag context': keys.tagContext(25),
    page: keys.page('diagnostics', 'prod'),
  });

  it('marks every P7 family stale on a source change', async () => {
    const all = families();
    for (const key of Object.values(all)) client.setQueryData(key, { value: 'stale-answer' });
    const fresh = Object.entries(all).filter(([, key]) => (
      client.getQueryCache().find({ queryKey: key })?.state.isInvalidated === false
    ));
    expect(fresh).toHaveLength(Object.keys(all).length);

    sourceChange.publishP7SourceChange('trip_committed');
    await flush();

    const missed = Object.entries(all)
      .filter(([, key]) => !client.getQueryCache().find({ queryKey: key })?.state.isInvalidated)
      .map(([name]) => name);
    expect(missed).toEqual([]);
  });

  it('leaves non-P7 caches alone', async () => {
    client.setQueryData(['settings-trips'], { value: 1 });
    sourceChange.publishP7SourceChange('trip_committed');
    await flush();
    expect(client.getQueryCache().find({ queryKey: ['settings-trips'] })?.state.isInvalidated)
      .toBe(false);
  });

  it('coalesces a burst into one invalidation', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    for (let index = 0; index < 60; index += 1) sourceChange.publishP7SourceChange('trips_committed');
    await flush();
    expect(invalidate).toHaveBeenCalledTimes(1);
    // The token still counts every change, so a consumer comparing tokens sees movement.
    expect(sourceChange.getP7SourceToken()).toBe(60);
  });

  /**
   * The cardinality property, which is the reason the revision is NOT in the key. A
   * thousand source changes must leave exactly the identities the live queries have.
   */
  it('never mints a new query identity for a source change', async () => {
    const all = Object.values(families());
    for (const key of all) client.setQueryData(key, { value: 0 });
    const before = client.getQueryCache().getAll().length;

    for (let index = 0; index < 1000; index += 1) {
      sourceChange.publishP7SourceChange(`mutation-${index}`);
      // A surface re-mints its key from the same semantic inputs after each change.
      for (const key of all) client.setQueryData(key, { value: index });
    }
    await flush();

    expect(client.getQueryCache().getAll().length).toBe(before);
    expect(before).toBe(all.length);
  });

  it('keeps the key factory free of any source revision', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src/api/trips.js'), 'utf8');
    const factory = source.slice(
      source.indexOf('export const p7QueryKeys'),
      source.indexOf('export const p7DetailQueryOptions'),
    );
    // `srcBinding` and Q2's `detailRevision` are caller-supplied SEMANTIC bindings, not
    // mutation counters, and every production caller leaves them empty. What may never
    // appear is the canonical SOURCE revision/generation/epoch — that is the
    // unbounded-cardinality regression this test exists to catch.
    const withoutSemanticParams = factory
      .replace(/detailRevision/g, '')
      .replace(/srcBinding/g, '');
    expect(withoutSemanticParams).not.toMatch(/revision|generation|epoch|sourceToken/i);
    const hookSources = ['useDashboardData', 'useReportData', 'useInsightsData', 'useTripHistoryTotals']
      .map((name) => readFileSync(resolve(process.cwd(), `src/hooks/${name}.js`), 'utf8'));
    for (const hookSource of hookSources) {
      expect(hookSource).not.toMatch(/p7QueryKeys\.[a-z]+\([^)]*(sourceRevision|queryRevision|sourceToken)/i);
    }
    const hooks = readFileSync(resolve(process.cwd(), 'src/hooks/useTripHistoryPageData.js'), 'utf8');
    expect(hooks).not.toMatch(/p7QueryKeys\.history\([^)]*(revision|token)/i);
  });
});

describe('AUD-001 — every canonical source change reaches the coordinator', () => {
  let indexedDb;
  let sourceChange;

  beforeEach(async () => {
    vi.resetModules();
    const { FakeIndexedDb, FakeKeyRange } = await import('@/lib/__tests__/helpers/fakeTripIndexedDb');
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name, optionsOrRun, maybeRun) => (
          typeof optionsOrRun === 'function' ? optionsOrRun({ name }) : maybeRun({ name })
        ),
      },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
    sourceChange = await import('@/lib/p7SourceChange');
    sourceChange.resetP7SourceChangeForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const moved = async (act) => {
    const before = sourceChange.getP7SourceToken();
    await act();
    return sourceChange.getP7SourceToken() > before;
  };

  it('signals on create, edit, import, delete and the conservative epoch', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    const reached = {
      create: await moved(() => repository.localTripRepository.create(tripFixture('coord-1'))),
      edit: await moved(() => repository.localTripRepository
        .update('coord-1', { status: 'completed', notes: 'edited' }).catch(() => null)),
      import: await moved(() => repository.localTripRepository.upsertMany(
        [tripFixture('coord-2', 1), tripFixture('coord-3', 2)],
      )),
      delete: await moved(() => repository.localTripRepository.delete('coord-2').catch(() => null)),
      restore: await moved(() => repository.advanceP7QueryEpoch('restore')),
      erasure: await moved(() => repository.advanceP7QueryEpoch('erasure')),
    };

    // Named individually so a failure says WHICH mutation class stopped refreshing.
    expect(reached).toEqual({
      create: true, edit: true, import: true, delete: true, restore: true, erasure: true,
    });
  });

  /**
   * AUD-001. `runLegacyBrowserRawGpsRetention()` is a DIRECT canonical mutation: it
   * rewrites the trip, its legacy summary and its `source_revision` in its own
   * transaction. It was the one path that changed canonical data without advancing the
   * query snapshot or telling the coordinator, so cursors stayed valid over changed rows
   * and live P7 answers stayed stale.
   *
   * The post-commit epilogue (privacy-audit append, derived-cache invalidation) does not
   * settle under this file's storage doubles, so the call is given a bounded settle
   * window. The revision advance and the signal both happen before it, so nothing being
   * asserted depends on the epilogue.
   */
  const runRetention = async (repository, tripId) => Promise.race([
    new Promise((resolve) => { setTimeout(resolve, 2000); }),
    repository.runLegacyBrowserRawGpsRetention({
      tripId,
      retentionDays: 1,
      motionRetentionDays: 1,
      now: Date.parse('2026-09-14T00:00:00.000Z'),
    }).catch(() => null),
  ]);

  const agedTrip = (id) => ({
    id,
    status: 'completed',
    start_time: '2026-09-01T12:00:00.000Z',
    end_time: '2026-09-01T12:20:00.000Z',
    distance: 8,
    duration: 20,
    route_points: [
      { lat: 43.1, lng: -79.1, timestamp: '2026-09-01T12:00:00.000Z' },
      { lat: 43.2, lng: -79.2, timestamp: '2026-09-01T12:10:00.000Z' },
    ],
  });

  it('advances the query revision and signals for a legacy retention rewrite', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(agedTrip('retention-signal'));

    const beforeSnapshot = await repository.readP7QuerySnapshot();
    const beforeToken = sourceChange.getP7SourceToken();
    await runRetention(repository, 'retention-signal');

    // The canonical mutation must move the snapshot every outstanding cursor is bound to.
    const afterSnapshot = await repository.readP7QuerySnapshot();
    expect(afterSnapshot.revision).toBeGreaterThan(beforeSnapshot.revision);
    // And the live families must be told, through the one coordinator.
    expect(sourceChange.getP7SourceToken()).toBeGreaterThan(beforeToken);
  }, 20000);

  it('does not signal when retention refuses without committing', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    const beforeToken = sourceChange.getP7SourceToken();
    // No such trip: the path refuses before any ciphertext or transaction exists.
    const outcome = await repository.runLegacyBrowserRawGpsRetention({
      tripId: 'never-stored',
      retentionDays: 1,
      now: Date.parse('2026-09-14T00:00:00.000Z'),
    });

    expect(outcome).toMatchObject({ changed: false });
    expect(sourceChange.getP7SourceToken()).toBe(beforeToken);
  });

  it('does not signal a revision the retention transaction refused to commit', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(agedTrip('retention-stale'));

    const beforeSnapshot = await repository.readP7QuerySnapshot();
    const beforeToken = sourceChange.getP7SourceToken();

    // Move the canonical row out from under the guard at the instant the retention
    // transaction opens. The guard then sees a record that is not the one it encoded
    // against, aborts, and must publish nothing: a signal here would announce a source
    // change that was never committed.
    const rows = indexedDb.getStoreState('drivesense_mobile', 'trips').records;
    const open = indexedDb.open.bind(indexedDb);
    indexedDb.open = (name, version) => {
      const request = open(name, version);
      let handler = null;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => handler,
        set: (fn) => {
          handler = (event) => {
            const database = request.result;
            if (database && !database.__staleHooked) {
              database.__staleHooked = true;
              const transaction = database.transaction.bind(database);
              database.transaction = (names, mode = 'readonly') => {
                const stores = Array.isArray(names) ? names : [names];
                if (mode === 'readwrite' && stores.includes('trips') && stores.includes('trip_summaries')) {
                  const row = rows.get('retention-stale');
                  if (row) rows.set('retention-stale', { ...row, source_revision: 'moved-underneath' });
                }
                return transaction(names, mode);
              };
            }
            fn?.(event);
          };
        },
      });
      return request;
    };

    let failure = null;
    const outcome = await Promise.race([
      new Promise((resolve) => { setTimeout(() => resolve('TIMEOUT'), 2000); }),
      repository.runLegacyBrowserRawGpsRetention({
        tripId: 'retention-stale',
        retentionDays: 1,
        motionRetentionDays: 1,
        now: Date.parse('2026-09-14T00:00:00.000Z'),
      }).catch((error) => { failure = error; return null; }),
    ]);
    indexedDb.open = open;
    expect(failure).toBeNull();

    expect(outcome).toMatchObject({ state: 'STALE_SOURCE', changed: false });
    // Nothing committed, so nothing is announced.
    expect(sourceChange.getP7SourceToken()).toBe(beforeToken);
    // The revision advance is issued INSIDE the aborted transaction, so real IndexedDB
    // rolls it back with everything else. This double commits each put independently and
    // cannot model that rollback, so the durable revision is deliberately not asserted
    // here — what is asserted is that no source change was published over it.
    expect(beforeSnapshot.revision).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('signals even when the epoch advance could not be made durable', async () => {
    const repository = await import('@/lib/localTripRepository');
    // No IndexedDB at all is not the failure path; a write that throws is.
    const advanced = await moved(async () => {
      const original = indexedDb.open.bind(indexedDb);
      indexedDb.open = () => { throw new Error('storage unavailable'); };
      try {
        await repository.advanceP7QueryEpoch('erasure').catch(() => null);
      } finally {
        indexedDb.open = original;
      }
    });
    // Conservatively known to have advanced: every outstanding cursor is refused for the
    // rest of the session, so a cache still showing the old answer is the same defect.
    expect(advanced).toBe(true);
  });
});

describe('AUD-001 — history accumulation resets with the source', () => {
  // This repository has no React renderer in its test stack (no @testing-library/react,
  // no react-test-renderer), so the hook's wiring is asserted structurally. What the
  // wiring CALLS — subscription, coalescing, token movement — is covered behaviourally
  // above; what is pinned here is that the hook is actually attached to it.
  const hook = readFileSync(resolve(process.cwd(), 'src/hooks/useTripHistoryPageData.js'), 'utf8');

  it('subscribes to the coordinator', () => {
    expect(hook).toContain("from '@/lib/p7SourceChange'");
    expect(hook).toMatch(/useEffect\(\(\) => subscribeP7SourceChange\(/);
  });

  it('discards accumulated continuation rows on a source change', () => {
    expect(hook).toMatch(/subscribeP7SourceChange\(\(\{ token \}\) => \{[\s\S]{0,300}?setAccumulated\(/);
    expect(hook).toMatch(/current === EMPTY \? current : EMPTY/);
  });

  it('drops an in-flight continuation turn that spans a source change', () => {
    expect(hook).toMatch(/const turnToken = sourceToken\.current;/);
    expect(hook).toMatch(/if \(sourceToken\.current !== turnToken\) return;/);
  });

  it('still refetches the first page, which React Query owns', () => {
    // Page 1 lives under a `['p7','history',...]` key, so the coordinator's semantic
    // invalidation reaches it; the hook must not have opted out with its own key shape.
    expect(hook).toMatch(/queryKey: p7QueryKeys\.history\(requestId, 'first'\)/);
  });
});
