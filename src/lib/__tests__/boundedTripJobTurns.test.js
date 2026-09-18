import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  pages: [],
  pageCalls: [],
  failures: new Map(),
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => (
    fixture.storage.has(key) ? structuredClone(fixture.storage.get(key)) : fallback
  )),
  setJson: vi.fn(async (key, value) => { fixture.storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { fixture.storage.delete(key); }),
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    queryHistoryPage: vi.fn(async ({ cursor = null }) => {
      fixture.pageCalls.push(cursor);
      const page = fixture.pages.find((entry) => (entry.cursor || null) === (cursor || null));
      if (!page) throw new Error(`No fixture page for cursor ${String(cursor)}`);
      return { rows: page.rows.map((row) => ({ ...row })), nextCursor: page.nextCursor };
    }),
    getFullById: vi.fn(async (id) => ({ id })),
    getPayloadStream: vi.fn(async () => (async function* () {})()),
  },
}));

vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn() }));

import { setJson } from '@/lib/mobileStorage';
import { logSystemFailure } from '@/lib/systemLog';
import {
  BOUNDED_JOB_STATE_VERSION,
  MAX_JOB_STATE_BYTES,
  runBoundedTripJob,
  runBoundedTripJobTurn,
} from '@/lib/boundedTripJob';

const JOB_KEY = 'v18-job';
const CHECKPOINT_KEY = `drivesense_bounded_job_${JOB_KEY}`;
const FINGERPRINT = 'fp-1';

// Three pages of two trips each. Cursor `null` -> `c1` -> `c2` -> end.
const buildPages = () => {
  fixture.pages = [
    { cursor: null, rows: [{ id: 't1' }, { id: 't2' }], nextCursor: 'c1' },
    { cursor: 'c1', rows: [{ id: 't3' }, { id: 't4' }], nextCursor: 'c2' },
    { cursor: 'c2', rows: [{ id: 't5' }, { id: 't6' }], nextCursor: null },
  ];
};

const checkpoint = () => fixture.storage.get(CHECKPOINT_KEY) || null;

beforeEach(() => {
  fixture.storage.clear();
  fixture.pageCalls = [];
  fixture.failures.clear();
  buildPages();
  vi.mocked(logSystemFailure).mockClear();
});

describe('DN1 bounded trip job failure contract', () => {
  it('V18: a non-cancellation failure mid-page keeps the last committed checkpoint', async () => {
    const seen = [];
    await expect(runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => {
        // Page 1 commits in full. Page 2 fails partway through, after `t3`
        // has already mutated in-memory state and `processed`.
        if (tripId === 't4') throw new Error('domain failure mid-page');
        seen.push(tripId);
        return { ids: [...state.ids, tripId] };
      },
    })).rejects.toThrow('domain failure mid-page');

    // Field-equivalent to the last committed boundary: page 1's end.
    expect(checkpoint()).toMatchObject({
      version: BOUNDED_JOB_STATE_VERSION,
      fingerprint: FINGERPRINT,
      cursor: 'c1',
      processed: 2,
      state: { ids: ['t1', 't2'] },
      done: false,
    });
    // Uncommitted page-2 progress (`t3`) must not have leaked into it.
    expect(checkpoint().state.ids).not.toContain('t3');
    expect(logSystemFailure).toHaveBeenCalledWith(
      'bounded_trip_job_failed',
      expect.any(Error),
      expect.objectContaining({ job_key: JOB_KEY })
    );
  });

  it('V18: a retry after that failure resumes from the committed cursor', async () => {
    await expect(runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => {
        if (tripId === 't4') throw new Error('domain failure mid-page');
        return { ids: [...state.ids, tripId] };
      },
    })).rejects.toThrow();

    fixture.pageCalls = [];
    const retry = await runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });

    // Resumed at `c1`; page 1 was never rescanned.
    expect(fixture.pageCalls).toEqual(['c1', 'c2']);
    expect(retry).toMatchObject({ resumed: true, completed: true, processed: 6 });
    // Committed page-1 state resumed intact; page 2 replayed exactly once.
    expect(retry.state.ids).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(checkpoint()).toMatchObject({ cursor: null, done: true, processed: 6 });
  });

  it('V18: cancellation keeps its existing semantics and prior checkpoint', async () => {
    const controller = new AbortController();
    const outcome = await runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      signal: controller.signal,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => {
        if (tripId === 't3') controller.abort();
        return { ids: [...state.ids, tripId] };
      },
    });

    expect(outcome).toMatchObject({ cancelled: true, completed: false });
    expect(checkpoint()).toMatchObject({ cursor: 'c1', processed: 2, done: false });
    expect(logSystemFailure).not.toHaveBeenCalled();
  });

  it('V18: oversized checkpoint state still fails and is not finalized', async () => {
    await expect(runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ blob: '' }),
      onTrip: () => ({ blob: 'x'.repeat(MAX_JOB_STATE_BYTES + 10) }),
    })).rejects.toMatchObject({ code: 'BOUNDED_JOB_STATE_TOO_LARGE' });

    // Nothing was ever committed, so nothing may be marked complete.
    expect(checkpoint()).toBeNull();
  });
});

describe('bounded scheduler-turn contract', () => {
  it('V18: one turn processes one page and reports hasMore under one identity', async () => {
    const turnOne = await runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });

    expect(turnOne).toMatchObject({ hasMore: true, completed: false, processed: 2, cursor: 'c1' });
    expect(fixture.pageCalls).toEqual([null]);
    expect(checkpoint()).toMatchObject({ cursor: 'c1', processed: 2, done: false });

    const turnTwo = await runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });
    expect(turnTwo).toMatchObject({ hasMore: true, resumed: true, processed: 4, cursor: 'c2' });

    const turnThree = await runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });
    expect(turnThree).toMatchObject({ hasMore: false, completed: true, processed: 6, cursor: null });
    // Three turns, three pages, never more than one page of residency per turn.
    expect(fixture.pageCalls).toEqual([null, 'c1', 'c2']);
    expect(checkpoint()).toMatchObject({ cursor: null, done: true, processed: 6 });
  });

  it('the per-turn ceiling is independent of how much history remains', async () => {
    fixture.pages = Array.from({ length: 40 }, (_, index) => ({
      cursor: index === 0 ? null : `c${index}`,
      rows: [{ id: `t${index}a` }, { id: `t${index}b` }],
      nextCursor: index === 39 ? null : `c${index + 1}`,
    }));

    const trips = [];
    const turn = await runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({}),
      onTrip: ({ tripId }) => { trips.push(tripId); },
    });

    expect(turn.hasMore).toBe(true);
    expect(trips).toHaveLength(2);
    expect(fixture.pageCalls).toHaveLength(1);
  });

  it('a turn that consumes pages without advancing its cursor fails closed', async () => {
    fixture.pages = [{ cursor: null, rows: [{ id: 't1' }], nextCursor: null }];
    // A backend that hands back the cursor it was given must not be able to
    // spin one scheduler turn at a time.
    fixture.pages = [{ cursor: null, rows: [{ id: 't1' }], nextCursor: null }];
    fixture.pages.push({ cursor: 'stuck', rows: [{ id: 't2' }], nextCursor: 'stuck' });

    await expect(runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      resume: false,
      initialState: () => ({}),
      onTrip: () => {},
      // Force the stuck page by resuming from its cursor.
    })).resolves.toMatchObject({ completed: true });

    fixture.storage.set(CHECKPOINT_KEY, {
      version: BOUNDED_JOB_STATE_VERSION,
      fingerprint: FINGERPRINT,
      cursor: 'stuck',
      processed: 0,
      state: {},
      done: false,
    });
    await expect(runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({}),
      onTrip: () => {},
    })).rejects.toThrow('Bounded trip page cursor did not advance');
  });

  it('the default full-pass invocation is unchanged for existing callers', async () => {
    const outcome = await runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });

    expect(outcome).toMatchObject({ completed: true, cancelled: false, processed: 6 });
    expect(fixture.pageCalls).toEqual([null, 'c1', 'c2']);
    expect(checkpoint()).toMatchObject({ cursor: null, done: true });
  });
});

describe('P4-C-F01: a stuck cursor is refused before it can corrupt the checkpoint', () => {
  const seedCheckpoint = (payload) => {
    fixture.storage.set(CHECKPOINT_KEY, {
      version: BOUNDED_JOB_STATE_VERSION,
      fingerprint: FINGERPRINT,
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...payload,
    });
  };

  it('leaves the last valid checkpoint byte-equivalent and folds nothing', async () => {
    // A backend that hands back the cursor it was given, on a non-empty page.
    fixture.pages = [
      { cursor: null, rows: [{ id: 't1' }, { id: 't2' }], nextCursor: 'c1' },
      { cursor: 'c1', rows: [{ id: 't3' }, { id: 't4' }], nextCursor: 'c1' },
    ];
    seedCheckpoint({ cursor: 'c1', processed: 2, state: { ids: ['t1', 't2'] }, done: false });
    const before = structuredClone(checkpoint());

    const folded = [];
    const job = () => runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => {
        folded.push(tripId);
        return { ids: [...state.ids, tripId] };
      },
    });

    await expect(job()).rejects.toThrow('Bounded trip page cursor did not advance');

    // Nothing was folded, nothing was counted, and the durable boundary is
    // field-for-field what it was before the turn.
    expect(folded).toEqual([]);
    expect(checkpoint()).toEqual(before);
    expect(checkpoint().processed).toBe(2);
    expect(checkpoint().state).toEqual({ ids: ['t1', 't2'] });
    expect(logSystemFailure).toHaveBeenCalledWith(
      'bounded_trip_job_failed',
      expect.any(Error),
      expect.objectContaining({ job_key: JOB_KEY }),
    );

    // The retry, against a backend that advances, folds each remaining row once.
    fixture.pages[1] = { cursor: 'c1', rows: [{ id: 't3' }, { id: 't4' }], nextCursor: null };
    const retry = await job();

    expect(folded).toEqual(['t3', 't4']);
    expect(retry).toMatchObject({ completed: true, processed: 4 });
    expect(retry.state).toEqual({ ids: ['t1', 't2', 't3', 't4'] });
    expect(checkpoint()).toMatchObject({ cursor: null, done: true, processed: 4 });
  });

  it('does not report a successful hasMore turn when the boundary write fails', async () => {
    fixture.pages = [
      { cursor: null, rows: [{ id: 't1' }], nextCursor: 'c1' },
      { cursor: 'c1', rows: [{ id: 't2' }], nextCursor: 'c2' },
      { cursor: 'c2', rows: [{ id: 't3' }], nextCursor: 'c3' },
      { cursor: 'c3', rows: [{ id: 't4' }], nextCursor: null },
    ];

    // One committed boundary to protect.
    const first = await runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });
    expect(first).toMatchObject({ hasMore: true, cursor: 'c1' });
    const committed = structuredClone(checkpoint());

    // With checkpointEveryPages above the turn's page budget, the boundary
    // write is the turn's only durable write - so its failure is the turn's.
    vi.mocked(setJson).mockRejectedValueOnce(new Error('durable write failed'));
    await expect(runBoundedTripJobTurn({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      checkpointEveryPages: 3,
      maxPages: 2,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    })).rejects.toThrow('durable write failed');

    // The durable state is still the last valid boundary, not the turn's claim.
    expect(checkpoint()).toEqual(committed);
    expect(logSystemFailure).toHaveBeenCalledWith(
      'bounded_trip_job_checkpoint_failed',
      expect.any(Error),
      expect.objectContaining({ job_key: JOB_KEY }),
    );
  });

  it('still finalizes an exhausted pass whose only write is the boundary write', async () => {
    const outcome = await runBoundedTripJob({
      jobKey: JOB_KEY,
      fingerprint: FINGERPRINT,
      checkpointEveryPages: 10,
      initialState: () => ({ ids: [] }),
      onTrip: ({ tripId, state }) => ({ ids: [...state.ids, tripId] }),
    });

    expect(outcome).toMatchObject({ completed: true, processed: 6, cancelled: false });
    expect(checkpoint()).toMatchObject({ cursor: null, done: true, processed: 6 });
  });
});
