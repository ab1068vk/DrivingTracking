import { describe, expect, it } from 'vitest';
import {
  buildDashboardTrackingExplanation,
  buildParkingTimeline,
  buildTrackingHealth,
  normalizeNativeDiagnosticEvents,
} from '@/lib/trackingDiagnostics';

describe('tracking diagnostics', () => {
  it('builds a real parking timeline from trip fields and native events', () => {
    const timeline = buildParkingTimeline({
      start_time: '2026-01-01T12:00:00.000Z',
      end_time: '2026-01-01T12:20:00.000Z',
      start_source: 'native_auto',
      traffic_idle_seconds: 45,
      sustained_idle_seconds: 240,
      parking_stop_detected: true,
      parking_stop_duration_seconds: 180,
      native_auto_stop_reason: 'parked_gps_stable',
      native_tracking_timeline: [{
        timestamp: '2026-01-01T12:19:30.000Z',
        type: 'trip_ended',
        reason: 'parked_gps_stable',
      }],
    });

    expect(timeline.map((item) => item.type)).toContain('parking_detected');
    expect(timeline.map((item) => item.type)).toContain('parked_idle');
    expect(timeline[0].type).toBe('trip_started');
  });

  it('normalizes Android diagnostic events for the UI log', () => {
    const events = normalizeNativeDiagnosticEvents({
      events: [{
        type: 'armed_location_watch',
        timestamp: '2026-01-01T12:00:00.000Z',
        reason: 'armed_gps_backup',
        speed_kmh: 0,
      }],
    });

    expect(events[0].source).toBe('android');
    expect(events[0].title).toBe('Movement watcher armed');
  });

  it('marks tracking health from real permission and native status', () => {
    const health = buildTrackingHealth({
      permissionStatus: {
        foregroundLocation: 'granted',
        backgroundLocation: 'denied',
        activityRecognition: 'granted',
        motionSensors: 'granted',
        notifications: 'granted',
        phoneUsageAccess: 'granted',
        bluetooth: 'not_requested',
      },
      nativeStatus: { enabled: true },
      batteryStatus: { batteryOptimizationIgnored: true },
      latestTrip: { parking_stop_detected: true, end_time: '2026-01-01T12:00:00.000Z' },
    });

    expect(health.find((item) => item.id === 'native')?.status).toBe('good');
    expect(health.find((item) => item.id === 'background')?.status).toBe('warn');
    expect(health.find((item) => item.id === 'motion')?.status).toBe('good');
    expect(health.find((item) => item.id === 'notifications')?.status).toBe('good');
    expect(health.find((item) => item.id === 'bluetooth')?.detail).toContain('OBD-II');
  });

  it('explains why dashboard auto tracking did not start from real permission state', () => {
    const explanation = buildDashboardTrackingExplanation({
      settings: { tracking_mode: 'background_auto', auto_tracking_enabled: true },
      permissionStatus: {
        foregroundLocation: 'granted',
        backgroundLocation: 'denied',
        activityRecognition: 'denied',
        notifications: 'granted',
      },
      nativeStatus: { enabled: false },
      batteryStatus: { batteryOptimizationIgnored: false },
      isAndroidPlatform: true,
    });

    expect(explanation.status).toBe('bad');
    expect(explanation.headline).toBe('Auto tracking did not start');
    expect(explanation.detail).toContain('Physical Activity');
    expect(explanation.facts.join(' ')).toContain('Background');
  });

  it('surfaces the last successful auto-start decision on dashboard', () => {
    const explanation = buildDashboardTrackingExplanation({
      settings: { tracking_mode: 'auto_detect', auto_tracking_enabled: true },
      permissionStatus: {
        foregroundLocation: 'granted',
        activityRecognition: 'granted',
      },
      diagnostics: {
        events: [{
          type: 'auto_start',
          title: 'In-app auto-start triggered',
          reason: 'activity_in_vehicle',
          timestamp: '2026-01-01T12:00:00.000Z',
        }],
      },
      isAndroidPlatform: true,
    });

    expect(explanation.status).toBe('good');
    expect(explanation.headline).toBe('Last auto start succeeded');
    expect(explanation.detail).toContain('activity in vehicle');
  });
});
