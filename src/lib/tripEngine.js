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
  SHARP_TURN_DEG_PER_S: 45,
  // Speeding fallback: above 130 km/h (when no speed limit data)
  SPEEDING_FALLBACK_KMH: 130,
  // Idle threshold: speed < 5 km/h
  IDLE_SPEED_KMH: 5,
  // Idle event: idling for > 60 consecutive seconds
  IDLE_EVENT_SECONDS: 60,
  // Long drive: > 120 continuous minutes
  LONG_DRIVE_MINUTES: 120,
  // Night driving: 22:00 - 06:00
  NIGHT_START_HOUR: 22,
  NIGHT_END_HOUR: 6,
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
};

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

  const dt = (new Date(point.timestamp) - new Date(previousPoint.timestamp)) / 1000;
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

export function calculateRouteSummary(points, startTime, endTime) {
  const cleaned = cleanRoutePoints(points);
  const stats = calculateTripStats(cleaned, startTime, endTime);
  const events = detectDrivingEvents(cleaned);
  const scores = calculateTripScores(events, stats);
  return { points: cleaned, stats, events, scores };
}

// ─── Event Detection ───────────────────────────────────────────────────────────
/**
 * Analyze route points to detect driving behavior events.
 * Returns an array of DrivingEvent objects.
 *
 * @param {Array} points - Array of { lat, lng, speed_kmh, timestamp, heading }
 * @param {Object} thresholds - Configurable thresholds
 * @returns {Array} Detected events
 */
export function detectDrivingEvents(points, thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!points || points.length < 3) return events;

  let idleStart = null;
  let idleAccum = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    const dt = (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000; // seconds
    if (dt <= 0 || dt > 120) continue; // skip gaps > 2 minutes (possible pause)

    const prevSegment = i > 1 ? calculateSegmentMetrics(points[i - 2], prev, thresholds) : null;
    const currSegment = calculateSegmentMetrics(prev, curr, thresholds);
    if (currSegment.isNoise) continue;

    const speed1 = prevSegment && !prevSegment.isNoise ? prevSegment.reliableSpeedKmh : (prev.speed_kmh || 0);
    const speed2 = currSegment.reliableSpeedKmh;
    const accel = calculateAcceleration(speed1, speed2, dt);

    // ── Harsh Braking
    // Threshold: deceleration > 4.5 m/s² while above 20 km/h (to avoid parking noise)
    if (accel < -thresholds.HARSH_BRAKE_MS2 && speed1 > 20) {
      events.push({
        type: 'harsh_brake',
        severity: Math.abs(accel) > 6 ? 'high' : Math.abs(accel) > 5 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        value: Math.abs(accel),
      });
    }

    // ── Rapid Acceleration
    // Threshold: acceleration > 3.5 m/s² from speed > 5 km/h
    if (accel > thresholds.RAPID_ACCEL_MS2 && speed1 > 5) {
      events.push({
        type: 'rapid_acceleration',
        severity: accel > 5 ? 'high' : accel > 4 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        value: accel,
      });
    }

    // ── Sharp Turn
    // Heading change > 45°/s while above 30 km/h. At lower speeds turns are normal.
    if (speed2 > 30) {
      const h1 = prev.heading ?? calculateBearing(
        i > 1 ? points[i - 2].lat : prev.lat,
        i > 1 ? points[i - 2].lng : prev.lng,
        prev.lat, prev.lng
      );
      const h2 = curr.heading ?? calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
      const hdiff = headingDiff(h1, h2);
      const turnRate = dt > 0 ? hdiff / dt : 0; // degrees per second

      if (turnRate > thresholds.SHARP_TURN_DEG_PER_S) {
        events.push({
          type: 'sharp_turn',
          severity: turnRate > 90 ? 'high' : turnRate > 60 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: turnRate,
        });
      }
    }

    // ── Speeding (fallback – no speed limit data)
    // Flag when speed exceeds the fallback threshold (default 130 km/h)
    if (speed2 > thresholds.SPEEDING_FALLBACK_KMH) {
      events.push({
        type: 'speeding',
        severity: speed2 > 160 ? 'high' : speed2 > 140 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        value: speed2,
      });
    }

    // ── Idle accumulation
    if (speed2 < thresholds.IDLE_SPEED_KMH) {
      if (!idleStart) idleStart = curr.timestamp;
      idleAccum += dt;
    } else {
      if (idleAccum >= thresholds.IDLE_EVENT_SECONDS) {
        events.push({
          type: 'idle',
          severity: idleAccum > 300 ? 'high' : idleAccum > 120 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: idleStart,
          value: idleAccum,
        });
      }
      idleStart = null;
      idleAccum = 0;
    }
  }

  // Final idle check
  if (idleAccum >= thresholds.IDLE_EVENT_SECONDS) {
    const last = points[points.length - 1];
    events.push({
      type: 'idle',
      severity: idleAccum > 300 ? 'high' : idleAccum > 120 ? 'medium' : 'low',
      lat: last.lat,
      lng: last.lng,
      timestamp: idleStart,
      value: idleAccum,
    });
  }

  return events;
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
export function calculateTripStats(points, startTime, endTime) {
  const routePoints = cleanRoutePoints(points);
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const durationSeconds = Math.max(0, (end - start) / 1000);

  if (!routePoints || routePoints.length < 2) {
    return {
      distance_km: 0,
      avg_speed_kmh: 0,
      max_speed_kmh: 0,
      idle_time_seconds: 0,
      duration_seconds: Math.round(durationSeconds),
      night_driving: false,
    };
  }

  let totalDistance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  let idleTime = 0;

  for (let i = 1; i < routePoints.length; i++) {
    const p = routePoints[i - 1];
    const c = routePoints[i];
    const segment = calculateSegmentMetrics(p, c);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

    totalDistance += segment.distanceKm;

    const spd = segment.reliableSpeedKmh;
    if (spd > maxSpeed) maxSpeed = spd;
    if (spd >= DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH) movingSeconds += segment.dt;

    if (spd < DEFAULT_THRESHOLDS.IDLE_SPEED_KMH) {
      idleTime += segment.dt;
    }
  }

  if (totalDistance * 1000 < DEFAULT_THRESHOLDS.MIN_POINT_DISTANCE_M) {
    totalDistance = 0;
    maxSpeed = 0;
  }

  // Night driving: any point between 22:00 and 06:00 local time
  const nightDriving = routePoints.some(p => {
    const h = new Date(p.timestamp).getHours();
    return h >= DEFAULT_THRESHOLDS.NIGHT_START_HOUR || h < DEFAULT_THRESHOLDS.NIGHT_END_HOUR;
  });
  const avgSpeed = durationSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, durationSeconds)
    : 0;

  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    avg_speed_kmh: movingSeconds > 0 ? Math.round(avgSpeed * 10) / 10 : 0,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: Math.round(idleTime),
    duration_seconds: Math.round(durationSeconds),
    night_driving: nightDriving,
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
export function calculateTripScores(events, stats) {
  const penalties = {
    harsh_brake: { low: 3, medium: 6, high: 12 },
    rapid_acceleration: { low: 2, medium: 5, high: 10 },
    sharp_turn: { low: 2, medium: 5, high: 10 },
    speeding: { low: 5, medium: 10, high: 20 },
    idle: { low: 1, medium: 3, high: 5 },
  };

  // Count events
  const counts = {
    harsh_brake: 0,
    rapid_acceleration: 0,
    sharp_turn: 0,
    speeding: 0,
    idle: 0,
  };
  let safetyPenalty = 0;
  let smoothnessPenalty = 0;
  let ecoPenalty = 0;

  for (const evt of events) {
    const p = penalties[evt.type]?.[evt.severity] ?? 0;
    if (counts[evt.type] !== undefined) counts[evt.type]++;

    // Safety: deducts from harsh_brake, speeding, sharp_turn
    if (['harsh_brake', 'speeding', 'sharp_turn'].includes(evt.type)) safetyPenalty += p;
    // Smoothness: deducts from harsh_brake, rapid_acceleration, sharp_turn
    if (['harsh_brake', 'rapid_acceleration', 'sharp_turn'].includes(evt.type)) smoothnessPenalty += p;
    // Eco: deducts from speeding, rapid_acceleration, idle
    if (['speeding', 'rapid_acceleration', 'idle'].includes(evt.type)) ecoPenalty += p;
  }

  // Night driving penalty (minor)
  if (stats.night_driving) safetyPenalty += 5;

  // Long drive penalty (fatigue risk)
  const driveMins = (stats.duration_seconds || 0) / 60;
  if (driveMins > DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES) {
    safetyPenalty += Math.floor((driveMins - DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES) / 30) * 3;
  }

  // Normalize per km (avoid penalizing long trips too harshly)
  const distFactor = Math.max(1, (stats.distance_km || 1));
  const normalize = (p) => Math.max(0, 100 - Math.min(p * (5 / distFactor), 80));

  const safety = Math.round(normalize(safetyPenalty));
  const smoothness = Math.round(normalize(smoothnessPenalty));
  const eco = Math.round(normalize(ecoPenalty));

  // Overall = weighted combination
  const overall = Math.round(safety * 0.4 + smoothness * 0.35 + eco * 0.25);

  return {
    score_overall: overall,
    score_safety: safety,
    score_smoothness: smoothness,
    score_eco: eco,
    harsh_brakes_count: counts.harsh_brake,
    rapid_accel_count: counts.rapid_acceleration,
    sharp_turns_count: counts.sharp_turn,
    speeding_events_count: counts.speeding,
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

  const riskMap = { harsh_brake: hb, rapid_acceleration: ra, sharp_turn: st, speeding: sp };
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
    'Eco', 'Harsh Brakes', 'Rapid Accels', 'Sharp Turns', 'Speeding Events', 'Night Driving',
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
    t.harsh_brakes_count ?? '',
    t.rapid_accel_count ?? '',
    t.sharp_turns_count ?? '',
    t.speeding_events_count ?? '',
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
