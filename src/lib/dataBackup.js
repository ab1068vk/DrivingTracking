import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';
import { getPrivacyZones, maskTripForPrivacy } from '@/lib/privacyZones';
import { getJson, setJson } from '@/lib/mobileStorage';
import { SAVED_FILTERS_KEY } from '@/lib/appConstants';

/*
 * Backup schema history:
 * v1: trips, vehicles, and settings base export.
 * v2: UI payload added for saved trip filters.
 * v3: route/event metadata and reviewed event feedback persisted.
 * v4: scoring schema refresh; older imported trips require rescoring.
 * v5: privacy-safe zone metadata and hardened import sanitization.
 * v6: legacy lane_change events are relabelled as heading_deviation_legacy.
 *
 * Every import is migrated one version at a time before it is sanitized and
 * merged. Coordinates omitted for privacy zones are intentionally not restored.
 */
export const BACKUP_VERSION = 6;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const BACKUP_TOO_LARGE_MESSAGE = 'Backup file is too large. Please choose a Road Sage JSON backup that is 50 MB or smaller.';
export const MAX_IMPORTED_TRIP_ROUTE_POINTS = 5000;
export const MAX_IMPORTED_TRIP_DRIVING_EVENTS = 500;
export const MAX_IMPORTED_STRING_LENGTH = 5000;
export const MAX_IMPORTED_TRIP_NOTES_LENGTH = 10000;

const safeFilename = (filename) => filename.replace(/[\\/:*?"<>|]+/g, '-');
const filterString = (value, fallback = '') => (
  typeof value === 'string' ? value.slice(0, 120) : fallback
);

const IMPORTED_TRIP_STATUS = new Set(['completed', 'discarded']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_IMPORTED_NESTED_ARRAY_ITEMS = 500;
const MAX_IMPORTED_NESTED_OBJECT_KEYS = 100;
const IMPORTED_STRING_LIMITS_BY_FIELD = {
  id: 120,
  nickname: 200,
  notes: MAX_IMPORTED_TRIP_NOTES_LENGTH,
  tag: 100,
  message: 500,
  label: 200,
};

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
  'road_type',
  'speed_zones',
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
  'score_explanation',
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
  'lane_changing_score',
  'lane_changing_score_confidence',
  'lane_changing_safety_weight',
  'lane_change_count',
  'unsafe_lane_changes',
  'lane_changing_confidence',
  'lane_change_detection_confidence',
  'lane_change_detection_method',
  'lane_change_events',
  'segment_scores',
  'hill_route',
  'map_matching_status',
  'map_matching_provider',
  'speed_limit_context',
  'weather_context',
  'weather_skipped_reason',
]);

const IMPORTED_ROUTE_POINT_FIELDS = new Set([
  'lat',
  'lng',
  'timestamp',
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
  const distanceKm = Math.max(1, Number(trip.distance_km) || 1);
  const { lane_changes_count: _laneChangesCount, lane_changes_per_10km: _laneChangesPer10Km, ...rest } = trip;
  return {
    ...rest,
    driving_events: events,
    heading_deviation_count: modernCount,
    heading_deviations_per_10km: Math.round((modernCount / distanceKm) * 100) / 10,
    heading_deviation_legacy_count: legacyCount,
    heading_deviation_legacy_per_10km: Math.round((legacyCount / distanceKm) * 100) / 10,
  };
};

export function buildDriveSenseBackup({ trips = [], vehicles = [], settings = localSettings.get(), savedFilters = [] } = {}) {
  const savedTripFilters = sanitizeSavedTripFilters(savedFilters);
  const exportSettings = {
    ...settings,
    privacy_zones: getPrivacyZones(settings).map((zone) => ({
      id: zone.id,
      label: zone.label,
      radius_m: zone.radius_m,
      masked_for_privacy: true,
    })),
  };
  return {
    app: 'Road Sage',
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    settings: exportSettings,
    ui: {
      saved_trip_filters: savedTripFilters,
    },
    vehicles,
    trips: trips.map((trip) => {
      const masked = /** @type {any} */ (maskTripForPrivacy(trip, settings));
      return {
        ...masked,
        route_points: Array.isArray(masked.route_points) ? masked.route_points : [],
        driving_events: Array.isArray(masked.driving_events) ? masked.driving_events : [],
        event_feedback: masked.event_feedback && typeof masked.event_feedback === 'object' ? masked.event_feedback : {},
      };
    }),
  };
}

/**
 * @param {{trips?:Array,vehicles?:Array,settings?:Object,filename?:string}} options
 */
export async function exportDriveSenseBackup({ trips, vehicles, settings, filename } = {}) {
  const savedFilters = await getJson(SAVED_FILTERS_KEY, []);
  const backup = buildDriveSenseBackup({ trips, vehicles, settings, savedFilters });
  const outputName = safeFilename(filename || `road-sage-full-backup-${new Date().toISOString().split('T')[0]}.json`);
  const content = JSON.stringify(backup, null, 2);
  let nativeFallbackError = null;

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const result = await saveExportToDownloads({
        filename: outputName,
        data: content,
        mimeType: 'application/json',
      });
      return { native: true, filename: outputName, uri: result.uri, backup };
    }
  } catch (error) {
    nativeFallbackError = error?.message || 'Native export failed.';
    console.warn('Native JSON export failed, falling back to browser download.', error);
  }

  const blob = new Blob([content], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outputName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { native: false, filename: outputName, backup, nativeFallback: Boolean(nativeFallbackError), nativeFallbackError };
}

export const BACKUP_MIGRATIONS = Object.freeze([
  /*
   * Migration backup v1 -> v2
   *
   * Adds: vehicles array and ui.saved_trip_filters container.
   * Removes: nothing.
   * Renames: nothing.
   * Requires rescore: no.
   *
   * After writing a backup migration, update:
   * - src/lib/schema/tripSchema.js when trip fields change
   * - BACKUP_VERSION and this migration registry
   * - backup migration tests and golden fixtures if affected
   */
  Object.freeze({
    from: 1,
    to: 2,
    migrate(data) {
      return {
        ...data,
        vehicles: Array.isArray(data.vehicles) ? data.vehicles : [],
        ui: isPlainObject(data.ui) ? data.ui : { saved_trip_filters: [] },
      };
    },
  }),
  /*
   * Migration backup v2 -> v3
   *
   * Adds: trip route_points, driving_events, event_feedback defaults.
   * Removes: nothing.
   * Renames: nothing.
   * Requires rescore: no.
   */
  Object.freeze({
    from: 2,
    to: 3,
    migrate(data) {
      return {
        ...data,
        ui: {
          ...(isPlainObject(data.ui) ? data.ui : {}),
          saved_trip_filters: Array.isArray(data.ui?.saved_trip_filters) ? data.ui.saved_trip_filters : [],
        },
        trips: (data.trips || []).map((trip) => ({
          ...trip,
          route_points: Array.isArray(trip?.route_points) ? trip.route_points : [],
          driving_events: Array.isArray(trip?.driving_events) ? trip.driving_events : [],
          event_feedback: isPlainObject(trip?.event_feedback) ? trip.event_feedback : {},
        })),
      };
    },
  }),
  /*
   * Migration backup v3 -> v4
   *
   * Adds: needs_rescore on completed trips so modern scoring fields refresh.
   * Removes: nothing.
   * Renames: nothing.
   * Requires rescore: yes.
   */
  Object.freeze({
    from: 3,
    to: 4,
    migrate(data) {
      return {
        ...data,
        trips: (data.trips || []).map((trip) => (
          trip?.status === 'discarded' ? trip : { ...trip, needs_rescore: true }
        )),
      };
    },
  }),
  /*
   * Migration backup v4 -> v5
   *
   * Adds: ui fallback container for hardened imports.
   * Removes: nothing.
   * Renames: nothing.
   * Requires rescore: no.
   */
  Object.freeze({
    from: 4,
    to: 5,
    migrate(data) {
      return {
        ...data,
        ui: isPlainObject(data.ui) ? data.ui : { saved_trip_filters: [] },
      };
    },
  }),
  /*
   * Migration backup v5 -> v6
   *
   * Adds: heading_deviation_legacy counts for retired lane-change records.
   * Removes: lane_changes_count, lane_changes_per_10km.
   * Renames: driving_events[].type lane_change -> heading_deviation_legacy.
   * Requires rescore: no; the migrated event is diagnostic only.
   */
  Object.freeze({
    from: 5,
    to: 6,
    migrate(data) {
      return {
        ...data,
        trips: (data.trips || []).map(migrateLegacyLaneChangeTrip),
      };
    },
  }),
]);

export function migrateBackup(data, fromVersion = Number(data?.version) || 1) {
  const sourceVersion = Number.isInteger(Number(fromVersion)) && Number(fromVersion) > 0 ? Number(fromVersion) : 1;
  if (sourceVersion > BACKUP_VERSION) {
    throw new Error(
      `This backup was made with a newer version of Road Sage (backup v${sourceVersion}, ` +
      `this app supports up to v${BACKUP_VERSION}). ` +
      'Update Road Sage to the latest version and try again.'
    );
  }

  let version = sourceVersion;
  let migrated = { ...data };
  while (version < BACKUP_VERSION) {
    const migration = BACKUP_MIGRATIONS.find((step) => step.from === version);
    if (!migration) throw new Error(`Missing backup migration from v${version}.`);
    migrated = migration.migrate(migrated);
    version = migration.to;
  }

  return { ...migrated, version: BACKUP_VERSION };
}

export function parseDriveSenseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Backup file is not valid JSON. Please select the correct file.');
  }

  if (!parsed || !['Road Sage', 'DriveSense'].includes(parsed.app) || !Array.isArray(parsed.trips)) {
    throw new Error('This is not a valid Road Sage backup file.');
  }

  const sourceVersion = Number(parsed.version) || 1;
  const migrated = migrateBackup(parsed, sourceVersion);
  const warnings = [];
  const truncatedNoteTripCount = migrated.trips.filter((trip) => (
    typeof trip?.notes === 'string' && trip.notes.length > MAX_IMPORTED_TRIP_NOTES_LENGTH
  )).length;

  return {
    version: migrated.version,
    sourceVersion,
    settings: migrated.settings && typeof migrated.settings === 'object' ? migrated.settings : null,
    ui: migrated.ui && typeof migrated.ui === 'object' ? migrated.ui : null,
    vehicles: Array.isArray(migrated.vehicles) ? migrated.vehicles : [],
    trips: migrated.trips.map((trip) => sanitizeImportedTrip(trip, warnings)),
    warnings,
    truncatedNoteTripCount,
  };
}

export async function importDriveSenseBackup(file, { includeSettings = true, acknowledgeTruncation = false } = {}) {
  if (Number(file?.size) > MAX_BACKUP_BYTES) {
    throw new Error(BACKUP_TOO_LARGE_MESSAGE);
  }
  const text = await file.text();
  const backup = parseDriveSenseBackup(text);
  if (backup.truncatedNoteTripCount > 0 && !acknowledgeTruncation) {
    return {
      requiresAcknowledgement: true,
      truncatedNoteTripCount: backup.truncatedNoteTripCount,
      warnings: backup.warnings,
      truncatedFields: backup.warnings.length,
    };
  }

  const importedVehicles = await vehicleService.upsertMany(backup.vehicles);
  const importedTrips = await tripService.upsertMany(backup.trips);

  const privacyZonesNeedReconfiguration = includeSettings && Array.isArray(backup.settings?.privacy_zones)
    ? backup.settings.privacy_zones.filter((zone) => (
      zone?.masked_for_privacy === true &&
      (!Number.isFinite(Number(zone.lat)) || !Number.isFinite(Number(zone.lng)))
    )).length
    : 0;

  let importedSettings = false;
  if (includeSettings && backup.settings) {
    const sanitizedSettings = sanitizeImportedSettings(backup.settings);
    localSettings.set({ ...localSettings.get(), ...sanitizedSettings });
    importedSettings = Object.keys(sanitizedSettings).length > 0;
  }

  const savedFilters = sanitizeSavedTripFilters(backup.ui?.saved_trip_filters);
  let savedFiltersRestored = false;
  if (savedFilters.length > 0) {
    try {
      await setJson(SAVED_FILTERS_KEY, savedFilters);
      savedFiltersRestored = true;
    } catch (error) {
      console.warn('Could not restore saved trip filters from backup.', error);
    }
  }

  return {
    trips: importedTrips.length,
    vehicles: importedVehicles.length,
    settings: importedSettings,
    savedFilters: savedFilters.length,
    savedFiltersRestored,
    warnings: backup.warnings,
    truncatedFields: backup.warnings.length,
    truncatedNoteTripCount: backup.truncatedNoteTripCount,
    privacy_zones_need_reconfiguration: privacyZonesNeedReconfiguration,
  };
}
