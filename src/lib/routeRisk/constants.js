import { scoringValue } from '@/lib/scoringConstants';

export const ROUTE_RISK_INDEX_KEY = 'road_sage_route_risk_index';
export const ROUTE_RISK_SNAP_DISTANCE_M = 15;
export const ROUTE_RISK_CELL_SIZE_M = ROUTE_RISK_SNAP_DISTANCE_M;
export const ROUTE_RISK_PRIVACY_ZONE_GUARD_M = 50;
export const GRID_PRECISION = 3;
export const MAX_SERIALIZED_LENGTH = 2_000_000;
export const MAX_STORED_CELLS = 5000;
export const ROUTE_RISK_INDEX_SCHEMA_VERSION = 2;

export const HARSH_EVENT_TYPES = new Set(['harsh_brake']);
export const EXCLUDED_PROXY_EVENT_TYPES = new Set([
  'near_miss',
  'close_proximity',
  'tailgate_cycle',
  'stop_start_pattern',
]);

export const SPEED_RISK_START_KMH = scoringValue('ROUTE_RISK_SPEED_START_KMH');
export const SPEED_RISK_FULL_KMH = scoringValue('ROUTE_RISK_SPEED_FULL_KMH');
export const SPEED_RISK_MAX_POINTS = scoringValue('ROUTE_RISK_SPEED_MAX_POINTS');

/**
 * Internal segment-risk weighting policy. These weights identify repeated
 * driving-event patterns; they are not calibrated to collision or casualty data.
 */
export const ROUTE_RISK_CONSTANTS = Object.freeze({
  ROUTE_RISK_EVENT_WEIGHT: scoringValue('ROUTE_RISK_EVENT_WEIGHT'),
  ROUTE_RISK_HARSH_WEIGHT: scoringValue('ROUTE_RISK_HARSH_WEIGHT'),
});
