/**
 * The single source of truth for the compact trip projection (P3).
 *
 * Membership is literal. A field is in the projection only because its name
 * appears below — never because of a naming pattern. A future
 * `giant_debug_score` does not enter merely by ending in `_score`; adding any
 * field requires an entry here, a bound class, a parity test and a
 * `TRIP_PROJECTION_VERSION` bump.
 *
 * Class counts, disjointness, the derived field list and the maximal-envelope
 * fixture are all generated from this constant, so prose can never disagree
 * with the contract.
 */

// v2 adds the single P7 projection addition `driver_metric_eligible`
// (P7 Annex C C1a.1). Rows written at v1 become stale and are rebuilt by the
// existing page-bounded projection repair path before they are classified,
// exactly as any other projection version bump.
export const TRIP_PROJECTION_VERSION = 2;
export const EVENT_TAXONOMY_VERSION = 1;

/** Terminal hard guard. The generated maximal fixture measures well below it. */
export const ENVELOPE_MAX_BYTES = 24_576;

/** Reserved plaintext `projection_version` meaning "stale / not built". */
export const PROJECTION_STALE_VERSION = 0;

/** Deterministic projection-build failure classes (per-row marker state). */
export const PROJECTION_FAILURE_CLASSES = Object.freeze({
  ENVELOPE_OVERSIZE: 'envelope_oversize',
  SCHEMA_INVALID: 'schema_invalid',
});

/** Numeric fields: finite number or `null`. */
const NUM = Object.freeze([
  'distance_km', 'estimated_private_distance_km', 'avg_speed_kmh', 'avg_running_speed_kmh',
  'max_speed_kmh', 'idle_time_seconds', 'traffic_idle_seconds', 'sustained_idle_seconds',
  'gap_seconds', 'wall_clock_duration_seconds', 'duration_seconds', 'trip_utc_offset_minutes',
  'fatigue_risk_score', 'intersection_score', 'stop_count', 'traffic_stop_count',
  'rolling_stop_count', 'smooth_approach_count', 'hill_infraction_count', 'hill_driving_score',
  'heading_drift_beta_window_count', 'heading_drift_beta_score', 'parking_approach_score',
  'parking_stop_duration_seconds', 'score_overall', 'score_confidence', 'score_safety',
  'score_smoothness', 'score_eco', 'harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count',
  'speeding_events_count', 'heading_deviation_count', 'heading_deviation_legacy_count',
  'stop_start_pattern_count', 'stop_start_pattern_sample_count', 'stop_start_pattern_score',
  'stop_start_pattern_highway_count', 'stop_start_pattern_urban_count',
  'stop_start_pattern_highway_score', 'stop_start_pattern_urban_score', 'distraction_events_count',
  'distraction_score', 'close_proximity_count', 'close_proximity_score', 'overtake_event_count',
  'overtake_score', 'jerk_score', 'jerk_event_count', 'eco_driving_score', 'cruise_score',
  'obd_powertrain_sample_count', 'obd_idle_seconds', 'obd_over_rev_count', 'obd_high_throttle_count',
  'speed_variability_index', 'svi_score', 'svi_moving_sample_count', 'optimal_band_ratio',
  'fuel_band_score', 'high_speed_ratio', 'city_crawl_ratio', 'merge_event_count', 'poor_merge_count',
  'harsh_merge_count', 'merge_score', 'harsh_stops_count', 'smooth_stops_count',
  'smooth_braking_ratio', 'smooth_braking_score', 'engine_stress_score', 'high_speed_accel_count',
  'trip_tire_wear_units', 'trip_tire_wear_missing_speed_event_count', 'speed_creep_event_count',
  'max_speed_creep_kmh', 'speed_creep_score', 'phone_proxy_count', 'phone_use_window_count',
  'phone_use_total_seconds', 'phone_use_score', 'phone_use_pct_of_trip',
  'phone_use_high_confidence_count', 'brake_onset_smoothness_score', 'avg_brake_onset_ramp_seconds',
  'brake_onset_sequence_count', 'cornering_consistency_score', 'mean_lateral_g', 'peak_lateral_g',
  'corner_sample_count', 'braking_efficiency_score', 'braking_sequence_count',
  'overall_compliance_score', 'lane_changing_score', 'lane_change_count', 'unsafe_lane_changes',
  'overtake_quality_score', 'overtake_count', 'unsafe_reentry_count', 'wet_signal_count',
  'wet_ratio', 'safety_condition_bonus', 'avg_distance_ratio', 'aggressive_driving_score',
  'defensive_driving_score', 'route_points_map_count', 'schema_version', 'severe_event_count',
  'emergency_heavy_braking_count', 'co2_saved_kg',
]);

/** Boolean fields. `phone_use_score_available` keeps `null` distinct from `false`. */
const BOOL = Object.freeze([
  'night_driving', 'parking_stop_detected', 'trip_tire_wear_has_missing_speed_data',
  'route_replay_available', 'is_favorite', 'has_notes', 'speed_limit_review_required',
  // P7 Annex C C1a.1 — the one projection addition P7 proposes. It is DERIVED
  // at build time from the canonical record (`isDriverMetricEligible`), not
  // copied from a source field of the same name, so that a bounded row can
  // evaluate the `P-DRIVER` population without every consumer re-implementing
  // the predicate. It carries no location, address, note or free text.
  'driver_metric_eligible',
]);

/** Booleans whose `undefined` must survive as `null` rather than collapsing to `false`. */
const NULLABLE_BOOL = Object.freeze(['phone_use_score_available']);

/**
 * The only finite enum. Repository-controlled, already a plaintext index column,
 * never displayed raw. Every other formerly enum-like value stays capped text so
 * an imported value is preserved rather than mapped to `other`.
 */
const ENUM = Object.freeze({
  status: Object.freeze(['completed', 'draft', 'active', 'cancelled', 'other']),
});

/** Text fields with serialized-byte caps. Exceeding a cap sets an overflow bit. */
const TEXT = Object.freeze({
  id: 64,
  start_time: 32,
  end_time: 32,
  updated_at: 32,
  created_at: 32,
  trip_timezone_id: 64,
  road_type: 64,
  dominant_road_type: 64,
  route_key: 128,
  vehicle_id: 64,
  vehicle_assignment_status: 32,
  tag: 48,
  auto_tag: 48,
  auto_tag_confidence: 32,
  privacy_mode: 32,
  route_data_expired_at: 32,
  score_version: 32,
  speed_limit_review_resolved_at: 32,
  fatigue_progression: 32,
  heading_drift_beta_level: 32,
  parking_approach_grade: 32,
  score_confidence_label: 32,
  score_safety_confidence: 32,
  score_smoothness_confidence: 32,
  score_eco_confidence: 32,
  svi_label: 32,
  band_label: 32,
  engine_stress_grade: 32,
  phone_proxy_risk: 32,
  phone_use_risk: 32,
  phone_use_score_status: 32,
  brake_onset_smoothness_grade: 32,
  braking_efficiency_grade: 32,
  aggressive_grade: 32,
  defensive_grade: 32,
  slippery_proxy: 32,
  nickname: 512,
  start_address: 512,
  end_address: 512,
  notes: 1024,
});

/**
 * Text fields whose consumers coerce with `String(...)`, so an imported numeric
 * value must still render (`getTripDisplayName` does exactly this), and identity
 * fields compared with `String(a) === String(b)`.
 */
const TEXT_COERCED = Object.freeze([
  'nickname', 'start_address', 'end_address', 'notes', 'route_key', 'vehicle_id', 'id',
]);

/** Collections and nested objects. Every member is enumerated. */
const COLLECTION = Object.freeze({
  tags: { kind: 'list', max: 40, member: { type: 'text', cap: 40 } },
  tag_sources: { kind: 'map', max: 40, keyCap: 40, member: { type: 'text', cap: 20 } },
  night_classification: {
    kind: 'object',
    members: { is_night: 'bool', window: 32, confidence: 32, source: 32, method: 32 },
  },
  weather_context: { kind: 'object', members: { source: 32, condition: 32 } },
  score_provenance: {
    kind: 'object',
    members: { calibration_status: 32, scoring_version: 32, computed_at: 32 },
  },
  component_scores: {
    kind: 'map', max: 32, keyCap: 48,
    member: { type: 'object', members: { value: 'num', evidence: 24 } },
  },
  overall_data_source: { kind: 'list', max: 8, member: { type: 'text', cap: 24 } },
  trip_speed_summary_v1: {
    kind: 'object',
    members: { tierCoverage: { kind: 'map', max: 8, keyCap: 32, member: { type: 'num' } } },
  },
  highway_score: { kind: 'object', members: { value: 'num', evidence: 24 } },
  urban_score: { kind: 'object', members: { value: 'num', evidence: 24 } },
  residential_score: { kind: 'object', members: { value: 'num', evidence: 24 } },
  phone_use_summary: {
    kind: 'object',
    members: {
      version: 'num', scoreAvailable: 'bool', scoreStatus: 32, risk: 32, score: 'num',
      windowCount: 'num', totalSeconds: 'num', pctOfTrip: 'num', avgSpeedKmh: 'num',
      hasConfirmedUse: 'bool', dataQuality: 32,
      worstEvent: {
        kind: 'object',
        members: {
          startTime: 32, durationSeconds: 'num', speedKmh: 'num', severity: 32,
          activityKey: 32, activityLabel: 64,
          contextLabels: { kind: 'list', max: 3, member: { type: 'text', cap: 48 } },
        },
      },
      activityBreakdown: {
        kind: 'list', max: 8,
        member: { type: 'object', members: { key: 32, label: 64, seconds: 'num' } },
      },
    },
  },
  // `aggregateOverflow` folds unknown/future taxonomy entries into an explicit
  // `other` bucket instead of dropping them, so counts stay semantically correct
  // and the envelope stays bounded as the taxonomy grows.
  event_counts_by_type: { kind: 'map', max: 32, keyCap: 48, aggregateOverflow: true, member: { type: 'num' } },
  event_counts_by_severity: { kind: 'map', max: 8, keyCap: 24, aggregateOverflow: true, member: { type: 'num' } },
  phone_use_evidence: {
    kind: 'object',
    members: {
      count: 'num', totalSeconds: 'num',
      windows: { kind: 'list', max: 8, member: { type: 'object', members: { s: 'num', d: 'num' } } },
    },
  },
});

export const TRIP_PROJECTION_SCHEMA = Object.freeze({
  num: NUM,
  bool: BOOL,
  nullableBool: NULLABLE_BOOL,
  enum: ENUM,
  text: TEXT,
  textCoerced: TEXT_COERCED,
  collection: COLLECTION,
});

/** Overflow bits emitted alongside `fields`, one per capped/limited group. */
export const PROJECTION_OVERFLOW_BITS = Object.freeze([
  'nickname_truncated', 'address_truncated', 'notes_truncated', 'tags_truncated',
  'route_key_truncated', 'vehicle_id_truncated',
]);

/** Fields whose exact value a bounded consumer requires (category B). */
export const PROJECTION_EXACT_FIELDS = Object.freeze([
  'nickname', 'start_address', 'end_address', 'notes', 'tags', 'route_key', 'vehicle_id',
]);

/** Derived, frozen. Never hand-maintained. */
export const TRIP_PROJECTION_FIELDS = Object.freeze([
  ...NUM,
  ...BOOL,
  ...NULLABLE_BOOL,
  ...Object.keys(ENUM),
  ...Object.keys(TEXT),
  ...Object.keys(COLLECTION),
]);

/** Class membership lookup, derived. */
export const TRIP_PROJECTION_CLASS_OF = Object.freeze(
  TRIP_PROJECTION_FIELDS.reduce((acc, name) => {
    if (NUM.includes(name)) acc[name] = 'num';
    else if (BOOL.includes(name)) acc[name] = 'bool';
    else if (NULLABLE_BOOL.includes(name)) acc[name] = 'nullableBool';
    else if (name in ENUM) acc[name] = 'enum';
    else if (name in TEXT) acc[name] = 'text';
    else acc[name] = 'collection';
    return acc;
  }, /** @type {Record<string, string>} */ ({}))
);

/** Generated counts. Tests assert these against the classes, never against prose. */
export const TRIP_PROJECTION_COUNTS = Object.freeze({
  num: NUM.length,
  bool: BOOL.length + NULLABLE_BOOL.length,
  enum: Object.keys(ENUM).length,
  text: Object.keys(TEXT).length,
  collection: Object.keys(COLLECTION).length,
  total: TRIP_PROJECTION_FIELDS.length,
});
