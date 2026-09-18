import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const OLD_TIME = new Date(NOW - 400 * DAY_MS).toISOString();
const RECENT_TIME = new Date(NOW - 2 * DAY_MS).toISOString();

const serviceState = vi.hoisted(() => ({
  stored: new Map(),
  preExisting: new Map(),
  restoreCalls: [],
  legacyCalls: 0,
  reconciliationCalls: 0,
  reconciliationError: null,
}));

vi.mock('@/api/trips', () => {
  const expired = (trip, retentionDays, now) => {
    if (!retentionDays) return false;
    const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(when) && when > 0 && when < now - retentionDays * DAY_MS;
  };
  return {
    tripService: {
      // Models the current broken boundary: ambient policy deletes, but attempted rows
      // are returned and therefore counted as restored.
      upsertMany: vi.fn(async (trips) => {
        serviceState.legacyCalls += 1;
        const settings = JSON.parse(globalThis.localStorage.getItem('drivesense_settings') || '{}');
        const retentionDays = Number(settings.data_retention_days || 0);
        for (const trip of trips) {
          serviceState.stored.set(String(trip.id), trip);
          if (expired(trip, retentionDays, NOW)) serviceState.stored.delete(String(trip.id));
        }
        return trips;
      }),
      // The wished-for B1 boundary. Production must select it explicitly.
      restoreBatch: vi.fn(async (trips, { retentionDays, now }) => {
        serviceState.restoreCalls.push({ trips, retentionDays, now });
        const survivingTrips = [];
        let removedByRetention = 0;
        for (const trip of trips) {
          if (expired(trip, retentionDays, now)) {
            removedByRetention += 1;
          } else {
            serviceState.stored.set(String(trip.id), trip);
            survivingTrips.push(trip);
          }
        }
        return {
          attemptedTrips: trips.length,
          survivingTrips,
          removedByRetention,
          failedWrites: 0,
          retentionPending: 0,
          status: 'complete',
        };
      }),
      stepRetentionReconciliation: vi.fn(async () => {
        serviceState.reconciliationCalls += 1;
        if (serviceState.reconciliationError) throw serviceState.reconciliationError;
        const settings = JSON.parse(globalThis.localStorage.getItem('drivesense_settings') || '{}');
        const retentionDays = Number(settings.data_retention_days || 0);
        let deletedTrips = 0;
        for (const [id, trip] of serviceState.preExisting) {
          if (expired(trip, retentionDays, NOW)) {
            serviceState.preExisting.delete(id);
            deletedTrips += 1;
          }
        }
        return { enabled: true, deletedTrips, processed: 1, examined: 1, hasMore: false };
      }),
      queryHistoryPage: vi.fn(async () => ({
        rows: [...serviceState.preExisting.values()].slice(0, 1),
        nextCursor: null,
        hasMore: serviceState.preExisting.size > 1,
      })),
      getPayloadStream: vi.fn(async () => (async function* empty() {})()),
      getById: vi.fn(async () => null),
      update: vi.fn(async (id, patch) => ({ id, ...patch })),
    },
  };
});

vi.mock('@/api/vehicles', () => ({
  vehicleService: { upsertMany: vi.fn(async (vehicles) => vehicles) },
}));

import { BACKUP_VERSION, importDriveSenseBackup } from '@/lib/dataBackup';
import { describeBackupImportResult } from '@/lib/dataBackupPresentation';
import { clearSettingsMemoryForErasure, localSettings } from '@/lib/trackingStore';

let values;

const installStorage = (retentionDays) => {
  values = new Map([['drivesense_settings', JSON.stringify({
    settings_defaults_version: 24,
    data_retention_days: retentionDays,
    raw_gps_retention_days: 0,
    privacy_zones: [],
  })]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  clearSettingsMemoryForErasure();
};

const trip = (id, time) => ({ id, status: 'completed', start_time: time, end_time: time });

const backupFile = ({ trips, retentionDays }) => ({
  size: 1024,
  text: vi.fn(async () => JSON.stringify({
    app: 'Road Sage',
    version: BACKUP_VERSION,
    vehicles: [],
    trips,
    settings: { data_retention_days: retentionDays },
  })),
});

beforeEach(() => {
  installStorage(0);
  serviceState.stored.clear();
  serviceState.preExisting.clear();
  serviceState.restoreCalls.length = 0;
  serviceState.legacyCalls = 0;
  serviceState.reconciliationCalls = 0;
  serviceState.reconciliationError = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearSettingsMemoryForErasure();
});

describe('HPR-B1 backup restore policy and result contract', () => {
  it('restores a 400-day trip when the backup explicitly adopts keep-everything', async () => {
    installStorage(30);

    const result = await importDriveSenseBackup(backupFile({
      trips: [trip('restore-old-under-zero', OLD_TIME)],
      retentionDays: 0,
    }), { now: NOW });

    expect(result).toMatchObject({
      trips: 1,
      tripsRemovedByRetention: 0,
      tripsFailedToWrite: 0,
      tripRetentionStatus: 'complete',
    });
    expect(serviceState.stored.has('restore-old-under-zero')).toBe(true);
    expect(serviceState.restoreCalls[0].retentionDays).toBe(0);
  });

  it('reports a 400-day imported trip as policy-removed under the restored 30-day setting', async () => {
    const result = await importDriveSenseBackup(backupFile({
      trips: [trip('restore-old-under-thirty', OLD_TIME)],
      retentionDays: 30,
    }), { now: NOW });

    expect(result).toMatchObject({
      trips: 0,
      tripsRemovedByRetention: 1,
      tripsFailedToWrite: 0,
      tripRetentionStatus: 'complete',
    });
    expect(serviceState.stored.has('restore-old-under-thirty')).toBe(false);
    expect(describeBackupImportResult(result)).toMatchObject({
      title: 'Import completed with warnings',
      hasIssues: true,
    });
    expect(describeBackupImportResult(result).description).toContain(
      '1 trip from the backup was outside the restored retention period and was not kept.'
    );
  });

  it.each([4, 40, 400])('uses only four-row restore batches at T=%s', async (total) => {
    const rows = Array.from({ length: total }, (_, index) => trip(`restore-scale-${index}`, RECENT_TIME));

    const result = await importDriveSenseBackup(
      backupFile({ trips: rows, retentionDays: 30 }),
      { now: NOW },
    );

    expect(result.trips).toBe(total);
    expect(serviceState.restoreCalls.map(({ trips }) => trips.length)).toEqual([
      ...Array(Math.floor(total / 4)).fill(4),
      ...(total % 4 ? [total % 4] : []),
    ]);
    expect(serviceState.legacyCalls).toBe(0);
  }, 120_000);

  it('does not reconcile pre-existing history before restored settings commit', async () => {
    serviceState.preExisting.set('pre-existing-old', trip('pre-existing-old', OLD_TIME));
    const update = vi.spyOn(localSettings, 'update').mockImplementationOnce(() => {
      throw new Error('Injected settings commit failure');
    });
    const file = backupFile({ trips: [trip('new-recent', RECENT_TIME)], retentionDays: 30 });

    await expect(importDriveSenseBackup(file, { now: NOW })).rejects.toThrow('Injected settings commit failure');

    expect(serviceState.preExisting.has('pre-existing-old')).toBe(true);
    expect(serviceState.reconciliationCalls).toBe(0);

    update.mockRestore();
    const result = await importDriveSenseBackup(file, { now: NOW });
    expect(localSettings.get().data_retention_days).toBe(30);
    expect(serviceState.preExisting.has('pre-existing-old')).toBe(false);
    expect(serviceState.reconciliationCalls).toBe(1);
    expect(result.tripRetentionReconciliation).toMatchObject({
      status: 'complete',
      deletedTrips: 1,
      hasMore: false,
    });
  });

  it('reports pending retention when post-commit bounded cleanup fails', async () => {
    serviceState.preExisting.set('pre-existing-pending', trip('pre-existing-pending', OLD_TIME));
    serviceState.reconciliationError = new Error('Injected bounded retention failure');

    const result = await importDriveSenseBackup(backupFile({
      trips: [trip('new-survivor', RECENT_TIME)],
      retentionDays: 30,
    }), { now: NOW });

    expect(localSettings.get().data_retention_days).toBe(30);
    expect(serviceState.preExisting.has('pre-existing-pending')).toBe(true);
    expect(result).toMatchObject({
      trips: 1,
      tripRetentionStatus: 'pending',
      tripRetentionReconciliation: expect.objectContaining({ status: 'pending', retryable: true }),
    });
    const report = describeBackupImportResult(result);
    expect(report.title).toBe('Import completed with warnings');
    expect(report.description).toContain('Trip retention cleanup is still pending');
  });
});
