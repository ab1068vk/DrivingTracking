import { describe, expect, it } from 'vitest';
import { applyCalibrationProfile, computeCalibrationProfile } from '@/lib/thresholdCalibration';

const point = (seconds, speedKmh) => ({
  lat: 43.6532 + seconds * 0.0001,
  lng: -79.3832,
  speed_kmh: speedKmh,
  accuracy: 5,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

const trip = (index, distanceKm = 15, speeds = [20, 80, 20]) => ({
  id: `t${index}`,
  status: 'completed',
  distance_km: distanceKm,
  start_time: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
  end_time: new Date(Date.UTC(2026, 0, index + 1, 13)).toISOString(),
  route_points: speeds.map((speed, i) => point(i * 5, speed)),
  driving_events: [],
});

const thresholds = {
  HARSH_BRAKE_MS2: 4.5,
  RAPID_ACCEL_MS2: 3.5,
  SHARP_TURN_G_LOW: 0.3,
  SHARP_TURN_G_MEDIUM: 0.45,
  SHARP_TURN_G_HIGH: 0.6,
};

describe('thresholdCalibration', () => {
  it('returns insufficient when fewer than 15 trips', () => {
    expect(computeCalibrationProfile([trip(1)], thresholds).insufficient).toBe(true);
  });

  it('returns insufficient when trips exist but under 200 km total', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 5)), thresholds);
    expect(profile.insufficient).toBe(true);
    expect(profile.kmNeeded).toBeGreaterThan(0);
  });

  it('clamps suggested harsh brake threshold to [3.0, 7.0]', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20, [120, 0])), thresholds);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeLessThanOrEqual(7);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeGreaterThanOrEqual(3);
  });

  it('clamps suggested rapid acceleration threshold to [2.0, 6.0]', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20, [0, 120])), thresholds);
    expect(profile.suggested.threshold_rapid_accel_ms2).toBeLessThanOrEqual(6);
    expect(profile.suggested.threshold_rapid_accel_ms2).toBeGreaterThanOrEqual(2);
  });

  it('applyCalibrationProfile merges into settings', async () => {
    let saved = null;
    const profile = {
      suggested: { threshold_harsh_brake_ms2: 5, threshold_rapid_accel_ms2: 4 },
    };
    const settings = await applyCalibrationProfile(profile, { units: 'metric' }, async (next) => { saved = next; });

    expect(settings.threshold_harsh_brake_ms2).toBe(5);
    expect(saved.threshold_rapid_accel_ms2).toBe(4);
  });

  it('computes delta as suggested minus current', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20)), thresholds);
    expect(profile.delta.threshold_harsh_brake_ms2).toBeCloseTo(
      profile.suggested.threshold_harsh_brake_ms2 - profile.current.threshold_harsh_brake_ms2,
      1
    );
  });

  it('uses repeated wrong event feedback even before the mileage baseline is met', () => {
    const profile = computeCalibrationProfile([
      {
        ...trip(1, 10, [30, 35, 32]),
        event_feedback: {
          e1: { type: 'harsh_brake', verdict: 'wrong', value: 4.9 },
          e2: { type: 'harsh_brake', verdict: 'wrong', value: 5.2 },
          e3: { type: 'rapid_acceleration', verdict: 'accurate', value: 3.3 },
        },
      },
    ], thresholds);

    expect(profile.insufficient).toBe(false);
    expect(profile.feedbackSummary.total).toBe(3);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeGreaterThan(thresholds.HARSH_BRAKE_MS2);
  });

  it('keeps turn feedback calibration at two-decimal g precision', () => {
    const profile = computeCalibrationProfile([
      {
        ...trip(1, 10, [30, 35, 32]),
        event_feedback: {
          e1: { type: 'sharp_turn', verdict: 'wrong', value: 0.51 },
          e2: { type: 'sharp_turn', verdict: 'wrong', value: 0.52 },
          e3: { type: 'sharp_turn', verdict: 'wrong', value: 0.53 },
        },
      },
    ], thresholds);

    expect(profile.suggested.threshold_sharp_turn_g_medium).toBe(0.58);
    expect(profile.delta.threshold_sharp_turn_g_medium).toBe(0.13);
  });
});
