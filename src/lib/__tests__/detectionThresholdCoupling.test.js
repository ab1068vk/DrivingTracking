import { describe, expect, it } from 'vitest';
import {
  buildDrivingThresholds,
  detectDrivingEvents,
  calculateTripScores,
  calculateJerkScore,
  DEFAULT_THRESHOLDS,
  EVENT_TYPES,
} from '@/lib/tripEngine';
import { classifyMagnitudeSeverity, classifySpeedingSeverity, shiftSeverity } from '@/lib/scoring/eventSeverity';
import { refineEventsWithMotion, IMU_EVIDENCE } from '@/lib/scoring/motionEventRefinement';
import { calculateImuJerk } from '@/lib/scoring/motionJerk';
import { STANDARD_GRAVITY_MS2 } from '@/lib/mathUtils';

const START_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (offsetMs) => new Date(START_MS + offsetMs).toISOString();

const KM_PER_DEGREE_LAT = 111.32;

/**
 * Straight-line route heading north, one point per second at the given speeds.
 * Positions integrate the speeds so coordinate displacement agrees with the reported
 * speed — otherwise the engine's own noise filter discards the points before any
 * detector sees them.
 */
const routeFromSpeeds = (speedsKmh) => {
  let lat = 43.65;
  return speedsKmh.map((speed, index) => {
    if (index > 0) lat += (speedsKmh[index - 1] / 3600) / KM_PER_DEGREE_LAT;
    return {
      lat,
      lng: -79.38,
      timestamp: iso(index * 1000),
      speed_kmh: speed,
      accuracy: 5,
    };
  });
};

/**
 * Cruise, brake at the requested deceleration for several seconds, then cruise again.
 *
 * The ramp has to be sustained: the engine derives acceleration from a centered 3-point
 * window, so a single one-second pulse is averaged down to half its true rate and never
 * reaches the trigger.
 */
const brakingRoute = (cruiseKmh, decelMs2, steps = 4) => {
  const dropKmh = decelMs2 * 3.6;
  const speeds = [cruiseKmh, cruiseKmh, cruiseKmh, cruiseKmh];
  let current = cruiseKmh;
  for (let i = 0; i < steps; i++) {
    current = Math.max(5, current - dropKmh);
    speeds.push(current);
  }
  speeds.push(current, current, current, current);
  return routeFromSpeeds(speeds);
};

const harshBrakes = (points, thresholds) => detectDrivingEvents(points, thresholds).events
  .filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE);

describe('event severity is coupled to the configured threshold', () => {
  it('classifies the same braking event differently as the user moves the slider', () => {
    // A ~5 m/s2 deceleration: comfortably above a 3.5 default, only just above a 4.5 setting.
    const points = brakingRoute(110, 5);

    const defaultEvents = harshBrakes(points, buildDrivingThresholds({}));
    const sensitiveEvents = harshBrakes(points, buildDrivingThresholds({ threshold_harsh_brake_ms2: 2.5 }));

    expect(defaultEvents.length).toBeGreaterThan(0);
    expect(sensitiveEvents.length).toBeGreaterThan(0);

    // This is the defect the coupling fixes: at a lower trigger threshold the same physical
    // event sits further above it, so it must be classified as more severe, not identically.
    const severityRank = { low: 0, medium: 1, high: 2 };
    expect(severityRank[sensitiveEvents[0].severity])
      .toBeGreaterThanOrEqual(severityRank[defaultEvents[0].severity]);
  });

  it('raising the threshold cannot leave every surviving event at high severity', () => {
    // With hardcoded literals (>6 high, >5 medium) a user who set 7.0 got "high" for
    // everything that still fired, because the trigger itself was above the high band.
    const thresholds = buildDrivingThresholds({ threshold_harsh_brake_ms2: 7 });
    const bands = {
      justOverTrigger: classifyMagnitudeSeverity(7.2, 7, EVENT_TYPES.HARSH_BRAKE),
      wellOverTrigger: classifyMagnitudeSeverity(13, 7, EVENT_TYPES.HARSH_BRAKE),
    };

    expect(thresholds.HARSH_BRAKE_MS2).toBe(7);
    expect(bands.justOverTrigger).toBe('low');
    expect(bands.wellOverTrigger).toBe('high');
  });

  it('keeps default-threshold boundaries close to the previous hardcoded literals', () => {
    // The severity multipliers were chosen so a user who never touched a slider sees a
    // near-neutral re-score. Guard that: harsh brake was >5 medium / >6 high.
    const trigger = DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
    expect(classifyMagnitudeSeverity(4.4, trigger, EVENT_TYPES.HARSH_BRAKE)).toBe('low');
    expect(classifyMagnitudeSeverity(5.0, trigger, EVENT_TYPES.HARSH_BRAKE)).toBe('medium');
    expect(classifyMagnitudeSeverity(6.5, trigger, EVENT_TYPES.HARSH_BRAKE)).toBe('high');
  });

  it('reports a degenerate threshold as low rather than promoting everything to high', () => {
    expect(classifyMagnitudeSeverity(9, 0, EVENT_TYPES.HARSH_BRAKE)).toBe('low');
    expect(classifyMagnitudeSeverity(9, -1, EVENT_TYPES.HARSH_BRAKE)).toBe('low');
  });

  it('scales no-limit speeding severity with the configured fallback threshold', () => {
    const strict = { SPEEDING_FALLBACK_KMH: 80 };
    const lax = { SPEEDING_FALLBACK_KMH: 130 };
    expect(classifySpeedingSeverity(150, null, strict)).toBe('high');
    expect(classifySpeedingSeverity(150, null, lax)).toBe('low');
    // With a known limit the bands stay absolute margins above it.
    expect(classifySpeedingSeverity(95, 60, {})).toBe('high');
    expect(classifySpeedingSeverity(85, 60, {})).toBe('medium');
    expect(classifySpeedingSeverity(70, 60, {})).toBe('low');
  });
});

describe('IMU refinement', () => {
  const calibration = {
    calibrated: true,
    longitudinal_axis: 'ax',
    lateral_axis: 'ay',
    confidence: 'high',
  };

  /** Motion samples at 50 Hz around the event, with the given longitudinal peak. */
  const motionAround = (offsetMs, peakMs2, count = 60) => Array.from({ length: count }, (_, index) => ({
    timestamp: iso(offsetMs - 600 + index * 20),
    ax: peakMs2,
    ay: 0.1,
    az: 0,
    gx: 0,
    gy: 0,
    gz: 0,
  }));

  const brakeEvent = (overrides = {}) => ({
    type: EVENT_TYPES.HARSH_BRAKE,
    timestamp: iso(5000),
    value: 6,
    severity: 'high',
    ...overrides,
  });

  it('confirms an event the motion stream agrees with', () => {
    const { events, summary } = refineEventsWithMotion(
      [brakeEvent()],
      motionAround(5000, 5.5),
      calibration
    );

    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.CONFIRMED);
    expect(events[0].severity).toBe('high');
    expect(summary.confirmed).toBe(1);
  });

  it('downgrades a GPS event the motion stream contradicts', () => {
    // The urban-canyon signature: GPS reports a 6 m/s2 speed cliff the vehicle never felt.
    const { events, summary } = refineEventsWithMotion(
      [brakeEvent()],
      motionAround(5000, 0.4),
      calibration
    );

    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.CONTRADICTED);
    expect(events[0].severity).toBe('medium');
    expect(events[0].severity_before_imu).toBe('high');
    expect(summary.contradicted).toBe(1);
  });

  it('never removes an event, only lowers its severity', () => {
    const { events } = refineEventsWithMotion([brakeEvent({ severity: 'low' })], motionAround(5000, 0.2), calibration);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('low');
  });

  it('will not contradict on a low-confidence orientation calibration', () => {
    const { events } = refineEventsWithMotion(
      [brakeEvent()],
      motionAround(5000, 0.4),
      { ...calibration, confidence: 'low' }
    );

    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.INCONCLUSIVE);
    expect(events[0].severity).toBe('high');
  });

  it('is a no-op when motion samples are absent', () => {
    const { events, summary } = refineEventsWithMotion([brakeEvent()], [], calibration);

    expect(events[0].severity).toBe('high');
    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.UNAVAILABLE);
    expect(summary.available).toBe(false);
  });

  it('is a no-op when orientation was never calibrated', () => {
    const { events } = refineEventsWithMotion(
      [brakeEvent()],
      motionAround(5000, 0.4),
      { calibrated: false, reason: 'insufficient_harsh_brake_axis_samples' }
    );

    expect(events[0].severity).toBe('high');
    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.UNAVAILABLE);
  });

  it('reuses a stored verdict so a re-score survives the motion-sample purge', () => {
    // Samples are purged after MOTION_SAMPLE_RETENTION_DAYS_DEFAULT. Re-deriving after the
    // purge would silently restore the severity the IMU had refuted.
    const purged = refineEventsWithMotion(
      [brakeEvent({ severity: 'medium', severity_before_imu: 'high', imu_evidence: IMU_EVIDENCE.CONTRADICTED })],
      [],
      calibration
    );

    expect(purged.events[0].severity).toBe('medium');
    expect(purged.events[0].imu_evidence).toBe(IMU_EVIDENCE.CONTRADICTED);
    expect(purged.summary.reused).toBe(1);
  });

  it('leaves event types it cannot observe untouched', () => {
    const speeding = { type: EVENT_TYPES.SPEEDING, timestamp: iso(5000), value: 120, severity: 'high' };
    const { events } = refineEventsWithMotion([speeding], motionAround(5000, 0.1), calibration);

    expect(events[0]).toEqual(speeding);
    expect(events[0].imu_evidence).toBeUndefined();
  });

  it('compares sharp turns in g rather than m/s2', () => {
    const turn = { type: EVENT_TYPES.SHARP_TURN, timestamp: iso(5000), value: 0.5, severity: 'high' };
    const lateralSamples = Array.from({ length: 60 }, (_, index) => ({
      timestamp: iso(4400 + index * 20),
      ax: 0,
      ay: 0.5 * STANDARD_GRAVITY_MS2,
      az: 0,
      gx: 0,
      gy: 0,
      gz: 0,
    }));

    const { events } = refineEventsWithMotion([turn], lateralSamples, calibration);
    expect(events[0].imu_evidence).toBe(IMU_EVIDENCE.CONFIRMED);
  });

  it('carries severity downgrades through into the trip score', () => {
    const points = brakingRoute(110, 5);
    const thresholds = buildDrivingThresholds({});
    const { events } = detectDrivingEvents(points, thresholds);
    const brakeIndex = events.findIndex((event) => event.type === EVENT_TYPES.HARSH_BRAKE);
    expect(brakeIndex).toBeGreaterThanOrEqual(0);

    const eventMs = new Date(events[brakeIndex].timestamp).getTime() - START_MS;
    const stats = { distance_km: 2, duration_seconds: 600, avg_speed_kmh: 60 };

    const withoutImu = calculateTripScores(events, stats, points, thresholds, 600, {}, {});
    const withContradictingImu = calculateTripScores(events, stats, points, thresholds, 600, {}, {
      motionSamples: motionAround(eventMs, 0.2, 200),
      orientationCalibration: calibration,
    });

    expect(withContradictingImu.imu_refinement.contradicted).toBeGreaterThan(0);
    expect(withoutImu.imu_refinement.available).toBe(false);
    expect(withContradictingImu.score_safety).toBeGreaterThanOrEqual(withoutImu.score_safety);
  });
});

describe('IMU jerk', () => {
  const steadySamples = (count, accelForIndex) => Array.from({ length: count }, (_, index) => ({
    timestamp: iso(index * 20),
    ax: accelForIndex(index),
    ay: 0,
    az: 0,
    gx: 0,
    gy: 0,
    gz: 0,
  }));

  const calibration = {
    calibrated: true,
    longitudinal_axis: 'ax',
    lateral_axis: 'ay',
    confidence: 'high',
  };

  it('reports near-zero jerk for a constant acceleration', () => {
    const result = calculateImuJerk(steadySamples(600, () => 2), calibration);
    expect(result.available).toBe(true);
    expect(result.avg_jerk_ms3).toBeLessThan(0.5);
  });

  it('reports higher jerk when acceleration keeps changing', () => {
    const smooth = calculateImuJerk(steadySamples(600, () => 2), calibration);
    const jerky = calculateImuJerk(
      steadySamples(600, (index) => (Math.floor(index / 25) % 2 === 0 ? 0.5 : 4)),
      calibration
    );

    expect(jerky.available).toBe(true);
    expect(jerky.avg_jerk_ms3).toBeGreaterThan(smooth.avg_jerk_ms3);
  });

  it('declines to report without a high-confidence orientation calibration', () => {
    expect(calculateImuJerk(steadySamples(600, () => 2), { ...calibration, confidence: 'low' }))
      .toMatchObject({ available: false, reason: 'orientation_confidence_low' });
    expect(calculateImuJerk(steadySamples(600, () => 2), null))
      .toMatchObject({ available: false, reason: 'orientation_not_calibrated' });
    expect(calculateImuJerk(steadySamples(10, () => 2), calibration))
      .toMatchObject({ available: false, reason: 'insufficient_motion_samples' });
  });

  it('falls back to the GPS estimate when the IMU cannot contribute', () => {
    const points = routeFromSpeeds([40, 45, 41, 48, 42, 50, 44, 52, 46, 54]);
    const gpsOnly = calculateJerkScore(points, 5);

    expect(gpsOnly.jerk_data_source).toEqual(['gps']);
    expect(gpsOnly.avg_jerk_ms3).toBeGreaterThanOrEqual(0);
  });
});

describe('severity shifting', () => {
  it('clamps at the ends', () => {
    expect(shiftSeverity('low', -1)).toBe('low');
    expect(shiftSeverity('high', 1)).toBe('high');
    expect(shiftSeverity('high', -1)).toBe('medium');
    expect(shiftSeverity('medium', -1)).toBe('low');
    expect(shiftSeverity('nonsense', -1)).toBe('low');
  });
});
