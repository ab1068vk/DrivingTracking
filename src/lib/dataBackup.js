import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { eventRatePerDistance } from '@/lib/mathUtils';
import { BACKUP_EXCLUDED_KEYS, localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';
import {
  boundsOverlapPrivacyZone,
  createPrivacyExportSalt,
  getHydratedPrivacyZones,
  getPrivacyZones,
  isInsidePrivacyZone,
  maskTripForPrivacyExport,
  routeTouchesPrivacyZone,
} from '@/lib/privacyZones';
import { commitZoneForExportSync, createExportId } from '@/lib/exportCommitment';
import { getJson, setJson } from '@/lib/mobileStorage';
import { SAVED_FILTERS_KEY } from '@/lib/appConstants';
import {
  readSpeedKnowledgeData,
  replaceSpeedKnowledgeData,
  SPEED_KNOWLEDGE_SCHEMA_VERSION,
} from '@/lib/speedKnowledgeRepository';
import { refreshTripsForLocalSpeedKnowledgeChanges } from '@/lib/localSpeedScoreRefresh';
import { geohashBounds } from '@/lib/localSpeedKnowledge';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  CALIBRATION_LABELS_KEY,
  CALIBRATION_SURVEY_MARKERS_KEY,
  localCalibrationLabelRepository,
} from '@/lib/localCalibrationLabelRepository';
import {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_WRONG_PASSWORD_CODE,
  decryptBackupText,
  ENCRYPTED_BACKUP_EXTENSION,
  ENCRYPTED_BACKUP_MIME_TYPE,
  encryptBackupText,
  isEncryptedBackupEnvelope,
} from '@/lib/backupEnvelopeEncryption';
import {
  isSignedExportEnvelope,
  signExport,
  verifyAndUnwrapExport,
} from '@/lib/exportIntegrity';
import { logTransmission } from '@/lib/transmissionLog';
import {
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
  BACKUP_TOO_LARGE_MESSAGE,
  MAX_BACKUP_DECOMPRESSED_BYTES,
  MAX_BACKUP_BYTES,
} from '@/lib/dataBackupConstants';

// CHANGES (session):
// - Added speed knowledge backup support and trip_speed_summary_v1 backup field support.

/*
 * Backup schema history:
 * v1: trips, vehicles, and settings base export.
 * v2: UI payload added for saved trip filters.
 * v3: route/event metadata and reviewed event feedback persisted.
 * v4: scoring schema refresh; older imported trips require rescoring.
 * v5: privacy-safe zone metadata and hardened import sanitization.
 * v6: legacy lane_change events are relabelled as heading_deviation_legacy.
 * v7: local post-trip calibration labels and survey markers are preserved.
 * v8: privacy zone cell hashes are omitted from backups; zones must be re-entered after restore.
 * v9: exports include a per-export id and privacy-zone commitments without zone coordinates.
 * v10: local speed knowledge and user speed-limit corrections are preserved.
 *
 * Every import is migrated one version at a time before it is sanitized and
 * merged. Coordinates omitted for privacy zones are intentionally not restored.
 */
export const BACKUP_VERSION = 10;
export const MAX_IMPORTED_TRIP_ROUTE_POINTS = 5000;
export const MAX_IMPORTED_TRIP_DRIVING_EVENTS = 500;
export const MAX_IMPORTED_STRING_LENGTH = 5000;
export const MAX_IMPORTED_TRIP_NOTES_LENGTH = 10000;
export const MAX_IMPORTED_CALIBRATION_LABELS = 5000;
export const MAX_IMPORTED_CALIBRATION_MARKERS = 10000;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_CELLS = 10000;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_CORRECTIONS = 5000;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_EXCLUSIONS = 2500;
export const MAX_IMPORTED_ROAD_MEMORY_CANDIDATES = 2500;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_SECTION_POINTS = 24;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_EDIT_HISTORY = 10;
export const MAX_IMPORTED_SPEED_KNOWLEDGE_AUDIT_TRAIL = 25;
export {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_TOO_LARGE_MESSAGE,
  BACKUP_WRONG_PASSWORD_CODE,
  MAX_BACKUP_DECOMPRESSED_BYTES,
  MAX_BACKUP_BYTES,
};

const safeFilename = (filename) => filename.replace(/[\\/:*?"<>|]+/g, '-');
const filterString = (value, fallback = '') => (
  typeof value === 'string' ? value.slice(0, 120) : fallback
);

const IMPORTED_TRIP_STATUS = new Set(['completed', 'discarded']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_IMPORTED_NESTED_ARRAY_ITEMS = 500;
const MAX_IMPORTED_NESTED_OBJECT_KEYS = 100;
const IMPORT_TRIP_BATCH_SIZE = 4;
const IMPORTED_STRING_LIMITS_BY_FIELD = {
  id: 120,
  nickname: 200,
  notes: MAX_IMPORTED_TRIP_NOTES_LENGTH,
  tag: 100,
  message: 500,
  label: 200,
};

const SPEED_KNOWLEDGE_SOURCES = new Set([
  'trip_consensus',
  'local_road_memory',
  'user_confirmed_posted_sign',
  'user_entered_estimate',
  'time_of_day_bucket',
]);

const SPEED_KNOWLEDGE_DIRECTION_MODES = new Set(['forward', 'reverse', 'both']);
const SPEED_KNOWLEDGE_QUALIFIER_STATUSES = new Set([
  'regulatory_text_no_qualifiers',
  'conditional_school_when_flashing',
  'conditional_school',
  'conditional_temporary_work_zone',
  'conditional_daytime',
  'conditional_night',
]);

const IMPORTED_TRIP_FIELDS = new Set([
  'id',
  'status',
  'start_time',
  'end_time',
  'created_at',
  'updated_at',
  'vehicle_id',
  'tag',
  'tags',
  'nickname',
  'notes',
  'is_favorite',
  'auto_tag',
  'auto_tag_confidence',
  'auto_tag_reason',
  'auto_tags',
  'tag_candidates',
  'tag_sources',
  'tag_intelligence_version',
  'tag_reviewed',
  'background_tracking',
  'start_source',
  'imported_from_native',
  'split_parent_id',
  'split_segment_index',
  'needs_rescore',
  'schema_version',
  'route_points',
  'route_points_raw_count',
  'route_points_map_count',
  'route_data_expired_at',
  'route_data_retention_days',
  'route_data_expiration_reason',
  'driving_events',
  'event_feedback',
  'duration_seconds',
  'wall_clock_duration_seconds',
  'gap_seconds',
  'data_quality_flags',
  'score_confidence_flag',
  'distance_km',
  'estimated_private_distance_km',
  'avg_speed_kmh',
  'avg_running_speed_kmh',
  'max_speed_kmh',
  'total_idle_seconds',
  'idle_periods_count',
  'night_driving',
  'night_classification',
  'trip_timezone_id',
  'trip_utc_offset_minutes',
  'road_type',
  'speed_zones',
  'trip_speed_summary_v1',
  'score_overall',
  'score_confidence',
  'score_confidence_label',
  'score_safety',
  'score_safety_confidence',
  'score_smoothness',
  'score_smoothness_confidence',
  'score_eco',
  'score_eco_confidence',
  'component_scores',
  'score_provenance',
  'score_provenance_change',
  'harsh_brakes_count',
  'rapid_accel_count',
  'sharp_turns_count',
  'speeding_events_count',
  'heading_deviation_count',
  'heading_deviations_per_10km',
  'heading_deviation_legacy_count',
  'heading_deviation_legacy_per_10km',
  'heading_deviation_available',
  'tailgate_cycle_count',
  'following_distance_score',
  'following_distance_score_confidence',
  'stop_start_pattern_count',
  'stop_start_pattern_score',
  'stop_start_pattern_score_confidence',
  'distraction_events_count',
  'distraction_score',
  'distraction_score_confidence',
  'near_miss_count',
  'near_miss_score',
  'near_miss_score_confidence',
  'close_proximity_count',
  'close_proximity_score',
  'close_proximity_score_confidence',
  'overtake_event_count',
  'overtake_score',
  'overtake_score_confidence',
  'overtake_affects_score',
  'intersection_score',
  'intersection_score_confidence',
  'stop_count',
  'traffic_stop_count',
  'rolling_stop_count',
  'smooth_approach_count',
  'jerk_score',
  'jerk_score_confidence',
  'eco_driving_score',
  'eco_driving_score_confidence',
  'speed_variability_index',
  'svi_score',
  'svi_label',
  'svi_score_confidence',
  'svi_moving_sample_count',
  'fuel_band_score',
  'fuel_band_score_confidence',
  'smooth_braking_ratio',
  'smooth_braking_score',
  'smooth_braking_score_confidence',
  'merge_score',
  'merge_score_confidence',
  'engine_stress_score',
  'engine_stress_score_confidence',
  'trip_tire_wear_units',
  'trip_tire_wear_has_missing_speed_data',
  'trip_tire_wear_missing_speed_event_count',
  'drowsy_risk_level',
  'drowsy_score',
  'drowsy_risk_score',
  'drowsy_risk_score_confidence',
  'heading_drift_beta_window_count',
  'heading_drift_beta_score',
  'heading_drift_beta_level',
  'heading_drift_beta_confidence',
  'heading_drift_beta_available',
  'hill_score',
  'hill_driving_score',
  'hill_driving_score_confidence',
  'climb_distance_km',
  'descent_distance_km',
  'hill_infraction_count',
  'hill_infraction_rate_per_km',
  'parking_approach_score',
  'parking_approach_score_confidence',
  'reaction_score',
  'reaction_score_confidence',
  'avg_reaction_seconds',
  'reaction_grade',
  'reaction_sample_count',
  'brake_onset_smoothness_score',
  'avg_brake_onset_ramp_seconds',
  'brake_onset_smoothness_grade',
  'brake_onset_sequence_count',
  'brake_onset_smoothness_confidence',
  'brake_onset_disclaimer',
  'cornering_consistency_score',
  'cornering_consistency_score_confidence',
  'cornering_grade',
  'mean_lateral_g',
  'peak_lateral_g',
  'corner_sample_count',
  'braking_efficiency_score',
  'braking_efficiency_score_confidence',
  'braking_efficiency_grade',
  'braking_context',
  'braking_sequence_count',
  'avg_braking_smoothness',
  'highway_score',
  'urban_score',
  'residential_score',
  'dominant_road_type',
  'highway_compliance',
  'urban_compliance',
  'residential_compliance',
  'overall_compliance_score',
  'overall_compliance_score_confidence',
  'overtake_quality_score',
  'overtake_quality_score_confidence',
  'overtake_quality_grade',
  'overtake_count',
  'overtake_quality_beta',
  'unsafe_reentry_count',
  'slippery_proxy',
  'wet_signal_count',
  'wet_ratio',
  'safety_condition_bonus',
  'avg_distance_ratio',
  'aggressive_driving_score',
  'aggressive_driving_score_confidence',
  'aggressive_grade',
  'defensive_driving_score',
  'defensive_driving_score_confidence',
  'defensive_grade',
  'phone_proxy_risk',
  'phone_proxy_count',
  'phone_proxy_events',
  'native_phone_proxy_count',
  'native_tracking_timeline',
  'phone_use_events',
  'phone_use_window_count',
  'phone_use_total_seconds',
  'phone_use_risk',
  'phone_use_score',
  'phone_use_score_confidence',
  'phone_use_score_available',
  'phone_use_score_status',
  'phone_use_pct_of_trip',
  'phone_use_high_confidence_count',
  'native_phone_usage_events',
  'native_phone_usage_event_count',
  'native_phone_usage_total_seconds',
  'native_phone_usage_access_granted',
  'native_phone_usage_access_checked_at',
  'phone_usage_access_provenance',
  'fuel_cost',
  'fuel_used_liters',
  'fuel_saved_liters',
  'fuel_price_per_liter',
  'co2_kg',
  'co2_saved_kg',
  'fatigue_progression',
  'fatigue_heatmap',
  'fatigue_risk_score',
  'fatigue_risk_score_confidence',
  'speed_creep_score',
  'speed_creep_score_confidence',
  'segment_scores',
  'hill_route',
  'map_matching_status',
  'map_matching_provider',
  'speed_limit_context',
  'weather_context',
  'weather_skipped_reason',
]);

const IMPORTED_NIGHT_CLASSIFICATION_FIELDS = new Set([
  'version',
  'is_night',
  'mode',
  'method',
  'reason',
  'solar_event_type',
  'boundary_tolerance_minutes',
  'sunset_offset_minutes',
  'sunrise_offset_minutes',
  'custom_start_time',
  'custom_end_time',
  'custom_fallback_used',
  'fallback_reason',
  'fallback_point_count',
  'evaluated_point_count',
  'trip_started_in_night',
  'trip_start_local_time',
  'decision_point_at',
  'decision_local_time',
  'local_date',
  'timezone_id',
  'utc_offset_minutes',
  'evening_event_local_time',
  'morning_event_local_time',
  'night_window_start_local_time',
  'night_window_end_local_time',
]);

const IMPORTED_ROUTE_POINT_FIELDS = new Set([
  'lat',
  'lng',
  'timestamp',
  'timezone_id',
  'utc_offset_minutes',
  'time',
  'speed',
  'speed_kmh',
  'accuracy',
  'heading',
  'altitude',
  'accel_ms2',
  'acceleration_ms2',
  'distance_m',
  'delta_seconds',
  'road_type',
  'speed_limit',
  'speed_limit_kmh',
  'speed_limit_source',
  'speed_limit_default_country',
  'fallback_country',
  'privacy_masked',
  'privacy_boundary',
  'original_lat',
  'original_lng',
  'source',
]);

const IMPORTED_DRIVING_EVENT_FIELDS = new Set([
  'id',
  'type',
  'severity',
  'timestamp',
  'time',
  'lat',
  'lng',
  'value',
  'speed_kmh',
  'durationS',
  'duration_seconds',
  'distance_m',
  'confidence',
  'source',
  'inferred',
  'speed_limit',
  'speed_limit_kmh',
  'speed_limit_source',
  'speed_limit_default_country',
  'fallback_country',
  'start_time',
  'end_time',
  'start_index',
  'end_index',
  'road_type',
  'message',
  'label',
  'legacy_renamed',
]);

const isPlainObject = (value) => (
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const addTruncationWarning = (warnings, field, limit) => {
  if (!warnings || !field) return;
  const message = `Imported ${field} text exceeded ${limit.toLocaleString()} characters and was truncated.`;
  if (!warnings.includes(message)) warnings.push(message);
};

const sanitizeJsonValue = (value, depth = 0, { maxStringLength = MAX_IMPORTED_STRING_LENGTH, warnings = null, field = '' } = {}) => {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > maxStringLength) addTruncationWarning(warnings, field, maxStringLength);
    return value.slice(0, maxStringLength);
  }
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_IMPORTED_NESTED_ARRAY_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1, { maxStringLength, warnings, field }))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DANGEROUS_OBJECT_KEYS.has(key))
      .slice(0, MAX_IMPORTED_NESTED_OBJECT_KEYS)
      .map(([key, item]) => [key, sanitizeJsonValue(item, depth + 1, {
        maxStringLength: IMPORTED_STRING_LIMITS_BY_FIELD[key] || maxStringLength,
        warnings,
        field: key,
      })])
      .filter(([, item]) => item !== undefined)
  );
};

const sanitizeWhitelistedObject = (value, allowedFields, warnings = null) => {
  if (!isPlainObject(value)) return null;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedFields.has(key)) continue;
    const next = sanitizeJsonValue(item, 0, {
      maxStringLength: IMPORTED_STRING_LIMITS_BY_FIELD[key] || MAX_IMPORTED_STRING_LENGTH,
      warnings,
      field: key,
    });
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
};

export function sanitizeImportedTrip(trip, warnings = null) {
  if (!isPlainObject(trip)) {
    throw new Error('Backup contains an invalid trip record.');
  }

  const id = filterString(trip.id).trim();
  if (!id) {
    throw new Error('Backup contains a trip without a valid id.');
  }

  const sanitized = sanitizeWhitelistedObject(trip, IMPORTED_TRIP_FIELDS, warnings);
  sanitized.id = id;
  sanitized.status = IMPORTED_TRIP_STATUS.has(trip.status) ? trip.status : 'completed';
  sanitized.route_points = Array.isArray(trip.route_points)
    ? trip.route_points
      .slice(0, MAX_IMPORTED_TRIP_ROUTE_POINTS)
      .map((point) => sanitizeWhitelistedObject(point, IMPORTED_ROUTE_POINT_FIELDS, warnings))
      .filter(Boolean)
    : [];
  sanitized.driving_events = Array.isArray(trip.driving_events)
    ? trip.driving_events
      .slice(0, MAX_IMPORTED_TRIP_DRIVING_EVENTS)
      .map((event) => sanitizeWhitelistedObject(event, IMPORTED_DRIVING_EVENT_FIELDS, warnings))
      .filter(Boolean)
    : [];
  if (isPlainObject(trip.night_classification)) {
    sanitized.night_classification = sanitizeWhitelistedObject(
      trip.night_classification,
      IMPORTED_NIGHT_CLASSIFICATION_FIELDS,
      warnings
    );
  } else {
    delete sanitized.night_classification;
  }

  return sanitized;
}

export const sanitizeSavedTripFilters = (filters) => (
  Array.isArray(filters)
    ? filters
      .filter((item) => item && typeof item === 'object' && filterString(item.name).trim())
      .slice(0, 8)
      .map((item, index) => ({
        id: filterString(item.id, `filter_import_${index}`),
        name: filterString(item.name).trim(),
        search: filterString(item.search),
        sortBy: filterString(item.sortBy, 'date_desc'),
        filterBy: filterString(item.filterBy, 'all'),
        selectedTag: filterString(item.selectedTag, 'all'),
      }))
    : []
);

export const sanitizeCalibrationLabels = (labels, warnings = null) => (
  Array.isArray(labels)
    ? labels
      .slice(0, MAX_IMPORTED_CALIBRATION_LABELS)
      .map((label) => sanitizeJsonValue(label, 0, {
        maxStringLength: 2000,
        warnings,
        field: 'calibration label',
      }))
      .filter(isPlainObject)
    : []
);

export const sanitizeCalibrationSurveyMarkers = (markers, warnings = null) => {
  if (!isPlainObject(markers)) return {};
  return Object.fromEntries(
    Object.entries(markers)
      .filter(([, marker]) => isPlainObject(marker))
      .slice(0, MAX_IMPORTED_CALIBRATION_MARKERS)
      .map(([tripId, marker]) => [
        filterString(tripId, 'trip').trim(),
        sanitizeJsonValue(marker, 0, {
          maxStringLength: 1000,
          warnings,
          field: 'calibration survey marker',
        }),
      ])
      .filter(([tripId, marker]) => tripId && isPlainObject(marker))
  );
};

const sanitizeSpeedKnowledgeGeohash = (value) => {
  const geohash = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(geohash) ? geohash : '';
};

const sanitizeSpeedKnowledgeNumber = (value, min = 0, max = 250) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
};

const sanitizeOptionalSpeedKnowledgeNumber = (value, min = 0, max = 250) => (
  value == null || value === '' ? null : sanitizeSpeedKnowledgeNumber(value, min, max)
);

const sanitizeSpeedKnowledgeString = (value, maxLength = 200) => (
  typeof value === 'string' ? value.slice(0, maxLength) : ''
);

const sanitizeSpeedKnowledgeInstant = (value) => {
  if (value == null || value === '') return null;
  if (!['string', 'number'].includes(typeof value)) return undefined;
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
};

const sanitizeSpeedKnowledgeDateOnly = (value) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  return value;
};

const sanitizeSpeedKnowledgeSource = (value, fallback = 'user_entered_estimate') => (
  SPEED_KNOWLEDGE_SOURCES.has(value) ? value : fallback
);

const sanitizeSpeedKnowledgeTimeRule = (rule) => {
  if (!isPlainObject(rule) || rule.enabled !== true) return { enabled: false };
  if (!Array.isArray(rule.days) || !rule.days.length) return null;
  const numericRuleValue = (value) => (
    (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
      ? Number(value)
      : Number.NaN
  );
  const numericDays = rule.days.map(numericRuleValue);
  if (numericDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null;
  const days = [...new Set(numericDays)].sort((a, b) => a - b);
  const startMinutes = numericRuleValue(rule.startMinutes);
  const endMinutes = numericRuleValue(rule.endMinutes);
  if (
    !Number.isInteger(startMinutes) ||
    startMinutes < 0 ||
    startMinutes > 1439 ||
    !Number.isInteger(endMinutes) ||
    endMinutes < 0 ||
    endMinutes > 1439
  ) return null;
  return {
    enabled: true,
    days,
    startMinutes: Math.round(startMinutes),
    endMinutes: Math.round(endMinutes),
    ...(typeof rule.label === 'string' ? { label: sanitizeSpeedKnowledgeString(rule.label, 120) } : {}),
  };
};

const sanitizeSpeedKnowledgePoint = (point, privacyZones = []) => {
  if (!isPlainObject(point)) return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return null;
  if (isInsidePrivacyZone(lat, lng, privacyZones)) return null;
  return { lat, lng };
};

const sanitizeSpeedKnowledgeCell = (cell, warnings = null, preserveDerivedTrust = false) => {
  if (!isPlainObject(cell)) return null;
  const limitKmh = sanitizeSpeedKnowledgeNumber(cell.limitKmh, 0, MAX_SAVED_SPEED_LIMIT_KMH);
  if (limitKmh == null || limitKmh <= 0) return null;
  const declaredSource = sanitizeSpeedKnowledgeSource(cell.source, 'trip_consensus');
  // Coarse runtime cells are derived trip consensus. An unsigned backup must not
  // promote a cell merely by claiming a higher-trust source, so canonicalize every
  // unverified imported cell and make it rebuild its eligibility from local drives.
  // Signed same-device backups and internal export sanitization explicitly opt in
  // to preserving their authenticated derived evidence.
  const preserveEvidence = preserveDerivedTrust === true;
  const source = preserveEvidence ? declaredSource : 'trip_consensus';
  const sanitized = {
    limitKmh: Math.round(limitKmh),
    source,
    confidence: preserveEvidence ? sanitizeSpeedKnowledgeNumber(cell.confidence, 0, 1) ?? 0 : 0,
    tripCount: preserveEvidence ? Math.max(0, Math.round(Number(cell.tripCount) || 0)) : 0,
    evidenceCount: preserveEvidence ? Math.max(0, Math.round(Number(cell.evidenceCount) || 0)) : 0,
    firstSeenAt: sanitizeSpeedKnowledgeString(cell.firstSeenAt, 80),
    lastUpdatedAt: sanitizeSpeedKnowledgeString(cell.lastUpdatedAt, 80),
    verifiedAt: preserveEvidence && cell.verifiedAt
      ? sanitizeSpeedKnowledgeString(cell.verifiedAt, 80)
      : null,
    verificationStatus: preserveEvidence
      ? sanitizeSpeedKnowledgeString(cell.verificationStatus, 120)
      : 'imported_shadow_relearning',
    ...(!preserveEvidence ? { importTrustState: 'shadow_relearning' } : {}),
  };
  if (cell.conflict === true) sanitized.conflict = true;
  if (isPlainObject(cell.conflictDetails)) {
    sanitized.conflictDetails = sanitizeJsonValue(cell.conflictDetails, 0, {
      maxStringLength: 500,
      warnings,
      field: 'speed knowledge conflict',
    });
  }
  if (cell.conflictResolvedAt) sanitized.conflictResolvedAt = sanitizeSpeedKnowledgeString(cell.conflictResolvedAt, 80);
  if (cell.conflictResolvedSource) sanitized.conflictResolvedSource = sanitizeSpeedKnowledgeSource(cell.conflictResolvedSource);
  if (cell.conflictResolvedNote) sanitized.conflictResolvedNote = sanitizeSpeedKnowledgeString(cell.conflictResolvedNote, 500);
  if (isPlainObject(cell.timeOfDayBuckets)) {
    const buckets = Object.fromEntries(
      Object.entries(cell.timeOfDayBuckets)
        .slice(0, 12)
        .filter(([key]) => /^\d{2}-\d{2}$/.test(key))
        .map(([key, bucket]) => {
          const p85Kmh = sanitizeSpeedKnowledgeNumber(
            bucket?.p85Kmh,
            0,
            MAX_SAVED_SPEED_LIMIT_KMH
          );
          return [key, {
            p85Kmh: p85Kmh == null ? sanitized.limitKmh : Math.round(p85Kmh),
            count: Math.max(0, Math.round(Number(bucket?.count) || 0)),
          }];
        })
    );
    if (Object.keys(buckets).length > 0) sanitized.timeOfDayBuckets = buckets;
  }
  sanitized.auditTrail = (Array.isArray(cell.auditTrail) ? cell.auditTrail : [])
    .slice(-MAX_IMPORTED_SPEED_KNOWLEDGE_AUDIT_TRAIL)
    .map((item) => sanitizeJsonValue(item, 0, {
      maxStringLength: 500,
      warnings,
      field: 'speed knowledge audit trail',
    }))
    .filter(isPlainObject);
  return sanitized;
};

const sanitizeSpeedKnowledgeCorrection = (
  correction,
  privacyZones = [],
  warnings = null,
  { preservePostedTrust = false } = {}
) => {
  if (!isPlainObject(correction)) return null;
  const geohash = sanitizeSpeedKnowledgeGeohash(correction.geohash);
  const limitKmh = sanitizeSpeedKnowledgeNumber(correction.limitKmh, 0, MAX_SAVED_SPEED_LIMIT_KMH);
  if (!geohash || limitKmh == null || limitKmh <= 0) return null;
  const coordinate = sanitizeSpeedKnowledgePoint(correction, []);
  const sectionPoints = (Array.isArray(correction.sectionPoints) ? correction.sectionPoints : [])
    .map((point) => sanitizeSpeedKnowledgePoint(point, []))
    .filter(Boolean)
    .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_SECTION_POINTS);
  if (!coordinate && sectionPoints.length === 0 && Number.isFinite(Number(correction.lat)) && Number.isFinite(Number(correction.lng))) {
    return null;
  }
  if (
    privacyZones.length &&
    (
      boundsOverlapPrivacyZone(geohashBounds(geohash), privacyZones) ||
      privacyZones.some((zone) => routeTouchesPrivacyZone(
        [coordinate, ...sectionPoints].filter(Boolean),
        zone
      ))
    )
  ) return null;
  const declaredSource = sanitizeSpeedKnowledgeSource(correction.source);
  const postedTrustReset = preservePostedTrust !== true && (
    declaredSource === 'user_confirmed_posted_sign' ||
    correction.importTrustState === 'posted_reconfirmation_required'
  );
  const source = postedTrustReset ? 'user_entered_estimate' : declaredSource;
  const directionMode = sanitizeSpeedKnowledgeDirectionMode(correction);
  const timeRule = sanitizeSpeedKnowledgeTimeRule(correction.timeRule);
  if (!directionMode || !timeRule) return null;
  const directionBearing = sanitizeSpeedKnowledgeNumber(correction.directionBearing, 0, 360);
  const validFrom = sanitizeSpeedKnowledgeInstant(correction.validFrom ?? correction.valid_from);
  const expiresAt = sanitizeSpeedKnowledgeInstant(correction.expiresAt);
  const validFromDate = sanitizeSpeedKnowledgeDateOnly(correction.validFromDate);
  const expiresAtDate = sanitizeSpeedKnowledgeDateOnly(correction.expiresAtDate);
  if (
    validFrom === undefined ||
    expiresAt === undefined ||
    validFromDate === undefined ||
    expiresAtDate === undefined ||
    (validFromDate && !validFrom) ||
    (expiresAtDate && !expiresAt)
  ) return null;
  if (
    validFrom &&
    expiresAt &&
    new Date(validFrom).getTime() >= new Date(expiresAt).getTime()
  ) return null;
  const supersededAt = sanitizeSpeedKnowledgeInstant(correction.supersededAt);
  const conflictResolution = sanitizeSpeedKnowledgeConflictResolution(correction.conflictResolution);
  const qualifierStatus = SPEED_KNOWLEDGE_QUALIFIER_STATUSES.has(correction.qualifierStatus)
    ? correction.qualifierStatus
    : hasOwn(correction, 'qualifierStatus')
      ? 'conditional_unverified'
      : null;
  return {
    id: sanitizeSpeedKnowledgeString(correction.id || correction.ruleId, 120),
    geohash,
    ...(coordinate || {}),
    coordinateSource: sanitizeSpeedKnowledgeString(correction.coordinateSource || 'driven_route_sample', 80),
    limitKmh: Math.round(limitKmh),
    note: sanitizeSpeedKnowledgeString(correction.note, 500),
    source,
    appliedAt: sanitizeSpeedKnowledgeString(correction.appliedAt, 80),
    verifiedAt: postedTrustReset
      ? null
      : correction.verifiedAt ? sanitizeSpeedKnowledgeString(correction.verifiedAt, 80) : null,
    verificationStatus: postedTrustReset
      ? 'imported_requires_posted_reconfirmation'
      : sanitizeSpeedKnowledgeString(correction.verificationStatus, 120),
    ...(postedTrustReset ? { importTrustState: 'posted_reconfirmation_required' } : {}),
    evidenceCount: Math.max(0, Math.round(Number(correction.evidenceCount) || 0)),
    validFrom,
    validFromDate,
    expiresAt,
    expiresAtDate,
    historicalVersion: correction.historicalVersion === true,
    supersededAt: supersededAt === undefined ? null : supersededAt,
    supersededByCorrectionId: sanitizeSpeedKnowledgeString(
      correction.supersededByCorrectionId ?? correction.supersededBy,
      160
    ) || null,
    supersedesCorrectionId: sanitizeSpeedKnowledgeString(
      correction.supersedesCorrectionId ?? correction.supersedes,
      160
    ) || null,
    versionRootId: sanitizeSpeedKnowledgeString(correction.versionRootId, 160) || null,
    provenance: sanitizeSpeedKnowledgeString(correction.provenance, 120) || null,
    roadMemoryCandidateId: sanitizeSpeedKnowledgeString(correction.roadMemoryCandidateId, 160) || null,
    qualifierStatus,
    conflictResolution,
    roadName: sanitizeSpeedKnowledgeString(correction.roadName, 200),
    contextLabel: sanitizeSpeedKnowledgeString(correction.contextLabel, 300),
    directionLabel: sanitizeSpeedKnowledgeString(correction.directionLabel, 200),
    timeLabel: sanitizeSpeedKnowledgeString(correction.timeLabel, 120),
    distanceM: Math.max(0, Math.round(Number(correction.distanceM) || 0)),
    directionMode,
    ...(directionBearing == null ? {} : { directionBearing }),
    timeRule,
    sectionPoints,
    editHistory: (Array.isArray(correction.editHistory) ? correction.editHistory : [])
      .slice(-MAX_IMPORTED_SPEED_KNOWLEDGE_EDIT_HISTORY)
      .map((item) => sanitizeJsonValue(item, 0, {
        maxStringLength: 500,
        warnings,
        field: 'speed knowledge edit history',
      }))
      .filter(isPlainObject),
    auditTrail: (Array.isArray(correction.auditTrail) ? correction.auditTrail : [])
      .slice(-MAX_IMPORTED_SPEED_KNOWLEDGE_AUDIT_TRAIL)
      .map((item) => sanitizeJsonValue(item, 0, {
        maxStringLength: 500,
        warnings,
        field: 'speed knowledge audit trail',
      }))
      .filter(isPlainObject),
  };
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const sanitizeSpeedKnowledgeDirectionMode = (value) => {
  if (!hasOwn(value, 'directionMode')) return 'both';
  return SPEED_KNOWLEDGE_DIRECTION_MODES.has(value.directionMode)
    ? value.directionMode
    : null;
};

const sanitizeSpeedKnowledgeConflictResolution = (resolution) => {
  if (!isPlainObject(resolution)) return null;
  const savedLimitKmh = sanitizeSpeedKnowledgeNumber(
    resolution.savedLimitKmh,
    0,
    MAX_SAVED_SPEED_LIMIT_KMH
  );
  const observedLimitKmh = sanitizeSpeedKnowledgeNumber(
    resolution.observedLimitKmh,
    0,
    MAX_SAVED_SPEED_LIMIT_KMH
  );
  if (savedLimitKmh == null || savedLimitKmh <= 0 || observedLimitKmh == null || observedLimitKmh <= 0) {
    return null;
  }
  const resolvedAt = sanitizeSpeedKnowledgeInstant(resolution.resolvedAt);
  return {
    savedLimitKmh: Math.round(savedLimitKmh),
    observedLimitKmh: Math.round(observedLimitKmh),
    deltaKmh: Math.abs(Math.round(savedLimitKmh) - Math.round(observedLimitKmh)),
    action: sanitizeSpeedKnowledgeString(resolution.action || 'resolved', 80) || 'resolved',
    source: sanitizeSpeedKnowledgeSource(resolution.source),
    note: sanitizeSpeedKnowledgeString(resolution.note, 240),
    resolvedAt: resolvedAt === undefined ? null : resolvedAt,
  };
};

const sanitizeExcludedSpeedSection = (section, privacyZones = []) => {
  if (!isPlainObject(section)) return null;
  const directionMode = sanitizeSpeedKnowledgeDirectionMode(section);
  if (!directionMode) return null;
  const geohash = sanitizeSpeedKnowledgeGeohash(section.geohash);
  const coordinate = sanitizeSpeedKnowledgePoint(section, []);
  const sectionPoints = (Array.isArray(section.sectionPoints) ? section.sectionPoints : [])
    .map((point) => sanitizeSpeedKnowledgePoint(point, []))
    .filter(Boolean)
    .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_SECTION_POINTS);
  const center = coordinate || sectionPoints[Math.floor(sectionPoints.length / 2)] || null;
  if (!geohash || !center) return null;
  if (
    privacyZones.length &&
    (
      boundsOverlapPrivacyZone(geohashBounds(geohash), privacyZones) ||
      privacyZones.some((zone) => routeTouchesPrivacyZone(
        [center, ...sectionPoints],
        zone
      ))
    )
  ) return null;

  const createdAt = sanitizeSpeedKnowledgeInstant(section.createdAt);
  // Legacy exclusion IDs and keys sometimes embedded unrelated endpoint
  // coordinates. Rebuild identity only from the already privacy-checked
  // geometry so hidden coordinate strings cannot ride through a backup.
  const id = `excluded-${geohash}-${center.lat.toFixed(5)}-${center.lng.toFixed(5)}`;
  const directionBearing = sanitizeSpeedKnowledgeNumber(section.directionBearing, 0, 360);
  return {
    id,
    geohash,
    ...center,
    roadName: sanitizeSpeedKnowledgeString(section.roadName, 200),
    reason: sanitizeSpeedKnowledgeString(section.reason || 'parking_private', 80),
    directionMode,
    ...(directionBearing == null ? {} : { directionBearing }),
    exclusionKeys: [],
    sectionPoints,
    createdAt: createdAt === undefined ? null : createdAt,
  };
};

const ROAD_MEMORY_REVIEW_STATES = new Set([
  '',
  'deferred',
  'confirmed',
  'adjusted',
  'kept_existing',
  'time_profiles_accepted',
  'rejected',
]);
const ROAD_MEMORY_FEEDBACK_OUTCOMES = new Set(['', 'exact', 'adjusted', 'rejected']);
const ROAD_MEMORY_EXACT_OR_ADJUSTED_REVIEW_STATES = new Set(['confirmed', 'adjusted']);
const ROAD_MEMORY_REJECTED_REVIEW_STATES = new Set(['kept_existing', 'rejected']);

const roadMemoryReviewMetadataIsValid = ({
  candidate,
  reviewState,
  feedbackOutcome,
  reviewedAt,
  timeProfilesAcceptedAt,
  limitAtReviewKmh,
  reviewedLimitKmh,
}) => {
  const reviewStateProvided = hasOwn(candidate, 'reviewState') &&
    candidate.reviewState != null && candidate.reviewState !== '';
  const feedbackOutcomeProvided = hasOwn(candidate, 'feedbackOutcome') &&
    candidate.feedbackOutcome != null && candidate.feedbackOutcome !== '';
  if (
    (reviewStateProvided && (
      typeof candidate.reviewState !== 'string' || !ROAD_MEMORY_REVIEW_STATES.has(reviewState)
    )) ||
    (feedbackOutcomeProvided && (
      typeof candidate.feedbackOutcome !== 'string' ||
      !ROAD_MEMORY_FEEDBACK_OUTCOMES.has(feedbackOutcome)
    )) ||
    (hasOwn(candidate, 'reviewedAt') && candidate.reviewedAt != null && reviewedAt === undefined) ||
    (hasOwn(candidate, 'timeProfilesAcceptedAt') &&
      candidate.timeProfilesAcceptedAt != null && timeProfilesAcceptedAt === undefined)
  ) return false;

  if (feedbackOutcome) {
    const compatible = feedbackOutcome === 'rejected'
      ? ROAD_MEMORY_REJECTED_REVIEW_STATES.has(reviewState)
      : ROAD_MEMORY_EXACT_OR_ADJUSTED_REVIEW_STATES.has(reviewState);
    if (!compatible) return false;
  }

  if (ROAD_MEMORY_EXACT_OR_ADJUSTED_REVIEW_STATES.has(reviewState)) {
    return Boolean(reviewedAt) && limitAtReviewKmh > 0 && reviewedLimitKmh > 0;
  }
  if (ROAD_MEMORY_REJECTED_REVIEW_STATES.has(reviewState)) {
    return Boolean(reviewedAt) && limitAtReviewKmh > 0;
  }
  if (reviewState === 'time_profiles_accepted') return Boolean(timeProfilesAcceptedAt);
  return true;
};

const sanitizeRoadMemoryCandidate = (
  candidate,
  privacyZones = [],
  { preserveRoadMemoryTrust = false } = {}
) => {
  if (!isPlainObject(candidate)) return null;
  const directionMode = sanitizeSpeedKnowledgeDirectionMode(candidate);
  if (!directionMode) return null;
  const geohash = sanitizeSpeedKnowledgeGeohash(candidate.geohash);
  const limitKmh = sanitizeSpeedKnowledgeNumber(candidate.limitKmh, 0, MAX_SAVED_SPEED_LIMIT_KMH);
  const coordinate = sanitizeSpeedKnowledgePoint(candidate, []);
  const sectionPoints = (Array.isArray(candidate.sectionPoints) ? candidate.sectionPoints : [])
    .map((point) => sanitizeSpeedKnowledgePoint(point, []))
    .filter(Boolean)
    .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_SECTION_POINTS);
  if (!geohash || limitKmh == null || limitKmh <= 0 || !coordinate || sectionPoints.length < 2) return null;
  if (
    privacyZones.length &&
    (
      boundsOverlapPrivacyZone(geohashBounds(geohash), privacyZones) ||
      privacyZones.some((zone) => routeTouchesPrivacyZone(
        [coordinate, ...sectionPoints],
        zone
      ))
    )
  ) return null;
  const confidence = sanitizeSpeedKnowledgeNumber(candidate.confidence, 0, 1) ?? 0;
  const agreement = sanitizeSpeedKnowledgeNumber(candidate.agreement, 0, 1) ?? 0;
  const tripIds = (Array.isArray(candidate.tripIds) ? candidate.tripIds : [])
    .map((value) => sanitizeSpeedKnowledgeString(String(value), 120))
    .filter(Boolean)
    .slice(-50);
  const tripCount = Math.max(tripIds.length, Math.round(Number(candidate.tripCount) || 0));
  const limitVotes = Object.entries(isPlainObject(candidate.limitVotes) ? candidate.limitVotes : {})
    .reduce((sanitizedVotes, [limit, count]) => {
      const safeLimit = sanitizeSpeedKnowledgeNumber(limit, 0, MAX_SAVED_SPEED_LIMIT_KMH);
      const safeCount = Math.max(0, Math.round(Number(count) || 0));
      if (safeLimit == null || safeLimit <= 0 || safeCount <= 0) return sanitizedVotes;
      const key = String(Math.round(safeLimit));
      if (!hasOwn(sanitizedVotes, key) && Object.keys(sanitizedVotes).length >= 20) {
        return sanitizedVotes;
      }
      sanitizedVotes[key] = Math.min(
        Number.MAX_SAFE_INTEGER,
        (Number(sanitizedVotes[key]) || 0) + safeCount
      );
      return sanitizedVotes;
    }, {});
  const tripVotes = Object.fromEntries(
    Object.entries(isPlainObject(candidate.tripVotes) ? candidate.tripVotes : {})
      .map(([tripId, limit]) => [
        sanitizeSpeedKnowledgeString(String(tripId), 120),
        Math.round(sanitizeSpeedKnowledgeNumber(limit, 0, MAX_SAVED_SPEED_LIMIT_KMH) || 0),
      ])
      .filter(([tripId, limit]) => tripId && Number.isFinite(limit) && limit > 0)
      .slice(-50)
  );
  const recentObservations = (Array.isArray(candidate.recentObservations)
    ? candidate.recentObservations
    : [])
    .slice(-8)
    .map((observation) => ({
      tripId: sanitizeSpeedKnowledgeString(String(observation?.tripId || ''), 120),
      limitKmh: sanitizeSpeedKnowledgeNumber(
        observation?.limitKmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      ),
      observedAt: sanitizeSpeedKnowledgeString(observation?.observedAt, 80),
      timeBucket: sanitizeSpeedKnowledgeString(observation?.timeBucket, 40),
      p85Kmh: sanitizeSpeedKnowledgeNumber(
        observation?.p85Kmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      ),
    }))
    .filter((observation) => observation.tripId && observation.limitKmh > 0);
  const timeProfiles = (Array.isArray(candidate.timeProfiles) ? candidate.timeProfiles : [])
    .slice(0, 8)
    .map((profile) => ({
      bucket: sanitizeSpeedKnowledgeString(profile?.bucket, 40),
      limitKmh: sanitizeSpeedKnowledgeNumber(
        profile?.limitKmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      ),
      tripCount: Math.max(0, Math.round(Number(profile?.tripCount) || 0)),
      agreement: sanitizeSpeedKnowledgeNumber(profile?.agreement, 0, 1) ?? 0,
      eligible: profile?.eligible === true,
    }))
    .filter((profile) => profile.bucket && profile.limitKmh > 0);
  const timeBuckets = Object.fromEntries(
    Object.entries(isPlainObject(candidate.timeBuckets) ? candidate.timeBuckets : {})
      .slice(0, 8)
      .map(([bucket, value]) => [
        sanitizeSpeedKnowledgeString(bucket, 40),
        {
          tripVotes: Object.fromEntries(
            Object.entries(isPlainObject(value?.tripVotes) ? value.tripVotes : {})
              .map(([tripId, limit]) => [
                sanitizeSpeedKnowledgeString(String(tripId), 120),
                Math.round(sanitizeSpeedKnowledgeNumber(
                  limit,
                  0,
                  MAX_SAVED_SPEED_LIMIT_KMH
                ) || 0),
              ])
              .filter(([tripId, limit]) => tripId && Number.isFinite(limit) && limit > 0)
              .slice(-50)
          ),
        },
      ])
      .filter(([bucket]) => bucket)
  );
  const changeDetection = isPlainObject(candidate.changeDetection)
    ? {
      status: sanitizeSpeedKnowledgeString(candidate.changeDetection.status, 40),
      previousLimitKmh: sanitizeSpeedKnowledgeNumber(
        candidate.changeDetection.previousLimitKmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      ),
      proposedLimitKmh: sanitizeSpeedKnowledgeNumber(
        candidate.changeDetection.proposedLimitKmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      ),
      evidenceCount: Math.max(0, Math.round(Number(candidate.changeDetection.evidenceCount) || 0)),
      detectedAt: sanitizeSpeedKnowledgeString(candidate.changeDetection.detectedAt, 80),
      resolvedAt: sanitizeSpeedKnowledgeString(candidate.changeDetection.resolvedAt, 80),
    }
    : null;
  const rawReviewState = sanitizeSpeedKnowledgeString(candidate.reviewState, 40);
  const rawFeedbackOutcome = sanitizeSpeedKnowledgeString(candidate.feedbackOutcome, 40);
  const reviewedAt = sanitizeSpeedKnowledgeInstant(candidate.reviewedAt);
  const timeProfilesAcceptedAt = rawReviewState === 'time_profiles_accepted'
    ? sanitizeSpeedKnowledgeInstant(candidate.timeProfilesAcceptedAt ?? candidate.reviewedAt)
    : null;
  const limitAtReviewKmh = sanitizeOptionalSpeedKnowledgeNumber(
    candidate.limitAtReviewKmh,
    0,
    MAX_SAVED_SPEED_LIMIT_KMH
  );
  const reviewedLimitKmh = sanitizeOptionalSpeedKnowledgeNumber(
    candidate.reviewedLimitKmh,
    0,
    MAX_SAVED_SPEED_LIMIT_KMH
  );
  const reviewMetadataValid = roadMemoryReviewMetadataIsValid({
    candidate,
    reviewState: rawReviewState,
    feedbackOutcome: rawFeedbackOutcome,
    reviewedAt,
    timeProfilesAcceptedAt,
    limitAtReviewKmh,
    reviewedLimitKmh,
  });
  // A valid same-device signature authenticates the local evidence. Every
  // other import source must earn trip support and parked feedback again.
  const preserveCandidateTrust = preserveRoadMemoryTrust && reviewMetadataValid;
  const reviewState = preserveCandidateTrust ? rawReviewState : '';
  return {
    id: sanitizeSpeedKnowledgeString(candidate.id, 160),
    sectionKey: sanitizeSpeedKnowledgeString(candidate.sectionKey || candidate.id, 160),
    geohash,
    ...coordinate,
    coordinateSource: 'learned_local_corridor',
    source: 'local_road_memory',
    limitKmh: Math.round(limitKmh),
    confidence: preserveCandidateTrust ? confidence : 0,
    verificationStatus: 'local_candidate',
    needsReview: true,
    // Imported Road Memory never bypasses the local calibration gate. The
    // intelligence layer recomputes active use from sanitized feedback.
    active: false,
    stage: preserveCandidateTrust &&
      ['learning', 'suggested', 'operational', 'change_review', 'stale', 'resolved'].includes(candidate.stage)
      ? candidate.stage
      : preserveCandidateTrust && candidate.active === true ? 'operational' : 'learning',
    tripIds: preserveCandidateTrust ? tripIds : [],
    tripCount: preserveCandidateTrust ? tripCount : 0,
    evidenceCount: preserveCandidateTrust
      ? Math.max(tripCount, Math.round(Number(candidate.evidenceCount) || 0))
      : 0,
    limitVotes: preserveCandidateTrust ? limitVotes : {},
    tripVotes: preserveCandidateTrust ? tripVotes : {},
    recentObservations: preserveCandidateTrust ? recentObservations : [],
    timeProfiles: preserveCandidateTrust ? timeProfiles : [],
    timeBuckets: preserveCandidateTrust ? timeBuckets : {},
    changeDetection: preserveCandidateTrust ? changeDetection : null,
    reviewState,
    reviewedAt: preserveCandidateTrust && reviewedAt !== undefined ? reviewedAt : '',
    timeProfilesAcceptedAt: preserveCandidateTrust && timeProfilesAcceptedAt !== undefined
      ? timeProfilesAcceptedAt
      : null,
    limitAtReviewKmh: preserveCandidateTrust ? limitAtReviewKmh : null,
    reviewedLimitKmh: preserveCandidateTrust ? reviewedLimitKmh : null,
    feedbackOutcome: preserveCandidateTrust && rawFeedbackOutcome ? rawFeedbackOutcome : null,
    feedbackContext: preserveCandidateTrust && isPlainObject(candidate.feedbackContext)
      ? {
        contextKey: sanitizeSpeedKnowledgeString(candidate.feedbackContext.contextKey, 80),
        proposedLimitKmh: sanitizeOptionalSpeedKnowledgeNumber(
          candidate.feedbackContext.proposedLimitKmh,
          0,
          MAX_SAVED_SPEED_LIMIT_KMH
        ),
        chosenLimitKmh: sanitizeOptionalSpeedKnowledgeNumber(
          candidate.feedbackContext.chosenLimitKmh,
          0,
          MAX_SAVED_SPEED_LIMIT_KMH
        ),
        tripCount: Math.max(0, Math.round(Number(candidate.feedbackContext.tripCount) || 0)),
        agreement: Math.max(0, Math.min(1, Number(candidate.feedbackContext.agreement) || 0)),
        observedP85Kmh: sanitizeOptionalSpeedKnowledgeNumber(
          candidate.feedbackContext.observedP85Kmh,
          0,
          MAX_SAVED_SPEED_LIMIT_KMH
        ),
      }
      : null,
    lastPromptedTripCount: preserveCandidateTrust
      ? Math.max(0, Math.round(Number(candidate.lastPromptedTripCount) || 0))
      : 0,
    agreement: preserveCandidateTrust ? agreement : 0,
    sectionPoints,
    distanceM: Math.max(0, Math.round(Number(candidate.distanceM) || 0)),
    directionMode,
    directionBearing: sanitizeOptionalSpeedKnowledgeNumber(candidate.directionBearing, 0, 360),
    firstObservedAt: preserveCandidateTrust
      ? sanitizeSpeedKnowledgeString(candidate.firstObservedAt, 80)
      : '',
    lastObservedAt: preserveCandidateTrust
      ? sanitizeSpeedKnowledgeString(candidate.lastObservedAt, 80)
      : '',
    observedP85Kmh: preserveCandidateTrust
      ? sanitizeOptionalSpeedKnowledgeNumber(
        candidate.observedP85Kmh,
        0,
        MAX_SAVED_SPEED_LIMIT_KMH
      )
      : null,
    sampleCount: preserveCandidateTrust
      ? Math.max(0, Math.round(Number(candidate.sampleCount) || 0))
      : 0,
    chronologyRepairPending: preserveCandidateTrust
      ? candidate.chronologyRepairPending === true
      : true,
    roadName: sanitizeSpeedKnowledgeString(candidate.roadName, 200),
    contextLabel: preserveCandidateTrust
      ? sanitizeSpeedKnowledgeString(candidate.contextLabel, 500)
      : 'Imported corridor awaiting fresh local evidence.',
  };
};

export const sanitizeSpeedKnowledge = (
  knowledge,
  privacyZones = [],
  warnings = null,
  { preserveRoadMemoryTrust = false } = {}
) => {
  if (!isPlainObject(knowledge)) {
    return {
      schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
      knowledgeRevision: 0,
      knowledgeUpdatedAt: null,
      cells: {},
      corrections: [],
      excludedSections: [],
      roadMemory: {
        version: 3,
        chronologyVersion: 0,
        candidates: [],
        processedTrips: {},
        intelligence: null,
      },
    };
  }
  const rawRevision = Number(knowledge.knowledgeRevision);
  const knowledgeRevision = Number.isSafeInteger(rawRevision) && rawRevision >= 0
    ? rawRevision
    : 0;
  const knowledgeUpdatedAt = sanitizeSpeedKnowledgeInstant(knowledge.knowledgeUpdatedAt);
  const roadMemoryChronologyVersion = Number(knowledge.roadMemory?.chronologyVersion) >= 1 ? 1 : 0;
  const cells = Object.fromEntries(
    Object.entries(isPlainObject(knowledge.cells) ? knowledge.cells : {})
      .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_CELLS)
      .map(([geohash, cell]) => {
        const safeGeohash = sanitizeSpeedKnowledgeGeohash(geohash);
        if (
          safeGeohash &&
          privacyZones.length &&
          boundsOverlapPrivacyZone(geohashBounds(safeGeohash), privacyZones)
        ) return [null, null];
        return [
          safeGeohash,
          sanitizeSpeedKnowledgeCell(cell, warnings, preserveRoadMemoryTrust),
        ];
      })
      .filter(([geohash, cell]) => geohash && cell)
  );
  const corrections = (Array.isArray(knowledge.corrections) ? knowledge.corrections : [])
    .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_CORRECTIONS)
    .map((correction) => sanitizeSpeedKnowledgeCorrection(correction, privacyZones, warnings, {
      preservePostedTrust: preserveRoadMemoryTrust,
    }))
    .filter(Boolean);
  const excludedSections = (Array.isArray(knowledge.excludedSections)
    ? knowledge.excludedSections
    : [])
    .slice(0, MAX_IMPORTED_SPEED_KNOWLEDGE_EXCLUSIONS)
    .map((section) => sanitizeExcludedSpeedSection(section, privacyZones))
    .filter(Boolean);
  const candidates = (Array.isArray(knowledge.roadMemory?.candidates)
    ? knowledge.roadMemory.candidates
    : [])
    .slice(0, MAX_IMPORTED_ROAD_MEMORY_CANDIDATES)
    .map((candidate) => sanitizeRoadMemoryCandidate(candidate, privacyZones, {
      preserveRoadMemoryTrust,
    }))
    .filter(Boolean);
  return {
    schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
    knowledgeRevision,
    knowledgeUpdatedAt: knowledgeUpdatedAt === undefined ? null : knowledgeUpdatedAt,
    cells,
    corrections,
    excludedSections,
    roadMemory: {
      version: 3,
      chronologyVersion: roadMemoryChronologyVersion,
      candidates,
      // Trips in the same backup are intentionally eligible to refresh this
      // evidence after restore instead of trusting old processed markers.
      processedTrips: {},
      intelligence: null,
    },
  };
};

const migrateLaneChangeEventType = (event) => (
  isPlainObject(event) && event.type === 'lane_change'
    ? { ...event, type: 'heading_deviation_legacy', legacy_renamed: true }
    : event
);

const migrateLegacyLaneChangeTrip = (trip) => {
  if (!isPlainObject(trip)) return trip;
  const events = Array.isArray(trip.driving_events)
    ? trip.driving_events.map(migrateLaneChangeEventType)
    : trip.driving_events;
  const eventLegacyCount = Array.isArray(events)
    ? events.filter((event) => event?.type === 'heading_deviation_legacy').length
    : 0;
  const legacyCount = eventLegacyCount || Number(trip.heading_deviation_legacy_count) || Number(trip.lane_changes_count) || 0;
  const modernCount = Array.isArray(events)
    ? events.filter((event) => event?.type === 'heading_deviation').length
    : Number(trip.heading_deviation_count) || 0;
  const { lane_changes_count: _laneChangesCount, lane_changes_per_10km: _laneChangesPer10Km, ...rest } = trip;
  return {
    ...rest,
    driving_events: events,
    heading_deviation_count: modernCount,
    heading_deviations_per_10km: eventRatePerDistance(modernCount, trip.distance_km),
    heading_deviation_legacy_count: legacyCount,
    heading_deviation_legacy_per_10km: eventRatePerDistance(legacyCount, trip.distance_km),
  };
};

const privacyZoneExportPlaceholders = (zones = []) => (
  (Array.isArray(zones) ? zones : []).map((_, index) => ({
    id: `private_area_${index + 1}`,
    label: 'Private area',
    masked_for_privacy: true,
    reconfiguration_required: true,
  }))
);

/**
 * @param {Record<string, any>} settings
 * @param {any[]} privacyZones
 */
const privacySafeSettingsForBackup = (settings = {}, privacyZones = []) => {
  const safe = { ...(settings || {}) };
  delete safe.last_map_center;
  safe.privacy_zones = privacyZoneExportPlaceholders(privacyZones);
  return safe;
};

const backupAbortError = () => {
  const error = new Error('Backup export cancelled.');
  error.name = 'AbortError';
  return error;
};

const throwIfBackupAborted = (signal) => {
  if (signal?.aborted) throw backupAbortError();
};

const yieldBackupWork = () => new Promise((resolve) => setTimeout(resolve, 0));

async function buildDriveSenseBackupAsync({
  trips = [],
  vehicles = [],
  settings = localSettings.get(),
  savedFilters = [],
  calibrationLabels = [],
  calibrationSurveyMarkers = {},
  speedKnowledge = {},
  signal,
  onProgress,
} = {}) {
  throwIfBackupAborted(signal);
  const savedTripFilters = sanitizeSavedTripFilters(savedFilters);
  const sanitizedCalibrationLabels = sanitizeCalibrationLabels(calibrationLabels);
  const sanitizedCalibrationSurveyMarkers = sanitizeCalibrationSurveyMarkers(calibrationSurveyMarkers);
  const privacyExportSalt = createPrivacyExportSalt();
  const exportId = createExportId();
  const privacyZones = getPrivacyZones(settings);
  const zoneCommitments = privacyZones.map((zone) => commitZoneForExportSync(zone, exportId));
  const sanitizedSpeedKnowledge = sanitizeSpeedKnowledge(speedKnowledge, privacyZones, null, {
    preserveRoadMemoryTrust: true,
  });
  const exportSettings = privacySafeSettingsForBackup(settings, privacyZones);
  const maskedTrips = [];
  let privacyPlaceholderCount = 0;

  for (let index = 0; index < trips.length; index += 1) {
    throwIfBackupAborted(signal);
    const masked = /** @type {any} */ (maskTripForPrivacyExport(trips[index], settings, privacyExportSalt));
    const normalized = {
      ...masked,
      route_points: Array.isArray(masked.route_points) ? masked.route_points : [],
      driving_events: Array.isArray(masked.driving_events) ? masked.driving_events : [],
      event_feedback: masked.event_feedback && typeof masked.event_feedback === 'object' ? masked.event_feedback : {},
    };
    maskedTrips.push(normalized);
    privacyPlaceholderCount += normalized.route_points.filter((point) => point?.privacy_export_placeholder === true).length;
    onProgress?.({ phase: 'protecting', completed: index + 1, total: trips.length });
    await yieldBackupWork();
  }

  throwIfBackupAborted(signal);
  const privacyShiftedTrips = maskedTrips.filter((trip) => trip?.privacy_time_shifted === true);
  return {
    app: 'Road Sage',
    version: BACKUP_VERSION,
    export_id: exportId,
    exported_at: new Date().toISOString(),
    privacy_export: {
      timestamp_fuzzing_enabled: true,
      timestamp_shift_policy: 'bounded_private_zone_noise',
      zone_commitment_scheme: 'sha256_zone_center_export_salt_v2',
      zone_commitment_count: zoneCommitments.length,
      zone_placeholder_count: privacyZones.length,
      shifted_trip_count: privacyShiftedTrips.length,
      boundary_placeholder_count: privacyPlaceholderCount,
      shifted_trip_ids: privacyShiftedTrips.map((trip) => trip.id).filter(Boolean).slice(0, 1000),
      no_backup_keys: [...BACKUP_EXCLUDED_KEYS],
    },
    zone_commitments: zoneCommitments,
    settings: exportSettings,
    ui: { saved_trip_filters: savedTripFilters },
    calibration: {
      labels: sanitizedCalibrationLabels,
      survey_markers: sanitizedCalibrationSurveyMarkers,
    },
    speed_knowledge: sanitizedSpeedKnowledge,
    vehicles,
    trips: maskedTrips,
  };
}

export function buildDriveSenseBackup({
  trips = [],
  vehicles = [],
  settings = localSettings.get(),
  savedFilters = [],
  calibrationLabels = [],
  calibrationSurveyMarkers = {},
  speedKnowledge = {},
} = {}) {
  const savedTripFilters = sanitizeSavedTripFilters(savedFilters);
  const sanitizedCalibrationLabels = sanitizeCalibrationLabels(calibrationLabels);
  const sanitizedCalibrationSurveyMarkers = sanitizeCalibrationSurveyMarkers(calibrationSurveyMarkers);
  const privacyExportSalt = createPrivacyExportSalt();
  const exportId = createExportId();
  const privacyZones = getPrivacyZones(settings);
  const zoneCommitments = privacyZones.map((zone) => commitZoneForExportSync(zone, exportId));
  const sanitizedSpeedKnowledge = sanitizeSpeedKnowledge(speedKnowledge, privacyZones, null, {
    preserveRoadMemoryTrust: true,
  });
  const exportSettings = privacySafeSettingsForBackup(settings, privacyZones);
  const maskedTrips = trips.map((trip) => {
    const masked = /** @type {any} */ (maskTripForPrivacyExport(trip, settings, privacyExportSalt));
    return {
      ...masked,
      route_points: Array.isArray(masked.route_points) ? masked.route_points : [],
      driving_events: Array.isArray(masked.driving_events) ? masked.driving_events : [],
      event_feedback: masked.event_feedback && typeof masked.event_feedback === 'object' ? masked.event_feedback : {},
    };
  });
  const privacyShiftedTrips = maskedTrips.filter((trip) => trip?.privacy_time_shifted === true);
  const privacyPlaceholderCount = maskedTrips.reduce((count, trip) => (
    count + (Array.isArray(trip?.route_points)
      ? trip.route_points.filter((point) => point?.privacy_export_placeholder === true).length
      : 0)
  ), 0);
  return {
    app: 'Road Sage',
    version: BACKUP_VERSION,
    export_id: exportId,
    exported_at: new Date().toISOString(),
    privacy_export: {
      timestamp_fuzzing_enabled: true,
      timestamp_shift_policy: 'bounded_private_zone_noise',
      zone_commitment_scheme: 'sha256_zone_center_export_salt_v2',
      zone_commitment_count: zoneCommitments.length,
      zone_placeholder_count: privacyZones.length,
      shifted_trip_count: privacyShiftedTrips.length,
      boundary_placeholder_count: privacyPlaceholderCount,
      shifted_trip_ids: privacyShiftedTrips.map((trip) => trip.id).filter(Boolean).slice(0, 1000),
      no_backup_keys: [...BACKUP_EXCLUDED_KEYS],
    },
    zone_commitments: zoneCommitments,
    settings: exportSettings,
    ui: {
      saved_trip_filters: savedTripFilters,
    },
    calibration: {
      labels: sanitizedCalibrationLabels,
      survey_markers: sanitizedCalibrationSurveyMarkers,
    },
    speed_knowledge: sanitizedSpeedKnowledge,
    vehicles,
    trips: maskedTrips,
  };
}

/**
 * @param {{trips?:Array,vehicles?:Array,settings?:Object,filename?:string,passphrase?:string|null,signal?:AbortSignal,onProgress?:(progress:{phase:string,completed?:number,total?:number})=>void}} options
 */
export async function exportDriveSenseBackup({ trips, vehicles, settings, filename, passphrase = null, signal, onProgress } = {}) {
  throwIfBackupAborted(signal);
  onProgress?.({ phase: 'preparing', completed: 0, total: 1 });
  const effectiveSettings = settings && typeof settings === 'object' ? settings : localSettings.get();
  let hydratedPrivacyZones;
  try {
    hydratedPrivacyZones = await getHydratedPrivacyZones(effectiveSettings);
    if (!Array.isArray(hydratedPrivacyZones)) {
      throw new Error('Privacy-zone hydration returned invalid data.');
    }
  } catch (error) {
    logSystemFailure('backup_export_privacy_zone_hydration', error, {});
    throw new Error(
      'Road Sage could not securely load your privacy zones, so no backup was exported.'
    );
  }
  const [savedFilters, calibrationLabels, calibrationSurveyMarkers, speedKnowledge] = await Promise.all([
    getJson(SAVED_FILTERS_KEY, []),
    getJson(CALIBRATION_LABELS_KEY, []),
    getJson(CALIBRATION_SURVEY_MARKERS_KEY, {}),
    readSpeedKnowledgeData().then((value) => value || {}),
  ]);
  const privacyHydratedSettings = {
    ...effectiveSettings,
    privacy_zones: hydratedPrivacyZones,
  };
  throwIfBackupAborted(signal);
  const backup = await buildDriveSenseBackupAsync({
    trips,
    vehicles,
    settings: privacyHydratedSettings,
    savedFilters,
    calibrationLabels,
    calibrationSurveyMarkers,
    speedKnowledge,
    signal,
    onProgress,
  });
  const encrypted = typeof passphrase === 'string' && passphrase.length > 0;
  const requestedName = filename || `road-sage-full-backup-${new Date().toISOString().split('T')[0]}.json`;
  const encryptedName = /\.(json|drivesensebackup)$/i.test(requestedName)
    ? requestedName.replace(/\.(json|drivesensebackup)$/i, ENCRYPTED_BACKUP_EXTENSION)
    : `${requestedName}${ENCRYPTED_BACKUP_EXTENSION}`;
  const outputName = safeFilename(encrypted ? encryptedName : requestedName);
  let signedBackup;
  try {
    throwIfBackupAborted(signal);
    onProgress?.({ phase: 'signing', completed: 0, total: 1 });
    signedBackup = await signExport(backup);
    throwIfBackupAborted(signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    logSystemFailure('backup_export_sign', error, {
      backup_version: BACKUP_VERSION,
    });
    throw error;
  }
  onProgress?.({ phase: 'packaging', completed: 0, total: 1 });
  await yieldBackupWork();
  throwIfBackupAborted(signal);
  const plaintext = JSON.stringify(signedBackup);
  throwIfBackupAborted(signal);
  await logTransmission({
    service: 'export',
    type: encrypted ? 'Encrypted full backup' : 'Full backup',
    coordinateDisclosure: 'committed',
    privacyTransformVerified: !JSON.stringify({
      zoneCommitments: signedBackup?.payload?.zone_commitments || [],
      privacyZones: signedBackup?.payload?.settings?.privacy_zones || [],
    }).match(/"lat(?:itude)?"|"lng"|"longitude"|"radius(?:_m)?"|"zone_radius_m"|"label":"(?!Private area")/i),
    privacyTransformSource: 'dataBackup.js:buildDriveSenseBackup',
    privacyVerificationEvidence: [
      'backup payload was inspected for zone coordinate and radius fields',
      'privacy zones are exported as coordinate-free commitments',
    ],
    sentCoords: '0 - zone coordinates and ranges excluded, boundary points committed',
    protections: ['local HMAC integrity', 'commitment scheme', 'no zone centers or ranges included'],
    offsetMeters: null,
    bytesOut: plaintext.length,
    status: 'safe',
    tripId: null,
    zonesSuppressed: privacyZoneExportPlaceholders(hydratedPrivacyZones).map((zone) => zone.label),
  });
  let content = plaintext;
  if (encrypted) {
    recordSystemEvent('backup_export_encryption_started', {
      backup_version: BACKUP_VERSION,
      trip_count: Array.isArray(trips) ? trips.length : 0,
      vehicle_count: Array.isArray(vehicles) ? vehicles.length : 0,
    }, { category: 'storage', title: 'Backup encryption started' });
    try {
      onProgress?.({ phase: 'encrypting', completed: 0, total: 1 });
      content = await encryptBackupText(plaintext, passphrase, {
        exportedAt: backup.exported_at,
        signal,
        onProgress: (progress) => onProgress?.({ phase: progress.phase || 'encrypting', completed: progress.completed, total: progress.total }),
      });
      throwIfBackupAborted(signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      logSystemFailure('backup_export_encrypt', error, {
        backup_version: BACKUP_VERSION,
      });
      throw error;
    }
  }
  const mimeType = encrypted ? ENCRYPTED_BACKUP_MIME_TYPE : 'application/json';
  let nativeFallbackError = null;
  if (!encrypted) {
    recordSystemEvent('backup_plaintext_export_selected', {
      backup_version: BACKUP_VERSION,
      trip_count: Array.isArray(trips) ? trips.length : 0,
      vehicle_count: Array.isArray(vehicles) ? vehicles.length : 0,
    }, {
      category: 'storage',
      severity: 'warn',
      title: 'Readable backup export selected',
      message: 'Backup will be saved without password protection.',
    });
  }
  recordSystemEvent('backup_export_started', {
    trip_count: Array.isArray(trips) ? trips.length : 0,
    vehicle_count: Array.isArray(vehicles) ? vehicles.length : 0,
    saved_filter_count: Array.isArray(savedFilters) ? savedFilters.length : 0,
    backup_version: BACKUP_VERSION,
    encrypted,
    signed: true,
    output_format: encrypted ? 'encrypted' : 'json',
  }, { category: 'storage', title: 'Backup export started' });

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const result = await saveExportToDownloads({
        filename: outputName,
        data: content,
        mimeType,
        signal,
        onProgress: (progress) => onProgress?.({ phase: 'saving', ...progress }),
      });
      recordSystemEvent('backup_export_completed', {
        native: true,
        mime_type: mimeType,
        byte_count: content.length,
        backup_version: BACKUP_VERSION,
        encrypted,
        signed: true,
        output_format: encrypted ? 'encrypted' : 'json',
      }, { category: 'storage', title: 'Backup export completed' });
      return { native: true, filename: outputName, uri: result.uri, encrypted, signed: true };
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    nativeFallbackError = error?.message || 'Native export failed.';
    logSystemFailure('backup_native_export', error, {
      mime_type: mimeType,
      byte_count: content.length,
      encrypted,
      output_format: encrypted ? 'encrypted' : 'json',
    });
    console.warn('Native backup export failed, falling back to browser download.', error);
  }

  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outputName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  recordSystemEvent('backup_export_completed', {
    native: false,
    native_fallback: Boolean(nativeFallbackError),
    mime_type: mimeType,
    byte_count: content.length,
    backup_version: BACKUP_VERSION,
    encrypted,
    signed: true,
    output_format: encrypted ? 'encrypted' : 'json',
  }, { category: 'storage', title: 'Backup export completed' });
  return {
    native: false,
    filename: outputName,
    backup,
    signedBackup,
    encrypted,
    signed: true,
    nativeFallback: Boolean(nativeFallbackError),
    nativeFallbackError,
  };
}

export function migrateBackup(data, fromVersion = Number(data?.version) || 1) {
  const sourceVersion = Number.isInteger(Number(fromVersion)) && Number(fromVersion) > 0 ? Number(fromVersion) : 1;
  if (sourceVersion > BACKUP_VERSION) {
    throw new Error(`Backup version ${sourceVersion} is newer than this app supports.`);
  }

  let version = sourceVersion;
  let migrated = { ...data };
  while (version < BACKUP_VERSION) {
    if (version === 1) {
      migrated = {
        ...migrated,
        vehicles: Array.isArray(migrated.vehicles) ? migrated.vehicles : [],
        ui: isPlainObject(migrated.ui) ? migrated.ui : { saved_trip_filters: [] },
      };
    } else if (version === 2) {
      migrated = {
        ...migrated,
        ui: {
          ...(isPlainObject(migrated.ui) ? migrated.ui : {}),
          saved_trip_filters: Array.isArray(migrated.ui?.saved_trip_filters) ? migrated.ui.saved_trip_filters : [],
        },
        trips: (migrated.trips || []).map((trip) => ({
          ...trip,
          route_points: Array.isArray(trip?.route_points) ? trip.route_points : [],
          driving_events: Array.isArray(trip?.driving_events) ? trip.driving_events : [],
          event_feedback: isPlainObject(trip?.event_feedback) ? trip.event_feedback : {},
        })),
      };
    } else if (version === 3) {
      migrated = {
        ...migrated,
        trips: (migrated.trips || []).map((trip) => (
          trip?.status === 'discarded' ? trip : { ...trip, needs_rescore: true }
        )),
      };
    } else if (version === 4) {
      migrated = {
        ...migrated,
        ui: isPlainObject(migrated.ui) ? migrated.ui : { saved_trip_filters: [] },
      };
    } else if (version === 5) {
      migrated = {
        ...migrated,
        trips: (migrated.trips || []).map(migrateLegacyLaneChangeTrip),
      };
    } else if (version === 6) {
      migrated = {
        ...migrated,
        calibration: isPlainObject(migrated.calibration)
          ? migrated.calibration
          : { labels: [], survey_markers: {} },
      };
    } else if (version === 8) {
      migrated = {
        ...migrated,
        export_id: typeof migrated.export_id === 'string' ? migrated.export_id : null,
        privacy_export: {
          ...(isPlainObject(migrated.privacy_export) ? migrated.privacy_export : {}),
          zone_commitment_scheme: migrated.privacy_export?.zone_commitment_scheme || null,
          zone_commitment_count: Number(migrated.privacy_export?.zone_commitment_count) || 0,
        },
        zone_commitments: Array.isArray(migrated.zone_commitments) ? migrated.zone_commitments : [],
      };
    } else if (version === 9) {
      migrated = {
        ...migrated,
        speed_knowledge: isPlainObject(migrated.speed_knowledge)
          ? migrated.speed_knowledge
          : { cells: {}, corrections: [] },
      };
    }
    version += 1;
  }

  return { ...migrated, version: BACKUP_VERSION };
}

function parseDriveSenseBackupValue(
  parsed,
  { sanitizeTrips = true, preserveRoadMemoryTrust = false } = {}
) {
  if (!parsed || !['Road Sage', 'DriveSense'].includes(parsed.app) || !Array.isArray(parsed.trips)) {
    throw new Error('This is not a valid Road Sage backup file.');
  }

  const sourceVersion = Number(parsed.version) || 1;
  const migrated = migrateBackup(parsed, sourceVersion);
  const warnings = [];
  const truncatedNoteTripCount = migrated.trips.filter((trip) => (
    typeof trip?.notes === 'string' && trip.notes.length > MAX_IMPORTED_TRIP_NOTES_LENGTH
  )).length;

  const trips = sanitizeTrips
    ? migrated.trips.map((trip) => sanitizeImportedTrip(trip, warnings))
    : migrated.trips;
  if (!sanitizeTrips && truncatedNoteTripCount > 0) {
    addTruncationWarning(warnings, 'notes', MAX_IMPORTED_TRIP_NOTES_LENGTH);
  }

  return {
    version: migrated.version,
    sourceVersion,
    speedKnowledgeIncluded: isPlainObject(parsed.speed_knowledge),
    settings: migrated.settings && typeof migrated.settings === 'object' ? migrated.settings : null,
    ui: migrated.ui && typeof migrated.ui === 'object' ? migrated.ui : null,
    calibration: {
      labels: sanitizeCalibrationLabels(migrated.calibration?.labels, warnings),
      survey_markers: sanitizeCalibrationSurveyMarkers(migrated.calibration?.survey_markers, warnings),
    },
    speed_knowledge: sanitizeSpeedKnowledge(migrated.speed_knowledge, [], warnings, {
      preserveRoadMemoryTrust,
    }),
    vehicles: Array.isArray(migrated.vehicles) ? migrated.vehicles : [],
    trips,
    warnings,
    truncatedNoteTripCount,
  };
}

export function parseDriveSenseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Backup file is not valid JSON. Please select the correct file.');
  }
  return parseDriveSenseBackupValue(parsed);
}

export async function importDriveSenseBackup(
  file,
  {
    includeSettings = true,
    acknowledgeTruncation = false,
    passphrase = null,
    allowUnverifiedSignedBackup = false,
    signal,
    onProgress,
  } = {}
) {
  throwIfBackupAborted(signal);
  // Preserve the device's current privacy boundary even if importing settings
  // later changes which zone definitions are retained from the backup.
  let activePrivacyZonesAtImport;
  try {
    activePrivacyZonesAtImport = await getHydratedPrivacyZones();
    if (!Array.isArray(activePrivacyZonesAtImport)) {
      throw new Error('Privacy-zone hydration returned invalid data.');
    }
  } catch (error) {
    logSystemFailure('backup_import_privacy_zone_hydration', error, {});
    throw new Error(
      'Road Sage could not securely load your privacy zones, so the backup was not imported.'
    );
  }
  if (Number(file?.size) > MAX_BACKUP_BYTES) {
    recordSystemEvent('backup_import_rejected', {
      reason: 'file_too_large',
      byte_count: Number(file?.size) || 0,
      max_bytes: MAX_BACKUP_BYTES,
    }, { category: 'storage', severity: 'warn', title: 'Backup import rejected' });
    throw new Error(BACKUP_TOO_LARGE_MESSAGE);
  }
  recordSystemEvent('backup_import_started', {
    byte_count: Number(file?.size) || 0,
    include_settings: includeSettings !== false,
    acknowledge_truncation: acknowledgeTruncation === true,
  }, { category: 'storage', title: 'Backup import started' });
  onProgress?.({ phase: 'reading', completed: 0, total: Number(file?.size) || 0 });
  let text = '';
  try {
    text = await file.text();
    throwIfBackupAborted(signal);
    onProgress?.({ phase: 'reading', completed: Number(file?.size) || text.length, total: Number(file?.size) || text.length });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    logSystemFailure('backup_import_read', error, {
      byte_count: Number(file?.size) || 0,
    });
    throw error;
  }

  let parsedInput;
  try {
    parsedInput = JSON.parse(text);
  } catch {
    throw new Error('Backup file is not valid JSON. Please select the correct file.');
  }
  const encrypted = isEncryptedBackupEnvelope(parsedInput);
  recordSystemEvent('backup_import_format_detected', {
    byte_count: Number(file?.size) || text.length || 0,
    encrypted,
    input_format: encrypted ? 'encrypted' : 'json',
  }, { category: 'storage', title: 'Backup import format detected' });
  let backupValue = parsedInput;
  if (encrypted) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      recordSystemEvent('backup_import_password_required', {
        byte_count: Number(file?.size) || text.length || 0,
        encrypted: true,
      }, {
        category: 'storage',
        severity: 'warn',
        title: 'Backup password required',
        message: 'Encrypted backup import is waiting for a password.',
      });
      const error = /** @type {Error & { code: string }} */ (
        new Error('This backup is encrypted. Enter the backup password to import it.')
      );
      error.code = BACKUP_PASSWORD_REQUIRED_CODE;
      throw error;
    }
    try {
      const decryptedText = await decryptBackupText(parsedInput, passphrase, {
        maxDecompressedBytes: MAX_BACKUP_DECOMPRESSED_BYTES,
        signal,
        onProgress,
      });
      throwIfBackupAborted(signal);
      try {
        backupValue = JSON.parse(decryptedText);
      } catch {
        throw new Error('Decrypted backup is not valid JSON. The file may be damaged.');
      }
      text = '';
      parsedInput = null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
      const wrongPassword = errorCode === BACKUP_WRONG_PASSWORD_CODE;
      recordSystemEvent(wrongPassword ? 'backup_import_wrong_password' : 'backup_import_decrypt_failed', {
        byte_count: Number(file?.size) || text.length || 0,
        encrypted: true,
        error_code: errorCode || 'decrypt_failed',
      }, {
        category: 'storage',
        severity: wrongPassword ? 'warn' : 'error',
        title: wrongPassword ? 'Backup password rejected' : 'Operation failed: backup_import_decrypt',
        message: wrongPassword
          ? 'Encrypted backup import was not unlocked.'
          : 'Encrypted backup could not be decrypted.',
      });
      throw error;
    }
    recordSystemEvent('backup_import_decrypted', {
      byte_count: Number(file?.size) || text.length || 0,
      encrypted: true,
    }, { category: 'storage', title: 'Backup decrypted' });
  }

  let signed = false;
  let signatureVerified = false;
  let signatureSignedAt = null;
  let signatureRecovered = false;
  if (isSignedExportEnvelope(backupValue)) {
    signed = true;
    const signedExport = backupValue;
    try {
      onProgress?.({ phase: 'verifying', completed: 0, total: 1 });
      const verified = await verifyAndUnwrapExport(signedExport);
      throwIfBackupAborted(signal);
      backupValue = verified.payload;
      signatureVerified = true;
      signatureSignedAt = verified.signedAt;
      onProgress?.({ phase: 'verifying', completed: 1, total: 1 });
      recordSystemEvent('backup_import_signature_verified', {
        byte_count: Number(file?.size) || 0,
        encrypted,
        signed: true,
        signed_at: signatureSignedAt,
      }, { category: 'storage', title: 'Backup signature verified' });
    } catch (error) {
      recordSystemEvent('backup_import_signature_rejected', {
        byte_count: Number(file?.size) || 0,
        encrypted,
        signed: true,
      }, {
        category: 'storage',
        severity: 'error',
        title: 'Backup signature rejected',
        message: 'Backup import stopped before writing data because the signature was invalid.',
      });
      if (!allowUnverifiedSignedBackup) {
        error.code = BACKUP_SIGNATURE_INVALID_CODE;
        throw error;
      }
      backupValue = signedExport.payload;
      signatureSignedAt = signedExport.signed_at || null;
      signatureRecovered = true;
      recordSystemEvent('backup_import_signature_recovery_accepted', {
        byte_count: Number(file?.size) || 0,
        encrypted,
        signed: true,
        signed_at: signatureSignedAt,
      }, {
        category: 'storage',
        severity: 'warn',
        title: 'Backup signature recovery accepted',
        message: 'Readable backup payload imported after explicit user confirmation.',
      });
    }
  } else {
    recordSystemEvent('backup_import_unsigned_legacy', {
      byte_count: Number(file?.size) || text.length || 0,
      encrypted,
      signed: false,
    }, {
      category: 'storage',
      severity: 'warn',
      title: 'Unsigned backup import',
      message: 'Legacy backup import continued without an export signature.',
    });
  }

  let backup;
  try {
    throwIfBackupAborted(signal);
    onProgress?.({ phase: 'validating', completed: 0, total: 1 });
    backup = parseDriveSenseBackupValue(backupValue, {
      sanitizeTrips: false,
      preserveRoadMemoryTrust: signatureVerified,
    });
    backup.speed_knowledge = sanitizeSpeedKnowledge(
      backup.speed_knowledge,
      activePrivacyZonesAtImport,
      backup.warnings,
      { preserveRoadMemoryTrust: signatureVerified }
    );
    const roadMemoryTrustReset = !signatureVerified &&
      backup.speed_knowledge.roadMemory.candidates.length > 0;
    if (roadMemoryTrustReset) {
      backup.warnings.push(
        'Imported Road Memory corridors were kept for local relearning, but their prior votes and review calibration were reset because this backup was not verified on this device.'
      );
    }
    const tripConsensusTrustReset = !signatureVerified && Object.values(
      backup.speed_knowledge.cells || {}
    ).some((cell) => cell?.source === 'trip_consensus');
    if (tripConsensusTrustReset) {
      backup.warnings.push(
        'Imported learned speed cells were kept only as shadow relearning hints. Their prior trip counts and confidence were reset because this backup was not verified on this device; they cannot affect scores or alerts until fresh local drives revalidate them.'
      );
    }
    const postedCorrectionTrustReset = !signatureVerified && backup.speed_knowledge.corrections
      .filter((correction) => correction?.importTrustState === 'posted_reconfirmation_required')
      .length;
    if (postedCorrectionTrustReset) {
      backup.warnings.push(
        `${postedCorrectionTrustReset} imported posted-sign rule${postedCorrectionTrustReset === 1 ? ' was' : 's were'} downgraded to an estimate because this backup was not verified on this device. Confirm the posted sign while parked before it receives posted-sign authority.`
      );
    }
    backup.roadMemoryTrustReset = roadMemoryTrustReset;
    backup.tripConsensusTrustReset = tripConsensusTrustReset;
    backup.postedCorrectionTrustReset = postedCorrectionTrustReset;
    backupValue = null;
    onProgress?.({ phase: 'validating', completed: 1, total: 1 });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    logSystemFailure('backup_import_parse', error, {
      byte_count: Number(file?.size) || text.length || 0,
      encrypted,
      signed,
    });
    throw error;
  }
  if (backup.truncatedNoteTripCount > 0 && !acknowledgeTruncation) {
    recordSystemEvent('backup_import_needs_acknowledgement', {
      truncated_note_trip_count: backup.truncatedNoteTripCount,
      truncated_fields: backup.warnings.length,
    }, { category: 'storage', severity: 'warn', title: 'Backup import needs acknowledgement' });
    return {
      requiresAcknowledgement: true,
      truncatedNoteTripCount: backup.truncatedNoteTripCount,
      warnings: backup.warnings,
      truncatedFields: backup.warnings.length,
    };
  }

  throwIfBackupAborted(signal);
  onProgress?.({ phase: 'restoring_vehicles', completed: 0, total: backup.vehicles.length });
  const importedVehicles = await vehicleService.upsertMany(backup.vehicles);
  onProgress?.({ phase: 'restoring_vehicles', completed: importedVehicles.length, total: backup.vehicles.length });

  let importedTripCount = 0;
  const totalTripCount = backup.trips.length;
  try {
    for (let start = 0; start < totalTripCount; start += IMPORT_TRIP_BATCH_SIZE) {
      throwIfBackupAborted(signal);
      const end = Math.min(totalTripCount, start + IMPORT_TRIP_BATCH_SIZE);
      const batch = [];
      for (let index = start; index < end; index += 1) {
        batch.push(sanitizeImportedTrip(backup.trips[index], backup.warnings));
        backup.trips[index] = null;
      }
      const importedBatch = await tripService.upsertMany(batch);
      importedTripCount += importedBatch.length;
      onProgress?.({ phase: 'restoring_trips', completed: importedTripCount, total: totalTripCount });
      await yieldBackupWork();
    }
  } catch (error) {
    if (importedTripCount > 0) {
      error.importedTripCount = importedTripCount;
      error.message = `${error.message || 'Backup import stopped.'} ${importedTripCount} of ${totalTripCount} trips were restored; retrying the same backup is safe.`;
    }
    throw error;
  }

  const shouldImportSettings = includeSettings && !signatureRecovered;
  const privacyZonesNeedReconfiguration = shouldImportSettings && Array.isArray(backup.settings?.privacy_zones)
    ? backup.settings.privacy_zones.filter((zone) => zone && typeof zone === 'object').length
    : 0;

  let importedSettings = false;
  if (shouldImportSettings && backup.settings) {
    const sanitizedSettings = sanitizeImportedSettings(backup.settings);
    importedSettings = Object.keys(sanitizedSettings).length > 0;
    if (importedSettings) localSettings.update(sanitizedSettings);
  }

  const savedFilters = sanitizeSavedTripFilters(backup.ui?.saved_trip_filters);
  let savedFiltersRestored = false;
  if (savedFilters.length > 0) {
    try {
      await setJson(SAVED_FILTERS_KEY, savedFilters);
      savedFiltersRestored = true;
    } catch (error) {
      logSystemFailure('backup_import_saved_filters_restore', error, {
        saved_filter_count: savedFilters.length,
      });
      console.warn('Could not restore saved trip filters from backup.', error);
    }
  }

  let calibrationLabelsRestored = false;
  if (backup.calibration.labels.length > 0 || Object.keys(backup.calibration.survey_markers).length > 0) {
    try {
      await localCalibrationLabelRepository.replaceAll(backup.calibration.labels);
      await localCalibrationLabelRepository.replaceTripSurveyMarkers(backup.calibration.survey_markers);
      calibrationLabelsRestored = true;
    } catch (error) {
      logSystemFailure('backup_import_calibration_labels_restore', error, {
        calibration_label_count: backup.calibration.labels.length,
        calibration_marker_count: Object.keys(backup.calibration.survey_markers).length,
      });
      console.warn('Could not restore calibration labels from backup.', error);
    }
  }

  const speedKnowledgeCellCount = Object.keys(backup.speed_knowledge?.cells || {}).length;
  const speedKnowledgeCorrectionCount = Array.isArray(backup.speed_knowledge?.corrections)
    ? backup.speed_knowledge.corrections.length
    : 0;
  const roadMemoryCandidateCount = Array.isArray(backup.speed_knowledge?.roadMemory?.candidates)
    ? backup.speed_knowledge.roadMemory.candidates.length
    : 0;
  const excludedSpeedSectionCount = Array.isArray(backup.speed_knowledge?.excludedSections)
    ? backup.speed_knowledge.excludedSections.length
    : 0;
  let speedKnowledgeRestored = false;
  let speedKnowledgeTripsRecalculated = 0;
  let speedKnowledgeTripsQueued = 0;
  let speedKnowledgeTripsAffected = 0;
  let speedKnowledgeTargetRevision = null;
  let speedKnowledgeRescoreFailed = false;
  if (
    backup.speedKnowledgeIncluded === true ||
    speedKnowledgeCellCount > 0 ||
    speedKnowledgeCorrectionCount > 0 ||
    roadMemoryCandidateCount > 0 ||
    excludedSpeedSectionCount > 0
  ) {
    let beforeSpeedKnowledge = {};
    try {
      beforeSpeedKnowledge = (await readSpeedKnowledgeData()) || {};
    } catch (error) {
      // Comparing from an empty baseline can over-select work, but it cannot
      // leave a trip stale. The durable post-write snapshot below is required.
      logSystemFailure('backup_import_speed_knowledge_before_read', error, {});
    }
    try {
      await replaceSpeedKnowledgeData(backup.speed_knowledge);
      speedKnowledgeRestored = true;
    } catch (error) {
      logSystemFailure('backup_import_speed_knowledge_restore', error, {
        speed_knowledge_cell_count: speedKnowledgeCellCount,
        speed_knowledge_correction_count: speedKnowledgeCorrectionCount,
        road_memory_candidate_count: roadMemoryCandidateCount,
        excluded_speed_section_count: excludedSpeedSectionCount,
      });
      console.warn('Could not restore speed knowledge from backup.', error);
    }
    if (speedKnowledgeRestored) {
      try {
        const afterSpeedKnowledge = await readSpeedKnowledgeData();
        if (!afterSpeedKnowledge || typeof afterSpeedKnowledge !== 'object') {
          throw new Error('Restored speed knowledge could not be read back from durable storage.');
        }
        const durableRevision = Number(afterSpeedKnowledge.knowledgeRevision);
        speedKnowledgeTargetRevision = Number.isFinite(durableRevision) ? durableRevision : null;
        const refreshedTrips = await refreshTripsForLocalSpeedKnowledgeChanges(
          beforeSpeedKnowledge,
          afterSpeedKnowledge
        );
        speedKnowledgeTripsRecalculated = refreshedTrips.length;
        speedKnowledgeTripsQueued = Math.max(
          0,
          Number(Reflect.get(refreshedTrips, 'queuedTripCount')) || 0
        );
        speedKnowledgeTripsAffected = Math.max(
          speedKnowledgeTripsRecalculated + speedKnowledgeTripsQueued,
          Number(Reflect.get(refreshedTrips, 'totalAffectedTripCount')) || 0
        );
        const refreshRevision = Number(Reflect.get(refreshedTrips, 'targetKnowledgeRevision'));
        if (Number.isFinite(refreshRevision)) speedKnowledgeTargetRevision = refreshRevision;
      } catch (error) {
        speedKnowledgeRescoreFailed = true;
        speedKnowledgeTripsRecalculated = null;
        speedKnowledgeTripsQueued = null;
        speedKnowledgeTripsAffected = null;
        logSystemFailure('backup_import_speed_knowledge_rescore', error, {
          target_knowledge_revision: speedKnowledgeTargetRevision,
        });
        backup.warnings.push(
          'Saved road speeds were restored, but affected trip scores could not be recalculated right now. Their recalculation status is unknown; retry from Saved road speeds before relying on those scores.'
        );
      }
    }
  }

  recordSystemEvent('backup_import_completed', {
    trip_count: importedTripCount,
    vehicle_count: importedVehicles.length,
    settings_imported: importedSettings,
    saved_filter_count: savedFilters.length,
    saved_filters_restored: savedFiltersRestored,
    calibration_label_count: backup.calibration.labels.length,
    calibration_labels_restored: calibrationLabelsRestored,
    speed_knowledge_cell_count: speedKnowledgeCellCount,
    speed_knowledge_correction_count: speedKnowledgeCorrectionCount,
    road_memory_candidate_count: roadMemoryCandidateCount,
    excluded_speed_section_count: excludedSpeedSectionCount,
    speed_knowledge_restored: speedKnowledgeRestored,
    speed_knowledge_trips_recalculated: speedKnowledgeTripsRecalculated,
    speed_knowledge_trips_queued: speedKnowledgeTripsQueued,
    speed_knowledge_trips_affected: speedKnowledgeTripsAffected,
    speed_knowledge_target_revision: speedKnowledgeTargetRevision,
    speed_knowledge_rescore_failed: speedKnowledgeRescoreFailed,
    warning_count: backup.warnings.length,
    truncated_note_trip_count: backup.truncatedNoteTripCount,
    privacy_zones_need_reconfiguration: privacyZonesNeedReconfiguration,
    source_version: backup.sourceVersion,
    backup_version: backup.version,
    encrypted,
    signed,
    signature_verified: signatureVerified,
    signature_recovered: signatureRecovered,
    road_memory_trust_reset: backup.roadMemoryTrustReset === true,
    trip_consensus_trust_reset: backup.tripConsensusTrustReset === true,
    posted_correction_trust_reset: Number(backup.postedCorrectionTrustReset) || 0,
    settings_skipped_for_signature_recovery: signatureRecovered && includeSettings,
    signature_signed_at: signatureSignedAt,
  }, {
    category: 'storage',
    severity: backup.warnings.length || privacyZonesNeedReconfiguration ? 'warn' : 'info',
    title: 'Backup import completed',
  });
  return {
    trips: importedTripCount,
    vehicles: importedVehicles.length,
    settings: importedSettings,
    savedFilters: savedFilters.length,
    savedFiltersRestored,
    calibrationLabels: backup.calibration.labels.length,
    calibrationLabelsRestored,
    speedKnowledgeCells: speedKnowledgeCellCount,
    speedKnowledgeCorrections: speedKnowledgeCorrectionCount,
    roadMemoryCandidates: roadMemoryCandidateCount,
    excludedSpeedSections: excludedSpeedSectionCount,
    speedKnowledgeRestored,
    speedKnowledgeTripsRecalculated,
    speedKnowledgeTripsQueued,
    speedKnowledgeTripsAffected,
    speedKnowledgeTargetRevision,
    speedKnowledgeRescoreFailed,
    warnings: backup.warnings,
    truncatedFields: backup.warnings.length,
    truncatedNoteTripCount: backup.truncatedNoteTripCount,
    privacy_zones_need_reconfiguration: privacyZonesNeedReconfiguration,
    signatureVerified,
    signatureRecovered,
    roadMemoryTrustReset: backup.roadMemoryTrustReset === true,
    tripConsensusTrustReset: backup.tripConsensusTrustReset === true,
    postedCorrectionTrustReset: Number(backup.postedCorrectionTrustReset) || 0,
    settingsSkippedForSignatureRecovery: signatureRecovered && includeSettings,
  };
}
