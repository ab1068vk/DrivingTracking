import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';

const EARTH_RADIUS_M = 6371000;
const MAX_SECTION_POINTS = 24;
const MAX_SEGMENT_LENGTH_M = 3000;
const MIN_SEGMENT_LENGTH_M = 90;
const WINDOW_TARGET_LENGTH_M = 220;
const MAX_POINT_GAP_M = 250;
const MAX_GPS_ACCURACY_M = 50;
const MIN_MOVING_SPEED_KMH = 5;
const MAX_REASONABLE_SPEED_KMH = 180;
const MAX_LOW_SPEED_RATIO = 0.32;
const MAX_STOP_RATIO = 0.20;
const MAX_TIMESTAMP_GAP_MS = 15_000;
const MAX_HEADING_CHANGE_DEG = 105;
const MIN_OPERATIONAL_TRIPS = 3;
const MIN_OPERATIONAL_AGREEMENT = 0.67;
const MIN_OPERATIONAL_CONFIDENCE = 0.62;
const MIN_TIME_PROFILE_TRIPS = 3;
const MIN_TIME_PROFILE_TOTAL_TRIPS = 6;
const ROAD_MEMORY_FRESH_DAYS = 45;
const ROAD_MEMORY_STALE_DAYS = 120;
const MATCH_RADIUS_M = 60;
const ADJACENT_ENDPOINT_RADIUS_M = 180;
const DIRECTION_TOLERANCE_DEG = 65;
const COMMON_LIMITS_KMH = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const DAY_MS = 86400000;

const plausibleSavedSpeedLimit = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= MAX_SAVED_SPEED_LIMIT_KMH;
};

const radians = (value) => Number(value) * Math.PI / 180;

export const roadMemoryDistanceMeters = (a = {}, b = {}) => {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLat = lat2 - lat1;
  const dLng = radians(Number(b.lng) - Number(a.lng));
  if (![lat1, lat2, dLat, dLng].every(Number.isFinite)) return Infinity;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const usablePoint = (point = {}) => {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  const accuracy = Number(point.accuracy);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) &&
    (!Number.isFinite(accuracy) || accuracy <= MAX_GPS_ACCURACY_M) &&
    point.privacy_export_placeholder !== true &&
    point.masked_for_privacy !== true &&
    point.privacy_gap !== true &&
    point.privacy_live_redacted !== true;
};

const pointSpeed = (point = {}) => {
  const speed = Number(point.speed_kmh ?? point.speedKmh);
  return Number.isFinite(speed) &&
    speed >= MIN_MOVING_SPEED_KMH &&
    speed <= MAX_REASONABLE_SPEED_KMH
    ? speed
    : null;
};

const pointTimestamp = (point = {}) => (
  point.timestamp ?? point.recorded_at ?? point.timestamp_ms ?? point.timestampMs ?? null
);

const observationTimestampMs = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const observationBounds = (...values) => {
  const timestamps = values
    .flat()
    .map(observationTimestampMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!timestamps.length) return { firstObservedAt: null, lastObservedAt: null };
  return {
    firstObservedAt: new Date(timestamps[0]).toISOString(),
    lastObservedAt: new Date(timestamps.at(-1)).toISOString(),
  };
};

const bearingDegrees = (a = {}, b = {}) => {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const deltaLng = radians(Number(b.lng) - Number(a.lng));
  if (![lat1, lat2, deltaLng].every(Number.isFinite)) return null;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const angleDifference = (a, b) => {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return Infinity;
  return Math.abs((((Number(a) - Number(b)) + 540) % 360) - 180);
};

const percentile = (values = [], ratio = 0.85) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * ratio));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

const median = (values = []) => percentile(values, 0.5);

const standardDeviation = (values = []) => {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return 0;
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  return Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length);
};

const nearestCommonLimit = (speedKmh) => {
  if (!Number.isFinite(Number(speedKmh))) return null;
  return COMMON_LIMITS_KMH.reduce((best, limit) => (
    Math.abs(limit - Number(speedKmh)) < Math.abs(best - Number(speedKmh)) ? limit : best
  ), COMMON_LIMITS_KMH[0]);
};

const explicitEstimatedLimit = (points = []) => {
  const allowedSources = new Set([
    'inferred',
    'region_default_estimate',
  ]);
  const values = points
    .filter((point) => allowedSources.has(point.speed_limit_source ?? point.limitSource))
    .map((point) => Number(point.speed_limit_kmh ?? point.limitKmh))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  const counts = new Map();
  values.forEach((value) => {
    const rounded = Math.round(value / 10) * 10;
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
};

const sampleGeometry = (points = [], maxPoints = MAX_SECTION_POINTS) => {
  if (points.length <= maxPoints) return points.map(({ lat, lng }) => ({ lat, lng }));
  const lastIndex = points.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => {
    const point = points[Math.round(index * lastIndex / (maxPoints - 1))];
    return { lat: point.lat, lng: point.lng };
  });
};

const sectionLengthMeters = (points = []) => points.reduce((sum, point, index) => (
  index === 0 ? 0 : sum + roadMemoryDistanceMeters(points[index - 1], point)
), 0);

const pointToSegmentDistanceMeters = (point, start, end) => {
  const latitude = Number(point?.lat);
  const longitude = Number(point?.lng);
  const startLat = Number(start?.lat);
  const startLng = Number(start?.lng);
  const endLat = Number(end?.lat);
  const endLng = Number(end?.lng);
  if (![latitude, longitude, startLat, startLng, endLat, endLng].every(Number.isFinite)) return Infinity;
  const meanLat = radians((latitude + startLat + endLat) / 3);
  const metersPerLatDegree = 111320;
  const metersPerLngDegree = Math.max(1, metersPerLatDegree * Math.cos(meanLat));
  const px = (longitude - startLng) * metersPerLngDegree;
  const py = (latitude - startLat) * metersPerLatDegree;
  const vx = (endLng - startLng) * metersPerLngDegree;
  const vy = (endLat - startLat) * metersPerLatDegree;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared <= 0) return Math.hypot(px, py);
  const projection = Math.max(0, Math.min(1, (px * vx + py * vy) / lengthSquared));
  return Math.hypot(px - projection * vx, py - projection * vy);
};

const pointToPolylineDistanceMeters = (point, points = []) => {
  if (!points.length) return Infinity;
  if (points.length === 1) return roadMemoryDistanceMeters(point, points[0]);
  let best = Infinity;
  for (let index = 1; index < points.length; index++) {
    best = Math.min(best, pointToSegmentDistanceMeters(point, points[index - 1], points[index]));
  }
  return best;
};

const headingForPoints = (points = []) => (
  points.length >= 2 ? bearingDegrees(points[0], points.at(-1)) : null
);

export function roadMemoryTimeBucket(timestamp, utcOffsetMinutes = null) {
  const date = timestamp == null ? null : new Date(timestamp);
  if (!date || !Number.isFinite(date.getTime())) return 'all_times';
  const offset = Number(utcOffsetMinutes);
  const hasOffset = utcOffsetMinutes != null && utcOffsetMinutes !== '' && Number.isFinite(offset);
  const localDate = hasOffset
    ? new Date(date.getTime() + offset * 60000)
    : date;
  const hour = hasOffset ? localDate.getUTCHours() : localDate.getHours();
  const day = hasOffset ? localDate.getUTCDay() : localDate.getDay();
  const weekday = day >= 1 && day <= 5;
  if (hour < 5) return 'overnight';
  if (weekday && hour >= 6 && hour < 10) return 'weekday_morning';
  if (weekday && hour >= 15 && hour < 19) return 'weekday_evening';
  return 'other_times';
}

const timestampMilliseconds = (point = {}) => {
  const raw = pointTimestamp(point);
  if (raw == null || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const totalHeadingChangeDegrees = (points = []) => {
  const bearings = [];
  for (let index = 1; index < points.length; index++) {
    const bearing = bearingDegrees(points[index - 1], points[index]);
    if (Number.isFinite(bearing)) bearings.push(bearing);
  }
  return bearings.reduce((sum, bearing, index) => (
    index === 0 ? 0 : sum + angleDifference(bearings[index - 1], bearing)
  ), 0);
};

const trafficQualityForPoints = (points = [], speeds = []) => {
  const accuracyValues = points
    .map((point) => Number(point.accuracy))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const rawSpeeds = points
    .map((point) => Number(point.speed_kmh ?? point.speedKmh))
    .filter(Number.isFinite);
  const stopRatio = rawSpeeds.filter((speed) => speed < MIN_MOVING_SPEED_KMH).length /
    Math.max(1, rawSpeeds.length);
  const lowSpeedRatio = rawSpeeds.filter((speed) => speed < 12).length /
    Math.max(1, rawSpeeds.length);
  const p85Kmh = percentile(speeds, 0.85);
  const medianKmh = median(speeds);
  const congestionSpreadKmh = Number.isFinite(p85Kmh) && Number.isFinite(medianKmh)
    ? p85Kmh - medianKmh
    : Infinity;
  let largestTimestampGapMs = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = timestampMilliseconds(points[index - 1]);
    const current = timestampMilliseconds(points[index]);
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      largestTimestampGapMs = Math.max(largestTimestampGapMs, Math.max(0, current - previous));
    }
  }
  const headingChangeDeg = totalHeadingChangeDegrees(points);
  const rejectedReasons = [];
  if (stopRatio > MAX_STOP_RATIO) rejectedReasons.push('stop_heavy');
  if (lowSpeedRatio > MAX_LOW_SPEED_RATIO) rejectedReasons.push('queue_or_parking_speed');
  if (congestionSpreadKmh > 22) rejectedReasons.push('unstable_traffic_speed');
  if (largestTimestampGapMs > MAX_TIMESTAMP_GAP_MS) rejectedReasons.push('traffic_dwell');
  if (headingChangeDeg > MAX_HEADING_CHANGE_DEG) rejectedReasons.push('turning_or_parking_manoeuvre');
  return {
    accepted: rejectedReasons.length === 0,
    rejectedReasons,
    stopRatio,
    lowSpeedRatio,
    congestionSpreadKmh,
    largestTimestampGapMs,
    headingChangeDeg,
    medianAccuracyM: median(accuracyValues),
  };
};

const makeObservation = (points = [], trip = {}) => {
  const speeds = points.map(pointSpeed).filter(Number.isFinite);
  const distanceM = sectionLengthMeters(points);
  if (distanceM < MIN_SEGMENT_LENGTH_M || speeds.length < 4) return null;
  const trafficQuality = trafficQualityForPoints(points, speeds);
  const p85Kmh = percentile(speeds, 0.85);
  const speedDeviationKmh = standardDeviation(speeds);
  if (
    !trafficQuality.accepted ||
    !Number.isFinite(p85Kmh) ||
    speedDeviationKmh > 24
  ) return null;

  const limitKmh = explicitEstimatedLimit(points) ?? nearestCommonLimit(p85Kmh);
  if (!Number.isFinite(limitKmh) || limitKmh <= 0) return null;
  const sectionPoints = sampleGeometry(points);
  const center = sectionPoints[Math.floor(sectionPoints.length / 2)];
  const directionBearing = headingForPoints(sectionPoints);
  const recordedAt = pointTimestamp(points.at(-1)) || trip.end_time || trip.start_time || new Date().toISOString();
  return {
    tripId: String(trip.id || trip.trip_id || trip.start_time || ''),
    lat: center.lat,
    lng: center.lng,
    sectionPoints,
    distanceM: Math.round(distanceM),
    directionMode: Number.isFinite(directionBearing) ? 'forward' : 'both',
    directionBearing,
    limitKmh: Math.round(limitKmh),
    inferenceBasis: explicitEstimatedLimit(points) != null
      ? 'trip_estimate_consensus'
      : 'driving_behavior_p85',
    legalAuthority: false,
    p85Kmh: Math.round(p85Kmh),
    speedDeviationKmh: Math.round(speedDeviationKmh * 10) / 10,
    sampleCount: speeds.length,
    observedAt: recordedAt,
    timeBucket: roadMemoryTimeBucket(
      recordedAt,
      points.at(-1)?.utc_offset_minutes ?? trip.utc_offset_minutes
    ),
    timezoneId: String(points.at(-1)?.timezone_id || trip.timezone_id || ''),
    utcOffsetMinutes: Number.isFinite(Number(points.at(-1)?.utc_offset_minutes ?? trip.utc_offset_minutes))
      ? Number(points.at(-1)?.utc_offset_minutes ?? trip.utc_offset_minutes)
      : null,
    quality: {
      stopRatio: Math.round(trafficQuality.stopRatio * 100) / 100,
      lowSpeedRatio: Math.round(trafficQuality.lowSpeedRatio * 100) / 100,
      headingChangeDeg: Math.round(trafficQuality.headingChangeDeg),
      congestionSpreadKmh: Math.round(trafficQuality.congestionSpreadKmh),
      medianAccuracyM: Number.isFinite(trafficQuality.medianAccuracyM)
        ? Math.round(trafficQuality.medianAccuracyM)
        : null,
    },
  };
};

const windowRoutePoints = (points = []) => {
  const windows = [];
  let current = [];
  let currentDistanceM = 0;
  const flush = () => {
    if (current.length) windows.push(current);
    current = [];
    currentDistanceM = 0;
  };
  for (const point of points) {
    const previous = current.at(-1);
    const gapM = previous ? roadMemoryDistanceMeters(previous, point) : 0;
    if (previous && gapM > MAX_POINT_GAP_M) flush();
    if (current.length) currentDistanceM += gapM;
    current.push(point);
    if (currentDistanceM >= WINDOW_TARGET_LENGTH_M) flush();
  }
  flush();
  return windows;
};

const compatibleObservation = (first = {}, second = {}) => (
  first.limitKmh === second.limitKmh &&
  Number(first.distanceM) + Number(second.distanceM) <= MAX_SEGMENT_LENGTH_M &&
  roadMemoryDistanceMeters(first.sectionPoints.at(-1), second.sectionPoints[0]) <= MAX_POINT_GAP_M &&
  (
    !Number.isFinite(first.directionBearing) ||
    !Number.isFinite(second.directionBearing) ||
    angleDifference(first.directionBearing, second.directionBearing) <= DIRECTION_TOLERANCE_DEG
  )
);

const mergeObservations = (first, second) => {
  const sectionPoints = sampleGeometry([
    ...first.sectionPoints,
    ...second.sectionPoints,
  ]);
  const center = sectionPoints[Math.floor(sectionPoints.length / 2)];
  return {
    ...first,
    lat: center.lat,
    lng: center.lng,
    sectionPoints,
    distanceM: Number(first.distanceM) + Number(second.distanceM),
    directionBearing: headingForPoints(sectionPoints),
    p85Kmh: Math.round((first.p85Kmh * first.sampleCount + second.p85Kmh * second.sampleCount) /
      Math.max(1, first.sampleCount + second.sampleCount)),
    speedDeviationKmh: Math.max(first.speedDeviationKmh, second.speedDeviationKmh),
    sampleCount: first.sampleCount + second.sampleCount,
    observedAt: second.observedAt || first.observedAt,
  };
};

export function buildRoadMemoryObservations(trip = {}) {
  if (trip?.status && trip.status !== 'completed') return [];
  if (trip?.private_trip === true || trip?.privacy_trend_excluded === true) return [];
  const points = (Array.isArray(trip.route_points) ? trip.route_points : [])
    .filter(usablePoint)
    .map((point) => ({
      ...point,
      lat: Number(point.lat),
      lng: Number(point.lng),
    }));
  const observations = windowRoutePoints(points)
    .map((window) => makeObservation(window, trip))
    .filter(Boolean);
  const merged = [];
  for (const observation of observations) {
    const previous = merged.at(-1);
    if (previous && compatibleObservation(previous, observation)) {
      merged[merged.length - 1] = mergeObservations(previous, observation);
    } else {
      merged.push(observation);
    }
  }
  return merged;
}

export function roadMemoryObservationMatchScore(observation = {}, candidate = {}) {
  const observationPoints = observation.sectionPoints || [];
  const candidatePoints = candidate.sectionPoints || [];
  if (observationPoints.length < 2 || candidatePoints.length < 2) return null;
  if (
    Number.isFinite(observation.directionBearing) &&
    Number.isFinite(candidate.directionBearing) &&
    angleDifference(observation.directionBearing, candidate.directionBearing) > DIRECTION_TOLERANCE_DEG
  ) return null;
  const matched = observationPoints.filter((point) => (
    pointToPolylineDistanceMeters(point, candidatePoints) <= MATCH_RADIUS_M
  )).length;
  const overlap = matched / observationPoints.length;
  const candidateMatched = candidatePoints.filter((point) => (
    pointToPolylineDistanceMeters(point, observationPoints) <= MATCH_RADIUS_M
  )).length;
  const candidateCoverage = candidateMatched / candidatePoints.length;
  const endpointDistance = Math.min(
    roadMemoryDistanceMeters(observationPoints[0], candidatePoints.at(-1)),
    roadMemoryDistanceMeters(observationPoints.at(-1), candidatePoints[0]),
    roadMemoryDistanceMeters(observationPoints[0], candidatePoints[0]),
    roadMemoryDistanceMeters(observationPoints.at(-1), candidatePoints.at(-1))
  );
  if (Number(observation.limitKmh) !== Number(candidate.limitKmh)) {
    if (overlap < 0.45 || candidateCoverage < 0.6) return null;
  }
  // A nearby endpoint alone is not road identity: side streets, ramps, and
  // divided-road connectors routinely begin within this radius. Require real
  // bidirectional corridor overlap and let the later consolidation pass handle
  // repeated adjacent fragments with independent continuity evidence.
  if (overlap < 0.2 && candidateCoverage < 0.2) return null;
  return overlap * 700 + candidateCoverage * 300 - Math.min(endpointDistance, 500);
}

export function findRoadMemoryCandidateMatch(observation, candidates = []) {
  return candidates
    .map((candidate) => ({
      candidate,
      score: roadMemoryObservationMatchScore(observation, candidate),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

export const roadMemoryEvidenceConfidence = (tripCount, agreement) => {
  if (tripCount < 2 || agreement < 0.6) return Math.min(0.54, 0.40 + tripCount * 0.05);
  return Math.min(0.72, 0.46 + Math.min(4, tripCount - 1) * 0.06 + agreement * 0.12);
};

const candidateLimitFromVotes = (votes = {}) => (
  Object.entries(votes)
    .map(([limit, count]) => [Number(limit), Number(count)])
    .filter(([limit, count]) => plausibleSavedSpeedLimit(limit) && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null
);

const votesFromTripVotes = (tripVotes = {}) => {
  const votes = {};
  Object.values(tripVotes || {}).forEach((limit) => {
    const numeric = Math.round(Number(limit));
    if (plausibleSavedSpeedLimit(numeric)) {
      votes[numeric] = (Number(votes[numeric]) || 0) + 1;
    }
  });
  return votes;
};

const profileFromBucket = (bucket, value = {}, baseLimitKmh, totalTripCount) => {
  const tripVotes = value.tripVotes && typeof value.tripVotes === 'object'
    ? value.tripVotes
    : {};
  const votes = Object.keys(tripVotes).length
    ? votesFromTripVotes(tripVotes)
    : { ...(value.limitVotes || {}) };
  const limitKmh = candidateLimitFromVotes(votes);
  const tripCount = Math.max(Object.keys(tripVotes).length, Number(value.tripCount) || 0);
  const totalVotes = Object.values(votes).reduce((sum, count) => sum + (Number(count) || 0), 0);
  const winningVotes = Number(votes[limitKmh]) || 0;
  const agreement = totalVotes ? winningVotes / totalVotes : 0;
  const eligible = bucket !== 'all_times' &&
    totalTripCount >= MIN_TIME_PROFILE_TOTAL_TRIPS &&
    tripCount >= MIN_TIME_PROFILE_TRIPS &&
    agreement >= MIN_OPERATIONAL_AGREEMENT &&
    Number.isFinite(limitKmh) &&
    Math.abs(limitKmh - baseLimitKmh) >= 10;
  return {
    bucket,
    limitKmh,
    tripCount,
    agreement: Math.round(agreement * 100) / 100,
    eligible,
    tripVotes,
    limitVotes: votes,
  };
};

const buildTimeProfiles = (timeBuckets = {}, baseLimitKmh, totalTripCount) => (
  Object.entries(timeBuckets || {})
    .map(([bucket, value]) => profileFromBucket(bucket, value, baseLimitKmh, totalTripCount))
    .filter((profile) => Number.isFinite(profile.limitKmh) && profile.tripCount > 0)
    .sort((a, b) => b.tripCount - a.tripCount || a.bucket.localeCompare(b.bucket))
);

export function roadMemoryEffectiveLimit(candidate = {}, timestamp = null, utcOffsetMinutes = null) {
  const bucket = roadMemoryTimeBucket(timestamp, utcOffsetMinutes);
  // Driving behaviour can reveal a repeatable time pattern, but it cannot by
  // itself establish a time-dependent legal limit. Keep eligible profiles in
  // review/shadow mode until the driver explicitly accepts the parked review.
  const timeProfilesAccepted = candidate.timeProfilesAcceptedAt != null ||
    candidate.reviewState === 'time_profiles_accepted';
  const pendingProfile = (candidate.timeProfiles || []).find((item) => (
    item?.eligible === true &&
    item.bucket === bucket &&
    plausibleSavedSpeedLimit(item.limitKmh)
  ));
  const profile = timeProfilesAccepted ? pendingProfile : null;
  const baseLimitKmh = plausibleSavedSpeedLimit(candidate.limitKmh)
    ? Number(candidate.limitKmh)
    : null;
  return {
    limitKmh: profile ? Number(profile.limitKmh) : baseLimitKmh,
    timeBucket: bucket,
    timeProfile: profile || null,
    pendingTimeProfile: !timeProfilesAccepted ? pendingProfile || null : null,
    timeProfilesAccepted,
  };
}

export function roadMemoryCandidateOperationalState(candidate = {}, nowMs = Date.now()) {
  // Older backfills were loaded newest-first while the learner assumed
  // chronological input. Use every retained boundary here so a legacy
  // inverted first/last pair cannot make a recently driven road look stale.
  const observedAt = Math.max(
    0,
    ...[
      candidate.firstObservedAt,
      candidate.lastObservedAt,
      ...(candidate.recentObservations || []).map((item) => item?.observedAt),
    ].map(observationTimestampMs).filter(Number.isFinite)
  );
  const ageDays = Number.isFinite(observedAt)
    ? Math.max(0, (nowMs - observedAt) / DAY_MS)
    : Infinity;
  const reconstructedConfidence = roadMemoryEvidenceConfidence(
    Number(candidate.tripCount) || 0,
    Number(candidate.agreement) || 0
  );
  const storedConfidence = Math.max(0, Math.min(0.72, Number(
    candidate.evidenceConfidence ?? candidate.rawConfidence ?? reconstructedConfidence
  ) || 0));
  const decay = ageDays <= ROAD_MEMORY_FRESH_DAYS
    ? 0
    : Math.min(0.24, (ageDays - ROAD_MEMORY_FRESH_DAYS) * 0.0025);
  const effectiveConfidence = Math.max(0, Math.round((storedConfidence - decay) * 100) / 100);
  const stale = ageDays > ROAD_MEMORY_STALE_DAYS;
  const possibleChange = candidate.changeDetection?.status === 'possible_change';
  const userResolved = ['confirmed', 'adjusted', 'rejected'].includes(candidate.reviewState);
  const strongTimeProfiles = (candidate.timeProfiles || []).filter((profile) => (
    Number(profile?.tripCount) >= MIN_TIME_PROFILE_TRIPS &&
    Number(profile?.agreement) >= MIN_OPERATIONAL_AGREEMENT
  ));
  const strongTimePattern = new Set(strongTimeProfiles.map((profile) => Number(profile.limitKmh))).size >= 2 &&
    Number(candidate.tripCount) >= MIN_TIME_PROFILE_TOTAL_TRIPS;
  let stage = 'learning';
  if (userResolved) stage = 'resolved';
  else if (candidate.chronologyRepairPending === true) stage = 'learning';
  else if (stale) stage = 'stale';
  else if (possibleChange) stage = 'change_review';
  else if (
    Number(candidate.tripCount) >= MIN_OPERATIONAL_TRIPS &&
    (Number(candidate.agreement) >= MIN_OPERATIONAL_AGREEMENT || strongTimePattern) &&
    effectiveConfidence >= MIN_OPERATIONAL_CONFIDENCE
  ) stage = 'operational';
  else if (
    Number(candidate.tripCount) >= 2 &&
    Number(candidate.agreement) >= 0.6 &&
    effectiveConfidence >= 0.58
  ) stage = 'suggested';
  return {
    active: stage === 'operational',
    ageDays: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
    decay: Math.round(decay * 100) / 100,
    effectiveConfidence,
    stage,
    stale,
  };
}

export function roadMemoryConfidenceExplanation(candidate = {}, nowMs = Date.now()) {
  const state = roadMemoryCandidateOperationalState(candidate, nowMs);
  const tripCount = Number(candidate.tripCount) || 0;
  const agreementPercent = Math.round((Number(candidate.agreement) || 0) * 100);
  const parts = [
    `${tripCount} independent drive${tripCount === 1 ? '' : 's'}`,
    `${agreementPercent}% limit agreement`,
  ];
  if (state.ageDays != null) {
    parts.push(state.ageDays === 0 ? 'observed today' : `last observed ${state.ageDays} day${state.ageDays === 1 ? '' : 's'} ago`);
  }
  if (state.decay > 0) parts.push(`confidence reduced ${Math.round(state.decay * 100)}% for age`);
  if (candidate.changeDetection?.status === 'possible_change') {
    parts.push(`recent drives suggest ${candidate.changeDetection.proposedLimitKmh} km/h`);
  }
  const eligibleProfiles = (candidate.timeProfiles || []).filter((profile) => profile?.eligible === true);
  if (eligibleProfiles.length) {
    parts.push(`${eligibleProfiles.length} time-specific pattern${eligibleProfiles.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

const mergeCandidateGeometry = (candidate = {}, observation = {}) => {
  const candidatePoints = candidate.sectionPoints || [];
  const observationPoints = observation.sectionPoints || [];
  if (observation.distanceM > Number(candidate.distanceM || 0) * 1.15) {
    return sampleGeometry(observationPoints);
  }
  const endpointDistance = Math.min(
    roadMemoryDistanceMeters(candidatePoints.at(-1), observationPoints[0]),
    roadMemoryDistanceMeters(observationPoints.at(-1), candidatePoints[0])
  );
  if (endpointDistance <= ADJACENT_ENDPOINT_RADIUS_M) {
    const append = roadMemoryDistanceMeters(candidatePoints.at(-1), observationPoints[0]) <=
      roadMemoryDistanceMeters(observationPoints.at(-1), candidatePoints[0]);
    return sampleGeometry(append
      ? [...candidatePoints, ...observationPoints]
      : [...observationPoints, ...candidatePoints]);
  }
  return sampleGeometry(candidatePoints);
};

export function mergeRoadMemoryObservation(candidate = null, observation = {}, id = '') {
  const observationTripId = String(observation.tripId || '');
  const existingTripVotes = candidate?.tripVotes && typeof candidate.tripVotes === 'object'
    ? { ...candidate.tripVotes }
    : {};
  if (!Object.keys(existingTripVotes).length) {
    (candidate?.tripIds || []).forEach((tripId, index) => {
      existingTripVotes[String(tripId)] = Number(candidate?.limitKmh) ||
        Number(Object.keys(candidate?.limitVotes || {})[index]) ||
        null;
    });
  }
  const alreadyObserved = Boolean(observationTripId && existingTripVotes[observationTripId] != null);
  if (!alreadyObserved && observationTripId) {
    existingTripVotes[observationTripId] = Math.round(Number(observation.limitKmh));
  }
  const trimmedTripVotes = Object.fromEntries(Object.entries(existingTripVotes).slice(-50));
  const tripIds = Object.keys(trimmedTripVotes);
  const votes = votesFromTripVotes(trimmedTripVotes);
  const winningLimitKmh = candidateLimitFromVotes(votes) ?? observation.limitKmh;
  const voteTotal = Object.values(votes).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const winningVotes = Number(votes[winningLimitKmh]) || 0;
  const agreement = voteTotal ? winningVotes / voteTotal : 0;
  let confidence = roadMemoryEvidenceConfidence(tripIds.length, agreement);
  const priorState = candidate ? roadMemoryCandidateOperationalState(candidate) : null;
  const establishedLimitKmh = Number(candidate?.limitKmh);
  const recentByTrip = new Map(
    (candidate?.chronologyRepairPending === true
      ? []
      : Array.isArray(candidate?.recentObservations) ? candidate.recentObservations : [])
      .filter((item) => item?.tripId)
      .map((item) => [String(item.tripId), item])
  );
  if (observationTripId) {
    recentByTrip.set(observationTripId, {
      tripId: observationTripId,
      limitKmh: Math.round(Number(observation.limitKmh)),
      observedAt: observation.observedAt,
      timeBucket: observation.timeBucket || roadMemoryTimeBucket(observation.observedAt),
      p85Kmh: Number(observation.p85Kmh) || null,
    });
  }
  const recentObservations = [...recentByTrip.values()]
    .sort((a, b) => (
      (observationTimestampMs(a?.observedAt) ?? 0) -
      (observationTimestampMs(b?.observedAt) ?? 0) ||
      String(a?.tripId || '').localeCompare(String(b?.tripId || ''))
    ))
    .slice(-8);
  let changeDetection = candidate?.chronologyRepairPending === true
    ? null
    : candidate?.changeDetection || null;
  const observationBucket = observation.timeBucket || roadMemoryTimeBucket(observation.observedAt);
  const priorBucketVotes = Object.values(candidate?.timeBuckets?.[observationBucket]?.tripVotes || {})
    .map(Number);
  const likelyNewTimePattern = Object.keys(candidate?.timeBuckets || {}).length > 0 &&
    !priorBucketVotes.includes(establishedLimitKmh);
  if (
    priorState?.active &&
    Number.isFinite(establishedLimitKmh) &&
    Number(observation.limitKmh) !== establishedLimitKmh &&
    !likelyNewTimePattern
  ) {
    const recentDifferent = recentObservations
      .filter((item) => Number(item.limitKmh) !== establishedLimitKmh)
      .slice(-3);
    const proposedLimitKmh = candidateLimitFromVotes(
      recentDifferent.reduce((result, item) => {
        result[item.limitKmh] = (result[item.limitKmh] || 0) + 1;
        return result;
      }, {})
    );
    const proposalCount = recentDifferent.filter((item) => Number(item.limitKmh) === proposedLimitKmh).length;
    if (proposalCount >= 2) {
      changeDetection = {
        status: 'possible_change',
        previousLimitKmh: establishedLimitKmh,
        proposedLimitKmh,
        evidenceCount: proposalCount,
        detectedAt: observation.observedAt || new Date().toISOString(),
      };
    }
  }
  const limitKmh = changeDetection?.status === 'possible_change' && Number.isFinite(establishedLimitKmh)
    ? establishedLimitKmh
    : winningLimitKmh;
  const timeBuckets = { ...(candidate?.timeBuckets || {}) };
  if (!alreadyObserved && observationTripId) {
    const bucket = observation.timeBucket || roadMemoryTimeBucket(observation.observedAt);
    const currentBucket = timeBuckets[bucket] || { tripVotes: {} };
    timeBuckets[bucket] = {
      ...currentBucket,
      tripVotes: {
        ...(currentBucket.tripVotes || {}),
        [observationTripId]: Math.round(Number(observation.limitKmh)),
      },
    };
  }
  const timeProfiles = buildTimeProfiles(timeBuckets, limitKmh, tripIds.length);
  const stableTimeProfiles = timeProfiles.filter((profile) => (
    profile.tripCount >= MIN_TIME_PROFILE_TRIPS &&
    profile.agreement >= MIN_OPERATIONAL_AGREEMENT
  ));
  if (
    tripIds.length >= MIN_TIME_PROFILE_TOTAL_TRIPS &&
    new Set(stableTimeProfiles.map((profile) => profile.limitKmh)).size >= 2
  ) {
    const patternedAgreement = stableTimeProfiles.reduce((sum, profile) => sum + profile.agreement, 0) /
      stableTimeProfiles.length;
    confidence = roadMemoryEvidenceConfidence(tripIds.length, Math.max(agreement, patternedAgreement));
  }
  const sectionPoints = candidate
    ? mergeCandidateGeometry(candidate, observation)
    : sampleGeometry(observation.sectionPoints);
  const center = sectionPoints[Math.floor(sectionPoints.length / 2)] || observation;
  const candidateId = candidate?.id || id;
  const observedBounds = observationBounds(
    candidate?.firstObservedAt,
    candidate?.lastObservedAt,
    (candidate?.recentObservations || []).map((item) => item?.observedAt),
    observation.observedAt
  );
  const next = {
    ...candidate,
    id: candidateId,
    sectionKey: candidateId,
    geohash: candidate?.geohash || '',
    lat: Number(center.lat),
    lng: Number(center.lng),
    coordinateSource: 'learned_local_corridor',
    source: 'local_road_memory',
    inferenceBasis: observation.inferenceBasis || candidate?.inferenceBasis || 'driving_behavior_p85',
    legalAuthority: false,
    limitKmh: Math.round(limitKmh),
    confidence: Math.round(confidence * 100) / 100,
    evidenceConfidence: Math.round(confidence * 100) / 100,
    verificationStatus: 'local_candidate',
    needsReview: true,
    tripIds,
    tripVotes: trimmedTripVotes,
    tripCount: tripIds.length,
    evidenceCount: tripIds.length,
    limitVotes: votes,
    agreement: Math.round(agreement * 100) / 100,
    recentObservations,
    changeDetection,
    timeBuckets,
    timeProfiles,
    sectionPoints,
    distanceM: Math.max(Number(candidate?.distanceM) || 0, Number(observation.distanceM) || 0),
    directionMode: observation.directionMode || candidate?.directionMode || 'both',
    directionBearing: Number.isFinite(observation.directionBearing)
      ? observation.directionBearing
      : candidate?.directionBearing ?? null,
    observedP85Kmh: observation.p85Kmh,
    firstObservedAt: observedBounds.firstObservedAt || candidate?.firstObservedAt || observation.observedAt,
    lastObservedAt: observedBounds.lastObservedAt || observation.observedAt || candidate?.lastObservedAt,
    sampleCount: (Number(candidate?.sampleCount) || 0) + (alreadyObserved ? 0 : Number(observation.sampleCount) || 0),
    roadName: candidate?.roadName || '',
    quality: observation.quality || candidate?.quality || null,
    chronologyRepairPending: false,
  };
  const state = roadMemoryCandidateOperationalState(next);
  return {
    ...next,
    ...state,
    contextLabel: roadMemoryConfidenceExplanation({ ...next, ...state }),
    directionLabel: next.directionMode === 'forward' && Number.isFinite(next.directionBearing)
      ? `Direction ${Math.round(next.directionBearing)}°`
      : 'Both directions',
    timeLabel: timeProfiles.some((profile) => profile.eligible)
      ? 'Time-specific Road Memory pattern'
      : 'All times',
  };
}

const mergeCandidateRecord = (target, incoming) => {
  let merged = target;
  const incomingTripVotes = incoming.tripVotes && typeof incoming.tripVotes === 'object'
    ? incoming.tripVotes
    : Object.fromEntries((incoming.tripIds || []).map((tripId) => [String(tripId), incoming.limitKmh]));
  Object.entries(incomingTripVotes).forEach(([tripId, limitKmh]) => {
    merged = mergeRoadMemoryObservation(merged, {
      tripId,
      limitKmh,
      p85Kmh: incoming.observedP85Kmh || limitKmh,
      sampleCount: Math.max(1, Math.round((Number(incoming.sampleCount) || 1) /
        Math.max(1, Object.keys(incomingTripVotes).length))),
      sectionPoints: incoming.sectionPoints,
      distanceM: incoming.distanceM,
      directionMode: incoming.directionMode,
      directionBearing: incoming.directionBearing,
      observedAt: incoming.lastObservedAt,
      timeBucket: incoming.recentObservations?.find((item) => String(item.tripId) === String(tripId))?.timeBucket ||
        'all_times',
      quality: incoming.quality,
    }, target.id);
  });
  return merged;
};

export function consolidateRoadMemoryCandidates(candidates = []) {
  const consolidated = [];
  for (const candidate of candidates.filter(Boolean)) {
    const matchIndex = consolidated.findIndex((existing) => {
      if (
        Number(existing.limitKmh) !== Number(candidate.limitKmh) ||
        existing.changeDetection?.status === 'possible_change' ||
        candidate.changeDetection?.status === 'possible_change'
      ) return false;
      if (
        Number.isFinite(existing.directionBearing) &&
        Number.isFinite(candidate.directionBearing) &&
        angleDifference(existing.directionBearing, candidate.directionBearing) > DIRECTION_TOLERANCE_DEG
      ) return false;
      const score = roadMemoryObservationMatchScore({
        sectionPoints: candidate.sectionPoints,
        directionBearing: candidate.directionBearing,
        limitKmh: candidate.limitKmh,
      }, existing);
      if (!Number.isFinite(score)) return false;
      const existingPoints = existing.sectionPoints || [];
      const candidatePoints = candidate.sectionPoints || [];
      const endpointDistance = existingPoints.length > 1 && candidatePoints.length > 1
        ? Math.min(
            roadMemoryDistanceMeters(existingPoints[0], candidatePoints[0]),
            roadMemoryDistanceMeters(existingPoints[0], candidatePoints.at(-1)),
            roadMemoryDistanceMeters(existingPoints.at(-1), candidatePoints[0]),
            roadMemoryDistanceMeters(existingPoints.at(-1), candidatePoints.at(-1))
          )
        : Infinity;
      const existingTrips = new Set((existing.tripIds || []).map(String));
      const sharedTripCount = (candidate.tripIds || [])
        .map(String)
        .filter((tripId) => existingTrips.has(tripId))
        .length;
      // Strong geometric overlap may merge immediately. Merely adjacent fragments
      // require continuity on at least two independent drives so nearby parallel
      // roads or one noisy pass cannot be stitched into the same corridor.
      return score >= 100 || (
        endpointDistance <= 120 &&
        sharedTripCount >= 2 &&
        score >= -80
      );
    });
    if (matchIndex < 0) consolidated.push(candidate);
    else consolidated[matchIndex] = mergeCandidateRecord(consolidated[matchIndex], candidate);
  }
  return consolidated;
}

export function roadMemoryTripSignature(trip = {}) {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  return [
    trip.id || trip.trip_id || trip.start_time || '',
    trip.end_time || '',
    points.length,
    points[0]?.timestamp || '',
    points.at(-1)?.timestamp || '',
  ].join('|');
}
