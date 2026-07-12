import { describe, expect, it } from 'vitest';
import {
  buildOutboundRows,
  buildTrackingPrivacyConsoleData,
  nativePrivacySyncRow,
  privacyZoneDisplayRows,
} from '@/lib/trackingPrivacyConsole';

describe('tracking privacy console display rows', () => {
  const sensitiveZone = {
    id: 'home-zone-private-id',
    label: 'Home',
    type: 'circle',
    sensitivity: 'high',
    lat: 43.650123,
    lng: -79.380456,
    radius_m: 180,
    privacy_cell_hashes: ['pzc_secret_hash'],
    waypoints: [
      { lat: 43.651, lng: -79.381 },
      { lat: 43.652, lng: -79.382 },
    ],
    allTime: { hidden: 8, events: 2 },
    week: { hidden: 3, events: 1 },
    lastActive: Date.UTC(2026, 0, 1),
  };

  it('redacts private-zone geometry from display rows', () => {
    const rows = privacyZoneDisplayRows([sensitiveZone], {
      zoneSummaries: [{
        label: 'Home',
        protectedRecords: 10,
        protectedWeek: 4,
        lastActive: Date.UTC(2026, 0, 2),
        status: 'protecting',
      }],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        displayId: 'Zone 1',
        label: 'Home',
        type: 'circle',
        sensitivity: 'high',
        geometry: 'redacted',
        protectedRecords: 10,
        protectedWeek: 4,
      }),
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('43.650123');
    expect(serialized).not.toContain('-79.380456');
    expect(serialized).not.toContain('radius_m');
    expect(serialized).not.toContain('privacy_cell_hashes');
    expect(serialized).not.toContain('pzc_secret_hash');
    expect(serialized).not.toContain('home-zone-private-id');
  });

  it('summarizes masking, private-trip mode, and app-recorded audit evidence without coordinates', () => {
    const data = buildTrackingPrivacyConsoleData({
      settings: {
        privacy_zones_native_sync_status: 'ok',
        privacy_zones_native_sync_zone_count: 1,
        weather_context_enabled: false,
        speed_limit_lookup_enabled: true,
        map_matching_enabled: true,
        osrm_map_matching_url: 'https://trusted-osrm.example',
        osrm_data_sharing_consented: false,
        osrm_block_near_any_zone: true,
      },
      intelligence: {
        generatedAt: Date.UTC(2026, 0, 3),
        zones: [sensitiveZone],
        zoneSummary: {
          zoneCount: 1,
          pointsWeek: 3,
          eventsWeek: 1,
        },
        drivingReadout: {
          protectedPointCount: 8,
          protectedEventCount: 2,
          rawPointInsideZoneCount: 1,
          zoneSummaries: [{ label: 'Home', protectedRecords: 10, protectedWeek: 4 }],
        },
        transmissions: {
          outboundReadout: {
            headline: 'Retained outbound records are usable',
            tone: 'ok',
            serviceSummaries: [],
          },
        },
        chainResult: { valid: true },
        auditSummary: {
          todayTotal: 1,
          weekTotal: 3,
          latestAt: Date.UTC(2026, 0, 3),
          signatureCoverage: 0,
          operations: [{ operation: 'POINTS_SUPPRESSED', count: 2 }],
        },
      },
    });

    expect(data.maskingRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'route_samples', value: '8', status: 'needs_review' }),
      expect.objectContaining({ id: 'suppressed_events', value: '2', status: 'masked' }),
      expect.objectContaining({ id: 'private_trip_mode', value: 'summary_only' }),
    ]));
    expect(data.auditRows[0]).toEqual(expect.objectContaining({
      operation: 'Points Suppressed',
      detail: 'App-recorded privacy evidence. This is not an external security audit.',
    }));

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('43.650123');
    expect(serialized).not.toContain('-79.380456');
    expect(serialized).not.toContain('radius_m');
    expect(serialized).not.toContain('pzc_secret_hash');
    expect(serialized).not.toContain('waypoints');
  });

  it('labels native sync failures and outbound consent or blocking status neutrally', () => {
    expect(nativePrivacySyncRow({
      privacy_zones_native_sync_status: 'failed',
      privacy_zones_native_sync_failed_at: '2026-01-01T12:00:00.000Z',
      privacy_zones_native_sync_zone_count: 2,
    })).toEqual(expect.objectContaining({
      value: 'failed',
      tone: 'error',
    }));

    const rows = buildOutboundRows({
      transmissions: {
        outboundReadout: {
          rawWithoutConsentCount: 1,
          serviceSummaries: [{
            service: 'osrm',
            label: 'OSRM route snapping',
            enabled: true,
            retainedCount: 1,
            rawCount: 1,
            blockedCount: 0,
          }],
        },
      },
    }, {
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://trusted-osrm.example',
      osrm_data_sharing_consented: false,
      osrm_block_near_any_zone: true,
    });

    expect(rows.find((row) => row.id === 'osrm')).toEqual(expect.objectContaining({
      status: 'raw_without_consent',
      tone: 'error',
      consentEvidence: 'Consent is current and privacy zones are always excluded',
    }));
    expect(rows.find((row) => row.id === 'open-meteo')).toEqual(expect.objectContaining({
      label: 'Open-Meteo weather',
    }));
    expect(rows.find((row) => row.id === 'overpass')).toEqual(expect.objectContaining({
      label: 'OpenStreetMap / Overpass',
    }));
  });
});
