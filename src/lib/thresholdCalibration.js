import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { calculateAcceleration, calculateSegmentMetrics } from '@/lib/tripEngine';

export const CALIBRATION_PROFILE_KEY = 'drivesense_calibration_profile';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

const currentValue = (thresholds, lowerKey, upperKey) => (
  Number(thresholds?.[lowerKey]) || Number(thresholds?.[upperKey]) || 0
);

export function computeCalibrationProfile(trips = [], /** @type {any} */ currentThresholds = {}) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const tripsAnalyzed = completed.length;
  const kmAnalyzedRaw = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);

  if (tripsAnalyzed < 15 || kmAnalyzedRaw < 200) {
    return {
      insufficient: true,
      tripsNeeded: Math.max(0, 15 - tripsAnalyzed),
      kmNeeded: Math.max(0, Math.ceil(200 - kmAnalyzedRaw)),
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
    suggested.threshold_sharp_turn_g_low = round1(clamp(percentile(lateralGValues, 0.70), 0.20, 0.50));
    suggested.threshold_sharp_turn_g_medium = round1(clamp(percentile(lateralGValues, 0.85), 0.25, 0.70));
    suggested.threshold_sharp_turn_g_high = round1(clamp(percentile(lateralGValues, 0.95), 0.35, 0.90));
  }

  const current = {
    threshold_harsh_brake_ms2: currentValue(currentThresholds, 'threshold_harsh_brake_ms2', 'HARSH_BRAKE_MS2'),
    threshold_rapid_accel_ms2: currentValue(currentThresholds, 'threshold_rapid_accel_ms2', 'RAPID_ACCEL_MS2'),
    threshold_sharp_turn_g_low: currentValue(currentThresholds, 'threshold_sharp_turn_g_low', 'SHARP_TURN_G_LOW'),
    threshold_sharp_turn_g_medium: currentValue(currentThresholds, 'threshold_sharp_turn_g_medium', 'SHARP_TURN_G_MEDIUM'),
    threshold_sharp_turn_g_high: currentValue(currentThresholds, 'threshold_sharp_turn_g_high', 'SHARP_TURN_G_HIGH'),
  };

  const delta = Object.fromEntries(Object.entries(suggested).map(([key, value]) => [
    key,
    value == null ? null : round1(value - current[key]),
  ]));
  const kmAnalyzed = Math.round(kmAnalyzedRaw * 10) / 10;
  const confidence = tripsAnalyzed >= 40 && kmAnalyzed >= 500
    ? 'high'
    : tripsAnalyzed >= 20 && kmAnalyzed >= 250
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
