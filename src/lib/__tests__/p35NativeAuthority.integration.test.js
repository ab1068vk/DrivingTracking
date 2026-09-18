import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  android: true,
  localList: vi.fn(),
  localPage: vi.fn(),
  localErase: vi.fn(),
  health: vi.fn(),
  page: vi.fn(),
  metadata: vi.fn(),
  overview: vi.fn(),
  adjacent: vi.fn(),
  aggregates: vi.fn(),
  chartBuckets: vi.fn(),
  tagContext: vi.fn(),
  sampleMetadata: vi.fn(),
  tombstone: vi.fn(),
  eraseGeneration: vi.fn(),
  payload: vi.fn(),
  streamCommit: vi.fn(),
}));

const loadApi = async ({ enabled = true, android = true } = {}) => {
  vi.resetModules();
  vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', enabled ? 'true' : 'false');
  state.android = android;
  vi.doMock('@/lib/nativePlatform', () => ({
    isAndroid: () => state.android,
    isNativePlatform: () => false,
  }));
  vi.doMock('@/lib/localTripRepository', () => ({
    localTripRepository: {
      list: state.localList,
      listSummaries: state.localList,
      listAll: vi.fn(() => { throw new Error('unexpected local authority'); }),
      listProjections: state.localPage,
      eraseAll: state.localErase,
    },
  }));
  vi.doMock('@/lib/nativeTripArchive', () => {
    class CanonicalArchiveError extends Error {
      constructor(code, message) { super(message); this.code = code; }
    }
    return {
      CanonicalArchiveError,
      nativeTripArchive: {
        health: state.health,
        queryHistoryPage: state.page,
        metadata: state.metadata,
        overview: state.overview,
        adjacent: state.adjacent,
        aggregates: state.aggregates,
        chartBuckets: state.chartBuckets,
        tagContext: state.tagContext,
        sampleMetadata: state.sampleMetadata,
        tombstone: state.tombstone,
        eraseGeneration: state.eraseGeneration,
      },
      readNativeTripPayload: state.payload,
      streamJsonToCanonicalCommit: state.streamCommit,
      iterateNativeTripJsonArray: vi.fn(),
      createNativeTripCommitWriter: vi.fn(),
    };
  });
  vi.doMock('@/lib/p35Migration', () => ({ migrateLegacyTripsToNativeArchive: vi.fn() }));
  return import('@/api/trips');
};

describe('P3.5 enabled native authority gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.health.mockResolvedValue({
      authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
    });
    state.page.mockResolvedValue({ items: [{ id: 'native-1', status: 'completed' }] });
    state.localList.mockResolvedValue([{ id: 'local-1' }]);
    state.localPage.mockResolvedValue({ rows: [], nextCursor: null, hasMore: false });
    state.localErase.mockResolvedValue({ erased: true, verified: true, removedTripCount: 2, authority: 'browser_indexeddb' });
    state.metadata.mockResolvedValue({ id: 'native-1', status: 'completed' });
    state.overview.mockResolvedValue({ points: [{ lat: 43.1, lng: -79.1 }] });
    state.adjacent.mockResolvedValue({ id: 'native-2', direction: 'next' });
    state.aggregates.mockResolvedValue({ liveCount: 45845, totalDistance: 123456, scoreAverage: 88 });
    state.chartBuckets.mockResolvedValue({ items: [{ startMs: 1, tripCount: 7 }] });
    state.tagContext.mockResolvedValue({ items: [{ id: 'native-1', tags: ['commute'] }] });
    state.sampleMetadata.mockResolvedValue({ items: [{ id: 'native-1' }] });
    state.tombstone.mockResolvedValue({ deleted: true, tripId: 'native-1' });
    state.eraseGeneration.mockResolvedValue({ verified: true, removedTripCount: 2 });
    state.payload.mockResolvedValue({ id: 'native-1', status: 'completed', route_points: [{ lat: 43.1, lng: -79.1 }] });
    state.streamCommit.mockResolvedValue({ verified: true });
  });

  it('uses native authority when explicitly enabled and healthy', async () => {
    const { tripService } = await loadApi();
    await expect(tripService.list({ limit: 10 })).resolves.toEqual([{ id: 'native-1', status: 'completed' }]);
    expect(state.page).toHaveBeenCalledTimes(1);
    expect(state.localList).not.toHaveBeenCalled();
  });

  it.each([
    ['plugin registration failure', () => state.health.mockRejectedValue(new Error('plugin unregistered'))],
    ['canonical unhealthy', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'RECOVERY_REQUIRED', sentinelMatches: true })],
    ['sentinel mismatch', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: false })],
  ])('fails closed on %s without touching IDB authority', async (_label, arrange) => {
    arrange();
    const { tripService } = await loadApi();
    await expect(tripService.list({ limit: 10 })).rejects.toThrow();
    expect(state.localList).not.toHaveBeenCalled();
  });

  it('keeps browser/dev and the dark default explicitly on the IDB backend', async () => {
    let api = await loadApi({ enabled: true, android: false });
    await expect(api.tripService.list({ limit: 10 })).resolves.toEqual([{ id: 'local-1' }]);
    expect(state.health).not.toHaveBeenCalled();
    vi.clearAllMocks(); state.localList.mockResolvedValue([{ id: 'dark-local' }]);
    api = await loadApi({ enabled: false, android: true });
    await expect(api.tripService.list({ limit: 10 })).resolves.toEqual([{ id: 'dark-local' }]);
    expect(state.health).not.toHaveBeenCalled();
  });

  it('serves the bounded native outputs used by history, dashboards, reports, detail, maps, settings, and diagnostics', async () => {
    const { tripService } = await loadApi();
    const { getJson, setJson } = await import('@/lib/mobileStorage');
    await setJson('drivesense_achievement_aggregates_v1', {
      version: 1,
      built: true,
      stats: { completedCount: 1, totalKm: 10 },
      recentWindow: [{ id: 'native-1' }],
      seenTripIds: ['native-1'],
    });
    await expect(tripService.queryHistoryPage({ limit: 25 })).resolves.toEqual({
      rows: [{ id: 'native-1', status: 'completed' }],
      nextCursor: null,
      hasMore: false,
    });
    await expect(tripService.getById('native-1')).resolves.toMatchObject({
      id: 'native-1',
      status: 'completed',
      route_overview_only: true,
      route_points: [{ lat: 43.1, lng: -79.1 }],
    });
    await expect(tripService.queryAdjacent('native-1', 'next')).resolves.toEqual({ id: 'native-2', direction: 'next' });
    await expect(tripService.getAggregates()).resolves.toMatchObject({ liveCount: 45845, scoreAverage: 88 });
    await expect(tripService.getChartBuckets({ granularity: 'month' })).resolves.toEqual({
      items: [{ startMs: 1, tripCount: 7 }],
    });
    await expect(tripService.getOverview('native-1', 900)).resolves.toEqual({ points: [{ lat: 43.1, lng: -79.1 }] });
    await expect(tripService.sampleMetadata(20)).resolves.toEqual({ items: [{ id: 'native-1' }] });
    await expect(tripService.listForSpeedMap({ limit: 10 })).resolves.toMatchObject({
      trips: [{ id: 'native-1', route_overview_only: true }],
    });
    await expect(tripService.delete('native-1')).resolves.toEqual({ deleted: true, tripId: 'native-1' });
    await expect(getJson('drivesense_achievement_aggregates_v1', null)).resolves.toMatchObject({
      built: false,
      invalidationReason: 'trip_deleted',
    });
    await expect(tripService.eraseAll()).resolves.toEqual({ verified: true, removedTripCount: 2 });
    await expect(tripService.listAll()).rejects.toMatchObject({ code: 'UNBOUNDED_QUERY_FORBIDDEN' });
    await expect(tripService.listAllForExport()).rejects.toMatchObject({ code: 'UNBOUNDED_QUERY_FORBIDDEN' });
    expect(state.localList).not.toHaveBeenCalled();
  });

  it.each([
    ['native', { enabled: true, android: true }],
    ['browser', { enabled: true, android: false }],
  ])('invalidates and bounded-rebuilds aggregates after direct %s eraseAll', async (_label, options) => {
    const { tripService } = await loadApi(options);
    const {
      ACHIEVEMENT_AGGREGATE_KEY,
      readAchievementBadges,
      readCalibrationProgressFromAggregates,
      rebuildAchievementAggregates,
    } = await import('@/lib/achievementAggregates');
    const { getJson } = await import('@/lib/mobileStorage');
    const completedTrips = [
      { id: 'erase-a', status: 'completed', distance_km: 10, duration_seconds: 600, start_time: '2026-08-18T10:00:00.000Z', end_time: '2026-08-18T10:10:00.000Z', score_overall: 90 },
      { id: 'erase-b', status: 'completed', distance_km: 20, duration_seconds: 600, start_time: '2026-08-19T10:00:00.000Z', end_time: '2026-08-19T10:10:00.000Z', score_overall: 90 },
    ];
    const populatedPage = { items: completedTrips, rows: completedTrips, nextCursor: null, hasMore: false };
    if (options.android) state.page.mockResolvedValue(populatedPage);
    else state.localPage.mockResolvedValue(populatedPage);

    await rebuildAchievementAggregates();
    await expect(readCalibrationProgressFromAggregates()).resolves.toEqual({ tripsAnalyzed: 2, kmAnalyzed: 30 });
    await expect(getJson(ACHIEVEMENT_AGGREGATE_KEY, null)).resolves.toMatchObject({
      built: true,
      stats: { completedCount: 2, totalKm: 30 },
    });

    // Clean ordering: eraseAll is the first removal operation, so an earlier
    // single-trip delete cannot mask missing service-layer invalidation.
    if (options.android) state.page.mockResolvedValue({ items: [], nextCursor: null });
    else state.localPage.mockResolvedValue({ rows: [], nextCursor: null, hasMore: false });
    await expect(tripService.eraseAll()).resolves.toMatchObject({ verified: true, removedTripCount: 2 });
    await expect(tripService.queryHistoryPage({ limit: 25 })).resolves.toMatchObject({ rows: [] });
    await expect(getJson(ACHIEVEMENT_AGGREGATE_KEY, null)).resolves.toMatchObject({
      built: false,
      invalidationReason: 'trips_erased',
    });

    await expect(readCalibrationProgressFromAggregates()).resolves.toEqual({ tripsAnalyzed: 0, kmAnalyzed: 0 });
    const badges = await readAchievementBadges();
    expect(badges.find((badge) => badge.id === 'first_drive')?.earned).toBe(false);
  });

  it('does not invalidate a built aggregate when native eraseAll refuses verification', async () => {
    const { tripService } = await loadApi();
    const { ACHIEVEMENT_AGGREGATE_KEY } = await import('@/lib/achievementAggregates');
    const { getJson, setJson } = await import('@/lib/mobileStorage');
    await setJson(ACHIEVEMENT_AGGREGATE_KEY, {
      version: 1,
      built: true,
      stats: { completedCount: 2, totalKm: 30 },
      recentWindow: [],
      seenTripIds: [],
    });
    state.eraseGeneration.mockResolvedValue({ verified: false, code: 'ERASURE_REFUSED' });

    await expect(tripService.eraseAll()).resolves.toEqual({ verified: false, code: 'ERASURE_REFUSED' });
    await expect(getJson(ACHIEVEMENT_AGGREGATE_KEY, null)).resolves.toMatchObject({
      built: true,
      stats: { completedCount: 2, totalKm: 30 },
    });
  });

  it('surfaces typed incomplete status when erase verifies but aggregate invalidation cannot persist', async () => {
    const { tripService } = await loadApi();
    const { ACHIEVEMENT_AGGREGATE_KEY } = await import('@/lib/achievementAggregates');
    const mobileStorage = await import('@/lib/mobileStorage');
    await mobileStorage.setJson(ACHIEVEMENT_AGGREGATE_KEY, {
      version: 1,
      built: true,
      stats: { completedCount: 2, totalKm: 30 },
      recentWindow: [],
      seenTripIds: [],
    });
    const persistenceFailure = new Error('storage unavailable');
    const setJson = vi.spyOn(mobileStorage, 'setJson').mockRejectedValueOnce(persistenceFailure);

    await expect(tripService.eraseAll()).rejects.toMatchObject({
      code: 'TRIP_ERASURE_DERIVED_STATE_INCOMPLETE',
      canonicalEraseVerified: true,
      cause: persistenceFailure,
    });
    setJson.mockRestore();
  });

  it.each([
    ['plugin absent', () => state.health.mockRejectedValue(Object.assign(new Error('plugin absent'), { code: 'UNIMPLEMENTED' }))],
    ['plugin registration failure', () => state.health.mockRejectedValue(new Error('plugin registration failed'))],
    ['archive unhealthy', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'RECOVERY_REQUIRED', sentinelMatches: true })],
    ['sentinel conflict', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: false })],
    ['new IDB generation mismatch', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'GENERATION_MISMATCH', sentinelMatches: true, idbOldVersion: 0 })],
    ['speed migration resource block', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE', sentinelMatches: true })],
    ['missing legacy key', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'LEGACY_KEY_MISSING', sentinelMatches: true })],
    ['speed authority incomplete', () => state.health.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'SPEED_AUTHORITY_INCOMPLETE', sentinelMatches: true })],
  ])('keeps real feature queries fail-closed for %s', async (_label, arrange) => {
    arrange();
    const { tripService } = await loadApi();
    await expect(tripService.getAggregates()).rejects.toThrow();
    await expect(tripService.queryHistoryPage({ limit: 25 })).rejects.toThrow();
    expect(state.localList).not.toHaveBeenCalled();
  });

  it('treats missing or stale projection as rebuildable and never as IDB authority', async () => {
    state.health.mockResolvedValue({
      authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
      projectionState: 'STALE', projectionLag: 42,
    });
    const { tripService } = await loadApi();
    await expect(tripService.list({ limit: 10 })).resolves.toEqual([{ id: 'native-1', status: 'completed' }]);
    expect(state.page).toHaveBeenCalled();
    expect(state.localList).not.toHaveBeenCalled();
  });

  it('propagates canonical chunk corruption without consulting disposable IDB', async () => {
    state.payload.mockRejectedValue(Object.assign(new Error('canonical chunk authentication failed'), {
      code: 'CANONICAL_CHUNK_CORRUPT',
    }));
    const { tripService } = await loadApi();
    await expect(tripService.getFullById('native-1')).rejects.toMatchObject({ code: 'CANONICAL_CHUNK_CORRUPT' });
    expect(state.localList).not.toHaveBeenCalled();
  });

  it('fails closed instead of fabricating browser restore outcomes under native authority', async () => {
    const { tripService } = await loadApi();

    await expect(tripService.restoreBatch([{ id: 'must-not-enter-idb' }]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_BACKUP_AUTHORITY' });
    await expect(tripService.stepRetentionReconciliation())
      .rejects.toMatchObject({ code: 'UNSUPPORTED_BACKUP_AUTHORITY' });
  });

  it('publishes native restore source change only after verified cutover and clears routing health cache', async () => {
    const { publishVerifiedNativeRestore, tripService } = await loadApi();
    const { subscribeP7SourceChange } = await import('@/lib/p7SourceChange');
    const notices = [];
    const unsubscribe = subscribeP7SourceChange((notice) => notices.push(notice));
    try {
      await tripService.list({ limit: 1 });
      expect(state.health).toHaveBeenCalledTimes(1);

      await expect(publishVerifiedNativeRestore({
        verified: false,
        authorityState: 'NATIVE',
      })).rejects.toMatchObject({ code: 'NATIVE_RESTORE_UNVERIFIED' });
      expect(notices).toEqual([]);

      await expect(publishVerifiedNativeRestore({
        verified: true,
        authorityState: 'NATIVE',
        operationId: 'restore-cutover',
      })).resolves.toMatchObject({ verified: true, authorityState: 'NATIVE' });
      expect(notices).toContainEqual(expect.objectContaining({
        reason: 'native_backup_restore_cutover',
      }));

      await tripService.list({ limit: 1 });
      expect(state.health).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});
