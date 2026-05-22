import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';
import { getPrivacyZones, maskTripForPrivacy } from '@/lib/privacyZones';

const BACKUP_VERSION = 5;
const SAVED_FILTERS_KEY = 'road_sage_trip_filter_presets';
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

const safeFilename = (filename) => filename.replace(/[\\/:*?"<>|]+/g, '-');
const filterString = (value, fallback = '') => (
  typeof value === 'string' ? value.slice(0, 120) : fallback
);

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
    trips: parsed.trips,
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
