import { describe, expect, it } from 'vitest';
import {
  PHONE_USE_PENALTY_POINTS,
  PHONE_USE_SEVERITY_THRESHOLDS,
  buildPhoneUseFromAndroidUsage,
  buildPhoneUsageAccessProvenance,
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
  it('exposes phone-use scoring heuristics for calibration review', () => {
    expect(PHONE_USE_SEVERITY_THRESHOLDS).toMatchObject({
      HIGH_DURATION_SECONDS: 90,
      HIGH_SPEED_KMH: 100,
      MEDIUM_DURATION_SECONDS: 20,
      MEDIUM_SPEED_KMH: 50,
    });
    expect(PHONE_USE_PENALTY_POINTS).toMatchObject({
      high: 20,
      medium: 10,
      low: 4,
    });
  });

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
    expect(usage.phone_use_events[0].severity).toBe('medium');
    expect(usage.phone_use_score).toBe(100 - PHONE_USE_PENALTY_POINTS.medium);
    expect(usage.phone_use_events[0].signals_triggered).toContain('android_usage_access');
    expect(usage.phone_use_events[0].lat).toBeDefined();
  });

  it('ignores passive navigation and stale usage sessions', () => {
    const routePoints = Array.from({ length: 40 }, (_, index) => routePoint(index));
    const usage = buildPhoneUseFromAndroidUsage({
      usage_access_granted: true,
      events: [
        { package_name: 'com.google.android.apps.maps', start_ms: baseTime + 5_000, end_ms: baseTime + 25_000, duration_seconds: 20 },
        { package_name: 'com.chat.app', start_ms: baseTime + 5 * 60_000, end_ms: baseTime + 5 * 60_000 + 20_000, duration_seconds: 20 },
      ],
    }, routePoints, 120);

    expect(usage.phone_use_window_count).toBe(0);
    expect(usage.phone_use_risk).toBe('none');
  });

  it('requires Android usage to overlap moving trip points', () => {
    const usage = buildPhoneUseFromAndroidUsage({
      usage_access_granted: true,
      events: [{
        package_name: 'com.chat.app',
        start_ms: baseTime + 5_000,
        end_ms: baseTime + 25_000,
        duration_seconds: 20,
      }],
    }, Array.from({ length: 40 }, (_, index) => routePoint(index, 0)), 120);

    expect(usage.phone_use_window_count).toBe(0);
    expect(usage.phone_use_score).toBe(100);
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

  it('keeps only the higher-confidence signal when GPS and Android windows overlap', () => {
    const gps = {
      phone_use_events: [{
        type: 'phone_use',
        source: 'gps_proxy',
        startTime: new Date(baseTime + 10_000).toISOString(),
        endTime: new Date(baseTime + 30_000).toISOString(),
        durationS: 20,
        confidence: 0.62,
      }],
      phone_use_risk: 'medium',
      phone_use_score: 88,
    };
    const usage = buildPhoneUseFromAndroidUsage({
      events: [{ package_name: 'com.chat.app', start_ms: baseTime + 12_000, end_ms: baseTime + 32_000, duration_seconds: 20 }],
    }, Array.from({ length: 40 }, (_, index) => routePoint(index)), 120);

    const merged = mergePhoneUseSignals(gps, usage, 120);
    expect(merged.phone_use_window_count).toBe(1);
    expect(merged.phone_use_events[0].source).toBe('android_usage_access');
    expect(merged.phone_use_total_seconds).toBe(20);
  });

  it('retains GPS proxy evidence as diagnostics without creating a phone-use score', () => {
    const gps = {
      phone_use_events: [{
        type: 'phone_use',
        source: 'gps_proxy',
        diagnostic_only: true,
        startTime: new Date(baseTime + 10_000).toISOString(),
        durationS: 10,
        confidence: 0.7,
      }],
      data_sources: ['gps_proxy'],
    };

    const merged = mergePhoneUseSignals(gps, {}, 120);

    expect(merged.phone_use_events).toEqual([]);
    expect(merged.phone_use_score).toBeNull();
    expect(merged.phone_use_score_status).toBe('usage_access_required');
    expect(merged.phone_proxy_count).toBe(1);
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

  it('reports provenance when current Usage Access no longer matches the recorded trip state', () => {
    const provenance = buildPhoneUsageAccessProvenance({
      native_phone_usage_access_granted: true,
    }, false);

    expect(provenance).toMatchObject({
      recordedUsageAccessGranted: true,
      currentUsageAccessGranted: false,
      changed: true,
    });
    expect(provenance.note).toBe('Phone use score was recorded when Usage Access was granted. Current permission status has changed.');
  });
});
