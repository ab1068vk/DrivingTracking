/**
 * CANONICAL TRIP RECORD SHAPE - v23
 *
 * This is what a completed trip looks like in IndexedDB after all migrations
 * and scoring refreshes have run. Keep this in sync with every migration. If
 * you add a persisted trip field, add it here and update the relevant migration
 * or rescore gate.
 *
 * Fields marked @optional may be absent on older trips pending rescore.
 */
export const TRIP_SCHEMA_DESCRIPTION = Object.freeze({
  // Identity
  id: 'string (UUID or local trip id)',
  schema_version: 'number',
  status: "'completed' | 'discarded'",
  start_time: 'ISO timestamp',
  end_time: 'ISO timestamp',
  created_at: '@optional ISO timestamp',
  updated_at: 'ISO timestamp',

  // Route
  route_points: 'RoutePoint[]',
  route_points_raw_count: '@optional number',
  route_points_map_count: '@optional number',
  distance_km: 'number',
  estimated_private_distance_km: '@optional number',
  duration_seconds: 'number',
  wall_clock_duration_seconds: '@optional number',
  gap_seconds: '@optional number',
  avg_speed_kmh: '@optional number',
  avg_running_speed_kmh: '@optional number',
  max_speed_kmh: '@optional number',
  total_idle_seconds: '@optional number',
  idle_periods_count: '@optional number',
  night_driving: '@optional boolean',
  road_type: '@optional string',
  speed_zones: '@optional SpeedZone[]',

  // Scores
  score_overall: 'number | null',
  score_confidence: '@optional number',
  score_confidence_label: '@optional EvidenceLevel',
  score_safety: 'number | null',
  score_safety_confidence: '@optional EvidenceLevel',
  score_smoothness: 'number | null',
  score_smoothness_confidence: '@optional EvidenceLevel',
  score_eco: 'number | null',
  score_eco_confidence: '@optional EvidenceLevel',
  component_scores: 'ComponentScores',
  score_provenance: 'ScoreProvenance',
  score_explanation: '@optional ScoreExplanation',
  score_provenance_change: '@optional ScoreProvenanceChange',

  // Events
  driving_events: 'DrivingEvent[]',
  event_feedback: '@optional Record<string, EventFeedback>',
  data_quality_flags: '@optional string[]',
  feedback_adjusted_events_count: '@optional number',

  // Metadata
  vehicle_id: 'string | null',
  nickname: 'string | null',
  notes: 'string | null',
  tag: '@optional string | null',
  tags: 'string[]',
  is_favorite: 'boolean',
  tag_reviewed: '@optional boolean',
  auto_tag: '@optional string | null',
  auto_tag_confidence: '@optional number',
  background_tracking: '@optional boolean',
  start_source: '@optional string',
  imported_from_native: '@optional boolean',
  split_parent_id: '@optional string | null',
  split_segment_index: '@optional number',
  needs_rescore: '@optional boolean',

  // Optional / scored-later fields
  weather_context: '@optional WeatherContext',
  weather_skipped_reason: '@optional string',
  speed_limit_context: '@optional SpeedLimitContext',
  map_matching_status: '@optional string',
  map_matching_provider: '@optional string',
  map_matched_route: '@optional RoutePoint[]',
  fatigue_progression: '@optional FatigueProgression',
  fatigue_heatmap: '@optional FatigueHeatmapSegment[]',
  economics: '@optional TripEconomics',
  fuel_cost: '@optional number',
  fuel_used_liters: '@optional number',
  fuel_saved_liters: '@optional number',
  fuel_price_per_liter: '@optional number',
  co2_kg: '@optional number',
  co2_saved_kg: '@optional number',
  privacy_zones_touched: '@optional string[]',
  phone_usage_access_provenance: '@optional PhoneUsageAccessProvenance',
  sensor_fusion_summary: '@optional SensorFusionSummary',
});

export const REQUIRED_TRIP_FIELDS = Object.freeze([
  'id',
  'schema_version',
  'status',
  'start_time',
  'end_time',
  'updated_at',
  'route_points',
  'distance_km',
  'duration_seconds',
  'score_overall',
  'score_safety',
  'score_smoothness',
  'score_eco',
  'component_scores',
  'score_provenance',
  'driving_events',
  'vehicle_id',
  'nickname',
  'notes',
  'tags',
  'is_favorite',
]);

export function missingRequiredTripFields(trip = {}) {
  return REQUIRED_TRIP_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(trip, field));
}

export function hasRequiredTripFields(trip = {}) {
  return missingRequiredTripFields(trip).length === 0;
}
