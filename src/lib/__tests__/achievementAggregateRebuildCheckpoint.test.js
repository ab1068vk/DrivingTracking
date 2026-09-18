import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-B-F01-A2 regressions.
 *
 * The explicit whole-history rebuild and the bounded lifecycle repair share one
 * durable checkpoint (`achievement_aggregates`). They used to disagree about
 * what that checkpoint's `state` means — the explicit pass ran `resume:false`
 * with `initialState: () => ({})` and kept its real tally in local variables,
 * so a page it committed left an empty same-fingerprint state the bounded fold
 * would then inherit. Nothing stopped the two from running concurrently either.
 *
 * These tests drive the real bounded-job engine and the real durable checkpoint.
 */

const mocks = vi.hoisted(() => ({
  queryHistoryPage: vi.fn(),
  logFailure: vi.fn(),
}));

vi.mock('@/api/trips', () => ({
  tripService: { queryHistoryPage: mocks.queryHistoryPage },
}));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logFailure,
  recordSystemEvent: vi.fn(),
}));

import {
  ACHIEVEMENT_AGGREGATE_KEY,
  ACHIEVEMENT_REBUILD_JOB_KEY,
  ACHIEVEMENT_REBUILD_STATE_VERSION,
  isAchievementRebuildBusy,
  emptyAchievementAggregate,
  isResumableAchievementRebuildState,
  rebuildAchievementAggregates,
  stepAchievementAggregateRepair,
} from '@/lib/achievementAggregates';
import { BOUNDED_JOB_STATE_VERSION } from '@/lib/boundedTripJob';

const CHECKPOINT_KEY = `drivesense_bounded_job_${ACHIEVEMENT_REBUILD_JOB_KEY}`;
const SETTINGS = { fuel_price_per_liter: 1.8 };
const EMPTY_AGGREGATE = emptyAchievementAggregate();

const createStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    _values: values,
  };
};
let storage;

/** `pages` pages of 5 completed trips each, newest first. */
const historyOfPages = (pages, { failAfterPage = null } = {}) => {
  mocks.queryHistoryPage.mockImplementation(async ({ cursor = null }) => {
    const index = cursor === null ? 0 : Number(cursor);
    if (failAfterPage !== null && index > failAfterPage) {
      throw new Error('history unavailable');
    }
    const rows = Array.from({ length: 5 }, (_, row) => ({
      id: `trip-${index}-${row}`,
      status: 'completed',
      start_time: new Date(Date.UTC(2026, 5, 1 + index, 8 + row)).toISOString(),
      distance_km: 10 + row,
      duration_seconds: 900,
      score_overall: 80 + row,
      harsh_brakes_count: 0,
      rapid_accel_count: 0,
      sharp_turns_count: 0,
      speeding_events_count: 0,
    }));
    return { rows, nextCursor: index + 1 < pages ? String(index + 1) : null };
  });
};

const readCheckpoint = () => {
  const raw = storage.getItem(CHECKPOINT_KEY);
  return raw ? JSON.parse(raw) : null;
};

const readAggregate = () => {
  const raw = storage.getItem(ACHIEVEMENT_AGGREGATE_KEY);
  return raw ? JSON.parse(raw) : null;
};

const driveRepairToCompletion = async (maxTurns = 100) => {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const outcome = await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    if (outcome.hasMore === false) return turn + 1;
  }
  throw new Error('bounded repair did not converge');
};

describe('P4-B-F01-A2: one rebuild checkpoint contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage = createStorage();
    vi.stubGlobal('localStorage', storage);
    historyOfPages(4);
  });

  it('gives both entry points the same fingerprint and durable state shape', async () => {
    historyOfPages(3);
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    const boundedCheckpoint = readCheckpoint();
    expect(boundedCheckpoint).toMatchObject({ version: BOUNDED_JOB_STATE_VERSION, done: false });
    expect(boundedCheckpoint.fingerprint).toContain(`state${ACHIEVEMENT_REBUILD_STATE_VERSION}`);
    // The state is the real tally, not the empty object the old explicit pass left.
    expect(boundedCheckpoint.state).toMatchObject({ recentWindow: expect.any(Array) });
    expect(boundedCheckpoint.state.stats.completedCount).toBeGreaterThan(0);

    storage.clear();
    historyOfPages(3, { failAfterPage: 0 });
    await expect(rebuildAchievementAggregates(SETTINGS)).rejects.toThrow('history unavailable');
    const explicitCheckpoint = readCheckpoint();
    expect(explicitCheckpoint.fingerprint).toBe(boundedCheckpoint.fingerprint);
    expect(explicitCheckpoint.state.stats.completedCount).toBeGreaterThan(0);
  });

  it('lets bounded repair resume a partial explicit rebuild to the same result', async () => {
    // A clean authoritative rebuild, for comparison.
    historyOfPages(4);
    const clean = await rebuildAchievementAggregates(SETTINGS);
    expect(clean.aggregate.built).toBe(true);
    const expected = clean.aggregate;

    // Now: explicit rebuild commits a page and then fails.
    storage.clear();
    historyOfPages(4, { failAfterPage: 1 });
    await expect(rebuildAchievementAggregates(SETTINGS)).rejects.toThrow('history unavailable');
    const partial = readCheckpoint();
    expect(partial.done).toBe(false);
    expect(partial.processed).toBeGreaterThan(0);
    expect(readAggregate()).toBeNull();

    // The bounded repair resumes that partial state rather than inheriting an
    // empty one, and converges on the identical aggregate.
    historyOfPages(4);
    await driveRepairToCompletion();
    const repaired = readAggregate();
    expect(repaired.built).toBe(true);
    expect(repaired.stats).toEqual(expected.stats);
    expect(repaired.recentWindow).toEqual(expected.recentWindow);
    expect(repaired.seenTripIds).toEqual(expected.seenTripIds);
    expect(readCheckpoint()).toBeNull();
  });

  it('lets the explicit rebuild resume a partial bounded repair to the same result', async () => {
    historyOfPages(4);
    const clean = await rebuildAchievementAggregates(SETTINGS);
    const expected = clean.aggregate;

    storage.clear();
    historyOfPages(4);
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    expect(readCheckpoint().done).toBe(false);
    expect(readAggregate()).toBeNull();

    const finished = await rebuildAchievementAggregates(SETTINGS);
    expect(finished.aggregate.stats).toEqual(expected.stats);
    expect(finished.aggregate.recentWindow).toEqual(expected.recentWindow);
    expect(readAggregate().built).toBe(true);
  });

  it('rejects an incompatible legacy checkpoint instead of folding into it', async () => {
    // Exactly what the previously shipped explicit rebuild left behind: the old
    // fingerprint and an empty state.
    historyOfPages(4);
    storage.setItem(CHECKPOINT_KEY, JSON.stringify({
      version: BOUNDED_JOB_STATE_VERSION,
      fingerprint: 'achievements:1',
      cursor: '2',
      processed: 10,
      state: {},
      done: false,
      updatedAt: new Date().toISOString(),
    }));

    await driveRepairToCompletion();

    const repaired = readAggregate();
    expect(repaired.built).toBe(true);
    // Restarted clean rather than resuming from the stale cursor: every trip in
    // history is counted exactly once.
    expect(repaired.stats.completedCount).toBe(20);
  });

  it('serializes the two entry points on the one checkpoint', async () => {
    historyOfPages(6);
    let observedBusy = false;
    mocks.queryHistoryPage.mockImplementation(async ({ cursor = null }) => {
      const index = cursor === null ? 0 : Number(cursor);
      // Observed from inside the explicit pass, which holds the lock.
      if (isAchievementRebuildBusy()) observedBusy = true;
      const rows = Array.from({ length: 5 }, (_, row) => ({
        id: `trip-${index}-${row}`,
        status: 'completed',
        start_time: new Date(Date.UTC(2026, 5, 1 + index, 8 + row)).toISOString(),
        distance_km: 10, duration_seconds: 900, score_overall: 80,
      }));
      return { rows, nextCursor: index + 1 < 6 ? String(index + 1) : null };
    });

    const explicit = rebuildAchievementAggregates(SETTINGS);
    await Promise.resolve();
    // A coordinator slice must never wait behind the explicit pass: it reports
    // the checkpoint busy and yields its turn instead of joining a queue.
    const yielded = await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    expect(yielded).toMatchObject({ busy: true, hasMore: true, processed: 0 });

    await explicit;
    expect(observedBusy).toBe(true);
    expect(isAchievementRebuildBusy()).toBe(false);
    expect(readAggregate().built).toBe(true);
    // The yielded slice wrote nothing, so the explicit result is intact.
    expect(readAggregate().stats.completedCount).toBe(30);
  });

  // ── F01-1: the lock spans terminal publication, not just the page fold ─────

  it('holds the shared lock across terminal aggregate publication', async () => {
    // Drive the repair to its last page, so the next slice is the one that
    // finalizes: terminal pass + aggregate publication + checkpoint clear.
    historyOfPages(2);
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    expect(readCheckpoint().done).toBe(false);

    const order = [];
    mocks.queryHistoryPage.mockImplementation(async ({ cursor = null }) => {
      const index = cursor === null ? 0 : Number(cursor);
      order.push(`page:${index}`);
      const rows = Array.from({ length: 5 }, (_, row) => ({
        id: `trip-${index}-${row}`, status: 'completed',
        start_time: new Date(Date.UTC(2026, 5, 1 + index, 8 + row)).toISOString(),
        distance_km: 10, duration_seconds: 900, score_overall: 80,
      }));
      return { rows, nextCursor: index + 1 < 2 ? String(index + 1) : null };
    });

    // The finalizing slice and an explicit rebuild are started back to back,
    // without awaiting the first. Finalization awaits real async storage
    // writes, so a lock released before it would let the explicit pass start
    // paging - and then clear its checkpoint from under it.
    const bounded = stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 })
      .then((outcome) => { order.push('bounded-finalized'); return outcome; });
    const explicit = rebuildAchievementAggregates(SETTINGS)
      .then((outcome) => { order.push('explicit-done'); return outcome; });

    const boundedOutcome = await bounded;
    await explicit;

    expect(boundedOutcome).toMatchObject({ hasMore: false, built: true });
    // Nothing the explicit pass did happened before the bounded finalizer
    // completed: one owner controls fold, publication and cleanup together.
    expect(order.indexOf('bounded-finalized')).toBeLessThan(order.indexOf('page:0'));
    expect(order.indexOf('bounded-finalized')).toBeLessThan(order.indexOf('explicit-done'));
    expect(isAchievementRebuildBusy()).toBe(false);
    // Coherent end state: the newer explicit rebuild's own finalization stands,
    // and no checkpoint was left behind by either.
    expect(readAggregate().built).toBe(true);
    expect(readCheckpoint()).toBeNull();
  });

  it('releases the shared lock when finalization itself fails', async () => {
    historyOfPages(1);
    const realSetItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === ACHIEVEMENT_AGGREGATE_KEY) throw new Error('aggregate write failed');
      return realSetItem(key, value);
    };

    await expect(stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 }))
      .rejects.toThrow('aggregate write failed');
    storage.setItem = realSetItem;

    // A failed finalizer must not strand the shared job.
    expect(isAchievementRebuildBusy()).toBe(false);
    historyOfPages(1);
    await driveRepairToCompletion();
    expect(readAggregate().built).toBe(true);
  });

  it('still yields the lifecycle slice instead of waiting during finalization', async () => {
    historyOfPages(3);
    const explicit = rebuildAchievementAggregates(SETTINGS);
    await Promise.resolve();

    const yielded = await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    expect(yielded).toMatchObject({ busy: true, hasMore: true, processed: 0 });

    await explicit;
    expect(isAchievementRebuildBusy()).toBe(false);
  });

  // ── F01-2: a current-fingerprint checkpoint must also be structurally valid ─

  const currentFingerprintCheckpoint = (state) => JSON.stringify({
    version: BOUNDED_JOB_STATE_VERSION,
    fingerprint: `achievements:1:state${ACHIEVEMENT_REBUILD_STATE_VERSION}`,
    cursor: '2',
    processed: 10,
    state,
    done: false,
    updatedAt: new Date().toISOString(),
  });

  it.each([
    ['an empty state', {}],
    ['a null state', null],
    ['missing stats', { recentWindow: [] }],
    ['missing recentWindow', { stats: { completedCount: 3 } }],
    ['a recentWindow of the wrong type', { stats: {}, recentWindow: 'nope' }],
    ['a malformed stats object', { stats: { completedCount: 'many' }, recentWindow: [] }],
    ['recentWindow entries without ids', { stats: {}, recentWindow: [{ start: 1 }] }],
    ['an oversized recentWindow', {
      stats: {},
      recentWindow: Array.from({ length: 40 }, (_, index) => ({ id: `x${index}`, start: index })),
    }],
  ])('restarts safely from a current-fingerprint checkpoint with %s', async (_label, state) => {
    // A clean authoritative rebuild, for comparison.
    historyOfPages(4);
    const clean = await rebuildAchievementAggregates(SETTINGS);
    const expected = clean.aggregate;

    storage.clear();
    historyOfPages(4);
    // The corruption: current fingerprint, retained cursor and processed count,
    // unusable tally. Resuming this would skip pages 0-1 with an empty state.
    storage.setItem(CHECKPOINT_KEY, currentFingerprintCheckpoint(state));
    expect(isResumableAchievementRebuildState(state)).toBe(false);

    await driveRepairToCompletion();

    const repaired = readAggregate();
    expect(repaired.built).toBe(true);
    // Every trip counted exactly once: the cursor was not combined with a
    // reset accumulator.
    expect(repaired.stats.completedCount).toBe(20);
    expect(repaired.stats).toEqual(expected.stats);
    expect(repaired.recentWindow).toEqual(expected.recentWindow);
  });

  /**
   * P4-B-F01-2. A *complete* current-fingerprint state — every counter present,
   * a well-formed recent window — with one value persisted at the wrong type.
   * These are the cases a coercive `Number.isFinite(Number(value))` predicate
   * accepts: `normalizeRebuildState` spreads them through unchanged and
   * `foldLifetime`'s `+=` then concatenates (`'10' + 1 === '101'`) or folds a
   * boolean/null, while the checkpoint's later cursor is retained.
   */
  const completeCurrentState = async () => {
    historyOfPages(4);
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    const partial = readCheckpoint();
    expect(isResumableAchievementRebuildState(partial.state)).toBe(true);
    expect(partial.state.recentWindow.length).toBeGreaterThan(0);
    return partial.state;
  };

  it.each([
    ['a numeric-string counter', (state) => { state.stats.completedCount = '10'; }],
    ['an empty-string counter', (state) => { state.stats.completedCount = ''; }],
    ['a true counter', (state) => { state.stats.completedCount = true; }],
    ['a false counter', (state) => { state.stats.completedCount = false; }],
    ['a null counter', (state) => { state.stats.completedCount = null; }],
    ['a numeric-string window sort key', (state) => { state.recentWindow[0].start = '123'; }],
    ['a true window sort key', (state) => { state.recentWindow[0].start = true; }],
    ['a null window sort key', (state) => { state.recentWindow[0].start = null; }],
  ])('restarts safely from a complete current-fingerprint checkpoint with %s', async (_label, corrupt) => {
    historyOfPages(4);
    const clean = await rebuildAchievementAggregates(SETTINGS);
    const expected = clean.aggregate;

    storage.clear();
    const state = await completeCurrentState();
    storage.clear();
    historyOfPages(4);

    corrupt(state);
    // Coercible, but not a number: the old predicate accepted exactly this.
    expect(isResumableAchievementRebuildState(state)).toBe(false);
    storage.setItem(CHECKPOINT_KEY, currentFingerprintCheckpoint(state));
    const seeded = readCheckpoint();
    expect(seeded.cursor).toBe('2');
    expect(seeded.processed).toBe(10);

    await driveRepairToCompletion();

    const repaired = readAggregate();
    expect(repaired.built).toBe(true);
    // Arithmetic, not concatenation, and every trip counted exactly once.
    expect(typeof repaired.stats.completedCount).toBe('number');
    expect(repaired.stats.completedCount).toBe(20);
    expect(repaired.stats).toEqual(expected.stats);
    expect(repaired.recentWindow).toEqual(expected.recentWindow);
  });

  it('accepts persisted zero and rejects every coercible non-number', () => {
    const zeroed = { stats: {}, recentWindow: [{ id: 'a', start: 0 }] };
    for (const key of Object.keys(EMPTY_AGGREGATE.stats)) zeroed.stats[key] = 0;
    expect(isResumableAchievementRebuildState(zeroed)).toBe(true);

    for (const bad of ['10', '', true, false, null, [], {}, undefined, NaN]) {
      expect(isResumableAchievementRebuildState({
        ...zeroed,
        stats: { ...zeroed.stats, completedCount: bad },
      })).toBe(false);
      expect(isResumableAchievementRebuildState({
        ...zeroed,
        recentWindow: [{ id: 'a', start: bad }],
      })).toBe(false);
    }
  });

  it('still resumes a valid current-fingerprint checkpoint', async () => {
    historyOfPages(4);
    const clean = await rebuildAchievementAggregates(SETTINGS);
    const expected = clean.aggregate;

    storage.clear();
    historyOfPages(4);
    await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });
    const partial = readCheckpoint();
    expect(isResumableAchievementRebuildState(partial.state)).toBe(true);
    expect(partial.cursor).not.toBeNull();
    const processedAtPause = partial.processed;

    await driveRepairToCompletion();

    // Resumed rather than restarted, and still equal to the clean rebuild.
    expect(processedAtPause).toBeGreaterThan(0);
    expect(readAggregate().stats).toEqual(expected.stats);
    expect(readAggregate().recentWindow).toEqual(expected.recentWindow);
  });

  it('keeps a repair turn bounded to one page whatever the history size', async () => {
    historyOfPages(20);
    const outcome = await stepAchievementAggregateRepair(SETTINGS, { maxPages: 1 });

    expect(outcome).toMatchObject({ hasMore: true, built: false });
    expect(outcome.processed).toBeLessThanOrEqual(5);
    expect(mocks.queryHistoryPage.mock.calls.length).toBe(1);
    // Twenty pages of history means twenty bounded turns, not one large one.
    const turns = 1 + await driveRepairToCompletion();
    expect(turns).toBeGreaterThanOrEqual(20);
    expect(readAggregate().built).toBe(true);
  });
});
