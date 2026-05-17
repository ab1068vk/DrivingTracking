import { EVENT_TYPES } from '@/lib/tripEngine';

const MS2_PER_G = 9.80665;
const MAX_SAMPLE_AGE_MS = 2 * 60 * 60 * 1000;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round2 = (value) => Math.round(value * 100) / 100;

export function normalizeMotionSample(input = {}) {
  const acceleration = input.accelerationIncludingGravity || input.acceleration || input;
  const rotation = input.rotationRate || input.rotation || {};
  const ax = Number(acceleration.x ?? input.ax ?? 0);
  const ay = Number(acceleration.y ?? input.ay ?? 0);
  const az = Number(acceleration.z ?? input.az ?? 0);
  const alpha = Number(rotation.alpha ?? input.alpha ?? 0);
  const beta = Number(rotation.beta ?? input.beta ?? 0);
  const gamma = Number(rotation.gamma ?? input.gamma ?? 0);
  const timestamp = input.timestamp || new Date().toISOString();
  const magnitudeMs2 = Math.sqrt(ax * ax + ay * ay + az * az);
  const linearMagnitudeMs2 = Math.abs(magnitudeMs2 - MS2_PER_G);
  const rotationMagnitudeDegS = Math.sqrt(alpha * alpha + beta * beta + gamma * gamma);

  return {
    timestamp,
    ax: Number.isFinite(ax) ? ax : 0,
    ay: Number.isFinite(ay) ? ay : 0,
    az: Number.isFinite(az) ? az : 0,
    alpha: Number.isFinite(alpha) ? alpha : 0,
    beta: Number.isFinite(beta) ? beta : 0,
    gamma: Number.isFinite(gamma) ? gamma : 0,
    magnitude_ms2: round2(magnitudeMs2),
    linear_magnitude_ms2: round2(linearMagnitudeMs2),
    rotation_magnitude_deg_s: round2(rotationMagnitudeDegS),
  };
}

export function buildSensorFusionSummary(samples = [], routePoints = [], activity = null) {
  const cutoff = Date.now() - MAX_SAMPLE_AGE_MS;
  const valid = (samples || [])
    .map(normalizeMotionSample)
    .filter((sample) => new Date(sample.timestamp).getTime() >= cutoff);
  if (!valid.length) {
    return {
      sample_count: 0,
      peak_linear_ms2: 0,
      peak_rotation_deg_s: 0,
      phone_movement_score: 0,
      harsh_motion_count: 0,
      impact_like_count: 0,
      activity_type: activity?.type || 'unknown',
      activity_confidence: activity?.confidence || 0,
      quality: 'unavailable',
    };
  }

  const linear = valid.map((sample) => sample.linear_magnitude_ms2);
  const rotation = valid.map((sample) => sample.rotation_magnitude_deg_s);
  const peakLinear = Math.max(...linear);
  const peakRotation = Math.max(...rotation);
  const harshMotionCount = valid.filter((sample) => sample.linear_magnitude_ms2 >= 5.5).length;
  const impactLikeCount = valid.filter((sample) => sample.linear_magnitude_ms2 >= 14 && sample.rotation_magnitude_deg_s >= 120).length;
  const phoneMovementScore = clamp(Math.round(
    avg(linear) * 5 +
    avg(rotation) * 0.08 +
    harshMotionCount * 2
  ), 0, 100);
  const routePointCount = Array.isArray(routePoints) ? routePoints.length : 0;

  return {
    sample_count: valid.length,
    peak_linear_ms2: round2(peakLinear),
    peak_rotation_deg_s: round2(peakRotation),
    phone_movement_score: phoneMovementScore,
    harsh_motion_count: harshMotionCount,
    impact_like_count: impactLikeCount,
    activity_type: activity?.type || 'unknown',
    activity_confidence: activity?.confidence || 0,
    quality: valid.length >= Math.min(120, Math.max(20, routePointCount * 2)) ? 'good' : 'partial',
  };
}

export function enrichEventsWithSensorContext(events = [], samples = []) {
  const normalized = (samples || []).map(normalizeMotionSample);
  if (!normalized.length) return events;
  return (events || []).map((event) => {
    const eventMs = new Date(event.timestamp || 0).getTime();
    if (!Number.isFinite(eventMs)) return event;
    const nearby = normalized.filter((sample) => Math.abs(new Date(sample.timestamp).getTime() - eventMs) <= 2500);
    if (!nearby.length) return event;
    const peakLinear = Math.max(...nearby.map((sample) => sample.linear_magnitude_ms2));
    const peakRotation = Math.max(...nearby.map((sample) => sample.rotation_magnitude_deg_s));
    const confirmed = (
      event.type === EVENT_TYPES.HARSH_BRAKE && peakLinear >= 4.5
    ) || (
      event.type === EVENT_TYPES.SHARP_TURN && peakRotation >= 80
    );
    return {
      ...event,
      sensor_peak_linear_ms2: round2(peakLinear),
      sensor_peak_rotation_deg_s: round2(peakRotation),
      sensor_confirmed: confirmed,
    };
  });
}

export function detectCrashIncident({ routePoints = [], motionSamples = [], activity = null, settings = {} } = {}) {
  const cfg = /** @type {any} */ (settings);
  if (cfg.crash_detection_enabled === false) return null;
  const points = routePoints || [];
  const samples = (motionSamples || []).map(normalizeMotionSample);
  if (points.length < 2 || samples.length < 3) return null;

  const recentPoints = points.slice(-8);
  const latestPoint = recentPoints[recentPoints.length - 1];
  const recentSpeeds = recentPoints.map((point) => Number(point.speed_kmh) || 0);
  const maxRecentSpeed = Math.max(...recentSpeeds);
  const stoppedSeconds = recentPoints
    .filter((point) => (Number(point.speed_kmh) || 0) < 3)
    .reduce((sum, point, index, list) => {
      if (index === 0) return sum;
      return sum + Math.max(0, (new Date(point.timestamp).getTime() - new Date(list[index - 1].timestamp).getTime()) / 1000);
    }, 0);
  const recentSamples = samples.filter((sample) => (
    Math.abs(new Date(sample.timestamp).getTime() - new Date(latestPoint.timestamp || Date.now()).getTime()) <= 12000
  ));
  const peakLinear = recentSamples.length ? Math.max(...recentSamples.map((sample) => sample.linear_magnitude_ms2)) : 0;
  const peakRotation = recentSamples.length ? Math.max(...recentSamples.map((sample) => sample.rotation_magnitude_deg_s)) : 0;
  const stillActivity = activity?.type === 'still' && (activity.confidence || 0) >= 60;
  const likelyIncident = maxRecentSpeed >= 20 && peakLinear >= 18 && peakRotation >= 90 && (stoppedSeconds >= 8 || stillActivity);
  if (!likelyIncident) return null;

  return {
    type: 'possible_crash',
    severity: peakLinear >= 28 ? 'high' : 'medium',
    lat: latestPoint.lat,
    lng: latestPoint.lng,
    timestamp: latestPoint.timestamp || new Date().toISOString(),
    speed_before_kmh: Math.round(maxRecentSpeed),
    peak_linear_ms2: round2(peakLinear),
    peak_rotation_deg_s: round2(peakRotation),
    stopped_seconds: Math.round(stoppedSeconds),
    activity_type: activity?.type || 'unknown',
    confidence: peakLinear >= 28 && stoppedSeconds >= 15 ? 0.9 : 0.72,
  };
}

export function createMotionSensorFusion({ maxSamples = 5000, onIncidentSample = null } = {}) {
  const samples = [];
  let listening = false;

  const onMotion = (event) => {
    const sample = normalizeMotionSample({
      accelerationIncludingGravity: event.accelerationIncludingGravity,
      acceleration: event.acceleration,
      rotationRate: event.rotationRate,
      timestamp: new Date().toISOString(),
    });
    samples.push(sample);
    if (samples.length > maxSamples) samples.shift();
    if (sample.linear_magnitude_ms2 >= 18) onIncidentSample?.(sample);
  };

  return {
    async start() {
      if (listening || typeof window === 'undefined') return false;
      const permissionApi = /** @type {any} */ (window.DeviceMotionEvent)?.requestPermission;
      if (typeof permissionApi === 'function') {
        const result = await permissionApi.call(window.DeviceMotionEvent).catch(() => 'denied');
        if (result !== 'granted') return false;
      }
      window.addEventListener('devicemotion', onMotion);
      listening = true;
      return true;
    },
    stop() {
      if (typeof window !== 'undefined') window.removeEventListener('devicemotion', onMotion);
      listening = false;
    },
    addSample(sample) {
      samples.push(normalizeMotionSample(sample));
      if (samples.length > maxSamples) samples.shift();
    },
    getSamples() {
      return [...samples];
    },
    clear() {
      samples.length = 0;
    },
    isActive() {
      return listening;
    },
  };
}
