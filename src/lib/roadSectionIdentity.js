import { geohashEncode } from '@/lib/localSpeedKnowledge';

const MAX_SECTION_POINTS = 24;
const CONTEXT_SCAN_POINTS = 40;
const NULL_ISLAND_EPSILON = 0.001;

const isPublicPoint = (point = {}) => {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(Math.abs(lat) < NULL_ISLAND_EPSILON && Math.abs(lng) < NULL_ISLAND_EPSILON) &&
    point.privacy_export_placeholder !== true &&
    point.masked_for_privacy !== true &&
    point.privacy_gap !== true &&
    point.privacy_live_redacted !== true;
};

const pointRoadName = (point = {}) => String(point.speed_limit_road_name || '').trim();

const mode = (values = []) => {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
};

const radians = (value) => value * Math.PI / 180;

const distanceKm = (a, b) => {
  const dLat = radians(Number(b.lat) - Number(a.lat));
  const dLng = radians(Number(b.lng) - Number(a.lng));
  const lat1 = radians(Number(a.lat));
  const lat2 = radians(Number(b.lat));
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const bearingDegrees = (a, b) => {
  const lat1 = radians(Number(a.lat));
  const lat2 = radians(Number(b.lat));
  const deltaLng = radians(Number(b.lng) - Number(a.lng));
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const directionLabel = (bearing) => {
  const directions = ['northbound', 'northeast-bound', 'eastbound', 'southeast-bound', 'southbound', 'southwest-bound', 'westbound', 'northwest-bound'];
  return directions[Math.round(Number(bearing) / 45) % 8] || 'along the route';
};

const formatTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
};

const longestContiguousRun = (indexes = []) => {
  if (!indexes.length) return null;
  let best = [indexes[0], indexes[0]];
  let current = [indexes[0], indexes[0]];
  for (let index = 1; index < indexes.length; index++) {
    if (indexes[index] === indexes[index - 1] + 1) {
      current[1] = indexes[index];
    } else {
      if (current[1] - current[0] > best[1] - best[0]) best = current;
      current = [indexes[index], indexes[index]];
    }
  }
  if (current[1] - current[0] > best[1] - best[0]) best = current;
  return best;
};

const nearbyDifferentRoad = (points, startIndex, step, roadName) => {
  for (
    let index = startIndex, scanned = 0;
    index >= 0 && index < points.length && scanned < CONTEXT_SCAN_POINTS;
    index += step, scanned++
  ) {
    const point = points[index];
    if (!isPublicPoint(point)) break;
    const candidate = pointRoadName(point);
    if (candidate && candidate !== roadName) return candidate;
  }
  return '';
};

const sampleSectionPoints = (points = []) => {
  if (points.length <= MAX_SECTION_POINTS) return points;
  const sampled = [];
  const lastIndex = points.length - 1;
  for (let index = 0; index < MAX_SECTION_POINTS; index++) {
    sampled.push(points[Math.round(index * lastIndex / (MAX_SECTION_POINTS - 1))]);
  }
  return sampled;
};

export function buildRoadSectionIdentity(trip = {}, geohash = '') {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const cellMatches = [];
  points.forEach((point, index) => {
    if (isPublicPoint(point) && geohashEncode(point.lat, point.lng) === geohash) cellMatches.push(index);
  });
  const dominantRoad = mode(cellMatches.map((index) => pointRoadName(points[index])));
  const matches = dominantRoad
    ? cellMatches.filter((index) => pointRoadName(points[index]) === dominantRoad)
    : cellMatches;
  const run = longestContiguousRun(matches);
  if (!run) return null;

  const coreStart = run[0];
  const coreEnd = run[1];
  let displayStart = coreStart;
  let displayEnd = coreEnd;
  for (let count = 0; count < 3 && displayStart > 0 && isPublicPoint(points[displayStart - 1]); count++) displayStart--;
  for (let count = 0; count < 3 && displayEnd < points.length - 1 && isPublicPoint(points[displayEnd + 1]); count++) displayEnd++;

  const corePoints = points.slice(coreStart, coreEnd + 1).filter(isPublicPoint);
  const displayPoints = points.slice(displayStart, displayEnd + 1).filter(isPublicPoint);
  const first = corePoints[0];
  const roadName = dominantRoad || mode(corePoints.map(pointRoadName));
  const beforeRoad = nearbyDifferentRoad(points, coreStart - 1, -1, roadName);
  const afterRoad = nearbyDifferentRoad(points, coreEnd + 1, 1, roadName);
  const direction = displayPoints.length > 1
    ? directionLabel(bearingDegrees(displayPoints[0], displayPoints.at(-1)))
    : 'along the route';
  const timeLabel = formatTime(first?.timestamp ?? first?.recorded_at ?? first?.timestamp_ms);
  const distance = displayPoints.slice(1).reduce(
    (sum, point, index) => sum + distanceKm(displayPoints[index], point),
    0
  );
  const contextParts = [];
  if (beforeRoad) contextParts.push(`after ${beforeRoad}`);
  if (afterRoad) contextParts.push(`before ${afterRoad}`);
  const contextLabel = contextParts.length
    ? contextParts.join(', ')
    : timeLabel
      ? `driven at ${timeLabel}`
      : 'from the recorded trip';

  return {
    roadName,
    title: roadName || 'Unnamed driven road section',
    contextLabel,
    directionLabel: direction,
    timeLabel,
    distanceM: Math.max(0, Math.round(distance * 1000)),
    sampleCount: corePoints.length,
    sampleLat: Number(first.lat),
    sampleLng: Number(first.lng),
    sectionPoints: sampleSectionPoints(displayPoints).map((point) => ({
      lat: Number(point.lat),
      lng: Number(point.lng),
    })),
  };
}

export function correctionSectionIdentity(correction = {}, trip = null) {
  const fromTrip = trip && correction.geohash
    ? buildRoadSectionIdentity(trip, correction.geohash)
    : null;
  if (fromTrip) return fromTrip;
  const sectionPoints = Array.isArray(correction.sectionPoints)
    ? correction.sectionPoints.filter(isPublicPoint).slice(0, MAX_SECTION_POINTS)
    : [];
  return {
    roadName: correction.roadName || '',
    title: correction.roadName || 'Saved driven road area',
    contextLabel: correction.contextLabel || 'Exact road name unavailable',
    directionLabel: correction.directionLabel || 'along the route',
    timeLabel: correction.timeLabel || '',
    distanceM: Number(correction.distanceM) || 0,
    sampleLat: Number(correction.lat),
    sampleLng: Number(correction.lng),
    sectionPoints,
  };
}

export { isPublicPoint };
