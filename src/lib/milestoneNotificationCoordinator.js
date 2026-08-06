import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { processDriverProgressionAfterTrip } from '@/lib/driverProgression';
import { syncNativeCompletedTrips } from '@/lib/localTripRepository';
import {
  mirrorCalibrationStateToNative,
  syncAchievementNotifications,
  syncCalibrationMilestoneNotifications,
} from '@/lib/notificationService';
import {
  CALIBRATION_KM_TARGET,
  CALIBRATION_TRIPS_TARGET,
  evaluateCalibrationMilestones,
  summarizeCalibrationProgress,
} from '@/lib/calibrationMilestones';
import { logSystemFailure } from '@/lib/systemLog';
import { calculateAchievementBadges } from '@/lib/tripInsights';
import { localSettings } from '@/lib/trackingStore';

let milestoneSyncQueue = /** @type {Promise<unknown>} */ (Promise.resolve());

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const queueMilestoneSync = (task) => {
  const run = milestoneSyncQueue.then(task, task);
  milestoneSyncQueue = run.catch(() => {});
  return run;
};

/**
 * Evaluate every milestone source from persisted trip history and notify for
 * newly earned items. Keeping this outside the Milestones page means unlocks
 * are processed as part of trip completion, whether or not that page is open.
 */
export async function reconcileMilestoneNotifications({ tripId = null } = {}) {
  const settings = localSettings.get();
  const [trips, vehicles] = await Promise.all([
    tripService.listAllSummaries({ sort: '-start_time' }),
    vehicleService.list({ sort: '-created_date', limit: 500 }).catch(() => []),
  ]);
  const completedTrips = trips.filter((trip) => trip.status === 'completed');
  const progressionUpdate = processDriverProgressionAfterTrip(completedTrips, settings, { tripId });
  const notificationBadges = [
    ...calculateAchievementBadges(completedTrips, settings, vehicles),
    ...progressionUpdate.notificationBadges,
  ];
  const notifiedMilestones = await syncAchievementNotifications(notificationBadges, {
    requestPermission: false,
  });

  // Personal detection calibration is its own system, not part of the
  // Milestones page. It is evaluated here only because the completed-trip list
  // is already loaded; a failure must not suppress achievement notifications.
  const calibrationProgress = summarizeCalibrationProgress(completedTrips);
  const notifiedCalibrationMilestones = await syncCalibrationMilestoneNotifications(
    evaluateCalibrationMilestones(calibrationProgress),
    { requestPermission: false }
  ).catch((error) => {
    logSystemFailure('calibration_milestone_notification_sync', error, {
      trips_analyzed: calibrationProgress.tripsAnalyzed,
      km_analyzed: calibrationProgress.kmAnalyzed,
    });
    return [];
  });
  // Push the refreshed counters down so Android can notify for a milestone
  // crossed by a background trip without the app being opened.
  await mirrorCalibrationStateToNative(calibrationProgress, {
    tripsTarget: CALIBRATION_TRIPS_TARGET,
    kmTarget: CALIBRATION_KM_TARGET,
  });

  return {
    ...progressionUpdate,
    notifiedMilestones,
    calibrationProgress,
    notifiedCalibrationMilestones,
  };
}

/**
 * Reconcile every milestone system immediately after a completed trip is
 * saved in-app.
 *
 * A trip recorded in the app is written straight through `tripService.create`
 * and never appears in the native import list, so without this hook its
 * milestones waited until the next app boot or resume - the same "only
 * notifies when I open the app" problem, one system over.
 *
 * Serialized through the same queue as the native import path so a trip save
 * landing alongside an app-resume cannot double-notify.
 *
 * @param {{tripId?: string|null}} [options]
 */
export function reconcileMilestonesAfterTripSave({ tripId = null } = {}) {
  return queueMilestoneSync(() => reconcileMilestoneNotifications({ tripId }).catch((error) => {
    logSystemFailure('trip_save_milestone_notification_sync', error, {
      trip_id: tripId,
    });
    return null;
  }));
}

/**
 * Import native-completed trips and immediately run milestone notification
 * reconciliation. Calls are serialized because app-resume and visibility
 * events can arrive together on Android.
 */
export function syncNativeCompletedTripsAndMilestones({ reconcileExisting = false } = {}) {
  return queueMilestoneSync(async () => {
    const result = await syncNativeCompletedTrips();
    const importedTrips = Array.isArray(result?.importedTrips) ? result.importedTrips : [];
    // Reconcile even when nothing was imported: a trip recorded and saved
    // locally never appears in `importedTrips`, so gating on it meant crossing
    // a milestone in-app produced no notification at all.
    const shouldReconcile = reconcileExisting || importedTrips.length > 0;
    const latestImportedTrip = importedTrips
      .filter((trip) => trip?.status === 'completed')
      .sort((a, b) => new Date(b.end_time || b.start_time || 0).getTime() - new Date(a.end_time || a.start_time || 0).getTime())[0];
    let milestoneUpdate = null;
    if (shouldReconcile) {
      milestoneUpdate = await reconcileMilestoneNotifications({
        tripId: latestImportedTrip?.id || null,
      }).catch((error) => {
        logSystemFailure('native_trip_milestone_notification_sync', error, {
          imported_trip_count: importedTrips.length,
          latest_trip_id: latestImportedTrip?.id || null,
        });
        return null;
      });
    }

    return {
      ...result,
      importedTrips,
      milestoneUpdate,
    };
  });
}
