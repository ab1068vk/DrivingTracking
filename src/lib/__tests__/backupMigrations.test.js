import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_MIGRATIONS,
  BACKUP_VERSION,
  MAX_IMPORTED_TRIP_NOTES_LENGTH,
  importDriveSenseBackup,
  migrateBackup,
  parseDriveSenseBackup,
} from '@/lib/dataBackup';

vi.mock('@/api/trips', () => ({
  tripService: {
    upsertMany: vi.fn(async (trips) => trips),
  },
}));

vi.mock('@/api/vehicles', () => ({
  vehicleService: {
    upsertMany: vi.fn(async (vehicles) => vehicles),
  },
}));

const minimalBackup = (version, trip = {}) => ({
  app: 'Road Sage',
  version,
  trips: [{
    id: `trip-v${version}`,
    status: 'completed',
    start_time: '2026-01-01T12:00:00.000Z',
    end_time: '2026-01-01T12:10:00.000Z',
    ...trip,
  }],
});

const backupFile = (backup) => ({
  size: JSON.stringify(backup).length,
  text: vi.fn(async () => JSON.stringify(backup)),
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('backup migrations', () => {
  it('applies every registered backup migration step from v1 through v6', () => {
    let backup = minimalBackup(1);

    BACKUP_MIGRATIONS.forEach((step) => {
      expect(backup.version ?? step.from).toBe(step.from);
      backup = { ...step.migrate(backup), version: step.to };
      expect(backup.version).toBe(step.to);
    });

    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.vehicles).toEqual([]);
    expect(backup.ui.saved_trip_filters).toEqual([]);
    expect(backup.trips[0]).toMatchObject({
      route_points: [],
      driving_events: [],
      event_feedback: {},
      needs_rescore: true,
    });
  });

  it('relabels lane_change events to heading_deviation_legacy at v6', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify(minimalBackup(5, {
      distance_km: 12,
      lane_changes_count: 2,
      driving_events: [
        { type: 'lane_change', severity: 'medium', timestamp: '2026-01-01T12:05:00.000Z' },
        { type: 'speeding', severity: 'low' },
      ],
    })));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.trips[0].driving_events[0]).toMatchObject({
      type: 'heading_deviation_legacy',
      legacy_renamed: true,
    });
    expect(parsed.trips[0].driving_events[1].type).toBe('speeding');
    expect(parsed.trips[0].lane_changes_count).toBeUndefined();
    expect(parsed.trips[0].heading_deviation_legacy_count).toBe(1);
    expect(parsed.trips[0].heading_deviation_count).toBe(0);
  });

  it('requires confirmation before truncating imported notes and reports the count', async () => {
    const file = backupFile(minimalBackup(BACKUP_VERSION, {
      notes: 'x'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH + 5),
    }));

    const pending = await importDriveSenseBackup(file);
    expect(pending).toMatchObject({
      requiresAcknowledgement: true,
      truncatedNoteTripCount: 1,
      truncatedFields: 1,
    });
    expect(pending.warnings[0]).toContain('notes');
  });

  it('rejects v7 and newer backups with an update-required error', () => {
    expect(() => migrateBackup(minimalBackup(BACKUP_VERSION + 1), BACKUP_VERSION + 1))
      .toThrow(`backup v${BACKUP_VERSION + 1}, this app supports up to v${BACKUP_VERSION}`);
  });
});
