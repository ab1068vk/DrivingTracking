import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_PASSWORD_REQUIRED_CODE,
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_WRONG_PASSWORD_CODE,
  buildDriveSenseBackup,
  exportDriveSenseBackup,
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
import {
  isSignedExportEnvelope,
  signExport,
  verifyExport,
} from '@/lib/exportIntegrity';
import { SCORING_VERSION } from '@/lib/scoringConstants';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { STORAGE_KEY as SPEED_KNOWLEDGE_STORAGE_KEY } from '@/lib/localSpeedKnowledge';
import { getJson, setJson } from '@/lib/mobileStorage';
import { maskTripForPrivacy } from '@/lib/privacyZones';
import { loadTransmissionLog } from '@/lib/transmissionLog';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('verifies signed backup envelopes before importing data', async () => {
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [],
      trips: [{ id: 'trip-signed', status: 'completed' }],
    });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    expect(isSignedExportEnvelope(signed)).toBe(true);
    await expect(verifyExport(signed)).resolves.toMatchObject({ valid: true });

    const imported = await importDriveSenseBackup(file);
    expect(imported).toMatchObject({ trips: 1, vehicles: 0 });
  });

  it('rejects tampered signed backups before writing trips or vehicles', async () => {
    const { tripService } = await import('@/api/trips');
    const { vehicleService } = await import('@/api/vehicles');
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      vehicles: [{ id: 'vehicle-original', name: 'Original' }],
      trips: [{ id: 'trip-original', status: 'completed' }],
    });
    signed.payload.trips.push({ id: 'trip-fabricated', status: 'completed' });
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    await expect(importDriveSenseBackup(file)).rejects.toMatchObject({
      code: BACKUP_SIGNATURE_INVALID_CODE,
      message: expect.stringContaining('Backup signature invalid'),
    });
    expect(tripService.upsertMany).not.toHaveBeenCalled();
    expect(vehicleService.upsertMany).not.toHaveBeenCalled();
  });

  it('can explicitly recover the payload from a signed readable backup after signature key loss', async () => {
    const { localSettings } = await import('@/lib/trackingStore');
    const updateSettingsSpy = vi.spyOn(localSettings, 'update');
    const signed = await signExport({
      app: 'Road Sage',
      version: BACKUP_VERSION,
      settings: {
        automatic_context_fetch_enabled: true,
        weather_context_enabled: true,
        speed_limit_lookup_enabled: true,
      },
      vehicles: [],
      trips: [{ id: 'trip-reinstall-recovery', status: 'completed' }],
    });
    signed.signature = signed.signature.replace(/.$/, signed.signature.endsWith('A') ? 'B' : 'A');
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify(signed)),
    };

    const imported = await importDriveSenseBackup(file, { allowUnverifiedSignedBackup: true });

    expect(imported).toMatchObject({
      trips: 1,
      vehicles: 0,
      signatureRecovered: true,
      settings: false,
      settingsSkippedForSignatureRecovery: true,
    });
    expect(updateSettingsSpy).not.toHaveBeenCalled();
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
      export_id: null,
      privacy_export: {
        zone_commitment_scheme: null,
        zone_commitment_count: 0,
      },
      zone_commitments: [],
      speed_knowledge: { cells: {}, corrections: [] },
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

  it('migrates v8 backups with empty commitment metadata', () => {
    const v8 = {
      app: 'Road Sage',
      version: 8,
      vehicles: [],
      trips: [{ id: 'trip-v8', status: 'completed' }],
      privacy_export: {
        timestamp_fuzzing_enabled: true,
      },
    };

    expect(migrateBackup(v8, 8)).toEqual({
      ...v8,
      version: BACKUP_VERSION,
      export_id: null,
      privacy_export: {
        timestamp_fuzzing_enabled: true,
        zone_commitment_scheme: null,
        zone_commitment_count: 0,
      },
      zone_commitments: [],
      speed_knowledge: { cells: {}, corrections: [] },
    });
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

  it('exports and parses local survey labels and trip markers', async () => {
    const backup = await buildDriveSenseBackup({
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

describe('backup speed knowledge', () => {
  afterEach(async () => {
    await setJson(SPEED_KNOWLEDGE_STORAGE_KEY, { cells: {}, corrections: [] });
    vi.clearAllMocks();
  });

  it('exports and parses local speed knowledge while dropping private-zone corrections', async () => {
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 150 }],
    };
    const backup = await buildDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings,
      speedKnowledge: {
        cells: {
          dpz83q: {
            limitKmh: 50,
            source: 'trip_consensus',
            confidence: 0.7,
            tripCount: 3,
            evidenceCount: 4,
            firstSeenAt: '2026-06-01T12:00:00.000Z',
            lastUpdatedAt: '2026-06-02T12:00:00.000Z',
            verifiedAt: '2026-06-02T12:00:00.000Z',
            verificationStatus: 'learned_from_confirmed_source',
            auditTrail: [{
              action: 'evidence_added',
              changedAt: '2026-06-02T12:00:00.000Z',
              pointSource: 'osm_maxspeed',
            }],
          },
        },
        corrections: [
          {
            geohash: 'dpz83q',
            lat: 43.7001,
            lng: -79.4001,
            limitKmh: 40,
            note: 'school zone',
            source: 'user_confirmed_posted_sign',
            roadName: 'King Street',
            verifiedAt: '2026-06-03T12:00:00.000Z',
            verificationStatus: 'confirmed_posted_sign',
            evidenceCount: 2,
            sectionPoints: [
              { lat: 43.7001, lng: -79.4001 },
              { lat: 43.7003, lng: -79.4003 },
            ],
            editHistory: [{
              changedAt: '2026-06-03T11:00:00.000Z',
              previousLimitKmh: 50,
              previousSource: 'user_entered_estimate',
            }],
            auditTrail: [{
              action: 'updated',
              changedAt: '2026-06-03T12:00:00.000Z',
              previousLimitKmh: 50,
              nextLimitKmh: 40,
            }],
          },
          {
            geohash: 'dpz800',
            lat: 43.65,
            lng: -79.38,
            limitKmh: 30,
            note: 'inside privacy zone',
            source: 'user_entered_estimate',
          },
        ],
      },
    });

    expect(backup.privacy_export.no_backup_keys).not.toContain(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(backup.speed_knowledge.cells.dpz83q).toMatchObject({
      limitKmh: 50,
      source: 'trip_consensus',
      tripCount: 3,
      evidenceCount: 4,
      verificationStatus: 'learned_from_confirmed_source',
    });
    expect(backup.speed_knowledge.cells.dpz83q.auditTrail).toEqual([expect.objectContaining({
      action: 'evidence_added',
      pointSource: 'osm_maxspeed',
    })]);
    expect(backup.speed_knowledge.corrections).toHaveLength(1);
    expect(backup.speed_knowledge.corrections[0]).toMatchObject({
      geohash: 'dpz83q',
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
      roadName: 'King Street',
      note: 'school zone',
      verifiedAt: '2026-06-03T12:00:00.000Z',
      verificationStatus: 'confirmed_posted_sign',
      evidenceCount: 2,
    });
    expect(backup.speed_knowledge.corrections[0].editHistory).toHaveLength(1);
    expect(backup.speed_knowledge.corrections[0].auditTrail).toEqual([expect.objectContaining({
      action: 'updated',
      previousLimitKmh: 50,
      nextLimitKmh: 40,
    })]);

    const parsed = parseDriveSenseBackup(JSON.stringify(backup));
    expect(parsed.speed_knowledge.corrections).toHaveLength(1);
    expect(parsed.speed_knowledge.corrections[0].sectionPoints).toHaveLength(2);
    expect(parsed.speed_knowledge.corrections[0]).toMatchObject({
      verifiedAt: '2026-06-03T12:00:00.000Z',
      verificationStatus: 'confirmed_posted_sign',
      evidenceCount: 2,
    });
    expect(parsed.speed_knowledge.corrections[0].auditTrail).toHaveLength(1);
  });

  it('restores speed knowledge during backup import', async () => {
    const file = {
      size: 100,
      text: vi.fn(async () => JSON.stringify({
        app: 'Road Sage',
        version: BACKUP_VERSION,
        vehicles: [],
        trips: [],
        speed_knowledge: {
          cells: {
            dpz83q: {
              limitKmh: 50,
              source: 'trip_consensus',
              confidence: 0.7,
              tripCount: 2,
            },
          },
          corrections: [{
            geohash: 'dpz83r',
            lat: 43.7001,
            lng: -79.4001,
            limitKmh: 40,
            source: 'user_entered_estimate',
            note: 'saved estimate',
          }],
        },
      })),
    };

    const imported = await importDriveSenseBackup(file);
    const restored = await getJson(SPEED_KNOWLEDGE_STORAGE_KEY, null);

    expect(imported).toMatchObject({
      speedKnowledgeCells: 1,
      speedKnowledgeCorrections: 1,
      speedKnowledgeRestored: true,
    });
    expect(restored.corrections[0]).toMatchObject({
      geohash: 'dpz83r',
      limitKmh: 40,
      note: 'saved estimate',
    });
  });
});

describe('backup export privacy', () => {
  it('logs full-backup exports from the actual signed payload shape', async () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const clicked = vi.fn();
    const anchor = {
      href: '',
      download: '',
      style: {},
      click: clicked,
      remove: vi.fn(),
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });
    const RealURL = globalThis.URL;
    const createObjectURL = vi.fn(() => 'blob:road-sage-backup');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class TestURL extends RealURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });

    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    };
    const result = await exportDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings,
      filename: 'backup.json',
    });

    const payloadText = JSON.stringify(result.signedBackup);
    const [entry] = await loadTransmissionLog();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(payloadText).not.toContain('"lat"');
    expect(payloadText).not.toContain('"lng"');
    expect(payloadText).not.toContain('"radius_m"');
    expect(payloadText).not.toContain('"label":"Home"');
    expect(entry).toMatchObject({
      service: 'export',
      coordinateDisclosure: 'committed',
      privacyTransformVerified: true,
      privacyTransformSource: 'dataBackup.js:buildDriveSenseBackup',
      privacyVerificationEvidence: [
        'backup payload was inspected for zone coordinate and radius fields',
        'privacy zones are exported as coordinate-free commitments',
      ],
      sentCoords: '0 - zone coordinates and ranges excluded, boundary points committed',
      bytesOut: payloadText.length,
      status: 'safe',
      zonesSuppressed: ['Private area'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('replaces exported privacy boundaries with opaque placeholders', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
      last_map_center: { lat: 43.65, lng: -79.38, source: 'privacy-zone-review' },
    };
    const trip = {
      id: 'trip-private-boundary',
      status: 'completed',
      start_time: '2026-01-01T12:00:00.000Z',
      avg_speed_kmh: 80,
      avg_running_speed_kmh: 85,
      max_speed_kmh: 120,
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z', speed_kmh: 120, heading: 45 },
        { lat: 43.6522, lng: -79.38, timestamp: '2026-01-01T12:00:20.000Z', speed_kmh: 20, radius_m: 999 },
        { lat: 43.6532, lng: -79.38, timestamp: '2026-01-01T12:00:40.000Z', speed_kmh: 40 },
      ],
      driving_events: [],
    };
    const exactBoundary = maskTripForPrivacy(trip, settings).route_points.find((point) => point.privacy_boundary);

    const backup = await buildDriveSenseBackup({ trips: [trip], vehicles: [], settings });
    const exportedPlaceholder = backup.trips[0].route_points.find((point) => point.privacy_export_placeholder);
    const [zoneCommitment] = backup.zone_commitments;

    expect(backup.trips[0].route_points.some((point) => point.privacy_boundary)).toBe(false);
    expect(backup.privacy_export).toMatchObject({
      timestamp_fuzzing_enabled: true,
      timestamp_shift_policy: 'bounded_private_zone_noise',
      zone_commitment_scheme: 'sha256_zone_center_export_salt_v2',
      zone_commitment_count: 1,
      zone_placeholder_count: 1,
      shifted_trip_count: 1,
      boundary_placeholder_count: 1,
      shifted_trip_ids: ['trip-private-boundary'],
    });
    expect(backup.trips[0]).toMatchObject({
      avg_speed_kmh: 30,
      avg_running_speed_kmh: 30,
      max_speed_kmh: 40,
      privacy_time_shifted: true,
      privacy_time_shifted_fields: ['start_time'],
    });
    expect(exportedPlaceholder).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
      privacy_zone_id: 'private_area',
      privacy_zone_label: 'Private area',
    });
    expect(JSON.stringify(backup.trips[0].route_points)).not.toContain(String(exactBoundary.lat));
    expect(exportedPlaceholder.radius_m).toBeUndefined();
    expect(backup.settings.privacy_zones[0]).toMatchObject({
      id: 'private_area_1',
      label: 'Private area',
      masked_for_privacy: true,
      reconfiguration_required: true,
    });
    expect(backup.settings.privacy_zones[0].radius_m).toBeUndefined();
    expect(backup.settings.privacy_zones[0].privacy_cell_hashes).toBeUndefined();
    expect(backup.settings.last_map_center).toBeUndefined();
    expect(JSON.stringify(backup.settings.privacy_zones)).not.toContain('privacy_cell_hashes');
    expect(JSON.stringify(backup.settings)).not.toContain('privacy-zone-review');
    expect(zoneCommitment).toMatchObject({
      zone_ref: 'private_area',
      export_id: backup.export_id,
    });
    expect(zoneCommitment.commitment).toEqual(expect.any(String));
    expect(zoneCommitment).not.toHaveProperty('zone_id');
    expect(zoneCommitment).not.toHaveProperty('zone_label');
    expect(zoneCommitment).not.toHaveProperty('zone_radius_m');
    expect(zoneCommitment).not.toHaveProperty('lat');
    expect(zoneCommitment).not.toHaveProperty('lng');
    expect(zoneCommitment).not.toHaveProperty('latitude');
    expect(zoneCommitment).not.toHaveProperty('longitude');
    expect(zoneCommitment).not.toHaveProperty('salt');
    expect(JSON.stringify(backup.zone_commitments)).not.toContain('43.65');
    expect(JSON.stringify(backup.zone_commitments)).not.toContain('-79.38');
    expect(JSON.stringify(backup)).not.toContain('"radius_m":100');
    expect(JSON.stringify(backup)).not.toContain('"zone_radius_m"');
    expect(JSON.stringify(backup)).not.toContain('"label":"Home"');
  });

  it('generates unlinkable privacy-zone commitments for repeated exports', async () => {
    const settings = {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    };

    const first = await buildDriveSenseBackup({ trips: [], vehicles: [], settings });
    const second = await buildDriveSenseBackup({ trips: [], vehicles: [], settings });

    expect(first.export_id).not.toBe(second.export_id);
    expect(first.zone_commitments[0].commitment).not.toBe(second.zone_commitments[0].commitment);
    expect(first.zone_commitments[0].export_id).toBe(first.export_id);
    expect(second.zone_commitments[0].export_id).toBe(second.export_id);
  });
});
