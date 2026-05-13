import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativePlatform } from '@/lib/nativePlatform';
import { requestNotificationPermission } from '@/lib/permissions';
import { localSettings } from '@/lib/trackingStore';

export const TRACKING_CHANNEL_ID = 'drivesense_tracking';
export const SUMMARY_CHANNEL_ID = 'drivesense_summary';
const LONG_TRIP_REMINDER_ID = 2001;
const TRIP_STARTED_ID = 2003;
const WEEKLY_REPORT_ID = 2101;
const SAFE_DRIVING_ID = 2102;
const SAFE_DRIVING_TIPS = [
  'Leave extra space ahead so you can brake once, early, and smoothly.',
  'Ease into acceleration for the first few seconds after every stop.',
  'Scan two intersections ahead so turns and stops never feel sudden.',
  'On longer drives, take a short break before fatigue shows up in your score.',
  'Keep your phone mounted and let DriveSense record without handling it.',
  'Rain, snow, and night driving need slower inputs and a larger following gap.',
  'A steady speed usually beats hard acceleration followed by hard braking.',
];

const notificationsEnabled = (key) => {
  const settings = localSettings.get();
  return settings.notifications_enabled !== false && settings[key] !== false;
};

const nextAt = ({ dayOffset = 1, hour = 9, minute = 0 }) => {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  if (date <= new Date()) date.setDate(date.getDate() + 1);
  return date;
};

const todaysSafeDrivingTip = () => {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return SAFE_DRIVING_TIPS[dayIndex % SAFE_DRIVING_TIPS.length];
};

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
  if (!notificationsEnabled('safe_driving_reminder')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await LocalNotifications.schedule({
    notifications: [{
      id: LONG_TRIP_REMINDER_ID,
      title: 'DriveSense is still tracking',
      body: 'Your trip has been active for a while. Stop tracking when you are done driving.',
      channelId: SUMMARY_CHANNEL_ID,
      schedule: { at: new Date(new Date(startTime).getTime() + 2 * 60 * 60 * 1000), allowWhileIdle: true },
    }],
  });
}

export async function cancelLongTripReminder() {
  if (!isNativePlatform()) return;
  await LocalNotifications.cancel({ notifications: [{ id: LONG_TRIP_REMINDER_ID }] });
}

export async function notifyTripStarted() {
  if (!isNativePlatform()) return;
  if (!notificationsEnabled('trip_start_notification')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await LocalNotifications.schedule({
    notifications: [{
      id: TRIP_STARTED_ID,
      title: 'Trip started',
      body: 'DriveSense is recording your route.',
      channelId: SUMMARY_CHANNEL_ID,
    }],
  });
}

export async function notifyTripCompleted(trip) {
  if (!isNativePlatform()) return;
  if (!notificationsEnabled('trip_end_notification')) return;
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

export async function syncReminderNotifications(settings = localSettings.get(), { requestPermission = true } = {}) {
  if (!isNativePlatform()) return;

  const cancelIds = [
    { id: WEEKLY_REPORT_ID },
    { id: SAFE_DRIVING_ID },
  ];
  await LocalNotifications.cancel({ notifications: cancelIds });

  if (settings.notifications_enabled === false) return;
  const needsPermission = settings.weekly_report_notification || settings.safe_driving_reminder;
  if (!needsPermission) return;

  const permission = await LocalNotifications.checkPermissions();
  const granted = permission.display === 'granted' || (requestPermission && await requestNotificationPermission());
  if (!granted) return;

  const notifications = [];
  if (settings.weekly_report_notification) {
    notifications.push({
      id: WEEKLY_REPORT_ID,
      title: 'Weekly driving report',
      body: 'Your weekly DriveSense report is ready. Review distance, score, and risky events.',
      channelId: SUMMARY_CHANNEL_ID,
      schedule: { on: { weekday: 2, hour: 9, minute: 0 }, allowWhileIdle: true },
    });
  }

  if (settings.safe_driving_reminder) {
    notifications.push({
      id: SAFE_DRIVING_ID,
      title: 'Safe driving tip',
      body: todaysSafeDrivingTip(),
      channelId: SUMMARY_CHANNEL_ID,
      schedule: { on: { hour: 8, minute: 0 }, allowWhileIdle: true },
    });
  }

  if (notifications.length) await LocalNotifications.schedule({ notifications });
}
