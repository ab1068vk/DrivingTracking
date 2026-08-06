import { scoringValue } from '@/lib/scoringConstants';
import { STANDARD_GRAVITY_MS2 } from '@/lib/mathUtils';
import { normalizeMotionSample } from '@/lib/sensorFusionModel';
import { shiftSeverity } from '@/lib/scoring/eventSeverity';

/**
 * Confirm or refute GPS-derived driving events against the recorded IMU stream.
 *
 * This is a refinement pass, not a second detector. Two hard rules:
 *
 *  1. It never creates an event. `calibratePhoneOrientation` recovers which device axis is
 *     longitudinal but not its sign or a full rotation matrix, and a phone being picked up
 *     produces accelerations indistinguishable from braking. GPS triggers; the IMU only
 *     agrees, disagrees, or abstains.
 *  2. The outcome is persisted on the event. Motion samples are purged at
 *     MOTION_SAMPLE_RETENTION_DAYS_DEFAULT (14 days); without persistence a re-score after
 *     the purge would silently move the score back. An event that already carries
 *     `imu_evidence` is left exactly as it is.
 *
 * A refutation downgrades one severity band rather than dropping the event: the GPS
 * evidence still exists, it is just no longer corroborated. This is the direct fix for
 * urban-canyon and tunnel-exit false positives, where GPS reports a speed cliff the
 * vehicle never experienced.
 */

export const IMU_EVIDENCE = Object.freeze({
  CONFIRMED: 'confirmed',
  CONTRADICTED: 'contradicted',
  INCONCLUSIVE: 'inconclusive',
  UNAVAILABLE: 'unavailable',
});

/** Event types with a magnitude the IMU can independently observe. */
const REFINABLE_LONGITUDINAL = Object.freeze(['harsh_brake', 'rapid_acceleration']);
const REFINABLE_LATERAL = Object.freeze(['sharp_turn']);

const finiteOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const timestampMs = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const peakAbsOnAxis = (samples, axis) => samples.reduce((peak, sample) => {
  const value = finiteOrNull(sample?.[axis]);
  return value == null ? peak : Math.max(peak, Math.abs(value));
}, 0);

/**
 * Normalize once and keep only samples that carry usable axes, sorted by time.
 * @param {Array<object>} motionSamples
 * @returns {Array<object & {_ms: number}>}
 */
function prepareSamples(motionSamples) {
  return (Array.isArray(motionSamples) ? motionSamples : [])
    .map((sample) => {
      const normalized = normalizeMotionSample(sample);
      const ms = timestampMs(normalized.timestamp);
      return ms == null || !normalized.has_axes ? null : { ...normalized, _ms: ms };
    })
    .filter(Boolean)
    .sort((left, right) => left._ms - right._ms);
}

/**
 * @param {Array<object & {_ms: number}>} samples Sorted, prepared samples.
 * @param {number} centerMs
 * @param {number} halfWidthMs
 */
function samplesInWindow(samples, centerMs, halfWidthMs) {
  return samples.filter((sample) => Math.abs(sample._ms - centerMs) <= halfWidthMs);
}

/**
 * Compare one event against its motion window.
 * @returns {{evidence: string, ratio: number|null, imuPeak: number|null}}
 */
function assessEvent(event, samples, calibration, config) {
  const eventMs = timestampMs(event?.timestamp);
  const gpsMagnitude = Math.abs(finiteOrNull(event?.value) ?? 0);
  if (eventMs == null || gpsMagnitude <= 0) {
    return { evidence: IMU_EVIDENCE.UNAVAILABLE, ratio: null, imuPeak: null };
  }

  const window = samplesInWindow(samples, eventMs, config.windowSeconds * 1000);
  if (window.length < config.minSamples) {
    return { evidence: IMU_EVIDENCE.UNAVAILABLE, ratio: null, imuPeak: null };
  }

  const isLateral = REFINABLE_LATERAL.includes(event.type);
  const axis = isLateral ? calibration.lateral_axis : calibration.longitudinal_axis;
  const peakMs2 = peakAbsOnAxis(window, axis);
  // sharp_turn carries lateral g; the longitudinal events carry m/s2.
  const imuPeak = isLateral ? peakMs2 / STANDARD_GRAVITY_MS2 : peakMs2;
  const ratio = imuPeak / gpsMagnitude;

  if (ratio >= config.confirmRatio) {
    return { evidence: IMU_EVIDENCE.CONFIRMED, ratio, imuPeak };
  }
  // Only a well-calibrated device may contradict GPS. On a low-confidence calibration a
  // small IMU peak is at least as likely to mean the axis is wrong as that the event is.
  if (ratio <= config.refuteRatio && calibration.confidence === 'high') {
    return { evidence: IMU_EVIDENCE.CONTRADICTED, ratio, imuPeak };
  }
  return { evidence: IMU_EVIDENCE.INCONCLUSIVE, ratio, imuPeak };
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * @param {Array<object>} events Detected driving events.
 * @param {Array<object>} motionSamples Raw or normalized IMU samples for the trip.
 * @param {object|null} orientationCalibration Result of calibratePhoneOrientation.
 * @returns {{events: Array<object>, summary: {confirmed: number, contradicted: number,
 *   inconclusive: number, unavailable: number, reused: number, available: boolean}}}
 */
export function refineEventsWithMotion(events = [], motionSamples = [], orientationCalibration = null) {
  const eventList = Array.isArray(events) ? events : [];
  const summary = {
    confirmed: 0,
    contradicted: 0,
    inconclusive: 0,
    unavailable: 0,
    reused: 0,
    available: false,
  };

  const calibration = orientationCalibration || {};
  const usable = calibration.calibrated === true
    && Boolean(calibration.longitudinal_axis)
    && Boolean(calibration.lateral_axis);

  const config = {
    windowSeconds: Number(scoringValue('IMU_REFINEMENT_WINDOW_SECONDS')) || 1.5,
    minSamples: Number(scoringValue('IMU_REFINEMENT_MIN_SAMPLES')) || 5,
    confirmRatio: Number(scoringValue('IMU_CONFIRM_RATIO')) || 0.6,
    refuteRatio: Number(scoringValue('IMU_REFUTE_RATIO')) || 0.3,
  };

  const prepared = usable ? prepareSamples(motionSamples) : [];
  summary.available = prepared.length > 0;

  const refined = eventList.map((event) => {
    const refinable = REFINABLE_LONGITUDINAL.includes(event?.type) || REFINABLE_LATERAL.includes(event?.type);
    if (!refinable) return event;

    // Already assessed on a previous scoring run: keep it, so the score survives the
    // 14-day motion-sample purge unchanged.
    if (event.imu_evidence) {
      summary.reused += 1;
      return event;
    }

    if (!summary.available) {
      summary.unavailable += 1;
      return { ...event, imu_evidence: IMU_EVIDENCE.UNAVAILABLE };
    }

    const { evidence, ratio, imuPeak } = assessEvent(event, prepared, calibration, config);
    summary[evidence] += 1;

    if (evidence === IMU_EVIDENCE.UNAVAILABLE) {
      return { ...event, imu_evidence: evidence };
    }

    const next = {
      ...event,
      imu_evidence: evidence,
      imu_peak: round2(imuPeak),
      imu_gps_ratio: round2(ratio),
    };
    if (evidence === IMU_EVIDENCE.CONTRADICTED) {
      next.severity_before_imu = event.severity;
      next.severity = shiftSeverity(event.severity, -1);
    }
    return next;
  });

  return { events: refined, summary };
}
