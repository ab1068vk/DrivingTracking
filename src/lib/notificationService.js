import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativePlatform } from '@/lib/nativePlatform';
import { requestNotificationPermission } from '@/lib/permissions';

export const TRACKING_CHANNEL_ID = 'drivesense_tracking';
export const SUMMARY_CHANNEL_ID = 'drivesense_summary';

export async function configureNotificationChannels() {
  if (!isNativePlatform()) return;

  await LocalNotifications.createChannel({
    id: TRACKING_CHANNEL_ID,
    name: 'Trip Tracking',
    description: 'Shown while DriveSense is actively tracking a trip.',
    importance: 2,
    visibility: 1,
    vibration: false,
  });

  await LocalNotifications.createChannel({
    id: SUMMARY_CHANNEL_ID,
    name: 'Trip Summaries',
    description: 'Trip completion and driving summary notifications.',
    importance: 3,
    visibility: 1,
  });
}

export async function scheduleLongTripReminder(startTime) {
  if (!isNativePlatform()) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await LocalNotifications.schedule({
    notifications: [{
      id: 2001,
      title: 'DriveSense is still tracking',
      body: 'Your trip has been active for a while. Stop tracking when you are done driving.',
      channelId: SUMMARY_CHANNEL_ID,
      schedule: { at: new Date(new Date(startTime).getTime() + 2 * 60 * 60 * 1000), allowWhileIdle: true },
    }],
  });
}

export async function cancelLongTripReminder() {
  if (!isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [{ id: 2001 }] });
}

export async function notifyTripCompleted(trip) {
  if (!isNativePlatform()) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await LocalNotifications.schedule({
    notifications: [{
      id: 2002,
      title: 'Trip saved',
      body: `${(trip.distance_km || 0).toFixed(1)} km recorded with a score of ${trip.score_overall || 0}.`,
      channelId: SUMMARY_CHANNEL_ID,
    }],
  });
}
