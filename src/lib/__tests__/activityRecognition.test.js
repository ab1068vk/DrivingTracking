import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  computeGpsPositionDrift,
  shouldAutoStopTracking,
} from '@/lib/activityRecognition';

describe('activityRecognition auto-stop logic', () => {
  it('does not stop at a red light with still activity and GPS drift', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 50,
      gpsPositionDriftM: 12,
    })).toBe(false);
  });

  it('stops quickly when parked with still activity and stable GPS', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 50,
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

  it('falls back to GPS-only stop when activity is missing and GPS is stable', () => {
    expect(shouldAutoStopTracking({
      activity: null,
      currentSpeedKmh: 0,
      stillSeconds: 190,
      gpsPositionDriftM: 4,
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
