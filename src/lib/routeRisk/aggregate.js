import { cleanRoutePoints } from '@/lib/gps/math';
import { ROUTE_RISK_PRIVACY_ZONE_GUARD_M, ROUTE_RISK_SNAP_DISTANCE_M } from '@/lib/routeRisk/constants';
import {
  boundsForPoint,
  boundsForSegment,
  cellBoundsFromKey,
  cellCenterFromKey,
  cellKeyForPoint,
  cellKeysForBounds,
  expandBounds,
  intersectsBounds,
} from '@/lib/routeRisk/grid';
import { finiteCoord, isNearPrivacyZone } from '@/lib/routeRisk/privacy';
import { dominantEventType, scoreRouteRiskCell } from '@/lib/routeRisk/scoring';
import { isRouteRiskHash, routeRiskLookupPrefixForHash } from '@/lib/routeRisk/segmentKey';
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

const routeRiskKeyForCell = (cell = {}, fallbackKey = '') => {
  const explicitKey = cell.key || fallbackKey;
  if (isRouteRiskHash(explicitKey)) return String(explicitKey);

  const lat = finiteCoord(cell.lat);
  const lng = finiteCoord(cell.lng);
  if (lat != null && lng != null) return cellKeyForPoint(lat, lng);

  const legacyCenter = cellCenterFromKey(explicitKey);
  return legacyCenter ? cellKeyForPoint(legacyCenter.lat, legacyCenter.lng) : String(explicitKey || '');
};

export const sanitizeRouteRiskCellForStorage = (cell = {}, fallbackKey = '') => {
  const key = routeRiskKeyForCell(cell, fallbackKey);
  const {
    lat,
    lng,
    bounds,
    segmentKeys,
    ...rest
  } = cell;
  return {
    ...rest,
    key,
    cellHash: key,
    lookupHash: isRouteRiskHash(key) ? routeRiskLookupPrefixForHash(key) : undefined,
  };
};

const cellOverlapsPrivacyZone = (cell = {}, privacyZones = []) => {
  const lat = finiteCoord(cell.lat);
  const lng = finiteCoord(cell.lng);
  if (lat != null && lng != null && isNearPrivacyZone(lat, lng, privacyZones)) return true;

  const cellBounds = cell.bounds || cellBoundsFromKey(cell.key);
  if (!cellBounds) return false;

  return (privacyZones || []).some((zone) => {
    const zoneLat = finiteCoord(zone?.lat);
    const zoneLng = finiteCoord(zone?.lng);
    const radiusM = Number(zone?.radius_m);
    if (zoneLat == null || zoneLng == null || !Number.isFinite(radiusM) || radiusM <= 0) return false;
    const zoneBounds = boundsForPoint(zoneLat, zoneLng, radiusM + ROUTE_RISK_PRIVACY_ZONE_GUARD_M);
    return zoneBounds ? intersectsBounds(cellBounds, zoneBounds) : false;
  });
};

export const mergeCellIntoIndex = (index, cell) => {
  if (!cell?.key) return index;
  const normalized = sanitizeRouteRiskCellForStorage(cell);
  const existing = index.get(normalized.key);
  if (!existing) {
    index.set(normalized.key, scoreRouteRiskCell({ ...normalized }));
    return index;
  }

  index.set(normalized.key, scoreRouteRiskCell({
    ...existing,
    tripCount: (existing.tripCount || 0) + (normalized.tripCount || 0),
    totalEvents: (existing.totalEvents || 0) + (normalized.totalEvents || 0),
    harshCount: (existing.harshCount || 0) + (normalized.harshCount || 0),
    speedSum: (existing.speedSum || 0) + (normalized.speedSum || 0),
    eventTypes: mergeEventTypes(existing.eventTypes, normalized.eventTypes),
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
    const keyedItem = { ...item, key: item?.key || key };
    if (cellOverlapsPrivacyZone(keyedItem, privacyZones)) continue;

    const cellKey = routeRiskKeyForCell(item, key);
    mergeCellIntoIndex(compacted, sanitizeRouteRiskCellForStorage({ ...item, key: cellKey }));
  }
  return compacted;
}

export function getRouteRiskCellsForBounds(index = new Map(), bounds = {}) {
  const queryBounds = expandBounds(bounds, ROUTE_RISK_SNAP_DISTANCE_M);
  if (!queryBounds) return [];

  const seen = new Set();
  const cells = [];
  const lookupKeys = cellKeysForBounds(queryBounds);
  for (const [key, cell] of index.entries()) {
    if (!cell || seen.has(key)) continue;
    const cellKey = cell.key || key;
    const matchesLookup = lookupKeys.some((lookupKey) => (
      cellKey === lookupKey ||
      String(cellKey).startsWith(String(lookupKey)) ||
      String(lookupKey).startsWith(String(cellKey))
    ));
    if (!matchesLookup) continue;

    const cellBounds = cell.bounds || cellBoundsFromKey(cellKey);
    if (cellBounds && !intersectsBounds(cellBounds, queryBounds)) continue;
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
