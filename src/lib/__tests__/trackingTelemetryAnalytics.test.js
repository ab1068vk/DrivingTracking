import { describe, expect, it } from 'vitest';
import {
  buildNormalizedComparison,
  buildTrackingTrendSeries,
  buildTripTelemetrySeries,
  nearestTelemetrySample,
  summarizeTripTelemetry,
} from '@/lib/trackingTelemetryAnalytics';

const trip = {
  id: 'trip-a',
  start_time: '2026-01-01T12:00:00.000Z',
  duration_seconds: 30,
  route_points: [
    { timestamp: '2026-01-01T12:00:00.000Z', lat: 43.1, lng: -79.1, speed_kmh: 0, accuracy: 8, speed_limit_kmh: 40 },
    { timestamp: '2026-01-01T12:00:10.000Z', lat: 43.2, lng: -79.2, speed_kmh: 36, accuracy: 12, speed_limit_kmh: 40 },
    { timestamp: '2026-01-01T12:00:20.000Z', lat: 43.3, lng: -79.3, speed_kmh: 54, accuracy: 10, speed_limit_kmh: 40 },
    { timestamp: '2026-01-01T12:00:30.000Z', lat: null, lng: null, speed_kmh: 0, privacy_gap: true, masked_for_privacy: true },
  ],
  driving_events: [{ type: 'speeding', timestamp: '2026-01-01T12:00:20.000Z' }],
};

describe('trackingTelemetryAnalytics', () => {
  it('builds privacy-safe linked telemetry and derived motion evidence', () => {
    const rows = buildTripTelemetrySeries(trip);
    expect(rows).toHaveLength(4);
    expect(rows[1].accelerationMs2).toBeCloseTo(1, 4);
    expect(rows[1].accelerationSource).toBe('derived from speed');
    expect(rows[2].observationLabel).toBe('Speeding');
    expect(rows[3].privacyMasked).toBe(true);
    expect(rows[3].lat).toBeNull();
    expect(rows[3].accelerationMs2).toBeNull();
  });

  it('summarizes coverage, gaps, and evidence without inventing unavailable samples', () => {
    const rows = buildTripTelemetrySeries(trip);
    const summary = summarizeTripTelemetry(trip, rows);
    expect(summary.speedLimitCoveragePct).toBe(75);
    expect(summary.thresholdExceededPct).toBe(33);
    expect(summary.privacyGapCount).toBe(1);
    expect(summary.accelerationEvidence).toBe('derived from speed');
  });

  it('finds the nearest timestamp and aligns comparison by normalized progress', () => {
    const rows = buildTripTelemetrySeries(trip);
    expect(nearestTelemetrySample(rows, Date.parse('2026-01-01T12:00:19.000Z')).sourceIndex).toBe(2);
    const comparison = buildNormalizedComparison(trip, {
      ...trip,
      id: 'trip-b',
      duration_seconds: 60,
      route_points: trip.route_points.map((point, index) => ({
        ...point,
        timestamp: new Date(Date.parse(trip.start_time) + index * 20_000).toISOString(),
        speed_kmh: index * 10,
      })),
    }, 10);
    expect(comparison).toHaveLength(11);
    expect(comparison[10].progress).toBe(100);
  });

  it('normalizes observation rate per distance for overview trends', () => {
    const rows = buildTrackingTrendSeries([{ ...trip, distance_km: 10, driving_events: undefined, event_count: 2 }]);
    expect(rows[0].eventRate).toBe(2);
  });
});
