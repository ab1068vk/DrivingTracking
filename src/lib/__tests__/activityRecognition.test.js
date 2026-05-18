import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  computeGpsPositionDrift,
  shouldAutoStartTracking,
  shouldAutoStopTracking,
} from '@/lib/activityRecognition';

describe('activityRecognition auto-stop logic', () => {
  it('auto-starts after a one-second confirmed in-vehicle movement window', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 66 },
      currentSpeedKmh: 3.5,
      recentMovingSeconds: 1,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 66 },
      currentSpeedKmh: 3.5,
      recentMovingSeconds: 0.5,
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
      currentSpeedKmh: 6,
      stillSeconds: 20,
      gpsPositionDriftM: 18,
    })).toBe(true);
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
