import { finiteNumber } from './numberUtils.js';
import { ROUTE_RISK_GROUP_CELL_SIZE_M } from './routeRiskConfig.js';

const EARTH_M_PER_DEG = 111320;
const MIN_LNG_COS = 0.01;

function cellSteps(lat, cellSizeM = ROUTE_RISK_GROUP_CELL_SIZE_M) {
  const latStep = cellSizeM / EARTH_M_PER_DEG;
  const lngStep = cellSizeM / (EARTH_M_PER_DEG * Math.max(MIN_LNG_COS, Math.cos(Number(lat) * Math.PI / 180)));
  return { latStep, lngStep };
}

export function routeRiskCellKeyForPoint(lat, lng, cellSizeM = ROUTE_RISK_GROUP_CELL_SIZE_M) {
  const pointLat = finiteNumber(lat);
  const pointLng = finiteNumber(lng);
  if (pointLat == null || pointLng == null) return null;

  const { latStep, lngStep } = cellSteps(pointLat, cellSizeM);
  return `${Math.floor(pointLat / latStep)}:${Math.floor(pointLng / lngStep)}`;
}
