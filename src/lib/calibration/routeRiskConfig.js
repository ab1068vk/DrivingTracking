export const ROUTE_RISK_MIN_TRIP_COUNT = 500;
export const ROUTE_RISK_MIN_ROUTE_GROUP_COUNT = 50;
export const ROUTE_RISK_GROUP_CELL_SIZE_M = 200;
export const ELEVATED_ROUTE_RISK_SCORE = 75;
export const HARSH_EVENT_RATIO_THRESHOLD = 0.4;
export const HARSH_ROUTE_SCORE_LIFT = 15;

export const ROUTE_RISK_EVENT_TYPES = Object.freeze([
  'harsh_brake',
  'rapid_acceleration',
  'sharp_turn',
  'speeding',
]);

export const ROUTE_RISK_HARSH_EVENT_TYPES = Object.freeze([
  'harsh_brake',
]);

export const ROUTE_RISK_EXCLUDED_EVENT_TYPES = Object.freeze([
  'near_miss',
  'close_proximity',
  'tailgate_cycle',
  'stop_start_pattern',
]);
