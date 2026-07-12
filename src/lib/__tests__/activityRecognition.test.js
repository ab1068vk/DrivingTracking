import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STATE_MAX_AGE_MS,
  ACTIVITY_TYPES,
  computeGpsPositionDrift,
  normalizeNativeActiveTrip,
  shouldAutoStartTracking,
  shouldAutoStopTracking,
} from '@/lib/activityRecognition';

describe('activityRecognition auto-stop logic', () => {
  it('normalizes privacy-safe native live recording status for Tracking Mode', () => {
    expect(normalizeNativeActiveTrip({
      recordingActive: true,
      activeTrip: {
        id: 'native-live',
        state: 'recording',
        start_time: '2026-07-10T18:00:00.000Z',
        start_source: 'native_auto',
        distance_km: 4.25,
        duration_seconds: 615,
        speed_kmh: 47,
        route_point_count: 92,
      },
    })).toMatchObject({
      id: 'native-live',
      native_recording: true,
      state: 'recording',
      distance_km: 4.25,
      duration_seconds: 615,
      speed_kmh: 47,
      route_point_count: 92,
    });
  });

  it('does not report stale native status as an active recording', () => {
    expect(normalizeNativeActiveTrip({ recordingActive: false, activeTrip: { active: true } })).toBeNull();
    expect(normalizeNativeActiveTrip({ recordingActive: true, activeTrip: null })).toBeNull();
  });

  it('keeps Android ON_BICYCLE distinct from the legacy CYCLING alias', () => {
    expect(ACTIVITY_TYPES.ON_BICYCLE).toBe('on_bicycle');
    expect(ACTIVITY_TYPES.CYCLING).toBe('cycling');
  });

  it('auto-starts after a two-second confirmed in-vehicle movement window', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 66 },
      currentSpeedKmh: 5,
      recentMovingSeconds: 2,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 66 },
      currentSpeedKmh: 5,
      recentMovingSeconds: 1,
    })).toBe(false);
  });

  it('auto-starts from sustained GPS movement when Android activity is delayed', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.UNKNOWN, confidence: 0 },
      currentSpeedKmh: 5,
      recentMovingSeconds: 2,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.UNKNOWN, confidence: 0 },
      currentSpeedKmh: 5,
      recentMovingSeconds: 1,
    })).toBe(false);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.UNKNOWN, confidence: 0 },
      currentSpeedKmh: 4.9,
      recentMovingSeconds: 3,
    })).toBe(false);
  });

  it('does not stop at a red light with still activity and GPS drift', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 50,
      gpsPositionDriftM: 12,
    })).toBe(false);
  });

  it('stops quickly when parked with still activity and stable GPS', () => {
    // FIX: Stable STILL auto-stop now matches the native 90-second threshold instead of 45 seconds.
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 90,
      gpsPositionDriftM: 3,
    })).toBe(true);
  });

  it('stops after parking when the user is walking away', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 80 },
      currentSpeedKmh: 0,
      stillSeconds: 20,
      gpsPositionDriftM: 3,
    })).toBe(true);
  });

  it('stops after parking when walking GPS speed is above the idle cutoff', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 82 },
      currentSpeedKmh: 10,
      stillSeconds: 20,
      gpsPositionDriftM: 18,
    })).toBe(true);
  });

  it('stops after parking when Android reports on-bicycle activity', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.ON_BICYCLE, confidence: 82 },
      currentSpeedKmh: 8,
      stillSeconds: 20,
      gpsPositionDriftM: 18,
    })).toBe(true);
  });

  it('does not use walking activity alone to end a trip above the walking speed cutoff', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 82 },
      currentSpeedKmh: 11,
      stillSeconds: 20,
      gpsPositionDriftM: 18,
    })).toBe(false);
  });

  it('does not stop while in a crawling traffic jam', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 80 },
      currentSpeedKmh: 0,
      stillSeconds: 250,
      gpsPositionDriftM: 6,
    })).toBe(false);
  });

  it('stops when in-vehicle activity is stale but GPS is very stable', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 80 },
      currentSpeedKmh: 0,
      stillSeconds: 250,
      gpsPositionDriftM: 3,
    })).toBe(true);
  });

  it('ends a parked in-vehicle stop sooner when GPS is very stable', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 80 },
      currentSpeedKmh: 0,
      stillSeconds: 180,
      gpsPositionDriftM: 3,
      lastMovingSpeedKmh: 45,
    })).toBe(true);
  });

  it('ends a long parked in-vehicle stop without waiting forever on moderate GPS drift', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 80 },
      currentSpeedKmh: 0,
      stillSeconds: 300,
      gpsPositionDriftM: 12,
      lastMovingSpeedKmh: 0,
    })).toBe(true);
  });

  it('treats stale in-vehicle activity as missing before GPS-only parked fallback', () => {
    const nowMs = Date.UTC(2026, 0, 1, 12, 1, 0);
    const staleActivity = {
      type: ACTIVITY_TYPES.IN_VEHICLE,
      confidence: 90,
      timestamp: new Date(nowMs - ACTIVITY_STATE_MAX_AGE_MS - 1).toISOString(),
    };

    expect(shouldAutoStopTracking({
      activity: staleActivity,
      currentSpeedKmh: 0,
      stillSeconds: 250,
      gpsPositionDriftM: 12,
      nowMs,
    })).toBe(false);

    expect(shouldAutoStopTracking({
      activity: staleActivity,
      currentSpeedKmh: 0,
      stillSeconds: 300,
      gpsPositionDriftM: 12,
      nowMs,
      returnReason: true,
    })).toMatchObject({
      shouldStop: true,
      reason: 'activity_recognition_stale',
      activityStale: true,
    });
  });

  it('falls back to GPS-only stop when activity is missing and GPS is stable', () => {
    expect(shouldAutoStopTracking({
      activity: null,
      currentSpeedKmh: 0,
      stillSeconds: 190,
      gpsPositionDriftM: 4,
    })).toBe(true);

    expect(shouldAutoStopTracking({
      activity: null,
      currentSpeedKmh: 0,
      stillSeconds: 190,
      gpsPositionDriftM: 7.5,
    })).toBe(true);

    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.UNKNOWN, confidence: 0 },
      currentSpeedKmh: 0,
      stillSeconds: 190,
      gpsPositionDriftM: 7.5,
    })).toBe(true);
  });

  it('does not GPS-only stop when activity is missing but GPS is drifting', () => {
    expect(shouldAutoStopTracking({
      activity: null,
      currentSpeedKmh: 0,
      stillSeconds: 190,
      gpsPositionDriftM: 9,
    })).toBe(false);
  });

  it('computes max GPS position drift from the stopped anchor', () => {
    const driftM = computeGpsPositionDrift(43.6532, -79.3832, [
      { lat: 43.6532, lng: -79.3832 },
      { lat: 43.65325, lng: -79.3832 },
      { lat: 43.6533, lng: -79.3832 },
    ]);

    expect(driftM).toBeGreaterThan(11);
    expect(driftM).toBeLessThan(11.2);
  });
});
