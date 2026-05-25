import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { clamp } from '@/lib/mathUtils';
import { calculateAcceleration, calculateSegmentMetrics } from '@/lib/tripEngine';
import { scoringValue } from '@/lib/scoringConstants';

export const CALIBRATION_PROFILE_KEY = 'drivesense_calibration_profile';

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const DEFAULT_THRESHOLDS = {
  threshold_harsh_brake_ms2: scoringValue('CALIBRATION_FALLBACK_HARSH_BRAKE_MS2'),
  threshold_rapid_accel_ms2: scoringValue('CALIBRATION_FALLBACK_RAPID_ACCEL_MS2'),
  threshold_sharp_turn_g_low: scoringValue('CALIBRATION_FALLBACK_SHARP_TURN_G_LOW'),
  threshold_sharp_turn_g_medium: scoringValue('SHARP_TURN_G_MEDIUM'),
  threshold_sharp_turn_g_high: scoringValue('SHARP_TURN_G_HIGH'),
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

const currentValue = (thresholds, lowerKey, upperKey) => {
  const localValue = Number(thresholds?.[lowerKey]);
  if (Number.isFinite(localValue) && localValue > 0) return localValue;
  const legacyValue = Number(thresholds?.[upperKey]);
  if (Number.isFinite(legacyValue) && legacyValue > 0) return legacyValue;
  return DEFAULT_THRESHOLDS[lowerKey] || 0;
};

const roundThreshold = (key, value) => (
  key.includes('_g_') ? round2(value) : round1(value)
);

const feedbackThresholdMap = {
  harsh_brake: { key: 'threshold_harsh_brake_ms2', margin: 0.3, min: 3.0, max: 7.0 },
  rapid_acceleration: { key: 'threshold_rapid_accel_ms2', margin: 0.3, min: 2.0, max: 6.0 },
  sharp_turn: { key: 'threshold_sharp_turn_g_medium', margin: 0.05, min: 0.25, max: 0.70 },
};

const summarizeEventFeedback = (trips = []) => {
  const byType = {};
  for (const trip of trips) {
    for (const item of Object.values(trip?.event_feedback || {})) {
      const type = item?.type;
      const config = feedbackThresholdMap[type];
      if (!config) continue;
      byType[type] ??= { accurate: 0, wrong: 0, wrongValues: [], accurateValues: [] };
      if (item.verdict === 'wrong') {
        byType[type].wrong += 1;
        if (Number.isFinite(Number(item.value))) byType[type].wrongValues.push(Math.abs(Number(item.value)));
      }
      if (item.verdict === 'accurate') {
        byType[type].accurate += 1;
        if (Number.isFinite(Number(item.value))) byType[type].accurateValues.push(Math.abs(Number(item.value)));
      }
    }
  }
  const total = Object.values(byType).reduce((sum, item) => sum + item.accurate + item.wrong, 0);
  return { total, byType };
};

export function computeCalibrationProfile(trips = [], /** @type {any} */ currentThresholds = {}) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const tripsAnalyzed = completed.length;
  const kmAnalyzedRaw = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const feedbackSummary = summarizeEventFeedback(completed);

  if (tripsAnalyzed < 15 && kmAnalyzedRaw < 200 && feedbackSummary.total < 3) {
    return {
      insufficient: true,
      tripsNeeded: Math.max(0, 15 - tripsAnalyzed),
      kmNeeded: Math.max(0, Math.ceil(200 - kmAnalyzedRaw)),
      feedbackSummary,
    };
  }

  const accelValues = [];
  const decelValues = [];
  const lateralGValues = [];

  for (const trip of completed) {
    const points = Array.isArray(trip.route_points) ? trip.route_points : [];
    for (let i = 1; i < points.length; i++) {
      const segment = calculateSegmentMetrics(points[i - 1], points[i], currentThresholds);
      if (segment.dt <= 0 || segment.dt > 60 || segment.isNoise) continue;
      const previousSpeed = Number(points[i - 1]?.speed_kmh);
      const baselineSpeed = Number.isFinite(previousSpeed) ? previousSpeed : segment.reliableSpeedKmh;
      const accel = calculateAcceleration(baselineSpeed, segment.reliableSpeedKmh, segment.dt);
      if (!Number.isFinite(accel) || Math.max(baselineSpeed, segment.reliableSpeedKmh) <= 15) continue;
      if (accel > 0) accelValues.push(accel);
      if (accel < 0) decelValues.push(Math.abs(accel));
    }

    for (const event of trip.driving_events || []) {
      const lateralG = Number(event.value);
      if (event.type === 'sharp_turn' && Number.isFinite(lateralG)) lateralGValues.push(Math.abs(lateralG));
    }
  }

  const suggested = {
    threshold_harsh_brake_ms2: round1(clamp(percentile(decelValues, 0.90) ?? currentValue(currentThresholds, 'threshold_harsh_brake_ms2', 'HARSH_BRAKE_MS2'), 3.0, 7.0)),
    threshold_rapid_accel_ms2: round1(clamp(percentile(accelValues, 0.88) ?? currentValue(currentThresholds, 'threshold_rapid_accel_ms2', 'RAPID_ACCEL_MS2'), 2.0, 6.0)),
    threshold_sharp_turn_g_low: null,
    threshold_sharp_turn_g_medium: null,
    threshold_sharp_turn_g_high: null,
  };

  if (lateralGValues.length >= 20) {
    suggested.threshold_sharp_turn_g_low = round2(clamp(percentile(lateralGValues, 0.70), 0.20, 0.50));
    suggested.threshold_sharp_turn_g_medium = round2(clamp(percentile(lateralGValues, 0.85), 0.25, 0.70));
    suggested.threshold_sharp_turn_g_high = round2(clamp(percentile(lateralGValues, 0.95), 0.35, 0.90));
  }

  const current = {
    threshold_harsh_brake_ms2: currentValue(currentThresholds, 'threshold_harsh_brake_ms2', 'HARSH_BRAKE_MS2'),
    threshold_rapid_accel_ms2: currentValue(currentThresholds, 'threshold_rapid_accel_ms2', 'RAPID_ACCEL_MS2'),
    threshold_sharp_turn_g_low: currentValue(currentThresholds, 'threshold_sharp_turn_g_low', 'SHARP_TURN_G_LOW'),
    threshold_sharp_turn_g_medium: currentValue(currentThresholds, 'threshold_sharp_turn_g_medium', 'SHARP_TURN_G_MEDIUM'),
    threshold_sharp_turn_g_high: currentValue(currentThresholds, 'threshold_sharp_turn_g_high', 'SHARP_TURN_G_HIGH'),
  };

  for (const [type, feedback] of Object.entries(feedbackSummary.byType)) {
    const config = feedbackThresholdMap[type];
    if (!config || feedback.wrong < 2 || feedback.wrongValues.length === 0) continue;
    const wrongTarget = (percentile(feedback.wrongValues, 0.75) || current[config.key]) + config.margin;
    const accurateCeiling = feedback.accurateValues.length >= 3
      ? (percentile(feedback.accurateValues, 0.95) || wrongTarget) + config.margin
      : wrongTarget;
    const feedbackTarget = roundThreshold(config.key, clamp(Math.min(wrongTarget, accurateCeiling), config.min, config.max));
    suggested[config.key] = Math.max(Number(suggested[config.key] || current[config.key]), feedbackTarget);
  }

  const delta = Object.fromEntries(Object.entries(suggested).map(([key, value]) => [
    key,
    value == null ? null : roundThreshold(key, value - current[key]),
  ]));
  const kmAnalyzed = Math.round(kmAnalyzedRaw * 10) / 10;
  const confidence = tripsAnalyzed >= 40 && kmAnalyzed >= 500
    ? 'high'
    : tripsAnalyzed >= 20 && kmAnalyzed >= 250
      ? 'medium'
      : feedbackSummary.total >= 6
        ? 'medium'
        : 'low';

  return {
    insufficient: false,
    confidence,
    tripsAnalyzed,
    kmAnalyzed,
    eventsAnalyzed: accelValues.length + decelValues.length + lateralGValues.length,
    suggested,
    current,
    delta,
    feedbackSummary,
    appliedAt: null,
  };
}

export async function applyCalibrationProfile(profile, currentSettings = {}, saveSettings) {
  const suggested = Object.fromEntries(
    Object.entries(profile?.suggested || {}).filter(([, value]) => value != null)
  );
  const newSettings = {
    ...currentSettings,
    ...suggested,
    calibration_profile_key: CALIBRATION_PROFILE_KEY,
  };
  const appliedProfile = { ...profile, appliedAt: new Date().toISOString() };
  await saveCalibrationProfile(appliedProfile);
  if (typeof saveSettings === 'function') await saveSettings(newSettings);
  return newSettings;
}

export async function saveCalibrationProfile(profile) {
  await setJson(CALIBRATION_PROFILE_KEY, profile);
}

export async function loadCalibrationProfile() {
  return getJson(CALIBRATION_PROFILE_KEY, null);
}

export async function clearCalibrationProfile() {
  await removeJson(CALIBRATION_PROFILE_KEY);
}
