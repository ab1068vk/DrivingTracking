import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V17 / V32 — bounded migration turns and the DN3 write contract.
 *
 * The domain semantics under test here are deliberately *not* redesigned:
 * manifest chaining, pass/row checkpoints, two-pass verification, quarantine,
 * source-vs-target failure classification, low-space handling and exact
 * promotion all remain owned by `p35Migration` and the native archive. What is
 * asserted is that one scheduler turn performs one bounded unit and that a
 * user-visible write never waits for the whole migration.
 */

const state = vi.hoisted(() => ({
  pages: [],
  trips: new Map(),
  checkpoint: null,
  checkpointWrites: [],
  journalQueue: [],
  commitFailures: new Map(),
  quarantined: [],
  completeResult: { verified: true, authorityState: 'NATIVE' },
  completeCalls: [],
  legacyPageCalls: [],
}));

const loadMigration = async () => {
  vi.resetModules();
  vi.doMock('@/lib/localTripRepository', () => ({
    localTripRepository: {
      listLegacyMigrationPage: vi.fn(async ({ cursor = null, limit }) => {
        state.legacyPageCalls.push({ cursor, limit });
        const index = cursor ? Number(String(cursor).replace('p', '')) : 0;
        const page = state.pages[index];
        if (!page) return { rows: [], hasMore: false, nextCursor: null };
        return {
          rows: page.map((id) => ({ id })),
          hasMore: index + 1 < state.pages.length,
          nextCursor: index + 1 < state.pages.length ? `p${index + 1}` : null,
        };
      }),
      getLegacyTripForMigration: vi.fn(async (id) => {
        if (!state.trips.has(id)) throw new Error('Legacy trip source record is missing');
        return state.trips.get(id);
      }),
    },
  }));
  vi.doMock('@/lib/nativeTripArchive', () => {
    class CanonicalArchiveError extends Error {
      constructor(code, message) { super(message); this.name = 'CanonicalArchiveError'; this.code = code; }
    }
    return {
      CanonicalArchiveError,
      sha256Hex: vi.fn(async (bytes) => {
        let hash = 0;
        for (const byte of bytes) hash = (hash * 31 + byte) >>> 0;
        return hash.toString(16).padStart(64, '0');
      }),
      streamJsonToMigration: vi.fn(async (trip) => {
        const failure = state.commitFailures.get(trip.id);
        if (failure) throw failure;
        return { payloadHash: 'a'.repeat(64) };
      }),
      nativeTripArchive: {
        ingestJournal: vi.fn(async () => state.journalQueue.shift() || { itemCount: 0, hasMore: false }),
        migrationCheckpoint: vi.fn(async () => ({ checkpoint: state.checkpoint })),
        saveMigrationCheckpoint: vi.fn(async (checkpoint) => {
          state.checkpoint = structuredClone(checkpoint);
          state.checkpointWrites.push(structuredClone(checkpoint));
        }),
        quarantineLegacySource: vi.fn(async (payload) => { state.quarantined.push(payload); }),
        completeMigration: vi.fn(async (payload) => {
          state.completeCalls.push(payload);
          return state.completeResult;
        }),
      },
    };
  });
  return import('@/lib/p35Migration');
};

beforeEach(() => {
  state.pages = [['t1', 't2'], ['t3', 't4'], ['t5']];
  state.trips = new Map(['t1', 't2', 't3', 't4', 't5'].map((id) => [id, { id, points: [] }]));
  state.checkpoint = null;
  state.checkpointWrites = [];
  state.journalQueue = [];
  state.commitFailures = new Map();
  state.quarantined = [];
  state.completeResult = { verified: true, authorityState: 'NATIVE' };
  state.completeCalls = [];
  state.legacyPageCalls = [];
});

const drain = async (step, limit = 40) => {
  const turns = [];
  for (let index = 0; index < limit; index += 1) {
    const turn = await step();
    turns.push(turn);
    if (turn.outcome !== 'hasMore') break;
  }
  return turns;
};

describe('V17: bounded migration turns', () => {
  it('performs one bounded unit per turn and converges across many turns', async () => {
    const { stepLegacyMigration } = await loadMigration();

    const first = await stepLegacyMigration();
    expect(first).toMatchObject({ outcome: 'hasMore', unit: 'migrating' });
    // One page of the MIGRATING pass, not the whole legacy history.
    expect(state.legacyPageCalls).toEqual([{ cursor: null, limit: 50 }]);

    const turns = [first, ...(await drain(() => stepLegacyMigration()))];
    const final = turns.at(-1);

    expect(final).toMatchObject({ outcome: 'done', unit: 'verified', verified: true });
    // MIGRATING pages + VERIFYING pages + the completion turn: many turns, and
    // every one of them read exactly one 50-row legacy page.
    expect(turns.length).toBeGreaterThan(4);
    expect(new Set(state.legacyPageCalls.map((call) => call.limit))).toEqual(new Set([50]));
    expect(state.checkpoint).toMatchObject({ phase: 'VERIFIED' });
  });

  it('drains the journal as its own bounded unit before scanning legacy rows', async () => {
    state.journalQueue = [{ itemCount: 8, hasMore: true }, { itemCount: 8, hasMore: true }];
    const { stepLegacyMigration } = await loadMigration();

    const first = await stepLegacyMigration();
    const second = await stepLegacyMigration();

    expect(first).toMatchObject({ outcome: 'hasMore', unit: 'journal', itemCount: 8 });
    expect(second).toMatchObject({ outcome: 'hasMore', unit: 'journal' });
    expect(state.legacyPageCalls).toEqual([]);
  });

  it('resumes from the domain checkpoint after a simulated process restart', async () => {
    let module = await loadMigration();
    await module.stepLegacyMigration();
    await module.stepLegacyMigration();
    const midpoint = structuredClone(state.checkpoint);
    expect(midpoint.phase).toBe('MIGRATING');

    // Fresh module registry, same durable native checkpoint.
    state.legacyPageCalls = [];
    module = await loadMigration();
    state.checkpoint = midpoint;
    await module.stepLegacyMigration();

    // Resumed at the committed page cursor rather than rescanning from zero.
    expect(state.legacyPageCalls[0].cursor).toBe(midpoint.pageCursor);
  });

  it('keeps quarantine and two-pass verification semantics unchanged', async () => {
    state.trips.delete('t3');
    const { stepLegacyMigration } = await loadMigration();
    const turns = await drain(() => stepLegacyMigration());

    expect(turns.at(-1)).toMatchObject({ outcome: 'done' });
    expect(state.quarantined).toHaveLength(1);
    expect(state.quarantined[0]).toMatchObject({ sourceLocator: 'indexeddb:trips:t3' });
    // Exactly one promotion attempt, carrying the domain's own counts.
    expect(state.completeCalls).toHaveLength(1);
    expect(state.completeCalls[0]).toMatchObject({ quarantineCount: expect.any(Number) });
  });

  it('reports low space as backoff, not failure, so a blocked device does not spin', async () => {
    const { CanonicalArchiveError } = await import('@/lib/nativeTripArchive');
    state.commitFailures.set('t1', Object.assign(new Error('LOW_SPACE'), { code: 'LOW_SPACE_BLOCKED' }));
    const { stepLegacyMigration } = await loadMigration();

    const turn = await stepLegacyMigration();

    expect(turn).toMatchObject({ outcome: 'backoff', code: 'LOW_SPACE_BLOCKED' });
    expect(state.completeCalls).toEqual([]);
    expect(CanonicalArchiveError).toBeDefined();
  });

  it('classifies a target failure as failing without promoting', async () => {
    state.commitFailures.set('t1', Object.assign(new Error('plugin exploded'), { code: 'CANONICAL_UNAVAILABLE' }));
    const { stepLegacyMigration } = await loadMigration();

    const turn = await stepLegacyMigration();

    expect(turn).toMatchObject({ outcome: 'failing', code: 'CANONICAL_UNAVAILABLE' });
    expect(state.completeCalls).toEqual([]);
    expect(state.checkpoint?.phase).not.toBe('VERIFIED');
  });

  it('runs exactly one migration logical turn at a time', async () => {
    const { stepLegacyMigration } = await loadMigration();
    const [a, b] = await Promise.all([stepLegacyMigration(), stepLegacyMigration()]);
    expect(a).toBe(b);
  });

  it('does not re-run a migration that already verified', async () => {
    state.checkpoint = { phase: 'VERIFIED', result: { verified: true } };
    const { stepLegacyMigration } = await loadMigration();

    const turn = await stepLegacyMigration();

    expect(turn).toMatchObject({ outcome: 'done', unit: 'already-verified', verified: true });
    expect(state.legacyPageCalls).toEqual([]);
    expect(state.completeCalls).toEqual([]);
  });

  it('P4-C-F03: the last verification page never promotes in the same turn', async () => {
    const { stepLegacyMigration } = await loadMigration();

    // Drive up to, and including, the turn that finishes the verification pass.
    let turn = null;
    for (let index = 0; index < 40; index += 1) {
      turn = await stepLegacyMigration();
      if (turn.unit === 'verifying-complete') break;
    }

    expect(turn).toMatchObject({ outcome: 'hasMore', unit: 'verifying-complete' });
    // The distinct comparison/promotion operation is not part of that turn.
    expect(state.completeCalls).toEqual([]);
    expect(state.checkpoint).toMatchObject({ phase: 'READY_TO_FINALIZE' });
    expect(state.checkpoint.baseline).toBeTruthy();

    // The next turn performs promotion alone, with no page traversal at all.
    const pagesBefore = state.legacyPageCalls.length;
    const finalize = await stepLegacyMigration();

    expect(finalize).toMatchObject({ outcome: 'done', unit: 'verified', verified: true });
    expect(state.completeCalls).toHaveLength(1);
    expect(state.legacyPageCalls).toHaveLength(pagesBefore);
    expect(state.checkpoint).toMatchObject({ phase: 'VERIFIED' });
  });

  it('P4-C-F03: an unverified promotion defers for recovery instead of reporting done', async () => {
    state.completeResult = { verified: false, authorityState: 'RECOVERY_REQUIRED' };
    const { stepLegacyMigration } = await loadMigration();

    const turns = await drain(() => stepLegacyMigration());
    const final = turns.at(-1);

    // Never `done`: the coordinator may not count an unverified cutover as
    // complete background work.
    expect(final.outcome).not.toBe('done');
    expect(final).toMatchObject({
      outcome: 'deferred',
      unit: 'shortfall',
      verified: false,
      authorityState: 'RECOVERY_REQUIRED',
    });
    expect(state.checkpoint).toMatchObject({ phase: 'SHORTFALL' });
    expect(state.completeCalls).toHaveLength(1);

    // A later healthy retry promotes exactly once, with no page rescan and no
    // duplicate cutover.
    state.completeResult = { verified: true, authorityState: 'NATIVE' };
    const pagesBefore = state.legacyPageCalls.length;
    const retry = await stepLegacyMigration();

    expect(retry).toMatchObject({ outcome: 'done', unit: 'verified', verified: true });
    expect(state.completeCalls).toHaveLength(2);
    expect(state.legacyPageCalls).toHaveLength(pagesBefore);
    expect(state.checkpoint).toMatchObject({ phase: 'VERIFIED' });

    // And once verified, nothing promotes again.
    const after = await stepLegacyMigration();
    expect(after).toMatchObject({ outcome: 'done', unit: 'already-verified' });
    expect(state.completeCalls).toHaveLength(2);
  });

  it('the historical run-to-completion caller still verifies in one call', async () => {
    const { migrateLegacyTripsToNativeArchive } = await loadMigration();
    const result = await migrateLegacyTripsToNativeArchive();
    expect(result).toMatchObject({ verified: true });
    expect(state.checkpoint).toMatchObject({ phase: 'VERIFIED' });
  });
});

describe('V32: DN3 bounded write contract during migration', () => {
  /**
   * The real production call graph: `api/trips` reaches migration only through
   * the exported P4 admission API, which admits the registered
   * `legacyMigration` job on the production coordinator. Nothing here stubs
   * that seam, so a direct `stepLegacyMigration()` call from `api/trips` would
   * leave the coordinator with no instance at all and fail these tests.
   */
  const loadTripApi = async ({ authorityState, android = true }) => {
    vi.resetModules();
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    vi.doMock('@/lib/nativePlatform', () => ({ isAndroid: () => android, isNativePlatform: () => android }));
    vi.doMock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));
    const health = vi.fn(async () => ({
      authorityState: authorityState(),
      recoveryState: 'HEALTHY',
      sentinelMatches: true,
    }));
    const legacyCreate = vi.fn(async () => ({ id: 'legacy-write' }));
    const nativeCreate = vi.fn(async () => ({ id: 'native-write' }));
    const legacyRestoreBatch = vi.fn(async (trips) => ({
      attemptedTrips: trips.length,
      processedTrips: trips.length,
      survivingTrips: trips,
      removedByRetention: 0,
      failedWrites: 0,
      unprocessedTrips: 0,
      retentionPending: 0,
      status: 'complete',
    }));
    const nativeRestoreBatch = vi.fn(async (trips) => ({
      attemptedTrips: trips.length,
      processedTrips: trips.length,
      survivingTrips: trips,
      removedByRetention: 0,
      failedWrites: 0,
      unprocessedTrips: 0,
      retentionPending: 0,
      status: 'complete',
    }));
    const step = vi.fn(async () => ({ outcome: 'done', unit: 'verified', verified: true }));
    vi.doMock('@/lib/p35Migration', () => ({ stepLegacyMigration: step }));
    vi.doMock('@/lib/localTripRepository', () => ({
      localTripRepository: {
        create: legacyCreate,
        restoreBatch: legacyRestoreBatch,
        list: vi.fn(async () => []),
      },
    }));
    vi.doMock('@/lib/nativeTripRepository', () => ({
      nativeTripRepository: {
        create: nativeCreate,
        restoreBatch: nativeRestoreBatch,
        list: vi.fn(async () => []),
      },
    }));
    vi.doMock('@/lib/nativeTripArchive', () => {
      class CanonicalArchiveError extends Error {
        constructor(code, message) { super(message); this.name = 'CanonicalArchiveError'; this.code = code; }
      }
      return { CanonicalArchiveError, nativeTripArchive: { health } };
    });

    const api = await import('@/api/trips');
    const lifecycle = await import('@/lib/appLifecycleWork');
    const coordinator = lifecycle.getP4WorkCoordinator();
    return {
      api,
      health,
      legacyCreate,
      nativeCreate,
      legacyRestoreBatch,
      nativeRestoreBatch,
      step,
      lifecycle,
      coordinator,
    };
  };

  /** Let the trigger's deliberately un-awaited dynamic import and pump settle. */
  const settleTrigger = async () => {
    for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const migrationTurns = (fixture) => fixture.coordinator.getTelemetrySnapshot().events
    .filter((event) => event.jobKey === fixture.lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION);

  it('refuses a write during migration with a bounded typed retryable response', async () => {
    const fixture = await loadTripApi({ authorityState: () => 'MIGRATING' });

    await expect(fixture.api.tripService.create({ id: 'x' })).rejects.toMatchObject({
      name: 'CanonicalArchiveError',
      code: 'MIGRATION_IN_PROGRESS',
      retryable: true,
      authorityState: 'MIGRATING',
    });

    // The refusal did not await migration, and did not run a migration unit.
    expect(fixture.step).not.toHaveBeenCalled();

    // P4-C-F02: the trigger admitted the coordinator-owned instance instead,
    // and the coordinator - not `api/trips` - performed every bounded unit.
    await settleTrigger();
    expect(fixture.step).toHaveBeenCalledTimes(1);
    expect(migrationTurns(fixture)).toHaveLength(1);
    expect(migrationTurns(fixture)[0]).toMatchObject({ turnOutcome: 'done' });

    // No disposable-IDB fallback write, and no write to the wrong authority.
    expect(fixture.legacyCreate).not.toHaveBeenCalled();
    expect(fixture.nativeCreate).not.toHaveBeenCalled();
  });

  it('refuses identically while authority is still LEGACY', async () => {
    const { api, legacyCreate } = await loadTripApi({ authorityState: () => 'LEGACY' });
    await expect(api.tripService.create({ id: 'x' })).rejects.toMatchObject({
      code: 'MIGRATION_IN_PROGRESS',
      retryable: true,
    });
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it('treats restore batches as fail-closed canonical writes during migration', async () => {
    const fixture = await loadTripApi({ authorityState: () => 'MIGRATING' });

    await expect(fixture.api.tripService.restoreBatch([{ id: 'restore-trip' }], {
      retentionDays: 30,
    })).rejects.toMatchObject({
      code: 'MIGRATION_IN_PROGRESS',
      retryable: true,
      authorityState: 'MIGRATING',
    });
    expect(fixture.legacyRestoreBatch).not.toHaveBeenCalled();
    expect(fixture.nativeRestoreBatch).not.toHaveBeenCalled();
  });

  it('a later retry succeeds normally after verified promotion', async () => {
    let authority = 'MIGRATING';
    const { api, nativeCreate, legacyCreate } = await loadTripApi({ authorityState: () => authority });

    await expect(api.tripService.create({ id: 'x' })).rejects.toMatchObject({ code: 'MIGRATION_IN_PROGRESS' });

    authority = 'NATIVE';
    await expect(api.tripService.create({ id: 'x' })).resolves.toMatchObject({ id: 'native-write' });
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it('reads stay valid on the current source authority while migration progresses', async () => {
    const fixture = await loadTripApi({ authorityState: () => 'MIGRATING' });

    await expect(fixture.api.tripService.list()).resolves.toEqual([]);

    // The read returned on the legacy source without executing migration work.
    expect(fixture.step).not.toHaveBeenCalled();
    await settleTrigger();
    // And the coordinator owns the unit that did run.
    expect(migrationTurns(fixture)).toHaveLength(1);
    expect(fixture.step).toHaveBeenCalledTimes(1);
  });

  it('P4-C-F02: repeat triggers coalesce onto one logical migration instance', async () => {
    const fixture = await loadTripApi({ authorityState: () => 'MIGRATING' });
    fixture.step
      .mockResolvedValueOnce({ outcome: 'hasMore', unit: 'migrating', visitedCount: 50 })
      .mockResolvedValueOnce({ outcome: 'hasMore', unit: 'verifying', visitedCount: 50 })
      .mockResolvedValueOnce({ outcome: 'done', unit: 'verified', verified: true });

    // Two reads and a refused write, all in the same lifecycle epoch.
    await fixture.api.tripService.list();
    await fixture.api.tripService.list();
    await expect(fixture.api.tripService.create({ id: 'x' })).rejects.toMatchObject({
      code: 'MIGRATION_IN_PROGRESS',
    });
    await settleTrigger();

    const turns = migrationTurns(fixture);
    // P4-C-F02: three triggers, one logical instance, and the coordinator's own
    // tail re-admission - not another read - drove the remaining bounded units.
    expect(new Set(turns.map((event) => event.instanceId)).size).toBe(1);
    // Every domain step that ran was a coordinator turn: none was executed by
    // the read/write trigger itself.
    expect(fixture.step.mock.calls).toHaveLength(turns.length);
    expect(turns.length).toBeGreaterThanOrEqual(3);
    expect(turns.slice(0, 2).map((event) => event.turnOutcome)).toEqual(['hasMore', 'hasMore']);
    expect(turns.at(-1).turnOutcome).toBe('done');
    expect(fixture.coordinator.getCoordinatorSnapshot().activeInstances).toBe(0);
  });

  it('P4-C-F02: a web/native-disabled read makes zero native archive calls', async () => {
    const fixture = await loadTripApi({ authorityState: () => 'MIGRATING', android: false });

    await expect(fixture.api.tripService.list()).resolves.toEqual([]);
    await settleTrigger();

    // Web never reaches the native authority branch, and the migration job is
    // explicitly ownerless rather than a spuriously failing coordinator job.
    expect(fixture.health).not.toHaveBeenCalled();
    expect(fixture.step).not.toHaveBeenCalled();
    expect(migrationTurns(fixture)).toEqual([]);
    expect(fixture.lifecycle.ensureP4LegacyMigrationAdvancing()).toMatchObject({
      status: 'ownerless',
      jobKey: fixture.lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION,
      reason: 'native_authority_unavailable',
    });
    expect(fixture.lifecycle.getP4OwnerlessJobs().map((entry) => entry.jobKey))
      .toContain(fixture.lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION);
    await settleTrigger();
    expect(fixture.step).not.toHaveBeenCalled();
    expect(fixture.coordinator.getJobSnapshot(
      fixture.lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION,
    )).toMatchObject({ active: null, failing: false });
  });
});
