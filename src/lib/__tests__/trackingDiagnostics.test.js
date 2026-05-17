import { describe, expect, it } from 'vitest';
import { buildParkingTimeline, buildTrackingHealth, normalizeNativeDiagnosticEvents } from '@/lib/trackingDiagnostics';

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
        phoneUsageAccess: 'granted',
      },
      nativeStatus: { enabled: true },
      batteryStatus: { batteryOptimizationIgnored: true },
      latestTrip: { parking_stop_detected: true, end_time: '2026-01-01T12:00:00.000Z' },
    });

    expect(health.find((item) => item.id === 'native')?.status).toBe('good');
    expect(health.find((item) => item.id === 'background')?.status).toBe('warn');
  });
});
