import { EVENT_TYPES } from '@/lib/scoring/eventTypes';
import { clamp, pearsonCorrelation, STANDARD_GRAVITY_MS2 } from '@/lib/mathUtils';

const MS2_PER_G = STANDARD_GRAVITY_MS2;
const MAX_SAMPLE_AGE_MS = 2 * 60 * 60 * 1000;
const RAD_TO_DEG = 180 / Math.PI;

const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round2 = (value) => Math.round(value * 100) / 100;
const safeMax = (values = [], fallback = 0) => values.length ? Math.max(...values) : fallback;
const finiteNumberOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function getMotionSensorSupport() {
  const win = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
  const supported = Boolean(win.DeviceMotionEvent);
  const permissionRequired = typeof win.DeviceMotionEvent?.requestPermission === 'function';
  return {
    supported,
    permissionRequired,
    status: !supported ? 'unavailable' : permissionRequired ? 'not_requested' : 'granted',
    note: supported
      ? permissionRequired
        ? 'This device asks before Road Sage can use motion and gyroscope samples.'
        : 'Motion and gyroscope samples are available without a separate Android prompt.'
      : 'Device motion events are not available in this browser or WebView.',
  };
}

export async function requestMotionSensorPermission() {
  const win = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
  if (!win.DeviceMotionEvent) return false;
  const permissionApi = win.DeviceMotionEvent.requestPermission;
  if (typeof permissionApi !== 'function') return true;
  const result = await permissionApi.call(win.DeviceMotionEvent).catch(() => 'denied');
  return result === 'granted';
}

export function normalizeMotionSample(input = {}) {
  const acceleration = input.acceleration || input.accelerationIncludingGravity || input;
  const rotation = input.rotationRate || input.rotation || {};
  const ax = finiteNumberOrNull(acceleration.x ?? input.ax);
  const ay = finiteNumberOrNull(acceleration.y ?? input.ay);
  const az = finiteNumberOrNull(acceleration.z ?? input.az);
  const gx = finiteNumberOrNull(input.gx);
  const gy = finiteNumberOrNull(input.gy);
  const gz = finiteNumberOrNull(input.gz);
  const alpha = finiteNumberOrNull(rotation.alpha ?? input.alpha);
  const beta = finiteNumberOrNull(rotation.beta ?? input.beta);
  const gamma = finiteNumberOrNull(rotation.gamma ?? input.gamma);
  const timestamp = input.timestamp || new Date().toISOString();
  const hasLinearAxes = ax != null && ay != null && az != null;
  const magnitudeMs2 = finiteNumberOrNull(input.magnitude_ms2) ?? (
    hasLinearAxes ? Math.sqrt(ax * ax + ay * ay + az * az) : 0
  );
  const providedLinearMagnitude = finiteNumberOrNull(input.linear_magnitude_ms2);
  const usesGravityAdjustedBrowserSample = input.accelerationIncludingGravity && !input.acceleration && providedLinearMagnitude == null;
  const inferredLinearMagnitudeMs2 = !hasLinearAxes
    ? 0
    : usesGravityAdjustedBrowserSample || input.linear_magnitude_ms2 == null
      ? Math.abs(magnitudeMs2 - MS2_PER_G)
      : magnitudeMs2;
  const linearMagnitudeMs2 = providedLinearMagnitude ?? inferredLinearMagnitudeMs2;
  const gzDegS = finiteNumberOrNull(input.gz_deg_s) ?? (gz != null ? gz * RAD_TO_DEG : null);
  const hasGyroAxes = gx != null && gy != null && gz != null;
  // gx/gy/gz are gyroscope rad/s and need converting; DeviceMotion
  // `rotationRate` alpha/beta/gamma are already deg/s per spec. With neither
  // present there is no rotation reading at all - report null rather than a
  // 0 deg/s that renders as a measured "no rotation".
  const hasBrowserRotation = alpha != null || beta != null || gamma != null;
  const rotationMagnitudeDegS = finiteNumberOrNull(input.rotation_magnitude_deg_s) ?? (
    hasGyroAxes
      ? Math.sqrt(gx * gx + gy * gy + gz * gz) * RAD_TO_DEG
      : hasBrowserRotation
        ? Math.sqrt((alpha ?? 0) * (alpha ?? 0) + (beta ?? 0) * (beta ?? 0) + (gamma ?? 0) * (gamma ?? 0))
        : null
  );

  return {
    timestamp,
    ax,
    ay,
    az,
    gx,
    gy,
    gz,
    gz_deg_s: gzDegS != null ? round2(gzDegS) : null,
    has_axes: ax != null && ay != null && gzDegS != null,
    alpha: alpha ?? 0,
    beta: beta ?? 0,
    gamma: gamma ?? 0,
    magnitude_ms2: round2(magnitudeMs2),
    linear_magnitude_ms2: round2(linearMagnitudeMs2),
    rotation_magnitude_deg_s: rotationMagnitudeDegS != null ? round2(rotationMagnitudeDegS) : null,
  };
}

const timestampToMs = (value) => {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
};

const axisAverage = (samples = [], axis) => {
  const values = samples
    .map((sample) => Number(sample?.[axis]))
    .filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};

export function calibratePhoneOrientation(motionSamples = [], harshBrakeEvents = []) {
  const normalized = (motionSamples || []).map(normalizeMotionSample);
  const brakeEvents = (harshBrakeEvents || []).filter((event) => event?.type === EVENT_TYPES.HARSH_BRAKE);
  const axPairs = [];
  const ayPairs = [];

  brakeEvents.forEach((event) => {
    const eventMs = timestampToMs(event.timestamp);
    const gpsDecel = Number(event.value) || 0;
    if (!Number.isFinite(eventMs) || gpsDecel <= 0) return;

    const nearbySamples = normalized.filter((sample) => (
      sample.has_axes &&
      Math.abs(timestampToMs(sample.timestamp) - eventMs) <= 1500
    ));
    if (nearbySamples.length < 3) return;

    axPairs.push({ gpsDecel, imuVal: Math.abs(axisAverage(nearbySamples, 'ax')) });
    ayPairs.push({ gpsDecel, imuVal: Math.abs(axisAverage(nearbySamples, 'ay')) });
  });

  if (axPairs.length < 2) {
    return {
      calibrated: false,
      sample_count: axPairs.length,
      reason: 'insufficient_harsh_brake_axis_samples',
    };
  }

  const axR = pearsonCorrelation(
    axPairs.map((item) => item.gpsDecel),
    axPairs.map((item) => item.imuVal)
  );
  const ayR = pearsonCorrelation(
    ayPairs.map((item) => item.gpsDecel),
    ayPairs.map((item) => item.imuVal)
  );
  const axAbs = Math.abs(axR);
  const ayAbs = Math.abs(ayR);
  const axIsLongitudinal = axAbs >= ayAbs;
  const bestCorrelation = Math.max(axAbs, ayAbs);

  return {
    calibrated: true,
    longitudinal_axis: axIsLongitudinal ? 'ax' : 'ay',
    lateral_axis: axIsLongitudinal ? 'ay' : 'ax',
    longitudinal_correlation: round2(bestCorrelation),
    ax_correlation: round2(axR),
    ay_correlation: round2(ayR),
    sample_count: axPairs.length,
    confidence: axPairs.length >= 5 && bestCorrelation >= 0.5 ? 'high' : 'low',
  };
}

export function buildSensorFusionSummary(samples = [], routePoints = [], activity = null, events = []) {
  const cutoff = Date.now() - MAX_SAMPLE_AGE_MS;
  const valid = (samples || [])
    .map(normalizeMotionSample)
    .filter((sample) => new Date(sample.timestamp).getTime() >= cutoff);
  const phoneOrientation = calibratePhoneOrientation(valid, events);
  if (!valid.length) {
    // Nothing was sampled, so nothing was measured. Reporting 0 here rendered
    // as "peak 0 m/s2 - phone movement 0/100", which reads as a calm trip
    // rather than as an absent sensor.
    return {
      sample_count: 0,
      peak_linear_ms2: null,
      peak_rotation_deg_s: null,
      phone_movement_score: null,
      harsh_motion_count: 0,
      impact_like_count: 0,
      activity_type: activity?.type || 'unknown',
      activity_confidence: activity?.confidence || 0,
      quality: 'unavailable',
      phone_orientation: phoneOrientation,
    };
  }

  const linear = valid.map((sample) => sample.linear_magnitude_ms2).filter(Number.isFinite);
  // Samples with no rotation source carry null; they must not be averaged in
  // as zeros, and a trip with no rotation reading at all reports null.
  const rotation = valid.map((sample) => sample.rotation_magnitude_deg_s).filter(Number.isFinite);
  const peakLinear = linear.length ? safeMax(linear) : null;
  const peakRotation = rotation.length ? safeMax(rotation) : null;
  const harshMotionCount = valid.filter((sample) => sample.linear_magnitude_ms2 >= 5.5).length;
  const impactLikeCount = valid.filter((sample) => (
    sample.linear_magnitude_ms2 >= 14 && Number(sample.rotation_magnitude_deg_s) >= 120
  )).length;
  // `harshMotionCount` is an absolute count, so feeding it in directly made a
  // long drive accumulate "phone movement" from duration alone. Use the share
  // of samples that were harsh instead, which is duration-independent.
  const harshMotionRatio = valid.length ? harshMotionCount / valid.length : 0;
  const phoneMovementScore = clamp(Math.round(
    avg(linear) * 5 +
    avg(rotation) * 0.08 +
    harshMotionRatio * 100 * 0.4
  ), 0, 100);
  const routePointCount = Array.isArray(routePoints) ? routePoints.length : 0;

  return {
    sample_count: valid.length,
    peak_linear_ms2: peakLinear != null ? round2(peakLinear) : null,
    peak_rotation_deg_s: peakRotation != null ? round2(peakRotation) : null,
    phone_movement_score: phoneMovementScore,
    harsh_motion_count: harshMotionCount,
    impact_like_count: impactLikeCount,
    activity_type: activity?.type || 'unknown',
    activity_confidence: activity?.confidence || 0,
    // 'quality' is a raw sample-count threshold, not an assessment of how good
    // the readings were.
    quality: valid.length >= Math.min(120, Math.max(20, routePointCount * 2)) ? 'good' : 'partial',
    quality_basis: 'sample_count',
    phone_orientation: phoneOrientation,
  };
}

const finiteSampleCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
};

function normalizeFusionQuality(summary = null) {
  const sampleCount = finiteSampleCount(summary?.sample_count);
  if (sampleCount <= 0) return 'unavailable';
  return summary?.quality === 'good' ? 'good' : 'partial';
}

export function buildMotionSensorDiagnostics({
  support = getMotionSensorSupport(),
  permissionState = support?.status,
  settings = {},
  currentTrip = null,
  latestTrip = null,
} = {}) {
  const currentSummary = currentTrip?.sensor_fusion_summary || null;
  const latestSummary = latestTrip?.sensor_fusion_summary || null;
  const evidenceSummary = currentSummary || latestSummary || null;
  const evidenceSource = currentSummary
    ? 'current_trip'
    : latestSummary
      ? 'latest_trip'
      : currentTrip
        ? 'current_trip_pending'
        : latestTrip
          ? 'latest_trip_missing'
          : 'none';
  const permission = permissionState || support?.status || 'unknown';
  const sensorAvailable = support?.supported === true;
  const permissionGranted = permission === 'granted';
  const settingsRecord = /** @type {Record<string, any>} */ (settings || {});
  const sensorFusionEnabled = settingsRecord.sensor_fusion_enabled !== false;
  const crashDetectionEnabled = settingsRecord.crash_detection_enabled !== false;
  const crashDetectionActive = sensorAvailable && permissionGranted && sensorFusionEnabled && crashDetectionEnabled;
  const inactiveReasons = [];

  if (!sensorAvailable) inactiveReasons.push('IMU unavailable');
  if (sensorAvailable && !permissionGranted) inactiveReasons.push('permission missing');
  if (!sensorFusionEnabled) inactiveReasons.push('sensor fusion disabled');
  if (!crashDetectionEnabled) inactiveReasons.push('crash detection disabled');

  return {
    sensorAvailable,
    permissionState: permission,
    permissionRequired: support?.permissionRequired === true,
    supportNote: support?.note || '',
    sampleCount: finiteSampleCount(evidenceSummary?.sample_count),
    quality: normalizeFusionQuality(evidenceSummary),
    receivedSamples: finiteSampleCount(evidenceSummary?.sample_count) > 0,
    evidenceSource,
    crashDetectionActive,
    inactiveReasons,
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
    const peakLinear = safeMax(nearby.map((sample) => sample.linear_magnitude_ms2));
    const peakRotation = safeMax(nearby.map((sample) => sample.rotation_magnitude_deg_s));
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
  const maxRecentSpeed = safeMax(recentSpeeds);
  const stoppedSeconds = recentPoints
    .filter((point) => (Number(point.speed_kmh) || 0) < 3)
    .reduce((sum, point, index, list) => {
      if (index === 0) return sum;
      return sum + Math.max(0, (new Date(point.timestamp).getTime() - new Date(list[index - 1].timestamp).getTime()) / 1000);
    }, 0);
  const recentSamples = samples.filter((sample) => (
    Math.abs(new Date(sample.timestamp).getTime() - new Date(latestPoint.timestamp || Date.now()).getTime()) <= 12000
  ));
  const peakLinear = safeMax(recentSamples.map((sample) => sample.linear_magnitude_ms2));
  const peakRotation = safeMax(recentSamples.map((sample) => sample.rotation_magnitude_deg_s));
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
      if (!await requestMotionSensorPermission()) return false;
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
