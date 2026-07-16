import { describe, expect, it } from 'vitest';
import {
  filterTrackingEventRows,
  normalizeTrackingEventRows,
  trackingEventSourceOptions,
} from '@/lib/trackingEvents';

const baseTrip = {
  id: 'trip-1',
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  route_points: [
    { lat: 43.65, lng: -79.38, speed_kmh: 40, timestamp: '2026-01-01T12:00:00.000Z' },
    { lat: 43.651, lng: -79.381, speed_kmh: 52, timestamp: '2026-01-01T12:01:00.000Z' },
    { lat: 43.652, lng: -79.382, speed_kmh: 55, timestamp: '2026-01-01T12:06:00.000Z', route_gap: true },
  ],
};

describe('tracking event normalization', () => {
  it('uses neutral event wording and threshold context', () => {
    const rows = normalizeTrackingEventRows({
      ...baseTrip,
      driving_events: [{
        type: 'harsh_brake',
        timestamp: '2026-01-01T12:01:00.000Z',
        value: 4.8,
        speed_kmh: 52,
        severity: 'medium',
        source: 'gps_events',
        point_index: 1,
      }],
    });

    expect(rows[0]).toMatchObject({
      label: 'Hard braking event',
      valueLabel: '4.8 m/s2',
      speedLabel: '52 km/h',
      sourceLabel: 'GPS event detection',
      scoringStatus: 'scored evidence',
    });
    expect(rows[0].thresholdNote).toContain('harsh-brake threshold');
    expect(rows[0].relatedRoutePoint).toMatchObject({ index: 1, speedKmh: 52 });
  });

  it('labels diagnostic-only events as diagnostic and not scored', () => {
    const rows = normalizeTrackingEventRows({
      ...baseTrip,
      driving_events: [{
        type: 'aggressive_overtake',
        timestamp: '2026-01-01T12:01:00.000Z',
        diagnostic_only: true,
        confidence: 0.72,
        source: 'gps_events',
      }],
    });
    const overtake = rows.find((row) => row.type === 'aggressive_overtake');

    expect(overtake.label).toBe('Overtake pattern recorded');
    expect(overtake.confidence).toBe('diagnostic');
    expect(overtake.scoringStatus).toBe('diagnostic / not scored');
  });

  it('distinguishes GPS proxy phone-use diagnostics from Android Usage Access evidence', () => {
    const rows = normalizeTrackingEventRows({
      ...baseTrip,
      driving_events: [
        {
          type: 'phone_use',
          source: 'gps_proxy',
          diagnostic_only: true,
          timestamp: '2026-01-01T12:01:00.000Z',
          durationS: 12,
          confidence: 0.68,
        },
        {
          type: 'phone_use',
          source: 'android_usage_access',
          timestamp: '2026-01-01T12:02:00.000Z',
          durationS: 25,
          confidence: 0.92,
          confidence_level: 'high',
        },
      ],
    });

    const proxy = rows.find((row) => row.source === 'gps_proxy');
    const usage = rows.find((row) => row.source === 'android_usage_access');

    expect(proxy.label).toBe('Phone-use window detected');
    expect(proxy.scoringStatus).toBe('diagnostic / not scored');
    expect(proxy.dataSourceNote).toBe('GPS diagnostic proxy; not Android Usage Access evidence.');
    expect(usage.scoringStatus).toBe('scored evidence');
    expect(usage.sourceLabel).toBe('Android Usage Access');
    expect(usage.dataSourceNote).toBe('Android Usage Access evidence recorded for the trip.');
  });

  it('adds route gaps and privacy gaps as technical log rows', () => {
    const rows = normalizeTrackingEventRows({
      ...baseTrip,
      route_points: [
        ...baseTrip.route_points,
        {
          lat: null,
          lng: null,
          timestamp: '2026-01-01T12:08:00.000Z',
          masked_for_privacy: true,
          privacy_gap: true,
          privacy_zone_label: 'Home',
        },
      ],
    });

    expect(rows.some((row) => row.type === 'route_gap' && row.scoringStatus === 'diagnostic / not scored')).toBe(true);
    expect(rows.some((row) => row.type === 'privacy_gap' && row.privacyStatus === 'privacy masked')).toBe(true);
  });

  it('filters by source, diagnostic level, and privacy state', () => {
    const rows = normalizeTrackingEventRows({
      ...baseTrip,
      driving_events: [{
        type: 'phone_use',
        source: 'gps_proxy',
        diagnostic_only: true,
        timestamp: '2026-01-01T12:01:00.000Z',
      }],
    });

    expect(trackingEventSourceOptions(rows).map((option) => option.value)).toContain('gps_proxy');
    expect(filterTrackingEventRows(rows, { source: 'gps_proxy' })).toHaveLength(1);
    expect(filterTrackingEventRows(rows, { severity: 'diagnostic' }).every((row) => row.diagnostic)).toBe(true);
    expect(filterTrackingEventRows(rows, { privacy: 'masked' })).toEqual([]);
  });
});
