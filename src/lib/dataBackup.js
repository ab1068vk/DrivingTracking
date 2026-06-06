import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';
import { getPrivacyZones, maskTripForPrivacy } from '@/lib/privacyZones';
import { getJson, setJson } from '@/lib/mobileStorage';
import { SAVED_FILTERS_KEY } from '@/lib/appConstants';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

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
  recordSystemEvent('backup_export_started', {
    trip_count: Array.isArray(trips) ? trips.length : 0,
    vehicle_count: Array.isArray(vehicles) ? vehicles.length : 0,
    saved_filter_count: Array.isArray(savedFilters) ? savedFilters.length : 0,
    backup_version: BACKUP_VERSION,
  }, { category: 'storage', title: 'Backup export started' });

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const result = await saveExportToDownloads({
        filename: outputName,
        data: content,
        mimeType: 'application/json',
      });
      recordSystemEvent('backup_export_completed', {
        native: true,
        mime_type: 'application/json',
        byte_count: content.length,
        backup_version: BACKUP_VERSION,
      }, { category: 'storage', title: 'Backup export completed' });
      return { native: true, filename: outputName, uri: result.uri, backup };
    }
  } catch (error) {
    nativeFallbackError = error?.message || 'Native export failed.';
    logSystemFailure('backup_native_export', error, {
      mime_type: 'application/json',
      byte_count: content.length,
    });
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
  recordSystemEvent('backup_export_completed', {
    native: false,
    native_fallback: Boolean(nativeFallbackError),
    mime_type: 'application/json',
    byte_count: content.length,
    backup_version: BACKUP_VERSION,
  }, { category: 'storage', title: 'Backup export completed' });
  return { native: false, filename: outputName, backup, nativeFallback: Boolean(nativeFallbackError), nativeFallbackError };
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
    }
    version += 1;
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
  const text = await file.text();
  let backup;
  try {
    backup = parseDriveSenseBackup(text);
  } catch (error) {
    logSystemFailure('backup_import_parse', error, {
      byte_count: Number(file?.size) || text.length || 0,
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

  recordSystemEvent('backup_import_completed', {
    trip_count: importedTrips.length,
    vehicle_count: importedVehicles.length,
    settings_imported: importedSettings,
    saved_filter_count: savedFilters.length,
    saved_filters_restored: savedFiltersRestored,
    warning_count: backup.warnings.length,
    truncated_note_trip_count: backup.truncatedNoteTripCount,
    privacy_zones_need_reconfiguration: privacyZonesNeedReconfiguration,
    source_version: backup.sourceVersion,
    backup_version: backup.version,
  }, {
    category: 'storage',
    severity: backup.warnings.length || privacyZonesNeedReconfiguration ? 'warn' : 'info',
    title: 'Backup import completed',
  });
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
