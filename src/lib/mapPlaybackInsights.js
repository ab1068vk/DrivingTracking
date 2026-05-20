import { calculateBearing, haversineDistance } from '@/lib/tripEngine';

const IDLE_SPEED_KMH = 5;
const MIN_STOP_SECONDS = 60;
const MAX_VISUAL_ACCURACY_M = 100;
const MAX_VISUAL_SPEED_KMH = 230;
const MAX_SEGMENT_JUMP_SPEED_KMH = 240;
const MAX_SMOOTHING_ACCURACY_M = 45;
const DEFAULT_RENDER_POINTS = 700;

export const SPEED_BANDS = [
  { id: 'slow', label: 'Slow', min: 0, color: '#94a3b8' },
  { id: 'city', label: 'City', min: 15, color: '#3b82f6' },
  { id: 'cruise', label: 'Cruise', min: 55, color: '#22c55e' },
  { id: 'fast', label: 'Fast', min: 90, color: '#f97316' },
  { id: 'risk', label: 'Risk', min: 120, color: '#ef4444' },
];

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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
  if (point.lat == null || point.lng == null) return false;
  if (point.accuracy != null && !point.map_matched && point.accuracy > MAX_VISUAL_ACCURACY_M) return false;
  if (Number.isFinite(point.speed_kmh) && point.speed_kmh > MAX_VISUAL_SPEED_KMH) return false;
  if (!previous) return true;

  const prevMs = pointTimeMs(previous);
  const currMs = pointTimeMs(point);
  if (prevMs != null && currMs != null && currMs <= prevMs) return false;

  const impliedSpeedKmh = segmentImpliedSpeedKmh(previous, point);
  if (impliedSpeedKmh == null) return true;

  const reportedSpeed = finiteNumber(point.speed_kmh ?? previous.speed_kmh);
  const reportedAllowsJump = reportedSpeed != null && reportedSpeed > 120;
  if (impliedSpeedKmh > MAX_SEGMENT_JUMP_SPEED_KMH && !reportedAllowsJump) return false;
  if (point.accuracy != null && point.accuracy > 60 && impliedSpeedKmh > 140) return false;
  return true;
};

export const cleanRoutePoints = (points = []) => {
  const accepted = [];
  (Array.isArray(points) ? points : [])
    .map(normalizeRoutePoint)
    .forEach((point) => {
      if (shouldKeepVisualPoint(point, accepted.at(-1))) accepted.push(point);
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

const progressForIndex = (index, total) => (
  total > 1 ? Math.max(0, Math.min(100, (index / (total - 1)) * 100)) : 0
);

export function gpsQualityForPoint(point = {}) {
  if (point.map_match_quality === 'gap') return { id: 'gap', label: 'OSRM gap', color: '#ef4444' };
  if (point.map_match_quality === 'low') return { id: 'low', label: 'Low match', color: '#f97316' };
  if (point.map_match_quality === 'medium' || point.gps_smoothed) return { id: 'medium', label: 'Smoothed', color: '#eab308' };
  if (point.map_matched || point.map_match_quality === 'high') return { id: 'matched', label: 'Matched', color: '#22c55e' };
  const accuracy = finiteNumber(point.accuracy);
  if (accuracy != null && accuracy > 60) return { id: 'low', label: 'Weak GPS', color: '#f97316' };
  if (accuracy != null && accuracy > 25) return { id: 'medium', label: 'Fair GPS', color: '#eab308' };
  return { id: 'raw', label: 'GPS', color: '#3b82f6' };
}

export function buildGpsQualitySummary(points = []) {
  const clean = cleanRoutePoints(points);
  const counts = clean.reduce((result, point) => {
    const quality = gpsQualityForPoint(point);
    result[quality.id] = (result[quality.id] || 0) + 1;
    return result;
  }, {});
  return {
    total: clean.length,
    matched: counts.matched || 0,
    smoothed: counts.medium || 0,
    weak: counts.low || 0,
    gaps: counts.gap || 0,
    raw: counts.raw || 0,
  };
}

export function downsampleRoutePoints(points = [], maxPoints = 250) {
  const clean = cleanRoutePoints(points);
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

export function prepareMapRoutePoints(points = [], options = {}) {
  const {
    maxPoints = DEFAULT_RENDER_POINTS,
    smooth = true,
  } = options;
  const clean = cleanRoutePoints(points);
  const visualPoints = smooth ? smoothRoutePoints(clean) : clean;
  if (!maxPoints || visualPoints.length <= maxPoints) return visualPoints;
  return downsampleRoutePoints(visualPoints, maxPoints);
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

export function snapEventsToRoute(events = [], points = [], maxDistanceM = 90) {
  const clean = cleanRoutePoints(points);
  if (!clean.length) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).map((event) => {
    const lat = finiteNumber(event?.lat);
    const lng = finiteNumber(event?.lng);
    if (lat == null || lng == null) return event;
    let best = null;
    clean.forEach((point, index) => {
      const distanceM = haversineDistance(lat, lng, point.lat, point.lng) * 1000;
      if (!best || distanceM < best.distanceM) best = { point, index, distanceM };
    });
    if (!best || best.distanceM > maxDistanceM) return event;
    return {
      ...event,
      original_lat: event.original_lat ?? event.lat,
      original_lng: event.original_lng ?? event.lng,
      lat: best.point.lat,
      lng: best.point.lng,
      route_event_snapped: true,
      route_event_snap_distance_m: Math.round(best.distanceM),
      playbackIndex: event.playbackIndex ?? best.index,
      matched_road_name: event.matched_road_name || best.point.speed_limit_road_name || best.point.matched_road_name || null,
      speed_limit_kmh: event.speed_limit_kmh ?? best.point.speed_limit_kmh,
      speed_limit_source: event.speed_limit_source || best.point.speed_limit_source || null,
    };
  });
}

const segmentSpeed = (prev, curr, distanceKm, durationSeconds) => {
  const reported = finiteNumber(curr.speed_kmh ?? prev.speed_kmh);
  if (reported != null) return Math.max(0, reported);
  return durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0;
};

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

export function buildPlaybackTimeline(points = [], events = []) {
  const clean = cleanRoutePoints(points);
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
    totalDistanceKm += distanceKm;

    const prevMs = pointTimeMs(prev);
    const currMs = pointTimeMs(curr);
    const durationSeconds = prevMs != null && currMs != null && currMs > prevMs
      ? (currMs - prevMs) / 1000
      : 0;
    const speedKmh = segmentSpeed(prev, curr, distanceKm, durationSeconds);
    maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);

    const speedLimitKmh = finiteNumber(curr.speed_limit_kmh ?? prev.speed_limit_kmh);
    const overLimitKmh = speedLimitKmh != null ? Math.max(0, speedKmh - speedLimitKmh) : 0;
    const band = speedBandForKmh(speedKmh);
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
      color: overLimitKmh > 10 ? '#ef4444' : overLimitKmh > 0 ? '#f97316' : band.color,
      progressStart: progressForIndex(i - 1, clean.length),
      progressEnd: progressForIndex(i, clean.length),
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
        progress: progressForIndex(playbackIndex, clean.length),
        offsetSeconds: firstMs != null && Number.isFinite(eventMs) ? Math.max(0, Math.round((eventMs - firstMs) / 1000)) : 0,
      };
    })
    .sort((a, b) => a.playbackIndex - b.playbackIndex);

  const stops = collectStops(segments).map((stop, index) => ({
      ...stop,
      id: `stop-${index}`,
      progressStart: progressForIndex(stop.startIndex, clean.length),
      progressEnd: progressForIndex(stop.endIndex, clean.length),
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

export function playbackPositionAtElapsed(points = [], elapsedSeconds = 0) {
  const clean = cleanRoutePoints(points);
  if (!clean.length) return { index: 0, point: null, heading: 0, ratio: 0, fromIndex: 0, toIndex: 0 };
  if (clean.length === 1) return { index: 0, point: clean[0], heading: Number(clean[0].heading ?? clean[0].bearing ?? 0) || 0, ratio: 0, fromIndex: 0, toIndex: 0 };

  const firstMs = pointTimeMs(clean[0]);
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
  let index = clean.length - 1;
  for (let i = 1; i < clean.length; i++) {
    const currMs = pointTimeMs(clean[i]);
    if (currMs == null || currMs < targetMs) continue;
    index = i;
    break;
  }

  const prev = clean[Math.max(0, index - 1)];
  const curr = clean[index];
  const prevMs = pointTimeMs(prev);
  const currMs = pointTimeMs(curr);
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
    index,
    point,
    heading: calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng),
    ratio,
    fromIndex: Math.max(0, index - 1),
    toIndex: index,
  };
}

export function buildRouteComparison(currentTrip = {}, secondaryTrip = {}) {
  if (!secondaryTrip) return { rows: [], notes: [] };
  const currentEvents = currentTrip.driving_events?.length || 0;
  const secondaryEvents = secondaryTrip.driving_events?.length || 0;
  const currentAvg = Number(currentTrip.avg_running_speed_kmh ?? currentTrip.avg_speed_kmh) || 0;
  const secondaryAvg = Number(secondaryTrip.avg_running_speed_kmh ?? secondaryTrip.avg_speed_kmh) || 0;
  const rows = [
    { label: 'Score', current: Number(currentTrip.score_overall) || 0, other: Number(secondaryTrip.score_overall) || 0, higherWins: true },
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
