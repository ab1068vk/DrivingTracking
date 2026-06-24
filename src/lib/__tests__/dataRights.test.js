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
  DATA_PORTABILITY_FORMAT,
  DATA_PORTABILITY_VERSION,
  buildDataPortabilityExport,
  getErasureKeyList,
  validatePortabilityExport,
} from '@/lib/dataRights';

describe('data rights exports and erasure manifest', () => {
  it('includes every rotating encrypted JSON key plus audit and score-history anchors', () => {
    const keys = getErasureKeyList().map((item) => item.key);

    ROTATING_ENCRYPTED_JSON_KEYS.forEach((key) => {
      expect(keys).toContain(key);
    });
    [
      PRIVACY_AUDIT_CHAIN_KEY,
      PRIVACY_AUDIT_ANCHOR_KEY,
      LAST_CHECKPOINT_EXPORT_KEY,
      PRIVACY_SCORE_HISTORY_KEY,
    ].forEach((key) => {
      expect(keys).toContain(key);
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
