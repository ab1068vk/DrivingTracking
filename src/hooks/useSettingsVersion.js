import { useMemo } from 'react';
import { buildDrivingThresholds, buildScoreConstantsSnapshot } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';

export const SCORING_KEYS = new Set([
  'advanced_safety_detection_enabled',
  'eco_cruise_score_multiplier',
  'eco_idle_max_penalty',
  'eco_idle_penalty_multiplier',
  'eco_min_moving_kmh',
  'lane_change_score_enabled',
  'night_detection_mode',
  'night_end_time',
  'night_start_time',
  'night_sunrise_offset_minutes',
  'night_sunset_offset_minutes',
  'phone_confidence_threshold',
  'phone_coupling_threshold',
  'phone_creep_rate_kmh_s',
  'phone_lane_drift_deg',
  'phone_micro_steer_count',
  'phone_min_window_s',
  'phone_use_affects_score',
  'phone_use_detection_enabled',
  'threshold_eco_cruise_max_kmh',
  'threshold_eco_cruise_min_kmh',
  'threshold_harsh_brake_ms2',
  'threshold_heading_drift_std_degs',
  'threshold_idle_seconds',
  'threshold_manoeuvre_alert_brake_ms2',
  'threshold_manoeuvre_alert_turn_degs',
  'threshold_overtake_accel_ms2',
  'threshold_phone_proxy_oscillations',
  'threshold_rapid_accel_ms2',
  'threshold_sharp_turn_g_high',
  'threshold_sharp_turn_g_low',
  'threshold_sharp_turn_g_medium',
  'threshold_speed_creep_kmh',
  'threshold_speed_over_kmh',
  'threshold_speeding_kmh',
  'threshold_stop_start_decel_ms2',
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function settingsVersionFromSnapshot(snapshot = {}) {
  return stableStringify(snapshot);
}

export function getCurrentSettingsVersion(settings = localSettings.get()) {
  return settingsVersionFromSnapshot(buildScoreConstantsSnapshot(buildDrivingThresholds(settings)));
}

export function bumpSettingsVersionIfScoring(key, currentVersion, setVersion) {
  if (SCORING_KEYS.has(key)) {
    setVersion(typeof currentVersion === 'number' ? currentVersion + 1 : getCurrentSettingsVersion());
  }
}

export function useSettingsVersion(settings = localSettings.get()) {
  return useMemo(() => getCurrentSettingsVersion(settings), [settings]);
}
