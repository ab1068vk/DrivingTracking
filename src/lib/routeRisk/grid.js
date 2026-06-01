import { ROUTE_RISK_CELL_SIZE_M } from '@/lib/routeRisk/constants';

const EARTH_M_PER_DEG = 111320;
const MIN_LNG_COS = 0.01;

export const normalizeBounds = (bounds = {}) => {
  const minLat = Math.min(Number(bounds.minLat), Number(bounds.maxLat));
  const maxLat = Math.max(Number(bounds.minLat), Number(bounds.maxLat));
  const minLng = Math.min(Number(bounds.minLng), Number(bounds.maxLng));
  const maxLng = Math.max(Number(bounds.minLng), Number(bounds.maxLng));
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) return null;
  return { minLat, maxLat, minLng, maxLng };
};

export const boundsForPoint = (lat, lng, radiusM = 0) => {
  const pointLat = Number(lat);
  const pointLng = Number(lng);
  if (!Number.isFinite(pointLat) || !Number.isFinite(pointLng)) return null;
  const latDelta = Math.max(0, Number(radiusM) || 0) / EARTH_M_PER_DEG;
  const lngDelta = latDelta / Math.max(MIN_LNG_COS, Math.cos(pointLat * Math.PI / 180));
  return {
    minLat: pointLat - latDelta,
    maxLat: pointLat + latDelta,
    minLng: pointLng - lngDelta,
    maxLng: pointLng + lngDelta,
  };
};

export const boundsForSegment = (lat1, lng1, lat2, lng2) => normalizeBounds({
  minLat: Math.min(Number(lat1), Number(lat2)),
  maxLat: Math.max(Number(lat1), Number(lat2)),
  minLng: Math.min(Number(lng1), Number(lng2)),
  maxLng: Math.max(Number(lng1), Number(lng2)),
});

export const expandBounds = (bounds, paddingM = 0) => {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return null;
  const centerLat = (normalized.minLat + normalized.maxLat) / 2;
  const latDelta = Math.max(0, Number(paddingM) || 0) / EARTH_M_PER_DEG;
  const lngDelta = latDelta / Math.max(MIN_LNG_COS, Math.cos(centerLat * Math.PI / 180));
  return {
    minLat: normalized.minLat - latDelta,
    maxLat: normalized.maxLat + latDelta,
    minLng: normalized.minLng - lngDelta,
    maxLng: normalized.maxLng + lngDelta,
  };
};

const cellSteps = (lat, cellSizeM = ROUTE_RISK_CELL_SIZE_M) => {
  const latStep = cellSizeM / EARTH_M_PER_DEG;
  const lngStep = cellSizeM / (EARTH_M_PER_DEG * Math.max(MIN_LNG_COS, Math.cos(Number(lat) * Math.PI / 180)));
  return { latStep, lngStep };
};

export const cellKeyForPoint = (lat, lng, cellSizeM = ROUTE_RISK_CELL_SIZE_M) => {
  const pointLat = Number(lat);
  const pointLng = Number(lng);
  if (!Number.isFinite(pointLat) || !Number.isFinite(pointLng)) return null;
  const { latStep, lngStep } = cellSteps(pointLat, cellSizeM);
  return `${Math.floor(pointLat / latStep)}:${Math.floor(pointLng / lngStep)}`;
};

export const cellCenterFromKey = (key, cellSizeM = ROUTE_RISK_CELL_SIZE_M) => {
  const [rowRaw, colRaw] = String(key || '').split(':');
  const row = Number(rowRaw);
  const col = Number(colRaw);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  const latStep = cellSizeM / EARTH_M_PER_DEG;
  const lat = (row + 0.5) * latStep;
  const { lngStep } = cellSteps(lat, cellSizeM);
  return { lat, lng: (col + 0.5) * lngStep };
};

export const cellBoundsFromKey = (key, cellSizeM = ROUTE_RISK_CELL_SIZE_M) => {
  const [rowRaw, colRaw] = String(key || '').split(':');
  const row = Number(rowRaw);
  const col = Number(colRaw);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  const latStep = cellSizeM / EARTH_M_PER_DEG;
  const minLat = row * latStep;
  const maxLat = (row + 1) * latStep;
  const centerLat = (minLat + maxLat) / 2;
  const { lngStep } = cellSteps(centerLat, cellSizeM);
  return {
    minLat,
    maxLat,
    minLng: col * lngStep,
    maxLng: (col + 1) * lngStep,
  };
};

export const cellKeysForBounds = (bounds, cellSizeM = ROUTE_RISK_CELL_SIZE_M) => {
  const normalized = normalizeBounds(bounds);
  if (!normalized) return [];
  const centerLat = (normalized.minLat + normalized.maxLat) / 2;
  const { latStep, lngStep } = cellSteps(centerLat, cellSizeM);
  const minRow = Math.floor(normalized.minLat / latStep);
  const maxRow = Math.floor(normalized.maxLat / latStep);
  const minCol = Math.floor(normalized.minLng / lngStep);
  const maxCol = Math.floor(normalized.maxLng / lngStep);
  const keys = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      keys.push(`${row}:${col}`);
    }
  }
  return keys;
};

export const intersectsBounds = (a, b) => {
  const first = normalizeBounds(a);
  const second = normalizeBounds(b);
  if (!first || !second) return false;
  return first.minLat <= second.maxLat &&
    first.maxLat >= second.minLat &&
    first.minLng <= second.maxLng &&
    first.maxLng >= second.minLng;
};
