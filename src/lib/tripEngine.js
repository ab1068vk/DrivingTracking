import { saveExportToDownloads } from './nativeDownloads';
import { detectTripStops, estimateTripEconomics } from './tripInsights';

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
  SPEED_OVER_KMH: 10,
  REACTION_SPEED_TRIGGER_KMH: 5,
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
  MAX_SPEED_SPIKE_DELTA_KMH: 45,
  MAX_SPEED_SPIKE_RATIO: 1.8,
  MAX_ALTITUDE_ACCURACY_M: 40,
  MIN_HILL_SEGMENT_DISTANCE_M: 20,
  HILL_GRADE_THRESHOLD_PCT: 6,
  MIN_SPEED_RAPID_ACCEL_KMH: 5,
  MIN_SPEED_HARSH_BRAKE_KMH: 25,
  TAILGATE_DECEL_MS2: 2.5,
  FOLLOWING_GAP_MIN_SPEED_KMH: 55,
  FOLLOWING_GAP_CRUISE_SECONDS: 4,
  FOLLOWING_GAP_SPEED_DROP_KMH: 10,
  LANE_CHANGE_MIN_SPEED_KMH: 45,
  LANE_CHANGE_HIGHWAY_MIN_SPEED_KMH: 80,
  LANE_CHANGE_MIN_TURN_RATE_DEG_S: 2,
  LANE_CHANGE_MAX_TURN_RATE_DEG_S: 20,
  MERGE_ENTRY_SPEED_KMH: 65,
  MERGE_EXIT_SPEED_KMH: 85,
  PARKING_LOOKBACK_SECONDS: 90,
  MAX_TERMINAL_IDLE_SECONDS: 1800,
  threshold_near_miss_brake_ms2: 3.5,
  threshold_near_miss_turn_degs: 30,
  threshold_drowsy_heading_std: 8,
  threshold_phone_proxy_oscillations: 3,
  PHONE_MICRO_STEER_COUNT: 4,
  PHONE_CREEP_RATE_KMH_S: 1.5,
  PHONE_LANE_DRIFT_DEG: 8,
  PHONE_COUPLING_THRESHOLD: 0.15,
  PHONE_CONFIDENCE_THRESHOLD: 0.40,
  PHONE_MIN_WINDOW_S: 4,
  PHONE_USE_DETECTION_ENABLED: true,
  PHONE_USE_AFFECTS_SCORE: true,
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
  PHONE_USE: 'phone_use',
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
    SPEED_OVER_KMH: settingNumber(settings.threshold_speed_over_kmh, DEFAULT_THRESHOLDS.SPEED_OVER_KMH),
    REACTION_SPEED_TRIGGER_KMH: settingNumber(settings.reaction_speed_trigger_kmh, DEFAULT_THRESHOLDS.REACTION_SPEED_TRIGGER_KMH),
    IDLE_EVENT_SECONDS: settingNumber(settings.threshold_idle_seconds, DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS),
    LONG_DRIVE_MINUTES: settingNumber(settings.threshold_long_drive_minutes, DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES),
    MIN_SPEED_RAPID_ACCEL_KMH: settingNumber(settings.min_speed_rapid_accel_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_RAPID_ACCEL_KMH),
    MIN_SPEED_HARSH_BRAKE_KMH: settingNumber(settings.min_speed_harsh_brake_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_HARSH_BRAKE_KMH),
    threshold_harsh_brake_ms2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    threshold_near_miss_brake_ms2: settingNumber(settings.threshold_near_miss_brake_ms2, DEFAULT_THRESHOLDS.threshold_near_miss_brake_ms2),
    threshold_near_miss_turn_degs: settingNumber(settings.threshold_near_miss_turn_degs, DEFAULT_THRESHOLDS.threshold_near_miss_turn_degs),
    threshold_drowsy_heading_std: settingNumber(settings.threshold_drowsy_heading_std, DEFAULT_THRESHOLDS.threshold_drowsy_heading_std),
    threshold_phone_proxy_oscillations: settingNumber(settings.threshold_phone_proxy_oscillations, DEFAULT_THRESHOLDS.threshold_phone_proxy_oscillations),
    PHONE_MICRO_STEER_COUNT: settingNumber(settings.phone_micro_steer_count, DEFAULT_THRESHOLDS.PHONE_MICRO_STEER_COUNT),
    PHONE_CREEP_RATE_KMH_S: settingNumber(settings.phone_creep_rate_kmh_s, DEFAULT_THRESHOLDS.PHONE_CREEP_RATE_KMH_S),
    PHONE_LANE_DRIFT_DEG: settingNumber(settings.phone_lane_drift_deg, DEFAULT_THRESHOLDS.PHONE_LANE_DRIFT_DEG),
    PHONE_COUPLING_THRESHOLD: settingNumber(settings.phone_coupling_threshold, DEFAULT_THRESHOLDS.PHONE_COUPLING_THRESHOLD),
    PHONE_CONFIDENCE_THRESHOLD: settings.phone_use_sensitivity === 'low'
      ? 0.60
      : settings.phone_use_sensitivity === 'high'
        ? 0.25
        : settingNumber(settings.phone_confidence_threshold, DEFAULT_THRESHOLDS.PHONE_CONFIDENCE_THRESHOLD),
    PHONE_MIN_WINDOW_S: settingNumber(settings.phone_min_window_s, DEFAULT_THRESHOLDS.PHONE_MIN_WINDOW_S),
    PHONE_USE_DETECTION_ENABLED: settings.phone_use_detection_enabled !== false,
    PHONE_USE_AFFECTS_SCORE: settings.phone_use_affects_score !== false,
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
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
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

function parseTimestampMs(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
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
  const stats = calculateTripStats(points, startTime, endTime, thresholds);
  const detection = detectDrivingEvents(cleaned, thresholds, endTime);
  const events = Reflect.get(detection, 'events') ?? detection;
  const scores = calculateTripScores(events, stats, cleaned, thresholds, stats.duration_seconds, Reflect.get(detection, 'phoneUse') ?? {}, { endTime });
  return { points: cleaned, stats, events, scores };
}

function generatedTripId(prefix = 'trip') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function splitTripAtStops(trip, minParkMinutes = 5, thresholds = DEFAULT_THRESHOLDS) {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (routePoints.length < 2) return [];

  const minStopSeconds = Math.max(0, Number(minParkMinutes) || 0) * 60;
  const stops = detectTripStops(routePoints, {
    minStopSeconds,
    maxSpeedKmh: thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH,
  });
  const sortedPoints = [...routePoints].sort((a, b) => timestampMs(a) - timestampMs(b));

  if (!stops.length) {
    return [{
      ...trip,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: 1,
      route_points: sortedPoints,
    }];
  }

  const splitRanges = [];
  let segmentStartIndex = 0;

  for (const stop of stops) {
    const stopStartMs = new Date(stop.start_time).getTime();
    const stopEndMs = new Date(stop.end_time).getTime();
    const beforeStopEnd = sortedPoints.findIndex((point, index) => index >= segmentStartIndex && timestampMs(point) >= stopStartMs);
    const afterStopStart = sortedPoints.findIndex((point) => timestampMs(point) > stopEndMs);
    const endIndex = beforeStopEnd > segmentStartIndex ? beforeStopEnd - 1 : segmentStartIndex - 1;
    if (endIndex - segmentStartIndex + 1 >= 2) splitRanges.push([segmentStartIndex, endIndex]);
    segmentStartIndex = afterStopStart >= 0 ? afterStopStart : sortedPoints.length;
  }

  if (sortedPoints.length - segmentStartIndex >= 2) {
    splitRanges.push([segmentStartIndex, sortedPoints.length - 1]);
  }

  return splitRanges.map(([startIndex, endIndex], index) => {
    const segmentPoints = sortedPoints.slice(startIndex, endIndex + 1);
    const startTime = segmentPoints[0].timestamp;
    const endTime = segmentPoints[segmentPoints.length - 1].timestamp;
    const stats = calculateTripStats(segmentPoints, startTime, endTime, thresholds);
    const detection = detectDrivingEvents(segmentPoints, thresholds, endTime);
    const events = Reflect.get(detection, 'events') ?? detection;
    const scores = calculateTripScores(events, stats, segmentPoints, thresholds, stats.duration_seconds, Reflect.get(detection, 'phoneUse') ?? {}, { endTime });
    const drivingEvents = scores.driving_events || events;
    const economics = estimateTripEconomics({ ...stats, ...scores });

    return {
      ...stats,
      ...scores,
      co2_saved_kg: economics.co2_saved_kg,
      fuel_cost: economics.cost,
      fuel_used_liters: economics.liters,
      co2_kg: economics.co2_kg,
      fuel_saved_liters: economics.fuel_saved_liters,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: index + 1,
      status: 'completed',
      start_time: startTime,
      end_time: endTime,
      vehicle_id: trip?.vehicle_id ?? null,
      tag: trip?.tag ?? null,
      background_tracking: trip?.background_tracking ?? false,
      start_source: trip?.start_source || 'split',
      route_points: segmentPoints,
      route_points_raw_count: segmentPoints.length,
      driving_events: drivingEvents,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });
}

// ─── Event Detection ───────────────────────────────────────────────────────────
function finiteSpeed(point) {
  return Number.isFinite(point?.speed_kmh) ? Math.max(0, point.speed_kmh) : 0;
}

function pointSpeedKmh(point) {
  return Number.isFinite(point?.speed_kmh) ? Math.max(0, point.speed_kmh) : null;
}

function isLikelySpeedSpike(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  const speed = pointSpeedKmh(points[index]);
  if (speed == null) return false;

  const previousSpeed = pointSpeedKmh(points[index - 1]);
  const nextSpeed = pointSpeedKmh(points[index + 1]);
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

function reliablePointSpeed(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  return isLikelySpeedSpike(points, index, thresholds) ? null : pointSpeedKmh(points[index]);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentileValue(values, p) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function calculateRouteDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) distance += segment.distanceKm;
  }
  return distance;
}

function calculateTerminalStoppedSeconds(points = [], endTime = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!points?.length || !endTime) return 0;
  const lastIndex = points.length - 1;
  const lastPoint = points[lastIndex];
  const lastMs = timestampMs(lastPoint);
  const endMs = parseTimestampMs(endTime);
  if (endMs == null || endMs <= lastMs) return 0;

  const lastSpeed = reliablePointSpeed(points, lastIndex, thresholds) ?? finiteSpeed(lastPoint);
  const idleSpeed = thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH;
  if (lastSpeed >= idleSpeed) return 0;

  const maxTerminalIdle = thresholds.MAX_TERMINAL_IDLE_SECONDS ?? DEFAULT_THRESHOLDS.MAX_TERMINAL_IDLE_SECONDS;
  return Math.min(maxTerminalIdle, (endMs - lastMs) / 1000);
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

function normalizeRoadTypeLabel(roadType, point = {}) {
  if (roadType === 'highway' || roadType === 'urban' || roadType === 'residential') return roadType;
  const speed = finiteSpeed(point);
  if (speed >= 80) return 'highway';
  if (speed < 30) return 'residential';
  return 'urban';
}

function classifyRoadTypesByPoint(routePoints = [], windowSize = 30) {
  const points = routePoints || [];
  const halfWindow = Math.max(1, Math.floor(windowSize / 2));
  return points.map((point, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(points.length, index + halfWindow + 1);
    return normalizeRoadTypeLabel(classifyRoadType(points.slice(start, end)).road_type, point);
  });
}

function nearestPointIndexByTimestamp(routePoints = [], event = {}) {
  if (Number.isInteger(event.point_index) && event.point_index >= 0 && event.point_index < routePoints.length) {
    return event.point_index;
  }
  const eventMs = timestampMs(event);
  if (!Number.isFinite(eventMs)) return -1;
  let nearestIndex = -1;
  let nearestDelta = Infinity;
  routePoints.forEach((point, index) => {
    const delta = Math.abs(timestampMs(point) - eventMs);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function zoneFromP85(p85Speed) {
  if (p85Speed < 30) return { inferredZone: 'zone_30', inferredZoneKmh: 30 };
  if (p85Speed < 55) return { inferredZone: 'zone_50', inferredZoneKmh: 50 };
  if (p85Speed < 80) return { inferredZone: 'zone_60_70', inferredZoneKmh: 70 };
  if (p85Speed < 110) return { inferredZone: 'zone_80_100', inferredZoneKmh: 100 };
  return { inferredZone: 'zone_highway', inferredZoneKmh: 120 };
}

export function inferSpeedZones(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = (routePoints || [])
    .map((point, index) => ({ point, index, ts: timestampMs(point), speed: reliablePointSpeed(routePoints, index, thresholds) }))
    .filter((entry) => Number.isFinite(entry.ts));
  if (points.length < 2) return [];

  const zones = [];
  for (let start = 0; start < points.length - 1; start++) {
    const startTs = points[start].ts;
    let end = start;
    while (end + 1 < points.length && points[end + 1].ts - startTs <= 60000) end++;
    if (end <= start) continue;

    const windowEntries = points.slice(start, end + 1);
    const speeds = windowEntries.map((entry) => entry.speed).filter((speed) => Number.isFinite(speed));
    if (speeds.length < 2) continue;

    const medianSpeed = percentileValue(speeds, 50);
    const p85Speed = percentileValue(speeds, 85);
    const deviation = speedStdDev(speeds);
    const { road_type: roadType, highway_fraction: highwayFraction } = classifyRoadType(windowEntries.map((entry) => entry.point));
    const zone = zoneFromP85(p85Speed);
    zones.push({
      startIndex: windowEntries[0].index,
      endIndex: windowEntries[windowEntries.length - 1].index,
      inferredZone: zone.inferredZone,
      inferredZoneKmh: zone.inferredZoneKmh,
      confidence: deviation < 8 ? 'high' : deviation < 18 ? 'medium' : 'low',
      median_speed_kmh: round1(medianSpeed),
      p85_speed_kmh: round1(p85Speed),
      road_type: roadType,
      road_type_fraction: highwayFraction,
      speed_std_dev: round1(deviation),
      threshold_kmh: zone.inferredZone === 'zone_highway'
        ? thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH
        : zone.inferredZoneKmh + (thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH),
    });
  }

  return zones;
}

export function calculateJerkScore(cleanPoints = [], distanceKmOrThresholds = 1) {
  if (!cleanPoints || cleanPoints.length < 3) {
    return { jerk_score: 100, jerk_event_count: 0, avg_jerk_ms3: 0 };
  }

  const distanceKm = typeof distanceKmOrThresholds === 'number'
    ? distanceKmOrThresholds
    : calculateRouteDistanceKm(cleanPoints, distanceKmOrThresholds || DEFAULT_THRESHOLDS);
  const thresholds = typeof distanceKmOrThresholds === 'number'
    ? DEFAULT_THRESHOLDS
    : distanceKmOrThresholds || DEFAULT_THRESHOLDS;
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
    const prevSegment = calculateSegmentMetrics(prev, curr, thresholds);
    const nextSegment = calculateSegmentMetrics(curr, next, thresholds);
    if (prevSegment.isNoise || nextSegment.isNoise) continue;

    const s0 = reliablePointSpeed(cleanPoints, i - 1, thresholds) ?? finiteSpeed(prev);
    const s1 = reliablePointSpeed(cleanPoints, i, thresholds) ?? finiteSpeed(curr);
    const s2 = reliablePointSpeed(cleanPoints, i + 1, thresholds) ?? finiteSpeed(next);
    if ((s0 + s1 + s2) / 3 < 8) continue;

    const v0 = s0 / 3.6;
    const v1 = s1 / 3.6;
    const v2 = s2 / 3.6;
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
  const maxAltitudeAccuracy = thresholds.MAX_ALTITUDE_ACCURACY_M ?? DEFAULT_THRESHOLDS.MAX_ALTITUDE_ACCURACY_M;
  const hasReliableAltitude = (point) => (
    Number.isFinite(point?.altitude) &&
    (!Number.isFinite(point?.altitude_accuracy) || point.altitude_accuracy <= maxAltitudeAccuracy)
  );
  const altitudePoints = cleanPoints.filter(hasReliableAltitude);
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
  let previousReliableSpeed = null;
  const harshBrakeThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  const minHillDistanceM = thresholds.MIN_HILL_SEGMENT_DISTANCE_M ?? DEFAULT_THRESHOLDS.MIN_HILL_SEGMENT_DISTANCE_M;
  const hillGradeThreshold = thresholds.HILL_GRADE_THRESHOLD_PCT ?? DEFAULT_THRESHOLDS.HILL_GRADE_THRESHOLD_PCT;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    if (!hasReliableAltitude(prev) || !hasReliableAltitude(curr)) {
      previousReliableSpeed = null;
      descentWindowStart = null;
      continue;
    }

    const segment = calculateSegmentMetrics(prev, curr, thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) {
      previousReliableSpeed = null;
      descentWindowStart = null;
      continue;
    }

    const distanceM = segment.distanceM;
    if (distanceM < minHillDistanceM) continue;

    const pointSpeed = reliablePointSpeed(cleanPoints, i, thresholds);
    const rawSpeed = pointSpeedKmh(curr);
    const speed = pointSpeed ?? (rawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh);
    const gradient = ((curr.altitude - prev.altitude) / distanceM) * 100;
    const accelMs2 = previousReliableSpeed == null
      ? 0
      : calculateAcceleration(previousReliableSpeed, speed, segment.dt);
    const isClimb = gradient >= hillGradeThreshold;
    const isDescent = gradient <= -hillGradeThreshold;

    if (isClimb) {
      climbDistanceKm += distanceM / 1000;
      if (speed >= 15 && accelMs2 > 2.5) infractionCount++;
      descentWindowStart = null;
    } else if (isDescent) {
      descentDistanceKm += distanceM / 1000;
      if (speed >= 15 && accelMs2 < -harshBrakeThreshold) infractionCount++;

      if (!descentWindowStart || (timestampMs(curr) - timestampMs(descentWindowStart)) / 1000 > 10) {
        descentWindowStart = curr;
        descentWindowSpeed = speed;
      } else if (speed >= 15 && speed - descentWindowSpeed > 15) {
        infractionCount++;
        descentWindowStart = curr;
        descentWindowSpeed = speed;
      }
    } else {
      descentWindowStart = null;
    }
    previousReliableSpeed = speed;
  }

  if (climbDistanceKm + descentDistanceKm < 0.2) {
    return {
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
    };
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
    .map((_, index) => reliablePointSpeed(cleanPoints, index))
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
  const avoidableIdleSeconds = stats.sustained_idle_seconds ?? stats.idle_time_seconds ?? 0;
  // FIX: Penalize sustained parked idle instead of unavoidable traffic-stop idle.
  const idleRatio = avoidableIdleSeconds / Math.max(1, stats.duration_seconds || 0);
  const idlePenalty = Math.min(25, idleRatio * 150);
  // FIX: Use a gentler eco idle curve capped at 25 points for avoidable idling.
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
    .map((_, index) => reliablePointSpeed(cleanPoints, index))
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

    const pointSpeed = reliablePointSpeed(cleanPoints, i, thresholds);
    const rawSpeed = pointSpeedKmh(curr);
    const speed = pointSpeed ?? (rawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh);
    const previousPointSpeed = reliablePointSpeed(cleanPoints, i - 1, thresholds) ?? finiteSpeed(prev);
    const accelMs2 = calculateAcceleration(previousPointSpeed, speed, segment.dt);
    if (speed > 5) totalMovingSeconds += segment.dt;
    if (speed >= 60 && speed <= 90 && accelMs2 >= -0.5 && accelMs2 <= 0.5) optimalBandSeconds += segment.dt;
    if (speed > 100) highSpeedSeconds += segment.dt;
    if (speed > 5 && speed < 30) cityCrawlSeconds += segment.dt;
  }

  const optimalBandRatio = totalMovingSeconds > 0 ? Math.round((optimalBandSeconds / totalMovingSeconds) * 100) : 0;
  const fuelBandScore = Math.min(100, Math.round(optimalBandRatio * 1.4));
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
    const speed = Math.max(
      reliablePointSpeed(points, i - 1, thresholds) ?? finiteSpeed(prev),
      reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(curr)
    );
    const minSpeed = thresholds.LANE_CHANGE_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.LANE_CHANGE_MIN_SPEED_KMH;
    if (speed < minSpeed) continue;

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
    const signedDelta = signedHeadingDelta(h1, h2);
    const turnRate = Math.abs(signedDelta) / dt;
    const minRate = thresholds.LANE_CHANGE_MIN_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.LANE_CHANGE_MIN_TURN_RATE_DEG_S;
    const maxRate = thresholds.LANE_CHANGE_MAX_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.LANE_CHANGE_MAX_TURN_RATE_DEG_S;

    const highwaySpeed = thresholds.LANE_CHANGE_HIGHWAY_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.LANE_CHANGE_HIGHWAY_MIN_SPEED_KMH;
    const windowStart = Math.max(0, i - 3);
    const windowEnd = Math.min(points.length - 1, i + 3);
    const windowPoints = points.slice(windowStart, windowEnd + 1);
    const windowDurationS = (timestampMs(points[windowEnd]) - timestampMs(points[windowStart])) / 1000;
    if (windowDurationS <= 0 || windowDurationS > 40) continue;

    let leftChange = 0;
    let rightChange = 0;
    let totalAbsChange = Math.abs(signedDelta);
    const nearbyHeadingDeltas = [];
    for (let j = Math.max(1, windowStart + 1); j <= windowEnd; j++) {
      const a = headingForIndex(points, j - 1);
      const b = headingForIndex(points, j);
      const delta = signedHeadingDelta(a, b);
      const deltaSeconds = Math.abs(timestampMs(points[j]) - timestampMs(curr)) / 1000;
      const absDelta = Math.abs(delta);
      totalAbsChange += j === i ? 0 : absDelta;
      if (deltaSeconds <= 8 && absDelta >= 1.5 && absDelta <= 20) nearbyHeadingDeltas.push(delta);
      if (delta > 0) rightChange += delta;
      if (delta < 0) leftChange += Math.abs(delta);
    }
    const hasCounterSteer = nearbyHeadingDeltas.some((delta) => (
      (signedDelta > 0 && delta < 0) || (signedDelta < 0 && delta > 0)
    )) || (leftChange >= 2.5 && rightChange >= 2.5);

    const headings = windowPoints.map((_, offset) => headingForIndex(points, windowStart + offset));
    const startHeading = headings[0];
    const endHeading = headings[headings.length - 1];
    const netHeadingChange = Math.abs(signedHeadingDelta(startHeading, endHeading));
    const peakExcursion = headings.reduce((peak, heading) => Math.max(peak, Math.abs(signedHeadingDelta(startHeading, heading))), 0);
    const windowSpeeds = windowPoints.map((_, offset) => reliablePointSpeed(points, windowStart + offset, thresholds) ?? finiteSpeed(points[windowStart + offset]));
    const stableSpeed = speedStdDev(windowSpeeds) <= (speed >= highwaySpeed ? 12 : 8);
    const sCurveLaneChange = hasCounterSteer &&
      peakExcursion >= 5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 6 &&
      totalAbsChange >= 10 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const highwayLaneShift = speed >= highwaySpeed &&
      hasCounterSteer &&
      peakExcursion >= 4.5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 7 &&
      totalAbsChange >= 9 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const pointRateFits = turnRate >= minRate && turnRate <= maxRate;

    if ((pointRateFits && hasCounterSteer && stableSpeed) || sCurveLaneChange || highwayLaneShift) {
      candidates.push({ point: curr, turnRate: Math.max(turnRate, totalAbsChange / windowDurationS), speed, pointIndex: i });
    }
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
        previous.speed = candidate.speed;
        previous.pointIndex = candidate.pointIndex;
      }
    } else {
      merged.push({ ...candidate, lastTime: candidateTime });
    }
  }

  const distanceKm = Math.max(1, calculateRouteDistanceKm(points, thresholds));
  const ratePer10Km = (merged.length / distanceKm) * 10;
  const severity = ratePer10Km >= 4 ? 'high' : ratePer10Km >= 2 ? 'medium' : 'low';

  return merged.map(({ point, turnRate, speed, pointIndex }) => ({
    type: EVENT_TYPES.LANE_CHANGE,
    severity,
    lat: point.lat,
    lng: point.lng,
    timestamp: point.timestamp,
    point_index: pointIndex,
    value: round1(turnRate),
    speed_kmh: Math.round(speed),
  }));
}

export function detectHighwayMergeBehavior(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  let mergeEventCount = 0;
  let poorMergeCount = 0;
  let harshMergeCount = 0;
  let windowStart = null;
  let windowPeakAccel = 0;
  const entrySpeedThreshold = thresholds.MERGE_ENTRY_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_ENTRY_SPEED_KMH;
  const exitSpeedThreshold = thresholds.MERGE_EXIT_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_EXIT_SPEED_KMH;

  for (let i = 0; i < cleanPoints.length; i++) {
    const point = cleanPoints[i];
    const speed = finiteSpeed(point);
    if (!windowStart && speed > 20 && speed < entrySpeedThreshold) {
      windowStart = point;
      windowPeakAccel = 0;
      continue;
    }

    if (!windowStart) continue;

    const duration = (timestampMs(point) - timestampMs(windowStart)) / 1000;
    if (duration <= 0) continue;
    if (duration > 20) {
      windowStart = speed > 20 && speed < entrySpeedThreshold ? point : null;
      windowPeakAccel = 0;
      continue;
    }

    const previous = cleanPoints[i - 1];
    if (previous) {
      const dt = (timestampMs(point) - timestampMs(previous)) / 1000;
      if (dt > 0 && dt <= 10) {
        windowPeakAccel = Math.max(windowPeakAccel, calculateAcceleration(finiteSpeed(previous), speed, dt));
      }
    }

    if (speed >= exitSpeedThreshold) {
      const entrySpeed = finiteSpeed(windowStart);
      const exitSpeed = speed;
      const accelMs2 = ((exitSpeed / 3.6) - (entrySpeed / 3.6)) / duration;
      const quality = exitSpeed < exitSpeedThreshold || duration < 5
        ? 'poor'
        : accelMs2 > 3.8 || windowPeakAccel > 4.5
          ? 'harsh'
          : 'good';

      mergeEventCount++;
      if (quality === 'poor') poorMergeCount++;
      if (quality === 'harsh') harshMergeCount++;
      windowStart = null;
      windowPeakAccel = 0;
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
  const followingMinSpeed = thresholds.FOLLOWING_GAP_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.FOLLOWING_GAP_MIN_SPEED_KMH;
  const cruiseSeconds = thresholds.FOLLOWING_GAP_CRUISE_SECONDS ?? DEFAULT_THRESHOLDS.FOLLOWING_GAP_CRUISE_SECONDS;
  const speedDropThreshold = thresholds.FOLLOWING_GAP_SPEED_DROP_KMH ?? DEFAULT_THRESHOLDS.FOLLOWING_GAP_SPEED_DROP_KMH;
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
      if (currSpeed >= followingMinSpeed) {
        state = 'CRUISING';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      }
      continue;
    }

    if (state === 'CRUISING') {
      if (currSpeed >= followingMinSpeed) {
        cruiseSpeed = Math.max(cruiseSpeed, currSpeed);
      } else if ((timestampMs(curr) - cruiseStartTime) / 1000 < cruiseSeconds) {
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

      if (speedDrop >= speedDropThreshold && elapsed <= 12) {
        events.push({
          type: EVENT_TYPES.TAILGATE_CYCLE,
          severity: maxDecel > 4.0 && speedDrop > 30 ? 'high' : maxDecel > 3.0 && speedDrop > 18 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: Math.round(speedDrop),
          speed_kmh: Math.round(cruiseSpeed),
        });
        state = currSpeed >= followingMinSpeed ? 'CRUISING' : 'IDLE';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      } else if (elapsed > 12 || currSpeed < Math.max(25, followingMinSpeed - 20)) {
        state = currSpeed >= followingMinSpeed ? 'CRUISING' : 'IDLE';
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

function pearsonCorrelation(xs = [], ys = []) {
  const count = Math.min(xs.length, ys.length);
  if (count < 2) return 0;
  const x = xs.slice(0, count);
  const y = ys.slice(0, count);
  const meanX = average(x);
  const meanY = average(y);
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < count; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denominator = Math.sqrt(denomX * denomY);
  return denominator > 0 ? numerator / denominator : 0;
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
      speed_kmh: reliablePointSpeed(cleanPoints, index, thresholds),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.speed_kmh) && sample.speed_kmh > 0);
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
      speed_kmh: reliablePointSpeed(cleanPoints, index, thresholds),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.speed_kmh) && sample.speed_kmh > 0);
  let count = 0;
  let maxCreep = 0;
  const severityCounts = { low: 0, medium: 0, high: 0 };
  let lastEventTime = 0;

  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.timestamp - lastEventTime < 30000) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 30000);
    if (window.length < 3 || window[window.length - 1].timestamp - start.timestamp < 25000) continue;
    if (calculateAngularStdDev(window.map((sample) => sample.heading)) >= 5) continue;

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

function emptyPhoneUseResult() {
  return {
    phone_use_events: [],
    phone_use_window_count: 0,
    phone_use_total_seconds: 0,
    phone_use_high_confidence_count: 0,
    phone_use_risk: 'none',
    phone_use_score: 100,
    phone_use_pct_of_trip: 0,
  };
}

/**
 * Detect likely phone-use windows from multi-signal GPS behavior evidence.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number,heading?:number}>} routePoints - Cleaned route points.
 * @param {Object} thresholds - Driving thresholds from buildDrivingThresholds.
 * @returns {{phone_use_events:Array,phone_use_window_count:number,phone_use_total_seconds:number,phone_use_high_confidence_count:number,phone_use_risk:string,phone_use_score:number,phone_use_pct_of_trip:number}} Phone-use result.
 * @example
 * const phoneUse = detectPhoneUseWindows(routePoints, buildDrivingThresholds(settings));
 */
export function detectPhoneUseWindows(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (thresholds.PHONE_USE_DETECTION_ENABLED === false) return emptyPhoneUseResult();
  const points = routePoints || [];
  if (points.length < 3) return emptyPhoneUseResult();

  const samples = points
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: reliablePointSpeed(points, index, thresholds) ?? finiteSpeed(point),
      heading: headingForIndex(points, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp));
  if (samples.length < 3) return emptyPhoneUseResult();

  const votes = [];
  const addVote = (signal, startIndex, endIndex, strength) => {
    if (startIndex < 0 || endIndex <= startIndex || !Number.isFinite(strength) || strength <= 0) return;
    votes.push({
      signal,
      startIndex: Math.max(0, startIndex),
      endIndex: Math.min(points.length - 1, endIndex),
      strength: Math.max(0, strength),
    });
  };

  const signedHeadingDeltas = samples.map((sample, index) => {
    if (index === 0) return 0;
    return signedHeadingDelta(samples[index - 1].heading, sample.heading);
  });
  const speedDeltas = samples.map((sample, index) => {
    if (index === 0) return 0;
    return sample.speed_kmh - samples[index - 1].speed_kmh;
  });
  const accelSamples = samples.map((sample, index) => {
    if (index === 0) return 0;
    const dt = (sample.timestamp - samples[index - 1].timestamp) / 1000;
    return dt > 0 ? calculateAcceleration(samples[index - 1].speed_kmh, sample.speed_kmh, dt) : 0;
  });

  // Signal 1: micro-steering oscillations.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 10000);
    if (window.length < 4) continue;
    let oscillations = 0;
    for (let j = 2; j < window.length; j++) {
      const globalIndex = window[j].index;
      const d1 = signedHeadingDeltas[Math.max(0, globalIndex - 1)];
      const d2 = signedHeadingDeltas[globalIndex];
      const bothMicro = Math.abs(d1) >= 3 && Math.abs(d1) <= 18 && Math.abs(d2) >= 3 && Math.abs(d2) <= 18;
      if (bothMicro && Math.sign(d1) !== Math.sign(d2)) oscillations++;
    }
    if (oscillations >= (thresholds.PHONE_MICRO_STEER_COUNT ?? 4)) {
      addVote('micro_steer', window[0].index, window[window.length - 1].index, Math.min(1, oscillations / 8));
      i += Math.max(1, Math.floor(window.length / 2));
    }
  }

  // Signal 2: speed creep without intent followed by abrupt correction.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 15000);
    if (window.length < 5) continue;
    const durationS = (window[window.length - 1].timestamp - window[0].timestamp) / 1000;
    if (durationS <= 0) continue;
    const speeds = window.map((sample) => sample.speed_kmh);
    const driftRate = (Math.max(...speeds) - Math.min(...speeds)) / durationS;
    const risingPairs = speeds.slice(1).filter((speed, index) => speed >= speeds[index] - 0.5).length;
    const trendIsMonotonic = risingPairs / Math.max(1, speeds.length - 1) >= 0.75 &&
      Math.max(...window.map((sample) => Math.abs(accelSamples[sample.index] || 0))) < 2.5;
    const after = samples.filter((sample) => sample.timestamp > window[window.length - 1].timestamp && sample.timestamp <= window[window.length - 1].timestamp + 3000);
    const correctionAbrupt = after.some((sample) => (accelSamples[sample.index] || 0) <= -1.5);
    if (driftRate >= (thresholds.PHONE_CREEP_RATE_KMH_S ?? 1.5) && trendIsMonotonic && correctionAbrupt) {
      addVote('speed_creep', window[0].index, window[window.length - 1].index, 0.7);
    }
  }

  // Signal 3: attention gap against rolling speed pattern.
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.speed_kmh < 30) continue;
    const history = samples.filter((entry) => entry.timestamp >= sample.timestamp - 20000 && entry.timestamp < sample.timestamp);
    if (history.length < 5) continue;
    const rollingSpeed = average(history.map((entry) => entry.speed_kmh));
    if (Math.abs(sample.speed_kmh - rollingSpeed) < 8) continue;
    const gap = samples.filter((entry) => entry.timestamp >= sample.timestamp && entry.timestamp <= sample.timestamp + 5000);
    if (gap.length < 3 || gap[gap.length - 1].timestamp - gap[0].timestamp < 4000) continue;
    const noInput = gap.every((entry) => Math.abs(accelSamples[entry.index] || 0) <= 0.4);
    if (noInput) addVote('attention_gap', gap[0].index, gap[gap.length - 1].index, 0.8);
  }

  // Signal 4: lane drift and recovery.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 40) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 8000);
    if (window.length < 5) continue;
    const firstHalf = window.filter((sample) => sample.timestamp <= start.timestamp + 4000);
    if (firstHalf.length < 3) continue;
    const driftValues = firstHalf.map((sample) => signedHeadingDelta(firstHalf[0].heading, sample.heading));
    const driftMagnitude = Math.max(...driftValues.map(Math.abs));
    const peakOffset = driftValues.findIndex((value) => Math.abs(value) === driftMagnitude);
    const peak = firstHalf[Math.max(0, peakOffset)];
    const recovery = window[window.length - 1];
    const timeToRecover = Math.max(0.5, (recovery.timestamp - peak.timestamp) / 1000);
    const recoverySpeed = headingDiff(recovery.heading, peak.heading) / timeToRecover;
    if (driftMagnitude >= (thresholds.PHONE_LANE_DRIFT_DEG ?? 8) && recoverySpeed >= 3) {
      addVote('lane_drift', window[0].index, window[window.length - 1].index, Math.min(1, driftMagnitude / 20));
    }
  }

  // Signal 5: speed-heading decoupling.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 20000);
    if (window.length < 8) continue;
    const headingChanges = window.map((sample) => Math.abs(signedHeadingDeltas[sample.index] || 0));
    const speedChanges = window.map((sample) => Math.abs(speedDeltas[sample.index] || 0));
    if (average(headingChanges) < 1 || average(speedChanges) < 0.2) continue;
    const correlation = pearsonCorrelation(headingChanges, speedChanges);
    const threshold = thresholds.PHONE_COUPLING_THRESHOLD ?? 0.15;
    if (correlation < threshold) {
      addVote('speed_heading_decoupling', window[0].index, window[window.length - 1].index, Math.min(1, (threshold - correlation) * 5));
    }
  }

  if (!votes.length) return emptyPhoneUseResult();

  const timeline = new Array(points.length).fill(0);
  for (const vote of votes) {
    for (let i = vote.startIndex; i <= vote.endIndex; i++) timeline[i] += vote.strength;
  }
  const kernel = [0.1, 0.2, 0.4, 0.2, 0.1];
  const smoothed = timeline.map((_, index) => kernel.reduce((sum, weight, kernelIndex) => {
    const sourceIndex = index + kernelIndex - 2;
    return sum + weight * (timeline[sourceIndex] || 0);
  }, 0));

  const confidenceThreshold = thresholds.PHONE_CONFIDENCE_THRESHOLD ?? 0.40;
  const runs = [];
  let startRun = null;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] >= confidenceThreshold && startRun == null) startRun = i;
    if ((smoothed[i] < confidenceThreshold || i === smoothed.length - 1) && startRun != null) {
      const endRun = smoothed[i] < confidenceThreshold ? i - 1 : i;
      if (endRun >= startRun) runs.push({ startIndex: startRun, endIndex: endRun });
      startRun = null;
    }
  }

  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const gapS = previous ? (timestampMs(points[run.startIndex]) - timestampMs(points[previous.endIndex])) / 1000 : Infinity;
    if (previous && gapS < 8) previous.endIndex = run.endIndex;
    else merged.push({ ...run });
  }

  const minWindowS = thresholds.PHONE_MIN_WINDOW_S ?? 4;
  const events = merged
    .map((run) => {
      const startTimeMs = timestampMs(points[run.startIndex]);
      const endTimeMs = timestampMs(points[run.endIndex]);
      const durationS = Math.max(0, (endTimeMs - startTimeMs) / 1000);
      if (durationS < minWindowS) return null;
      const midpointIndex = Math.round((run.startIndex + run.endIndex) / 2);
      const signalsTriggered = [...new Set(votes
        .filter((vote) => vote.startIndex <= run.endIndex && vote.endIndex >= run.startIndex)
        .map((vote) => vote.signal))];
      const windowSamples = samples.filter((sample) => sample.index >= run.startIndex && sample.index <= run.endIndex);
      const windowDeltas = windowSamples
        .slice(1)
        .map((sample, offset) => signedHeadingDelta(windowSamples[offset].heading, sample.heading));
      const cumulativeHeadingChange = windowDeltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
      const netHeadingChange = windowSamples.length >= 2
        ? headingDiff(windowSamples[0].heading, windowSamples[windowSamples.length - 1].heading)
        : 0;
      const sustainedTurnLike = netHeadingChange >= 35 || (
        durationS <= 12 &&
        cumulativeHeadingChange >= 70 &&
        !signalsTriggered.includes('micro_steer')
      );
      if (sustainedTurnLike && signalsTriggered.length < 2) return null;

      const confidence = Math.min(1, average(smoothed.slice(run.startIndex, run.endIndex + 1)));
      const meanSpeed = average(windowSamples.map((sample) => sample.speed_kmh));
      const confidenceLevel = confidence < 0.55 ? 'low' : confidence < 0.75 ? 'medium' : 'high';
      const severity = confidence < 0.55 || meanSpeed < 50
        ? 'low'
        : confidence < 0.75 || meanSpeed < 80
          ? 'medium'
          : 'high';
      return {
        type: EVENT_TYPES.PHONE_USE,
        startIndex: run.startIndex,
        endIndex: run.endIndex,
        point_index: midpointIndex,
        startTime: new Date(startTimeMs).toISOString(),
        endTime: new Date(endTimeMs).toISOString(),
        timestamp: new Date(startTimeMs).toISOString(),
        durationS: Math.round(durationS),
        duration_seconds: Math.round(durationS),
        lat: points[midpointIndex]?.lat,
        lng: points[midpointIndex]?.lng,
        speed_kmh: Math.round(meanSpeed),
        confidence: round2(confidence),
        confidence_level: confidenceLevel,
        signals_triggered: signalsTriggered,
        context_flags: sustainedTurnLike ? ['turn_or_merge_context'] : [],
        severity,
        value: round2(confidence),
      };
    })
    .filter(Boolean);

  const totalSeconds = events.reduce((sum, event) => sum + (event.durationS || 0), 0);
  const highConfidenceCount = events.filter((event) => event.confidence >= 0.75).length;
  const anyVeryFast = events.some((event) => event.speed_kmh >= 100);
  const phoneUseRisk = events.length === 0
    ? 'none'
    : highConfidenceCount >= 3 || totalSeconds > 90 || anyVeryFast
      ? 'high'
      : highConfidenceCount >= 1 || totalSeconds >= 30
        ? 'medium'
        : 'low';
  const scorePenalty = events.reduce((sum, event) => (
    sum + (event.severity === 'high' ? 20 : event.severity === 'medium' ? 8 : 3)
  ), 0) + (anyVeryFast ? 15 : 0);
  const tripDurationS = Math.max(1, (timestampMs(points[points.length - 1]) - timestampMs(points[0])) / 1000);

  return {
    phone_use_events: events,
    phone_use_window_count: events.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - scorePenalty)),
    phone_use_pct_of_trip: round2((totalSeconds / tripDurationS) * 100),
  };
}

export function detectPhoneUsageProxy(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const result = detectPhoneUseWindows(cleanPoints, thresholds);
  return {
    phone_proxy_count: result.phone_use_window_count,
    phone_proxy_risk: result.phone_use_risk === 'none' ? 'none' : result.phone_use_risk === 'low' ? 'possible' : 'likely',
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

/**
 * Extract contiguous braking sequences from route points.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} thresholds - Driving thresholds used for speed/noise filtering.
 * @param {{startSpeedKmh?:number,endSpeedKmh?:number,minEntryKmh?:number}} options - Sequence speed gates.
 * @returns {Array<{points:Array,entrySpeed:number,exitSpeed:number,durationS:number,distanceM:number}>} Braking sequences.
 * @example
 * const sequences = extractBrakingSequences(points, DEFAULT_THRESHOLDS, { minEntryKmh: 30 });
 */
export function extractBrakingSequences(routePoints, thresholds = DEFAULT_THRESHOLDS, {
  startSpeedKmh = 25,
  endSpeedKmh = 5,
  minEntryKmh = 25,
} = {}) {
  const points = routePoints || [];
  if (points.length < 2) return [];

  const sequences = [];
  let active = null;
  let lastAccelNegative = false;

  const finishSequence = (includePoint = null) => {
    if (!active || active.points.length < 2) {
      active = null;
      lastAccelNegative = false;
      return;
    }
    const sequencePoints = includePoint && active.points[active.points.length - 1] !== includePoint
      ? [...active.points, includePoint]
      : [...active.points];
    const entrySpeed = finiteSpeed(sequencePoints[0]);
    const exitSpeed = finiteSpeed(sequencePoints[sequencePoints.length - 1]);
    if (entrySpeed >= minEntryKmh && exitSpeed <= endSpeedKmh) {
      const durationS = Math.max(0, (timestampMs(sequencePoints[sequencePoints.length - 1]) - timestampMs(sequencePoints[0])) / 1000);
      let distanceM = 0;
      for (let j = 1; j < sequencePoints.length; j++) {
        distanceM += haversineMeters(sequencePoints[j - 1].lat, sequencePoints[j - 1].lng, sequencePoints[j].lat, sequencePoints[j].lng);
      }
      if (durationS > 0) {
        sequences.push({
          points: sequencePoints,
          entrySpeed: round1(entrySpeed),
          exitSpeed: round1(exitSpeed),
          durationS: round1(durationS),
          distanceM: round1(distanceM),
        });
      }
    }
    active = null;
    lastAccelNegative = false;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) {
      finishSequence();
      continue;
    }

    const prevSpeed = finiteSpeed(prev);
    const currSpeed = finiteSpeed(curr);
    const accel = calculateAcceleration(prevSpeed, currSpeed, dt);
    const decelerating = accel < -0.05 && currSpeed <= prevSpeed;

    if (!active) {
      if (decelerating && prevSpeed >= startSpeedKmh) {
        active = { points: [prev, curr] };
        lastAccelNegative = true;
        if (currSpeed <= endSpeedKmh) finishSequence();
      }
      continue;
    }

    if (decelerating || (lastAccelNegative && currSpeed <= prevSpeed + 1)) {
      active.points.push(curr);
      lastAccelNegative = decelerating;
      if (currSpeed <= endSpeedKmh) finishSequence();
      continue;
    }

    if (currSpeed <= endSpeedKmh) finishSequence(curr);
    else finishSequence();
  }

  finishSequence();
  return sequences;
}

/**
 * Estimate braking reaction timing around harsh-brake and near-miss events.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string,timestamp?:string,point_index?:number,speed_kmh?:number}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds, including REACTION_SPEED_TRIGGER_KMH.
 * @returns {{reaction_score:number,avg_reaction_seconds:number,reaction_grade:string,reaction_sample_count:number}} Reaction score fields.
 * @example
 * const reaction = calculateReactionTimeProxy(points, events, DEFAULT_THRESHOLDS);
 */
export function calculateReactionTimeProxy(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const targetEvents = (drivingEvents || []).filter((event) => (
    event.type === EVENT_TYPES.HARSH_BRAKE || event.type === EVENT_TYPES.NEAR_MISS
  ));
  if (points.length < 2 || !targetEvents.length) {
    return {
      reaction_score: 100,
      avg_reaction_seconds: 0,
      reaction_grade: 'anticipatory',
      reaction_sample_count: 0,
    };
  }

  const triggerDelta = thresholds.REACTION_SPEED_TRIGGER_KMH ?? DEFAULT_THRESHOLDS.REACTION_SPEED_TRIGGER_KMH;
  let totalPenalty = 0;
  const windows = [];

  for (const event of targetEvents) {
    const eventIndex = nearestPointIndexByTimestamp(points, event);
    if (eventIndex <= 0) continue;
    const eventPoint = points[eventIndex];
    const eventSpeed = Number.isFinite(event.speed_kmh)
      ? event.speed_kmh
      : reliablePointSpeed(points, eventIndex, thresholds) ?? finiteSpeed(eventPoint);
    if (eventSpeed < (thresholds.MIN_SPEED_HARSH_BRAKE_KMH ?? DEFAULT_THRESHOLDS.MIN_SPEED_HARSH_BRAKE_KMH)) continue;
    const eventMs = timestampMs(eventPoint);
    let triggerIndex = -1;

    for (let i = eventIndex - 1; i >= 0; i--) {
      const deltaS = (eventMs - timestampMs(points[i])) / 1000;
      if (deltaS > 5) break;
      const speed = reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(points[i]);
      const nextSpeed = reliablePointSpeed(points, Math.min(eventIndex, i + 1), thresholds) ?? finiteSpeed(points[Math.min(eventIndex, i + 1)]);
      if (speed >= eventSpeed + triggerDelta && nextSpeed <= speed) {
        triggerIndex = i;
      }
    }

    if (triggerIndex < 0) continue;
    const reactionWindowSeconds = Math.max(0, (eventMs - timestampMs(points[triggerIndex])) / 1000);
    windows.push(reactionWindowSeconds);
    if (reactionWindowSeconds <= 1.0) totalPenalty += 0;
    else if (reactionWindowSeconds <= 2.0) totalPenalty += 2;
    else if (reactionWindowSeconds <= 3.5) totalPenalty += 6;
    else totalPenalty += 12;
  }

  if (!windows.length) {
    return {
      reaction_score: 100,
      avg_reaction_seconds: 0,
      reaction_grade: 'anticipatory',
      reaction_sample_count: 0,
    };
  }

  const distFactor = Math.max(1, calculateRouteDistanceKm(points, thresholds));
  const reactionScore = Math.max(20, Math.round(100 - Math.min(totalPenalty * (5 / distFactor), 80)));
  return {
    reaction_score: reactionScore,
    avg_reaction_seconds: round2(average(windows)),
    reaction_grade: reactionScore >= 85 ? 'anticipatory' : reactionScore >= 70 ? 'normal' : reactionScore >= 50 ? 'reactive' : 'delayed',
    reaction_sample_count: windows.length,
  };
}

function lateralGForTriplet(points, index, thresholds = DEFAULT_THRESHOLDS) {
  if (index <= 0 || index >= points.length - 1) return null;
  const prev = points[index - 1];
  const curr = points[index];
  const next = points[index + 1];
  const prevSegment = calculateSegmentMetrics(prev, curr, thresholds);
  const nextSegment = calculateSegmentMetrics(curr, next, thresholds);
  if (prevSegment.dt <= 0 || nextSegment.dt <= 0 || prevSegment.dt > 8 || nextSegment.dt > 8) return null;
  if (prevSegment.isNoise || nextSegment.isNoise || prevSegment.distanceM < 8 || nextSegment.distanceM < 8) return null;
  const h1 = calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  const h2 = calculateBearing(curr.lat, curr.lng, next.lat, next.lng);
  const rawHeadingChange = headingDiff(h1, h2);
  const effectiveDt = Math.max(1.5, (prevSegment.dt + nextSegment.dt) / 2);
  const omegaRadPerSec = (rawHeadingChange * Math.PI / 180) / effectiveDt;
  const speed = Math.max(finiteSpeed(prev), finiteSpeed(curr), finiteSpeed(next), nextSegment.reliableSpeedKmh);
  return (speed / 3.6 * omegaRadPerSec) / 9.81;
}

/**
 * Score consistency across all cornering samples, not only sharp-turn events.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} thresholds - Driving thresholds for GPS filtering.
 * @returns {{cornering_consistency_score:number|null,cornering_grade:string,mean_lateral_g:number,peak_lateral_g:number,corner_sample_count:number}} Cornering fields.
 * @example
 * const cornering = calculateCorneringConsistency(points, DEFAULT_THRESHOLDS);
 */
export function calculateCorneringConsistency(routePoints, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const cornerSamples = [];
  for (let i = 1; i < points.length - 1; i++) {
    if (finiteSpeed(points[i]) <= 20) continue;
    const lateralG = lateralGForTriplet(points, i, thresholds);
    if (Number.isFinite(lateralG) && lateralG > 0.05) cornerSamples.push(lateralG);
  }

  if (cornerSamples.length < 5) {
    return {
      cornering_consistency_score: null,
      cornering_grade: 'insufficient_data',
      mean_lateral_g: 0,
      peak_lateral_g: 0,
      corner_sample_count: cornerSamples.length,
    };
  }

  const meanG = average(cornerSamples);
  const stdG = stddev(cornerSamples);
  const cv = stdG / Math.max(0.01, meanG);
  const peakG = Math.max(...cornerSamples);
  const consistencyBase = Math.max(0, 100 - cv * 120);
  const peakPenalty = Math.max(0, (peakG - 0.50) * 60);
  const score = Math.max(0, Math.round(consistencyBase - peakPenalty));
  return {
    cornering_consistency_score: score,
    cornering_grade: score >= 85 ? 'fluid' : score >= 70 ? 'controlled' : score >= 50 ? 'variable' : 'erratic',
    mean_lateral_g: round2(meanG),
    peak_lateral_g: round2(peakG),
    corner_sample_count: cornerSamples.length,
  };
}

function brakingEfficiencyGrade(score) {
  if (score == null) return 'insufficient_data';
  if (score >= 85) return 'progressive';
  if (score >= 65) return 'adequate';
  if (score >= 45) return 'abrupt';
  return 'emergency_heavy';
}

/**
 * Score progressive braking quality across meaningful full-stop sequences.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds, including HARSH_BRAKE_MS2.
 * @returns {{braking_efficiency_score:number|null,braking_efficiency_grade:string,braking_sequence_count:number,avg_braking_smoothness:number}} Braking efficiency fields.
 * @example
 * const braking = calculateBrakingEfficiency(points, events, DEFAULT_THRESHOLDS);
 */
export function calculateBrakingEfficiency(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const sequences = extractBrakingSequences(routePoints, thresholds, {
    startSpeedKmh: 25,
    endSpeedKmh: 5,
    minEntryKmh: 25,
  });
  if (!sequences.length) {
    return {
      braking_efficiency_score: null,
      braking_efficiency_grade: 'insufficient_data',
      braking_sequence_count: 0,
      avg_braking_smoothness: 0,
    };
  }

  const harshThreshold = thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  const sequenceScores = [];
  const smoothnessValues = [];

  for (const sequence of sequences) {
    const decelSamples = [];
    for (let i = 1; i < sequence.points.length; i++) {
      const prev = sequence.points[i - 1];
      const curr = sequence.points[i];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 30) continue;
      const accel = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
      if (accel < 0) decelSamples.push(Math.abs(accel));
    }
    if (!decelSamples.length) continue;

    const meanDecel = average(decelSamples);
    const smoothnessIndex = clamp(1 - (stddev(decelSamples) / Math.max(0.1, meanDecel)), 0, 1);
    const expectedMinDuration = sequence.entrySpeed / (3.6 * harshThreshold);
    const efficiencyRatio = expectedMinDuration > 0 ? sequence.durationS / expectedMinDuration : 0;
    const sequenceScore = Math.min(100, Math.round(
      Math.min(1, efficiencyRatio / 3) * 50 +
      smoothnessIndex * 50
    ));
    sequenceScores.push(sequenceScore);
    smoothnessValues.push(smoothnessIndex);
  }

  const score = sequenceScores.length ? Math.round(average(sequenceScores)) : null;
  return {
    braking_efficiency_score: score,
    braking_efficiency_grade: brakingEfficiencyGrade(score),
    braking_sequence_count: sequences.length,
    avg_braking_smoothness: round2(average(smoothnessValues)),
  };
}

function complianceFallbackLimit(roadType, thresholds = DEFAULT_THRESHOLDS) {
  if (roadType === 'highway') return thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  if (roadType === 'residential') return 40;
  return 60;
}

/**
 * Calculate speed-limit compliance breakdown by inferred road type.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} stats - Trip stats, optionally including speed_zones.
 * @param {Object} thresholds - Driving thresholds for speed-over-limit tolerance.
 * @returns {{highway_compliance:Object|null,urban_compliance:Object|null,residential_compliance:Object|null,overall_compliance_score:number}} Compliance fields.
 * @example
 * const compliance = calculateSpeedLimitCompliance(points, stats, DEFAULT_THRESHOLDS);
 */
export function calculateSpeedLimitCompliance(routePoints, stats = {}, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const roadTypes = classifyRoadTypesByPoint(points);
  const zones = Array.isArray(stats.speed_zones) ? stats.speed_zones : inferSpeedZones(points, thresholds);
  const byType = {
    highway: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0 },
    urban: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0 },
    residential: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0 },
  };
  const speedOver = thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH;

  points.forEach((point, index) => {
    const speed = reliablePointSpeed(points, index, thresholds);
    if (!Number.isFinite(speed)) return;
    if (speed <= (thresholds.STATIONARY_SPEED_KMH ?? DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH)) return;
    const roadType = roadTypes[index] || 'urban';
    const zone = zones.find((item) => index >= item.startIndex && index <= item.endIndex);
    const limit = zone?.inferredZoneKmh ?? complianceFallbackLimit(roadType, thresholds);
    const bucket = byType[roadType];
    bucket.totalPoints++;
    bucket.limitTotal += limit;
    bucket.maxSpeed = Math.max(bucket.maxSpeed, speed);
    if (speed > limit + speedOver) bucket.overLimitPoints++;
  });

  const build = (bucket) => {
    if (!bucket.totalPoints) return null;
    const inferredLimit = Math.round(bucket.limitTotal / bucket.totalPoints);
    const rate = 1 - bucket.overLimitPoints / bucket.totalPoints;
    const maxExcessKmh = Math.max(0, bucket.maxSpeed - inferredLimit);
    return {
      score: clamp(Math.round(rate * 100 - maxExcessKmh * 0.5), 0, 100),
      rate: round2(rate),
      max_excess_kmh: round1(maxExcessKmh),
      inferred_limit_kmh: inferredLimit,
      point_count: bucket.totalPoints,
    };
  };

  const highway = build(byType.highway);
  const urban = build(byType.urban);
  const residential = build(byType.residential);
  const weighted = [highway, urban, residential].filter(Boolean);
  const totalPoints = weighted.reduce((sum, item) => sum + item.point_count, 0);
  const overall = totalPoints
    ? Math.round(weighted.reduce((sum, item) => sum + item.score * item.point_count, 0) / totalPoints)
    : 100;

  return {
    highway_compliance: highway,
    urban_compliance: urban,
    residential_compliance: residential,
    overall_compliance_score: overall,
  };
}

/**
 * Score the quality of detected overtake windows.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number,heading?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string,timestamp?:string,speed_kmh?:number}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{overtake_quality_score:number|null,overtake_quality_grade:string,overtake_count:number,unsafe_reentry_count:number}} Overtake fields.
 * @example
 * const overtake = calculateOvertakeQualityScore(points, events, DEFAULT_THRESHOLDS);
 */
export function calculateOvertakeQualityScore(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  if (points.length < 2) {
    return {
      overtake_quality_score: null,
      overtake_quality_grade: 'none',
      overtake_count: 0,
      unsafe_reentry_count: 0,
    };
  }

  const windows = [];
  for (const event of drivingEvents || []) {
    const isOvertake = event.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE ||
      (event.type === EVENT_TYPES.LANE_CHANGE && (event.speed_kmh ?? 0) >= 80);
    if (!isOvertake) continue;
    const index = nearestPointIndexByTimestamp(points, event);
    if (index < 0) continue;
    const center = timestampMs(points[index]);
    windows.push({ start: center - 3000, end: center + 3000 });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }

  if (!merged.length) {
    return {
      overtake_quality_score: null,
      overtake_quality_grade: 'none',
      overtake_count: 0,
      unsafe_reentry_count: 0,
    };
  }

  const harshBrakeTimes = (drivingEvents || [])
    .filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE)
    .map((event) => timestampMs(event))
    .filter((time) => Number.isFinite(time));
  const windowScores = [];
  let unsafeReentryCount = 0;

  for (const window of merged) {
    const samples = points.filter((point) => {
      const time = timestampMs(point);
      return time >= window.start && time <= window.end;
    });
    if (samples.length < 2) continue;
    const speeds = samples.map(finiteSpeed);
    const entrySpeed = speeds[0];
    const peakSpeed = Math.max(...speeds);
    const speedDelta = peakSpeed - entrySpeed;
    const headings = samples.map((point, index) => (
      Number.isFinite(point.heading) ? point.heading : headingForIndex(samples, index)
    ));
    const headingVariance = Math.pow(calculateAngularStdDev(headings), 2);
    const postOvertakeBrake = harshBrakeTimes.some((time) => time > window.end && time <= window.end + 5000);
    if (postOvertakeBrake) unsafeReentryCount++;
    const score = clamp(
      80 -
      (speedDelta > 30 ? 15 : speedDelta > 20 ? 8 : 0) -
      (headingVariance > 40 ? 15 : headingVariance > 20 ? 8 : 0) -
      (postOvertakeBrake ? 20 : 0),
      0,
      100
    );
    windowScores.push(score);
  }

  const score = windowScores.length ? Math.round(average(windowScores)) : null;
  return {
    overtake_quality_score: score,
    overtake_quality_grade: score == null ? 'none' : score >= 80 ? 'confident' : score >= 60 ? 'adequate' : score >= 40 ? 'borderline' : 'dangerous',
    overtake_count: merged.length,
    unsafe_reentry_count: unsafeReentryCount,
  };
}

/**
 * Detect possible wet or slippery conditions from unusually long stopping distances.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{slippery_proxy:string,wet_signal_count:number,wet_ratio:number,safety_condition_bonus:number,avg_distance_ratio:number}} Road-condition proxy fields.
 * @example
 * const conditions = detectSlipperyConditionProxy(points, events, DEFAULT_THRESHOLDS);
 */
export function detectSlipperyConditionProxy(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const sequences = extractBrakingSequences(routePoints, thresholds, {
    startSpeedKmh: 30,
    endSpeedKmh: 5,
    minEntryKmh: 30,
  });
  const ratios = [];
  for (const sequence of sequences) {
    const entrySpeedMps = sequence.entrySpeed / 3.6;
    const theoreticalDryStoppingDistanceM = (entrySpeedMps * entrySpeedMps) / (2 * 0.75 * 9.81);
    if (theoreticalDryStoppingDistanceM > 0) {
      ratios.push(sequence.distanceM / theoreticalDryStoppingDistanceM);
    }
  }

  if (ratios.length < 3) {
    return {
      slippery_proxy: 'insufficient_data',
      wet_signal_count: 0,
      wet_ratio: 0,
      safety_condition_bonus: 0,
      avg_distance_ratio: round2(average(ratios)),
    };
  }

  const wetSignalCount = ratios.filter((ratio) => ratio > 1.5).length;
  const wetRatio = wetSignalCount / ratios.length;
  const slipperyProxy = wetRatio >= 0.50 ? 'likely_wet' : wetRatio >= 0.30 ? 'possible_wet' : 'appears_dry';
  return {
    slippery_proxy: slipperyProxy,
    wet_signal_count: wetSignalCount,
    wet_ratio: round2(wetRatio),
    safety_condition_bonus: slipperyProxy === 'likely_wet' ? 5 : slipperyProxy === 'possible_wet' ? 2 : 0,
    avg_distance_ratio: round2(average(ratios)),
  };
}

/**
 * Score trip behavior independently across highway, urban, and residential route portions.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string,timestamp?:string,point_index?:number}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} stats - Trip stats.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{highway_score:Object|null,urban_score:Object|null,residential_score:Object|null,dominant_road_type:string}} Road-type scores.
 * @example
 * const segments = calculateRoadTypeSegmentedScores(points, events, stats, DEFAULT_THRESHOLDS);
 */
export function calculateRoadTypeSegmentedScores(routePoints, drivingEvents = [], stats = {}, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const roadTypes = classifyRoadTypesByPoint(points);
  const result = {
    highway_score: null,
    urban_score: null,
    residential_score: null,
    dominant_road_type: 'mixed',
  };
  if (points.length < 2) return result;

  const eventBuckets = { highway: [], urban: [], residential: [] };
  for (const event of drivingEvents || []) {
    const index = nearestPointIndexByTimestamp(points, event);
    const roadType = roadTypes[index];
    if (eventBuckets[roadType]) eventBuckets[roadType].push(event);
  }

  const typeMetrics = { highway: { distance: 0, seconds: 0 }, urban: { distance: 0, seconds: 0 }, residential: { distance: 0, seconds: 0 } };
  for (let i = 1; i < points.length; i++) {
    const type = roadTypes[i] || roadTypes[i - 1] || 'urban';
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise || !typeMetrics[type]) continue;
    typeMetrics[type].distance += segment.distanceKm;
    typeMetrics[type].seconds += segment.dt;
  }

  const distances = Object.entries(typeMetrics).sort((a, b) => b[1].distance - a[1].distance);
  if (distances[0]?.[1].distance > 0) {
    const top = distances[0];
    const second = distances[1];
    result.dominant_road_type = second && second[1].distance / top[1].distance > 0.55 ? 'mixed' : top[0];
  }

  for (const type of ['highway', 'urban', 'residential']) {
    const metric = typeMetrics[type];
    if (metric.distance < 2 || metric.seconds < 60) continue;
    const slice = points.filter((_, index) => roadTypes[index] === type);
    if (slice.length < 3) continue;
    const segmentStats = {
      distance_km: round2(metric.distance),
      duration_seconds: Math.round(metric.seconds),
      avg_speed_kmh: metric.seconds > 0 ? round1(calculateSpeedKmh(metric.distance, metric.seconds)) : 0,
      fatigue_risk_score: 0,
      intersection_score: 100,
      idle_time_seconds: 0,
    };
    const segmentDetection = detectDrivingEvents(slice, thresholds);
    const segmentEvents = Reflect.get(segmentDetection, 'events') ?? segmentDetection;
    const segmentScores = calculateTripScores(segmentEvents, segmentStats, slice, thresholds, segmentStats.duration_seconds, Reflect.get(segmentDetection, 'phoneUse') ?? {}, {
      includeRoadTypeSegments: false,
    });
    result[`${type}_score`] = {
      overall: segmentScores.score_overall,
      safety: segmentScores.score_safety,
      smoothness: segmentScores.score_smoothness,
      eco: segmentScores.score_eco,
      distance_km: round2(metric.distance),
      event_count: eventBuckets[type].length || segmentEvents.length,
    };
  }

  return result;
}

export function analyzeParkingApproach(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS, endTime = null) {
  if (!cleanPoints || cleanPoints.length < 3) {
    return {
      parking_approach_score: 100,
      parking_approach_grade: 'smooth',
      parking_stop_detected: false,
      parking_stop_duration_seconds: 0,
    };
  }

  const lastPoint = cleanPoints[cleanPoints.length - 1];
  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(cleanPoints, endTime, thresholds);
  const lookbackSeconds = thresholds.PARKING_LOOKBACK_SECONDS ?? DEFAULT_THRESHOLDS.PARKING_LOOKBACK_SECONDS;
  const cutoff = timestampMs(lastPoint) - lookbackSeconds * 1000;
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
    return {
      parking_approach_score: 100,
      parking_approach_grade: 'smooth',
      parking_stop_detected: finiteSpeed(lastPoint) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH),
      parking_stop_duration_seconds: Math.round(terminalStoppedSeconds),
    };
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
    parking_stop_detected: finiteSpeed(lastPoint) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH),
    parking_stop_duration_seconds: Math.round(terminalStoppedSeconds),
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
  const detection = detectDrivingEvents(points, thresholds);
  const events = Reflect.get(detection, 'events') ?? detection;
  const stats = calculateSegmentStats(points, thresholds);
  return calculateTripScores(events, stats, points, thresholds, stats.duration_seconds, Reflect.get(detection, 'phoneUse') ?? {}).score_overall;
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

function attachEventResult(events = [], phoneUse = emptyPhoneUseResult()) {
  Object.defineProperty(events, 'events', {
    value: events,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(events, 'phoneUse', {
    value: phoneUse,
    enumerable: false,
    configurable: true,
  });
  return events;
}

export function detectDrivingEvents(points, thresholds = DEFAULT_THRESHOLDS, endTime = null) {
  const events = [];
  if (!points || points.length < 3) return attachEventResult(events);

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
  const MIN_POINTS_BEFORE_EVENTS = 0;
  const MIN_SPEEDING_SECONDS = 3;
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const smoothedAccels = computeSmoothedAccelerations(points, thresholds);
  const configuredSpeedThreshold = thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  const inferredZones = inferSpeedZones(points, thresholds);
  const zoneForIndex = (index) => inferredZones.find((zone) => index >= zone.startIndex && index <= zone.endIndex) || null;

  let idleStart = null;
  let idleAccum = 0;
  let previousReliableSpeed = points[0]?.speed_kmh ?? 0;
  let acceptedSegmentCount = 0;
  let speedingAccumSeconds = 0;
  let speedingStart = null;
  let speedingPeakPoint = null;
  let speedingPeakSpeed = 0;
  let speedingZone = null;

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
        inferred_zone_kmh: speedingZone?.inferredZoneKmh ?? null,
        zone_confidence: speedingZone?.confidence ?? null,
      });
    }

    speedingAccumSeconds = 0;
    speedingStart = null;
    speedingPeakPoint = null;
    speedingPeakSpeed = 0;
    speedingZone = null;
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
    const speed2 = reliablePointSpeed(points, i, thresholds) ?? currSegment.impliedSpeedKmh;

    if (acceptedSegmentCount <= MIN_POINTS_BEFORE_EVENTS) {
      previousReliableSpeed = speed2;
      continue;
    }

    const smooth = [i - 1, i, i + 1].some((idx) => isLikelySpeedSpike(points, idx, thresholds))
      ? null
      : smoothedAccels[i];
    const speed1 = smooth?.speed_kmh ?? previousReliableSpeed;
    const rawAccel = dt <= 10 ? calculateAcceleration(previousReliableSpeed, speed2, dt) : null;
    const accel = smooth?.accel_ms2 ?? rawAccel;

    // ── Harsh Braking
    // Threshold: deceleration > 4.5 m/s² while above 20 km/h (to avoid parking noise)
    if (accel != null && accel < -thresholds.HARSH_BRAKE_MS2 && speed1 >= (thresholds.MIN_SPEED_HARSH_BRAKE_KMH ?? 25)) {
      pushEvent({
        type: EVENT_TYPES.HARSH_BRAKE,
        severity: Math.abs(accel) > 6 ? 'high' : Math.abs(accel) > 5 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        point_index: i,
        value: Math.abs(accel),
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Rapid Acceleration
    // Threshold: acceleration > 3.5 m/s² from speed > 5 km/h
    if (accel != null && accel > thresholds.RAPID_ACCEL_MS2 && speed1 >= (thresholds.MIN_SPEED_RAPID_ACCEL_KMH ?? DEFAULT_THRESHOLDS.MIN_SPEED_RAPID_ACCEL_KMH)) {
      pushEvent({
        type: EVENT_TYPES.RAPID_ACCELERATION,
        severity: accel > 5 ? 'high' : accel > 4 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        point_index: i,
        value: accel,
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Sharp Turn
    // Heading change > 45°/s while above 30 km/h. At lower speeds turns are normal.
    if (speed2 > 30 && dt <= 8 && currSegment.distanceM >= 10 && i > 1) {
      const prevPrev = points[i - 2];
      const prevSegment = calculateSegmentMetrics(prevPrev, prev, thresholds);
      if (prevSegment.dt > 0 && prevSegment.dt <= 8 && !prevSegment.isNoise && prevSegment.distanceM >= 10) {
        const h1 = calculateBearing(prevPrev.lat, prevPrev.lng, prev.lat, prev.lng);
        const h2 = calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
        const rawHeadingChange = headingDiff(h1, h2);
        const effectiveDt = Math.max(1.5, (prevSegment.dt + dt) / 2);
        const omegaRadPerSec = (rawHeadingChange * Math.PI / 180) / effectiveDt;
        const vMps = speed2 / 3.6;
        const lateralG = (vMps * omegaRadPerSec) / 9.81;
        const lowG = thresholds.SHARP_TURN_G_LOW ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW;
        const mediumG = thresholds.SHARP_TURN_G_MEDIUM ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM;
        const highG = thresholds.SHARP_TURN_G_HIGH ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH;

        if (rawHeadingChange >= 25 && lateralG >= lowG) {
          pushEvent({
            type: EVENT_TYPES.SHARP_TURN,
            severity: lateralG >= highG ? 'high' : lateralG >= mediumG ? 'medium' : 'low',
            lat: curr.lat,
            lng: curr.lng,
            timestamp: curr.timestamp,
            point_index: i,
            value: Math.round(lateralG * 100) / 100,
            speed_kmh: Math.round(speed2),
          });
        }
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
          point_index: i,
          value: round1(Math.abs(accel)),
          speed_kmh: Math.round(speed2),
        });
      }
    }

    const segmentZone = zoneForIndex(i);
    const contextualSpeedingThreshold = Math.min(
      configuredSpeedThreshold,
      segmentZone?.threshold_kmh ?? configuredSpeedThreshold
    );

    if (speed2 > contextualSpeedingThreshold) {
      if (!speedingStart) speedingStart = curr;
      speedingAccumSeconds += dt;
      speedingZone = segmentZone || speedingZone;
      if (speed2 > speedingPeakSpeed) {
        speedingPeakSpeed = speed2;
        speedingPeakPoint = curr;
        speedingZone = segmentZone || speedingZone;
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
      // FIX: Reset after an idle event window closes so a continuous stop emits only one IDLE event.
    }

    previousReliableSpeed = speed2;
  }

  flushSpeedingWindow();

  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(points, endTime, thresholds);
  if (terminalStoppedSeconds > 0) {
    const lastPoint = points[points.length - 1];
    if (!idleStart) idleStart = lastPoint.timestamp;
    idleAccum += terminalStoppedSeconds;
  }

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
    idleAccum = 0;
    // FIX: Clear the flushed trip-end idle window to prevent duplicate IDLE handling.
  }

  const alwaysOnEvents = [
    detectLaneChanges(points, thresholds),
    detectTailgateCycles(points, thresholds),
    detectErraticSpeedWindows(points),
  ];
  if (advancedSafetyEnabled) alwaysOnEvents.push(detectAggressiveOvertakes(points, thresholds));
  const phoneUse = advancedSafetyEnabled ? detectPhoneUseWindows(points, thresholds) : emptyPhoneUseResult();
  const combined = events.concat(...alwaysOnEvents, phoneUse.phone_use_events || []);
  return attachEventResult(combined, phoneUse);
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
    else if (startHour >= 22 || startHour < 2) timeScore = 3;
    // FIX: Raise the 10pm-2am fatigue bucket to the elevated late-night risk tier.
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
  if (!routePoints || routePoints.length === 0) return 0;

  let nightPoints = 0;
  let deepNightPoints = 0;
  for (const point of routePoints) {
    const hour = new Date(point.timestamp).getHours();
    if (isNightDrivingTime(point, thresholds)) nightPoints++;
    if (hour >= 2 && hour < 5) deepNightPoints++;
  }

  const n = routePoints.length;
  const normalNightPoints = nightPoints - deepNightPoints;
  // FIX: Deep-night points are a subset of night points, so separate them before weighting.
  return (normalNightPoints / n) * 8 + (deepNightPoints / n) * 12;
  // FIX: Give deep-night points an exclusive higher weight instead of double-counting them.
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
  const routePoints = (points || []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
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
      traffic_idle_seconds: 0,
      // FIX: Return explicit traffic idle even for short/empty trips so stats stay shape-compatible.
      sustained_idle_seconds: 0,
      // FIX: Return explicit sustained idle for eco scoring fallback compatibility.
      gap_seconds: 0,
      // FIX: Expose noise-filtered gap time without mixing it into moving or idle totals.
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
      speed_zones: [],
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
      drowsy_window_count: 0,
      drowsy_risk_score: 0,
      drowsy_risk_level: 'none',
      parking_approach_score: 100,
      parking_approach_grade: 'smooth',
      parking_stop_detected: false,
      parking_stop_duration_seconds: 0,
    };
  }

  let totalDistance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  let trafficIdleSeconds = 0;
  // FIX: Track short sub-5 km/h traffic stops separately from avoidable parked idle.
  let sustainedIdleSeconds = 0;
  // FIX: Track sustained sub-5 km/h idle for eco scoring instead of penalizing all idle.
  let gapSeconds = 0;
  // FIX: Track noise-filtered time excluded from moving and idle buckets.
  let idleRunStart = null;
  let idleRunDuration = 0;

  const flushIdleRun = () => {
    if (idleRunDuration <= 0) return;
    if (idleRunDuration >= 90) {
      sustainedIdleSeconds += idleRunDuration;
    } else {
      trafficIdleSeconds += idleRunDuration;
    }
    idleRunStart = null;
    idleRunDuration = 0;
  };
  // FIX: Classify each contiguous sub-5 km/h run once it ends or the trip ends.

  for (let i = 1; i < routePoints.length; i++) {
    const p = routePoints[i - 1];
    const c = routePoints[i];
    const rawDistance = haversineDistance(p.lat, p.lng, c.lat, c.lng);
    if (Number.isFinite(rawDistance)) totalDistance += rawDistance;

    const rawSpeed = Number(c.speed_kmh) || 0;
    if (rawSpeed > maxSpeed) maxSpeed = rawSpeed;

    const segment = calculateSegmentMetrics(p, c, thresholds);
    if (segment.dt <= 0 || segment.dt > 120) {
      flushIdleRun();
      continue;
    }
    if (segment.isNoise) {
      gapSeconds += segment.dt;
      // FIX: Count short noise-filtered gaps separately instead of losing them entirely.
      flushIdleRun();
      continue;
    }

    const currPointSpeed = reliablePointSpeed(routePoints, i, thresholds);
    const currRawSpeed = pointSpeedKmh(routePoints[i]);
    const spd = currPointSpeed ?? (currRawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh);
    if (spd >= thresholds.STATIONARY_SPEED_KMH) {
      movingSeconds += segment.dt;
      flushIdleRun();
    }

    if (spd < thresholds.IDLE_SPEED_KMH) {
      if (!idleRunStart) idleRunStart = p.timestamp;
      idleRunDuration += segment.dt;
    }
  }

  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(routePoints, endTime, thresholds);
  if (terminalStoppedSeconds > 0) {
    if (!idleRunStart) idleRunStart = routePoints[routePoints.length - 1].timestamp;
    idleRunDuration += terminalStoppedSeconds;
  }

  flushIdleRun();

  const idleTime = trafficIdleSeconds + sustainedIdleSeconds;
  // FIX: Keep legacy idle_time_seconds as the sum of traffic and sustained idle buckets.
  const effectiveMovingSeconds = movingSeconds;
  // FIX: gap_seconds is noise-filtered time excluded from moving and idle buckets; it is debug-only and does not affect scores.
  const nightDriving = routePoints.some(p => isNightDrivingTime(p, thresholds));
  const avgSpeed = durationSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, durationSeconds)
    : 0;
  const avgRunningSpeed = effectiveMovingSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, effectiveMovingSeconds)
    : 0;
  const roadStats = classifyRoadType(routePoints);
  const speedZones = inferSpeedZones(routePoints, thresholds);
  const intersectionStats = analyzeIntersectionBehavior(routePoints, thresholds);
  const fatigueProgression = durationSeconds > 1800
    ? analyzeFatigueProgression(routePoints, start.getTime(), end.getTime(), thresholds)
    : { fatigue_progression: 'unknown', segment_scores: [] };
  const hillStats = calculateHillDrivingScore(routePoints, thresholds);
  const drowsyStats = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED === false
    ? { drowsy_window_count: 0, drowsy_risk_score: 0, drowsy_risk_level: 'none' }
    : detectDrowsyDrivingSignature(routePoints, durationSeconds, thresholds);
  const parkingStats = analyzeParkingApproach(routePoints, thresholds, endTime);

  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    avg_running_speed_kmh: Math.round(avgRunningSpeed * 10) / 10,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: Math.round(idleTime),
    traffic_idle_seconds: Math.round(trafficIdleSeconds),
    // FIX: Return sub-90-second traffic idle separately for reporting/debugging.
    sustained_idle_seconds: Math.round(sustainedIdleSeconds),
    // FIX: Return 90-second-plus parked idle separately for eco scoring.
    gap_seconds: Math.round(gapSeconds),
    // FIX: Return short noise-filtered gap time without affecting moving speed or scores.
    duration_seconds: Math.round(durationSeconds),
    night_driving: nightDriving,
    fatigue_risk_score: calculateFatigueScore(durationSeconds, routePoints),
    ...roadStats,
    speed_zones: speedZones,
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
  durationSeconds = stats?.duration_seconds || 0,
  phoneUseOrOptions = {},
  maybeOptions = {}
) {
  const eventsList = Array.isArray(events) ? events : events?.events || [];
  const serializableEvents = eventsList.map((event) => ({ ...event }));
  const phoneUseFromEvents = events?.phoneUse || {};
  const options = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseOrOptions
    : maybeOptions;
  const phoneUse = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseFromEvents
    : { ...phoneUseFromEvents, ...(phoneUseOrOptions || {}) };
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
    [EVENT_TYPES.PHONE_USE]: 0,
  };
  let safetyPenalty = 0;
  let smoothnessPenalty = 0;
  let ecoPenalty = 0;
  let tailgatePenalty = 0;
  let distractionPenalty = 0;

  for (const evt of eventsList) {
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
  const phoneUseResult = {
    ...emptyPhoneUseResult(),
    ...(advancedSafetyEnabled ? phoneUse : {}),
  };
  const phoneProxy = {
    phone_proxy_count: phoneUseResult.phone_use_window_count || 0,
    phone_proxy_risk: phoneUseResult.phone_use_risk === 'none' ? 'none' : phoneUseResult.phone_use_risk === 'low' ? 'possible' : 'likely',
  };
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.low || 0) * 2;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.medium || 0) * 5;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.high || 0) * 10;
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
  const merge = detectHighwayMergeBehavior(routePoints, thresholds);
  const smoothBraking = calculateSmoothBrakingRatio(routePoints, thresholds);
  const engineStress = calculateEngineStressScore(eventsList, stats);
  const tireWear = calculateTireWearUnits(eventsList);
  const drowsy = advancedSafetyEnabled
    ? detectDrowsyDrivingSignature(routePoints, durationSeconds, thresholds)
    : { drowsy_window_count: 0, drowsy_risk_score: 0, drowsy_risk_level: 'none' };
  const hill = calculateHillDrivingScore(routePoints, thresholds);
  const parking = analyzeParkingApproach(routePoints, thresholds, options.endTime ?? null);
  const nearMissScore = counts[EVENT_TYPES.NEAR_MISS] === 0
    ? 100
    : Math.max(0, Math.round(100 * Math.pow(0.60, counts[EVENT_TYPES.NEAR_MISS])));
  const aggressive = calculateAggressiveDrivingScore(eventsList, { ...stats, ...jerk });
  const highwayKm = Math.max(1, calculateHighwayDistanceKm(routePoints));
  const followingDistanceScore = Math.max(0, 100 - Math.min(tailgatePenalty * (4 / highwayKm), 80));
  const distractionScore = Math.max(0, 100 - Math.min(distractionPenalty * (3 / distKm), 50));
  const reaction = calculateReactionTimeProxy(routePoints, eventsList, thresholds);
  const cornering = calculateCorneringConsistency(routePoints, thresholds);
  const brakingEfficiency = calculateBrakingEfficiency(routePoints, eventsList, thresholds);
  const compliance = calculateSpeedLimitCompliance(routePoints, stats, thresholds);
  const overtakeQuality = calculateOvertakeQualityScore(routePoints, eventsList, thresholds);
  const slippery = detectSlipperyConditionProxy(routePoints, eventsList, thresholds);

  const brakingScoreForSafety = brakingEfficiency.braking_efficiency_score ?? 100;
  const complianceScoreForSafety = compliance.overall_compliance_score ?? 100;
  const phoneUseScoreForSafety = thresholds.PHONE_USE_AFFECTS_SCORE === false ? 100 : (phoneUseResult.phone_use_score ?? 100);
  const safetyWithoutOvertake = Math.round(
    baseSafety * 0.60 +
    followingDistanceScore * 0.10 +
    brakingScoreForSafety * 0.15 +
    complianceScoreForSafety * 0.10 +
    phoneUseScoreForSafety * 0.05
  );
  let safety = overtakeQuality.overtake_count > 0
    ? Math.round(safetyWithoutOvertake * 0.95 + (overtakeQuality.overtake_quality_score ?? 100) * 0.05)
    : safetyWithoutOvertake;
  safety = Math.min(100, safety + (slippery.safety_condition_bonus || 0));
  const smoothness = Math.round(
    baseSmoothness * 0.45 +
    jerk.jerk_score * 0.25 +
    svi.svi_score * 0.10 +
    reaction.reaction_score * 0.10 +
    (cornering.cornering_consistency_score ?? 100) * 0.10
  );
  const eco = Math.round(baseEco * 0.40 + ecoDriving.eco_driving_score * 0.40 + fuelBand.fuel_band_score * 0.20);
  const intersectionScore = Number.isFinite(stats.intersection_score) ? stats.intersection_score : 100;

  // Overall = weighted combination
  const overall = Math.min(100, Math.round(
    safety * 0.35 + smoothness * 0.30 + eco * 0.20 + intersectionScore * 0.15
  ));

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
    phone_use_events: phoneUseResult.phone_use_events || [],
    phone_use_window_count: phoneUseResult.phone_use_window_count || 0,
    phone_use_total_seconds: phoneUseResult.phone_use_total_seconds || 0,
    phone_use_risk: phoneUseResult.phone_use_risk || 'none',
    phone_use_score: phoneUseResult.phone_use_score ?? 100,
    phone_use_pct_of_trip: phoneUseResult.phone_use_pct_of_trip || 0,
    phone_use_high_confidence_count: phoneUseResult.phone_use_high_confidence_count || 0,
    ...drowsy,
    ...hill,
    ...parking,
    ...reaction,
    ...cornering,
    ...brakingEfficiency,
    ...compliance,
    ...overtakeQuality,
    ...slippery,
    ...(options.includeRoadTypeSegments === false ? {} : calculateRoadTypeSegmentedScores(routePoints, eventsList, stats, thresholds)),
    ...aggressive,
    driving_events: serializableEvents,
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
    'Avg Speed (km/h)', 'Avg Moving Speed (km/h)', 'Max Speed (km/h)', 'Score', 'Safety', 'Smoothness',
    // FIX: Add exported moving-speed column immediately after the legacy overall average speed.
    'Eco', 'Jerk Score', 'Eco Driving Score', 'Following Score', 'Focus Score', 'Intersection Score',
    'Aggressive Score', 'Aggressive Grade', 'Defensive Score', 'Defensive Grade', 'SVI', 'Fuel Band',
    'Smooth Braking', 'Engine Stress', 'Tire Wear Units', 'Drowsy Risk', 'Phone Proxy', 'Parking Score',
    'Highway Score', 'Urban Score', 'Residential Score', 'Dominant Road Type',
    'Reaction Score', 'Avg Reaction Time (s)', 'Reaction Grade',
    'Phone Use Windows', 'Phone Use Total Seconds', 'Phone Use Risk', 'Phone Use Score', 'Phone Use Pct Trip',
    'Cornering Consistency Score', 'Mean Lateral G', 'Peak Lateral G',
    'Braking Efficiency Score', 'Braking Efficiency Grade', 'Braking Sequence Count',
    'Highway Compliance Score', 'Urban Compliance Score', 'Residential Compliance Score', 'Overall Compliance Score',
    'Overtake Quality Score', 'Overtake Count', 'Unsafe Re-entry Count',
    'Road Condition Proxy', 'Safety Condition Bonus',
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
    t.avg_running_speed_kmh ?? '',
    // FIX: Export avg_running_speed_kmh so CSV consumers can use driving speed excluding stops.
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
    t.highway_score?.overall ?? '',
    t.urban_score?.overall ?? '',
    t.residential_score?.overall ?? '',
    t.dominant_road_type ?? '',
    t.reaction_score ?? '',
    t.avg_reaction_seconds ?? '',
    t.reaction_grade ?? '',
    t.phone_use_window_count ?? 0,
    t.phone_use_total_seconds ?? 0,
    t.phone_use_risk ?? 'none',
    t.phone_use_score ?? 100,
    t.phone_use_pct_of_trip ?? 0,
    t.cornering_consistency_score ?? '',
    t.mean_lateral_g ?? '',
    t.peak_lateral_g ?? '',
    t.braking_efficiency_score ?? '',
    t.braking_efficiency_grade ?? '',
    t.braking_sequence_count ?? '',
    t.highway_compliance?.score ?? '',
    t.urban_compliance?.score ?? '',
    t.residential_compliance?.score ?? '',
    t.overall_compliance_score ?? '',
    t.overtake_quality_score ?? '',
    t.overtake_count ?? '',
    t.unsafe_reentry_count ?? '',
    t.slippery_proxy ?? '',
    t.safety_condition_bonus ?? '',
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
      const result = await saveExportToDownloads({
        filename: safeFilename,
        data: content,
        mimeType: 'text/csv',
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
