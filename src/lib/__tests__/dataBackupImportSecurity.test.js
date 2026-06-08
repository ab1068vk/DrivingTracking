import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_WRONG_PASSWORD_CODE,
  buildDriveSenseBackup,
  importDriveSenseBackup,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  MAX_IMPORTED_TRIP_DRIVING_EVENTS,
  MAX_IMPORTED_TRIP_NOTES_LENGTH,
  MAX_IMPORTED_TRIP_ROUTE_POINTS,
  migrateBackup,
  parseDriveSenseBackup,
} from '@/lib/dataBackup';
import {
  encryptBackupText,
  isEncryptedBackupEnvelope,
} from '@/lib/backupEnvelopeEncryption';
import { SCORING_VERSION } from '@/lib/scoringConstants';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { maskTripForPrivacy } from '@/lib/privacyZones';

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
    vi.clearAllMocks();
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

  it('imports encrypted backups through the existing sanitizer without leaking plaintext', async () => {
    const passphrase = 'correct horse battery staple';
    const plaintext = JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-encrypted', status: 'completed', notes: 'private route note' }],
    });
    const encrypted = await encryptBackupText(plaintext, passphrase, {
      exportedAt: '2026-06-06T12:00:00.000Z',
    });
    const file = {
      size: encrypted.length,
      text: vi.fn(async () => encrypted),
    };

    expect(isEncryptedBackupEnvelope(encrypted)).toBe(true);
    expect(encrypted).not.toContain('trip-encrypted');
    expect(encrypted).not.toContain('private route note');

    await expect(importDriveSenseBackup(file)).rejects.toMatchObject({
      code: BACKUP_PASSWORD_REQUIRED_CODE,
    });
    await expect(importDriveSenseBackup(file, { passphrase: 'wrong password value' })).rejects.toMatchObject({
      code: BACKUP_WRONG_PASSWORD_CODE,
    });

    const imported = await importDriveSenseBackup(file, { passphrase });
    expect(imported).toMatchObject({ trips: 1, vehicles: 0 });
  });
});

describe('backup schema migrations', () => {
  it('migrates a v3 trip through scoring refresh to the current backup version', () => {
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

  it('migrates v6 content to the current schema with empty calibration payload', () => {
    const v6 = { app: 'Road Sage', version: 6, trips: [{ id: 'trip-v6', notes: 'kept' }] };
    expect(migrateBackup(v6, 6)).toEqual({
      ...v6,
      version: BACKUP_VERSION,
      calibration: { labels: [], survey_markers: {} },
    });
  });

  it('migrates v7 backups to the current privacy-safe backup schema', () => {
    const parsed = parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: 7,
      vehicles: [],
      trips: [{ id: 'trip-v7', status: 'completed' }],
      settings: {
        privacy_zones: [{
          id: 'home',
          label: 'Home',
          radius_m: 100,
          privacy_cell_hashes: ['pzc_legacy'],
          masked_for_privacy: true,
        }],
      },
    }));

    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.sourceVersion).toBe(7);
    expect(parsed.trips[0].id).toBe('trip-v7');
  });

  it('rejects backups newer than the current schema', () => {
    expect(() => parseDriveSenseBackup(JSON.stringify({
      app: 'Road Sage',
      version: BACKUP_VERSION + 1,
      trips: [],
    }))).toThrow('newer than this app supports');
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
});

describe('backup calibration labels', () => {
  afterEach(async () => {
    await localCalibrationLabelRepository.replaceAll([]);
    await localCalibrationLabelRepository.replaceTripSurveyMarkers({});
    vi.clearAllMocks();
  });

  it('exports and parses local survey labels and trip markers', () => {
    const backup = buildDriveSenseBackup({
      trips: [{ id: 'trip-calibration', status: 'completed' }],
      vehicles: [],
      calibrationLabels: [{
        id: 'label-1',
        upload_status: 'local_only',
        scoreOutput: { overall: 82 },
        surveyLabel: {
          overallDriveRating: 4,
          targetScore: 75,
          wasDriver: 'yes',
          contextTags: ['traffic'],
        },
        local_only_note: 'kept in user backup',
      }],
      calibrationSurveyMarkers: {
        'trip-calibration': {
          label_id: 'label-1',
          rating: 4,
          upload_status: 'local_only',
        },
      },
    });

    const parsed = parseDriveSenseBackup(JSON.stringify(backup));

    expect(parsed.calibration.labels).toHaveLength(1);
    expect(parsed.calibration.labels[0].surveyLabel.overallDriveRating).toBe(4);
    expect(parsed.calibration.survey_markers['trip-calibration']).toMatchObject({
      label_id: 'label-1',
      rating: 4,
    });
  });

  it('restores calibration labels during backup import', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        calibration: {
          labels: [{
            id: 'label-imported',
            scoreOutput: { overall: 70 },
            surveyLabel: { overallDriveRating: 5, targetScore: 100, wasDriver: 'yes' },
          }],
          survey_markers: {
            'trip-imported': { label_id: 'label-imported', rating: 5 },
          },
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const labels = await localCalibrationLabelRepository.list();
    const marker = await localCalibrationLabelRepository.getTripSurveyStatus('trip-imported');

    expect(imported).toMatchObject({
      calibrationLabels: 1,
      calibrationLabelsRestored: true,
    });
    expect(labels[0].id).toBe('label-imported');
    expect(marker).toMatchObject({ label_id: 'label-imported', rating: 5 });
  });
});

describe('backup export privacy', () => {
  it('replaces exported privacy boundaries with opaque placeholders', () => {
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    };
    const trip = {
      id: 'trip-private-boundary',
      status: 'completed',
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z' },
        { lat: 43.6522, lng: -79.38, timestamp: '2026-01-01T12:00:20.000Z', radius_m: 999 },
      ],
      driving_events: [],
    };
    const exactBoundary = maskTripForPrivacy(trip, settings).route_points.find((point) => point.privacy_boundary);

    const backup = buildDriveSenseBackup({ trips: [trip], vehicles: [], settings });
    const exportedPlaceholder = backup.trips[0].route_points.find((point) => point.privacy_export_placeholder);

    expect(backup.trips[0].route_points.some((point) => point.privacy_boundary)).toBe(false);
    expect(exportedPlaceholder).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
      privacy_zone_id: 'home',
    });
    expect(JSON.stringify(backup.trips[0].route_points)).not.toContain(String(exactBoundary.lat));
    expect(exportedPlaceholder.radius_m).toBeUndefined();
    expect(backup.settings.privacy_zones[0]).toMatchObject({
      id: 'home',
      label: 'Home',
      radius_m: 100,
      exclude_from_osrm: true,
      masked_for_privacy: true,
    });
    expect(backup.settings.privacy_zones[0].privacy_cell_hashes).toBeUndefined();
    expect(JSON.stringify(backup.settings.privacy_zones)).not.toContain('privacy_cell_hashes');
  });
});
