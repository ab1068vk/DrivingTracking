export const STORAGE_KEY_MIGRATION_DONE_KEY = 'road_sage_key_migration_v1_done';

export const STORAGE_KEY_RENAMES = Object.freeze({
  drivesense_active_trip: 'road_sage_active_trip',
  drivesense_settings: 'road_sage_settings',
  drivesense_last_parked: 'road_sage_last_parked',
  drivesense_trips: 'road_sage_trips',
  drivesense_vehicles: 'road_sage_vehicles',
  drivesense_driver_signature: 'road_sage_driver_signature',
  drivesense_danger_zones: 'road_sage_danger_zones',
  drivesense_route_risk_index: 'road_sage_route_risk_index',
  drivesense_calibration_profile: 'road_sage_calibration_profile',
  drivesense_indexeddb_name: 'road_sage_indexeddb_name',
  drivesense_trip_event_migration_version: 'road_sage_trip_event_migration_version',
  drivesense_heading_event_migration_note_dismissed: 'road_sage_heading_event_migration_note_dismissed',
  drivesense_dismissed_tag_suggestions: 'road_sage_dismissed_tag_suggestions',
  drivesense_first_launch_permission_prompted: 'road_sage_first_launch_permission_prompted',
  drivesense_map_matching_cache_v2: 'road_sage_map_matching_cache_v2',
  drivesense_osm_speed_limit_cache_v2: 'road_sage_osm_speed_limit_cache_v2',
  drivesense_open_meteo_weather_cache_v1: 'road_sage_open_meteo_weather_cache_v1',
  drivesense_tracking_diagnostics: 'road_sage_tracking_diagnostics',
  drivesense_notified_achievements: 'road_sage_notified_achievements',
  drivesense_achievement_notification_ids_v1: 'road_sage_achievement_notification_ids_v1',
  drivesense_notification_dedupe_v1: 'road_sage_notification_dedupe_v1',
  drivesense_phone_notif_last_ms: 'road_sage_phone_notif_last_ms',
  drivesense_heading_drift_notif_last_ms: 'road_sage_heading_drift_notif_last_ms',
  drivesense_speeding_notif_last_ms: 'road_sage_speeding_notif_last_ms',
  drivesense_fatigue_notif_trip_id: 'road_sage_fatigue_notif_trip_id',
  drivesense_phone_pattern_last_ms: 'road_sage_phone_pattern_last_ms',
});

const NEW_TO_OLD_STORAGE_KEYS = Object.freeze(
  Object.fromEntries(Object.entries(STORAGE_KEY_RENAMES).map(([oldKey, newKey]) => [newKey, oldKey]))
);

const safeLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

export function resolveStorageKey(key) {
  return STORAGE_KEY_RENAMES[key] ?? key;
}

export function legacyStorageKeysFor(key) {
  const legacyKey = NEW_TO_OLD_STORAGE_KEYS[key] ?? key;
  const currentKey = resolveStorageKey(key);
  return legacyKey !== currentKey ? [legacyKey] : [];
}

function copyLocalStorageKey(storage, oldKey, newKey) {
  if (storage.getItem(newKey) !== null) return false;
  const value = storage.getItem(oldKey);
  if (value === null) return false;

  storage.setItem(newKey, value);
  storage.setItem(`${oldKey}__migrated_to__${newKey}`, '1');
  return true;
}

async function copyNativePreferenceKey(Preferences, encryptedCapacitorStorage, oldKey, newKey) {
  const current = await encryptedCapacitorStorage.get({ key: newKey });
  if (current.value !== null) return false;

  const legacy = await Preferences.get({ key: oldKey });
  if (legacy.value === null) return false;

  await encryptedCapacitorStorage.set({ key: newKey, value: legacy.value });
  await Preferences.remove({ key: oldKey });
  return true;
}

export async function runStorageKeyMigration() {
  const storage = safeLocalStorage();
  const localStorageMigrationDone = Boolean(storage?.getItem(STORAGE_KEY_MIGRATION_DONE_KEY));

  let migrated = false;
  if (storage && !localStorageMigrationDone) {
    Object.entries(STORAGE_KEY_RENAMES).forEach(([oldKey, newKey]) => {
      migrated = copyLocalStorageKey(storage, oldKey, newKey) || migrated;
    });
    storage.setItem(STORAGE_KEY_MIGRATION_DONE_KEY, '1');
  }

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return migrated;

    const { encryptedCapacitorStorage } = await import('@/lib/encryptedCapacitorStorage');
    const { Preferences } = await import('@capacitor/preferences');
    const done = await encryptedCapacitorStorage.get({ key: STORAGE_KEY_MIGRATION_DONE_KEY });
    if (done.value) return migrated;

    for (const [oldKey, newKey] of Object.entries(STORAGE_KEY_RENAMES)) {
      migrated = await copyNativePreferenceKey(Preferences, encryptedCapacitorStorage, oldKey, newKey) || migrated;
    }
    await encryptedCapacitorStorage.set({ key: STORAGE_KEY_MIGRATION_DONE_KEY, value: '1' });
  } catch {
    return migrated;
  }

  return migrated;
}
