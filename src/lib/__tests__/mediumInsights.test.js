import { describe, expect, it } from 'vitest';
import {
  buildCommuteDetections,
  buildMaintenanceReminders,
  buildRiskHotspots,
  buildRouteComparisons,
  buildWeeklyDriverSummary,
  routeKeyForTrip,
} from '@/lib/mediumInsights';

const point = (lat, lng) => ({ lat, lng });

const trip = (overrides = {}) => ({
  id: `trip_${Math.random().toString(36).slice(2)}`,
  status: 'completed',
  start_time: '2026-05-12T08:30:00.000Z',
  end_time: '2026-05-12T09:00:00.000Z',
  score_overall: 84,
  score_safety: 82,
  braking_efficiency_score: 80,
  cornering_consistency_score: 78,
  svi_score: 81,
  distance_km: 18,
  duration_seconds: 1800,
  route_points: [point(43.65, -79.38), point(43.7, -79.42)],
  driving_events: [],
  ...overrides,
});

describe('mediumInsights', () => {
  it('uses route shape to compare repeated routes and detect commutes without addresses', () => {
    const trips = [
      trip({ id: 'm1', start_time: '2026-05-11T08:30:00', score_overall: 86 }),
      trip({ id: 'm2', start_time: '2026-05-12T08:30:00', score_overall: 82 }),
      trip({ id: 'm3', start_time: '2026-05-13T08:30:00', score_overall: 88 }),
    ];

    const routes = buildRouteComparisons(trips);
    const commutes = buildCommuteDetections(trips);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      label: 'Morning commute',
      trip_count: 3,
      avg_score: 85,
    });
    expect(routes[0].safest_time).toContain('8:30');
    expect(commutes[0]).toMatchObject({
      label: 'Morning commute',
      trip_count: 3,
      explanation: 'Repeated weekday route detected from similar start and end areas.',
    });
  });

  it('ignores malformed route coordinates instead of creating NaN route keys', () => {
    expect(routeKeyForTrip({ route_points: [{ lat: 'bad', lng: -79 }, point(43.7, -79.4)] })).toBeNull();
  });

  it('does not claim weekly improvement when there is no previous week baseline', () => {
    const summary = buildWeeklyDriverSummary([
      trip({ start_time: new Date().toISOString(), braking_efficiency_score: 90 }),
    ]);

    expect(summary.biggest_improvement).toBe('more trips needed');
  });

  it('does not compare an observed SVI week with an unavailable SVI baseline', () => {
    const current = new Date();
    const previous = new Date(current.getTime() - 8 * 24 * 60 * 60 * 1000);
    const summary = buildWeeklyDriverSummary([
      trip({
        start_time: current.toISOString(),
        cornering_consistency_score: 78,
        braking_efficiency_score: 80,
        score_safety: 82,
        svi_score: 98,
      }),
      trip({
        start_time: previous.toISOString(),
        cornering_consistency_score: 78,
        braking_efficiency_score: 80,
        score_safety: 82,
        svi_score: null,
      }),
    ]);

    expect(summary.biggest_improvement).toBe('more trips needed');
  });

  it('builds risk hotspots from repeated harsh or speeding events', () => {
    const hotspots = buildRiskHotspots([
      trip({
        driving_events: [
          { type: 'harsh_brake', severity: 'high', lat: 43.65, lng: -79.38, timestamp: '2026-05-12T08:40:00.000Z' },
          { type: 'speeding', severity: 'medium', lat: 43.65, lng: -79.38, timestamp: '2026-05-12T08:41:00.000Z' },
        ],
      }),
    ]);

    expect(hotspots).toHaveLength(1);
    expect(hotspots[0].eventCount).toBe(2);
    expect(hotspots[0].typeBreakdown.speeding).toBe(1);
  });

  it('uses completed vehicle distance and renewal dates for maintenance reminders', () => {
    const reminders = buildMaintenanceReminders(
      {
        odometer_km: undefined,
        registration_renewal_date: '2026-05-20',
        maintenance_items: [
          { id: 'oil', label: 'Oil change', interval_km: 1000, last_service_km: 0 },
        ],
      },
      [
        trip({ distance_km: 1200 }),
        trip({ status: 'draft', distance_km: 9000 }),
      ]
    );

    expect(reminders.find((item) => item.id === 'oil')).toMatchObject({
      remaining_km: -200,
      status: 'due',
    });
    expect(reminders.find((item) => item.id === 'registration')?.type).toBe('date');
  });
});
