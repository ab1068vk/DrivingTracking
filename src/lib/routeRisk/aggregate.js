import { cleanRoutePoints, haversineDistance } from '@/lib/gps/math';
import { ROUTE_RISK_SNAP_DISTANCE_M } from '@/lib/routeRisk/constants';
import {
  boundsForPoint,
  boundsForSegment,
  cellKeyForPoint,
  cellKeysForBounds,
  expandBounds,
  intersectsBounds,
} from '@/lib/routeRisk/grid';
import { finiteCoord, isNearPrivacyZone } from '@/lib/routeRisk/privacy';
import { dominantEventType, scoreRouteRiskCell } from '@/lib/routeRisk/scoring';
import { buildRouteRiskCellsForTrip } from '@/lib/routeRisk/tripCells';

export const createRouteRiskIndexMap = (entries = [], metadata = {}) => {
  const map = new Map(entries);
  Object.defineProperty(map, 'metadata', {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  return map;
};

const normalizeTripIds = (metadata = {}) => new Set(
  Array.isArray(metadata.indexedTripIds) ? metadata.indexedTripIds.map(String) : []
);

const mergeEventTypes = (left = {}, right = {}) => {
  const merged = { ...left };
  for (const [type, count] of Object.entries(right || {})) {
    merged[type] = (merged[type] || 0) + count;
  }
  return merged;
};

export const mergeCellIntoIndex = (index, cell) => {
  if (!cell?.key) return index;
  const existing = index.get(cell.key);
  if (!existing) {
    index.set(cell.key, scoreRouteRiskCell({ ...cell }));
    return index;
  }

  index.set(cell.key, scoreRouteRiskCell({
    ...existing,
    tripCount: (existing.tripCount || 0) + (cell.tripCount || 0),
    totalEvents: (existing.totalEvents || 0) + (cell.totalEvents || 0),
    harshCount: (existing.harshCount || 0) + (cell.harshCount || 0),
    speedSum: (existing.speedSum || 0) + (cell.speedSum || 0),
    eventTypes: mergeEventTypes(existing.eventTypes, cell.eventTypes),
    segmentKeys: mergeEventTypes(existing.segmentKeys, cell.segmentKeys),
  }));
  return index;
};

export function mergeRouteRiskTripIntoIndexMap(index = createRouteRiskIndexMap(), trip = {}, privacyZones = []) {
  if (trip?.status !== 'completed') return index;
  const tripId = trip.id == null ? null : String(trip.id);
  const indexedTripIds = normalizeTripIds(index.metadata);
  if (tripId && indexedTripIds.has(tripId)) return index;

  for (const cell of buildRouteRiskCellsForTrip(trip, privacyZones)) {
    mergeCellIntoIndex(index, cell);
  }
  if (tripId) indexedTripIds.add(tripId);
  Object.defineProperty(index, 'metadata', {
    value: {
      ...(index.metadata || {}),
      indexedTripIds: [...indexedTripIds],
      updatedAt: new Date().toISOString(),
    },
    enumerable: false,
    configurable: true,
  });
  return index;
}

export function buildRouteRiskIndexFromTrips(trips = [], privacyZones = []) {
  const index = createRouteRiskIndexMap();
  for (const trip of trips || []) {
    mergeRouteRiskTripIntoIndexMap(index, trip, privacyZones);
  }
  return index;
}

export function compactRouteRiskIndex(index = createRouteRiskIndexMap(), privacyZones = []) {
  const compacted = createRouteRiskIndexMap([], index.metadata || {});
  for (const [key, item] of index.entries()) {
    const hasCenter = Number.isFinite(Number(item?.lat)) && Number.isFinite(Number(item?.lng));
    if (hasCenter && isNearPrivacyZone(item.lat, item.lng, privacyZones)) continue;
    const cellKey = item.key || key;
    const nearby = hasCenter && !item.bounds && !String(cellKey).includes(':')
      ? [...compacted.values()].find((candidate) => (
        Number.isFinite(Number(candidate?.lat)) &&
        Number.isFinite(Number(candidate?.lng)) &&
        haversineDistance(item.lat, item.lng, candidate.lat, candidate.lng) * 1000 <= ROUTE_RISK_SNAP_DISTANCE_M
      ))
      : null;
    mergeCellIntoIndex(compacted, { ...item, key: nearby?.key || cellKey });
  }
  return compacted;
}

export function getRouteRiskCellsForBounds(index = new Map(), bounds = {}) {
  const queryBounds = expandBounds(bounds, ROUTE_RISK_SNAP_DISTANCE_M);
  if (!queryBounds) return [];

  const seen = new Set();
  const cells = [];
  for (const key of cellKeysForBounds(queryBounds)) {
    const cell = index.get(key);
    if (!cell || seen.has(key)) continue;
    if (cell.bounds && !intersectsBounds(cell.bounds, queryBounds)) continue;
    seen.add(key);
    cells.push(cell);
  }
  return cells;
}

export function getRouteRiskCellsNearPoint(index = new Map(), lat, lng, radiusM = ROUTE_RISK_SNAP_DISTANCE_M) {
  const bounds = boundsForPoint(lat, lng, radiusM);
  return bounds ? getRouteRiskCellsForBounds(index, bounds) : [];
}

export function getSegmentsForTrip(trip, riskIndex = new Map()) {
  const points = cleanRoutePoints(trip?.route_points || []);
  const segments = [];

  for (let i = 1; i < points.length; i++) {
    const prevLat = finiteCoord(points[i - 1]?.lat);
    const prevLng = finiteCoord(points[i - 1]?.lng);
    const currLat = finiteCoord(points[i]?.lat);
    const currLng = finiteCoord(points[i]?.lng);
    if (prevLat == null || prevLng == null || currLat == null || currLng == null) continue;

    const segmentBounds = expandBounds(boundsForSegment(prevLat, prevLng, currLat, currLng), ROUTE_RISK_SNAP_DISTANCE_M);
    const midpointKey = cellKeyForPoint((prevLat + currLat) / 2, (prevLng + currLng) / 2);
    const directCell = midpointKey ? riskIndex.get(midpointKey) : null;
    const candidates = directCell ? [directCell] : getRouteRiskCellsForBounds(riskIndex, segmentBounds);
    const risk = candidates
      .filter((candidate) => Number(candidate?.tripCount) >= 2)
      .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0))[0];
    if (!risk) continue;

    segments.push({
      from: { lat: points[i - 1].lat, lng: points[i - 1].lng },
      to: { lat: points[i].lat, lng: points[i].lng },
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      tripCount: risk.tripCount,
      totalEvents: risk.totalEvents,
      dominantEventType: dominantEventType(risk.eventTypes),
    });
  }
  return segments;
}
