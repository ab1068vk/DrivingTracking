import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { processDriverProgressionAfterTrip } from '@/lib/driverProgression';
import { syncNativeCompletedTrips } from '@/lib/localTripRepository';
import { syncAchievementNotifications } from '@/lib/notificationService';
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

  return {
    ...progressionUpdate,
    notifiedMilestones,
  };
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
