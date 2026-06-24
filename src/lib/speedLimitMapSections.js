import { geohashCenter, geohashEncode } from '@/lib/localSpeedKnowledge';
import { isPublicPoint } from '@/lib/roadSectionIdentity';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import { measureSync } from '@/lib/performanceTriage';

const pointRoadName = (point = {}) => String(point.speed_limit_road_name || '').trim();
const pointSource = (point = {}) => point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? null;
const CONFIRMED_LIMIT_SOURCES = new Set([
  'openstreetmap',
  'user_confirmed_posted_sign',
]);
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

const limitGeometryPoints = (points = [], maxPoints = 80) => {
  const geometry = cleanGeometry(points);
  if (geometry.length <= maxPoints) return geometry;
  const lastIndex = geometry.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => (
    geometry[Math.round((index / (maxPoints - 1)) * lastIndex)]
  )).filter((point, index, sampled) => (
    index === 0 || point.lat !== sampled[index - 1].lat || point.lng !== sampled[index - 1].lng
  ));
};

const distanceMeters = (a, b) => {
  const lat1 = Number(a?.lat) * Math.PI / 180;
  const lat2 = Number(b?.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (Number(b?.lng) - Number(a?.lng)) * Math.PI / 180;
  if (![lat1, lat2, dLat, dLng].every(Number.isFinite)) return Infinity;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const interpolatePoint = (start, end, ratio) => ({
  lat: Number(start.lat) + (Number(end.lat) - Number(start.lat)) * ratio,
  lng: Number(start.lng) + (Number(end.lng) - Number(start.lng)) * ratio,
});

const samePoint = (a, b) => (
  Math.abs(Number(a?.lat) - Number(b?.lat)) < 1e-9 &&
  Math.abs(Number(a?.lng) - Number(b?.lng)) < 1e-9
);

const splitGeometryAtMidpoint = (points = []) => {
  const geometry = cleanGeometry(points);
  if (geometry.length < 2) return [];
  const segmentLengths = geometry.map((point, index) => (
    index === 0 ? 0 : distanceMeters(geometry[index - 1], point)
  ));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(totalLength) || totalLength <= 0) return [];

  const target = totalLength / 2;
  let travelled = 0;
  for (let index = 1; index < geometry.length; index++) {
    const segmentLength = segmentLengths[index];
    if (travelled + segmentLength < target) {
      travelled += segmentLength;
      continue;
    }
    const ratio = segmentLength > 0 ? (target - travelled) / segmentLength : 0;
    const midpoint = interpolatePoint(geometry[index - 1], geometry[index], Math.max(0, Math.min(1, ratio)));
    const first = geometry.slice(0, index);
    if (!samePoint(first.at(-1), midpoint)) first.push(midpoint);
    const second = geometry.slice(index);
    if (!samePoint(second[0], midpoint)) second.unshift(midpoint);
    return [first, second].filter((part) => part.length >= 2);
  }
  return [];
};

const normalizedRoadName = (value) => String(value || '').trim().toLowerCase();

export function snapSectionPointsToTripRoutes(sectionPoints = [], trips = [], maxDistanceM = 80) {
  return snapSectionPointsToTripRoutesWithStats(sectionPoints, trips, maxDistanceM).points;
}

export function snapSectionPointsToTripRoutesWithStats(sectionPoints = [], trips = [], maxDistanceM = 80) {
  const routePoints = (trips || [])
    .flatMap((trip) => Array.isArray(trip?.route_points) ? trip.route_points : [])
    .filter(isPublicPoint)
    .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  const originalPoints = cleanGeometry(sectionPoints);
  if (!routePoints.length) {
    return {
      points: originalPoints,
      changedCount: 0,
      snappedCount: 0,
      maxMoveM: 0,
      averageMoveM: 0,
      routePointCount: 0,
    };
  }

  let changedCount = 0;
  let snappedCount = 0;
  let totalMoveM = 0;
  let maxMoveM = 0;
  const points = originalPoints.map((point) => {
    let nearest = null;
    let nearestDistanceM = Infinity;
    for (const routePoint of routePoints) {
      const candidateDistanceM = distanceMeters(point, routePoint);
      if (candidateDistanceM < nearestDistanceM) {
        nearest = routePoint;
        nearestDistanceM = candidateDistanceM;
      }
    }
    if (!nearest || nearestDistanceM > maxDistanceM) return point;
    snappedCount += 1;
    const changed = !samePoint(point, nearest);
    if (changed) changedCount += 1;
    totalMoveM += nearestDistanceM;
    maxMoveM = Math.max(maxMoveM, nearestDistanceM);
    return nearest;
  });
  return {
    points,
    changedCount,
    snappedCount,
    maxMoveM: Math.round(maxMoveM),
    averageMoveM: snappedCount ? Math.round(totalMoveM / snappedCount) : 0,
    routePointCount: routePoints.length,
  };
}

export function findMergeableSpeedSection(section = {}, sections = [], maxDistanceM = 150) {
  const sectionPoints = cleanGeometry(section.sectionPoints || []);
  if (!section.saved || sectionPoints.length < 2) return null;
  const roadName = normalizedRoadName(section.roadName);
  const endpoints = [sectionPoints[0], sectionPoints.at(-1)];
  return (sections || [])
    .filter((candidate) => (
      candidate.saved &&
      (candidate.sectionKey || candidate.geohash) !== (section.sectionKey || section.geohash)
    ))
    .filter((candidate) => Number(candidate.limitKmh) === Number(section.limitKmh))
    .filter((candidate) => {
      const candidateRoad = normalizedRoadName(candidate.roadName);
      return !roadName || !candidateRoad || candidateRoad === roadName;
    })
    .map((candidate) => {
      const candidatePoints = cleanGeometry(candidate.sectionPoints || []);
      if (candidatePoints.length < 2) return null;
      const candidateEndpoints = [candidatePoints[0], candidatePoints.at(-1)];
      const distanceM = Math.min(...endpoints.flatMap((point) => (
        candidateEndpoints.map((candidatePoint) => distanceMeters(point, candidatePoint))
      )));
      return { candidate, distanceM };
    })
    .filter((result) => result && result.distanceM <= maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM)[0] || null;
}

export function mergeSpeedSections(first = {}, second = {}) {
  const firstPoints = cleanGeometry(first.sectionPoints || []);
  const secondPoints = cleanGeometry(second.sectionPoints || []);
  if (firstPoints.length < 2 || secondPoints.length < 2) return null;
  const options = [
    [firstPoints, secondPoints],
    [[...firstPoints].reverse(), secondPoints],
    [firstPoints, [...secondPoints].reverse()],
    [[...firstPoints].reverse(), [...secondPoints].reverse()],
  ];
  const [left, right] = options.sort((a, b) => (
    distanceMeters(a[0].at(-1), a[1][0]) - distanceMeters(b[0].at(-1), b[1][0])
  ))[0];
  const sectionPoints = [...left, ...right].filter((point, index, points) => (
    index === 0 || distanceMeters(point, points[index - 1]) > 2
  )).slice(0, 24);
  const center = sectionPoints[Math.floor(sectionPoints.length / 2)];
  return {
    ...first,
    geohash: geohashEncode(center.lat, center.lng),
    lat: center.lat,
    lng: center.lng,
    roadName: first.roadName || second.roadName || '',
    sectionPoints,
    mergedSelectors: [
      first.id || first.ruleId || first.geohash,
      second.id || second.ruleId || second.geohash,
    ],
    mergedGeohashes: [first.geohash, second.geohash],
  };
}

const sectionCandidate = (geohash, points, tripId) => {
  const geometry = limitGeometryPoints(points);
  if (!geometry.length) return null;
  const center = geometry[Math.floor(geometry.length / 2)];
  const observedLimits = points.map(pointLimit).filter((value) => value != null);
  const confirmedObservedLimits = points
    .filter((point) => CONFIRMED_LIMIT_SOURCES.has(pointSource(point)))
    .map(pointLimit)
    .filter((value) => value != null);
  const observedSources = [...new Set(points.map(pointSource).filter(Boolean))].sort();
  return {
    geohash,
    lat: center.lat,
    lng: center.lng,
    sectionPoints: geometry,
    roadName: mode(points.map(pointRoadName)),
    observedLimitKmh: numberMode(observedLimits),
    confirmedObservedLimitKmh: numberMode(confirmedObservedLimits),
    confirmedObservedLimits,
    observedLimits,
    observedSources,
    tripId,
    tripIds: tripId ? [tripId] : [],
    sampleCount: geometry.length,
  };
};

const mergeCandidates = (existing, candidate) => {
  if (!existing) return candidate;
  const observedLimits = [...(existing.observedLimits || []), ...(candidate.observedLimits || [])];
  const confirmedObservedLimits = [
    ...(existing.confirmedObservedLimits || []),
    ...(candidate.confirmedObservedLimits || []),
  ];
  const useCandidateGeometry = candidate.sectionPoints.length > existing.sectionPoints.length;
  return {
    ...existing,
    ...(useCandidateGeometry ? {
      lat: candidate.lat,
      lng: candidate.lng,
      sectionPoints: candidate.sectionPoints,
      tripId: candidate.tripId,
    } : {}),
    roadName: existing.roadName || candidate.roadName,
    observedLimits,
    observedLimitKmh: numberMode(observedLimits),
    confirmedObservedLimits,
    confirmedObservedLimitKmh: numberMode(confirmedObservedLimits),
    observedSources: [...new Set([
      ...(existing.observedSources || []),
      ...(candidate.observedSources || []),
    ])].sort(),
    tripIds: [...new Set([...(existing.tripIds || []), ...(candidate.tripIds || [])])],
    sampleCount: (Number(existing.sampleCount) || 0) + (Number(candidate.sampleCount) || 0),
  };
};

function conflictFor(correction, candidate) {
  const savedLimit = Number(correction?.limitKmh);
  const observedLimit = Number(candidate?.confirmedObservedLimitKmh);
  if (
    !Number.isFinite(savedLimit) ||
    savedLimit <= 0 ||
    !Number.isFinite(observedLimit) ||
    observedLimit <= 0
  ) return null;
  const deltaKmh = Math.abs(Math.round(savedLimit) - Math.round(observedLimit));
  if (deltaKmh <= 10) return null;
  const resolution = correction?.conflictResolution;
  if (
    resolution &&
    Math.round(Number(resolution.savedLimitKmh)) === Math.round(savedLimit) &&
    Math.round(Number(resolution.observedLimitKmh)) === Math.round(observedLimit) &&
    Math.round(Number(resolution.deltaKmh)) === deltaKmh
  ) {
    return null;
  }
  return {
    savedLimitKmh: Math.round(savedLimit),
    observedLimitKmh: Math.round(observedLimit),
    deltaKmh,
    sources: candidate?.observedSources || [],
    evidenceKind: 'confirmed_limit',
    tripId: candidate?.tripId || null,
  };
}

/** @returns {any[]} */
export function buildSplitCorrections(section = {}, splitIndex = null) {
  const points = cleanGeometry(section.sectionPoints || []);
  if (points.length < 2) return [];
  const halves = Number.isInteger(splitIndex) && points.length >= 3
    ? [
      points.slice(0, Math.max(1, Math.min(points.length - 2, splitIndex)) + 1),
      points.slice(Math.max(1, Math.min(points.length - 2, splitIndex))),
    ].filter((part) => part.length >= 2)
    : splitGeometryAtMidpoint(points);

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

export const SPEED_MAP_LAYER_DEFAULTS = {
  conflicts: true,
  saved: true,
  observed: true,
  unset: true,
};

function hasSpeedLimit(section = {}) {
  const limit = Number(section.effectiveLimitKmh ?? section.limitKmh ?? section.observedLimitKmh);
  return Number.isFinite(limit) && limit > 0;
}

function sectionLayer(section = {}) {
  if (section.conflict) return 'conflicts';
  if (section.saved) return 'saved';
  if (hasSpeedLimit(section)) return 'observed';
  return 'unset';
}

function normalizedSearchText(section = {}) {
  return [
    section.geohash,
    section.roadName,
    section.source,
    section.tripId,
    section.limitKmh,
    section.observedLimitKmh,
    section.effectiveLimitKmh,
    ...(section.observedSources || []),
  ].filter((value) => value != null && value !== '').join(' ').toLowerCase();
}

export function summarizeSpeedMapSections(sections = []) {
  return (sections || []).reduce((summary, section) => {
    const layer = sectionLayer(section);
    summary.total += 1;
    summary[layer] += 1;
    if (section.saved) summary.savedRules += 1;
    if (!section.saved && hasSpeedLimit(section)) summary.observedOnly += 1;
    return summary;
  }, {
    total: 0,
    conflicts: 0,
    saved: 0,
    observed: 0,
    unset: 0,
    savedRules: 0,
    observedOnly: 0,
  });
}

export function filterSpeedMapSections(sections = [], {
  query = '',
  layers = SPEED_MAP_LAYER_DEFAULTS,
} = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const layerState = { ...SPEED_MAP_LAYER_DEFAULTS, ...(layers || {}) };
  return (sections || [])
    .filter((section) => layerState[sectionLayer(section)] !== false)
    .filter((section) => !normalizedQuery || normalizedSearchText(section).includes(normalizedQuery));
}

export function buildSpeedMapSections(trips = [], corrections = []) {
  return measureSync('buildSpeedMapSections', () => buildSpeedMapSectionsInternal(trips, corrections), {
    tripCount: trips?.length || 0,
    correctionCount: corrections?.length || 0,
    routePointCount: (trips || []).reduce((sum, trip) => sum + (trip?.route_points?.length || 0), 0),
  });
}

function buildSpeedMapSectionsInternal(trips = [], corrections = []) {
  const candidates = new Map();

  for (const trip of trips || []) {
    if (trip?.status && trip.status !== 'completed') continue;
    const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
    let currentHash = '';
    let currentPoints = [];

    const flush = () => {
      if (!currentHash || !currentPoints.length) return;
      const candidate = sectionCandidate(currentHash, currentPoints, trip?.id);
      if (candidate) candidates.set(currentHash, mergeCandidates(candidates.get(currentHash), candidate));
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

  const correctionsByHash = new Map();
  for (const correction of corrections || []) {
    const items = correctionsByHash.get(correction.geohash) || [];
    items.push(correction);
    correctionsByHash.set(correction.geohash, items);
  }
  const hashes = new Set([...candidates.keys(), ...correctionsByHash.keys()]);
  const entries = [...hashes].flatMap((geohash) => {
    const savedCorrections = correctionsByHash.get(geohash) || [];
    return savedCorrections.length
      ? savedCorrections.map((correction) => ({ geohash, correction }))
      : [{ geohash, correction: null }];
  });

  return entries.map(({ geohash, correction }) => {
    const candidate = candidates.get(geohash);
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
    const observedEvidence = assessSpeedLimitEvidence({
      source: candidate?.observedSources?.[0] || 'unknown',
      sampleCount: candidate?.sampleCount,
    });
    const savedEvidence = correction
      ? assessSpeedLimitEvidence(correction)
      : null;
    return {
      ...candidate,
      ...correction,
      geohash,
      sectionKey: correction?.id || correction?.ruleId || geohash,
      lat: Number(correction?.lat ?? candidate?.lat ?? center.lat),
      lng: Number(correction?.lng ?? candidate?.lng ?? center.lng),
      sectionPoints,
      roadName: correction?.roadName || candidate?.roadName || '',
      saved: Boolean(correction),
      limitKmh: correction?.limitKmh ?? null,
      effectiveLimitKmh,
      source: correction?.source ?? null,
      conflict: conflictFor(correction, candidate),
      observedEvidence,
      savedEvidence,
      confidence: savedEvidence?.confidence ?? observedEvidence.confidence,
      confidenceLevel: savedEvidence?.level ?? observedEvidence.level,
      affectedTripCount: candidate?.tripIds?.length || 0,
    };
  }).sort((a, b) => {
    if (a.saved !== b.saved) return a.saved ? -1 : 1;
    return String(a.roadName || a.geohash).localeCompare(String(b.roadName || b.geohash));
  });
}
