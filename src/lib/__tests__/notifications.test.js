import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_IDS,
  dispatchPostTripNotification,
  isQuietHours,
} from '@/lib/notificationService';

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
  });

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

  it('fires near-miss summary before lower-priority post-trip alerts', async () => {
    const notification = await dispatchPostTripNotification(trip({
      phone_use_risk: 'high',
      driving_events: [{ type: 'near_miss' }, { type: 'near_miss' }],
    }), [], settings);

    expect(notification.id).toBe(NOTIFICATION_IDS.TRIP_NEAR_MISS_SUMMARY);
  });

  it('fires nothing when master notifications are disabled', async () => {
    const notification = await dispatchPostTripNotification(trip({
      driving_events: [{ type: 'near_miss' }, { type: 'near_miss' }],
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
});
