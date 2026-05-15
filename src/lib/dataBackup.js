import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { localSettings } from '@/lib/trackingStore';

const BACKUP_VERSION = 2;

const safeFilename = (filename) => filename.replace(/[\\/:*?"<>|]+/g, '-');

export function buildDriveSenseBackup({ trips = [], vehicles = [], settings = localSettings.get() } = {}) {
  return {
    app: 'DriveSense',
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    settings,
    vehicles,
    trips: trips.map((trip) => ({
      ...trip,
      route_points: Array.isArray(trip.route_points) ? trip.route_points : [],
      driving_events: Array.isArray(trip.driving_events) ? trip.driving_events : [],
    })),
  };
}

export async function exportDriveSenseBackup({ trips, vehicles, settings, filename } = {}) {
  const backup = buildDriveSenseBackup({ trips, vehicles, settings });
  const outputName = safeFilename(filename || `drivesense-full-backup-${new Date().toISOString().split('T')[0]}.json`);
  const content = JSON.stringify(backup, null, 2);

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
  return { native: false, filename: outputName, backup };
}

export function parseDriveSenseBackup(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.app !== 'DriveSense' || !Array.isArray(parsed.trips)) {
    throw new Error('This is not a valid DriveSense backup file.');
  }

  return {
    version: parsed.version || 0,
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : null,
    vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : [],
    trips: parsed.trips,
  };
}

export async function importDriveSenseBackup(file, { includeSettings = true } = {}) {
  const text = await file.text();
  const backup = parseDriveSenseBackup(text);

  const importedVehicles = await vehicleService.upsertMany(backup.vehicles);
  const tripsToImport = backup.version < 2
    ? backup.trips.map((trip) => ({ ...trip, needs_rescore: true }))
    : backup.trips;
  const importedTrips = await tripService.upsertMany(tripsToImport);

  if (includeSettings && backup.settings) {
    localSettings.set({ ...localSettings.get(), ...backup.settings });
  }

  return {
    trips: importedTrips.length,
    vehicles: importedVehicles.length,
    settings: includeSettings && Boolean(backup.settings),
  };
}
