// Laplace mechanism: adds noise ~ Laplace(0, sensitivity / epsilon).
// Lower epsilon means more privacy and more noise.

export const PRIVACY_BUDGETS = Object.freeze({
  distance_km: { sensitivity: 0.3, epsilon: 0.8 },
  event_count: { sensitivity: 1, epsilon: 0.8 },
  avg_speed_kmh: { sensitivity: 3, epsilon: 1 },
  idle_seconds: { sensitivity: 45, epsilon: 0.6 },
  phone_use_count: { sensitivity: 1, epsilon: 0.8 },
});

const DISTANCE_FIELDS = Object.freeze([
  'distance_km',
  'estimated_private_distance_km',
]);

const SPEED_FIELDS = Object.freeze([
  'avg_speed_kmh',
  'avg_running_speed_kmh',
]);

const IDLE_FIELDS = Object.freeze([
  'idle_time_seconds',
  'traffic_idle_seconds',
  'sustained_idle_seconds',
]);

const EVENT_COUNT_FIELDS = Object.freeze([
  'harsh_brakes_count',
  'rapid_accel_count',
  'sharp_turns_count',
  'speeding_events_count',
  'heading_deviation_count',
  'heading_deviation_legacy_count',
  'stop_start_pattern_count',
  'stop_start_pattern_sample_count',
  'stop_start_pattern_highway_count',
  'stop_start_pattern_urban_count',
  'distraction_events_count',
  'close_proximity_count',
  'overtake_event_count',
  'overtake_count',
  'unsafe_reentry_count',
  'speed_creep_event_count',
  'lane_change_count',
  'unsafe_lane_changes',
  'native_phone_usage_event_count',
]);

const PHONE_COUNT_FIELDS = Object.freeze([
  'phone_use_window_count',
  'phone_use_high_confidence_count',
  'phone_proxy_count',
]);

export function laplace(sensitivity, epsilon) {
  const safeSensitivity = Math.max(0, Number(sensitivity) || 0);
  const safeEpsilon = Number(epsilon);
  if (!Number.isFinite(safeEpsilon) || safeEpsilon <= 0 || safeSensitivity === 0) return 0;

  const u = Math.random() - 0.5;
  return -(safeSensitivity / safeEpsilon) * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

export function noisyStat(value, metricName) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return value;

  const budget = PRIVACY_BUDGETS[metricName];
  if (!budget) return value;

  return Math.max(0, numericValue + laplace(budget.sensitivity, budget.epsilon));
}

function finiteMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundedNoisyMetric(value, metricName, digits = 0) {
  const noisy = noisyStat(value, metricName);
  const numeric = finiteMetric(noisy);
  if (numeric == null) return value;
  const factor = 10 ** digits;
  return Math.max(0, Math.round(numeric * factor) / factor);
}

function noisyCount(value, metricName = 'event_count') {
  const numeric = finiteMetric(value);
  if (numeric == null) return value;
  return Math.max(0, Math.round(noisyStat(numeric, metricName)));
}

export function applyDifferentialPrivacyToAggregates(value = {}) {
  if (!value || typeof value !== 'object' || /** @type {Record<string, any>} */ (value)._dpApplied === true) return value;

  const privatized = /** @type {Record<string, any>} */ ({ ...value });
  const noisedFields = [];
  const applyField = (field, metricName, digits = 0, count = false) => {
    if (!(field in privatized) || finiteMetric(privatized[field]) == null) return;
    privatized[field] = count
      ? noisyCount(privatized[field], metricName)
      : roundedNoisyMetric(privatized[field], metricName, digits);
    noisedFields.push(field);
  };

  DISTANCE_FIELDS.forEach((field) => applyField(field, 'distance_km', 3));
  SPEED_FIELDS.forEach((field) => applyField(field, 'avg_speed_kmh', 1));
  IDLE_FIELDS.forEach((field) => applyField(field, 'idle_seconds', 0));
  EVENT_COUNT_FIELDS.forEach((field) => applyField(field, 'event_count', 0, true));
  PHONE_COUNT_FIELDS.forEach((field) => applyField(field, 'phone_use_count', 0, true));

  if (finiteMetric(privatized.estimated_private_distance_km) != null && finiteMetric(privatized.distance_km) != null) {
    privatized.estimated_private_distance_km = Math.min(
      privatized.estimated_private_distance_km,
      privatized.distance_km
    );
  }

  return {
    ...privatized,
    _dpApplied: true,
    differential_privacy: {
      mechanism: 'laplace',
      applied: true,
      scope: 'export',
      noised_fields: noisedFields,
    },
  };
}
