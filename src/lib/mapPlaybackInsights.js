import { calculateBearing, haversineDistance } from '@/lib/tripEngine';

const IDLE_SPEED_KMH = 5;
const MIN_STOP_SECONDS = 60;
const MAX_VISUAL_ACCURACY_M = 100;
const MAX_VISUAL_SPEED_KMH = 230;
const MAX_SEGMENT_JUMP_SPEED_KMH = 240;
const MAX_VISUAL_SEGMENT_GAP_SECONDS = 120;
const ROUTE_GAP_SECONDS = MAX_VISUAL_SEGMENT_GAP_SECONDS;
const MAX_SMOOTHING_ACCURACY_M = 45;
const DEFAULT_RENDER_POINTS = 700;

export const VISUAL_REFERENCE_SPEED_KMH = 35;
export const MIN_VISUAL_PLAYBACK_RATE = 0.22;
export const MAX_VISUAL_PLAYBACK_RATE = 3.1;

export const SPEED_BANDS = [
  { id: 'slow', label: 'Slow', min: 0, color: '#94a3b8' },
  { id: 'city', label: 'City', min: 15, color: '#3b82f6' },
  { id: 'cruise', label: 'Cruise', min: 55, color: '#22c55e' },
  { id: 'fast', label: 'Fast', min: 90, color: '#f97316' },
  { id: 'risk', label: 'Risk', min: 120, color: '#ef4444' },
];

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validLatitude = (value) => value != null && value >= -90 && value <= 90;
const validLongitude = (value) => value != null && value >= -180 && value <= 180;

export const pointTimeMs = (point) => {
  const value = point?.timestamp ?? point?.time;
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const normalizeRoutePoint = (point) => {
  const speed = finiteNumber(point?.speed_kmh);
  const accuracy = finiteNumber(point?.accuracy);
  return {
    ...point,
    lat: finiteNumber(point?.lat),
    lng: finiteNumber(point?.lng),
    speed_kmh: speed != null ? Math.max(0, speed) : point?.speed_kmh,
    accuracy: accuracy != null ? Math.max(0, accuracy) : point?.accuracy,
  };
};

const segmentImpliedSpeedKmh = (prev, curr) => {
  const prevMs = pointTimeMs(prev);
  const currMs = pointTimeMs(curr);
  if (prevMs == null || currMs == null || currMs <= prevMs) return null;
  const distanceKm = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
  return (distanceKm / ((currMs - prevMs) / 1000)) * 3600;
};

const shouldKeepVisualPoint = (point, previous) => {
  if (!validLatitude(point.lat) || !validLongitude(point.lng)) return false;
  if (point.accuracy != null && !point.map_matched && point.accuracy > MAX_VISUAL_ACCURACY_M) return false;
  if (Number.isFinite(point.speed_kmh) && point.speed_kmh > MAX_VISUAL_SPEED_KMH) return false;
  if (!previous) return true;

  const prevMs = pointTimeMs(previous);
  const currMs = pointTimeMs(point);
  if (prevMs != null && currMs != null && currMs <= prevMs) return false;

  const impliedSpeedKmh = segmentImpliedSpeedKmh(previous, point);
  if (impliedSpeedKmh == null) return true;

  if (impliedSpeedKmh > MAX_SEGMENT_JUMP_SPEED_KMH) return false;
  if (point.accuracy != null && point.accuracy > 60 && impliedSpeedKmh > 140) return false;
  return true;
};

export const cleanRoutePoints = (points = []) => {
  const accepted = [];
  (Array.isArray(points) ? points : [])
    .map(normalizeRoutePoint)
    .forEach((point) => {
      const previous = accepted.at(-1);
      if (!shouldKeepVisualPoint(point, previous)) return;

      const prevMs = pointTimeMs(previous);
      const currMs = pointTimeMs(point);
      const hasRouteGap = point?.tracking_gap === true ||
        point?.route_gap === true ||
        (previous && prevMs != null && currMs != null && (currMs - prevMs) / 1000 > MAX_VISUAL_SEGMENT_GAP_SECONDS);
      accepted.push(hasRouteGap ? { ...point, tracking_gap: true } : point);
    });
  return accepted;
};

const smoothRoutePoints = (points = []) => {
  if (points.length < 3 || points.some((point) => point.map_matched)) return points;

  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const prev = points[index - 1];
    const next = points[index + 1];
    const prevSpeed = segmentImpliedSpeedKmh(prev, point);
    const nextSpeed = segmentImpliedSpeedKmh(point, next);
    const accuracy = finiteNumber(point.accuracy) ?? 12;
    const reportedSpeed = finiteNumber(point.speed_kmh) ?? Math.max(prevSpeed || 0, nextSpeed || 0);

    if (accuracy > MAX_SMOOTHING_ACCURACY_M || reportedSpeed > 120) return point;
    if ((prevSpeed != null && prevSpeed > MAX_SEGMENT_JUMP_SPEED_KMH) || (nextSpeed != null && nextSpeed > MAX_SEGMENT_JUMP_SPEED_KMH)) return point;

    const strength = accuracy >= 25 ? 0.34 : accuracy >= 12 ? 0.22 : 0.12;
    const midLat = (prev.lat + next.lat) / 2;
    const midLng = (prev.lng + next.lng) / 2;
    return {
      ...point,
      original_lat: point.original_lat ?? point.lat,
      original_lng: point.original_lng ?? point.lng,
      lat: point.lat + (midLat - point.lat) * strength,
      lng: point.lng + (midLng - point.lng) * strength,
      gps_smoothed: true,
    };
  });
};

export function speedBandForKmh(speedKmh = 0) {
  const speed = Number(speedKmh) || 0;
  return [...SPEED_BANDS].reverse().find((band) => speed >= band.min) || SPEED_BANDS[0];
}

export function visualPlaybackRateForSpeed(speedKmh = 0) {
  const speed = Math.max(0, Number(speedKmh) || 0);
  if (speed <= IDLE_SPEED_KMH) return MIN_VISUAL_PLAYBACK_RATE;
  return Math.max(
    MIN_VISUAL_PLAYBACK_RATE,
    Math.min(MAX_VISUAL_PLAYBACK_RATE, speed / VISUAL_REFERENCE_SPEED_KMH)
  );
}

const progressForIndex = (index, total) => (
  total > 1 ? Math.max(0, Math.min(100, (index / (total - 1)) * 100)) : 0
);

const progressForTime = (point, firstMs, lastMs, fallback = 0) => {
  const currentMs = pointTimeMs(point);
  return firstMs != null && lastMs != null && currentMs != null && lastMs > firstMs
    ? Math.max(0, Math.min(100, ((currentMs - firstMs) / (lastMs - firstMs)) * 100))
    : fallback;
};

const distanceForKeys = (points = [], latKey = 'lat', lngKey = 'lng') => {
  const clean = (Array.isArray(points) ? points : [])
    .map((point) => ({
      lat: finiteNumber(point?.[latKey]),
      lng: finiteNumber(point?.[lngKey]),
    }))
    .filter((point) => point.lat != null && point.lng != null);

  let distanceKm = 0;
  for (let i = 1; i < clean.length; i++) {
    distanceKm += haversineDistance(clean[i - 1].lat, clean[i - 1].lng, clean[i].lat, clean[i].lng);
  }
  return distanceKm;
};

export function hasRecoverableOriginalRouteGeometry(points = []) {
  const route = Array.isArray(points) ? points : [];
  const originalCount = route.filter((point) => (
    finiteNumber(point?.original_lat) != null && finiteNumber(point?.original_lng) != null
  )).length;
  if (originalCount < 2) return false;

  const currentDistanceKm = distanceForKeys(route);
  const originalDistanceKm = distanceForKeys(route, 'original_lat', 'original_lng');
  return originalDistanceKm > 0.1 && originalDistanceKm > Math.max(0.1, currentDistanceKm * 2);
}

export function restoreOriginalRouteGeometry(points = []) {
  if (!hasRecoverableOriginalRouteGeometry(points)) return Array.isArray(points) ? points : [];
  return points.map((point) => {
    const originalLat = finiteNumber(point?.original_lat);
    const originalLng = finiteNumber(point?.original_lng);
    if (originalLat == null || originalLng == null) return point;
    return {
      ...point,
      matched_lat: point.matched_lat ?? point.lat,
      matched_lng: point.matched_lng ?? point.lng,
      lat: originalLat,
      lng: originalLng,
      recovered_map_matching_geometry: true,
    };
  });
}

export function downsampleRoutePoints(points = [], maxPoints = 250) {
  const clean = cleanRoutePoints(restoreOriginalRouteGeometry(points));
  if (clean.length <= maxPoints) return clean;
  if (maxPoints < 3) return clean.slice(0, maxPoints);

  const result = [clean[0]];
  const step = (clean.length - 2) / (maxPoints - 2);
  for (let i = 1; i < maxPoints - 1; i++) {
    result.push(clean[Math.round(i * step)]);
  }
  result.push(clean[clean.length - 1]);
  return result;
}

export function injectTimestampGapMarkers(points, gapThresholdSeconds = ROUTE_GAP_SECONDS) {
  if (!Array.isArray(points) || points.length < 2) return points;
  return points.map((point, index) => {
    if (index === 0) return point;
    if (point.tracking_gap === true || point.route_gap === true) return point;

    const previous = points[index - 1];
    const previousMs = pointTimeMs(previous);
    const currentMs = pointTimeMs(point);
    if (
      previousMs != null &&
      currentMs != null &&
      currentMs > previousMs &&
      (currentMs - previousMs) / 1000 > gapThresholdSeconds
    ) {
      return { ...point, tracking_gap: true };
    }
    return point;
  });
}

export function prepareMapRoutePoints(points = [], options = {}) {
  const {
    maxPoints = DEFAULT_RENDER_POINTS,
    smooth = true,
  } = options;
  const clean = cleanRoutePoints(restoreOriginalRouteGeometry(points));
  const visualPoints = smooth ? smoothRoutePoints(clean) : clean;
  if (!maxPoints || visualPoints.length <= maxPoints) return injectTimestampGapMarkers(visualPoints);
  return injectTimestampGapMarkers(downsampleRoutePoints(visualPoints, maxPoints));
}

export function selectMapRoutePoints(analysisPoints = [], recordedPoints = []) {
  const strictPoints = prepareMapRoutePoints(analysisPoints, { maxPoints: null, smooth: false });
  const recordedVisualPoints = prepareMapRoutePoints(recordedPoints, { maxPoints: null, smooth: false });
  const strictCoverage = recordedVisualPoints.length
    ? strictPoints.length / recordedVisualPoints.length
    : 1;
  const scoringCleanerCollapsedRoute =
    recordedVisualPoints.length >= 8 &&
    strictPoints.length >= 2 &&
    strictCoverage <= 0.25;

  return {
    points: scoringCleanerCollapsedRoute ? recordedVisualPoints : strictPoints,
    usedRecordedFallback: scoringCleanerCollapsedRoute,
    strictPointCount: strictPoints.length,
    recordedVisualPointCount: recordedVisualPoints.length,
  };
}

export function eventIndexForRoute(event, points = []) {
  if (!points.length) return 0;
  const eventMs = new Date(event?.timestamp || event?.startTime || 0).getTime();
  if (Number.isFinite(eventMs)) {
    let bestIndex = 0;
    let bestDelta = Infinity;
    points.forEach((point, index) => {
      const pointMs = pointTimeMs(point);
      if (pointMs == null) return;
      const delta = Math.abs(pointMs - eventMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  const lat = finiteNumber(event?.lat);
  const lng = finiteNumber(event?.lng);
  if (lat == null || lng == null) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = Math.abs(lat - point.lat) + Math.abs(lng - point.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

const collectStops = (segments = []) => {
  const stops = [];
  /** @type {{ startIndex: number, endIndex: number, durationSeconds: number, distanceKm: number } | null} */
  let active = null;
  segments.forEach((segment) => {
    if (segment.speedKmh <= IDLE_SPEED_KMH) {
      active ??= { startIndex: segment.fromIndex, endIndex: segment.toIndex, durationSeconds: 0, distanceKm: 0 };
      active.endIndex = segment.toIndex;
      active.durationSeconds += segment.durationSeconds;
      active.distanceKm += segment.distanceKm;
      return;
    }
    if (active?.durationSeconds >= MIN_STOP_SECONDS) stops.push(active);
    active = null;
  });
  if (active?.durationSeconds >= MIN_STOP_SECONDS) stops.push(active);
  return stops;
};

const segmentDisplaySpeed = (prev, curr, distanceKm, durationSeconds) => {
  const implied = durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : null;
  const obd = finiteNumber(curr.obd_speed_kmh ?? prev.obd_speed_kmh);
  if (obd != null) return Math.max(0, obd);

  const reported = finiteNumber(curr.speed_kmh ?? prev.speed_kmh);
  if (reported == null) return Math.max(0, implied || 0);
  if (reported <= IDLE_SPEED_KMH && implied != null && implied >= SPEED_BANDS[1].min) {
    return Math.max(0, implied);
  }
  return Math.max(0, reported);
};

export function buildPlaybackTimeline(points = [], events = []) {
  const clean = cleanRoutePoints(restoreOriginalRouteGeometry(points));
  const firstMs = pointTimeMs(clean[0]);
  const lastMs = pointTimeMs(clean[clean.length - 1]);
  const totalDurationSeconds = firstMs != null && lastMs != null && lastMs > firstMs
    ? Math.round((lastMs - firstMs) / 1000)
    : 0;

  let totalDistanceKm = 0;
  let maxSpeedKmh = 0;
  const cumulativeDistancesKm = [0];
  const segments = [];

  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1];
    const curr = clean[i];
    const distanceKm = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);
    const prevMs = pointTimeMs(prev);
    const currMs = pointTimeMs(curr);
    const durationSeconds = prevMs != null && currMs != null && currMs > prevMs
      ? (currMs - prevMs) / 1000
      : 0;
    if (curr.tracking_gap === true || durationSeconds > MAX_VISUAL_SEGMENT_GAP_SECONDS) {
      cumulativeDistancesKm.push(totalDistanceKm);
      continue;
    }
    totalDistanceKm += distanceKm;
    const speedKmh = segmentDisplaySpeed(prev, curr, distanceKm, durationSeconds);
    maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);

    const speedLimitKmh = finiteNumber(curr.speed_limit_kmh ?? prev.speed_limit_kmh);
    const overLimitKmh = speedLimitKmh != null ? Math.max(0, speedKmh - speedLimitKmh) : 0;
    const band = speedBandForKmh(speedKmh);
    const speedLimitColor = speedLimitKmh == null
      ? null
      : overLimitKmh > 10
        ? '#ef4444'
        : overLimitKmh > 0
          ? '#f97316'
          : '#22c55e';
    const heading = calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
    const segment = {
      id: `seg-${i - 1}`,
      fromIndex: i - 1,
      toIndex: i,
      from: prev,
      to: curr,
      distanceKm,
      durationSeconds,
      speedKmh,
      speedLimitKmh,
      overLimitKmh,
      speedLimitSource: curr.speed_limit_source || prev.speed_limit_source || null,
      roadName: curr.speed_limit_road_name || prev.speed_limit_road_name || null,
      heading,
      band,
      speedBandColor: band.color,
      speedLimitColor,
      color: band.color,
      progressStart: progressForTime(prev, firstMs, lastMs, progressForIndex(i - 1, clean.length)),
      progressEnd: progressForTime(curr, firstMs, lastMs, progressForIndex(i, clean.length)),
      startOffsetSeconds: firstMs != null && prevMs != null ? Math.max(0, (prevMs - firstMs) / 1000) : 0,
      endOffsetSeconds: firstMs != null && currMs != null ? Math.max(0, (currMs - firstMs) / 1000) : 0,
    };
    segment.timeProgressStart = totalDurationSeconds > 0
      ? Math.max(0, Math.min(100, (segment.startOffsetSeconds / totalDurationSeconds) * 100))
      : segment.progressStart;
    segment.timeProgressEnd = totalDurationSeconds > 0
      ? Math.max(0, Math.min(100, (segment.endOffsetSeconds / totalDurationSeconds) * 100))
      : segment.progressEnd;
    segments.push(segment);
    cumulativeDistancesKm.push(totalDistanceKm);
  }

  clean.forEach((point) => {
    maxSpeedKmh = Math.max(maxSpeedKmh, Number(point.speed_kmh) || 0);
  });

  const timelineEvents = (Array.isArray(events) ? events : [])
    .filter((event) => finiteNumber(event?.lat) != null && finiteNumber(event?.lng) != null)
    .map((event) => {
      const playbackIndex = eventIndexForRoute(event, clean);
      const eventMs = new Date(event.timestamp || event.startTime || 0).getTime();
      return {
        ...event,
        playbackIndex,
        progress: firstMs != null && lastMs != null && Number.isFinite(eventMs) && lastMs > firstMs
          ? Math.max(0, Math.min(100, ((eventMs - firstMs) / (lastMs - firstMs)) * 100))
          : progressForIndex(playbackIndex, clean.length),
        offsetSeconds: firstMs != null && Number.isFinite(eventMs) ? Math.max(0, Math.round((eventMs - firstMs) / 1000)) : 0,
      };
    })
    .sort((a, b) => a.playbackIndex - b.playbackIndex);

  const stops = collectStops(segments).map((stop, index) => ({
      ...stop,
      id: `stop-${index}`,
      progressStart: progressForTime(clean[stop.startIndex], firstMs, lastMs, progressForIndex(stop.startIndex, clean.length)),
      progressEnd: progressForTime(clean[stop.endIndex], firstMs, lastMs, progressForIndex(stop.endIndex, clean.length)),
      timeProgressStart: totalDurationSeconds > 0
        ? Math.max(0, Math.min(100, ((segments.find((segment) => segment.fromIndex === stop.startIndex)?.startOffsetSeconds || 0) / totalDurationSeconds) * 100))
        : progressForIndex(stop.startIndex, clean.length),
      timeProgressEnd: totalDurationSeconds > 0
        ? Math.max(0, Math.min(100, ((segments.find((segment) => segment.toIndex === stop.endIndex)?.endOffsetSeconds || 0) / totalDurationSeconds) * 100))
        : progressForIndex(stop.endIndex, clean.length),
      point: clean[stop.startIndex],
    }));

  const violations = segments.filter((segment) => segment.overLimitKmh > 0);
  const avgSpeedKmh = totalDurationSeconds > 0 ? (totalDistanceKm / totalDurationSeconds) * 3600 : 0;
  const longestStop = stops.reduce((best, stop) => (
    stop.durationSeconds > (best?.durationSeconds || 0) ? stop : best
  ), null);
  const firstEvent = timelineEvents[0] || null;
  const story = [
    clean.length > 1 ? `Covered ${totalDistanceKm.toFixed(1)} km in ${Math.round(totalDurationSeconds / 60)} min.` : null,
    maxSpeedKmh > 0 ? `Peak speed reached ${Math.round(maxSpeedKmh)} km/h.` : null,
    firstEvent ? `First event was ${String(firstEvent.type || 'event').replace(/_/g, ' ')} at ${Math.round(firstEvent.offsetSeconds / 60)} min.` : null,
    longestStop ? `Longest stop lasted ${Math.round(longestStop.durationSeconds / 60)} min.` : null,
    violations.length ? `${violations.length} route segments were above the known/default limit.` : null,
  ].filter(Boolean);

  return {
    points: clean,
    segments,
    events: timelineEvents,
    stops,
    violations,
    story,
    cumulativeDistancesKm,
    stats: {
      pointCount: clean.length,
      distanceKm: totalDistanceKm,
      durationSeconds: totalDurationSeconds,
      avgSpeedKmh,
      maxSpeedKmh,
      eventCount: timelineEvents.length,
      stopCount: stops.length,
      violationCount: violations.length,
    },
  };
}

export function buildPlaybackPositionIndex(points = [], options = {}) {
  const { alreadyClean = false } = options;
  const clean = alreadyClean
    ? (Array.isArray(points) ? points : [])
    : cleanRoutePoints(restoreOriginalRouteGeometry(points));
  const timesMs = clean.map(pointTimeMs);
  const hasTimeline = timesMs.length > 1 && timesMs.every((time, index) => (
    time != null && (index === 0 || time > timesMs[index - 1])
  ));
  return {
    points: clean,
    timesMs,
    firstMs: timesMs[0] ?? null,
    hasTimeline,
  };
}

const findPlaybackIndexForTargetMs = (timesMs = [], targetMs = 0) => {
  let low = 1;
  let high = timesMs.length - 1;
  let result = high;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (timesMs[mid] >= targetMs) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
};

export function playbackPositionAtElapsed(points = [], elapsedSeconds = 0, positionIndex = null) {
  const indexData = positionIndex?.points ? positionIndex : buildPlaybackPositionIndex(points);
  const clean = indexData.points;
  if (!clean.length) return { index: 0, point: null, heading: 0, ratio: 0, fromIndex: 0, toIndex: 0 };
  if (clean.length === 1) return { index: 0, point: clean[0], heading: Number(clean[0].heading ?? clean[0].bearing ?? 0) || 0, ratio: 0, fromIndex: 0, toIndex: 0 };

  const firstMs = indexData.firstMs ?? pointTimeMs(clean[0]);
  if (firstMs == null) {
    const fallbackIndex = Math.max(0, Math.min(clean.length - 1, Math.round(elapsedSeconds)));
    return { index: fallbackIndex, point: clean[fallbackIndex], heading: 0, ratio: 0, fromIndex: Math.max(0, fallbackIndex - 1), toIndex: fallbackIndex };
  }
  if (elapsedSeconds <= 0) {
    return {
      index: 0,
      point: clean[0],
      heading: Number(clean[0].heading ?? clean[0].bearing ?? 0) || 0,
      ratio: 0,
      fromIndex: 0,
      toIndex: 0,
    };
  }

  const targetMs = firstMs + Math.max(0, elapsedSeconds) * 1000;
  const index = indexData.hasTimeline
    ? findPlaybackIndexForTargetMs(indexData.timesMs, targetMs)
    : clean.findIndex((point, pointIndex) => (
      pointIndex > 0 && (pointTimeMs(point) ?? -Infinity) >= targetMs
    ));
  const safeIndex = index > 0 ? index : clean.length - 1;

  const prev = clean[Math.max(0, safeIndex - 1)];
  const curr = clean[safeIndex];
  const prevMs = indexData.timesMs?.[Math.max(0, safeIndex - 1)] ?? pointTimeMs(prev);
  const currMs = indexData.timesMs?.[safeIndex] ?? pointTimeMs(curr);
  const ratio = prevMs != null && currMs != null && currMs > prevMs
    ? Math.max(0, Math.min(1, (targetMs - prevMs) / (currMs - prevMs)))
    : 1;
  const point = {
    ...curr,
    lat: prev.lat + (curr.lat - prev.lat) * ratio,
    lng: prev.lng + (curr.lng - prev.lng) * ratio,
    speed_kmh: prev.speed_kmh != null && curr.speed_kmh != null
      ? Number(prev.speed_kmh) + (Number(curr.speed_kmh) - Number(prev.speed_kmh)) * ratio
      : curr.speed_kmh,
  };

  return {
    index: safeIndex,
    point,
    heading: calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng),
    ratio,
    fromIndex: Math.max(0, safeIndex - 1),
    toIndex: safeIndex,
  };
}

export function routeDistanceAtPlaybackPosition(timeline = {}, playbackPosition = {}, fallbackIndex = 0) {
  const cumulativeDistancesKm = Array.isArray(timeline.cumulativeDistancesKm) ? timeline.cumulativeDistancesKm : [];
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  const fromIndex = Math.max(0, playbackPosition.fromIndex ?? Math.max(0, fallbackIndex - 1));
  const toIndex = Math.max(fromIndex, playbackPosition.toIndex ?? fallbackIndex);
  const segment = segments.find((item) => item.fromIndex === fromIndex && item.toIndex === toIndex);
  const baseDistanceKm = cumulativeDistancesKm[fromIndex] || 0;
  return baseDistanceKm + (segment?.distanceKm || 0) * (playbackPosition.ratio ?? 0);
}

export function advancePlaybackElapsed(elapsedSeconds = 0, deltaSeconds = 0, playbackMultiplier = 1, durationSeconds = Infinity) {
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  const delta = Math.max(0, Number(deltaSeconds) || 0);
  const multiplier = Math.max(0, Number(playbackMultiplier) || 0);
  const duration = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Number(durationSeconds))
    : Infinity;
  return Math.min(duration, elapsed + delta * multiplier);
}

export function buildRouteComparison(currentTrip = {}, secondaryTrip = {}) {
  if (!secondaryTrip) return { rows: [], notes: [] };
  const currentEvents = currentTrip.driving_events?.length || 0;
  const secondaryEvents = secondaryTrip.driving_events?.length || 0;
  const currentAvg = Number(currentTrip.avg_running_speed_kmh ?? currentTrip.avg_speed_kmh) || 0;
  const secondaryAvg = Number(secondaryTrip.avg_running_speed_kmh ?? secondaryTrip.avg_speed_kmh) || 0;
  const currentScore = currentTrip.score_overall == null || currentTrip.score_overall === ''
    ? null
    : Number(currentTrip.score_overall);
  const secondaryScore = secondaryTrip.score_overall == null || secondaryTrip.score_overall === ''
    ? null
    : Number(secondaryTrip.score_overall);
  const hasScoreComparison = Number.isFinite(currentScore) && Number.isFinite(secondaryScore);
  const rows = [
    { label: 'Score', current: Number.isFinite(currentScore) ? currentScore : 'Unavailable', other: Number.isFinite(secondaryScore) ? secondaryScore : 'Unavailable', higherWins: hasScoreComparison ? true : null },
    { label: 'Events', current: currentEvents, other: secondaryEvents, higherWins: false },
    { label: 'Harsh brakes', current: currentTrip.harsh_brakes_count || 0, other: secondaryTrip.harsh_brakes_count || 0, higherWins: false },
    { label: 'Avg speed', current: currentAvg, other: secondaryAvg, higherWins: null, speed: true },
  ];
  const notes = [];
  const eventDelta = currentEvents - secondaryEvents;
  const speedDelta = currentAvg - secondaryAvg;
  if (eventDelta < 0) notes.push(`${Math.abs(eventDelta)} fewer recorded events than the comparison trip.`);
  if (eventDelta > 0) notes.push(`${eventDelta} more recorded events than the comparison trip.`);
  if (Math.abs(speedDelta) >= 5) notes.push(`${Math.abs(Math.round(speedDelta))} km/h ${speedDelta > 0 ? 'faster' : 'slower'} average pace.`);
  return { rows, notes };
}
