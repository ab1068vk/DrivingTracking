import { describe, expect, it } from 'vitest';
import { buildMapDiagnosticsAggregate } from '@/lib/mapDiagnostics';

describe('buildMapDiagnosticsAggregate', () => {
  it('summarizes every filtered route displayed in the map overview', () => {
    const aggregate = buildMapDiagnosticsAggregate([
      {
        distance_km: 4.8,
        duration_seconds: 370,
        avg_speed_kmh: 41,
        max_speed_kmh: 47,
        route_points_raw_count: 38,
        driving_events: [],
        traffic_stop_count: 0,
      },
      {
        distance_km: 38.6,
        duration_seconds: 2590,
        avg_speed_kmh: 55,
        max_speed_kmh: 92,
        route_points_map_count: 266,
        driving_events_count: 8,
        stop_count: 0,
      },
    ]);

    expect(aggregate).toEqual({
      distance_km: 43.4,
      duration_seconds: 2960,
      max_speed_kmh: 92,
      avg_speed_kmh: expect.closeTo(52.78, 2),
      route_points_raw_count: 304,
      driving_events_count: 8,
      traffic_stop_count: 0,
    });
  });

  it('handles an empty filtered overview without inventing diagnostics', () => {
    expect(buildMapDiagnosticsAggregate([])).toEqual({
      distance_km: 0,
      duration_seconds: 0,
      max_speed_kmh: 0,
      avg_speed_kmh: 0,
      route_points_raw_count: 0,
      driving_events_count: 0,
      traffic_stop_count: 0,
    });
  });
});
