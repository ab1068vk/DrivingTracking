import { describe, expect, it } from 'vitest';
import {
  buildPhoneUseFromAndroidUsage,
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
  mergePhoneUseSignals,
} from '@/lib/phoneUsageAccess';

const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);

const routePoint = (index, speed = 55) => ({
  lat: 43.65 + index * 0.0001,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(baseTime + index * 1000).toISOString(),
});

describe('Android phone usage access merge', () => {
  it('turns foreground app sessions into high-confidence phone-use windows', () => {
    const usage = buildPhoneUseFromAndroidUsage({
      usage_access_granted: true,
      events: [{
        package_name: 'com.chat.app',
        start_ms: baseTime + 5_000,
        end_ms: baseTime + 25_000,
        duration_seconds: 20,
      }],
    }, Array.from({ length: 40 }, (_, index) => routePoint(index)), 120);

    expect(usage.phone_use_window_count).toBe(1);
    expect(usage.phone_use_risk).toBe('medium');
    expect(usage.phone_use_events[0].signals_triggered).toContain('android_usage_access');
    expect(usage.phone_use_events[0].lat).toBeDefined();
  });

  it('keeps the higher risk and lower score when GPS and usage access are combined', () => {
    const gps = {
      phone_use_events: [],
      phone_use_window_count: 0,
      phone_use_total_seconds: 0,
      phone_use_high_confidence_count: 0,
      phone_use_risk: 'none',
      phone_use_score: 100,
    };
    const usage = buildPhoneUseFromAndroidUsage({
      events: [
        { package_name: 'com.chat.app', start_ms: baseTime + 1_000, end_ms: baseTime + 31_000, duration_seconds: 30 },
        { package_name: 'com.mail.app', start_ms: baseTime + 45_000, end_ms: baseTime + 80_000, duration_seconds: 35 },
      ],
    }, Array.from({ length: 90 }, (_, index) => routePoint(index)), 120);

    const merged = mergePhoneUseSignals(gps, usage, 120);

    expect(merged.phone_use_risk).toBe('high');
    expect(merged.phone_use_score).toBeLessThan(100);
    expect(merged.phone_use_total_seconds).toBe(65);
  });

  it('adds usage-access phone events to the driving event list once', () => {
    const usage = buildPhoneUseFromAndroidUsage({
      events: [{ package_name: 'com.chat.app', start_ms: baseTime + 5_000, end_ms: baseTime + 15_000, duration_seconds: 10 }],
    }, Array.from({ length: 20 }, (_, index) => routePoint(index)), 60);
    const events = mergePhoneUseEventsIntoDrivingEvents([], usage);
    const again = mergePhoneUseEventsIntoDrivingEvents(events, usage);

    expect(events).toHaveLength(1);
    expect(again).toHaveLength(1);
  });

  it('reconstructs visible phone-use events from stored trip evidence', () => {
    const routePoints = Array.from({ length: 40 }, (_, index) => routePoint(index));
    const trip = {
      phone_use_window_count: 1,
      phone_use_risk: 'medium',
      native_phone_usage_access_granted: true,
      native_phone_usage_events: [{
        package_name: 'com.chat.app',
        start_ms: baseTime + 5_000,
        end_ms: baseTime + 25_000,
        duration_seconds: 20,
      }],
      driving_events: [],
    };

    const phoneUse = buildPhoneUseFromTripEvidence(trip, routePoints, 120, {});
    const events = mergePhoneUseEventsIntoDrivingEvents(trip.driving_events, phoneUse);

    expect(phoneUse.phone_use_window_count).toBe(1);
    expect(phoneUse.phone_use_events[0].source).toBe('android_usage_access');
    expect(events.some((event) => event.type === 'phone_use')).toBe(true);
  });
});
