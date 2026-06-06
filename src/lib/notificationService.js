import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativePlatform } from '@/lib/nativePlatform';
import { requestNotificationPermission } from '@/lib/permissions';
import { localSettings } from '@/lib/trackingStore';
import { DEFAULT_FUEL_PRICE_PER_LITER } from '@/lib/tripInsights';
import { formatCurrencyAmount } from '@/lib/currency';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const TRACKING_CHANNEL_ID = 'drivesense_tracking';
export const SUMMARY_CHANNEL_ID = 'drivesense_summary';
export const ACHIEVEMENT_CHANNEL_ID = 'drivesense_achievements';
export const SAFETY_ALERTS_CHANNEL_ID = 'drivesense_safety_alerts';
export const COACHING_CHANNEL_ID = 'drivesense_coaching';
export const VEHICLE_CHANNEL_ID = 'drivesense_vehicle';
export const NOTIFICATION_IDS = {
  LONG_TRIP_REMINDER: 2001,
  TRIP_STARTED: 2003,
  STAY_ALERT: 2005,
  WEEKLY_REPORT: 2101,
  SAFE_DRIVING_TIP: 2102,
  PHONE_USE_WARNING: 4001,
  MANOEUVRE_ALERT: 4002,
  HEADING_DRIFT_BETA_WARNING: 4003,
  SPEEDING_WARNING: 4004,
  SPEEDING_ESCALATION: 4005,
  FATIGUE_BREAK_REMINDER: 4006,
  DAILY_FATIGUE_WARNING: 2200,
  DANGER_ZONE_PROXIMITY: 4007,
  TRIP_SCORE_PERSONAL_BEST: 4010,
  TRIP_SCORE_IMPROVEMENT: 4011,
  TRIP_SCORE_DECLINE: 4012,
  TRIP_PHONE_USE_HIGH: 4013,
  TRIP_FUEL_SAVING: 4014,
  TRIP_CONDITION_ADJUSTED: 4015,
  TRIP_MANOEUVRE_ALERT_SUMMARY: 4016,
  TRIP_STOP_START_SUMMARY: 4017,
  TRIP_MERGE_SUMMARY: 4018,
  TRIP_ACCEL_SUMMARY: 4019,
  HARSH_BRAKE_STREAK: 4020,
  CLEAN_TRIP_STREAK: 4021,
  SCORE_7_DAY_TREND: 4022,
  PHONE_USE_PATTERN: 4023,
  STYLE_SHIFT_ALERT: 4024,
  COACH_FOCUS_CHANGED: 4025,
  PERSONAL_BEST_WEEK: 4026,
  NIGHT_DRIVING_WARNING: 4027,
  MAINTENANCE_DUE: 4030,
  MAINTENANCE_SOON: 4031,
  ODOMETER_MILESTONE: 4032,
  FUEL_COST_MONTHLY: 4033,
  INACTIVE_DRIVER_NUDGE: 4034,
  BACKGROUND_TRACKING_ACTIVE: 4040,
  EXPORT_SAVED: 4050,
};
// Backward-compatible notification identifiers for persisted scheduled items.
NOTIFICATION_IDS.NEAR_MISS_ALERT = NOTIFICATION_IDS.MANOEUVRE_ALERT;
NOTIFICATION_IDS.DROWSY_WARNING = NOTIFICATION_IDS.HEADING_DRIFT_BETA_WARNING;
NOTIFICATION_IDS.TRIP_NEAR_MISS_SUMMARY = NOTIFICATION_IDS.TRIP_MANOEUVRE_ALERT_SUMMARY;
NOTIFICATION_IDS.TRIP_FOLLOWING_GAP_SUMMARY = NOTIFICATION_IDS.TRIP_STOP_START_SUMMARY;
const LONG_TRIP_REMINDER_ID = NOTIFICATION_IDS.LONG_TRIP_REMINDER;
const TRIP_STARTED_ID = NOTIFICATION_IDS.TRIP_STARTED;
const TRIP_COMPLETED_ID = 2002;
const WEEKLY_REPORT_ID = 2101;
const SAFE_DRIVING_ID = 2102;
const STAY_ALERT_ID = NOTIFICATION_IDS.STAY_ALERT;
const ACHIEVEMENT_BASE_ID = 3000;
export const MAX_ACHIEVEMENT_NOTIF_IDS = 999;
const ACHIEVEMENT_GROUP_ID = ACHIEVEMENT_BASE_ID + MAX_ACHIEVEMENT_NOTIF_IDS;
const NOTIFIED_ACHIEVEMENTS_KEY = 'drivesense_notified_achievements';
const ACHIEVEMENT_NOTIFICATION_IDS_KEY = 'drivesense_achievement_notification_ids_v1';
const NOTIFICATION_DEDUPE_KEY = 'drivesense_notification_dedupe_v1';
const PHONE_NOTIF_LAST_KEY = 'drivesense_phone_notif_last_ms';
const HEADING_DRIFT_NOTIF_LAST_KEY = 'drivesense_heading_drift_notif_last_ms';
const SPEEDING_NOTIF_LAST_KEY = 'drivesense_speeding_notif_last_ms';
const FATIGUE_NOTIF_TRIP_KEY = 'drivesense_fatigue_notif_trip_id';
const DEDUPE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const TRIP_NOTIFICATION_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_DRIVING_TIPS = [
  'Leave extra space ahead so you can brake once, early, and smoothly.',
  'Ease into acceleration for the first few seconds after every stop.',
  'Scan two intersections ahead so turns and stops never feel sudden.',
  'On longer drives, take a short break before fatigue shows up in your score.',
  'Keep your phone mounted and let Road Sage record without handling it.',
  'Rain, snow, and night driving need slower inputs and a larger following gap.',
  'A steady speed usually beats hard acceleration followed by hard braking.',
];

const notificationsEnabled = (key) => {
  const settings = localSettings.get();
  return settings.notifications_enabled !== false && settings[key] !== false;
};

const todaysSafeDrivingTip = () => {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return SAFE_DRIVING_TIPS[dayIndex % SAFE_DRIVING_TIPS.length];
};

const readNotifiedAchievementIds = () => {
  try {
    const raw = localStorage.getItem(NOTIFIED_ACHIEVEMENTS_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
};

const writeNotifiedAchievementIds = (ids) => {
  try {
    localStorage.setItem(NOTIFIED_ACHIEVEMENTS_KEY, JSON.stringify([...ids]));
  } catch {}
};

const readNumber = (key, fallback = 0) => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

const writeNumber = (key, value) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
};

const readDedupeState = () => {
  try {
    const raw = localStorage.getItem(NOTIFICATION_DEDUPE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => (
      value && now - Number(value.at || 0) < DEDUPE_RETENTION_MS
    )));
  } catch {
    return {};
  }
};

const writeDedupeState = (state) => {
  try {
    localStorage.setItem(NOTIFICATION_DEDUPE_KEY, JSON.stringify(state));
  } catch {}
};

const wasRecentlySent = (key, cooldownMs) => {
  if (!key || !cooldownMs) return false;
  const state = readDedupeState();
  const last = Number(state[key]?.at || 0);
  return last > 0 && Date.now() - last < cooldownMs;
};

const markSent = (key) => {
  if (!key) return;
  const state = readDedupeState();
  state[key] = { at: Date.now() };
  writeDedupeState(state);
};

const cancelNotificationIds = async (ids = []) => {
  if (!isNativePlatform()) return;
  const notifications = ids
    .filter((id) => Number.isFinite(Number(id)))
    .map((id) => ({ id: Number(id) }));
  if (!notifications.length) return;
  await LocalNotifications.cancel({ notifications }).catch((error) => {
    logSystemFailure('notifications_cancel', error, {
      notification_count: notifications.length,
      notification_ids: notifications.map((item) => item.id),
    });
  });
};

const scheduleNotification = async (
  notification,
  { requestPermission = true, dedupeKey = null, cooldownMs = 0, replaceIds = [] } = {},
) => {
  if (!notification) return null;
  if (wasRecentlySent(dedupeKey, cooldownMs)) return null;
  if (isNativePlatform()) await cancelNotificationIds([notification.id, ...replaceIds]);
  if (!isNativePlatform()) return notification;

  try {
    const permission = await LocalNotifications.checkPermissions();
    const granted = permission.display === 'granted' || (requestPermission && await requestNotificationPermission());
    if (!granted) {
      recordSystemEvent('notification_schedule_blocked', {
        notification_id: notification.id,
        channel_id: notification.channelId,
        type: notification.extra?.type,
        reason: 'permission_not_granted',
      }, { category: 'notification', severity: 'warn', source: 'native', title: 'Notification schedule blocked' });
      return null;
    }
    await LocalNotifications.schedule({ notifications: [notification] });
    markSent(dedupeKey);
    recordSystemEvent('notification_scheduled', {
      notification_id: notification.id,
      channel_id: notification.channelId,
      type: notification.extra?.type,
      has_schedule: Boolean(notification.schedule),
      replace_count: replaceIds.length,
      dedupe: Boolean(dedupeKey),
    }, { category: 'notification', source: 'native', title: 'Notification scheduled' });
    return notification;
  } catch (error) {
    logSystemFailure('notification_schedule', error, {
      notification_id: notification.id,
      channel_id: notification.channelId,
      type: notification.extra?.type,
    });
    throw error;
  }
};

function scoreOf(trip = {}) {
  return Number(trip.score_overall ?? trip.overall_score ?? 0);
}

let fallbackAchievementNotificationIds = {};

const isAchievementNotificationId = (id) => (
  Number.isInteger(id) &&
  id >= ACHIEVEMENT_BASE_ID &&
  id < ACHIEVEMENT_BASE_ID + MAX_ACHIEVEMENT_NOTIF_IDS
);

const readAchievementNotificationIds = () => {
  try {
    const raw = localStorage.getItem(ACHIEVEMENT_NOTIFICATION_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { ...fallbackAchievementNotificationIds };
  }
};

const writeAchievementNotificationIds = (ids) => {
  fallbackAchievementNotificationIds = { ...ids };
  try {
    localStorage.setItem(ACHIEVEMENT_NOTIFICATION_IDS_KEY, JSON.stringify(ids));
  } catch {}
};

const nextAchievementNotificationId = (assignedIds) => {
  const used = new Set(
    Object.values(assignedIds)
      .map((id) => Number(id))
      .filter(isAchievementNotificationId)
  );

  for (let offset = 0; offset < MAX_ACHIEVEMENT_NOTIF_IDS; offset += 1) {
    const id = ACHIEVEMENT_BASE_ID + offset;
    if (!used.has(id)) return id;
  }

  throw new Error('Achievement notification ID range exhausted');
};

function resolveFuelPricePerLiter(trip = {}, settings = {}) {
  const candidates = [
    trip.fuel_price,
    trip.fuel_price_per_liter,
    settings.fuel_price_per_liter,
    settings.default_fuel_price_per_liter,
    DEFAULT_FUEL_PRICE_PER_LITER,
  ];
  const price = candidates.map(Number).find((value) => Number.isFinite(value) && value > 0);
  return price ?? DEFAULT_FUEL_PRICE_PER_LITER;
}

/**
 * Returns true if local time is inside quiet hours. Safety alerts bypass quiet hours.
 * @param {Object} settings - User settings.
 * @param {boolean} isSafetyAlert - Whether this is a real-time safety alert.
 * @returns {boolean} True when non-safety notifications should be suppressed.
 */
export function isQuietHours(settings = localSettings.get(), isSafetyAlert = false) {
  if (!settings.notif_quiet_hours_enabled) return false;
  if (isSafetyAlert) return false;

  const parse = (value, fallback) => {
    const [h, m = '0'] = String(value || fallback).split(':');
    const hours = Number(h);
    const minutes = Number(m);
    return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : 0;
  };
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = parse(settings.notif_quiet_start, '22:00');
  const endMins = parse(settings.notif_quiet_end, '07:00');
  return startMins <= endMins
    ? nowMins >= startMins && nowMins < endMins
    : nowMins >= startMins || nowMins < endMins;
}

export const achievementNotificationId = (achievementId) => {
  const key = String(achievementId);
  const assignedIds = readAchievementNotificationIds();
  const existingId = Number(assignedIds[key]);
  if (isAchievementNotificationId(existingId)) return existingId;

  const id = nextAchievementNotificationId(assignedIds);
  assignedIds[key] = id;
  writeAchievementNotificationIds(assignedIds);
  return id;
};

export async function configureNotificationChannels() {
  if (!isNativePlatform()) return;

  try {
    await LocalNotifications.createChannel({
    id: TRACKING_CHANNEL_ID,
    name: 'Trip Tracking',
    description: 'Shown while Road Sage is actively tracking a trip.',
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

    await LocalNotifications.createChannel({
    id: ACHIEVEMENT_CHANNEL_ID,
    name: 'Achievements',
    description: 'Achievement unlock notifications.',
    importance: 3,
    visibility: 1,
  });

    await LocalNotifications.createChannel({
    id: SAFETY_ALERTS_CHANNEL_ID,
    name: 'Safety Alerts',
    description: 'Urgent warnings while driving',
    importance: 5,
    visibility: 1,
    sound: 'default',
    vibration: true,
    lights: true,
    lightColor: '#ef4444',
  });

    await LocalNotifications.createChannel({
    id: COACHING_CHANNEL_ID,
    name: 'Coaching & Milestones',
    description: 'Driving improvement tips and personal milestones',
    importance: 3,
    visibility: 1,
    sound: 'default',
    vibration: false,
  });

    await LocalNotifications.createChannel({
    id: VEHICLE_CHANNEL_ID,
    name: 'Vehicle & Maintenance',
    description: 'Maintenance reminders and vehicle updates',
    importance: 2,
    visibility: 1,
    sound: null,
    vibration: false,
  });
    recordSystemEvent('notification_channels_configured', {
      channel_count: 6,
    }, { category: 'notification', source: 'native', title: 'Notification channels configured' });
  } catch (error) {
    logSystemFailure('notification_channels_configure', error);
    throw error;
  }
}

export async function scheduleLongTripReminder(startTime) {
  if (!isNativePlatform()) return;
  if (!notificationsEnabled('safe_driving_reminder')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;
  const originalReminderAt = new Date(startTime).getTime() + 2 * 60 * 60 * 1000;
  const reminderAt = Number.isFinite(originalReminderAt)
    ? Math.max(originalReminderAt, Date.now() + 15 * 60 * 1000)
    : Date.now() + 2 * 60 * 60 * 1000;

  return scheduleNotification({
      id: LONG_TRIP_REMINDER_ID,
      title: 'Road Sage is still tracking',
      body: 'Your trip has been active for a while. Stop tracking when you are done driving.',
      channelId: SUMMARY_CHANNEL_ID,
      schedule: { at: new Date(reminderAt), allowWhileIdle: true },
      extra: { type: 'long_trip_reminder' },
    }, {
      requestPermission: false,
      dedupeKey: 'long_trip_reminder',
      cooldownMs: 30 * 60 * 1000,
  });
}

export async function cancelLongTripReminder() {
  if (!isNativePlatform()) return;
  await cancelNotificationIds([LONG_TRIP_REMINDER_ID]);
}

export async function notifyTripStarted(trip = {}) {
  if (!isNativePlatform()) return;
  if (!notificationsEnabled('trip_start_notification')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  const tripKey = trip?.id || trip?.start_time || 'active';
  return scheduleNotification({
      id: TRIP_STARTED_ID,
      title: 'Trip started',
      body: 'Road Sage is recording your route.',
      channelId: SUMMARY_CHANNEL_ID,
      extra: { type: 'trip_started', tripId: trip?.id || null },
    }, {
      dedupeKey: `trip_started:${tripKey}`,
      cooldownMs: 5 * 60 * 1000,
    });
}

export async function notifyTripCompleted(trip, { dedupeKey = null, replaceIds = [] } = {}) {
  if (!isNativePlatform()) return;
  if (!notificationsEnabled('trip_end_notification')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  const additions = [];
  if ((trip.close_proximity_count ?? 0) > 0) additions.push(`${trip.close_proximity_count} estimated brake-turn alert(s).`);
  if (trip.heading_drift_beta_level === 'high') additions.push('High GPS heading variation pattern recorded (Beta).');
  if (trip.aggressive_grade === 'aggressive') additions.push('Aggressive driving pattern recorded.');
  const scoreText = Number.isFinite(Number(trip.score_overall)) ? `a score of ${Math.round(Number(trip.score_overall))}` : 'score unavailable';
  const baseBody = `${(trip.distance_km || 0).toFixed(1)} km recorded with ${scoreText}.`;
  const body = [baseBody, ...additions].join(' ').slice(0, 160);

  return scheduleNotification({
      id: TRIP_COMPLETED_ID,
      title: 'Trip saved',
      body,
      channelId: SUMMARY_CHANNEL_ID,
      extra: { tripId: trip?.id || null, type: 'trip_completed_basic' },
    }, {
      dedupeKey: dedupeKey || `trip_completed:${trip?.id || trip?.end_time || Date.now()}`,
      cooldownMs: TRIP_NOTIFICATION_DEDUPE_MS,
      replaceIds,
    });
}

export async function notifyExportSaved(/** @type {any} */ { filename, uri, mimeType, label = 'Export' } = {}) {
  if (!isNativePlatform()) return null;
  if (!notificationsEnabled('notifications_enabled')) return null;

  const notification = {
    id: NOTIFICATION_IDS.EXPORT_SAVED,
    title: `${label} saved`,
    body: `${filename || 'Your file'} was saved to Downloads. Tap to open it.`,
    channelId: SUMMARY_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: {
      type: 'export_saved',
      filename,
      uri,
      mimeType,
    },
  };
  return scheduleNotification(notification);
}

export async function notifyStayAlert(opts = {}) {
  if (!isNativePlatform()) return;
  const settings = localSettings.get();
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  return scheduleNotification({
      id: opts.id || STAY_ALERT_ID,
      title: opts.title || 'Stay Alert',
      body: opts.body || 'GPS heading variation pattern recorded - take a break if you feel tired.',
      channelId: opts.channelId || SAFETY_ALERTS_CHANNEL_ID,
      schedule: opts.schedule,
      extra: opts.extra,
    }, {
      dedupeKey: opts.dedupeKey || `safety:${opts.id || STAY_ALERT_ID}:${opts.extra?.type || opts.title || 'stay_alert'}`,
      cooldownMs: opts.cooldownMs ?? 60 * 1000,
    });
}

export async function notifyDailyFatigueWarning(fatigueState) {
  if (!isNativePlatform()) return null;
  if (!notificationsEnabled('notif_heading_drift_alert_enabled')) return null;
  const notification = {
    id: NOTIFICATION_IDS.DAILY_FATIGUE_WARNING,
    title: 'Take a break - high fatigue',
    body: `${Math.round(fatigueState.totalDrivingMinutes || 0)} min driven today. Rest ${fatigueState.recommendedBreakMinutes || 0} min before your next trip.`,
    channelId: SUMMARY_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'daily_fatigue_warning' },
  };
  return scheduleNotification(notification);
}

export async function notifyPhoneUseDetected(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_phone_use_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const now = Date.now();
  if (now - readNumber(PHONE_NOTIF_LAST_KEY) < 120000) return null;

  const confidence = opts.confidence || opts.confidence_level || 'medium';
  const notification = {
    id: NOTIFICATION_IDS.PHONE_USE_WARNING,
    title: 'Eyes on the Road',
    body: confidence === 'high'
      ? 'Phone activity recorded during driving. Put your phone down now.'
      : 'Possible phone activity recorded. Stay focused on driving.',
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'phone_use', confidence, speed: opts.speedKmh },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(PHONE_NOTIF_LAST_KEY, now);
  return scheduled;
}

export async function notifyHeadingDriftBetaWarning(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_heading_drift_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const now = Date.now();
  if (now - readNumber(HEADING_DRIFT_NOTIF_LAST_KEY) < 10 * 60 * 1000) return null;

  const minutes = Number(opts.tripDurationMinutes) || 0;
  const notification = {
    id: NOTIFICATION_IDS.HEADING_DRIFT_BETA_WARNING,
    title: 'Heading Drift Alert (Beta)',
    body: minutes >= 90
      ? `You've been driving for ${Math.round(minutes)} minutes. Consider taking a break.`
      : 'GPS heading variation pattern recorded. This is not a fatigue measurement; take a break if you feel tired.',
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'heading_drift_beta_warning', headingDriftBetaLevel: opts.headingDriftBetaLevel },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(HEADING_DRIFT_NOTIF_LAST_KEY, now);
  return scheduled;
}

// Backward-compatible export for existing integrations.
export const notifyDrowsyWarning = notifyHeadingDriftBetaWarning;

export async function notifySpeedingAlert(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_speeding_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const now = Date.now();
  if (now - readNumber(SPEEDING_NOTIF_LAST_KEY) < 60000) return null;

  const durationS = Number(opts.durationS) || 0;
  const currentSpeed = Number(opts.currentSpeedKmh) || 0;
  const limit = Number(opts.limitKmh) || Number(settings.threshold_speeding_kmh) || 100;
  const id = durationS < 60 ? NOTIFICATION_IDS.SPEEDING_WARNING : NOTIFICATION_IDS.SPEEDING_ESCALATION;
  const notification = {
    id,
    title: durationS >= 60 ? 'Continued Speeding' : 'Speed Warning',
    body: `${Math.round(currentSpeed)} km/h - ${Math.max(0, Math.round(currentSpeed - limit))} km/h over the estimated limit.`,
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'speeding', currentSpeedKmh: currentSpeed, limitKmh: limit, durationS },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(SPEEDING_NOTIF_LAST_KEY, now);
  return scheduled;
}

export async function notifyFatigueBreakReminder(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_heading_drift_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const tripId = opts.tripId || 'active';
  try {
    if (localStorage.getItem(FATIGUE_NOTIF_TRIP_KEY) === String(tripId)) return null;
  } catch {}

  const minutes = Math.round(Number(opts.tripDurationMinutes) || 0);
  const notification = {
    id: NOTIFICATION_IDS.FATIGUE_BREAK_REMINDER,
    title: 'Break Reminder',
    body: `You've been driving for ${minutes} minutes. A short break can help restore alertness.`,
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'fatigue_break', tripId },
  };
  const scheduled = await scheduleNotification(notification);
  try {
    if (scheduled) localStorage.setItem(FATIGUE_NOTIF_TRIP_KEY, String(tripId));
  } catch {}
  return scheduled;
}

export async function dispatchPostTripNotification(trip, recentTrips = [], settings = localSettings.get()) {
  const manoeuvreAlertCount = trip.driving_events?.filter((event) => event.type === 'close_proximity').length ?? (trip.close_proximity_count ?? 0);
  const phoneUseHigh = trip.phone_use_risk === 'high';
  const manoeuvreAlertHigh = manoeuvreAlertCount >= 2;
  const stopStartPatternCount = Number(trip.stop_start_pattern_count ?? trip.tailgate_cycle_count) || trip.driving_events?.filter((event) => event.type === 'stop_start_pattern' || event.type === 'tailgate_cycle').length || 0;
  const stopStartPatternScore = trip.stop_start_pattern_score == null ? null : Number(trip.stop_start_pattern_score);
  const stopStartPatternRisk = stopStartPatternCount >= 2 || (Number.isFinite(stopStartPatternScore) && stopStartPatternScore < 70);
  const mergeIssueCount = (Number(trip.poor_merge_count) || 0) + (Number(trip.harsh_merge_count) || 0);
  const mergeRisk = mergeIssueCount > 0 && Number(trip.merge_event_count || mergeIssueCount) > 0;
  const rapidAccelCount = Number(trip.rapid_accel_count) || trip.driving_events?.filter((event) => event.type === 'rapid_acceleration').length || 0;
  const rapidAccelRisk = rapidAccelCount >= 3;
  if (settings.notifications_enabled === false || settings.notif_post_trip_summary_enabled === false) return null;
  if (isQuietHours(settings)) return null;
  if (scoreOf(trip) < (settings.notif_min_score_for_post_trip ?? 0) && !manoeuvreAlertHigh && !phoneUseHigh && !stopStartPatternRisk && !mergeRisk && !rapidAccelRisk) return null;

  const later = () => ({ at: new Date(Date.now() + 3000) });
  let notification = null;
  if (manoeuvreAlertHigh) {
    notification = {
      id: NOTIFICATION_IDS.TRIP_MANOEUVRE_ALERT_SUMMARY,
      title: 'Estimated Brake-Turn Alerts',
      body: `${manoeuvreAlertCount} estimated brake-turn manoeuvre alerts on your last trip. GPS alone cannot establish object proximity.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'brake_turn_alert_summary' },
    };
  } else if (phoneUseHigh && settings.notif_post_trip_phone_use !== false) {
    const minutes = Math.round(((trip.phone_use_total_seconds ?? 0) / 60) * 10) / 10;
    notification = {
      id: NOTIFICATION_IDS.TRIP_PHONE_USE_HIGH,
      title: 'High Phone Activity Recorded',
      body: `Approx. ${minutes} min of confirmed or suspected phone activity on your last trip. See details in Road Sage.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'phone_use_high' },
    };
  } else if (stopStartPatternRisk) {
    notification = {
      id: NOTIFICATION_IDS.TRIP_STOP_START_SUMMARY,
      title: 'Stop-Start Pattern Estimate',
      body: `${stopStartPatternCount || 'Multiple'} low-confidence stop-start pattern${stopStartPatternCount === 1 ? '' : 's'} estimated from GPS speed data. This does not measure following distance.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'stop_start_pattern_summary' },
    };
  } else if (mergeRisk) {
    notification = {
      id: NOTIFICATION_IDS.TRIP_MERGE_SUMMARY,
      title: 'Merge Pattern Recorded',
      body: `${mergeIssueCount} merge issue${mergeIssueCount === 1 ? '' : 's'} found. Aim for smoother ramp acceleration and earlier gaps.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'merge_summary' },
    };
  } else if (rapidAccelRisk) {
    notification = {
      id: NOTIFICATION_IDS.TRIP_ACCEL_SUMMARY,
      title: 'Rapid Acceleration Review',
      body: `${rapidAccelCount} rapid acceleration event${rapidAccelCount === 1 ? '' : 's'} on your last trip. Ease into throttle from stops.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'rapid_accel_summary' },
    };
  } else {
    const scores = recentTrips.map(scoreOf).filter(Boolean);
    const currentScore = scoreOf(trip);
    const prevBest = scores.length ? Math.max(...scores) : 0;
    const recent = scores.slice(0, 5);
    const recentAvg = recent.length ? Math.round(recent.reduce((sum, score) => sum + score, 0) / recent.length) : 0;
    if (currentScore > prevBest && currentScore >= 85) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_SCORE_PERSONAL_BEST,
        title: 'Personal Best!',
        body: `Score: ${formatEstimatedScore(currentScore)}/100 - your best trip yet. Keep it up!`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id, score: currentScore },
      };
    } else if (settings.notif_post_trip_score_change !== false && recentAvg > 0 && currentScore >= recentAvg + 10) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_SCORE_IMPROVEMENT,
        title: 'Great Improvement',
        body: `Score ${formatEstimatedScore(currentScore)} - ${currentScore - recentAvg} points above your recent average.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if (settings.notif_post_trip_fuel_saving !== false && (trip.score_eco ?? trip.eco_score ?? 0) >= 85 && (trip.fuel_saved_liters ?? 0) >= 0.3) {
      const saved = (trip.fuel_saved_liters ?? 0) * resolveFuelPricePerLiter(trip, settings);
      notification = {
        id: NOTIFICATION_IDS.TRIP_FUEL_SAVING,
        title: 'Eco Drive',
        body: `Smooth driving saved ~${formatCurrencyAmount(saved, settings)} in fuel on this trip. Eco score: ${formatEstimatedScore(trip.score_eco ?? trip.eco_score)}.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if ((trip.safety_condition_bonus ?? 0) > 0) {
      notification = {
      id: NOTIFICATION_IDS.TRIP_CONDITION_ADJUSTED,
      title: 'Adjusted for Conditions',
      body: `Wet-road patterns estimated from the trip context. Your safety score estimate includes a +${trip.safety_condition_bonus} condition adjustment.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if (settings.notif_post_trip_score_change !== false && recentAvg > 0 && currentScore <= recentAvg - 15) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_SCORE_DECLINE,
        title: 'Score Dip',
        body: `Score ${formatEstimatedScore(currentScore)} - below your recent average. Open Road Sage to see what happened.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    }
  }

  return scheduleNotification(notification);
}

export async function dispatchTripCompletedNotification(trip, recentTrips = [], settings = localSettings.get()) {
  const tripKey = trip?.id || trip?.end_time || trip?.start_time;
  if (!tripKey) return null;
  const dedupeKey = `trip_finished:${tripKey}`;
  if (wasRecentlySent(dedupeKey, TRIP_NOTIFICATION_DEDUPE_MS)) return null;

  const smart = await dispatchPostTripNotification(trip, recentTrips, settings).catch(() => null);
  if (smart) {
    markSent(dedupeKey);
    await cancelNotificationIds([TRIP_COMPLETED_ID]);
    return smart;
  }

  if (settings.trip_end_notification === false) return null;
  const basic = await notifyTripCompleted(trip, {
    dedupeKey,
    replaceIds: Object.values(NOTIFICATION_IDS).filter((id) => id >= 4010 && id <= 4019),
  }).catch(() => null);
  return basic;
}

export async function scheduleWeeklyPatternNotification(lastWeekTrips = [], settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_weekly_pattern_enabled === false || isQuietHours(settings)) return null;
  const trips = lastWeekTrips.filter((trip) => trip.status === 'completed');
  const distanceKm = trips.reduce((sum, trip) => sum + (trip.distance_km || 0), 0);
  const avgScore = trips.length ? Math.round(trips.reduce((sum, trip) => sum + scoreOf(trip), 0) / trips.length) : 0;
  const phoneTrips = trips.filter((trip) => ['medium', 'high'].includes(trip.phone_use_risk)).length;
  const harshBrakes = trips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const body = !trips.length
    ? 'No trips last week. Ready for a new week?'
    : avgScore >= 80
      ? `Great week! Avg score: ${avgScore}. ${trips.length} trips, ${Math.round(distanceKm)} km.`
      : phoneTrips >= 2
        ? 'Tip this week: leave your phone in your bag while driving.'
        : harshBrakes > (settings.weekly_goal_harsh_brakes ?? 5)
          ? `Watch your braking - ${harshBrakes} harsh brakes last week.`
          : `Last week: ${trips.length} trips, avg score ${avgScore}. Keep improving!`;
  return scheduleNotification({
    id: NOTIFICATION_IDS.SCORE_7_DAY_TREND,
    title: 'Weekly driving pattern',
    body,
    channelId: COACHING_CHANNEL_ID,
    schedule: { on: { weekday: 1, hour: 8, minute: 30 }, allowWhileIdle: true },
    extra: { type: 'weekly_pattern' },
  });
}

export async function notifyHarshBrakeStreak(streakDays, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_streak_enabled === false) return null;
  const key = [30, 14, 7, 3].find((threshold) => streakDays === threshold);
  if (!key || isQuietHours(settings)) return null;
  const titles = {
    3: '3-Day Smooth Streak!',
    7: 'One Week, Zero Harsh Brakes!',
    14: 'Two Weeks of Smooth Braking!',
    30: '30-Day Braking Legend!',
  };
  return scheduleNotification({
    id: NOTIFICATION_IDS.HARSH_BRAKE_STREAK,
    title: titles[key],
    body: `${streakDays} days without harsh braking. Keep protecting that smooth streak.`,
    channelId: COACHING_CHANNEL_ID,
    extra: { type: 'harsh_brake_streak', streakDays },
  });
}

export async function checkAndNotifyPhoneUsePattern(recentTrips = [], settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_coaching_enabled === false || isQuietHours(settings)) return null;
  const last7 = recentTrips.slice(0, 7);
  const affected = last7.filter((trip) => (
    trip.phone_use_score_available === true &&
    (trip.phone_use_risk === 'medium' || trip.phone_use_risk === 'high')
  )).length;
  if (affected < 3) return null;
  const key = 'drivesense_phone_pattern_last_ms';
  const now = Date.now();
  if (now - readNumber(key) < 48 * 60 * 60 * 1000) return null;
  const notification = {
    id: NOTIFICATION_IDS.PHONE_USE_PATTERN,
    title: 'Phone Use This Week',
    body: `Confirmed phone use was recorded in ${affected} trips this week. Try enabling Do Not Disturb while driving.`,
    channelId: COACHING_CHANNEL_ID,
    extra: { type: 'phone_use_pattern' },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(key, now);
  return scheduled;
}

export async function notifyStyleShift(styleShifts = [], settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_style_shift_enabled === false || !styleShifts.length || isQuietHours(settings)) return null;
  const aggShift = styleShifts.find((shift) => shift.dimension === 'aggression' && shift.direction === 'increasing');
  if (!aggShift) return null;
  return scheduleNotification({
    id: NOTIFICATION_IDS.STYLE_SHIFT_ALERT,
    title: 'Driving Style Change Recorded',
    body: 'Your driving has become more aggressive over your last 5 trips. See your Coach for details.',
    channelId: COACHING_CHANNEL_ID,
    extra: { type: 'phone_use_pattern' },
  });
}

export async function notifyMaintenanceDue(vehicleName, dueItems = [], settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_maintenance_enabled === false || !dueItems.length || isQuietHours(settings)) return null;
  const due = dueItems.find((item) => (item.remaining_km ?? 0) <= 0);
  const item = due || dueItems[0];
  const notification = {
    id: due ? NOTIFICATION_IDS.MAINTENANCE_DUE : NOTIFICATION_IDS.MAINTENANCE_SOON,
    title: due ? 'Maintenance Due' : 'Maintenance Coming Soon',
    body: `${vehicleName}: ${item.item || item.label || 'Service'} ${due ? `overdue by ${Math.abs(item.remaining_km || 0).toLocaleString()} km` : `due in ${(item.remaining_km || 0).toLocaleString()} km`}.`,
    channelId: VEHICLE_CHANNEL_ID,
    extra: { type: 'maintenance' },
  };
  return scheduleNotification(notification, {
    dedupeKey: `maintenance:${vehicleName}:${item.item || item.label || 'service'}:${due ? 'due' : 'soon'}`,
    cooldownMs: 7 * 24 * 60 * 60 * 1000,
  });
}

export async function scheduleInactiveDriverNudge(daysSinceLastTrip = 0, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_inactive_nudge_enabled === false || isQuietHours(settings)) return null;
  const threshold = settings.notif_inactive_nudge_days ?? 7;
  if (daysSinceLastTrip < threshold) return null;
  return scheduleNotification({
    id: NOTIFICATION_IDS.INACTIVE_DRIVER_NUDGE,
    title: 'Ready when you are',
    body: `It's been ${Math.round(daysSinceLastTrip)} days since your last trip. Road Sage is ready when you are.`,
    channelId: VEHICLE_CHANNEL_ID,
    schedule: { at: new Date(Date.now() + 60000), allowWhileIdle: true },
    extra: { type: 'inactive_nudge' },
  }, {
    dedupeKey: 'inactive_nudge',
    cooldownMs: 24 * 60 * 60 * 1000,
  });
}

export async function syncReminderNotifications(settings = localSettings.get(), { requestPermission = true, lastTripTimestamp = 0, lastWeekTrips = null, maintenanceAlerts = null } = {}) {
  if (!isNativePlatform()) return;

  const cancelIds = [
    { id: WEEKLY_REPORT_ID },
    { id: SAFE_DRIVING_ID },
    { id: NOTIFICATION_IDS.SCORE_7_DAY_TREND },
  ];
  await cancelNotificationIds(cancelIds.map((item) => item.id));

  if (settings.notifications_enabled === false) return;
  const needsPermission = settings.weekly_report_notification ||
    settings.safe_driving_reminder ||
    settings.notif_weekly_pattern_enabled ||
    settings.notif_inactive_nudge_enabled ||
    settings.notif_maintenance_enabled;
  if (!needsPermission) return;

  const permission = await LocalNotifications.checkPermissions();
  const granted = permission.display === 'granted' || (requestPermission && await requestNotificationPermission());
  if (!granted) return;

  const notifications = [];
  if (settings.weekly_report_notification) {
    notifications.push({
      id: WEEKLY_REPORT_ID,
      title: 'Weekly driving report',
      body: 'Your weekly Road Sage report is ready. Review distance, score, and risky events.',
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

  if (notifications.length) {
    try {
      await LocalNotifications.schedule({ notifications });
      recordSystemEvent('notification_batch_scheduled', {
        notification_count: notifications.length,
        notification_ids: notifications.map((item) => item.id),
        types: notifications.map((item) => item.extra?.type || 'reminder'),
      }, { category: 'notification', source: 'native', title: 'Reminder notifications scheduled' });
    } catch (error) {
      logSystemFailure('notification_batch_schedule', error, {
        notification_count: notifications.length,
        notification_ids: notifications.map((item) => item.id),
      });
      throw error;
    }
  }

  if (settings.notif_inactive_nudge_enabled && lastTripTimestamp) {
    const daysSince = (Date.now() - new Date(lastTripTimestamp).getTime()) / 86400000;
    await scheduleInactiveDriverNudge(daysSince, settings);
  }
  if (settings.notif_weekly_pattern_enabled && lastWeekTrips) {
    await scheduleWeeklyPatternNotification(lastWeekTrips, settings);
  }
  if (settings.notif_maintenance_enabled && maintenanceAlerts) {
    for (const alert of maintenanceAlerts) {
      await notifyMaintenanceDue(alert.vehicleName, alert.dueItems, settings);
    }
  }
}

export async function syncAchievementNotifications(achievements = [], { requestPermission = true } = {}) {
  const earned = achievements.filter((achievement) => achievement.earned);
  if (!earned.length) return [];

  const notifiedIds = readNotifiedAchievementIds();
  const newAchievements = earned.filter((achievement) => !notifiedIds.has(achievement.id));
  if (!newAchievements.length) return [];

  if (!isNativePlatform() || !notificationsEnabled('achievement_notifications')) {
    return newAchievements;
  }

  const permission = await LocalNotifications.checkPermissions();
  const granted = permission.display === 'granted' || (requestPermission && await requestNotificationPermission());
  if (!granted) return [];

  const notifications = newAchievements.length === 1
    ? [{
      id: achievementNotificationId(newAchievements[0].id),
      title: 'Achievement unlocked',
      body: `${newAchievements[0].label}: ${newAchievements[0].description}`,
      channelId: ACHIEVEMENT_CHANNEL_ID,
      extra: { type: 'achievement', achievementId: newAchievements[0].id },
    }]
    : [{
      id: ACHIEVEMENT_GROUP_ID,
      title: `${newAchievements.length} achievements unlocked`,
      body: newAchievements.length > 6
        ? `${newAchievements.slice(0, 6).map((achievement) => achievement.label).join(', ')}, and ${newAchievements.length - 6} more`
        : newAchievements.map((achievement) => achievement.label).join(', '),
      channelId: ACHIEVEMENT_CHANNEL_ID,
      extra: { type: 'achievement_batch', achievementIds: newAchievements.map((achievement) => achievement.id) },
    }];

  try {
    await LocalNotifications.schedule({ notifications });
    recordSystemEvent('notification_batch_scheduled', {
      notification_count: notifications.length,
      notification_ids: notifications.map((item) => item.id),
      types: notifications.map((item) => item.extra?.type || 'achievement'),
    }, { category: 'notification', source: 'native', title: 'Achievement notifications scheduled' });
  } catch (error) {
    logSystemFailure('achievement_notification_schedule', error, {
      notification_count: notifications.length,
      notification_ids: notifications.map((item) => item.id),
    });
    throw error;
  }

  newAchievements.forEach((achievement) => notifiedIds.add(achievement.id));
  writeNotifiedAchievementIds(notifiedIds);
  return newAchievements;
}

export function getNotifiedAchievementIds() {
  return [...readNotifiedAchievementIds()];
}
