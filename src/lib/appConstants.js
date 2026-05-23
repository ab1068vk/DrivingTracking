export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 5;
export const MORNING_RUSH_START_HOUR = 7;
export const MORNING_RUSH_END_HOUR = 9;
export const EVENING_RUSH_START_HOUR = 16;
export const EVENING_RUSH_END_HOUR = 19;
export const NIGHT_START_TIME = `${String(NIGHT_START_HOUR).padStart(2, '0')}:00`;
export const NIGHT_END_TIME = `${String(NIGHT_END_HOUR).padStart(2, '0')}:00`;

export const MAX_VISIBLE_DANGER_ZONES = 6;
export const MAX_ROUTE_RISK_SEGMENTS_SHOWN = 3;

export const SAVED_FILTERS_KEY = 'road_sage_trip_filter_presets';
export const DISMISSED_TAG_SUGGESTIONS_KEY = 'drivesense_dismissed_tag_suggestions';
export const FIRST_LAUNCH_PERMISSION_PROMPTED_KEY = 'drivesense_first_launch_permission_prompted';

export function isNightRiskHour(hour) {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

export function isMorningRushHour(hour) {
  return hour >= MORNING_RUSH_START_HOUR && hour <= MORNING_RUSH_END_HOUR;
}

export function isEveningRushHour(hour) {
  return hour >= EVENING_RUSH_START_HOUR && hour < EVENING_RUSH_END_HOUR;
}
