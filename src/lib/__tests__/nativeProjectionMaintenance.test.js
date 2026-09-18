import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  health: vi.fn(),
  page: vi.fn(),
  feed: vi.fn(),
  metadata: vi.fn(),
  readState: vi.fn(),
  apply: vi.fn(),
  committed: [],
}));

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    health: state.health,
    queryHistoryPage: state.page,
    projectionFeed: state.feed,
    metadata: state.metadata,
  },
}));

vi.mock('@/lib/localTripRepository', () => ({
  readNativeProjectionState: state.readState,
  applyNativeProjectionTurn: state.apply,
}));

import { runNativeProjectionTurn } from '@/lib/nativeProjectionMaintenance';

describe('bounded native projection maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.health.mockResolvedValue({
      authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
      archiveGeneration: 'g1', lastCommittedSeq: 12,
    });
    state.readState.mockResolvedValue(null);
    state.committed = [];
    // P4-B-F02: the generation fence is now evaluated by the repository inside
    // its commit barrier, so the repository seam has to honour it. A mock that
    // committed unconditionally would hide exactly the refusal being asserted.
    state.apply.mockImplementation(async ({
      generation, items = [], deletedIds = [], checkpoint, verifyCommit,
    }) => {
      const fence = verifyCommit ? await verifyCommit() : { allowed: true };
      if (!fence?.allowed) return { written: 0, deleted: 0, refused: true, fence };
      state.committed.push({ generation, items, deletedIds, checkpoint });
      return { written: items.length, deleted: deletedIds.length };
    });
  });

  it('rebuilds one bounded catalog page and persists its continuation', async () => {
    state.page.mockResolvedValue({ items: [{ id: 'a', revision: 1 }], nextCursor: 'next' });
    await expect(runNativeProjectionTurn()).resolves.toMatchObject({ mode: 'rebuild', applied: 1, done: false });
    expect(state.page).toHaveBeenCalledWith(expect.objectContaining({ maxItems: 100, maxBytes: 256 * 1024 }));
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'g1', items: [{ id: 'a', revision: 1 }],
      checkpoint: expect.objectContaining({ cursor: 'next', mode: 'rebuild' }),
    }));
  });

  it('restarts a catalog rebuild when the compacted event window has passed its checkpoint', async () => {
    state.readState.mockResolvedValue({ generation: 'g1', mode: 'catchup', afterSeq: 3, applied: 9 });
    state.feed.mockResolvedValue({ oldestAvailableSeq: 8, requiredSeq: 12, items: [] });
    await expect(runNativeProjectionTurn()).resolves.toMatchObject({
      mode: 'rebuild', reason: 'event_window_compacted', done: false,
    });
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'g1', checkpoint: expect.objectContaining({ mode: 'rebuild', afterSeq: 0 }),
    }));
  });

  it('applies a bounded delta with tombstones and metadata-by-id', async () => {
    state.readState.mockResolvedValue({ generation: 'g1', mode: 'catchup', afterSeq: 10, applied: 4 });
    state.feed.mockResolvedValue({
      oldestAvailableSeq: 10, afterSeq: 12, hasMore: false,
      items: [
        { eventType: 'COMMIT', tripId: 'kept' },
        { eventType: 'TOMBSTONE', tripId: 'gone' },
      ],
    });
    state.metadata.mockResolvedValue({ id: 'kept', revision: 2 });
    await expect(runNativeProjectionTurn()).resolves.toMatchObject({ mode: 'idle', applied: 1, deleted: 1, done: true });
    expect(state.metadata).toHaveBeenCalledTimes(1);
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ id: 'kept', revision: 2 }], deletedIds: ['gone'],
      checkpoint: expect.objectContaining({ afterSeq: 12, mode: 'idle' }),
    }));
  });

  it('does no projection work while canonical health is not proven', async () => {
    state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'RECOVERY_REQUIRED', sentinelMatches: true });
    await expect(runNativeProjectionTurn()).resolves.toEqual({ deferred: true, reason: 'canonical_not_healthy' });
    expect(state.page).not.toHaveBeenCalled();
    expect(state.feed).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('V12/V30: refuses a stale generation at the domain-owned projection commit fence', async () => {
    state.health
      .mockResolvedValueOnce({
        authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
        archiveGeneration: 'g1', lastCommittedSeq: 12,
      })
      .mockResolvedValueOnce({
        authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
        archiveGeneration: 'g2', lastCommittedSeq: 0,
      });
    state.page.mockResolvedValue({ items: [{ id: 'stale', revision: 1 }], nextCursor: 'next' });

    await expect(runNativeProjectionTurn({ expectedGeneration: 'g1' })).resolves.toEqual({
      obsolete: true,
      reason: 'canonical_generation_changed',
    });
    // The commit path was entered, re-read the fence inside it, and refused:
    // nothing was made durable under the superseded generation.
    expect(state.apply).toHaveBeenCalledTimes(1);
    expect(state.committed).toEqual([]);
  });

  it('refuses before reading projection state when the coordinator token is already stale', async () => {
    await expect(runNativeProjectionTurn({ expectedGeneration: 'g0' })).resolves.toEqual({
      obsolete: true,
      reason: 'canonical_generation_changed',
    });
    expect(state.readState).not.toHaveBeenCalled();
    expect(state.page).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
  });

  it('allows the process-local Physical H test authority without changing persisted authority', async () => {
    state.health.mockResolvedValue({
      authorityState: 'LEGACY', testAuthorityEnabled: true,
      recoveryState: 'HEALTHY', sentinelMatches: true,
      archiveGeneration: 'g-test', lastCommittedSeq: 2,
    });
    state.page.mockResolvedValue({ items: [{ id: 'physical-h-trip', revision: 1 }], nextCursor: null });

    await expect(runNativeProjectionTurn()).resolves.toMatchObject({ mode: 'catchup', applied: 1, done: true });
    expect(state.apply).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'g-test', items: [{ id: 'physical-h-trip', revision: 1 }],
    }));
  });

  it('keeps a legacy archive deferred when no Physical H test authority is active', async () => {
    state.health.mockResolvedValue({
      authorityState: 'LEGACY', testAuthorityEnabled: false,
      recoveryState: 'HEALTHY', sentinelMatches: true,
    });

    await expect(runNativeProjectionTurn()).resolves.toEqual({ deferred: true, reason: 'canonical_not_healthy' });
    expect(state.page).not.toHaveBeenCalled();
    expect(state.apply).not.toHaveBeenCalled();
  });
});
