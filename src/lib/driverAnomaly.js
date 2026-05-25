import { clamp } from '@/lib/mathUtils';

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const std = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length);
};
const finiteMetric = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export function tripFeatureVector(trip = {}) {
  const distance = Math.max(1, Number(trip.distance_km) || 1);
  const vector = {
    harsh_per_10km: ((Number(trip.harsh_brakes_count) || 0) / distance) * 10,
    accel_per_10km: ((Number(trip.rapid_accel_count) || 0) / distance) * 10,
    turn_per_10km: ((Number(trip.sharp_turns_count) || 0) / distance) * 10,
    speed_per_10km: ((Number(trip.speeding_events_count) || 0) / distance) * 10,
    phone_pct: Number(trip.phone_use_pct_of_trip) || 0,
  };
  const score = finiteMetric(trip.score_overall);
  const avgSpeed = finiteMetric(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh);
  const smoothness = finiteMetric(trip.score_smoothness);
  if (score != null) vector.score = score;
  if (avgSpeed != null) vector.avg_speed = avgSpeed;
  if (smoothness != null) vector.smoothness = smoothness;
  return vector;
}

export function buildOnDeviceDriverModel(trips = []) {
  const completed = (trips || []).filter((trip) => trip.status === 'completed').slice(0, 60);
  if (completed.length < 8) return null;
  const rows = completed.map(tripFeatureVector);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return {
    provider: 'local_rules',
    trip_count: completed.length,
    features: Object.fromEntries(keys.map((key) => {
      const values = rows.map((row) => row[key]).filter(Number.isFinite);
      if (!values.length) return null;
      return [key, { mean: mean(values), std: Math.max(std(values), 1) }];
    }).filter(Boolean)),
  };
}

export function scoreTripAnomaly(trip = {}, model = null) {
  if (!model?.features) {
    return { anomaly_score: 0, anomaly_level: 'unknown', reasons: [] };
  }
  const vector = tripFeatureVector(trip);
  const zScores = Object.entries(vector).map(([key, value]) => {
    const baseline = model.features[key];
    if (!baseline) return null;
    const z = baseline.std > 0 ? Math.abs((value - baseline.mean) / baseline.std) : 0;
    return { key, z, value, mean: baseline.mean };
  }).filter(Boolean);
  if (!zScores.length) {
    return { anomaly_score: 0, anomaly_level: 'unknown', reasons: [], model_trip_count: model.trip_count };
  }
  const score = clamp(Math.round(mean(zScores.map((item) => Math.min(item.z, 5))) * 20), 0, 100);
  const reasons = zScores
    .filter((item) => item.z >= 1.8)
    .sort((a, b) => b.z - a.z)
    .slice(0, 3)
    .map((item) => item.key);
  return {
    anomaly_score: score,
    anomaly_level: score >= 75 ? 'high' : score >= 55 ? 'moderate' : 'normal',
    reasons,
    model_trip_count: model.trip_count,
  };
}
