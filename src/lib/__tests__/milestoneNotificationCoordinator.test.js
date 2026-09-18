import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryHistoryPage: vi.fn(),
  readBadges: vi.fn(),
  applyAggregate: vi.fn(),
  readCalibrationCounters: vi.fn(),
  listVehiclePage: vi.fn(),
  processProgression: vi.fn(),
  syncNativeTrips: vi.fn(),
  syncNotifications: vi.fn(),
  syncCalibrationNotifications: vi.fn(),
  mirrorCalibrationState: vi.fn(),
  getSettings: vi.fn(),
  logFailure: vi.fn(),
}));

vi.mock('@/api/trips', () => ({
  tripService: { queryHistoryPage: mocks.queryHistoryPage },
}));
vi.mock('@/api/vehicles', () => ({
  vehicleService: { listPage: mocks.listVehiclePage },
}));
vi.mock('@/lib/driverProgression', () => ({
  processDriverProgressionAfterTrip: mocks.processProgression,
}));
vi.mock('@/lib/localTripRepository', () => ({
  syncNativeCompletedTrips: mocks.syncNativeTrips,
}));
vi.mock('@/lib/notificationService', () => ({
  // The one-pass callers never cap, so the selector is the identity filter over
  // earned candidates here; delivered-id filtering stays inside the notifier.
  selectUndeliveredAchievements: (candidates = []) => ({
    batch: candidates.filter((candidate) => candidate?.earned),
    remaining: [],
  }),
  syncAchievementNotifications: mocks.syncNotifications,
  syncCalibrationMilestoneNotifications: mocks.syncCalibrationNotifications,
  mirrorCalibrationStateToNative: mocks.mirrorCalibrationState,
}));
vi.mock('@/lib/achievementAggregates', () => ({
  ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS: 2000,
  achievementAggregateNeedsRepair: vi.fn(async () => false),
  applyCompletedTripToAggregates: mocks.applyAggregate,
  readAchievementBadges: mocks.readBadges,
  readAchievementSurfaces: vi.fn(async () => ({ badges: [], calibration: null, needsRepair: false })),
  readCalibrationProgressFromAggregates: mocks.readCalibrationCounters,
  stepAchievementAggregateRepair: vi.fn(async () => ({ processed: 0, hasMore: false, built: true })),
}));
vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: mocks.getSettings },
}));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logFailure,
}));

import {
  reconcileMilestoneNotifications,
  reconcileMilestonesAfterTripSave,
  syncNativeCompletedTripsAndMilestones,
} from '@/lib/milestoneNotificationCoordinator';

describe('milestone notification coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockReturnValue({ achievement_notifications: true });
    mocks.listVehiclePage.mockResolvedValue({
      vehicles: [{ id: 'vehicle-1' }], returned: 1, hasMore: false, complete: true, continuation: null,
    });
    mocks.readBadges.mockResolvedValue([{ id: 'first_drive', earned: true }]);
    mocks.applyAggregate.mockResolvedValue(null);
    mocks.readCalibrationCounters.mockResolvedValue({ tripsAnalyzed: 1, kmAnalyzed: 12 });
    mocks.processProgression.mockReturnValue({
      newUnlocks: [{ id: 'mastery:braking' }],
      notificationBadges: [{ id: 'progression_mastery:braking', earned: true }],
    });
    mocks.syncNotifications.mockResolvedValue([{ id: 'first_drive' }]);
    mocks.syncCalibrationNotifications.mockResolvedValue([]);
    mocks.mirrorCalibrationState.mockResolvedValue(true);
  });

  it('evaluates persisted trip history and sends both badge and progression notifications', async () => {
    const completedTrip = { id: 'trip-2', status: 'completed' };
    mocks.queryHistoryPage.mockResolvedValue({ nextCursor: null, rows: [
      completedTrip,
      { id: 'trip-draft', status: 'recording' },
    ] });

    const result = await reconcileMilestoneNotifications({ tripId: completedTrip.id });

    expect(mocks.processProgression).toHaveBeenCalledWith(
      [completedTrip],
      { achievement_notifications: true },
      { tripId: completedTrip.id },
    );
    expect(mocks.readBadges).toHaveBeenCalledWith(
      { achievement_notifications: true },
      { vehicles: [{ id: 'vehicle-1' }] },
    );
    expect(mocks.syncNotifications).toHaveBeenCalledWith([
      { id: 'first_drive', earned: true },
      { id: 'progression_mastery:braking', earned: true },
    ], { requestPermission: false });
    expect(result.notifiedMilestones).toEqual([{ id: 'first_drive' }]);
  });

  it('runs milestone reconciliation immediately after a native trip import', async () => {
    const importedTrip = {
      id: 'native-trip-1',
      status: 'completed',
      end_time: '2026-07-29T14:00:00.000Z',
    };
    mocks.syncNativeTrips.mockResolvedValue({
      importedTrips: [importedTrip],
      matchedActiveTrip: null,
    });
    mocks.queryHistoryPage.mockResolvedValue({ nextCursor: null, rows: [importedTrip] });

    const result = await syncNativeCompletedTripsAndMilestones();

    expect(mocks.processProgression).toHaveBeenCalledWith(
      [importedTrip],
      { achievement_notifications: true },
      { tripId: importedTrip.id },
    );
    expect(mocks.syncNotifications).toHaveBeenCalledOnce();
    expect(result.milestoneUpdate).not.toBeNull();
  });

  it('reconciles previously missed milestones during startup without a new native import', async () => {
    const existingTrip = { id: 'existing-trip', status: 'completed' };
    mocks.syncNativeTrips.mockResolvedValue({
      importedTrips: [],
      matchedActiveTrip: null,
    });
    mocks.queryHistoryPage.mockResolvedValue({ nextCursor: null, rows: [existingTrip] });

    await syncNativeCompletedTripsAndMilestones({ reconcileExisting: true });

    expect(mocks.processProgression).toHaveBeenCalledWith(
      [existingTrip],
      { achievement_notifications: true },
      { tripId: null },
    );
    expect(mocks.syncNotifications).toHaveBeenCalledOnce();
  });

  it('notifies for a trip saved in-app without waiting for an app restart', async () => {
    // An in-app trip goes straight through tripService.create and never
    // appears in the native import list, so it must not depend on the
    // native-import path to have its milestones evaluated.
    const savedTrip = { id: 'in-app-trip', status: 'completed' };
    mocks.queryHistoryPage.mockResolvedValue({ nextCursor: null, rows: [savedTrip] });

    await reconcileMilestonesAfterTripSave({ tripId: savedTrip.id });

    expect(mocks.syncNativeTrips).not.toHaveBeenCalled();
    expect(mocks.processProgression).toHaveBeenCalledWith(
      [savedTrip],
      { achievement_notifications: true },
      { tripId: savedTrip.id },
    );
    expect(mocks.syncNotifications).toHaveBeenCalledOnce();
    // The separate calibration system is evaluated in the same pass.
    expect(mocks.syncCalibrationNotifications).toHaveBeenCalledOnce();
  });

  it('never lets a milestone failure propagate out of a trip save', async () => {
    mocks.queryHistoryPage.mockRejectedValue(new Error('history unavailable'));

    await expect(reconcileMilestonesAfterTripSave({ tripId: 't1' })).resolves.toBeNull();
    expect(mocks.logFailure).toHaveBeenCalledWith(
      'trip_save_milestone_notification_sync',
      expect.any(Error),
      { trip_id: 't1' },
    );
  });

  it('does not hide a successfully imported trip when milestone scheduling fails', async () => {
    const importedTrip = { id: 'native-trip-2', status: 'completed' };
    mocks.syncNativeTrips.mockResolvedValue({
      importedTrips: [importedTrip],
      matchedActiveTrip: importedTrip,
    });
    mocks.queryHistoryPage.mockRejectedValue(new Error('history unavailable'));

    const result = await syncNativeCompletedTripsAndMilestones();

    expect(result.importedTrips).toEqual([importedTrip]);
    expect(result.matchedActiveTrip).toBe(importedTrip);
    expect(result.milestoneUpdate).toBeNull();
    expect(mocks.logFailure).toHaveBeenCalledWith(
      'native_trip_milestone_notification_sync',
      expect.any(Error),
      expect.objectContaining({ imported_trip_count: 1, latest_trip_id: importedTrip.id }),
    );
  });
});
