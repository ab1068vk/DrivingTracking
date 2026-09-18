/**
 * The fields a **native Q1 page row** must carry (Annex A §A1/§A2 addendum).
 *
 * P7-IMPL-F05. Q10 runs the *identical* registered reducer implementations over
 * whichever authority's page it is handed, so a native page row that omits
 * `driver_metric_eligible` does not produce a smaller answer — it produces
 * **zero**, labelled `EXACT`, because `P-DRIVER` excludes every row. The page
 * parity double supplied those fields and hid it.
 *
 * This list is the single authority for that shape. The Java page path mirrors
 * it verbatim (`DriveSenseTripArchiveRepository.PAGE_PROJECTION_FIELDS`) and
 * `p7NativeWireContract.test.js` fails the build if the two ever diverge, so
 * there is one owner of the field set and one place to change it.
 *
 * **This costs no extra work per row.** The native page already decrypts each
 * row's display-metadata blob to copy `nickname`/`is_favorite`/`tag`/`tags`;
 * these fields come out of the same already-decrypted object. No extra read, no
 * extra decrypt, no full-trip acquisition, no second field authority — the blob
 * the canonical commit wrote is still the only source.
 */

/** Fields the frozen Q10 populations and reducers read from a bounded row. */
const REDUCER_FIELDS = Object.freeze([
  'avg_running_speed_kmh', 'avg_speed_kmh', 'braking_efficiency_score', 'city_crawl_ratio',
  'co2_saved_kg', 'cornering_consistency_score', 'distance_km', 'distraction_events_count',
  'driver_metric_eligible', 'duration_seconds', 'emergency_heavy_braking_count',
  'harsh_brakes_count', 'heading_deviation_count', 'high_speed_ratio', 'night_driving',
  'optimal_band_ratio', 'overall_compliance_score', 'phone_use_high_confidence_count',
  'phone_use_score_available', 'rapid_accel_count', 'road_type', 'route_data_expired_at',
  'route_points_map_count', 'route_replay_available', 'score_confidence', 'score_version',
  'severe_event_count', 'sharp_turns_count', 'speeding_events_count', 'stop_start_pattern_count',
  'svi_score', 'tailgate_cycle_count', 'trip_utc_offset_minutes', 'wet_signal_count',
]);

/**
 * Fields the bounded **list and geometry** surfaces read, beyond the reducers.
 *
 * `privacy_mode` and `route_data_expired_at` gate Q8: a masked or expired drive
 * must not have its overview opened, and a row that cannot say so would be
 * treated as ordinary.
 */
const SURFACE_FIELDS = Object.freeze([
  'is_favorite', 'nickname', 'privacy_mode', 'route_key', 'start_source', 'tag', 'tag_sources', 'tags',
]);

/**
 * The complete set, sorted, with no duplicate.
 *
 * `id`, `start_time`, `end_time`, `status`, `vehicle_id`, `distance`, `duration`
 * and the score columns are **not** here: they are plaintext columns the page's
 * own `SELECT` already returns, so copying them from the metadata blob would be
 * a second source for a value that already has one.
 */
export const P7_NATIVE_PAGE_PROJECTION_FIELDS = Object.freeze(
  [...new Set([...REDUCER_FIELDS, ...SURFACE_FIELDS])].sort()
);
