import { describe, expect, it } from 'vitest';
import {
  calculateRouteSummary,
  calculateTripStats,
  cleanRoutePoints,
  haversineDistance,
  shouldAcceptLocationPoint,
} from '@/lib/tripEngine';
import {
  shouldAutoStartTracking,
  shouldAutoStopTracking,
  ACTIVITY_TYPES,
} from '@/lib/activityRecognition';
import {
  buildScoreTips,
  buildSpeedSegments,
  buildDrivingCoachInsights,
  calculateAchievementBadges,
  calculateFatigueRisk,
  calculateDrivingConsistency,
  calculateNoHarshBrakeStreak,
  calculateRiskEventRate,
  calculateSpeedDiscipline,
  calculateWeeklyDrivingGoals,
  detectTripStops,
  estimateTripEconomics,
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  getMaintenanceStatus,
  getVehicleOdometerKm,
} from '@/lib/tripInsights';

const point = (lat, lng, seconds, speedKmh = 40, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh: speedKmh,
  accuracy,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

describe('tripEngine', () => {
  it('calculates haversine distance for nearby route points', () => {
    const km = haversineDistance(43.6532, -79.3832, 43.6542, -79.3832);
    expect(km).toBeGreaterThan(0.1);
    expect(km).toBeLessThan(0.12);
  });

  it('rejects inaccurate, duplicate, and impossible GPS points', () => {
    const first = point(43.6532, -79.3832, 0);
    const duplicate = point(43.6532001, -79.3832001, 2);
    const badAccuracy = point(43.654, -79.384, 12, 40, 120);
    const impossibleJump = point(44.6532, -80.3832, 14, 40, 5);

    expect(shouldAcceptLocationPoint(first)).toBe(true);
    expect(shouldAcceptLocationPoint(duplicate, first)).toBe(false);
    expect(shouldAcceptLocationPoint(badAccuracy, first)).toBe(false);
    expect(shouldAcceptLocationPoint(impossibleJump, first)).toBe(false);
  });

  it('summarizes distance, duration, average speed, max speed, and idle time', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0),
      point(43.6542, -79.3832, 10, 40),
      point(43.6552, -79.3832, 70, 0),
    ];

    const stats = calculateTripStats(points, points[0].timestamp, points[2].timestamp);

    expect(stats.distance_km).toBeGreaterThan(0.2);
    expect(stats.duration_seconds).toBe(70);
    expect(stats.avg_speed_kmh).toBe(11.4);
    expect(stats.max_speed_kmh).toBe(40);
    expect(stats.idle_time_seconds).toBe(60);
  });

  it('cleans noisy route points before calculating route summaries', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0),
      point(43.6532001, -79.3832001, 2, 0),
      point(43.6542, -79.3832, 20, 35),
      point(43.6552, -79.3832, 40, 45),
    ];

    const summary = calculateRouteSummary(points, points[0].timestamp, points[3].timestamp);

    expect(cleanRoutePoints(points)).toHaveLength(3);
    expect(summary.stats.distance_km).toBeGreaterThan(0.2);
    expect(summary.scores.score_overall).toBeGreaterThan(0);
  });

  it('does not turn stationary GPS jitter into speed or distance', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0, 12),
      point(43.653235, -79.383225, 12, 16, 18),
      point(43.65318, -79.38326, 30, 14, 20),
      point(43.65322, -79.38321, 50, 15, 18),
    ];

    const stats = calculateTripStats(points, points[0].timestamp, points[3].timestamp);

    expect(stats.distance_km).toBe(0);
    expect(stats.avg_speed_kmh).toBe(0);
    expect(stats.max_speed_kmh).toBe(0);
  });
});

describe('auto tracking decision logic', () => {
  it('starts only when activity and speed strongly suggest driving', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 82 },
      currentSpeedKmh: 28,
      recentMovingSeconds: 30,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 95 },
      currentSpeedKmh: 6,
      recentMovingSeconds: 60,
    })).toBe(false);
  });

  it('stops only after still or non-vehicle signals persist', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 240,
    })).toBe(true);

    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 70 },
      currentSpeedKmh: 8,
      stillSeconds: 30,
    })).toBe(false);
  });
});

describe('trip insights', () => {
  it('builds speed-colored route segments from GPS points', () => {
    const points = [
      point(43.6532, -79.3832, 0, 20),
      point(43.6542, -79.3832, 10, 65),
      point(43.6552, -79.3832, 20, 125),
    ];

    const segments = buildSpeedSegments(points);

    expect(segments).toHaveLength(2);
    expect(segments[0].label).toBe('Cruise');
    expect(segments[1].label).toBe('Risk');
  });

  it('estimates odometer, maintenance, fuel cost, CO2, tips, and badges', () => {
    const trips = [
      {
        id: 't1',
        vehicle_id: 'v1',
        status: 'completed',
        start_time: new Date().toISOString(),
        distance_km: 100,
        score_overall: 96,
        harsh_brakes_count: 0,
        rapid_accel_count: 0,
        sharp_turns_count: 0,
        speeding_events_count: 0,
      },
    ];
    const vehicle = {
      id: 'v1',
      odometer_km: 7000,
      fuel_efficiency_l_per_100km: 10,
      fuel_price_per_liter: 2,
      maintenance_items: [{ id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 }],
    };

    expect(getVehicleOdometerKm(vehicle, trips)).toBe(7100);
    expect(getMaintenanceStatus(vehicle, trips)[0].status).toBe('soon');
    expect(estimateTripEconomics(trips[0], vehicle).cost).toBe(20);
    expect(estimateTripEconomics(trips[0], vehicle).co2_kg).toBe(23.1);
    expect(buildScoreTips(trips)[0]).toContain('excellent');
    expect(calculateAchievementBadges(trips).find((badge) => badge.id === 'perfect_trip').earned).toBe(true);
  });

  it('detects stops and summarizes driver-focused analytics', () => {
    const stoppedPoints = [
      point(43.6532, -79.3832, 0, 30),
      point(43.6532, -79.3832, 10, 0),
      point(43.6532, -79.3832, 130, 0),
      point(43.6542, -79.3832, 150, 25),
    ];
    const now = new Date();
    const todayTrip = {
      id: 'today',
      status: 'completed',
      start_time: now.toISOString(),
      duration_seconds: 150 * 60,
      distance_km: 50,
      score_overall: 82,
      harsh_brakes_count: 0,
      rapid_accel_count: 1,
      sharp_turns_count: 0,
      speeding_events_count: 1,
      night_driving: false,
      route_points: [
        point(43.6532, -79.3832, 0, 45),
        point(43.6542, -79.3832, 10, 145),
      ],
    };

    expect(detectTripStops(stoppedPoints)).toHaveLength(1);
    expect(calculateNoHarshBrakeStreak([todayTrip])).toBe(1);
    expect(calculateFatigueRisk([todayTrip], { threshold_long_drive_minutes: 120 }).level).toBe('medium');
    expect(calculateWeeklyDrivingGoals([todayTrip], {
      weekly_goal_harsh_brakes: 0,
      weekly_goal_speeding_events: 0,
      weekly_goal_min_avg_score: 80,
      weekly_goal_max_night_trips: 0,
    }).find((goal) => goal.id === 'speeding').met).toBe(false);
    expect(calculateRiskEventRate([todayTrip]).events_per_100km).toBe(4);
    expect(calculateSpeedDiscipline([todayTrip], { threshold_speeding_kmh: 130 }).level).toBe('needs_attention');
    expect(calculateDrivingConsistency([todayTrip]).consistency_score).toBe(100);
    expect(buildDrivingCoachInsights([todayTrip], { threshold_speeding_kmh: 130 }).focus_area).toBe('acceleration');
    expect(analyzeTimeOfDay([todayTrip]).reduce((sum, bucket) => sum + bucket.trips, 0)).toBe(1);
    expect(analyzeDayOfWeek([todayTrip]).reduce((sum, day) => sum + day.trips, 0)).toBe(1);
  });
});
