import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ACHIEVEMENT_NOTIF_IDS,
  NOTIFICATION_IDS,
  achievementNotificationId,
  dispatchPostTripNotification,
  isQuietHours,
  cancelStaleParkingReminder,
  getParkingReminderState,
  getParkingReminderStates,
  scheduleParkingReminder,
} from '@/lib/notificationService';
import { calculateAchievementBadges } from '@/lib/tripInsights';
import { pathForNotificationExtra } from '@/lib/appNavigation';

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

  it('uses milestone wording for achievement notification surfaces', () => {
    const source = readFileSync(new URL('../notificationService.js', import.meta.url), 'utf8');

    expect(source).toContain("name: 'Milestones'");
    expect(source).toContain("description: 'Milestone unlock notifications.'");
    expect(source).toContain("title: 'Milestone unlocked'");
    expect(source).toContain("title: `${newAchievements.length} milestones unlocked`");
    expect(source).not.toContain("title: 'Achievement unlocked'");
    expect(source).not.toContain('achievements unlocked');
  });

  it('opens the Milestones page when a milestone notification is tapped', () => {
    expect(pathForNotificationExtra({ type: 'achievement' })).toBe('/achievements');
    expect(pathForNotificationExtra({ type: 'achievement_batch' })).toBe('/achievements');
  });

  it('binds a parking reminder to the current parking revision', async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));

    const notification = await scheduleParkingReminder({
      minutes: 120,
      stateRevision: 55,
      vehicleName: 'Blue SUV',
    });

    expect(notification).toMatchObject({
      id: NOTIFICATION_IDS.PARKING_REMINDER,
      title: 'Parking reminder',
      extra: { type: 'parking_reminder', stateRevision: 55 },
    });
    expect(notification.body).toContain('Blue SUV');
    expect(await getParkingReminderState()).toMatchObject({
      stateRevision: 55,
      reminderAt: Date.parse('2026-07-29T14:00:00.000Z'),
      vehicleName: 'Blue SUV',
    });
    expect(await cancelStaleParkingReminder(55)).toBe(false);
    expect(await cancelStaleParkingReminder(56)).toBe(true);
    expect(localStorage.removeItem).toHaveBeenCalledWith(
      'drivesense_parking_reminder_state_v1',
    );
  });

  it('keeps independent reminder timers for multiple vehicles', async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));

    const first = await scheduleParkingReminder({
      minutes: 60,
      stateRevision: 101,
      vehicleId: 'car-a',
      vehicleName: 'Car A',
    });
    const second = await scheduleParkingReminder({
      minutes: 180,
      stateRevision: 202,
      vehicleId: 'car-b',
      vehicleName: 'Car B',
    });

    expect(first.id).not.toBe(second.id);
    expect(await getParkingReminderState({ vehicleId: 'car-a' })).toMatchObject({
      stateRevision: 101,
      vehicleName: 'Car A',
    });
    expect(await getParkingReminderState({ vehicleId: 'car-b' })).toMatchObject({
      stateRevision: 202,
      vehicleName: 'Car B',
    });
    expect(Object.keys(await getParkingReminderStates()).sort()).toEqual(['car-a', 'car-b']);
  });

  it('fires estimated brake-turn summary before lower-priority post-trip alerts', async () => {
    const notification = await dispatchPostTripNotification(trip({
      phone_use_risk: 'high',
      driving_events: [{ type: 'close_proximity' }, { type: 'close_proximity' }],
    }), [], settings);

    expect(notification.id).toBe(NOTIFICATION_IDS.TRIP_MANOEUVRE_ALERT_SUMMARY);
  });

  it('fires nothing when master notifications are disabled', async () => {
    const notification = await dispatchPostTripNotification(trip({
      driving_events: [{ type: 'close_proximity' }, { type: 'close_proximity' }],
    }), [], { ...settings, notifications_enabled: false });

    expect(notification).toBeNull();
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
    const titleIndex = source.indexOf("title: 'Efficient Trip'");
    const branchStart = source.lastIndexOf('notif_post_trip_fuel_saving', titleIndex);
    const branchEnd = source.indexOf("title: 'Adjusted for Conditions'", titleIndex);
    const fuelSavingsBranch = source.slice(branchStart, branchEnd);

    expect(titleIndex).toBeGreaterThan(-1);
    expect(fuelSavingsBranch).not.toContain('1.65');
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
