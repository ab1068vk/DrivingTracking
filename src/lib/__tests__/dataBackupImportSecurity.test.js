import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_INTEGRITY_ERROR,
  importDriveSenseBackup,
  BACKUP_VERSION,
  countTripsOutsideRetentionWindow,
  MAX_BACKUP_BYTES,
  MAX_IMPORTED_TRIP_DRIVING_EVENTS,
  MAX_IMPORTED_TRIP_NOTES_LENGTH,
  MAX_IMPORTED_TRIP_ROUTE_POINTS,
  migrateBackup,
  parseDriveSenseBackup,
  sealPlaintextBackup,
  verifyPlaintextBackupIntegrity,
} from '@/lib/dataBackup';
import { tripService } from '@/api/trips';
import { encryptBackup } from '@/lib/backupEncryption';
import { DEFAULT_SETTINGS, localSettings } from '@/lib/trackingStore';
import { SCORING_VERSION } from '@/lib/scoringConstants';

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

const parseTrips = (trips) => parseDriveSenseBackup(JSON.stringify({
  app: 'Road Sage',
  version: 5,
  trips,
})).trips;

describe('backup trip import sanitization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localSettings.set(DEFAULT_SETTINGS);
  });

  it('rejects oversized backup files before reading them', async () => {
    const file = {
      size: MAX_BACKUP_BYTES + 1,
      text: vi.fn(),
    };

    await expect(importDriveSenseBackup(file)).rejects.toThrow('50 MB or smaller');
    expect(file.text).not.toHaveBeenCalled();
  });

  it('accepts a backup file exactly at the size limit', async () => {
    const file = {
      size: MAX_BACKUP_BYTES,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: 5,
        vehicles: [],
        trips: [],
      })),
    };

    await expect(importDriveSenseBackup(file)).resolves.toMatchObject({
      trips: 0,
      vehicles: 0,
    });
    expect(file.text).toHaveBeenCalledTimes(1);
  });

  it('accepts JSON backups with a UTF-8 BOM prefix', async () => {
    const file = {
      size: 200,
      text: vi.fn(async () => `\uFEFF${JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [{ id: 'trip-bom', status: 'completed' }],
      })}`),
    };

    await expect(importDriveSenseBackup(file)).resolves.toMatchObject({
      trips: 1,
      vehicles: 0,
    });
  });

  it('keeps older restored trips visible by disabling retention during full backup import', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-01T12:00:00.000Z').getTime());
    localSettings.set({ ...DEFAULT_SETTINGS, data_retention_months: 24 });
    const file = {
      size: 300,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        settings: { data_retention_months: 24 },
        vehicles: [],
        trips: [{
          id: 'legacy-json-trip',
          status: 'completed',
          start_time: '2020-01-01T12:00:00.000Z',
          end_time: '2020-01-01T12:20:00.000Z',
        }],
      })),
    };

    await expect(importDriveSenseBackup(file)).resolves.toMatchObject({
      trips: 1,
      retentionAutoDeleteDisabled: true,
      retentionPreservedTripCount: 1,
    });
    expect(tripService.upsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'legacy-json-trip' })]),
      { skipRetentionPrune: true, skipRescore: true }
    );
    expect(localSettings.get().data_retention_months).toBe(0);
  });

  it('counts completed trips outside the active retention window', () => {
    const now = new Date('2026-06-01T12:00:00.000Z').getTime();

    expect(countTripsOutsideRetentionWindow([
      { id: 'old-completed', status: 'completed', start_time: '2020-01-01T12:00:00.000Z' },
      { id: 'old-discarded', status: 'discarded', start_time: '2020-01-01T12:00:00.000Z' },
      { id: 'recent-completed', status: 'completed', start_time: '2026-05-01T12:00:00.000Z' },
    ], 24, now)).toBe(1);
  });

  it('sanitizes active trips from backup imports', () => {
    const [trip] = parseTrips([{ id: 'trip-active', status: 'active' }]);

    expect(trip.status).toBe('completed');
  });

  it('preserves estimated private distance on imported trips', () => {
    const [trip] = parseTrips([{
      id: 'trip-private-distance',
      status: 'completed',
      estimated_private_distance_km: 0.42,
    }]);

    expect(trip.estimated_private_distance_km).toBe(0.42);
  });

  it('truncates oversized imported trip routes', () => {
    const [trip] = parseTrips([{
      id: 'trip-huge-route',
      status: 'completed',
      route_points: Array.from({ length: 100000 }, (_, index) => ({
        lat: 43 + index / 100000,
        lng: -79,
        timestamp: `2026-05-22T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
        payload: { oversized: true },
      })),
    }]);

    expect(trip.route_points).toHaveLength(MAX_IMPORTED_TRIP_ROUTE_POINTS);
    expect(trip.route_points[0].payload).toBeUndefined();
  });

  it('truncates oversized imported driving events', () => {
    const [trip] = parseTrips([{
      id: 'trip-huge-events',
      status: 'completed',
      driving_events: Array.from({ length: 1000 }, (_, index) => ({
        type: 'harsh_brake',
        severity: 'medium',
        timestamp: `2026-05-22T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })),
    }]);

    expect(trip.driving_events).toHaveLength(MAX_IMPORTED_TRIP_DRIVING_EVENTS);
  });

  it('strips unknown fields from imported trips and driving events', () => {
    const [trip] = parseTrips([{
      id: 'trip-unknown-fields',
      status: 'completed',
      score_overall: 91,
      unknown_top_level: 'nope',
      driving_events: [{
        type: 'harsh_brake',
        severity: 'medium',
        malicious_payload: { execute: true },
      }],
    }]);

    expect(trip).toMatchObject({ id: 'trip-unknown-fields', score_overall: 91 });
    expect(trip.unknown_top_level).toBeUndefined();
    expect(trip.driving_events[0].malicious_payload).toBeUndefined();
  });

  it('preserves jerk-score confidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-jerk-confidence',
      status: 'completed',
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
    }]);

    expect(trip.jerk_score).toBeNull();
    expect(trip.jerk_score_confidence).toBe('insufficient_data');
  });

  it('preserves tire-wear missing-speed evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-tire-speed-evidence',
      status: 'completed',
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    }]);

    expect(trip).toMatchObject({
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    });
  });

  it('preserves road-type-stratified SVI evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-svi-confidence',
      status: 'completed',
      speed_variability_index: 6.2,
      svi_score: 91,
      svi_label: 'very smooth',
      svi_score_confidence: 'road_type_stratified',
      svi_moving_sample_count: 42,
    }]);

    expect(trip).toMatchObject({
      speed_variability_index: 6.2,
      svi_score: 91,
      svi_label: 'very smooth',
      svi_score_confidence: 'road_type_stratified',
      svi_moving_sample_count: 42,
    });
  });

  it('preserves traffic-stop intersection results through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-intersection-stops',
      status: 'completed',
      intersection_score: 73,
      intersection_score_confidence: 'observed_stops',
      stop_count: 3,
      traffic_stop_count: 3,
      rolling_stop_count: 3,
      smooth_approach_count: 3,
    }]);

    expect(trip).toMatchObject({
      intersection_score: 73,
      intersection_score_confidence: 'observed_stops',
      traffic_stop_count: 3,
      rolling_stop_count: 3,
    });
  });

  it('preserves following-distance confidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-following-confidence',
      status: 'completed',
      following_distance_score: null,
      following_distance_score_confidence: 'insufficient_data',
    }]);

    expect(trip.following_distance_score).toBeNull();
    expect(trip.following_distance_score_confidence).toBe('insufficient_data');
  });

  it('preserves corrected duration and numeric component confidence metadata', () => {
    const [trip] = parseTrips([{
      id: 'trip-score-confidence',
      status: 'completed',
      duration_seconds: 120,
      wall_clock_duration_seconds: 720,
      gap_seconds: 600,
      fatigue_risk_score: 30,
      fatigue_risk_score_confidence: 0.8,
      speed_creep_score: 88,
      speed_creep_score_confidence: 0.8,
      smooth_braking_score: 82,
      smooth_braking_score_confidence: 0.8,
      braking_efficiency_score: 74,
      braking_efficiency_score_confidence: 0.8,
      hill_driving_score: null,
      hill_driving_score_confidence: 0,
    }]);

    expect(trip).toMatchObject({
      duration_seconds: 120,
      wall_clock_duration_seconds: 720,
      gap_seconds: 600,
      fatigue_risk_score: 30,
      fatigue_risk_score_confidence: 0.8,
      speed_creep_score: 88,
      speed_creep_score_confidence: 0.8,
      smooth_braking_score: 82,
      smooth_braking_score_confidence: 0.8,
      braking_efficiency_score_confidence: 0.8,
      hill_driving_score_confidence: 0,
    });
  });

  it('preserves typed component score evidence through sanitized backup imports', () => {
    const [trip] = parseTrips([{
      id: 'trip-component-evidence',
      status: 'completed',
      component_scores: {
        safety: {
          value: 84,
          evidence: 'developing',
          dataSource: ['gps', 'osm_speed_limit'],
          sampleCount: 18,
          note: 'Partial route context.',
        },
      },
      score_provenance: {
        computed_at: '2026-05-24T17:23:44.000Z',
        scoring_version: SCORING_VERSION,
        components: { safety: 'developing' },
        constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
      },
      score_provenance_change: {
        previous_scoring_version: '2.0.0',
        current_scoring_version: SCORING_VERSION,
        reason: 'scoring_inputs_changed',
        changed_constants: ['PENALTY_SCALE_FACTOR'],
      },
      score_explanation: {
        safety: [{ factor: 'phone_use', label: 'Phone use detected while driving', impact: -10 }],
      },
    }]);

    expect(trip.component_scores.safety).toEqual({
      value: 84,
      evidence: 'developing',
      dataSource: ['gps', 'osm_speed_limit'],
      sampleCount: 18,
      note: 'Partial route context.',
    });
    expect(trip.score_provenance).toMatchObject({
      scoring_version: SCORING_VERSION,
      constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
    });
    expect(trip.score_provenance_change.changed_constants).toEqual(['PENALTY_SCALE_FACTOR']);
    expect(trip.score_explanation.safety[0]).toMatchObject({
      factor: 'phone_use',
      impact: -10,
    });
  });

  it('rejects imported trips without a non-empty string id', () => {
    expect(() => parseTrips([{ id: '', status: 'completed' }])).toThrow('valid id');
    expect(() => parseTrips([{ id: 123, status: 'completed' }])).toThrow('valid id');
  });

  it('preserves legitimate long trip notes and reports truncation above their field limit', () => {
    const acceptableNote = 'a'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH);
    const [acceptable] = parseTrips([{ id: 'trip-note-ok', notes: acceptableNote }]);
    expect(acceptable.notes).toHaveLength(MAX_IMPORTED_TRIP_NOTES_LENGTH);

    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      trips: [{ id: 'trip-note-long', notes: 'b'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH + 1) }],
    }));
    expect(parsed.trips[0].notes).toHaveLength(MAX_IMPORTED_TRIP_NOTES_LENGTH);
    expect(parsed.warnings[0]).toContain('notes');
  });

  it('requires acknowledgement before importing truncated trip notes', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        trips: [{ id: 'long-note', notes: 'x'.repeat(MAX_IMPORTED_TRIP_NOTES_LENGTH + 1) }],
      })),
    };
    const pending = await importDriveSenseBackup(file);
    expect(pending).toMatchObject({ requiresAcknowledgement: true, truncatedNoteTripCount: 1 });

    const imported = await importDriveSenseBackup(file, { acknowledgeTruncation: true });
    expect(imported.trips).toBe(1);
  });

  it('prompts for a password before importing encrypted backups', async () => {
    const encrypted = await encryptBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [],
    }), 'correct horse battery');
    const file = {
      size: encrypted.length,
      text: vi.fn(async () => encrypted),
    };

    await expect(importDriveSenseBackup(file)).resolves.toEqual({ error: 'password_required' });
    await expect(importDriveSenseBackup(file, { password: 'wrong horse battery' })).resolves.toEqual({ error: 'wrong_password' });
    await expect(importDriveSenseBackup(file, { password: 'correct horse battery' })).resolves.toMatchObject({
      trips: 0,
      vehicles: 0,
    });
  });

  it('seals plaintext backups with a device-bound HMAC', async () => {
    const backup = {
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-sealed', status: 'completed' }],
    };

    const sealed = await sealPlaintextBackup(backup);
    expect(sealed._integrity).toMatch(/^[0-9a-f]{64}$/);

    const verified = await verifyPlaintextBackupIntegrity(JSON.stringify(sealed));
    expect(verified).toEqual({
      text: JSON.stringify(backup),
      sealed: true,
    });
  });

  it('rejects tampered sealed plaintext backup imports before merging records', async () => {
    const sealed = await sealPlaintextBackup({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-clean', status: 'completed' }],
    });
    const tampered = {
      ...sealed,
      trips: [{ id: 'trip-tampered', status: 'completed' }],
    };
    const file = {
      size: 1024,
      text: vi.fn(async () => JSON.stringify(tampered)),
    };

    await expect(importDriveSenseBackup(file)).resolves.toEqual({ error: BACKUP_INTEGRITY_ERROR });
  });

  it('does not treat the plaintext integrity field as backup content', async () => {
    const sealed = await sealPlaintextBackup({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-strip-integrity', status: 'completed' }],
    });

    const parsed = parseDriveSenseBackup(JSON.stringify(sealed));
    expect(parsed.trips).toHaveLength(1);
    expect(parsed._integrity).toBeUndefined();
  });
});

describe('backup schema migrations', () => {
  it('migrates a v3 trip through scoring refresh to v6', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 3,
      trips: [{ id: 'trip-v3', status: 'completed' }],
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(3);
    expect(parsed.trips[0].needs_rescore).toBe(true);
  });

  it('relabels legacy lane-change events when migrating v5 backups', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 5,
      trips: [{
        id: 'trip-v5',
        status: 'completed',
        distance_km: 10,
        lane_changes_count: 1,
        driving_events: [{ type: 'lane_change', severity: 'medium' }],
      }],
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(5);
    expect(parsed.trips[0].driving_events[0]).toMatchObject({
      type: 'heading_deviation_legacy',
      legacy_renamed: true,
    });
    expect(parsed.trips[0].lane_changes_count).toBeUndefined();
    expect(parsed.trips[0].heading_deviation_count).toBe(0);
    expect(parsed.trips[0].heading_deviation_legacy_count).toBe(1);
  });

  it('leaves current v6 content unchanged during migration', () => {
    const v6 = { app: 'Road Sage', version: 6, trips: [{ id: 'trip-v6', notes: 'kept' }] };
    expect(migrateBackup(v6, 6)).toEqual(v6);
  });

  it('treats a versionless backup as v1', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      trips: [{ id: 'trip-v1', status: 'completed' }],
    }));

    expect(parsed.sourceVersion).toBe(1);
    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.trips[0].needs_rescore).toBe(true);
  });

  it('gives an actionable error for backups from newer app versions', () => {
    expect(() => parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION + 1,
      trips: [],
    }))).toThrow(`backup v${BACKUP_VERSION + 1}, this app supports up to v${BACKUP_VERSION}`);
  });
});
