import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';
import { getPrivacyZones, maskTripForPrivacy } from '@/lib/privacyZones';

const BACKUP_VERSION = 5;
const SAVED_FILTERS_KEY = 'road_sage_trip_filter_presets';
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORTED_TRIP_ROUTE_POINTS = 5000;
export const MAX_IMPORTED_TRIP_DRIVING_EVENTS = 500;

const safeFilename = (filename) => filename.replace(/[\\/:*?"<>|]+/g, '-');
const filterString = (value, fallback = '') => (
  typeof value === 'string' ? value.slice(0, 120) : fallback
);

const IMPORTED_TRIP_STATUS = new Set(['completed', 'discarded']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_IMPORTED_NESTED_ARRAY_ITEMS = 500;
const MAX_IMPORTED_NESTED_OBJECT_KEYS = 100;
const MAX_IMPORTED_STRING_LENGTH = 5000;

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
  'distance_km',
  'avg_speed_kmh',
  'avg_running_speed_kmh',
  'max_speed_kmh',
  'total_idle_seconds',
  'idle_periods_count',
  'night_driving',
  'road_type',
  'speed_zones',
  'score_overall',
  'score_safety',
  'score_smoothness',
  'score_eco',
  'harsh_brakes_count',
  'rapid_accel_count',
  'sharp_turns_count',
  'speeding_events_count',
  'lane_changes_count',
  'lane_changes_per_10km',
  'tailgate_cycle_count',
  'following_distance_score',
  'distraction_events_count',
  'distraction_score',
  'near_miss_count',
  'near_miss_score',
  'overtake_event_count',
  'overtake_score',
  'intersection_score',
  'jerk_score',
  'eco_driving_score',
  'speed_variability_index',
  'fuel_band_score',
  'smooth_braking_ratio',
  'engine_stress_score',
  'trip_tire_wear_units',
  'drowsy_risk_level',
  'drowsy_score',
  'hill_score',
  'parking_approach_score',
  'reaction_score',
  'avg_reaction_seconds',
  'reaction_grade',
  'reaction_sample_count',
  'cornering_consistency_score',
  'cornering_grade',
  'mean_lateral_g',
  'peak_lateral_g',
  'corner_sample_count',
  'braking_efficiency_score',
  'braking_efficiency_grade',
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
  'overtake_quality_score',
  'overtake_quality_grade',
  'overtake_count',
  'unsafe_reentry_count',
  'slippery_proxy',
  'wet_signal_count',
  'wet_ratio',
  'safety_condition_bonus',
  'avg_distance_ratio',
  'aggressive_driving_score',
  'aggressive_grade',
  'defensive_driving_score',
  'defensive_grade',
  'phone_proxy_risk',
  'native_phone_proxy_count',
  'phone_use_events',
  'phone_use_window_count',
  'phone_use_total_seconds',
  'phone_use_risk',
  'phone_use_score',
  'phone_use_pct_of_trip',
  'phone_use_high_confidence_count',
  'native_phone_usage_events',
  'native_phone_usage_event_count',
  'native_phone_usage_total_seconds',
  'native_phone_usage_access_granted',
  'fuel_cost',
  'fuel_used_liters',
  'fuel_saved_liters',
  'fuel_price_per_liter',
  'co2_kg',
  'co2_saved_kg',
  'fatigue_progression',
  'segment_scores',
  'map_matching_status',
  'map_matching_provider',
  'speed_limit_context',
  'weather_context',
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
  'start_time',
  'end_time',
  'start_index',
  'end_index',
  'road_type',
  'message',
  'label',
]);

const isPlainObject = (value) => (
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const sanitizeJsonValue = (value, depth = 0) => {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_IMPORTED_STRING_LENGTH);
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_IMPORTED_NESTED_ARRAY_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DANGEROUS_OBJECT_KEYS.has(key))
      .slice(0, MAX_IMPORTED_NESTED_OBJECT_KEYS)
      .map(([key, item]) => [key, sanitizeJsonValue(item, depth + 1)])
      .filter(([, item]) => item !== undefined)
  );
};

const sanitizeWhitelistedObject = (value, allowedFields) => {
  if (!isPlainObject(value)) return null;
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedFields.has(key)) continue;
    const next = sanitizeJsonValue(item);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
};

export function sanitizeImportedTrip(trip) {
  if (!isPlainObject(trip)) {
    throw new Error('Backup contains an invalid trip record.');
  }

  const id = filterString(trip.id).trim();
  if (!id) {
    throw new Error('Backup contains a trip without a valid id.');
  }

  const sanitized = sanitizeWhitelistedObject(trip, IMPORTED_TRIP_FIELDS);
  sanitized.id = id;
  sanitized.status = IMPORTED_TRIP_STATUS.has(trip.status) ? trip.status : 'completed';
  sanitized.route_points = Array.isArray(trip.route_points)
    ? trip.route_points
      .slice(0, MAX_IMPORTED_TRIP_ROUTE_POINTS)
      .map((point) => sanitizeWhitelistedObject(point, IMPORTED_ROUTE_POINT_FIELDS))
      .filter(Boolean)
    : [];
  sanitized.driving_events = Array.isArray(trip.driving_events)
    ? trip.driving_events
      .slice(0, MAX_IMPORTED_TRIP_DRIVING_EVENTS)
      .map((event) => sanitizeWhitelistedObject(event, IMPORTED_DRIVING_EVENT_FIELDS))
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

export function buildDriveSenseBackup({ trips = [], vehicles = [], settings = localSettings.get() } = {}) {
  let savedTripFilters = [];
  try {
    savedTripFilters = sanitizeSavedTripFilters(JSON.parse(localStorage.getItem(SAVED_FILTERS_KEY) || '[]'));
  } catch {}
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
  const backup = buildDriveSenseBackup({ trips, vehicles, settings });
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

  return {
    version: parsed.version || 0,
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : null,
    ui: parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : null,
    vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : [],
    trips: parsed.trips.map(sanitizeImportedTrip),
  };
}

export async function importDriveSenseBackup(file, { includeSettings = true } = {}) {
  if (Number(file?.size) > MAX_BACKUP_BYTES) {
    throw new Error('Backup file is too large. Please choose a Road Sage JSON backup under 50 MB.');
  }
  const text = await file.text();
  const backup = parseDriveSenseBackup(text);

  const importedVehicles = await vehicleService.upsertMany(backup.vehicles);
  const tripsToImport = backup.version < 4
    ? backup.trips.map((trip) => ({ ...trip, needs_rescore: true }))
    : backup.trips;
  const importedTrips = await tripService.upsertMany(tripsToImport);

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
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(savedFilters));
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
    privacy_zones_need_reconfiguration: privacyZonesNeedReconfiguration,
  };
}
