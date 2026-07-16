import { describe, expect, it } from 'vitest';
import {
  assertNoCoordinateColumns,
  buildRouteQualityCsv,
  buildRouteQualityRows,
  buildSpeedSourceAuditCsv,
  buildSpeedSourceAuditRows,
  buildTechnicalReportPayload,
  buildTripEventCsv,
  buildTripEventExportRows,
  buildVoiceAlertLogRows,
} from '@/lib/trackingExportLab';

const zone = { id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 };
const settings = { units: 'metric', privacy_zones: [zone] };

const trip = {
  id: 'trip-1',
  status: 'completed',
  start_time: '2026-07-09T12:00:00.000Z',
  end_time: '2026-07-09T12:20:00.000Z',
  distance_km: 8,
  score_overall: 88,
  score_provenance: { scoring_version: '2.6.0', calibration_status: 'approximate' },
  route_points_raw_count: 4,
  route_points_map_count: 3,
  route_points: [
    { lat: 43.65, lng: -79.38, timestamp: '2026-07-09T12:00:00.000Z', speed_kmh: 12, privacy_boundary: true },
    { lat: 43.6512, lng: -79.38, timestamp: '2026-07-09T12:02:00.000Z', speed_kmh: 38, speed_limit_kmh: 40 },
    { lat: 43.6522, lng: -79.38, timestamp: '2026-07-09T12:08:00.000Z', speed_kmh: 46, route_gap: true },
  ],
  driving_events: [{
    type: 'harsh_brake',
    timestamp: '2026-07-09T12:02:00.000Z',
    value: -4.2,
    lat: 43.6522,
    lng: -79.38,
    source: 'gps_events',
  }],
};

describe('tracking export lab builders', () => {
  it('builds privacy-safe route quality rows without coordinate columns', () => {
    const rows = buildRouteQualityRows([trip], settings);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trip_id: 'trip-1',
      raw_route_points: '4',
      map_playback_points: '3',
      privacy_status: 'privacy masked',
      score_estimate: '~88',
      score_label: expect.stringContaining('Scores are estimates'),
    });
    expect(rows[0].privacy_export_placeholders).toBeGreaterThan(0);
    expect(assertNoCoordinateColumns(rows)).toEqual({ valid: true, offendingKeys: [] });

    const csv = buildRouteQualityCsv([trip], settings);
    expect(csv).toContain('privacy_export_placeholders');
    expect(csv).not.toContain('43.65');
    expect(csv).not.toMatch(/\blat\b|\blng\b|radius/i);
  });

  it('builds event CSV rows with privacy status and no raw private coordinates', () => {
    const rows = buildTripEventExportRows([trip], settings);
    const privacyRows = rows.filter((row) => row.privacy_status === 'privacy masked');

    expect(rows.some((row) => row.event_type === 'harsh_brake')).toBe(true);
    expect(privacyRows.length).toBeGreaterThan(0);
    expect(assertNoCoordinateColumns(rows)).toEqual({ valid: true, offendingKeys: [] });

    const csv = buildTripEventCsv([trip], settings);
    expect(csv).toContain('privacy_status');
    expect(csv).toContain('privacy masked');
    expect(csv).not.toContain('43.65');
    expect(csv).not.toMatch(/\blat\b|\blng\b|radius/i);
  });

  it('builds speed-source audit rows without learned cell keys or coordinates', () => {
    const rows = buildSpeedSourceAuditRows({
      trips: [trip],
      settings,
      nowMs: Date.parse('2026-07-09T12:00:00.000Z'),
      speedKnowledgeData: {
        cells: {
          dpz83f: { limitKmh: 50, source: 'trip_consensus', confidence: 0.55 },
        },
        corrections: [{
          id: 'posted-rule',
          roadName: 'King Street',
          limitKmh: 40,
          source: 'user_confirmed_posted_sign',
        }],
      },
    });

    expect(rows.some((row) => row.source_key === 'trip_consensus')).toBe(true);
    expect(rows.some((row) => row.section_label === 'Learned local speed cell')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('dpz83f');
    expect(assertNoCoordinateColumns(rows)).toEqual({ valid: true, offendingKeys: [] });

    const csv = buildSpeedSourceAuditCsv({
      trips: [trip],
      settings,
      speedKnowledgeData: { cells: { dpz83f: { limitKmh: 50, source: 'trip_consensus' } }, corrections: [] },
    });
    expect(csv).toContain('fallback_reason');
    expect(csv).not.toContain('dpz83f');
    expect(csv).not.toMatch(/\blat\b|\blng\b|radius/i);
  });

  it('builds sanitized voice alert log rows', () => {
    const rows = buildVoiceAlertLogRows({
      systemLogs: [{
        id: 'log-1',
        timestamp: '2026-07-09T12:00:00.000Z',
        source: 'webview',
        operation: 'voice_alert_spoken',
        title: 'Voice alert spoken',
        message: 'Hard braking event recorded.',
        details: { lat: 43.65, lng: -79.38, channel: 'speechSynthesis' },
      }],
      nativeDiagnostics: {
        events: [{
          type: 'native_voice_alert',
          title: 'Native voice alert',
          reason: 'recorded',
          timestamp: '2026-07-09T12:01:00.000Z',
        }],
      },
    });

    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('43.65');
    expect(assertNoCoordinateColumns(rows)).toEqual({ valid: true, offendingKeys: [] });
  });

  it('builds a technical manifest that declares privacy-safe export shape', () => {
    const payload = buildTechnicalReportPayload({
      trips: [trip],
      settings,
      speedKnowledgeData: { cells: {}, corrections: [] },
      systemLogs: [],
      nativeDiagnostics: { events: [] },
      now: '2026-07-09T12:00:00.000Z',
    });

    expect(payload.privacy).toMatchObject({
      transform: 'maskTripForPrivacyExport',
      private_zone_geometry_exported: false,
      private_coordinates_exported: false,
      coordinate_columns_exported: [],
    });
    expect(payload.counts.trip_count).toBe(1);
    expect(payload.score_notice).toContain('Scores are estimates');
    expect(JSON.stringify(payload)).not.toContain('"lat"');
    expect(JSON.stringify(payload)).not.toContain('"lng"');
    expect(JSON.stringify(payload)).not.toContain('43.65');
  });
});
