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
      nativeStatus: {
        enabled: true,
        completedTripsCount: 1,
        completedTripJournal: {
          queueReadable: true,
          pendingCount: 1,
          unreadableCount: 0,
          encryptedBytes: 700_000,
          maxTotalBytes: 32 * 1024 * 1024,
          maxFileBytes: 512 * 1024,
          availableDeviceBytes: 4 * 1024 * 1024 * 1024,
        },
        activeTripCheckpoint: {
          supported: true,
          state: 'protected',
          present: true,
          ageSeconds: 24,
          encryptedBytes: 12_500,
          maxEncryptedBytes: 524_288,
        },
      },
      batteryStatus: { batteryOptimizationIgnored: true },
      latestTrip: { parking_stop_detected: true, end_time: '2026-01-01T12:00:00.000Z' },
    });

    expect(health.find((item) => item.id === 'native')?.status).toBe('good');
    expect(health.find((item) => item.id === 'native-handoff')).toMatchObject({
      status: 'warn',
      value: '1 pending',
    });
    expect(health.find((item) => item.id === 'active-checkpoint')).toMatchObject({
      status: 'good',
      value: 'Protected',
    });
    expect(health.find((item) => item.id === 'active-checkpoint')?.detail).toContain('13 KB');
    expect(health.find((item) => item.id === 'recovery-storage')).toMatchObject({
      status: 'good',
      value: 'Bounded',
    });
    expect(health.find((item) => item.id === 'recovery-storage')?.detail).toContain('32 MB total');
    expect(health.find((item) => item.id === 'background')?.status).toBe('warn');
    expect(health.find((item) => item.id === 'motion')?.status).toBe('good');
    expect(health.find((item) => item.id === 'notifications')?.status).toBe('good');
    expect(health.find((item) => item.id === 'bluetooth')?.detail).toContain('OBD-II');
  });

  it('preserves and surfaces an unreadable native handoff queue', () => {
    const health = buildTrackingHealth({
      nativeStatus: {
        enabled: true,
        completedTripsCount: 0,
        completedTripJournal: {
          queueReadable: false,
          pendingCount: 0,
          unreadableCount: 1,
          encryptedBytes: 2048,
          maxTotalBytes: 32 * 1024 * 1024,
          maxFileBytes: 512 * 1024,
        },
      },
    });

    expect(health.find((item) => item.id === 'native-handoff')).toMatchObject({
      status: 'bad',
      value: 'Needs attention',
    });
    expect(health.find((item) => item.id === 'native-handoff')?.detail).toContain('preserves it');
  });

  it('warns when protected recovery storage is nearly full', () => {
    const health = buildTrackingHealth({
      nativeStatus: {
        enabled: true,
        completedTripsCount: 3,
        completedTripJournal: {
          queueReadable: true,
          pendingCount: 3,
          unreadableCount: 0,
          encryptedBytes: 27 * 1024 * 1024,
          maxTotalBytes: 32 * 1024 * 1024,
          maxFileBytes: 512 * 1024,
          availableDeviceBytes: 2 * 1024 * 1024 * 1024,
        },
      },
    });

    expect(health.find((item) => item.id === 'recovery-storage')).toMatchObject({
      status: 'warn',
      value: 'Journal nearly full',
    });
  });

  it('confirms when no temporary active-trip checkpoint is retained', () => {
    const health = buildTrackingHealth({
      nativeStatus: {
        enabled: true,
        recordingActive: false,
        completedTripsCount: 0,
        activeTripCheckpoint: {
          supported: true,
          state: 'none',
          present: false,
          encryptedBytes: 0,
          maxEncryptedBytes: 524_288,
        },
      },
    });

    expect(health.find((item) => item.id === 'active-checkpoint')).toMatchObject({
      status: 'good',
      value: 'None stored',
      detail: 'No temporary active-trip recovery file is retained.',
    });
  });

  it('shows waiting while an active trip has not reached its first checkpoint', () => {
    const health = buildTrackingHealth({
      nativeStatus: {
        enabled: true,
        recordingActive: true,
        completedTripsCount: 0,
        activeTripCheckpoint: {
          supported: true,
          state: 'none',
          present: false,
          encryptedBytes: 0,
          maxEncryptedBytes: 524_288,
        },
      },
    });

    expect(health.find((item) => item.id === 'active-checkpoint')).toMatchObject({
      status: 'warn',
      value: 'Waiting',
    });
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

  it('explains the all-green-but-not-started state with next detection signals', () => {
    const explanation = buildDashboardTrackingExplanation({
      settings: { tracking_mode: 'background_auto', auto_tracking_enabled: true },
      permissionStatus: {
        foregroundLocation: 'granted',
        backgroundLocation: 'granted',
        activityRecognition: 'granted',
        notifications: 'granted',
      },
      nativeStatus: { enabled: true },
      batteryStatus: { batteryOptimizationIgnored: true },
      currentSpeedKmh: 0,
      isAndroidPlatform: true,
    });

    expect(explanation.status).toBe('warn');
    expect(explanation.headline).toBe('Ready, but no drive signal yet');
    expect(explanation.detail).toContain('2 seconds');
    expect(explanation.detail).toContain('5 km/h');
    expect(explanation.facts.join(' ')).toContain('All required setup checks are green');
  });
});

/**
 * AUD-006 — the active-trip recovery row must describe what Android actually reports.
 *
 * The consumer tested for `invalid_removed`, a state the shipping Java emitter never
 * produces. Its real preserved-but-unreadable state, `invalid_preserved`, fell through
 * to the default branch and rendered as green, "None stored", "No temporary active-trip
 * recovery file is retained." — while a retained encrypted file sat on the device. A
 * diagnostics screen that reports the opposite of the truth is worse than one that says
 * nothing.
 */
describe('AUD-006 active-trip recovery truthfulness', () => {
  const checkpointRow = (activeTripCheckpoint, extra = {}) => buildTrackingHealth({
    nativeStatus: { enabled: true, recordingActive: false, activeTripCheckpoint, ...extra },
  }).find((item) => item.id === 'active-checkpoint');

  it('reports a preserved unreadable checkpoint as retained, not as absent', () => {
    const row = checkpointRow({
      supported: true,
      state: 'invalid_preserved',
      present: true,
      encryptedBytes: 12_500,
      maxEncryptedBytes: 524_288,
    });

    expect(row?.status).toBe('warn');
    expect(row?.value).not.toBe('None stored');
    expect(row?.detail).toMatch(/preserv|retain|unreadable/i);
    expect(row?.detail).not.toBe('No temporary active-trip recovery file is retained.');
    expect(row?.detail).toContain('13 KB');
  });

  it('does not collapse an unrecognised present state to absent', () => {
    const row = checkpointRow({
      supported: true,
      state: 'future_preserved_state',
      present: true,
      encryptedBytes: 512,
    });

    expect(row?.status).not.toBe('good');
    expect(row?.value).not.toBe('None stored');
    expect(row?.detail).not.toMatch(/No temporary .* file is retained/i);
  });

  it('treats a contradictory protected-but-absent report as unknown, never as good', () => {
    const row = checkpointRow({ supported: true, state: 'protected', present: false });
    expect(row?.status).toBe('unknown');
    expect(row?.value).toBe('Unknown');
  });

  it('still reports a genuinely absent checkpoint truthfully', () => {
    const row = checkpointRow({
      supported: true, state: 'future_state', present: false, encryptedBytes: 0,
    });
    expect(row).toMatchObject({ status: 'good', value: 'None stored' });
  });

  it('never claims a preserved checkpoint was removed', () => {
    const row = checkpointRow({
      supported: true, state: 'invalid_preserved', present: true, encryptedBytes: 900,
    });
    expect(row?.value).not.toMatch(/removed/i);
    expect(row?.detail).not.toMatch(/removed|deleted/i);
  });

  it('handles every checkpoint state the Android emitter can produce', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { CHECKPOINT_STATES_HANDLED } = await import('@/lib/trackingDiagnostics');
    const java = readFileSync(resolve(
      process.cwd(),
      'android/app/src/main/java/com/drivesense/app/DriveSenseActiveTripCheckpointStore.java',
    ), 'utf8');

    const emitted = [...java.matchAll(/status\.put\("state",\s*(?:[^"]*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?\)/g)]
      .flatMap(([, first, second]) => [first, second].filter(Boolean));

    // Guard against a vacuous pass: if the regex stops matching the emitter, this fails
    // rather than quietly asserting nothing.
    expect(new Set(emitted)).toEqual(new Set(['unknown', 'none', 'invalid_preserved', 'protected']));
    emitted.forEach((state) => expect(CHECKPOINT_STATES_HANDLED).toContain(state));
  });
});
