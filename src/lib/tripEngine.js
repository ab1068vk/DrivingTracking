/**
 * DriveSense Trip Engine
 * Core logic for trip tracking, event detection, and scoring.
 * All thresholds are configurable via the THRESHOLDS object.
 */

// ─── Default Thresholds ────────────────────────────────────────────────────────
export const DEFAULT_THRESHOLDS = {
  // Harsh braking: deceleration > 4.5 m/s² (≈ 16 km/h per second drop)
  HARSH_BRAKE_MS2: 4.5,
  // Rapid acceleration: > 3.5 m/s² (≈ 12.6 km/h per second gain)
  RAPID_ACCEL_MS2: 3.5,
  // Sharp turn: heading change > 45° per GPS sample at > 30 km/h
  SHARP_TURN_G_LOW: 0.30,
  SHARP_TURN_G_MEDIUM: 0.45,
  SHARP_TURN_G_HIGH: 0.60,
  // Speeding fallback: above 130 km/h (when no speed limit data)
  SPEEDING_FALLBACK_KMH: 130,
  // Idle threshold: speed < 5 km/h
  IDLE_SPEED_KMH: 5,
  // Idle event: idling for > 60 consecutive seconds
  IDLE_EVENT_SECONDS: 90,
  // Long drive: > 120 continuous minutes
  LONG_DRIVE_MINUTES: 120,
  // Night driving defaults: sunset/sunrise when coordinates exist, otherwise 22:00 - 06:00.
  NIGHT_DETECTION_MODE: 'sunset',
  NIGHT_START_TIME: '22:00',
  NIGHT_END_TIME: '06:00',
  NIGHT_START_HOUR: 22,
  NIGHT_END_HOUR: 6,
  NIGHT_SUNSET_OFFSET_MINUTES: 0,
  NIGHT_SUNRISE_OFFSET_MINUTES: 0,
  // Minimum trip distance to save (< 0.1 km = likely noise)
  MIN_TRIP_DISTANCE_KM: 0.1,
  // Minimum trip duration
  MIN_TRIP_DURATION_SECONDS: 30,
  // GPS accuracy filter: ignore points with accuracy > 50m
  MAX_GPS_ACCURACY_M: 50,
  // Ignore small point-to-point hops that are inside normal GPS drift.
  MIN_POINT_DISTANCE_M: 8,
  // Do not trust low-speed GPS speed unless movement also backs it up.
  MIN_TRUSTED_SPEED_KMH: 18,
  // Stationary / crawling speed used to suppress jitter in stats and events.
  STATIONARY_SPEED_KMH: 5,
  MIN_SPEED_RAPID_ACCEL_KMH: 15,
  MIN_SPEED_HARSH_BRAKE_KMH: 25,
  TAILGATE_DECEL_MS2: 2.5,
  threshold_near_miss_brake_ms2: 3.5,
  threshold_near_miss_turn_degs: 30,
  threshold_drowsy_heading_std: 8,
  threshold_phone_proxy_oscillations: 3,
  threshold_speed_creep_kmh: 10,
  threshold_overtake_accel_ms2: 3.0,
  ADVANCED_SAFETY_DETECTION_ENABLED: true,
};

export const EVENT_TYPES = {
  HARSH_BRAKE: 'harsh_brake',
  RAPID_ACCELERATION: 'rapid_acceleration',
  SHARP_TURN: 'sharp_turn',
  SPEEDING: 'speeding',
  IDLE: 'idle',
  LANE_CHANGE: 'lane_change',
  TAILGATE_CYCLE: 'tailgate_cycle',
  ERRATIC_SPEED: 'erratic_speed',
  NEAR_MISS: 'near_miss',
  AGGRESSIVE_OVERTAKE: 'aggressive_overtake',
};

function settingNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildDrivingThresholds(settings = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    HARSH_BRAKE_MS2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    RAPID_ACCEL_MS2: settingNumber(settings.threshold_rapid_accel_ms2, DEFAULT_THRESHOLDS.RAPID_ACCEL_MS2),
    TAILGATE_DECEL_MS2: settingNumber(settings.threshold_tailgate_decel_ms2, DEFAULT_THRESHOLDS.TAILGATE_DECEL_MS2),
    SHARP_TURN_G_LOW: settingNumber(settings.threshold_sharp_turn_g_low, DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW),
    SHARP_TURN_G_MEDIUM: settingNumber(settings.threshold_sharp_turn_g_medium, DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM),
    SHARP_TURN_G_HIGH: settingNumber(settings.threshold_sharp_turn_g_high, DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH),
    SPEEDING_FALLBACK_KMH: settingNumber(settings.threshold_speeding_kmh, DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH),
    IDLE_EVENT_SECONDS: settingNumber(settings.threshold_idle_seconds, DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS),
    LONG_DRIVE_MINUTES: settingNumber(settings.threshold_long_drive_minutes, DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES),
    MIN_SPEED_RAPID_ACCEL_KMH: settingNumber(settings.min_speed_rapid_accel_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_RAPID_ACCEL_KMH),
    MIN_SPEED_HARSH_BRAKE_KMH: settingNumber(settings.min_speed_harsh_brake_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_HARSH_BRAKE_KMH),
    threshold_harsh_brake_ms2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    threshold_near_miss_brake_ms2: settingNumber(settings.threshold_near_miss_brake_ms2, DEFAULT_THRESHOLDS.threshold_near_miss_brake_ms2),
    threshold_near_miss_turn_degs: settingNumber(settings.threshold_near_miss_turn_degs, DEFAULT_THRESHOLDS.threshold_near_miss_turn_degs),
    threshold_drowsy_heading_std: settingNumber(settings.threshold_drowsy_heading_std, DEFAULT_THRESHOLDS.threshold_drowsy_heading_std),
    threshold_phone_proxy_oscillations: settingNumber(settings.threshold_phone_proxy_oscillations, DEFAULT_THRESHOLDS.threshold_phone_proxy_oscillations),
    threshold_speed_creep_kmh: settingNumber(settings.threshold_speed_creep_kmh, DEFAULT_THRESHOLDS.threshold_speed_creep_kmh),
    threshold_overtake_accel_ms2: settingNumber(settings.threshold_overtake_accel_ms2, DEFAULT_THRESHOLDS.threshold_overtake_accel_ms2),
    NIGHT_DETECTION_MODE: settings.night_detection_mode || DEFAULT_THRESHOLDS.NIGHT_DETECTION_MODE,
    NIGHT_START_TIME: settings.night_start_time || DEFAULT_THRESHOLDS.NIGHT_START_TIME,
    NIGHT_END_TIME: settings.night_end_time || DEFAULT_THRESHOLDS.NIGHT_END_TIME,
    NIGHT_SUNSET_OFFSET_MINUTES: settingNumber(settings.night_sunset_offset_minutes, DEFAULT_THRESHOLDS.NIGHT_SUNSET_OFFSET_MINUTES),
    NIGHT_SUNRISE_OFFSET_MINUTES: settingNumber(settings.night_sunrise_offset_minutes, DEFAULT_THRESHOLDS.NIGHT_SUNRISE_OFFSET_MINUTES),
    ADVANCED_SAFETY_DETECTION_ENABLED: settings.advanced_safety_detection_enabled !== false,
  };
}

// ─── Haversine Distance ────────────────────────────────────────────────────────
/**
 * Calculate great-circle distance between two GPS points using Haversine formula.
 * @param {number} lat1 - Latitude of point 1 in degrees
 * @param {number} lng1 - Longitude of point 1 in degrees
 * @param {number} lat2 - Latitude of point 2 in degrees
 * @param {number} lng2 - Longitude of point 2 in degrees
 * @returns {number} Distance in kilometers
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  return haversineDistance(lat1, lng1, lat2, lng2) * 1000;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// ─── Heading Calculation ───────────────────────────────────────────────────────
/**
 * Calculate bearing (heading) between two GPS points.
 * @returns {number} Bearing in degrees (0-360)
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const rlat1 = toRad(lat1);
  const rlat2 = toRad(lat2);
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

function timestampMs(point) {
  const value = point?.timestamp ?? point?.time;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

function accuracyMeters(point) {
  return Number.isFinite(point?.accuracy) ? Math.max(0, point.accuracy) : 0;
}

function movementNoiseFloorMeters(point, previousPoint, thresholds = DEFAULT_THRESHOLDS) {
  const bestAccuracy = Math.max(accuracyMeters(point), accuracyMeters(previousPoint));
  return Math.max(
    thresholds.MIN_POINT_DISTANCE_M ?? 8,
    Math.min(25, bestAccuracy * 0.6)
  );
}

export function calculateSegmentMetrics(previousPoint, point, thresholds = DEFAULT_THRESHOLDS) {
  if (!previousPoint || !point) {
    return {
      dt: 0,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: Number.isFinite(point?.speed_kmh) ? Math.max(0, point.speed_kmh) : null,
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
      reportedSpeedKmh: Number.isFinite(point.speed_kmh) ? Math.max(0, point.speed_kmh) : null,
      reliableSpeedKmh: 0,
      isNoise: true,
    };
  }

  const distanceKm = haversineDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
  const distanceM = distanceKm * 1000;
  const impliedSpeedKmh = calculateSpeedKmh(distanceKm, dt);
  const reportedSpeedKmh = Number.isFinite(point.speed_kmh) ? Math.max(0, point.speed_kmh) : null;
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
  return {
    lat,
    lng,
    speed_kmh: coords.speed != null ? Math.max(0, coords.speed * 3.6) : input.speed_kmh ?? null,
    heading: coords.heading ?? coords.bearing ?? coords.course ?? input.heading ?? null,
    accuracy: coords.accuracy ?? input.accuracy ?? null,
    altitude: coords.altitude ?? input.altitude ?? null,
    altitude_accuracy: coords.altitudeAccuracy ?? input.altitudeAccuracy ?? null,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

export function shouldAcceptLocationPoint(point, previousPoint = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  if (point.accuracy != null && point.accuracy > thresholds.MAX_GPS_ACCURACY_M) return false;
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

function perpendicularDistanceMeters(point, lineStart, lineEnd) {
  const dx = lineEnd.lng - lineStart.lng;
  const dy = lineEnd.lat - lineStart.lat;
  if (dx === 0 && dy === 0) {
    return haversineMeters(point.lat, point.lng, lineStart.lat, lineStart.lng);
  }

  const t = ((point.lng - lineStart.lng) * dx + (point.lat - lineStart.lat) * dy) / (dx * dx + dy * dy);
  const tClamped = Math.max(0, Math.min(1, t));
  const closestLat = lineStart.lat + tClamped * dy;
  const closestLng = lineStart.lng + tClamped * dx;
  return haversineMeters(point.lat, point.lng, closestLat, closestLng);
}

export function simplifyRoute(points = [], toleranceMeters = 10, events = []) {
  const validPoints = points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  if (validPoints.length <= 2) return validPoints;

  const keepFlags = new Array(validPoints.length).fill(false);
  keepFlags[0] = true;
  keepFlags[validPoints.length - 1] = true;

  for (const event of events || []) {
    if (!Number.isFinite(event?.lat) || !Number.isFinite(event?.lng)) continue;
    let nearestIndex = 0;
    let nearestMeters = Infinity;
    validPoints.forEach((point, index) => {
      const meters = haversineMeters(point.lat, point.lng, event.lat, event.lng);
      if (meters < nearestMeters) {
        nearestMeters = meters;
        nearestIndex = index;
      }
    });
    keepFlags[nearestIndex] = true;
  }

  const reduce = (start, end) => {
    if (end <= start + 1) return;

    let maxDistance = 0;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      if (keepFlags[i]) continue;
      const distance = perpendicularDistanceMeters(validPoints[i], validPoints[start], validPoints[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    if (maxDistance > toleranceMeters) {
      keepFlags[maxIndex] = true;
      reduce(start, maxIndex);
      reduce(maxIndex, end);
    }
  };

  const anchors = keepFlags
    .map((keep, index) => keep ? index : null)
    .filter((index) => index !== null)
    .sort((a, b) => a - b);

  for (let i = 1; i < anchors.length; i++) {
    reduce(anchors[i - 1], anchors[i]);
  }

  return validPoints.filter((_, index) => keepFlags[index]);
}

export function calculateRouteSummary(points, startTime, endTime, thresholds = DEFAULT_THRESHOLDS) {
  const cleaned = cleanRoutePoints(points, thresholds);
  const stats = calculateTripStats(cleaned, startTime, endTime, thresholds);
  const events = detectDrivingEvents(cleaned, thresholds);
  const scores = calculateTripScores(events, stats, cleaned, thresholds, stats.duration_seconds);
  return { points: cleaned, stats, events, scores };
}

// ─── Event Detection ───────────────────────────────────────────────────────────
function finiteSpeed(point) {
  return Number.isFinite(point?.speed_kmh) ? Math.max(0, point.speed_kmh) : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function calculateRouteDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) distance += segment.distanceKm;
  }
  return distance;
}

function calculateHighwayDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;
    if (Math.max(finiteSpeed(points[i - 1]), finiteSpeed(points[i]), segment.reliableSpeedKmh) >= 80) {
      distance += segment.distanceKm;
    }
  }
  return distance;
}

export function classifyRoadType(cleanPoints = []) {
  const speeds = cleanPoints
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed > 0);

  if (!speeds.length) {
    return {
      road_type: 'urban',
      avg_highway_speed_kmh: 0,
      avg_urban_speed_kmh: 0,
      highway_fraction: 0,
    };
  }

  const highwaySpeeds = speeds.filter((speed) => speed >= 80);
  const urbanSpeeds = speeds.filter((speed) => speed >= 20 && speed < 80);
  const residentialSpeeds = speeds.filter((speed) => speed < 20);
  const total = speeds.length;
  const fHighway = highwaySpeeds.length / total;
  const fUrban = urbanSpeeds.length / total;
  const fResidential = residentialSpeeds.length / total;
  const avgSpeed = average(speeds);

  let roadType = 'urban';
  if (fHighway >= 0.60) roadType = 'highway';
  else if (fHighway >= 0.30 && fUrban >= 0.30) roadType = 'mixed';
  else if (fResidential >= 0.50 && avgSpeed < 30) roadType = 'residential';

  return {
    road_type: roadType,
    avg_highway_speed_kmh: round1(average(highwaySpeeds)),
    avg_urban_speed_kmh: round1(average(urbanSpeeds)),
    highway_fraction: round1(fHighway * 100) / 100,
  };
}

export function calculateJerkScore(cleanPoints = [], distanceKmOrThresholds = 1) {
  if (!cleanPoints || cleanPoints.length < 3) {
    return { jerk_score: 100, jerk_event_count: 0, avg_jerk_ms3: 0 };
  }

  const distanceKm = typeof distanceKmOrThresholds === 'number'
    ? distanceKmOrThresholds
    : calculateRouteDistanceKm(cleanPoints, distanceKmOrThresholds || DEFAULT_THRESHOLDS);
  let totalJerkPenalty = 0;
  let jerkEventCount = 0;
  let jerkAbsTotal = 0;
  let jerkSampleCount = 0;

  for (let i = 1; i < cleanPoints.length - 1; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const next = cleanPoints[i + 1];
    const dt1 = (timestampMs(curr) - timestampMs(prev)) / 1000;
    const dt2 = (timestampMs(next) - timestampMs(curr)) / 1000;
    if (dt1 <= 0 || dt2 <= 0 || dt1 > 60 || dt2 > 60) continue;

    const v0 = finiteSpeed(prev) / 3.6;
    const v1 = finiteSpeed(curr) / 3.6;
    const v2 = finiteSpeed(next) / 3.6;
    const a1 = (v1 - v0) / dt1;
    const a2 = (v2 - v1) / dt2;
    const jerk = (a2 - a1) / ((dt1 + dt2) / 2);
    const absJerk = Math.abs(jerk);
    if (!Number.isFinite(absJerk)) continue;

    jerkAbsTotal += absJerk;
    jerkSampleCount++;
    if (absJerk > 6) totalJerkPenalty += 4;
    else if (absJerk > 3) totalJerkPenalty += 2;
    else if (absJerk > 1.5) totalJerkPenalty += 1;
    if (absJerk > 1.5) jerkEventCount++;
  }

  const distFactor = Math.max(1, distanceKm || 0);
  const jerkScore = Math.max(0, 100 - Math.min(totalJerkPenalty * (4 / distFactor), 80));
  return {
    jerk_score: Math.round(jerkScore),
    jerk_event_count: jerkEventCount,
    avg_jerk_ms3: round1(jerkSampleCount ? jerkAbsTotal / jerkSampleCount : 0),
  };
}

export function calculateHillDrivingScore(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const altitudePoints = cleanPoints.filter((point) => Number.isFinite(point?.altitude));
  if (!cleanPoints.length || altitudePoints.length / cleanPoints.length < 0.5) {
    return {
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
    };
  }

  let climbDistanceKm = 0;
  let descentDistanceKm = 0;
  let infractionCount = 0;
  let descentWindowStart = null;
  let descentWindowSpeed = 0;
  const harshBrakeThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    if (!Number.isFinite(prev.altitude) || !Number.isFinite(curr.altitude)) continue;

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 120) continue;

    const distanceM = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    if (distanceM < 5) continue;

    const gradient = ((curr.altitude - prev.altitude) / distanceM) * 100;
    const accelMs2 = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
    const isClimb = gradient >= 5;
    const isDescent = gradient <= -5;

    if (isClimb) {
      climbDistanceKm += distanceM / 1000;
      if (accelMs2 > 2.5) infractionCount++;
      descentWindowStart = null;
    } else if (isDescent) {
      descentDistanceKm += distanceM / 1000;
      if (accelMs2 < -harshBrakeThreshold) infractionCount++;

      if (!descentWindowStart || (timestampMs(curr) - timestampMs(descentWindowStart)) / 1000 > 10) {
        descentWindowStart = curr;
        descentWindowSpeed = finiteSpeed(curr);
      } else if (finiteSpeed(curr) - descentWindowSpeed > 15) {
        infractionCount++;
        descentWindowStart = curr;
        descentWindowSpeed = finiteSpeed(curr);
      }
    } else {
      descentWindowStart = null;
    }
  }

  return {
    climb_distance_km: Math.round(climbDistanceKm * 100) / 100,
    descent_distance_km: Math.round(descentDistanceKm * 100) / 100,
    hill_infraction_count: infractionCount,
    hill_driving_score: Math.max(0, 100 - infractionCount * 10),
  };
}

export function calculateEcoDrivingScore(cleanPoints = [], stats = {}) {
  const movingSpeeds = cleanPoints
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed >= 15);

  if (movingSpeeds.length < 3) {
    return { eco_driving_score: 50, speed_stability: 50, cruise_score: 50 };
  }

  const mean = average(movingSpeeds);
  const variance = average(movingSpeeds.map((speed) => (speed - mean) ** 2));
  const cv = Math.sqrt(variance) / Math.max(1, mean);
  const speedStability = Math.max(0, 100 - cv * 150);
  const cruiseRatio = movingSpeeds.filter((speed) => speed >= 55 && speed <= 90).length / movingSpeeds.length;
  const cruiseScore = Math.min(100, cruiseRatio * 130);
  const idleRatio = (stats.idle_time_seconds || 0) / Math.max(1, stats.duration_seconds || 0);
  const idlePenalty = Math.min(30, idleRatio * 200);
  const ecoDrivingScore = Math.round(
    speedStability * 0.40 +
    cruiseScore * 0.35 +
    Math.max(0, 100 - idlePenalty) * 0.25
  );

  return {
    eco_driving_score: ecoDrivingScore,
    speed_stability: Math.round(speedStability),
    cruise_score: Math.round(cruiseScore),
  };
}

export function calculateSpeedVariabilityIndex(cleanPoints = []) {
  const samples = cleanPoints
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed > 0);

  if (samples.length < 3) {
    return { speed_variability_index: 0, svi_score: 100, svi_label: 'unknown' };
  }

  const mean = average(samples);
  const variance = average(samples.map((speed) => (speed - mean) ** 2));
  const svi = round1(Math.sqrt(variance));
  const sviScore = Math.max(0, Math.round(100 - svi * 1.5));
  const sviLabel = svi < 10
    ? 'very smooth'
    : svi < 20
      ? 'smooth'
      : svi < 35
        ? 'variable'
        : svi < 50
          ? 'erratic'
          : 'very erratic';

  return {
    speed_variability_index: svi,
    svi_score: sviScore,
    svi_label: sviLabel,
  };
}

export function calculateFuelBandScore(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  let totalMovingSeconds = 0;
  let optimalBandSeconds = 0;
  let highSpeedSeconds = 0;
  let cityCrawlSeconds = 0;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const segment = calculateSegmentMetrics(prev, curr, thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

    const speed = segment.reliableSpeedKmh;
    const accelMs2 = calculateAcceleration(finiteSpeed(prev), speed, segment.dt);
    if (speed > 5) totalMovingSeconds += segment.dt;
    if (speed >= 60 && speed <= 90 && accelMs2 >= -0.5 && accelMs2 <= 0.5) optimalBandSeconds += segment.dt;
    if (speed > 100) highSpeedSeconds += segment.dt;
    if (speed > 5 && speed < 30) cityCrawlSeconds += segment.dt;
  }

  const optimalBandRatio = totalMovingSeconds > 0 ? Math.round((optimalBandSeconds / totalMovingSeconds) * 100) : 0;
  const fuelBandScore = Math.min(100, Math.round(optimalBandRatio * 2.0));
  const bandLabel = fuelBandScore >= 80
    ? 'excellent cruise'
    : fuelBandScore >= 55
      ? 'good cruise'
      : fuelBandScore >= 35
        ? 'mixed'
        : 'stop-and-go';

  return {
    optimal_band_ratio: optimalBandRatio,
    fuel_band_score: fuelBandScore,
    band_label: bandLabel,
    high_speed_ratio: totalMovingSeconds > 0 ? Math.round((highSpeedSeconds / totalMovingSeconds) * 100) : 0,
    city_crawl_ratio: totalMovingSeconds > 0 ? Math.round((cityCrawlSeconds / totalMovingSeconds) * 100) : 0,
  };
}

function headingBetweenPair(prev, curr, fallbackPrev = null) {
  if (Number.isFinite(prev?.heading) && Number.isFinite(curr?.heading)) {
    return { h1: prev.heading, h2: curr.heading };
  }
  const h1 = Number.isFinite(prev?.heading)
    ? prev.heading
    : fallbackPrev
      ? calculateBearing(fallbackPrev.lat, fallbackPrev.lng, prev.lat, prev.lng)
      : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  const h2 = Number.isFinite(curr?.heading)
    ? curr.heading
    : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  return { h1, h2 };
}

export function detectLaneChanges(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 2) return [];

  const candidates = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (finiteSpeed(prev) <= 80 || finiteSpeed(curr) <= 80) continue;

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
    const turnRate = headingDiff(h1, h2) / dt;
    if (turnRate > 2 && turnRate < 20) candidates.push({ point: curr, turnRate });
  }

  const merged = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const candidateTime = timestampMs(candidate.point);
    if (previous && (candidateTime - previous.lastTime) / 1000 <= 3) {
      previous.lastTime = candidateTime;
      if (candidate.turnRate > previous.turnRate) {
        previous.turnRate = candidate.turnRate;
        previous.point = candidate.point;
      }
    } else {
      merged.push({ ...candidate, lastTime: candidateTime });
    }
  }

  const distanceKm = Math.max(1, calculateRouteDistanceKm(points, thresholds));
  const ratePer10Km = (merged.length / distanceKm) * 10;
  const severity = ratePer10Km >= 4 ? 'high' : ratePer10Km >= 2 ? 'medium' : 'low';

  return merged.map(({ point, turnRate }) => ({
    type: EVENT_TYPES.LANE_CHANGE,
    severity,
    lat: point.lat,
    lng: point.lng,
    timestamp: point.timestamp,
    value: round1(turnRate),
  }));
}

export function detectHighwayMergeBehavior(cleanPoints = []) {
  let mergeEventCount = 0;
  let poorMergeCount = 0;
  let harshMergeCount = 0;
  let windowStart = null;

  for (const point of cleanPoints) {
    const speed = finiteSpeed(point);
    if (!windowStart && speed < 70) {
      windowStart = point;
      continue;
    }

    if (!windowStart) continue;

    const duration = (timestampMs(point) - timestampMs(windowStart)) / 1000;
    if (duration <= 0) continue;
    if (duration > 20) {
      windowStart = speed < 70 ? point : null;
      continue;
    }

    if (speed > 95) {
      const entrySpeed = finiteSpeed(windowStart);
      const exitSpeed = speed;
      const accelMs2 = ((exitSpeed / 3.6) - (entrySpeed / 3.6)) / duration;
      const quality = exitSpeed < 90 || duration < 5
        ? 'poor'
        : accelMs2 > 4.0
          ? 'harsh'
          : 'good';

      mergeEventCount++;
      if (quality === 'poor') poorMergeCount++;
      if (quality === 'harsh') harshMergeCount++;
      windowStart = null;
    }
  }

  return {
    merge_event_count: mergeEventCount,
    poor_merge_count: poorMergeCount,
    harsh_merge_count: harshMergeCount,
    merge_score: Math.max(0, 100 - poorMergeCount * 8 - harshMergeCount * 6),
  };
}

export function detectTailgateCycles(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!cleanPoints || cleanPoints.length < 3) return [];

  const events = [];
  const decelThreshold = thresholds.TAILGATE_DECEL_MS2 ?? DEFAULT_THRESHOLDS.TAILGATE_DECEL_MS2;
  let state = 'IDLE';
  let cruiseStartTime = null;
  let cruiseSpeed = 0;
  let decelStartTime = null;
  let maxDecel = 0;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) {
      state = 'IDLE';
      cruiseStartTime = null;
      continue;
    }

    const prevSpeed = finiteSpeed(prev);
    const currSpeed = finiteSpeed(curr);
    const accel = calculateAcceleration(prevSpeed, currSpeed, dt);

    if (state === 'IDLE') {
      if (currSpeed >= 80) {
        state = 'CRUISING';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      }
      continue;
    }

    if (state === 'CRUISING') {
      if (currSpeed >= 80) {
        cruiseSpeed = Math.max(cruiseSpeed, currSpeed);
      } else if ((timestampMs(curr) - cruiseStartTime) / 1000 < 5) {
        state = 'IDLE';
        cruiseStartTime = null;
        continue;
      }

      const harshBrake = accel <= -(thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2);
      if (accel < -decelThreshold && !harshBrake) {
        state = 'DECELERATING';
        decelStartTime = timestampMs(curr);
        maxDecel = Math.abs(accel);
      }
      continue;
    }

    if (state === 'DECELERATING') {
      maxDecel = Math.max(maxDecel, Math.abs(accel));
      const elapsed = (timestampMs(curr) - decelStartTime) / 1000;
      const speedDrop = cruiseSpeed - currSpeed;

      if (speedDrop > 15 && elapsed <= 10) {
        events.push({
          type: EVENT_TYPES.TAILGATE_CYCLE,
          severity: maxDecel > 4.0 && speedDrop > 30 ? 'high' : maxDecel > 3.0 && speedDrop > 20 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: Math.round(speedDrop),
          speed_kmh: Math.round(cruiseSpeed),
        });
        state = currSpeed >= 60 ? 'CRUISING' : 'IDLE';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      } else if (elapsed > 10 || currSpeed < 60) {
        state = currSpeed >= 60 ? 'CRUISING' : 'IDLE';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      }
    }
  }

  return events;
}

export function calculateWindowStats(speedArray = []) {
  const mean = average(speedArray);
  const variance = speedArray.length ? average(speedArray.map((speed) => (speed - mean) ** 2)) : 0;
  const stddev = Math.sqrt(variance);
  return {
    mean,
    stddev,
    oscillationRatio: stddev / Math.max(1, mean),
  };
}

function stddev(values = []) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function signedHeadingDelta(from, to) {
  let diff = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(diff)) diff = 0;
  return diff;
}

function headingForIndex(points, index) {
  const point = points[index];
  if (Number.isFinite(point?.heading)) return point.heading;
  if (index > 0) {
    const prev = points[index - 1];
    return calculateBearing(prev.lat, prev.lng, point.lat, point.lng);
  }
  if (points[index + 1]) {
    const next = points[index + 1];
    return calculateBearing(point.lat, point.lng, next.lat, next.lng);
  }
  return 0;
}

export function calculateAngularStdDev(headings = []) {
  const finite = headings.filter((heading) => Number.isFinite(heading));
  if (finite.length < 2) return 0;

  const vectors = finite.map((heading) => {
    const rad = toRad(heading);
    return { x: Math.cos(rad), y: Math.sin(rad) };
  });
  const meanX = average(vectors.map((vector) => vector.x));
  const meanY = average(vectors.map((vector) => vector.y));
  const meanAngle = Math.atan2(meanY, meanX) * 180 / Math.PI;
  const deltas = finite.map((heading) => signedHeadingDelta(meanAngle, heading));
  return stddev(deltas);
}

export function detectErraticSpeedWindows(cleanPoints = []) {
  const samples = cleanPoints
    .map((point) => ({ point, timestamp: timestampMs(point), speed_kmh: finiteSpeed(point) }))
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.speed_kmh > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const events = [];
  let distractionDurationSeconds = 0;
  if (samples.length < 4) return Object.assign(events, { distraction_duration_seconds: 0 });

  const flagged = [];
  const firstTime = samples[0].timestamp;
  const lastTime = samples[samples.length - 1].timestamp;
  for (let start = firstTime; start <= lastTime - 30000; start += 5000) {
    const end = start + 30000;
    const windowSamples = samples.filter((sample) => (
      sample.timestamp >= start &&
      sample.timestamp <= end &&
      sample.speed_kmh >= 15 &&
      sample.speed_kmh <= 65
    ));
    if (windowSamples.length < 4) continue;

    const stats = calculateWindowStats(windowSamples.map((sample) => sample.speed_kmh));
    if (stats.oscillationRatio > 0.25) flagged.push({ start, end, point: windowSamples[0].point });
  }

  const merged = [];
  for (const window of flagged) {
    const previous = merged[merged.length - 1];
    if (previous && (window.start - previous.end) / 1000 < 10) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  for (const episode of merged) {
    const durationSeconds = Math.round((episode.end - episode.start) / 1000);
    if (durationSeconds < 20) continue;
    distractionDurationSeconds += durationSeconds;
    events.push({
      type: EVENT_TYPES.ERRATIC_SPEED,
      severity: durationSeconds > 120 ? 'high' : durationSeconds > 60 ? 'medium' : 'low',
      lat: episode.point.lat,
      lng: episode.point.lng,
      timestamp: episode.point.timestamp,
      value: durationSeconds,
    });
  }

  return Object.assign(events, { distraction_duration_seconds: distractionDurationSeconds });
}

export function detectSpeedCreep(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const creepThreshold = thresholds.threshold_speed_creep_kmh ?? DEFAULT_THRESHOLDS.threshold_speed_creep_kmh;
  const samples = cleanPoints
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: finiteSpeed(point),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.speed_kmh > 0);
  let count = 0;
  let maxCreep = 0;
  const severityCounts = { low: 0, medium: 0, high: 0 };
  let lastEventTime = 0;

  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.timestamp - lastEventTime < 30000) continue;

    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 30000);
    if (window.length < 3 || window[window.length - 1].timestamp - start.timestamp < 25000) continue;

    const headingStdDev = calculateAngularStdDev(window.map((sample) => sample.heading));
    if (headingStdDev >= 5) continue;

    const creep = window[window.length - 1].speed_kmh - window[0].speed_kmh;
    if (creep >= creepThreshold && window[window.length - 1].speed_kmh > 80) {
      const severity = creep >= 25 ? 'high' : creep >= 15 ? 'medium' : 'low';
      severityCounts[severity]++;
      count++;
      maxCreep = Math.max(maxCreep, creep);
      lastEventTime = start.timestamp;
    }
  }

  return {
    speed_creep_event_count: count,
    max_speed_creep_kmh: Math.round(maxCreep),
    speed_creep_score: Math.max(0, 100 - count * 12),
    speed_creep_severity_counts: severityCounts,
  };
}

export function detectSpeedCreepWithThresholds(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const creepThreshold = thresholds.threshold_speed_creep_kmh ?? DEFAULT_THRESHOLDS.threshold_speed_creep_kmh;
  const result = detectSpeedCreep(cleanPoints, thresholds);
  if (creepThreshold === 10) return result;

  const samples = cleanPoints
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: finiteSpeed(point),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.speed_kmh > 0);
  let count = 0;
  let maxCreep = 0;
  const severityCounts = { low: 0, medium: 0, high: 0 };
  let lastEventTime = 0;

  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.timestamp - lastEventTime < 30000) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 30000);
    if (window.length < 3 || window[window.length - 1].timestamp - start.timestamp < 25000) continue;
    if (headingStdDev(window.map((sample) => sample.heading)) >= 5) continue;

    const creep = window[window.length - 1].speed_kmh - window[0].speed_kmh;
    if (creep >= creepThreshold && window[window.length - 1].speed_kmh > 80) {
      const severity = creep >= 25 ? 'high' : creep >= 15 ? 'medium' : 'low';
      severityCounts[severity]++;
      count++;
      maxCreep = Math.max(maxCreep, creep);
      lastEventTime = start.timestamp;
    }
  }

  return {
    speed_creep_event_count: count,
    max_speed_creep_kmh: Math.round(maxCreep),
    speed_creep_score: Math.max(0, 100 - count * 12),
    speed_creep_severity_counts: severityCounts,
  };
}

export function detectPhoneUsageProxy(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const oscillationThreshold = thresholds.threshold_phone_proxy_oscillations ?? DEFAULT_THRESHOLDS.threshold_phone_proxy_oscillations;
  const samples = cleanPoints
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: finiteSpeed(point),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && sample.speed_kmh > 30);
  let count = 0;
  let lastEventTime = 0;

  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.timestamp - lastEventTime < 15000) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 15000);
    if (window.length < 5) continue;

    const changes = [];
    const signedChanges = [];
    for (let j = 1; j < window.length; j++) {
      const delta = signedHeadingDelta(window[j - 1].heading, window[j].heading);
      signedChanges.push(delta);
      changes.push(Math.abs(delta));
    }

    let oscillationCount = 0;
    for (let j = 1; j < signedChanges.length; j++) {
      if (
        Math.abs(signedChanges[j]) > 4 &&
        Math.abs(signedChanges[j - 1]) > 4 &&
        Math.sign(signedChanges[j]) !== Math.sign(signedChanges[j - 1])
      ) {
        oscillationCount++;
      }
    }

    const maxSnapBack = changes.length ? Math.max(...changes) : 0;
    const windowSpeedStdDev = speedStdDev(window.map((sample) => sample.speed_kmh));
    if (oscillationCount >= oscillationThreshold && maxSnapBack >= 10 && maxSnapBack < 45 && windowSpeedStdDev < 8) {
      count++;
      lastEventTime = start.timestamp;
    }
  }

  return {
    phone_proxy_count: count,
    phone_proxy_risk: count === 0 ? 'none' : count <= 2 ? 'possible' : 'likely',
  };
}

export function detectPhoneProxy(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  return detectPhoneUsageProxy(cleanPoints, thresholds);
}

export function analyzeIntersectionBehavior(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const intersectionEvents = [];
  let state = 'MOVING';
  let approachStart = null;
  let stopPoint = null;
  let minSpeed = Infinity;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const prevSpeed = finiteSpeed(prev);
    const currSpeed = finiteSpeed(curr);

    if (state === 'MOVING' && prevSpeed > 20 && currSpeed < 20) {
      state = 'APPROACHING';
      approachStart = prev;
      minSpeed = currSpeed;
    }

    if (state === 'APPROACHING') {
      minSpeed = Math.min(minSpeed, currSpeed);
      if (currSpeed < 5) {
        state = 'STOPPED';
        stopPoint = curr;
      } else if (currSpeed > 25) {
        state = 'MOVING';
        approachStart = null;
      }
    }

    if (state === 'STOPPED') {
      minSpeed = Math.min(minSpeed, currSpeed);
      if (currSpeed > 8 && approachStart && stopPoint) {
        const duration = Math.max(1, (timestampMs(stopPoint) - timestampMs(approachStart)) / 1000);
        const decel = (finiteSpeed(approachStart) / 3.6) / duration;
        const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
        const approachGrade = decel < 2.0
          ? 'smooth'
          : decel <= 3.5 || decel >= harshThreshold
            ? 'acceptable'
            : 'late';

        intersectionEvents.push({
          type: 'intersection',
          approach_grade: approachGrade,
          rolling_stop: minSpeed > 2.5,
          lat: stopPoint.lat,
          lng: stopPoint.lng,
          timestamp: stopPoint.timestamp,
        });

        state = 'MOVING';
        approachStart = null;
        stopPoint = null;
        minSpeed = Infinity;
      }
    }
  }

  const stopCount = intersectionEvents.length;
  const rollingStopCount = intersectionEvents.filter((event) => event.rolling_stop).length;
  const smoothApproachCount = intersectionEvents.filter((event) => event.approach_grade === 'smooth').length;
  const lateCount = intersectionEvents.filter((event) => event.approach_grade === 'late').length;
  const penalty = lateCount * 2 + rollingStopCount * 3;
  const distFactor = Math.max(1, stopCount / 5);
  const intersectionScore = Math.max(0, 100 - Math.min(penalty * (3 / distFactor), 60));

  return {
    intersection_score: Math.round(intersectionScore),
    stop_count: stopCount,
    rolling_stop_count: rollingStopCount,
    smooth_approach_count: smoothApproachCount,
    intersection_events: intersectionEvents,
  };
}

export function calculateSmoothBrakingRatio(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  let state = 'MOVING';
  let windowPoints = [];
  let totalStops = 0;
  let harshStops = 0;

  const closeWindow = () => {
    if (windowPoints.length < 2) return;
    totalStops++;
    let harsh = false;
    for (let i = 1; i < windowPoints.length; i++) {
      const prev = windowPoints[i - 1];
      const curr = windowPoints[i];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 30) continue;
      if (calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt) < -harshThreshold) {
        harsh = true;
        break;
      }
    }
    if (harsh) harshStops++;
  };

  for (const point of cleanPoints) {
    const speed = finiteSpeed(point);
    if (state === 'MOVING') {
      if (speed >= 20) windowPoints = [point];
      else if (windowPoints.length && speed <= 5) {
        windowPoints.push(point);
        state = 'STOPPED';
        closeWindow();
      }
      else if (windowPoints.length && speed < 20 && speed > 5) {
        state = 'SLOWING';
        windowPoints.push(point);
      }
      continue;
    }

    if (state === 'SLOWING') {
      windowPoints.push(point);
      if (speed <= 5) {
        state = 'STOPPED';
        closeWindow();
      } else if (speed >= 25) {
        state = 'MOVING';
        windowPoints = [point];
      }
      continue;
    }

    if (state === 'STOPPED' && speed >= 10) {
      state = 'MOVING';
      windowPoints = speed >= 20 ? [point] : [];
    }
  }

  const smoothStops = Math.max(0, totalStops - harshStops);
  const smoothBrakingRatio = totalStops > 0 ? Math.round((smoothStops / totalStops) * 100) : 100;
  return {
    total_stops_detected: totalStops,
    harsh_stops_count: harshStops,
    smooth_stops_count: smoothStops,
    smooth_braking_ratio: smoothBrakingRatio,
    smooth_braking_score: smoothBrakingRatio,
  };
}

export function analyzeParkingApproach(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!cleanPoints || cleanPoints.length < 3) {
    return { parking_approach_score: 100, parking_approach_grade: 'smooth' };
  }

  const lastPoint = cleanPoints[cleanPoints.length - 1];
  const cutoff = timestampMs(lastPoint) - 30000;
  let startIndex = cleanPoints.findIndex((point) => timestampMs(point) >= cutoff);
  if (startIndex < 0) startIndex = Math.max(0, cleanPoints.length - 3);

  for (let i = cleanPoints.length - 1; i > 0; i--) {
    if (finiteSpeed(cleanPoints[i - 1]) >= 20 && finiteSpeed(cleanPoints[i]) < 20) {
      startIndex = Math.min(startIndex, i - 1);
      break;
    }
  }

  const window = cleanPoints.slice(startIndex);
  if (window.length < 3) {
    return { parking_approach_score: 100, parking_approach_grade: 'smooth' };
  }

  let penalty = 0;
  const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const accelMs2 = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
    const { h1, h2 } = headingBetweenPair(prev, curr, window[i - 2] || null);
    const headingRate = headingDiff(h1, h2) / dt;
    if (accelMs2 < -harshThreshold) penalty += 15;
    if (headingRate > 30 && finiteSpeed(curr) > 8) penalty += 8;
    if (finiteSpeed(curr) - finiteSpeed(prev) > 5) penalty += 5;
  }

  const score = Math.max(0, 100 - penalty);
  return {
    parking_approach_score: score,
    parking_approach_grade: score >= 90 ? 'smooth' : score >= 70 ? 'acceptable' : 'rough',
  };
}

function calculateSegmentStats(points = [], thresholds = DEFAULT_THRESHOLDS) {
  const start = timestampMs(points[0]);
  const end = timestampMs(points[points.length - 1]);
  const distanceKm = calculateRouteDistanceKm(points, thresholds);
  const durationSeconds = Math.max(0, (end - start) / 1000);
  return {
    distance_km: distanceKm,
    duration_seconds: durationSeconds,
    avg_speed_kmh: durationSeconds > 0 ? calculateSpeedKmh(distanceKm, durationSeconds) : 0,
    idle_time_seconds: 0,
    fatigue_risk_score: 0,
    intersection_score: 100,
  };
}

export function scoreSegmentPoints(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 3) return 0;
  const events = detectDrivingEvents(points, thresholds);
  const stats = calculateSegmentStats(points, thresholds);
  return calculateTripScores(events, stats, points, thresholds, stats.duration_seconds).score_overall;
}

export function analyzeFatigueProgression(cleanPoints = [], startTimeMs, endTimeMs, thresholds = DEFAULT_THRESHOLDS) {
  const start = Number.isFinite(startTimeMs) ? startTimeMs : timestampMs(cleanPoints[0]);
  const end = Number.isFinite(endTimeMs) ? endTimeMs : timestampMs(cleanPoints[cleanPoints.length - 1]);
  const totalDuration = end - start;
  if (!cleanPoints.length || totalDuration <= 0) {
    return { fatigue_progression: 'unknown', segment_scores: [] };
  }

  const third = totalDuration / 3;
  const segments = [[], [], []];
  for (const point of cleanPoints) {
    const offset = timestampMs(point) - start;
    const index = Math.min(2, Math.max(0, Math.floor(offset / third)));
    segments[index].push(point);
  }

  if (segments.some((segment) => segment.length < 3)) {
    return { fatigue_progression: 'unknown', segment_scores: [] };
  }

  const scores = segments.map((segment) => scoreSegmentPoints(segment, thresholds));
  const degradation = scores[0] - scores[2];
  const fatigueProgression = degradation >= 20
    ? 'significant'
    : degradation >= 10
      ? 'moderate'
      : degradation >= 0
        ? 'slight'
        : 'improving';

  return {
    fatigue_progression: fatigueProgression,
    segment_scores: scores,
    degradation: Math.round(degradation),
  };
}

export function detectDrowsyDrivingSignature(cleanPoints = [], durationSeconds = 0, thresholds = DEFAULT_THRESHOLDS) {
  if (!cleanPoints || cleanPoints.length < 4 || durationSeconds <= 0) {
    return { drowsy_window_count: 0, drowsy_risk_score: 0, drowsy_risk_level: 'none' };
  }

  const headingThreshold = thresholds.threshold_drowsy_heading_std ?? DEFAULT_THRESHOLDS.threshold_drowsy_heading_std;
  const startTime = timestampMs(cleanPoints[0]);
  let drowsyWindowCount = 0;
  let weightedScore = 0;

  for (let i = 0; i < cleanPoints.length; i++) {
    const start = cleanPoints[i];
    const startMs = timestampMs(start);
    const window = cleanPoints
      .slice(i)
      .filter((point) => timestampMs(point) >= startMs && timestampMs(point) <= startMs + 60000);
    if (window.length < 4) continue;
    if ((timestampMs(window[window.length - 1]) - startMs) < 45000) continue;
    if (!window.every((point) => finiteSpeed(point) > 80)) continue;

    const windowHeadingStdDev = headingStdDev(window.map((_, offset) => headingForIndex(cleanPoints, i + offset)));
    const windowSpeedStdDev = speedStdDev(window.map((point) => finiteSpeed(point)));
    if (windowHeadingStdDev > headingThreshold && windowSpeedStdDev < 6) {
      const elapsedFraction = Math.max(0, (startMs - startTime) / 1000) / Math.max(1, durationSeconds);
      weightedScore += 1 + elapsedFraction;
      drowsyWindowCount++;
      i += Math.max(1, window.length - 1);
    }
  }

  const riskScore = Math.min(100, Math.round(weightedScore * 15));
  return {
    drowsy_window_count: drowsyWindowCount,
    drowsy_risk_score: riskScore,
    drowsy_risk_level: riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : riskScore > 0 ? 'low' : 'none',
  };
}

export function detectDrowsyDriving(cleanPoints = [], durationSeconds = 0, thresholds = DEFAULT_THRESHOLDS) {
  return detectDrowsyDrivingSignature(cleanPoints, durationSeconds, thresholds);
}

export function detectAggressiveOvertakes(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!cleanPoints || cleanPoints.length < 5) {
    return Object.assign(events, { overtake_event_count: 0, overtake_score: 100 });
  }

  const accelThreshold = thresholds.threshold_overtake_accel_ms2 ?? DEFAULT_THRESHOLDS.threshold_overtake_accel_ms2;
  let lastEventTime = 0;
  for (let i = 0; i < cleanPoints.length; i++) {
    const start = cleanPoints[i];
    const startMs = timestampMs(start);
    if (startMs - lastEventTime < 15000) continue;
    const window = cleanPoints
      .slice(i)
      .filter((point) => timestampMs(point) >= startMs && timestampMs(point) <= startMs + 15000);
    if (window.length < 5 || !window.every((point) => finiteSpeed(point) > 80)) continue;

    let phase = 'NONE';
    let accelSeconds = 0;
    let accelEndMs = null;
    let changeMs = null;
    let changePoint = null;
    let maxAccel = 0;
    let minDecel = 0;
    let headingRatePeak = 0;

    for (let j = 1; j < window.length; j++) {
      const prev = window[j - 1];
      const curr = window[j];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 5) continue;
      const accel = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
      const { h1, h2 } = headingBetweenPair(prev, curr, window[j - 2] || null);
      const headingRate = headingDiff(h1, h2) / dt;

      if (phase === 'NONE') {
        if (accel > accelThreshold) {
          accelSeconds += dt;
          maxAccel = Math.max(maxAccel, accel);
          if (accelSeconds >= 2) {
            phase = 'ACCEL';
            accelEndMs = timestampMs(curr);
          }
        } else {
          accelSeconds = 0;
        }
      } else if (phase === 'ACCEL') {
        maxAccel = Math.max(maxAccel, accel);
        if ((timestampMs(curr) - accelEndMs) / 1000 > 5) break;
        if (headingRate > 15) {
          phase = 'CHANGE';
          changeMs = timestampMs(curr);
          changePoint = curr;
          headingRatePeak = headingRate;
        }
      } else if (phase === 'CHANGE') {
        headingRatePeak = Math.max(headingRatePeak, headingRate);
        if ((timestampMs(curr) - changeMs) / 1000 > 5) break;
        if (accel < -2.5) {
          minDecel = Math.min(minDecel, accel);
          const severity = maxAccel > 5.0 && minDecel < -4.0 && headingRatePeak > 30
            ? 'high'
            : maxAccel > 4.0 && minDecel < -3.0
              ? 'medium'
              : 'low';
          events.push({
            type: EVENT_TYPES.AGGRESSIVE_OVERTAKE,
            severity,
            lat: changePoint?.lat ?? curr.lat,
            lng: changePoint?.lng ?? curr.lng,
            timestamp: changePoint?.timestamp ?? curr.timestamp,
            value: round1(maxAccel),
            speed_kmh: Math.round(finiteSpeed(curr)),
          });
          lastEventTime = startMs;
          break;
        }
      }
    }
  }

  return Object.assign(events, {
    overtake_event_count: events.length,
    overtake_score: Math.max(0, 100 - events.length * 20),
  });
}

export function detectDrivingEvents(points, thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!points || points.length < 3) return events;

  const EVENT_COOLDOWN_SECONDS = {
    [EVENT_TYPES.HARSH_BRAKE]: 4,
    [EVENT_TYPES.RAPID_ACCELERATION]: 4,
    [EVENT_TYPES.SHARP_TURN]: 3,
    [EVENT_TYPES.SPEEDING]: 10,
  };
  const lastEventTime = {
    [EVENT_TYPES.HARSH_BRAKE]: null,
    [EVENT_TYPES.RAPID_ACCELERATION]: null,
    [EVENT_TYPES.SHARP_TURN]: null,
    [EVENT_TYPES.SPEEDING]: null,
  };
  const MIN_POINTS_BEFORE_EVENTS = 2;
  const MIN_SPEEDING_SECONDS = 3;
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const smoothedAccels = computeSmoothedAccelerations(points, thresholds);
  const { road_type: roadType } = classifyRoadType(points);
  const configuredSpeedThreshold = thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  const contextSpeedingThreshold = roadType === 'residential'
    ? Math.min(configuredSpeedThreshold, 60)
    : roadType === 'urban'
      ? Math.min(configuredSpeedThreshold, 90)
      : configuredSpeedThreshold;

  let idleStart = null;
  let idleAccum = 0;
  let previousReliableSpeed = points[0]?.speed_kmh ?? 0;
  let acceptedSegmentCount = 0;
  let speedingAccumSeconds = 0;
  let speedingStart = null;
  let speedingPeakPoint = null;
  let speedingPeakSpeed = 0;

  const canEmitEvent = (eventType, timestamp) => {
    const cooldownSeconds = EVENT_COOLDOWN_SECONDS[eventType];
    if (!cooldownSeconds) return true;

    const tsSec = new Date(timestamp).getTime() / 1000;
    if (!Number.isFinite(tsSec)) return true;

    const lastTime = lastEventTime[eventType];
    if (lastTime !== null && (tsSec - lastTime) < cooldownSeconds) return false;

    lastEventTime[eventType] = tsSec;
    return true;
  };

  const pushEvent = (event) => {
    if (!canEmitEvent(event.type, event.timestamp)) return false;
    events.push(event);
    return true;
  };

  const speedingSeverity = (speed) => (
    speed > 160 ? 'high' : speed > 140 ? 'medium' : 'low'
  );

  const flushSpeedingWindow = () => {
    if (speedingAccumSeconds >= MIN_SPEEDING_SECONDS && speedingStart) {
      const eventPoint = speedingPeakPoint || speedingStart;
      pushEvent({
        type: EVENT_TYPES.SPEEDING,
        severity: speedingSeverity(speedingPeakSpeed),
        lat: eventPoint.lat,
        lng: eventPoint.lng,
        timestamp: speedingStart.timestamp,
        value: Math.round(speedingPeakSpeed),
        speed_kmh: Math.round(speedingPeakSpeed),
      });
    }

    speedingAccumSeconds = 0;
    speedingStart = null;
    speedingPeakPoint = null;
    speedingPeakSpeed = 0;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    const dt = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000; // seconds
    if (dt <= 0 || dt > 120) {
      flushSpeedingWindow();
      continue; // skip gaps > 2 minutes (possible pause)
    }

    const currSegment = calculateSegmentMetrics(prev, curr, thresholds);
    if (currSegment.isNoise) {
      flushSpeedingWindow();
      continue;
    }

    acceptedSegmentCount++;
    const speed2 = currSegment.reliableSpeedKmh;

    if (acceptedSegmentCount <= MIN_POINTS_BEFORE_EVENTS) {
      previousReliableSpeed = speed2;
      continue;
    }

    const smooth = smoothedAccels[i];
    const speed1 = smooth?.speed_kmh ?? previousReliableSpeed;
    const accel = smooth?.accel_ms2 ?? null;

    // ── Harsh Braking
    // Threshold: deceleration > 4.5 m/s² while above 20 km/h (to avoid parking noise)
    if (accel != null && accel < -thresholds.HARSH_BRAKE_MS2 && speed1 >= (thresholds.MIN_SPEED_HARSH_BRAKE_KMH ?? 25)) {
      pushEvent({
        type: EVENT_TYPES.HARSH_BRAKE,
        severity: Math.abs(accel) > 6 ? 'high' : Math.abs(accel) > 5 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        value: Math.abs(accel),
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Rapid Acceleration
    // Threshold: acceleration > 3.5 m/s² from speed > 5 km/h
    if (accel != null && accel > thresholds.RAPID_ACCEL_MS2 && speed1 >= (thresholds.MIN_SPEED_RAPID_ACCEL_KMH ?? 15)) {
      pushEvent({
        type: EVENT_TYPES.RAPID_ACCELERATION,
        severity: accel > 5 ? 'high' : accel > 4 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        value: accel,
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Sharp Turn
    // Heading change > 45°/s while above 30 km/h. At lower speeds turns are normal.
    if (speed2 > 25) {
      const h1 = prev.heading ?? calculateBearing(
        i > 1 ? points[i - 2].lat : prev.lat,
        i > 1 ? points[i - 2].lng : prev.lng,
        prev.lat, prev.lng
      );
      const h2 = curr.heading ?? calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
      const rawHeadingChange = headingDiff(h1, h2);
      const effectiveDt = Math.min(dt, 2.0);
      const omegaRadPerSec = (rawHeadingChange * Math.PI / 180) / effectiveDt;
      const vMps = speed2 / 3.6;
      const lateralG = (vMps * vMps * omegaRadPerSec) / 9.81;
      const lowG = thresholds.SHARP_TURN_G_LOW ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW;
      const mediumG = thresholds.SHARP_TURN_G_MEDIUM ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM;
      const highG = thresholds.SHARP_TURN_G_HIGH ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH;

      if (lateralG >= lowG) {
        pushEvent({
          type: EVENT_TYPES.SHARP_TURN,
          severity: lateralG >= highG ? 'high' : lateralG >= mediumG ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: Math.round(lateralG * 100) / 100,
          speed_kmh: Math.round(speed2),
        });
      }
    }

    // ── Speeding (fallback – no speed limit data)
    // Flag when speed exceeds the fallback threshold (default 130 km/h)
    const nearMissBrakeThreshold = thresholds.threshold_near_miss_brake_ms2 ?? DEFAULT_THRESHOLDS.threshold_near_miss_brake_ms2;
    const nearMissTurnThreshold = thresholds.threshold_near_miss_turn_degs ?? DEFAULT_THRESHOLDS.threshold_near_miss_turn_degs;
    if (advancedSafetyEnabled && accel != null && dt <= 2.0 && speed2 > 40 && accel < -nearMissBrakeThreshold) {
      const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
      const headingRate = headingDiff(h1, h2) / dt;
      if (headingRate > nearMissTurnThreshold) {
        pushEvent({
          type: EVENT_TYPES.NEAR_MISS,
          severity: accel < -5.5 && headingRate > 60 ? 'high' : accel < -4.5 && headingRate > 45 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: round1(Math.abs(accel)),
          speed_kmh: Math.round(speed2),
        });
      }
    }

    if (speed2 > contextSpeedingThreshold) {
      if (!speedingStart) speedingStart = curr;
      speedingAccumSeconds += dt;
      if (speed2 > speedingPeakSpeed) {
        speedingPeakSpeed = speed2;
        speedingPeakPoint = curr;
      }
    } else {
      flushSpeedingWindow();
    }

    // ── Idle accumulation
    if (speed2 < thresholds.IDLE_SPEED_KMH) {
      if (!idleStart) idleStart = curr.timestamp;
      idleAccum += dt;
    } else {
      if (idleAccum >= thresholds.IDLE_EVENT_SECONDS) {
        events.push({
          type: EVENT_TYPES.IDLE,
          severity: idleAccum > 300 ? 'high' : idleAccum > 180 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: idleStart,
          value: idleAccum,
        });
      }
      idleStart = null;
      idleAccum = 0;
    }

    previousReliableSpeed = speed2;
  }

  flushSpeedingWindow();

  // Flush any open idle window at trip end.
  if (idleAccum >= thresholds.IDLE_EVENT_SECONDS && idleStart) {
    const lastPoint = points[points.length - 1];
    events.push({
      type: EVENT_TYPES.IDLE,
      severity: idleAccum > 300 ? 'high' : idleAccum > 180 ? 'medium' : 'low',
      lat: lastPoint.lat,
      lng: lastPoint.lng,
      timestamp: lastPoint.timestamp,
      value: Math.round(idleAccum),
    });
  }

  const alwaysOnEvents = [
    detectLaneChanges(points, thresholds),
    detectTailgateCycles(points, thresholds),
    detectErraticSpeedWindows(points),
  ];
  if (advancedSafetyEnabled) alwaysOnEvents.push(detectAggressiveOvertakes(points, thresholds));

  return events.concat(...alwaysOnEvents);
}

export function detectNearMisses(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!cleanPoints || cleanPoints.length < 2) return events;

  const brakeThreshold = thresholds.threshold_near_miss_brake_ms2 ?? DEFAULT_THRESHOLDS.threshold_near_miss_brake_ms2;
  const turnThreshold = thresholds.threshold_near_miss_turn_degs ?? DEFAULT_THRESHOLDS.threshold_near_miss_turn_degs;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 10) continue;

    const speed2 = finiteSpeed(curr);
    if (speed2 < 40) continue;

    const accelMs2 = calculateAcceleration(finiteSpeed(prev), speed2, dt);
    const { h1, h2 } = headingBetweenPair(prev, curr, cleanPoints[i - 2] || null);
    const headingRate = h1 != null && h2 != null ? headingDiff(h1, h2) / dt : 0;

    if (accelMs2 < -brakeThreshold && headingRate > turnThreshold && dt <= 2.0) {
      events.push({
        type: EVENT_TYPES.NEAR_MISS,
        severity: accelMs2 < -5.5 && headingRate > 60 ? 'high' : accelMs2 < -4.5 && headingRate > 45 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        speed_kmh: Math.round(speed2),
        value: round1(Math.abs(accelMs2)),
      });
    }
  }

  return events;
}

export function calculateFatigueScore(durationSeconds, routePoints = []) {
  const durationMinutes = (durationSeconds || 0) / 60;
  const durationScore = Math.min(5, durationMinutes / 30);

  let timeScore = 0;
  if (routePoints.length > 0) {
    const startHour = new Date(routePoints[0].timestamp).getHours();
    if (startHour >= 2 && startHour < 5) timeScore = 5;
    else if (startHour >= 5 && startHour < 7) timeScore = 3;
    else if (startHour >= 13 && startHour < 15) timeScore = 2;
    else if (startHour >= 22 || startHour < 2) timeScore = 1;
  }

  return Math.min(10, Math.round((durationScore + timeScore) * 10) / 10);
}

function parseClockMinutes(value, fallbackHour) {
  if (typeof value === 'string') {
    const [hour, minute = '0'] = value.split(':');
    const h = Number(hour);
    const m = Number(minute);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
  }
  return fallbackHour * 60;
}

function isWithinClockWindow(minutes, startMinutes, endMinutes) {
  const dayMinutes = 24 * 60;
  const normalized = ((minutes % dayMinutes) + dayMinutes) % dayMinutes;
  const start = ((startMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  const end = ((endMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  if (start === end) return false;
  return start < end
    ? normalized >= start && normalized < end
    : normalized >= start || normalized < end;
}

function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000);
}

function sunEventMinutes(date, lat, lng, isSunrise) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 89.8) return null;

  const zenith = 90.833;
  const n = dayOfYear(date);
  const lngHour = lng / 15;
  const t = n + (((isSunrise ? 6 : 18) - lngHour) / 24);
  const meanAnomaly = (0.9856 * t) - 3.289;
  let trueLongitude = meanAnomaly
    + (1.916 * Math.sin(toRad(meanAnomaly)))
    + (0.020 * Math.sin(toRad(2 * meanAnomaly)))
    + 282.634;
  trueLongitude = ((trueLongitude % 360) + 360) % 360;

  let rightAscension = Math.atan(0.91764 * Math.tan(toRad(trueLongitude))) * 180 / Math.PI;
  rightAscension = ((rightAscension % 360) + 360) % 360;
  const longitudeQuadrant = Math.floor(trueLongitude / 90) * 90;
  const ascensionQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15;

  const sinDec = 0.39782 * Math.sin(toRad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(toRad(zenith)) - (sinDec * Math.sin(toRad(lat)))) / (cosDec * Math.cos(toRad(lat)));
  if (cosHour > 1 || cosHour < -1) return null;

  const hourAngle = isSunrise
    ? 360 - (Math.acos(cosHour) * 180 / Math.PI)
    : Math.acos(cosHour) * 180 / Math.PI;
  const localMeanTime = (hourAngle / 15) + rightAscension - (0.06571 * t) - 6.622;
  const utcMinutes = ((localMeanTime - lngHour) * 60) % (24 * 60);
  return ((utcMinutes - date.getTimezoneOffset()) % (24 * 60) + (24 * 60)) % (24 * 60);
}

export function isNightDrivingTime(point, thresholds = DEFAULT_THRESHOLDS) {
  if (!point?.timestamp) return false;

  const date = new Date(point.timestamp);
  if (Number.isNaN(date.getTime())) return false;

  const minutes = date.getHours() * 60 + date.getMinutes();
  if (thresholds.NIGHT_DETECTION_MODE === 'sunset') {
    const sunset = sunEventMinutes(date, Number(point.lat), Number(point.lng), false);
    const sunrise = sunEventMinutes(date, Number(point.lat), Number(point.lng), true);
    if (sunset != null && sunrise != null) {
      return isWithinClockWindow(
        minutes,
        sunset + (thresholds.NIGHT_SUNSET_OFFSET_MINUTES ?? 0),
        sunrise + (thresholds.NIGHT_SUNRISE_OFFSET_MINUTES ?? 0)
      );
    }
  }

  return isWithinClockWindow(
    minutes,
    parseClockMinutes(thresholds.NIGHT_START_TIME, thresholds.NIGHT_START_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_START_HOUR),
    parseClockMinutes(thresholds.NIGHT_END_TIME, thresholds.NIGHT_END_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_END_HOUR)
  );
}

export function calculateNightPenalty(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!routePoints.length) return 0;

  let nightPoints = 0;
  let deepNightPoints = 0;
  for (const point of routePoints) {
    const hour = new Date(point.timestamp).getHours();
    if (isNightDrivingTime(point, thresholds)) nightPoints++;
    if (hour >= 2 && hour < 5) deepNightPoints++;
  }

  return (nightPoints / routePoints.length) * 8 + (deepNightPoints / routePoints.length) * 4;
}

// ─── Trip Statistics ───────────────────────────────────────────────────────────
/**
 * Calculate aggregate trip statistics from route points.
 *
 * @param {Array} points - GPS route points
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @returns {Object} Trip statistics
 */
export function calculateTripStats(points, startTime, endTime, thresholds = DEFAULT_THRESHOLDS) {
  const routePoints = cleanRoutePoints(points, thresholds);
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const durationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);

  if (!routePoints || routePoints.length < 2) {
    const roadStats = classifyRoadType(routePoints || []);
    return {
      distance_km: 0,
      avg_speed_kmh: 0,
      avg_running_speed_kmh: 0,
      max_speed_kmh: 0,
      idle_time_seconds: 0,
      duration_seconds: Math.round(durationSeconds),
      night_driving: false,
      fatigue_risk_score: calculateFatigueScore(durationSeconds, routePoints || []),
      ...roadStats,
      intersection_score: 100,
      stop_count: 0,
      rolling_stop_count: 0,
      smooth_approach_count: 0,
      intersection_events: [],
      fatigue_progression: 'unknown',
      segment_scores: [],
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
      drowsy_window_count: 0,
      drowsy_risk_score: 0,
      drowsy_risk_level: 'none',
      parking_approach_score: 100,
      parking_approach_grade: 'smooth',
    };
  }

  let totalDistance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  let idleTime = 0;

  for (let i = 1; i < routePoints.length; i++) {
    const p = routePoints[i - 1];
    const c = routePoints[i];
    const segment = calculateSegmentMetrics(p, c, thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

    totalDistance += segment.distanceKm;

    const spd = segment.reliableSpeedKmh;
    if (spd > maxSpeed) maxSpeed = spd;
    if (spd >= thresholds.STATIONARY_SPEED_KMH) movingSeconds += segment.dt;

    if (spd < thresholds.IDLE_SPEED_KMH) {
      idleTime += segment.dt;
    }
  }

  if (totalDistance * 1000 < thresholds.MIN_POINT_DISTANCE_M) {
    totalDistance = 0;
    maxSpeed = 0;
  }

  const nightDriving = routePoints.some(p => isNightDrivingTime(p, thresholds));
  const avgSpeed = movingSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, movingSeconds)
    : 0;
  const roadStats = classifyRoadType(routePoints);
  const intersectionStats = analyzeIntersectionBehavior(routePoints, thresholds);
  const fatigueProgression = durationSeconds > 1800
    ? analyzeFatigueProgression(routePoints, start.getTime(), end.getTime(), thresholds)
    : { fatigue_progression: 'unknown', segment_scores: [] };
  const hillStats = calculateHillDrivingScore(routePoints, thresholds);
  const drowsyStats = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED === false
    ? { drowsy_window_count: 0, drowsy_risk_score: 0, drowsy_risk_level: 'none' }
    : detectDrowsyDrivingSignature(routePoints, durationSeconds, thresholds);
  const parkingStats = analyzeParkingApproach(routePoints, thresholds);

  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    avg_running_speed_kmh: Math.round(avgSpeed * 10) / 10,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: Math.round(idleTime),
    duration_seconds: Math.round(durationSeconds),
    night_driving: nightDriving,
    fatigue_risk_score: calculateFatigueScore(durationSeconds, routePoints),
    ...roadStats,
    ...intersectionStats,
    ...fatigueProgression,
    ...hillStats,
    ...drowsyStats,
    ...parkingStats,
  };
}

// ─── Scoring Engine ────────────────────────────────────────────────────────────
/**
 * Calculate trip scores from events and statistics.
 *
 * Scoring methodology:
 * - Start with 100 points
 * - Deduct for each risky event (severity-weighted)
 * - Apply bonuses for clean driving
 * - Sub-scores: Safety, Smoothness, Eco
 * - Overall = weighted average of sub-scores
 *
 * Safety (40%):    based on harsh brakes, speeding, sharp turns
 * Smoothness (35%): based on rapid accel, harsh brakes, turn smoothness
 * Eco (25%):        based on speeding, rapid accel, idle time
 *
 * @param {Array} events - Detected driving events
 * @param {Object} stats - Trip statistics (distance, duration, etc.)
 * @returns {Object} { overall, safety, smoothness, eco }
 */
export function calculateEngineStressScore(events = [], stats = {}) {
  const basePenalty = { low: 2, medium: 5, high: 10 };
  const speedMultiplier = (speedKmh) => (
    speedKmh >= 100 ? 3.0 : speedKmh >= 70 ? 2.0 : speedKmh >= 40 ? 1.3 : 1.0
  );
  let engineStressRaw = 0;
  let highSpeedAccelCount = 0;

  for (const event of events) {
    if (event.type !== EVENT_TYPES.RAPID_ACCELERATION) continue;
    const speed = Number(event.speed_kmh) || 0;
    engineStressRaw += (basePenalty[event.severity] || 0) * speedMultiplier(speed);
    if (speed >= 70) highSpeedAccelCount++;
  }

  const distFactor = Math.max(1, stats.distance_km || 1);
  const score = Math.max(0, Math.round(100 - Math.min(engineStressRaw * (5 / distFactor), 100)));
  return {
    engine_stress_score: score,
    engine_stress_grade: score >= 90 ? 'low stress' : score >= 70 ? 'moderate' : score >= 50 ? 'high' : 'critical',
    high_speed_accel_count: highSpeedAccelCount,
  };
}

export function calculateTireWearUnits(events = []) {
  const severityBase = { low: 1, medium: 2.5, high: 5 };
  let units = 0;
  for (const event of events) {
    if (event.type === EVENT_TYPES.HARSH_BRAKE) {
      units += (severityBase[event.severity] || 0) * ((event.speed_kmh ?? 50) / 50) ** 2;
    }
    if (event.type === EVENT_TYPES.SHARP_TURN) {
      units += (severityBase[event.severity] || 0) * ((event.speed_kmh ?? 40) / 40) ** 2;
    }
  }
  return { trip_tire_wear_units: round1(units) };
}

export function calculateAggressiveDrivingScore(events = [], stats = {}) {
  const weights = {
    [EVENT_TYPES.HARSH_BRAKE]: { low: 3, medium: 7, high: 15 },
    [EVENT_TYPES.RAPID_ACCELERATION]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.SHARP_TURN]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.SPEEDING]: { low: 5, medium: 10, high: 20 },
    [EVENT_TYPES.NEAR_MISS]: { low: 8, medium: 18, high: 35 },
    [EVENT_TYPES.AGGRESSIVE_OVERTAKE]: { low: 12, medium: 25, high: 45 },
  };
  const rawPenalty = events.reduce((sum, event) => sum + (weights[event.type]?.[event.severity] || 0), 0);
  const avgJerkMs3 = stats.avg_jerk_ms3 ?? 0;
  const jerkPenalty = Math.min(Math.max((avgJerkMs3 - 0.3) * 20, 0), 25);
  const combinedPenalty = rawPenalty + jerkPenalty;
  const distFactor = Math.max(1, stats.distance_km || 1);
  const normalizedPenalty = Math.min(combinedPenalty * (5 / distFactor), 100);
  const score = Math.max(0, Math.round(100 - normalizedPenalty));
  return {
    aggressive_driving_score: score,
    aggressive_grade: score >= 90 ? 'calm' : score >= 75 ? 'moderate' : score >= 55 ? 'assertive' : 'aggressive',
    aggression_penalty_raw: rawPenalty,
  };
}

export function calculateDefensiveDrivingScore(scores = {}) {
  const defensiveScore = Math.round(
    (scores.smooth_braking_ratio ?? 100) * 0.25 +
    (scores.intersection_score ?? 100) * 0.20 +
    (scores.svi_score ?? 100) * 0.20 +
    (scores.following_distance_score ?? 100) * 0.20 +
    (scores.near_miss_score ?? 100) * 0.15
  );
  return {
    defensive_driving_score: defensiveScore,
    defensive_grade: defensiveScore >= 90 ? 'exemplary' : defensiveScore >= 75 ? 'defensive' : defensiveScore >= 55 ? 'average' : 'reactive',
  };
}

export function calculateTripScores(
  events,
  stats,
  routePoints = [],
  thresholds = DEFAULT_THRESHOLDS,
  durationSeconds = stats?.duration_seconds || 0
) {
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const penalties = {
    [EVENT_TYPES.HARSH_BRAKE]: { low: 3, medium: 6, high: 12 },
    [EVENT_TYPES.RAPID_ACCELERATION]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.SHARP_TURN]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.SPEEDING]: { low: 5, medium: 10, high: 20 },
    [EVENT_TYPES.IDLE]: { low: 1, medium: 3, high: 5 },
    [EVENT_TYPES.LANE_CHANGE]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.TAILGATE_CYCLE]: { low: 3, medium: 8, high: 15 },
    [EVENT_TYPES.ERRATIC_SPEED]: { low: 2, medium: 5, high: 10 },
    [EVENT_TYPES.NEAR_MISS]: { low: 8, medium: 18, high: 35 },
    [EVENT_TYPES.AGGRESSIVE_OVERTAKE]: { low: 12, medium: 25, high: 45 },
  };

  // Count events
  const counts = {
    [EVENT_TYPES.HARSH_BRAKE]: 0,
    [EVENT_TYPES.RAPID_ACCELERATION]: 0,
    [EVENT_TYPES.SHARP_TURN]: 0,
    [EVENT_TYPES.SPEEDING]: 0,
    [EVENT_TYPES.IDLE]: 0,
    [EVENT_TYPES.LANE_CHANGE]: 0,
    [EVENT_TYPES.TAILGATE_CYCLE]: 0,
    [EVENT_TYPES.ERRATIC_SPEED]: 0,
    [EVENT_TYPES.NEAR_MISS]: 0,
    [EVENT_TYPES.AGGRESSIVE_OVERTAKE]: 0,
  };
  let safetyPenalty = 0;
  let smoothnessPenalty = 0;
  let ecoPenalty = 0;
  let tailgatePenalty = 0;
  let distractionPenalty = 0;

  for (const evt of events) {
    let p = penalties[evt.type]?.[evt.severity] ?? 0;
    if (
      [EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.SHARP_TURN].includes(evt.type) &&
      evt.speed_kmh != null
    ) {
      const speedFactor = 1 + Math.max(0, Math.min(1.5, (evt.speed_kmh - 30) / 60));
      p *= speedFactor;
    }
    if (counts[evt.type] !== undefined) counts[evt.type]++;

    // Safety: deducts from harsh_brake, speeding, sharp_turn
    if ([
      EVENT_TYPES.HARSH_BRAKE,
      EVENT_TYPES.SPEEDING,
      EVENT_TYPES.SHARP_TURN,
      EVENT_TYPES.LANE_CHANGE,
      EVENT_TYPES.TAILGATE_CYCLE,
      EVENT_TYPES.ERRATIC_SPEED,
      EVENT_TYPES.NEAR_MISS,
      EVENT_TYPES.AGGRESSIVE_OVERTAKE,
    ].includes(evt.type)) safetyPenalty += p;
    // Smoothness: deducts from harsh_brake, rapid_acceleration, sharp_turn
    if ([EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.SHARP_TURN, EVENT_TYPES.NEAR_MISS].includes(evt.type)) smoothnessPenalty += p;
    // Eco: deducts from speeding, rapid_acceleration, idle
    if ([EVENT_TYPES.SPEEDING, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.IDLE].includes(evt.type)) ecoPenalty += p;
    if (evt.type === EVENT_TYPES.TAILGATE_CYCLE) tailgatePenalty += p;
    if (evt.type === EVENT_TYPES.ERRATIC_SPEED) distractionPenalty += p;
  }

  const speedCreep = advancedSafetyEnabled
    ? detectSpeedCreep(routePoints, thresholds)
    : {
      speed_creep_event_count: 0,
      max_speed_creep_kmh: 0,
      speed_creep_score: 100,
      speed_creep_severity_counts: { low: 0, medium: 0, high: 0 },
    };
  const phoneProxy = advancedSafetyEnabled
    ? detectPhoneUsageProxy(routePoints, thresholds)
    : { phone_proxy_count: 0, phone_proxy_risk: 'none' };
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.low || 0) * 2;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.medium || 0) * 5;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.high || 0) * 10;
  safetyPenalty += (phoneProxy.phone_proxy_count || 0) * 8;

  safetyPenalty += calculateNightPenalty(routePoints, thresholds);

  safetyPenalty += (stats.fatigue_risk_score || 0) * 1.2;

  const distKm = Math.max(1, stats.distance_km || 1);
  const SCORE_FLOOR = 20;
  const MAX_DEDUCTION = 80;
  const SCALE_FACTOR = 40.0;
  const normalize = (totalPenalty) => {
    const penaltyRate = totalPenalty / distKm;
    const deduction = Math.min(penaltyRate * SCALE_FACTOR, MAX_DEDUCTION);
    return Math.max(SCORE_FLOOR, Math.round(100 - deduction));
  };

  const baseSafety = Math.round(normalize(safetyPenalty));
  const baseSmoothness = Math.round(normalize(smoothnessPenalty));
  const baseEco = Math.round(normalize(ecoPenalty));
  const jerk = calculateJerkScore(routePoints, stats.distance_km || distKm);
  const ecoDriving = calculateEcoDrivingScore(routePoints, stats);
  const svi = calculateSpeedVariabilityIndex(routePoints);
  const fuelBand = calculateFuelBandScore(routePoints, thresholds);
  const merge = detectHighwayMergeBehavior(routePoints);
  const smoothBraking = calculateSmoothBrakingRatio(routePoints, thresholds);
  const engineStress = calculateEngineStressScore(events, stats);
  const tireWear = calculateTireWearUnits(events);
  const drowsy = advancedSafetyEnabled
    ? detectDrowsyDrivingSignature(routePoints, durationSeconds, thresholds)
    : { drowsy_window_count: 0, drowsy_risk_score: 0, drowsy_risk_level: 'none' };
  const hill = calculateHillDrivingScore(routePoints, thresholds);
  const parking = analyzeParkingApproach(routePoints, thresholds);
  const nearMissScore = Math.max(0, 100 - counts[EVENT_TYPES.NEAR_MISS] * 15);
  const aggressive = calculateAggressiveDrivingScore(events, { ...stats, ...jerk });
  const highwayKm = Math.max(1, calculateHighwayDistanceKm(routePoints));
  const followingDistanceScore = Math.max(0, 100 - Math.min(tailgatePenalty * (4 / highwayKm), 80));
  const distractionScore = Math.max(0, 100 - Math.min(distractionPenalty * (3 / distKm), 50));

  const safety = Math.round(baseSafety * 0.85 + followingDistanceScore * 0.15);
  const smoothness = Math.round(baseSmoothness * 0.55 + jerk.jerk_score * 0.30 + svi.svi_score * 0.15);
  const eco = Math.round(baseEco * 0.40 + ecoDriving.eco_driving_score * 0.40 + fuelBand.fuel_band_score * 0.20);
  const intersectionScore = Number.isFinite(stats.intersection_score) ? stats.intersection_score : 100;

  // Overall = weighted combination
  const overall = Math.round(safety * 0.35 + smoothness * 0.30 + eco * 0.20 + intersectionScore * 0.15);

  const componentScores = {
    score_overall: overall,
    score_safety: safety,
    score_smoothness: smoothness,
    score_eco: eco,
    harsh_brakes_count: counts[EVENT_TYPES.HARSH_BRAKE],
    rapid_accel_count: counts[EVENT_TYPES.RAPID_ACCELERATION],
    sharp_turns_count: counts[EVENT_TYPES.SHARP_TURN],
    speeding_events_count: counts[EVENT_TYPES.SPEEDING],
    lane_changes_count: counts[EVENT_TYPES.LANE_CHANGE],
    lane_changes_per_10km: round1((counts[EVENT_TYPES.LANE_CHANGE] / distKm) * 10),
    tailgate_cycle_count: counts[EVENT_TYPES.TAILGATE_CYCLE],
    following_distance_score: Math.round(followingDistanceScore),
    distraction_events_count: counts[EVENT_TYPES.ERRATIC_SPEED],
    distraction_score: Math.round(distractionScore),
    near_miss_count: counts[EVENT_TYPES.NEAR_MISS],
    near_miss_score: nearMissScore,
    overtake_event_count: counts[EVENT_TYPES.AGGRESSIVE_OVERTAKE],
    overtake_score: Math.max(0, 100 - counts[EVENT_TYPES.AGGRESSIVE_OVERTAKE] * 20),
    intersection_score: intersectionScore,
    ...jerk,
    ...ecoDriving,
    ...svi,
    ...fuelBand,
    ...merge,
    ...smoothBraking,
    ...engineStress,
    ...tireWear,
    ...speedCreep,
    ...phoneProxy,
    ...drowsy,
    ...hill,
    ...parking,
    ...aggressive,
    driving_events: events,
  };
  delete componentScores.speed_creep_severity_counts;

  return {
    ...componentScores,
    ...calculateDefensiveDrivingScore(componentScores),
  };
}

// ─── Score Color Utility ───────────────────────────────────────────────────────
export function getScoreColor(score) {
  if (score >= 85) return { color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-950/30', label: 'Excellent' };
  if (score >= 70) return { color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30', label: 'Good' };
  if (score >= 55) return { color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30', label: 'Fair' };
  if (score >= 40) return { color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30', label: 'Poor' };
  return { color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30', label: 'Risky' };
}

export function getScoreGradient(score) {
  if (score >= 85) return 'from-green-400 to-emerald-500';
  if (score >= 70) return 'from-blue-400 to-blue-600';
  if (score >= 55) return 'from-yellow-400 to-orange-400';
  if (score >= 40) return 'from-orange-400 to-red-400';
  return 'from-red-500 to-red-700';
}

// ─── Format Utilities ──────────────────────────────────────────────────────────
export function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDistance(km, units = 'metric') {
  if (units === 'imperial') {
    const miles = km * 0.621371;
    return `${miles.toFixed(1)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatSpeed(kmh, units = 'metric') {
  if (units === 'imperial') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return `${formatDate(dateStr)} ${formatTime(dateStr)}`;
}

// ─── Report Calculations ───────────────────────────────────────────────────────
/**
 * Generate a summary report for a set of trips.
 *
 * @param {Array} trips - Array of completed trips
 * @returns {Object} Report summary
 */
export function generateReportSummary(trips) {
  if (!trips || trips.length === 0) {
    return {
      total_trips: 0,
      total_distance_km: 0,
      total_duration_seconds: 0,
      avg_score: 0,
      best_trip: null,
      worst_trip: null,
      total_harsh_brakes: 0,
      total_rapid_accels: 0,
      total_sharp_turns: 0,
      total_speeding_events: 0,
      total_lane_changes: 0,
      total_tailgate_cycles: 0,
      total_distraction_events: 0,
      most_common_risk: null,
    };
  }

  const completed = trips.filter(t => t.status === 'completed');
  const totalDistance = completed.reduce((s, t) => s + (t.distance_km || 0), 0);
  const totalDuration = completed.reduce((s, t) => s + (t.duration_seconds || 0), 0);
  const scores = completed.filter(t => t.score_overall > 0).map(t => t.score_overall);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  const sorted = [...completed].sort((a, b) => (b.score_overall || 0) - (a.score_overall || 0));
  const bestTrip = sorted[0] || null;
  const worstTrip = sorted[sorted.length - 1] || null;

  const hb = completed.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
  const ra = completed.reduce((s, t) => s + (t.rapid_accel_count || 0), 0);
  const st = completed.reduce((s, t) => s + (t.sharp_turns_count || 0), 0);
  const sp = completed.reduce((s, t) => s + (t.speeding_events_count || 0), 0);
  const lc = completed.reduce((s, t) => s + (t.lane_changes_count || 0), 0);
  const tg = completed.reduce((s, t) => s + (t.tailgate_cycle_count || 0), 0);
  const er = completed.reduce((s, t) => s + (t.distraction_events_count || 0), 0);

  const riskMap = {
    [EVENT_TYPES.HARSH_BRAKE]: hb,
    [EVENT_TYPES.RAPID_ACCELERATION]: ra,
    [EVENT_TYPES.SHARP_TURN]: st,
    [EVENT_TYPES.SPEEDING]: sp,
    [EVENT_TYPES.LANE_CHANGE]: lc,
    [EVENT_TYPES.TAILGATE_CYCLE]: tg,
    [EVENT_TYPES.ERRATIC_SPEED]: er,
  };
  const mostCommonRisk = Object.entries(riskMap).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    total_trips: completed.length,
    total_distance_km: Math.round(totalDistance * 10) / 10,
    total_duration_seconds: totalDuration,
    avg_score: avgScore,
    best_trip: bestTrip,
    worst_trip: worstTrip,
    total_harsh_brakes: hb,
    total_rapid_accels: ra,
    total_sharp_turns: st,
    total_speeding_events: sp,
    total_lane_changes: lc,
    total_tailgate_cycles: tg,
    total_distraction_events: er,
    most_common_risk: mostCommonRisk,
    score_trend: scores,
  };
}

// ─── GPS Location Service (Browser) ───────────────────────────────────────────
/**
 * Live GPS tracking service using the Web Geolocation API.
 * Returns an object with start/stop methods and a callback for new points.
 */
export function createLocationService() {
  let watchId = null;
  let onPoint = null;
  let onError = null;

  return {
    start(onPointCb, onErrorCb) {
      onPoint = onPointCb;
      onError = onErrorCb;

      if (!navigator.geolocation) {
        onError?.({ message: 'Geolocation not supported' });
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (pos.coords.accuracy > DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M) return; // filter noisy points
          onPoint?.({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speed_kmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            timestamp: new Date(pos.timestamp).toISOString(),
          });
        },
        (err) => onError?.({ message: err.message, code: err.code }),
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    },
    stop() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    isActive: () => watchId !== null,
  };
}

// ─── CSV Export ────────────────────────────────────────────────────────────────
export function tripsToCSV(trips) {
  const headers = [
    'ID', 'Start Time', 'End Time', 'Duration (min)', 'Distance (km)',
    'Avg Speed (km/h)', 'Max Speed (km/h)', 'Score', 'Safety', 'Smoothness',
    'Eco', 'Jerk Score', 'Eco Driving Score', 'Following Score', 'Focus Score', 'Intersection Score',
    'Aggressive Score', 'Aggressive Grade', 'Defensive Score', 'Defensive Grade', 'SVI', 'Fuel Band',
    'Smooth Braking', 'Engine Stress', 'Tire Wear Units', 'Drowsy Risk', 'Phone Proxy', 'Parking Score',
    'Road Type', 'Harsh Brakes', 'Rapid Accels', 'Sharp Turns', 'Speeding Events',
    'Lane Changes', 'Tailgate Cycles', 'Distraction Events', 'Near Misses', 'Overtakes', 'Night Driving',
    'GPS Point Count', 'Route Points JSON', 'Driving Events JSON',
  ];

  const rows = trips.map(t => [
    t.id,
    t.start_time,
    t.end_time,
    t.duration_seconds ? (t.duration_seconds / 60).toFixed(1) : '',
    t.distance_km ?? '',
    t.avg_speed_kmh ?? '',
    t.max_speed_kmh ?? '',
    t.score_overall ?? '',
    t.score_safety ?? '',
    t.score_smoothness ?? '',
    t.score_eco ?? '',
    t.jerk_score ?? '',
    t.eco_driving_score ?? '',
    t.following_distance_score ?? '',
    t.distraction_score ?? '',
    t.intersection_score ?? '',
    t.aggressive_driving_score ?? '',
    t.aggressive_grade ?? '',
    t.defensive_driving_score ?? '',
    t.defensive_grade ?? '',
    t.speed_variability_index ?? '',
    t.fuel_band_score ?? '',
    t.smooth_braking_ratio ?? '',
    t.engine_stress_score ?? '',
    t.trip_tire_wear_units ?? '',
    t.drowsy_risk_level ?? '',
    t.phone_proxy_risk ?? '',
    t.parking_approach_score ?? '',
    t.road_type ?? '',
    t.harsh_brakes_count ?? '',
    t.rapid_accel_count ?? '',
    t.sharp_turns_count ?? '',
    t.speeding_events_count ?? '',
    t.lane_changes_count ?? '',
    t.tailgate_cycle_count ?? '',
    t.distraction_events_count ?? '',
    t.near_miss_count ?? '',
    t.overtake_event_count ?? '',
    t.night_driving ? 'Yes' : 'No',
    t.route_points?.length || 0,
    JSON.stringify(t.route_points || []),
    JSON.stringify(t.driving_events || []),
  ]);

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

export async function downloadCSV(content, filename) {
  const safeFilename = filename.replace(/[\\/:*?"<>|]+/g, '-');

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const result = await Filesystem.writeFile({
        path: safeFilename,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      return {
        native: true,
        uri: result.uri,
        filename: safeFilename,
      };
    }
  } catch (error) {
    console.warn('Native CSV export failed, falling back to browser download.', error);
  }

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return {
    native: false,
    filename: safeFilename,
  };
}
