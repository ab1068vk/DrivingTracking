import { describe, expect, it } from 'vitest';
import {
  LAST_CHECKPOINT_EXPORT_KEY,
  PRIVACY_AUDIT_ANCHOR_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
} from '@/lib/hashChainLog';
import { ROTATING_ENCRYPTED_JSON_KEYS } from '@/lib/keyRotationManager';
import {
  PRIVACY_SCORE_HISTORY_KEY,
} from '@/lib/privacyIntelligence';
import {
  NATIVE_PRIVACY_ZONES_KEY,
  PRIVACY_ZONES_SECURE_KEY,
  ZONE_STATS_KEY,
} from '@/lib/privacyZones';
import { SPEED_KNOWLEDGE_STORAGE_KEY } from '@/lib/speedKnowledgeRepository';
import { TRANSMISSION_LOG_KEY } from '@/lib/transmissionLog';
import {
  DATA_PORTABILITY_FORMAT,
  DATA_PORTABILITY_VERSION,
  buildDataPortabilityExport,
  getErasureKeyList,
  validatePortabilityExport,
} from '@/lib/dataRights';

describe('data rights exports and erasure manifest', () => {
  it('includes every privacy-sensitive local store in the erasure manifest', () => {
    const manifest = getErasureKeyList();
    const keys = manifest.map((item) => item.key);
    const byKey = new Map(manifest.map((item) => [item.key, item]));

    ROTATING_ENCRYPTED_JSON_KEYS.forEach((key) => {
      expect(keys).toContain(key);
    });
    [
      PRIVACY_AUDIT_CHAIN_KEY,
      PRIVACY_AUDIT_ANCHOR_KEY,
      LAST_CHECKPOINT_EXPORT_KEY,
      PRIVACY_SCORE_HISTORY_KEY,
      PRIVACY_ZONES_SECURE_KEY,
      NATIVE_PRIVACY_ZONES_KEY,
      ZONE_STATS_KEY,
      TRANSMISSION_LOG_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      'drivesense_system_logs_v1',
      'drivesense_tracking_diagnostics',
      'drivesense_danger_zones',
      'drivesense_route_risk_index',
      'drivesense_map_matching_cache_v2',
      'drivesense_osm_speed_limit_cache_v2',
      'drivesense_open_meteo_weather_cache_v1',
      'road_sage_calibration_labels',
      'road_sage_calibration_survey_markers',
      'drivesense_coach_programs_v1',
      'drivesense_driver_progression_ledger_v1',
      'drivesense_parking_learning_v1',
      'roadsage_pending_post_drive_review_v1',
    ].forEach((key) => {
      expect(keys).toContain(key);
    });
    [
      PRIVACY_ZONES_SECURE_KEY,
      NATIVE_PRIVACY_ZONES_KEY,
      ZONE_STATS_KEY,
      TRANSMISSION_LOG_KEY,
      PRIVACY_SCORE_HISTORY_KEY,
    ].forEach((key) => {
      expect(byKey.get(key)?.storage).toBe('encrypted_json');
    });
  });

  it('builds a portability bundle that round-trips through the documented schema', async () => {
    const bundle = await buildDataPortabilityExport({
      trips: [{
        id: 'trip-1',
        start_time: '2026-06-22T12:00:00.000Z',
        route_points: [{ lat: 43.1, lng: -79.1 }],
      }],
      vehicles: [{ id: 'vehicle-1', name: 'Car' }],
      settings: { units: 'metric', privacy_zones: [], last_map_center: { lat: 43, lng: -79 } },
      privacyZones: [{ id: 'zone-1', label: 'Home', lat: 43, lng: -79, radius_m: 150, privacy_cell_hashes: ['pzc_secret'] }],
      scoreHistory: [{ timestamp: 1, overall: 88, layerScores: { device: 80 } }],
    });
    const serialized = JSON.stringify(bundle);
    const parsed = JSON.parse(serialized);

    expect(parsed).toMatchObject({
      format: DATA_PORTABILITY_FORMAT,
      version: DATA_PORTABILITY_VERSION,
      trips: [{ id: 'trip-1' }],
      vehicles: [{ id: 'vehicle-1' }],
      settings: { units: 'metric' },
      privacyZones: [{ id: 'zone-1' }],
      scoreHistory: [{ overall: 88 }],
    });
    expect(parsed.settings.last_map_center).toBeUndefined();
    expect(parsed.privacyZones[0]).not.toHaveProperty('lat');
    expect(parsed.privacyZones[0]).not.toHaveProperty('lng');
    expect(parsed.privacyZones[0]).not.toHaveProperty('privacy_cell_hashes');
    expect(serialized).not.toContain('pzc_secret');
    expect(validatePortabilityExport(parsed)).toMatchObject({ valid: true });
  });
});
