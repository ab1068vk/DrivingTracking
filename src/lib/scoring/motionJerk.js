import { scoringValue } from '@/lib/scoringConstants';
import { normalizeMotionSample } from '@/lib/sensorFusionModel';

/**
 * Jerk (rate of change of acceleration) derived from the IMU stream.
 *
 * The GPS-derived estimate differentiates 1 Hz speed twice, so it measures GPS noise about
 * as much as it measures driving. At ~50 Hz the accelerometer can do genuinely better — but
 * only after filtering: differentiating a raw accelerometer measures suspension travel,
 * road texture and phone rattle, and would report an impossibly harsh driver on a rough road.
 *
 * So the signal is low-pass filtered with a moving average and then differentiated over a
 * step long enough to be a vehicle motion rather than a chassis response. The result is
 * only preferred over the GPS estimate on a high-confidence orientation calibration with a
 * substantial sample stream; otherwise the caller keeps the GPS value.
 */

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

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Moving average of the longitudinal axis, emitted on a fixed time step.
 * Returns points as [timeMs, smoothedMs2], with a break inserted wherever the raw stream
 * has a gap longer than maxGapMs so the derivative never spans a sensor dropout.
 */
function smoothedAccelerationSeries(samples, axis, config) {
  const series = [];
  let windowStart = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < samples.length; i++) {
    const value = finiteOrNull(samples[i][axis]);
    if (value == null) continue;
    sum += Math.abs(value);
    count += 1;
    while (samples[i]._ms - samples[windowStart]._ms > config.smoothingWindowMs) {
      const dropped = finiteOrNull(samples[windowStart][axis]);
      if (dropped != null) {
        sum -= Math.abs(dropped);
        count -= 1;
      }
      windowStart += 1;
    }
    if (count <= 0) continue;
    const previousGap = i > 0 ? samples[i]._ms - samples[i - 1]._ms : 0;
    series.push({
      ms: samples[i]._ms,
      value: sum / count,
      brokenBefore: previousGap > config.maxGapMs,
    });
  }
  return series;
}

/**
 * @param {Array<object>} motionSamples Raw or normalized IMU samples.
 * @param {object|null} orientationCalibration Result of calibratePhoneOrientation.
 * @returns {{available: boolean, avg_jerk_ms3: number|null, sample_count: number,
 *   reason: string|null}}
 */
export function calculateImuJerk(motionSamples = [], orientationCalibration = null) {
  const unavailable = (reason) => ({
    available: false,
    avg_jerk_ms3: null,
    sample_count: 0,
    reason,
  });

  const calibration = orientationCalibration || {};
  const axis = calibration.longitudinal_axis;
  if (calibration.calibrated !== true || !axis) return unavailable('orientation_not_calibrated');
  // A low-confidence calibration may have picked the wrong axis entirely, in which case
  // this measures lateral motion and calls cornering "harsh acceleration".
  if (calibration.confidence !== 'high') return unavailable('orientation_confidence_low');

  const config = {
    smoothingWindowMs: Number(scoringValue('IMU_JERK_SMOOTHING_WINDOW_MS')) || 200,
    stepMs: Number(scoringValue('IMU_JERK_STEP_MS')) || 200,
    maxGapMs: Number(scoringValue('IMU_JERK_MAX_GAP_MS')) || 300,
    minSamples: Number(scoringValue('IMU_JERK_MIN_SAMPLES')) || 200,
  };

  const samples = (Array.isArray(motionSamples) ? motionSamples : [])
    .map((sample) => {
      const normalized = normalizeMotionSample(sample);
      const ms = timestampMs(normalized.timestamp);
      return ms == null || !normalized.has_axes ? null : { ...normalized, _ms: ms };
    })
    .filter(Boolean)
    .sort((left, right) => left._ms - right._ms);

  if (samples.length < config.minSamples) return unavailable('insufficient_motion_samples');

  const series = smoothedAccelerationSeries(samples, axis, config);
  let jerkAbsTotal = 0;
  let jerkCount = 0;
  let anchor = 0;

  for (let i = 1; i < series.length; i++) {
    if (series[i].brokenBefore) {
      anchor = i;
      continue;
    }
    const dtMs = series[i].ms - series[anchor].ms;
    if (dtMs < config.stepMs) continue;
    const jerk = Math.abs(series[i].value - series[anchor].value) / (dtMs / 1000);
    anchor = i;
    if (!Number.isFinite(jerk)) continue;
    jerkAbsTotal += jerk;
    jerkCount += 1;
  }

  if (jerkCount === 0) return unavailable('no_usable_intervals');

  return {
    available: true,
    avg_jerk_ms3: round2(jerkAbsTotal / jerkCount),
    sample_count: samples.length,
    reason: null,
  };
}
