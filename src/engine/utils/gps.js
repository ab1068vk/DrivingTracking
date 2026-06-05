import { scoringValue } from '../../lib/scoringConstants.js';

const OBD_SPEED_FALLBACK_ACCURACY_M = 15;
const OBD_SPEED_MAX_SAMPLE_AGE_MS = 2500;

const DEFAULT_THRESHOLDS = Object.freeze({
  IDLE_SPEED_KMH: scoringValue('IDLE_SPEED_KMH'),
  MAX_GPS_ACCURACY_M: scoringValue('MAX_GPS_ACCURACY_M'),
  MAX_SPEED_SPIKE_DELTA_KMH: scoringValue('MAX_SPEED_SPIKE_DELTA_KMH'),
  MAX_SPEED_SPIKE_RATIO: scoringValue('MAX_SPEED_SPIKE_RATIO'),
  MIN_POINT_DISTANCE_M: scoringValue('MIN_POINT_DISTANCE_M'),
  MIN_TRUSTED_SPEED_KMH: scoringValue('MIN_TRUSTED_SPEED_KMH'),
  OBD_SPEED_FALLBACK_ACCURACY_M,
  OBD_SPEED_MAX_SAMPLE_AGE_MS,
  STATIONARY_SPEED_KMH: scoringValue('STATIONARY_SPEED_KMH'),
});

export function haversineDistance(lat1, lng1, lat2, lng2) {
  const startLat = finiteCoordinate(lat1);
  const startLng = finiteCoordinate(lng1);
  const endLat = finiteCoordinate(lat2);
  const endLng = finiteCoordinate(lng2);
  if (startLat == null || startLng == null || endLat == null || endLng == null) return 0;

  const R = 6371; // Earth radius in km
  const dLat = toRad(endLat - startLat);
  const dLng = toRad(endLng - startLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(startLat)) * Math.cos(toRad(endLat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  return haversineDistance(lat1, lng1, lat2, lng2) * 1000;
}

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function finiteCoordinate(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function hasValidCoordinates(point) {
  return finiteCoordinate(point?.lat) != null && finiteCoordinate(point?.lng) != null;
}

// ─── Heading Calculation ───────────────────────────────────────────────────────
/**
 * Calculate bearing (heading) between two GPS points.
 * @returns {number} Bearing in degrees (0-360)
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const startLat = finiteCoordinate(lat1);
  const startLng = finiteCoordinate(lng1);
  const endLat = finiteCoordinate(lat2);
  const endLng = finiteCoordinate(lng2);
  if (startLat == null || startLng == null || endLat == null || endLng == null) return 0;

  const dLng = toRad(endLng - startLng);
  const rlat1 = toRad(startLat);
  const rlat2 = toRad(endLat);
  const y = Math.sin(dLng) * Math.cos(rlat2);
  const x = Math.cos(rlat1) * Math.sin(rlat2) - Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Get the smallest angular difference between two headings.
 * @returns {number} Angle in degrees (0-180)
 */
export function headingDiff(h1, h2) {
  let diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function headingStdDev(headings) {
  if (!headings || headings.length < 2) return 0;
  const valid = headings.filter(h => h != null && Number.isFinite(h));
  if (valid.length < 2) return 0;
  const sinMean = valid.reduce((s, h) => s + Math.sin(h * Math.PI / 180), 0) / valid.length;
  const cosMean = valid.reduce((s, h) => s + Math.cos(h * Math.PI / 180), 0) / valid.length;
  const R = Math.sqrt(sinMean * sinMean + cosMean * cosMean);
  const stdRad = R < 1 ? Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) : 0;
  return stdRad * 180 / Math.PI;
}

export function speedStdDev(speeds) {
  if (!speeds || speeds.length < 2) return 0;
  const valid = speeds.filter(s => Number.isFinite(s));
  if (valid.length < 2) return 0;
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
  return Math.sqrt(variance);
}

// ─── Speed Calculation ─────────────────────────────────────────────────────────
/**
 * Calculate speed between two GPS points.
 * @param {number} distKm - Distance in km
 * @param {number} durationSeconds - Time elapsed in seconds
 * @returns {number} Speed in km/h
 */
export function calculateSpeedKmh(distKm, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  return (distKm / durationSeconds) * 3600;
}

// ─── Acceleration Detection ────────────────────────────────────────────────────
/**
 * Calculate acceleration/deceleration from two speed readings.
 * Formula: a = (v2 - v1) / t
 * @param {number} speed1Kmh - Initial speed in km/h
 * @param {number} speed2Kmh - Final speed in km/h
 * @param {number} durationSeconds - Time elapsed in seconds
 * @returns {number} Acceleration in m/s² (negative = braking)
 */
export function calculateAcceleration(speed1Kmh, speed2Kmh, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  const v1 = speed1Kmh / 3.6; // convert to m/s
  const v2 = speed2Kmh / 3.6;
  return (v2 - v1) / durationSeconds;
}

export function timestampMs(point) {
  const value = point?.timestamp ?? point?.time;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

export function parseTimestampMs(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function accuracyMeters(point) {
  return Number.isFinite(point?.accuracy) ? Math.max(0, point.accuracy) : 0;
}

export function movementNoiseFloorMeters(point, previousPoint, thresholds = DEFAULT_THRESHOLDS) {
  const bestAccuracy = Math.max(accuracyMeters(point), accuracyMeters(previousPoint));
  return Math.max(
    thresholds.MIN_POINT_DISTANCE_M ?? 8,
    Math.min(25, bestAccuracy * 0.6)
  );
}

export function finiteVehicleSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed >= 0 && speed <= 260 ? speed : null;
}

export function obdSpeedTimestampMs(point) {
  return parseTimestampMs(point?.obd_speed_timestamp ?? point?.obd_data_timestamp);
}

export function gpsSpeedTimestampMs(point) {
  return parseTimestampMs(point?.gps_speed_timestamp ?? point?.timestamp ?? point?.time);
}

export function speedSourceForPoint(point, thresholds = DEFAULT_THRESHOLDS) {
  if (!point) return null;
  const gpsSpeed = finiteVehicleSpeed(point.speed_kmh);
  const obdSpeed = finiteVehicleSpeed(point.obd_speed_kmh);
  if (obdSpeed == null) return gpsSpeed == null ? null : 'gps';
  if (point.speed_source === 'obd' || point.vehicle_speed_source === 'obd') return 'obd_bluetooth';
  if (gpsSpeed == null) return 'obd_bluetooth';

  const fallbackAccuracy = thresholds.OBD_SPEED_FALLBACK_ACCURACY_M ?? OBD_SPEED_FALLBACK_ACCURACY_M;
  if (Number(point.accuracy) <= fallbackAccuracy) return 'gps';

  const gpsMs = gpsSpeedTimestampMs(point);
  const obdMs = obdSpeedTimestampMs(point);
  if (gpsMs != null && obdMs != null) {
    const maxAgeMs = thresholds.OBD_SPEED_MAX_SAMPLE_AGE_MS ?? OBD_SPEED_MAX_SAMPLE_AGE_MS;
    return obdMs >= gpsMs || Math.abs(gpsMs - obdMs) <= maxAgeMs ? 'obd_bluetooth' : 'gps';
  }
  return 'obd_bluetooth';
}

export function vehicleSpeedKmh(point, thresholds = DEFAULT_THRESHOLDS) {
  const source = speedSourceForPoint(point, thresholds);
  if (source === 'obd_bluetooth') return finiteVehicleSpeed(point?.obd_speed_kmh);
  return finiteVehicleSpeed(point?.speed_kmh);
}

export function finiteSpeed(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds) ?? 0;
}

export function pointSpeedKmh(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds);
}

export function isLikelySpeedSpike(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  thresholds = thresholds || DEFAULT_THRESHOLDS;
  const speed = pointSpeedKmh(points[index], thresholds);
  if (speed == null) return false;

  const previousSpeed = pointSpeedKmh(points[index - 1], thresholds);
  const nextSpeed = pointSpeedKmh(points[index + 1], thresholds);
  const neighborSpeeds = [previousSpeed, nextSpeed].filter((value) => value != null);
  if (!neighborSpeeds.length) return false;

  const spikeDelta = thresholds.MAX_SPEED_SPIKE_DELTA_KMH ?? DEFAULT_THRESHOLDS.MAX_SPEED_SPIKE_DELTA_KMH;
  const spikeRatio = thresholds.MAX_SPEED_SPIKE_RATIO ?? DEFAULT_THRESHOLDS.MAX_SPEED_SPIKE_RATIO;
  const neighborMax = Math.max(...neighborSpeeds);
  if (speed - neighborMax <= spikeDelta || speed <= Math.max(1, neighborMax) * spikeRatio) return false;

  let maxAdjacentImplied = 0;
  if (points[index - 1]) {
    const previousSegment = calculateSegmentMetrics(points[index - 1], points[index], thresholds);
    if (previousSegment.dt > 0 && previousSegment.dt <= 120 && !previousSegment.isNoise) {
      maxAdjacentImplied = Math.max(maxAdjacentImplied, previousSegment.impliedSpeedKmh);
    }
  }
  if (points[index + 1]) {
    const nextSegment = calculateSegmentMetrics(points[index], points[index + 1], thresholds);
    if (nextSegment.dt > 0 && nextSegment.dt <= 120 && !nextSegment.isNoise) {
      maxAdjacentImplied = Math.max(maxAdjacentImplied, nextSegment.impliedSpeedKmh);
    }
  }

  return speed - maxAdjacentImplied > spikeDelta;
}

export function reliablePointSpeed(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  return isLikelySpeedSpike(points, index, thresholds) ? null : pointSpeedKmh(points[index], thresholds);
}

export function calculateSegmentMetrics(previousPoint, point, thresholds = DEFAULT_THRESHOLDS) {
  if (!previousPoint || !point) {
    return {
      dt: 0,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: false,
    };
  }

  const dt = (timestampMs(point) - timestampMs(previousPoint)) / 1000;
  if (dt <= 0) {
    return {
      dt,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: true,
    };
  }

  if (!hasValidCoordinates(previousPoint) || !hasValidCoordinates(point)) {
    return {
      dt,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: true,
    };
  }

  const distanceKm = haversineDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
  const distanceM = distanceKm * 1000;
  const impliedSpeedKmh = calculateSpeedKmh(distanceKm, dt);
  const reportedSpeedKmh = pointSpeedKmh(point, thresholds);
  const noiseFloorM = movementNoiseFloorMeters(point, previousPoint, thresholds);
  const stationarySpeed = thresholds.STATIONARY_SPEED_KMH ?? 5;
  const trustedSpeed = thresholds.MIN_TRUSTED_SPEED_KMH ?? 18;

  const tinyMovement = distanceM < noiseFloorM;
  const displacementSaysStill = impliedSpeedKmh < stationarySpeed && distanceM < noiseFloorM * 1.5;
  const reportedDisagreesWithDisplacement = reportedSpeedKmh != null &&
    reportedSpeedKmh < trustedSpeed &&
    displacementSaysStill;
  const isNoise = tinyMovement || reportedDisagreesWithDisplacement;

  let reliableSpeedKmh = impliedSpeedKmh;
  if (!isNoise && reportedSpeedKmh != null) {
    const reportedCloseToImplied = impliedSpeedKmh >= stationarySpeed ||
      reportedSpeedKmh >= trustedSpeed ||
      Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= 12;
    reliableSpeedKmh = reportedCloseToImplied ? reportedSpeedKmh : impliedSpeedKmh;
  }

  return {
    dt,
    distanceKm,
    distanceM,
    impliedSpeedKmh,
    reportedSpeedKmh,
    reliableSpeedKmh: isNoise ? 0 : Math.max(0, reliableSpeedKmh),
    isNoise,
  };
}

export function computeSmoothedAccelerations(points, thresholds = DEFAULT_THRESHOLDS) {
  const result = new Array(points?.length || 0).fill(null);
  if (!points || points.length < 3) return result;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const dtTotal = (timestampMs(next) - timestampMs(prev)) / 1000;

    if (dtTotal <= 0 || dtTotal > 15) continue;

    const segPrev = calculateSegmentMetrics(prev, curr, thresholds);
    const segNext = calculateSegmentMetrics(curr, next, thresholds);
    if (segPrev.isNoise || segNext.isNoise) continue;

    result[i] = {
      accel_ms2: calculateAcceleration(
        segPrev.reliableSpeedKmh,
        segNext.reliableSpeedKmh,
        dtTotal
      ),
      speed_kmh: segPrev.reliableSpeedKmh,
    };
  }

  return result;
}

export function normalizeLocationPoint(input) {
  if (!input) return null;

  const coords = input.coords || input;
  const lat = coords.latitude ?? input.lat;
  const lng = coords.longitude ?? input.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timestampMs = input.timestamp ?? input.time ?? Date.now();
  const normalized = {
    lat,
    lng,
    speed_kmh: coords.speed != null ? Math.max(0, coords.speed * 3.6) : input.speed_kmh ?? null,
    heading: coords.heading ?? coords.bearing ?? coords.course ?? input.heading ?? null,
    accuracy: coords.accuracy ?? input.accuracy ?? null,
    altitude: coords.altitude ?? input.altitude ?? null,
    altitude_accuracy: coords.altitudeAccuracy ?? input.altitudeAccuracy ?? null,
    timestamp: new Date(timestampMs).toISOString(),
  };
  [
    'obd_speed_kmh',
    'obd_speed_timestamp',
    'obd_rpm',
    'obd_throttle_pct',
    'obd_engine_load_pct',
    'obd_coolant_temp_c',
    'obd_maf_gps',
    'obd_data_source',
    'obd_data_timestamp',
  ].forEach((key) => {
    if (input[key] != null) normalized[key] = input[key];
  });
  return normalized;
}

export function shouldAcceptLocationPoint(point, previousPoint = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!point || !hasValidCoordinates(point)) return false;
  if (point.accuracy != null && point.accuracy > thresholds.MAX_GPS_ACCURACY_M) return false;
  if (Number.isFinite(Number(point.speed_kmh)) && Number(point.speed_kmh) > 220) return false;
  if (Number.isFinite(Number(point.obd_speed_kmh)) && Number(point.obd_speed_kmh) > 260) return false;
  if (!previousPoint) return true;

  const dt = (new Date(point.timestamp).getTime() - new Date(previousPoint.timestamp).getTime()) / 1000;
  if (dt <= 0) return false;

  const segment = calculateSegmentMetrics(previousPoint, point, thresholds);
  if (segment.isNoise && dt < 45) return false;

  const impliedSpeed = segment.impliedSpeedKmh;
  const reportedSpeed = segment.reportedSpeedKmh ?? impliedSpeed;
  if (impliedSpeed > 220 || reportedSpeed > 220) return false;

  return true;
}

export function cleanRoutePoints(points, thresholds = DEFAULT_THRESHOLDS) {
  return (points || []).reduce((accepted, rawPoint) => {
    const point = normalizeLocationPoint(rawPoint) || rawPoint;
    const previous = accepted[accepted.length - 1] || null;
    if (shouldAcceptLocationPoint(point, previous, thresholds)) accepted.push(point);
    return accepted;
  }, []);
}

export const TRIP_STATES = {
  IDLE: 'Idle',
  CANDIDATE: 'CandidateTrip',
  CONFIRMED: 'ConfirmedTrip',
  ENDING_REVIEW: 'EndingReview',
  SAVED: 'Saved',
  DISCARDED: 'Discarded',
};

export const CANDIDATE_TRIP_DEFAULTS = {
  REVIEW_TIMEOUT_MS: 3 * 60 * 1000,
  DISTANCE_M: 150,
  DISTANCE_PARKING_COOLDOWN_M: 250,
  MAX_SPEED_KMH: 10,
  MAX_SPEED_PARKING_COOLDOWN_KMH: 10,
  WALKING_SPEED_CUTOFF_KMH: 10,
  STABLE_POINTS: 4,
  STABLE_POINTS_PARKING_COOLDOWN: 5,
  MAX_ACCURACY_M: DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M,
  PARKING_COOLDOWN_MS: 5 * 60 * 1000,
  PARKING_COOLDOWN_RADIUS_M: 75,
};

export function activityTypeOf(activity) {
  return String(activity?.type || activity?.activity || '').toLowerCase();
}

export function activityConfidenceOf(activity) {
  const confidence = Number(activity?.confidence);
  return Number.isFinite(confidence) ? confidence : 0;
}

export function isStrongFootActivity(activity) {
  const type = activityTypeOf(activity);
  return ['walking', 'running', 'on_foot', 'cycling', 'on_bicycle'].includes(type) &&
    activityConfidenceOf(activity) >= 75;
}

export function isVehicleActivity(activity) {
  return activityTypeOf(activity) === 'in_vehicle' && activityConfidenceOf(activity) >= 65;
}

export function countStableGpsPoints(points = [], maxAccuracyM = DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M) {
  return (points || []).filter((point) => {
    const accuracy = Number(point?.accuracy);
    return !Number.isFinite(accuracy) || accuracy <= maxAccuracyM;
  }).length;
}

export function isNearRecentParkedLocation(point, parkedLocation, options = {}) {
  if (!point || !parkedLocation) return false;
  const pointLat = Number(point.lat);
  const pointLng = Number(point.lng);
  const parkedLat = Number(parkedLocation.lat);
  const parkedLng = Number(parkedLocation.lng);
  if (![pointLat, pointLng, parkedLat, parkedLng].every(Number.isFinite)) return false;

  const parkedMs = parseTimestampMs(parkedLocation.timestamp) ?? Number(parkedLocation.timestamp_ms);
  if (!Number.isFinite(parkedMs)) return false;

  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = options.cooldownMs ?? CANDIDATE_TRIP_DEFAULTS.PARKING_COOLDOWN_MS;
  if (nowMs - parkedMs > cooldownMs) return false;

  const radiusM = options.radiusM ?? CANDIDATE_TRIP_DEFAULTS.PARKING_COOLDOWN_RADIUS_M;
  return haversineMeters(parkedLat, parkedLng, pointLat, pointLng) <= radiusM;
}

export function calculateCandidateTripStats(points = [], startTime = null, endTime = null, thresholds = DEFAULT_THRESHOLDS) {
  let distanceKm = 0;
  let maxSpeedKmh = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) distanceKm += segment.distanceKm;
    const speed = pointSpeedKmh(points[i], thresholds);
    if (Number.isFinite(speed)) maxSpeedKmh = Math.max(maxSpeedKmh, speed);
  }
  const startMs = parseTimestampMs(startTime);
  const endMs = parseTimestampMs(endTime) ?? Date.now();
  return {
    distance_km: Math.round(distanceKm * 1000) / 1000,
    max_speed_kmh: Math.round(maxSpeedKmh * 10) / 10,
    duration_seconds: startMs == null ? 0 : Math.max(0, Math.round((endMs - startMs) / 1000)),
  };
}

export function validateCandidateTrip(input = {}) {
  const {
    points = [],
    startTime = null,
    now = new Date().toISOString(),
    activity = null,
    nearParkedLocation = false,
    forceFinal = false,
    thresholds = DEFAULT_THRESHOLDS,
    options = {},
  } = input || {};
  const config = { ...CANDIDATE_TRIP_DEFAULTS, ...options };
  const cleanPoints = cleanRoutePoints(points, thresholds);
  const stats = calculateCandidateTripStats(cleanPoints, startTime, now, thresholds);
  const stablePoints = countStableGpsPoints(cleanPoints, config.MAX_ACCURACY_M);
  const requiredDistanceM = nearParkedLocation ? config.DISTANCE_PARKING_COOLDOWN_M : config.DISTANCE_M;
  const requiredSpeedKmh = nearParkedLocation ? config.MAX_SPEED_PARKING_COOLDOWN_KMH : config.MAX_SPEED_KMH;
  const requiredStablePoints = nearParkedLocation ? config.STABLE_POINTS_PARKING_COOLDOWN : config.STABLE_POINTS;
  const strongFootSignal = isStrongFootActivity(activity);
  const vehicleActivity = isVehicleActivity(activity);
  const enoughGps = stablePoints >= requiredStablePoints;
  const enoughDistance = (stats.distance_km || 0) * 1000 >= requiredDistanceM;
  const vehicleSpeedSegment = (stats.max_speed_kmh || 0) >= requiredSpeedKmh;
  const startMs = parseTimestampMs(startTime);
  const nowMs = parseTimestampMs(now) ?? Date.now();
  const candidateAgeMs = startMs == null ? 0 : Math.max(0, nowMs - startMs);

  const result = {
    state: TRIP_STATES.CANDIDATE,
    confirmed: false,
    discarded: false,
    reason: null,
    title: null,
    cleanPoints,
    metrics: {
      distance_m: Math.round((stats.distance_km || 0) * 1000),
      max_speed_kmh: stats.max_speed_kmh || 0,
      stable_points: stablePoints,
      required_distance_m: requiredDistanceM,
      required_speed_kmh: requiredSpeedKmh,
      required_stable_points: requiredStablePoints,
      candidate_age_ms: candidateAgeMs,
      near_parked_location: nearParkedLocation,
      vehicle_activity: vehicleActivity,
      strong_foot_signal: strongFootSignal,
    },
  };

  if (strongFootSignal && (stats.max_speed_kmh || 0) <= config.WALKING_SPEED_CUTOFF_KMH) {
    return {
      ...result,
      state: TRIP_STATES.DISCARDED,
      discarded: true,
      reason: 'movement_looked_like_walking',
      title: 'Candidate discarded: walking/running signal detected',
    };
  }

  if (enoughGps && enoughDistance && vehicleSpeedSegment && !strongFootSignal) {
    return {
      ...result,
      state: TRIP_STATES.CONFIRMED,
      confirmed: true,
      reason: vehicleActivity ? 'activity_in_vehicle' : 'vehicle_speed_distance',
      title: 'Candidate confirmed: vehicle-like movement detected',
    };
  }

  if (forceFinal || candidateAgeMs >= config.REVIEW_TIMEOUT_MS) {
    if (!vehicleSpeedSegment) {
      return {
        ...result,
        state: TRIP_STATES.DISCARDED,
        discarded: true,
        reason: 'no_vehicle_speed_segment',
        title: 'Candidate discarded: no vehicle-speed segment',
      };
    }
    if (!enoughGps) {
      return {
        ...result,
        state: TRIP_STATES.DISCARDED,
        discarded: true,
        reason: 'unstable_gps_drift',
        title: 'Candidate discarded: unstable GPS drift',
      };
    }
    return {
      ...result,
      state: TRIP_STATES.DISCARDED,
      discarded: true,
      reason: 'gps_movement_too_short',
      title: 'Candidate discarded: GPS movement too short',
    };
  }

  return result;
}

export function trimParkedTail(points = [], {
  endTime = new Date().toISOString(),
  reason = '',
  activity = null,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const cleanPoints = cleanRoutePoints(points, thresholds);
  const originalEndTime = endTime;
  if (cleanPoints.length < 4) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const stopLikeReason = /park|still|foot|walking|gps|auto/i.test(String(reason || ''));
  const strongFootSignal = isStrongFootActivity(activity);
  if (!stopLikeReason && !strongFootSignal) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const vehicleSpeed = CANDIDATE_TRIP_DEFAULTS.MAX_SPEED_KMH;
  let lastVehicleIndex = -1;
  for (let i = cleanPoints.length - 1; i >= 0; i--) {
    if ((Number(cleanPoints[i].speed_kmh) || 0) >= vehicleSpeed) {
      lastVehicleIndex = i;
      break;
    }
  }

  if (lastVehicleIndex < 0 || lastVehicleIndex >= cleanPoints.length - 1) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  let keepThrough = Math.min(lastVehicleIndex + 1, cleanPoints.length - 1);
  for (let i = lastVehicleIndex + 1; i < cleanPoints.length; i++) {
    if ((Number(cleanPoints[i].speed_kmh) || 0) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH)) {
      keepThrough = i;
      break;
    }
  }

  const removedPoints = cleanPoints.length - (keepThrough + 1);
  if (removedPoints <= 0) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const trimmedPoints = cleanPoints.slice(0, keepThrough + 1);
  return {
    points: trimmedPoints,
    endTime: trimmedPoints[trimmedPoints.length - 1]?.timestamp || originalEndTime,
    removedPoints,
    trimmed: true,
    reason: strongFootSignal ? 'walking_after_parking' : 'parked_tail_review',
  };
}
