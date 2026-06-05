import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANDROID_NOTIFICATION_VISIBILITY,
  MAX_ACHIEVEMENT_NOTIF_IDS,
  NOTIFICATION_IDS,
  achievementNotificationId,
  dispatchPostTripNotification,
  isQuietHours,
  notifySpeedingAlert,
} from '@/lib/notificationService';
import { calculateAchievementBadges } from '@/lib/tripInsights';

const settings = {
  notifications_enabled: true,
  notif_post_trip_summary_enabled: true,
  notif_post_trip_phone_use: true,
  notif_post_trip_score_change: true,
  notif_post_trip_fuel_saving: true,
  notif_min_score_for_post_trip: 0,
};

const trip = (patch = {}) => ({
  id: 'trip-1',
  status: 'completed',
  score_overall: 82,
  score_eco: 70,
  driving_events: [],
  ...patch,
});

describe('advanced notifications', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stubLocalStorage = () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
  };

  it('allows safety alerts during quiet hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:30:00'));

    expect(isQuietHours({
      notif_quiet_hours_enabled: true,
      notif_quiet_start: '22:00',
      notif_quiet_end: '07:00',
    }, true)).toBe(false);
  });

  it('handles midnight-crossing quiet hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:30:00'));

    expect(isQuietHours({
      notif_quiet_hours_enabled: true,
      notif_quiet_start: '22:00',
      notif_quiet_end: '07:00',
    })).toBe(true);

    vi.setSystemTime(new Date('2026-01-01T12:00:00'));
    expect(isQuietHours({
      notif_quiet_hours_enabled: true,
      notif_quiet_start: '22:00',
      notif_quiet_end: '07:00',
    })).toBe(false);
  });

  it('assigns distinct notification IDs for same-digit-sum achievement IDs', () => {
    stubLocalStorage();

    const ids = ['12', '21', '30'].map(achievementNotificationId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(achievementNotificationId('12')).not.toBe(achievementNotificationId('21'));
  });

  it('assigns unique notification IDs for all achievement badge IDs', () => {
    stubLocalStorage();
    const achievementIds = calculateAchievementBadges([]).map((badge) => badge.id);

    const notificationIds = achievementIds.map(achievementNotificationId);

    expect(new Set(notificationIds).size).toBe(achievementIds.length);
    expect(achievementIds.length).toBeLessThanOrEqual(MAX_ACHIEVEMENT_NOTIF_IDS);
  });

  it('fires estimated brake-turn summary before lower-priority post-trip alerts', async () => {
    const notification = await dispatchPostTripNotification(trip({
      phone_use_risk: 'high',
      driving_events: [{ type: 'close_proximity' }, { type: 'close_proximity' }],
    }), [], settings);

    expect(notification.id).toBe(NOTIFICATION_IDS.TRIP_MANOEUVRE_ALERT_SUMMARY);
  });

  it('marks returned local notifications private on Android lock screens', async () => {
    const notification = await dispatchPostTripNotification(trip({
      driving_events: [{ type: 'close_proximity' }, { type: 'close_proximity' }],
    }), [], settings);

    expect(notification.visibility).toBe(ANDROID_NOTIFICATION_VISIBILITY.PRIVATE);
  });

  it('fires nothing when master notifications are disabled', async () => {
    const notification = await dispatchPostTripNotification(trip({
      driving_events: [{ type: 'close_proximity' }, { type: 'close_proximity' }],
    }), [], { ...settings, notifications_enabled: false });

    expect(notification).toBeNull();
  });

  it('does not fire phantom speeding alerts for empty or invalid speed context', async () => {
    stubLocalStorage();

    await expect(notifySpeedingAlert({}, settings)).resolves.toBeNull();
    await expect(notifySpeedingAlert({ currentSpeedKmh: 80 }, settings)).resolves.toBeNull();
    await expect(notifySpeedingAlert({ currentSpeedKmh: 0, limitKmh: 50 }, settings)).resolves.toBeNull();
    await expect(notifySpeedingAlert({ currentSpeedKmh: 51, limitKmh: 50 }, settings)).resolves.toBeNull();
  });

  it('formats valid speeding warnings from real speed and limit values', async () => {
    stubLocalStorage();

    const notification = await notifySpeedingAlert({
      currentSpeedKmh: 68.4,
      limitKmh: 50,
      durationS: 12,
      limitSource: 'inferred',
    }, settings);

    expect(notification.id).toBe(NOTIFICATION_IDS.SPEEDING_WARNING);
    expect(notification.title).toBe('Speed Warning');
    expect(notification.body).toBe('68 km/h - 18 km/h over the estimated limit.');
    expect(notification.extra).toMatchObject({
      type: 'speeding',
      currentSpeedKmh: 68.4,
      limitKmh: 50,
      durationS: 12,
      limitSource: 'inferred',
    });
  });

  it('uses a shorter cooldown for initial speeding warnings', async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00'));

    const payload = { currentSpeedKmh: 70, limitKmh: 50, durationS: 12 };

    expect(await notifySpeedingAlert(payload, settings)).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-01T12:00:29'));
    expect(await notifySpeedingAlert(payload, settings)).toBeNull();
    vi.setSystemTime(new Date('2026-01-01T12:00:31'));
    expect(await notifySpeedingAlert(payload, settings)).not.toBeNull();
  });

  it('escalates sustained speeding and applies the longer cooldown', async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00'));

    const payload = { currentSpeed: 82, limit: 60, durationS: 60, limitSource: 'openstreetmap' };

    const notification = await notifySpeedingAlert(payload, settings);
    expect(notification.id).toBe(NOTIFICATION_IDS.SPEEDING_ESCALATION);
    expect(notification.title).toBe('Continued Speeding');
    expect(notification.body).toBe('82 km/h - 22 km/h over the limit.');

    vi.setSystemTime(new Date('2026-01-01T12:00:59'));
    expect(await notifySpeedingAlert(payload, settings)).toBeNull();
    vi.setSystemTime(new Date('2026-01-01T12:01:01'));
    expect(await notifySpeedingAlert(payload, settings)).not.toBeNull();
  });

  it('fires nothing during quiet hours for non-safety post-trip notifications', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:30:00'));

    const notification = await dispatchPostTripNotification(trip({
      score_overall: 95,
    }), [{ score_overall: 80 }], {
      ...settings,
      notif_quiet_hours_enabled: true,
      notif_quiet_start: '22:00',
      notif_quiet_end: '07:00',
    });

    expect(notification).toBeNull();
  });

  it('keeps post-trip branches in priority order', async () => {
    const phone = await dispatchPostTripNotification(trip({
      phone_use_risk: 'high',
      phone_use_total_seconds: 70,
    }), [{ score_overall: 60 }], settings);
    const best = await dispatchPostTripNotification(trip({
      score_overall: 91,
    }), [{ score_overall: 85 }], settings);
    const improvement = await dispatchPostTripNotification(trip({
      score_overall: 88,
    }), [{ score_overall: 90 }, { score_overall: 70 }, { score_overall: 72 }], settings);
    const fuel = await dispatchPostTripNotification(trip({
      score_overall: 80,
      score_eco: 90,
      fuel_saved_liters: 0.5,
    }), [{ score_overall: 80 }, { score_overall: 82 }], settings);
    const condition = await dispatchPostTripNotification(trip({
      score_overall: 80,
      safety_condition_bonus: 2,
    }), [{ score_overall: 80 }, { score_overall: 82 }], settings);
    const decline = await dispatchPostTripNotification(trip({
      score_overall: 60,
    }), [{ score_overall: 80 }, { score_overall: 82 }], settings);

    expect(phone.id).toBe(NOTIFICATION_IDS.TRIP_PHONE_USE_HIGH);
    expect(best.id).toBe(NOTIFICATION_IDS.TRIP_SCORE_PERSONAL_BEST);
    expect(improvement.id).toBe(NOTIFICATION_IDS.TRIP_SCORE_IMPROVEMENT);
    expect(fuel.id).toBe(NOTIFICATION_IDS.TRIP_FUEL_SAVING);
    expect(condition.id).toBe(NOTIFICATION_IDS.TRIP_CONDITION_ADJUSTED);
    expect(decline.id).toBe(NOTIFICATION_IDS.TRIP_SCORE_DECLINE);
  });

  it('does not format fuel-savings notifications with a raw hardcoded fallback price', () => {
    const source = readFileSync(new URL('../notificationService.js', import.meta.url), 'utf8');
    const titleIndex = source.indexOf("title: 'Eco Drive'");
    const branchStart = source.lastIndexOf('notif_post_trip_fuel_saving', titleIndex);
    const branchEnd = source.indexOf("title: 'Adjusted for Conditions'", titleIndex);
    const fuelSavingsBranch = source.slice(branchStart, branchEnd);

    expect(titleIndex).toBeGreaterThan(-1);
    expect(fuelSavingsBranch).not.toContain('1.65');
  });

  it('does not configure public lock-screen notification channels', () => {
    const source = readFileSync(new URL('../notificationService.js', import.meta.url), 'utf8');

    expect(source).not.toContain('visibility: 1');
    expect(source).toContain('visibility: ANDROID_NOTIFICATION_VISIBILITY.SECRET');
    expect(source).toContain('visibility: ANDROID_NOTIFICATION_VISIBILITY.PRIVATE');
  });

  it('hides native foreground notification content on Android lock screens', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java', import.meta.url), 'utf8');

    expect(source).toContain('.setVisibility(NotificationCompat.VISIBILITY_SECRET)');
    expect(source).toContain('channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET)');
    expect(source).toContain('.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)');
    expect(source).toContain('channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE)');
  });

  it('formats fuel-savings notifications from the user settings fuel price', async () => {
    const baseTrip = trip({
      id: 'fuel-settings-trip',
      score_overall: 80,
      score_eco: 90,
      fuel_saved_liters: 1,
    });
    const recentTrips = [{ score_overall: 80 }, { score_overall: 82 }];

    const lowPrice = await dispatchPostTripNotification(baseTrip, recentTrips, {
      ...settings,
      fuel_price_per_liter: 1,
    });
    const highPrice = await dispatchPostTripNotification(baseTrip, recentTrips, {
      ...settings,
      fuel_price_per_liter: 3.25,
    });
    const euroPrice = await dispatchPostTripNotification(baseTrip, recentTrips, {
      ...settings,
      currencySymbol: '€',
      fuel_price_per_liter: 3.25,
    });

    expect(lowPrice.body).toContain('~$1.00');
    expect(highPrice.body).toContain('~$3.25');
    expect(euroPrice.body).toContain('~€3.25');
  });

  it('summarizes stop-start, merge, and rapid acceleration patterns after higher-priority alerts', async () => {
    const stopStart = await dispatchPostTripNotification(trip({
      stop_start_pattern_count: 2,
      stop_start_pattern_score: 60,
    }), [{ score_overall: 82 }], settings);
    const merge = await dispatchPostTripNotification(trip({
      merge_event_count: 1,
      poor_merge_count: 1,
    }), [{ score_overall: 82 }], settings);
    const accel = await dispatchPostTripNotification(trip({
      rapid_accel_count: 3,
    }), [{ score_overall: 82 }], settings);

    expect(stopStart.id).toBe(NOTIFICATION_IDS.TRIP_STOP_START_SUMMARY);
    expect(merge.id).toBe(NOTIFICATION_IDS.TRIP_MERGE_SUMMARY);
    expect(accel.id).toBe(NOTIFICATION_IDS.TRIP_ACCEL_SUMMARY);
  });

  it('does not treat an unavailable stop-start score as an alert', async () => {
    const notification = await dispatchPostTripNotification(trip({
      stop_start_pattern_score: null,
      stop_start_pattern_count: 0,
    }), [{ score_overall: 82 }], {
      ...settings,
      notif_post_trip_score_change: false,
      notif_post_trip_fuel_saving: false,
    });

    expect(notification).toBeNull();
  });
});
