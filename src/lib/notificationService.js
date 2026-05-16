import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativePlatform } from '@/lib/nativePlatform';
import { requestNotificationPermission } from '@/lib/permissions';
import { localSettings } from '@/lib/trackingStore';

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
  NEAR_MISS_ALERT: 4002,
  DROWSY_WARNING: 4003,
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
  TRIP_NEAR_MISS_SUMMARY: 4016,
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
const LONG_TRIP_REMINDER_ID = NOTIFICATION_IDS.LONG_TRIP_REMINDER;
const TRIP_STARTED_ID = NOTIFICATION_IDS.TRIP_STARTED;
const WEEKLY_REPORT_ID = 2101;
const SAFE_DRIVING_ID = 2102;
const STAY_ALERT_ID = NOTIFICATION_IDS.STAY_ALERT;
const ACHIEVEMENT_BASE_ID = 3000;
const NOTIFIED_ACHIEVEMENTS_KEY = 'drivesense_notified_achievements';
const PHONE_NOTIF_LAST_KEY = 'drivesense_phone_notif_last_ms';
const DROWSY_NOTIF_LAST_KEY = 'drivesense_drowsy_notif_last_ms';
const SPEEDING_NOTIF_LAST_KEY = 'drivesense_speeding_notif_last_ms';
const FATIGUE_NOTIF_TRIP_KEY = 'drivesense_fatigue_notif_trip_id';
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

const scheduleNotification = async (notification, { requestPermission = true } = {}) => {
  if (!notification) return null;
  if (!isNativePlatform()) return notification;

  const permission = await LocalNotifications.checkPermissions();
  const granted = permission.display === 'granted' || (requestPermission && await requestNotificationPermission());
  if (!granted) return null;
  await LocalNotifications.schedule({ notifications: [notification] });
  return notification;
};

function scoreOf(trip = {}) {
  return Number(trip.score_overall ?? trip.overall_score ?? 0);
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

const achievementNotificationId = (achievementId) => (
  ACHIEVEMENT_BASE_ID + [...String(achievementId)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
);

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

  const additions = [];
  if ((trip.near_miss_count || 0) > 0) additions.push(`${trip.near_miss_count} near-miss event(s) detected.`);
  if (trip.drowsy_risk_level === 'high') additions.push('High drowsiness risk detected.');
  if (trip.aggressive_grade === 'aggressive') additions.push('Aggressive driving pattern recorded.');
  const baseBody = `${(trip.distance_km || 0).toFixed(1)} km recorded with a score of ${trip.score_overall || 0}.`;
  const body = [baseBody, ...additions].join(' ').slice(0, 160);

  await LocalNotifications.schedule({
    notifications: [{
      id: 2002,
      title: 'Trip saved',
      body,
      channelId: SUMMARY_CHANNEL_ID,
    }],
  });
}

export async function notifyExportSaved({ filename, uri, mimeType, label = 'Export' } = {}) {
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
  if (!notificationsEnabled('safe_driving_reminder')) return;
  const granted = await requestNotificationPermission();
  if (!granted) return;

  await LocalNotifications.schedule({
    notifications: [{
      id: opts.id || STAY_ALERT_ID,
      title: opts.title || 'Stay Alert',
      body: opts.body || 'Heading drift detected - take a break if you can.',
      channelId: opts.channelId || SUMMARY_CHANNEL_ID,
      schedule: opts.schedule,
      extra: opts.extra,
    }],
  });
}

export async function notifyDailyFatigueWarning(fatigueState) {
  if (!isNativePlatform()) return null;
  if (!notificationsEnabled('notif_drowsy_alert_enabled')) return null;
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
      ? 'Distracted driving detected. Put your phone down now.'
      : 'Possible phone use detected. Stay focused on driving.',
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'phone_use', confidence, speed: opts.speedKmh },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(PHONE_NOTIF_LAST_KEY, now);
  return scheduled;
}

export async function notifyDrowsyWarning(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_drowsy_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const now = Date.now();
  if (now - readNumber(DROWSY_NOTIF_LAST_KEY) < 10 * 60 * 1000) return null;

  const minutes = Number(opts.tripDurationMinutes) || 0;
  const notification = {
    id: NOTIFICATION_IDS.DROWSY_WARNING,
    title: 'Fatigue Warning',
    body: minutes >= 90
      ? `You've been driving for ${Math.round(minutes)} minutes. Consider taking a break.`
      : 'Drowsy driving patterns detected. Pull over safely if you feel tired.',
    channelId: SAFETY_ALERTS_CHANNEL_ID,
    schedule: { at: new Date() },
    extra: { type: 'drowsy_warning', drowsyRiskLevel: opts.drowsyRiskLevel },
  };
  const scheduled = await scheduleNotification(notification);
  if (scheduled) writeNumber(DROWSY_NOTIF_LAST_KEY, now);
  return scheduled;
}

export async function notifySpeedingAlert(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_speeding_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const now = Date.now();
  if (now - readNumber(SPEEDING_NOTIF_LAST_KEY) < 60000) return null;

  const durationS = Number(opts.durationS) || 0;
  const currentSpeed = Number(opts.currentSpeedKmh) || 0;
  const limit = Number(opts.limitKmh) || Number(settings.threshold_speeding_kmh) || 130;
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
  if (settings.notifications_enabled === false || settings.notif_safety_alerts_enabled === false || settings.notif_drowsy_alert_enabled === false) return null;
  if (isQuietHours(settings, true)) return null;
  const tripId = opts.tripId || 'active';
  try {
    if (localStorage.getItem(FATIGUE_NOTIF_TRIP_KEY) === String(tripId)) return null;
  } catch {}

  const minutes = Math.round(Number(opts.tripDurationMinutes) || 0);
  const notification = {
    id: NOTIFICATION_IDS.FATIGUE_BREAK_REMINDER,
    title: 'Break Reminder',
    body: `You've been driving for ${minutes} minutes. A short break improves alertness and reaction time.`,
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
  const nearMissCount = trip.driving_events?.filter((event) => event.type === 'near_miss').length ?? (trip.near_miss_count || 0);
  const phoneUseHigh = trip.phone_use_risk === 'high';
  const nearMissHigh = nearMissCount >= 2;
  if (settings.notifications_enabled === false || settings.notif_post_trip_summary_enabled === false) return null;
  if (isQuietHours(settings)) return null;
  if (scoreOf(trip) < (settings.notif_min_score_for_post_trip ?? 0) && !nearMissHigh && !phoneUseHigh) return null;

  const later = () => ({ at: new Date(Date.now() + 3000) });
  let notification = null;
  if (nearMissHigh) {
    notification = {
      id: NOTIFICATION_IDS.TRIP_NEAR_MISS_SUMMARY,
      title: 'Near Miss Events Detected',
      body: `${nearMissCount} near-miss events on your last trip. Review the route in DriveSense.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'near_miss_summary' },
    };
  } else if (phoneUseHigh && settings.notif_post_trip_phone_use !== false) {
    const minutes = Math.round(((trip.phone_use_total_seconds ?? 0) / 60) * 10) / 10;
    notification = {
      id: NOTIFICATION_IDS.TRIP_PHONE_USE_HIGH,
      title: 'High Phone Use Detected',
      body: `Approx. ${minutes} min of suspected phone use on your last trip. See details in DriveSense.`,
      channelId: SUMMARY_CHANNEL_ID,
      schedule: later(),
      extra: { tripId: trip.id, type: 'phone_use_high' },
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
        body: `Score: ${currentScore}/100 - your best trip yet. Keep it up!`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id, score: currentScore },
      };
    } else if (settings.notif_post_trip_score_change !== false && recentAvg > 0 && currentScore >= recentAvg + 10) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_SCORE_IMPROVEMENT,
        title: 'Great Improvement',
        body: `Score ${currentScore} - ${currentScore - recentAvg} points above your recent average.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if (settings.notif_post_trip_fuel_saving !== false && (trip.score_eco ?? trip.eco_score ?? 0) >= 85 && (trip.fuel_saved_liters ?? 0) >= 0.3) {
      const saved = ((trip.fuel_saved_liters ?? 0) * (trip.fuel_price ?? 1.65)).toFixed(2);
      notification = {
        id: NOTIFICATION_IDS.TRIP_FUEL_SAVING,
        title: 'Eco Drive',
        body: `Smooth driving saved ~$${saved} in fuel on this trip. Eco score: ${trip.score_eco ?? trip.eco_score}.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if ((trip.safety_condition_bonus ?? 0) > 0) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_CONDITION_ADJUSTED,
        title: 'Adjusted for Conditions',
        body: `Wet road patterns detected. Your safety score includes a +${trip.safety_condition_bonus} condition adjustment.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    } else if (settings.notif_post_trip_score_change !== false && recentAvg > 0 && currentScore <= recentAvg - 15) {
      notification = {
        id: NOTIFICATION_IDS.TRIP_SCORE_DECLINE,
        title: 'Score Dip',
        body: `Score ${currentScore} - below your recent average. Open DriveSense to see what happened.`,
        channelId: SUMMARY_CHANNEL_ID,
        schedule: later(),
        extra: { tripId: trip.id },
      };
    }
  }

  return scheduleNotification(notification);
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
  const affected = last7.filter((trip) => trip.phone_use_risk === 'medium' || trip.phone_use_risk === 'high').length;
  if (affected < 3) return null;
  const key = 'drivesense_phone_pattern_last_ms';
  const now = Date.now();
  if (now - readNumber(key) < 48 * 60 * 60 * 1000) return null;
  const notification = {
    id: NOTIFICATION_IDS.PHONE_USE_PATTERN,
    title: 'Phone Use This Week',
    body: `Phone use was detected in ${affected} trips this week. Try enabling Do Not Disturb while driving.`,
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
    title: 'Driving Style Change Detected',
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
  return scheduleNotification(notification);
}

export async function scheduleInactiveDriverNudge(daysSinceLastTrip = 0, settings = localSettings.get()) {
  if (settings.notifications_enabled === false || settings.notif_inactive_nudge_enabled === false || isQuietHours(settings)) return null;
  const threshold = settings.notif_inactive_nudge_days ?? 7;
  if (daysSinceLastTrip < threshold) return null;
  return scheduleNotification({
    id: NOTIFICATION_IDS.INACTIVE_DRIVER_NUDGE,
    title: 'Ready when you are',
    body: `It's been ${Math.round(daysSinceLastTrip)} days since your last trip. DriveSense is ready when you are.`,
    channelId: VEHICLE_CHANNEL_ID,
    schedule: { at: new Date(Date.now() + 60000), allowWhileIdle: true },
    extra: { type: 'inactive_nudge' },
  });
}

export async function syncReminderNotifications(settings = localSettings.get(), { requestPermission = true, lastTripTimestamp = 0, lastWeekTrips = null, maintenanceAlerts = null } = {}) {
  if (!isNativePlatform()) return;

  const cancelIds = [
    { id: WEEKLY_REPORT_ID },
    { id: SAFE_DRIVING_ID },
    { id: NOTIFICATION_IDS.SCORE_7_DAY_TREND },
  ];
  await LocalNotifications.cancel({ notifications: cancelIds });

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

  await LocalNotifications.schedule({
    notifications: newAchievements.map((achievement) => ({
      id: achievementNotificationId(achievement.id),
      title: 'Achievement unlocked',
      body: `${achievement.label}: ${achievement.description}`,
      channelId: ACHIEVEMENT_CHANNEL_ID,
    })),
  });

  newAchievements.forEach((achievement) => notifiedIds.add(achievement.id));
  writeNotifiedAchievementIds(notifiedIds);
  return newAchievements;
}

export function getNotifiedAchievementIds() {
  return [...readNotifiedAchievementIds()];
}
