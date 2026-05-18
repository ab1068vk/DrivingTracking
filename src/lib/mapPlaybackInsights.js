import { calculateBearing, haversineDistance } from '@/lib/tripEngine';

const IDLE_SPEED_KMH = 5;
const MIN_STOP_SECONDS = 60;

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
  const ms = new Date(point?.timestamp || 0).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const cleanRoutePoints = (points = []) => (Array.isArray(points) ? points : [])
  .map((point) => ({
    ...point,
    lat: finiteNumber(point?.lat),
    lng: finiteNumber(point?.lng),
  }))
  .filter((point) => point.lat != null && point.lng != null);

export function speedBandForKmh(speedKmh = 0) {
  const speed = Number(speedKmh) || 0;
  return [...SPEED_BANDS].reverse().find((band) => speed >= band.min) || SPEED_BANDS[0];
}

const progressForIndex = (index, total) => (
  total > 1 ? Math.max(0, Math.min(100, (index / (total - 1)) * 100)) : 0
);

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

const segmentSpeed = (prev, curr, distanceKm, durationSeconds) => {
  const reported = finiteNumber(curr.speed_kmh ?? prev.speed_kmh);
  if (reported != null) return Math.max(0, reported);
  return durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0;
};

const collectStops = (segments = []) => {
  const stops = [];
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
  if (!clean.length) return { index: 0, point: null, heading: 0 };
  if (clean.length === 1) return { index: 0, point: clean[0], heading: Number(clean[0].heading ?? clean[0].bearing ?? 0) || 0 };

  const firstMs = pointTimeMs(clean[0]);
  if (firstMs == null) {
    const fallbackIndex = Math.max(0, Math.min(clean.length - 1, Math.round(elapsedSeconds)));
    return { index: fallbackIndex, point: clean[fallbackIndex], heading: 0 };
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
