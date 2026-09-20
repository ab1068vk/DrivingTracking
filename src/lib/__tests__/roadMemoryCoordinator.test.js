import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { current: /** @type {Record<string, any>} */ ({}) },
  browserV2: true,
  nativeSpeedAuthority: false,
  start: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: () => mocks.settings.current },
}));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn() }));
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => false }));
vi.mock('@/lib/speedKnowledgeRepository', () => ({
  isP6BrowserSpeedV2Authority: () => Promise.resolve(mocks.browserV2),
  // Saved speeds follow the authority, not the platform: the coordinator asks
  // whether native owns them, not whether it is running on Android (DPD-011).
  isNativeSpeedAuthoritySelected: () => mocks.nativeSpeedAuthority,
}));
vi.mock('@/lib/p6Contracts', () => ({
  P6_EXPLICIT_OPERATION_STATES: {
    READY: 'READY', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', FAILED: 'FAILED',
    PAUSED_AFTER_RESTART: 'PAUSED_AFTER_RESTART', PAUSED_HIDDEN: 'PAUSED_HIDDEN',
    WAITING_FOR_OWNER: 'WAITING_FOR_OWNER',
  },
  P6_EXPLICIT_OPERATION_TYPES: {
    RETAINED_HISTORY_LEARNING: 'E2_RETAINED_HISTORY_LEARNING',
    BROWSER_SPEED_MIGRATION: 'E4_BROWSER_SAVED_SPEED_MIGRATION',
  },
}));
vi.mock('@/lib/p6ExplicitOperations', () => ({
  startKnownP6ExplicitOperation: (...args) => mocks.start(...args),
  runKnownP6ExplicitOperationTurn: (...args) => mocks.run(...args),
  cancelP6ExplicitOperation: (...args) => mocks.cancel(...args),
  resumeP6ExplicitOperation: (...args) => mocks.resume(...args),
}));

import {
  backfillLocalRoadMemoryFromTripHistory,
  synchronizeLocalRoadMemory,
} from '@/lib/roadMemoryCoordinator';

describe('P6 Road Memory coordinator adoption', () => {
  beforeEach(() => {
    mocks.settings.current = {};
    mocks.browserV2 = true;
    mocks.start.mockReset().mockImplementation(async (type) => ({
      operationId: `operation:${type}`, type, state: 'READY',
      progress: { itemsWorked: 0, bytesWorked: 0, turns: 0 },
    }));
    mocks.run.mockReset().mockImplementation(async (id) => ({
      operationId: id, state: 'COMPLETED',
      progress: { itemsWorked: 7, bytesWorked: 128, turns: 1 },
    }));
    mocks.cancel.mockReset();
    mocks.resume.mockReset();
    mocks.nativeSpeedAuthority = false;
  });

  it('leaves live-trip learning to the canonical P6 desired row and J2', async () => {
    const result = await synchronizeLocalRoadMemory([{
      id: 'trip-1', status: 'completed', route_points: [{}, {}],
    }]);
    expect(result).toMatchObject({ changed: false, delegated: 'p6RoadMemoryUpdates', queuedTripCount: 1 });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('preserves the automatic-learning kill switch', async () => {
    mocks.settings.current = { road_memory_learning_enabled: false };
    await expect(synchronizeLocalRoadMemory([{
      id: 'trip-1', status: 'completed', route_points: [{}, {}],
    }])).resolves.toMatchObject({ changed: false, skipped: 'learning_disabled' });
  });

  it('runs retained-history learning only through foreground E2', async () => {
    const result = await backfillLocalRoadMemoryFromTripHistory();
    expect(mocks.start).toHaveBeenCalledWith('E2_RETAINED_HISTORY_LEARNING');
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ changed: true, state: 'COMPLETED', processedTripCount: 7 });
  });

  it('finishes explicit browser E4 before E2 when v2 is not authoritative', async () => {
    mocks.browserV2 = false;
    await backfillLocalRoadMemoryFromTripHistory();
    expect(mocks.start.mock.calls.map(([type]) => type)).toEqual([
      'E4_BROWSER_SAVED_SPEED_MIGRATION',
      'E2_RETAINED_HISTORY_LEARNING',
    ]);
  });

  /**
   * DPD-011. This step used to be skipped whenever `isAndroid()` was true, so
   * on the shipping platform E2 ran against a v1 authority and every subject
   * came back CONVERSION_REQUIRED having learned nothing. The decision belongs
   * to the authority, which is what these two cases separate.
   */
  it('still runs E4 first when the browser owns saved speeds, Android included', async () => {
    mocks.browserV2 = false;
    mocks.nativeSpeedAuthority = false;
    await backfillLocalRoadMemoryFromTripHistory();
    expect(mocks.start.mock.calls.map(([type]) => type)).toEqual([
      'E4_BROWSER_SAVED_SPEED_MIGRATION',
      'E2_RETAINED_HISTORY_LEARNING',
    ]);
  });

  it('skips the browser cutover when native authority owns saved speeds', async () => {
    mocks.browserV2 = false;
    mocks.nativeSpeedAuthority = true;
    await backfillLocalRoadMemoryFromTripHistory();
    expect(mocks.start.mock.calls.map(([type]) => type)).toEqual([
      'E2_RETAINED_HISTORY_LEARNING',
    ]);
  });
});
