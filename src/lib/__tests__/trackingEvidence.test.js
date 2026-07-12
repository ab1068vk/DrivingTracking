import { describe, expect, it } from 'vitest';
import { SCORING_VERSION } from '@/lib/tripEngine';
import {
  buildMetricEvidenceRows,
  buildSourceEvidenceRows,
  buildTrackingEvidenceConsoleData,
  countObdPowertrainSamples,
} from '@/lib/trackingEvidence';

const findRow = (rows, id) => rows.find((row) => row.id === id);

describe('tracking evidence console rows', () => {
  it('shows missing evidence as unavailable instead of zero', () => {
    const rows = buildSourceEvidenceRows({ id: 'trip-1' }, {});

    expect(findRow(rows, 'route-retained-points')).toMatchObject({
      value: 'unavailable',
      confidence: 'unavailable',
      sampleCount: 'unavailable',
    });
    expect(findRow(rows, 'route-raw-map-points')).toMatchObject({
      value: 'raw unavailable / map unavailable',
      confidence: 'unavailable',
    });
    expect(findRow(rows, 'gps-gaps')).toMatchObject({
      value: 'unavailable',
      confidence: 'unavailable',
    });
    expect(findRow(rows, 'obd-powertrain')).toMatchObject({
      value: 'unavailable',
      confidence: 'unavailable',
    });
  });

  it('preserves explicit zero samples as recorded zero values', () => {
    const rows = buildSourceEvidenceRows({
      id: 'trip-1',
      route_points: [],
      route_points_raw_count: 0,
      route_points_map_count: 0,
      gps_gap_count: 0,
      obd_powertrain_sample_count: 0,
      phone_use_window_count: 0,
      speed_limit_context: { status: 'unavailable', sample_count: 0 },
    }, {});

    expect(findRow(rows, 'route-retained-points')).toMatchObject({
      value: '0',
      confidence: 'recorded',
      sampleCount: '0',
    });
    expect(findRow(rows, 'route-raw-map-points')).toMatchObject({
      value: 'raw 0 / map 0',
      confidence: 'recorded',
      sampleCount: '0',
    });
    expect(findRow(rows, 'gps-gaps')).toMatchObject({
      value: '0',
      confidence: 'recorded',
    });
    expect(findRow(rows, 'obd-powertrain')).toMatchObject({
      value: '0',
      confidence: 'recorded',
      sampleCount: '0',
    });
  });

  it('builds metric rows from component scores with source and calibration notes', () => {
    const rows = buildMetricEvidenceRows({
      id: 'trip-1',
      route_points: [
        { timestamp: '2026-01-01T12:00:00.000Z', speed_kmh: 30 },
        { timestamp: '2026-01-01T12:01:00.000Z', speed_kmh: 34 },
      ],
      component_scores: {
        speed_limit_compliance: {
          value: 82,
          evidence: 'developing',
          dataSource: ['osm_speed_limit', 'gps_events'],
          sampleCount: 7,
          calibrationNote: 'Provisional speed-limit evidence from matched route points.',
        },
      },
      score_provenance: {
        scoring_version: SCORING_VERSION,
        components: { speed_limit_compliance: 'developing' },
      },
    });

    expect(findRow(rows, 'metric-speed_limit_compliance')).toMatchObject({
      label: 'speed limit compliance',
      value: '82',
      confidence: 'developing',
      sampleCount: '7',
      dataSourceLabel: 'OpenStreetMap speed limits, GPS event detection',
      calibrationNote: 'Provisional speed-limit evidence from matched route points.',
      provisional: true,
      provenance: SCORING_VERSION,
    });
  });

  it('distinguishes Android Usage Access evidence from GPS proxy diagnostics', () => {
    const usageRows = buildSourceEvidenceRows({
      phone_use_score_status: 'android_usage_access',
      phone_use_window_count: 3,
    }, {});
    expect(findRow(usageRows, 'phone-use-provenance')).toMatchObject({
      value: 'available',
      confidence: 'recorded',
      sampleCount: '3',
      dataSourceLabel: 'Android Usage Access',
    });

    const proxyRows = buildSourceEvidenceRows({
      phone_use_events: [{ source: 'gps_proxy', diagnostic_only: true }],
    }, {});
    expect(findRow(proxyRows, 'phone-use-provenance')).toMatchObject({
      value: 'GPS proxy diagnostics only',
      confidence: 'diagnostic',
      dataSourceLabel: 'GPS diagnostic proxy',
    });
    expect(findRow(proxyRows, 'phone-use-provenance').detail).toContain('diagnostic');
  });

  it('counts OBD samples from explicit metadata or route point evidence', () => {
    expect(countObdPowertrainSamples({ obd_powertrain_sample_count: 0 })).toBe(0);
    expect(countObdPowertrainSamples({
      route_points: [
        { speed_kmh: 30 },
        { obd_rpm: 1800 },
        { obd_throttle_pct: 21 },
        { obd_speed_kmh: 42 },
      ],
    })).toBe(3);
    expect(countObdPowertrainSamples({ id: 'missing-route' })).toBeNull();
  });

  it('summarizes provenance and unavailable rows for the console', () => {
    const data = buildTrackingEvidenceConsoleData({
      trip: {
        id: 'trip-1',
        score_overall: 91,
        score_provenance: {
          scoring_version: '2.6.0',
          computed_at: '2026-07-09T12:00:00.000Z',
          components: { overall: 'developing' },
          constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
        },
      },
      settings: {},
    });

    expect(data.tripId).toBe('trip-1');
    expect(data.summary.scoringVersion).toBe('2.6.0');
    expect(data.summary.unavailableCount).toBeGreaterThan(0);
    expect(findRow(data.provenanceRows, 'scoring-version')).toMatchObject({
      label: 'Scoring version',
      value: '2.6.0',
      detail: 'Computed 2026-07-09T12:00:00.000Z',
    });
  });
});
