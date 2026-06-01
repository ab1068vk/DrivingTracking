import { calculateSegmentMetrics, cleanRoutePoints } from '@/lib/gps/math';
import { HARSH_EVENT_TYPES, EXCLUDED_PROXY_EVENT_TYPES } from '@/lib/routeRisk/constants';
import {
  boundsForPoint,
  cellKeyForPoint,
  cellKeysForBounds,
} from '@/lib/routeRisk/grid';
import { finiteCoord, isNearPrivacyZone, isPrivacyMaskedPoint } from '@/lib/routeRisk/privacy';
import { scoreRouteRiskCell } from '@/lib/routeRisk/scoring';
import { isRouteRiskHash, routeRiskLookupPrefixForHash, segmentKey } from '@/lib/routeRisk/segmentKey';

const pointMetadataKey = (point) => {
  const lat = finiteCoord(point?.lat ?? point?.coords?.latitude);
  const lng = finiteCoord(point?.lng ?? point?.coords?.longitude);
  const timestampValue = point?.timestamp ?? point?.time;
  const timestamp = timestampValue ? new Date(timestampValue).getTime() : NaN;
  return `${lat ?? ''},${lng ?? ''},${Number.isFinite(timestamp) ? timestamp : ''}`;
};

const cleanRoutePointsWithPrivacyMetadata = (routePoints = []) => {
  const metadataByKey = new Map();
  for (const rawPoint of routePoints || []) {
    if (finiteCoord(rawPoint?.lat ?? rawPoint?.coords?.latitude) == null ||
      finiteCoord(rawPoint?.lng ?? rawPoint?.coords?.longitude) == null) {
      continue;
    }
    const key = pointMetadataKey(rawPoint);
    const bucket = metadataByKey.get(key) || [];
    bucket.push(rawPoint);
    metadataByKey.set(key, bucket);
  }

  return cleanRoutePoints(routePoints).map((point) => {
    const bucket = metadataByKey.get(pointMetadataKey(point));
    const rawPoint = bucket?.shift();
    return rawPoint ? { ...point, ...rawPoint } : point;
  });
};

export { segmentKey };

const createCell = (key) => {
  return {
    key,
    tripCount: 0,
    totalEvents: 0,
    eventTypes: {},
    speedSum: 0,
    avgSpeed: 0,
    harshCount: 0,
    riskScore: 0,
    riskLevel: 'low',
  };
};

const touchCell = (cells, key) => {
  const existing = cells.get(key);
  if (existing) return existing;
  const cell = createCell(key);
  cells.set(key, cell);
  return cell;
};

const sanitizePrecomputedCell = (cell = {}) => {
  const key = isRouteRiskHash(cell.key)
    ? cell.key
    : cellKeyForPoint(cell.lat, cell.lng) || String(cell.key || '');
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

const addSegmentToCells = (cells, prev, curr, privacyZones, visitedSegmentCells) => {
  const prevLat = finiteCoord(prev?.lat);
  const prevLng = finiteCoord(prev?.lng);
  const currLat = finiteCoord(curr?.lat);
  const currLng = finiteCoord(curr?.lng);
  if (prevLat == null || prevLng == null || currLat == null || currLng == null) return;
  if (isPrivacyMaskedPoint(prev) || isPrivacyMaskedPoint(curr)) return;

  const midpoint = {
    lat: (prevLat + currLat) / 2,
    lng: (prevLng + currLng) / 2,
  };
  if (isNearPrivacyZone(midpoint.lat, midpoint.lng, privacyZones)) return;

  const segment = calculateSegmentMetrics(prev, curr);
  const key = segmentKey(prevLat, prevLng, currLat, currLng);
  if (!key) return;
  const cell = touchCell(cells, key);
  if (!visitedSegmentCells.has(key)) {
    visitedSegmentCells.add(key);
    cell.tripCount += 1;
    cell.speedSum += Number(segment.reliableSpeedKmh) || 0;
  }
};

const addEventToCells = (cells, event) => {
  if (event?.diagnostic_only === true || EXCLUDED_PROXY_EVENT_TYPES.has(event?.type)) return;
  const lat = Number(event?.lat);
  const lng = Number(event?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const key = cellKeyForPoint(lat, lng) || cellKeysForBounds(boundsForPoint(lat, lng, 0))[0];
  if (!key) return;
  const cell = touchCell(cells, key);
  cell.totalEvents += 1;
  cell.eventTypes[event.type] = (cell.eventTypes[event.type] || 0) + 1;
  if (HARSH_EVENT_TYPES.has(event.type)) cell.harshCount += 1;
};

export function buildRouteRiskCellsForTrip(trip = {}, privacyZones = [], options = {}) {
  if (trip?.status !== 'completed') return [];
  if (options.preferExisting !== false && Array.isArray(trip.route_risk_cells) && trip.route_risk_cells.length) {
    return trip.route_risk_cells.map(sanitizePrecomputedCell).filter((cell) => cell.key);
  }

  const points = cleanRoutePointsWithPrivacyMetadata(trip.route_points || []);
  if (points.length < 2) return [];

  const cells = new Map();
  const visitedSegmentCells = new Set();
  for (let index = 1; index < points.length; index++) {
    addSegmentToCells(cells, points[index - 1], points[index], privacyZones, visitedSegmentCells);
  }
  for (const event of trip.driving_events || []) {
    addEventToCells(cells, event);
  }

  return [...cells.values()].map(scoreRouteRiskCell);
}
