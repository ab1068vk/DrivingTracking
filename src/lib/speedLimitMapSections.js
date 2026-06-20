import { geohashCenter, geohashEncode } from '@/lib/localSpeedKnowledge';
import { isPublicPoint } from '@/lib/roadSectionIdentity';

const pointRoadName = (point = {}) => String(point.speed_limit_road_name || '').trim();
const pointSource = (point = {}) => point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? null;
const pointLimit = (point = {}) => {
  const limit = Number(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);
  return Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
};

const mode = (values = []) => {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
};

const numberMode = (values = []) => {
  const counts = new Map();
  for (const value of values.filter((item) => Number.isFinite(Number(item)))) {
    const rounded = Math.round(Number(value));
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
};

const cleanGeometry = (points = []) => points
  .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
  .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

const sectionCandidate = (geohash, points, tripId) => {
  const geometry = cleanGeometry(points);
  if (!geometry.length) return null;
  const center = geometry[Math.floor(geometry.length / 2)];
  return {
    geohash,
    lat: center.lat,
    lng: center.lng,
    sectionPoints: geometry,
    roadName: mode(points.map(pointRoadName)),
    observedLimitKmh: numberMode(points.map(pointLimit)),
    observedSources: [...new Set(points.map(pointSource).filter(Boolean))].sort(),
    tripId,
    sampleCount: geometry.length,
  };
};

function conflictFor(correction, candidate) {
  const savedLimit = Number(correction?.limitKmh);
  const observedLimit = Number(candidate?.observedLimitKmh);
  if (!Number.isFinite(savedLimit) || !Number.isFinite(observedLimit)) return null;
  const deltaKmh = Math.abs(Math.round(savedLimit) - Math.round(observedLimit));
  if (deltaKmh <= 10) return null;
  return {
    savedLimitKmh: Math.round(savedLimit),
    observedLimitKmh: Math.round(observedLimit),
    deltaKmh,
    sources: candidate?.observedSources || [],
    tripId: candidate?.tripId || null,
  };
}

export function buildSplitCorrections(section = {}, splitIndex = null) {
  const points = cleanGeometry(section.sectionPoints || []);
  if (points.length < 3) return [];
  const index = Number.isInteger(splitIndex)
    ? Math.max(1, Math.min(points.length - 2, splitIndex))
    : Math.floor(points.length / 2);
  const halves = [
    points.slice(0, index + 1),
    points.slice(index),
  ].filter((part) => part.length >= 2);

  return halves.map((sectionPoints, partIndex) => {
    const center = sectionPoints[Math.floor(sectionPoints.length / 2)];
    return {
      ...section,
      geohash: geohashEncode(center.lat, center.lng),
      lat: center.lat,
      lng: center.lng,
      sectionPoints,
      contextLabel: `Split from ${section.roadName || section.geohash || 'saved road section'}`,
      note: section.note || '',
      splitPart: partIndex + 1,
    };
  });
}

export function speedLimitColor(limitKmh) {
  const limit = Number(limitKmh);
  if (!Number.isFinite(limit) || limit <= 0) return '#94a3b8';
  if (limit <= 30) return '#14b8a6';
  if (limit <= 40) return '#22c55e';
  if (limit <= 50) return '#84cc16';
  if (limit <= 60) return '#eab308';
  if (limit <= 80) return '#f97316';
  if (limit <= 100) return '#ef4444';
  return '#a855f7';
}

export function buildSpeedMapSections(trips = [], corrections = []) {
  const candidates = new Map();

  for (const trip of trips || []) {
    if (trip?.status && trip.status !== 'completed') continue;
    const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
    let currentHash = '';
    let currentPoints = [];

    const flush = () => {
      if (!currentHash || !currentPoints.length) return;
      const candidate = sectionCandidate(currentHash, currentPoints, trip?.id);
      if (candidate && candidate.sampleCount > (candidates.get(currentHash)?.sampleCount || 0)) {
        candidates.set(currentHash, candidate);
      }
    };

    for (const point of points) {
      if (!isPublicPoint(point)) {
        flush();
        currentHash = '';
        currentPoints = [];
        continue;
      }
      const geohash = geohashEncode(point.lat, point.lng);
      if (geohash !== currentHash) {
        flush();
        currentHash = geohash;
        currentPoints = [point];
      } else {
        currentPoints.push(point);
      }
    }
    flush();
  }

  const correctionByHash = new Map((corrections || []).map((row) => [row.geohash, row]));
  const hashes = new Set([...candidates.keys(), ...correctionByHash.keys()]);

  return [...hashes].map((geohash) => {
    const candidate = candidates.get(geohash);
    const correction = correctionByHash.get(geohash);
    const savedGeometry = cleanGeometry(correction?.sectionPoints);
    const center = geohashCenter(geohash);
    const sectionPoints = savedGeometry.length >= 2
      ? savedGeometry
      : candidate?.sectionPoints || savedGeometry;
    const savedLimitKmh = Number(correction?.limitKmh);
    const observedLimitKmh = Number(candidate?.observedLimitKmh);
    const effectiveLimitKmh = Number.isFinite(savedLimitKmh) && savedLimitKmh > 0
      ? Math.round(savedLimitKmh)
      : Number.isFinite(observedLimitKmh) && observedLimitKmh > 0
        ? Math.round(observedLimitKmh)
        : null;
    return {
      ...candidate,
      ...correction,
      geohash,
      lat: Number(correction?.lat ?? candidate?.lat ?? center.lat),
      lng: Number(correction?.lng ?? candidate?.lng ?? center.lng),
      sectionPoints,
      roadName: correction?.roadName || candidate?.roadName || '',
      saved: Boolean(correction),
      limitKmh: correction?.limitKmh ?? null,
      effectiveLimitKmh,
      source: correction?.source ?? null,
      conflict: conflictFor(correction, candidate),
    };
  }).sort((a, b) => {
    if (a.saved !== b.saved) return a.saved ? -1 : 1;
    return String(a.roadName || a.geohash).localeCompare(String(b.roadName || b.geohash));
  });
}
