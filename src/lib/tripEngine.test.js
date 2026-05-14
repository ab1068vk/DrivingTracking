import { describe, expect, it } from 'vitest';
import {
  calculateNightPenalty,
  calculateJerkScore,
  calculateFuelBandScore,
  calculateSmoothBrakingRatio,
  calculateSpeedVariabilityIndex,
  classifyRoadType,
  calculateRouteSummary,
  calculateTripScores,
  calculateTripStats,
  cleanRoutePoints,
  computeSmoothedAccelerations,
  detectDrivingEvents,
  detectLaneChanges,
  EVENT_TYPES,
  haversineDistance,
  shouldAcceptLocationPoint,
  simplifyRoute,
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
  calculateVehicleHealthImpact,
  computePersonalBaseline,
  detectTripStops,
  estimateTripEconomics,
  suggestTripTag,
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
    expect(stats.avg_speed_kmh).toBe(80.1);
    expect(stats.avg_running_speed_kmh).toBe(80.1);
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

  it('detects sharp turns using lateral G-force at running speed', () => {
    const points = [
      { ...point(43.6532, -79.3832, 0, 80), heading: 0 },
      { ...point(43.6534, -79.3832, 1, 80), heading: 0 },
      { ...point(43.6536, -79.3832, 2, 80), heading: 0 },
      { ...point(43.6538, -79.3832, 3, 80), heading: 45 },
    ];

    const events = detectDrivingEvents(points);
    const sharpTurn = events.find((event) => event.type === EVENT_TYPES.SHARP_TURN);

    expect(sharpTurn).toBeTruthy();
    expect(sharpTurn.value).toBeGreaterThan(0.45);
  });

  it('uses centered acceleration to smooth point-to-point speed changes', () => {
    const points = [
      point(43.6532, -79.3832, 0, 80),
      point(43.6534, -79.3832, 1, 60),
      point(43.6536, -79.3832, 2, 40),
    ];

    const smooth = computeSmoothedAccelerations(points)[1];
    const forward = (40 / 3.6 - 60 / 3.6) / 1;

    expect(Math.abs(smooth.accel_ms2)).toBeLessThan(Math.abs(forward));
  });

  it('normalizes score by event rate instead of raw trip length', () => {
    const shortEvents = [{ type: EVENT_TYPES.HARSH_BRAKE, severity: 'low', speed_kmh: 30 }];
    const longEvents = Array.from({ length: 10 }, () => ({
      type: EVENT_TYPES.HARSH_BRAKE,
      severity: 'low',
      speed_kmh: 30,
    }));

    const shortScore = calculateTripScores(shortEvents, { distance_km: 5, fatigue_risk_score: 0 }, []);
    const longScore = calculateTripScores(longEvents, { distance_km: 50, fatigue_risk_score: 0 }, []);

    expect(longScore.score_overall).toBe(shortScore.score_overall);
  });

  it('classifies road type and calculates advanced smoothness fields', () => {
    const highwayPoints = Array.from({ length: 8 }, (_, index) => ({
      ...point(43.6532 + index * 0.001, -79.3832, index * 5, 90),
      heading: index < 4 ? 0 : 15,
    }));

    expect(classifyRoadType(highwayPoints).road_type).toBe('highway');
    expect(calculateJerkScore([
      point(43.6532, -79.3832, 0, 40),
      point(43.6534, -79.3832, 1, 50),
      point(43.6536, -79.3832, 2, 40),
    ], 1).jerk_score).toBeLessThan(100);
    expect(detectLaneChanges(highwayPoints).length).toBeGreaterThan(0);
  });

  it('computes second-wave advanced score components from route points', () => {
    const points = [
      point(43.6532, -79.3832, 0, 70),
      point(43.6542, -79.3832, 5, 72),
      point(43.6552, -79.3832, 10, 74),
      point(43.6562, -79.3832, 15, 20),
      point(43.6572, -79.3832, 20, 0),
    ];

    expect(calculateSpeedVariabilityIndex(points).svi_score).toBeLessThan(100);
    expect(calculateFuelBandScore(points).fuel_band_score).toBeGreaterThan(0);
    expect(calculateSmoothBrakingRatio(points).total_stops_detected).toBe(1);
    const scores = calculateTripScores([], { distance_km: 2, fatigue_risk_score: 0, intersection_score: 100 }, points);
    expect(scores.defensive_driving_score).toBeGreaterThan(0);
    expect(scores.aggressive_driving_score).toBeGreaterThan(0);
  });

  it('scales night penalty by night and deep-night route share', () => {
    const day = point(43.6532, -79.3832, 0, 40);
    const night = { ...day, timestamp: new Date(2026, 0, 1, 23, 0, 0).toISOString() };
    const deepNight = { ...day, timestamp: new Date(2026, 0, 1, 3, 0, 0).toISOString() };

    expect(calculateNightPenalty([day, night])).toBeGreaterThan(0);
    expect(calculateNightPenalty([deepNight, deepNight])).toBeGreaterThan(calculateNightPenalty([day, night]));
  });

  it('does not emit idle events below the 90 second traffic-stop grace period', () => {
    const points = [
      point(43.6532, -79.3832, 0, 30),
      point(43.6534, -79.3832, 10, 30),
      point(43.6536, -79.3832, 20, 0),
      point(43.6538, -79.3832, 80, 0),
    ];

    expect(detectDrivingEvents(points).some((event) => event.type === EVENT_TYPES.IDLE)).toBe(false);
  });

  it('simplifies straight route points while preserving corners', () => {
    const straight = Array.from({ length: 10 }, (_, index) => point(43.6532 + index * 0.0001, -79.3832, index, 40));
    const corner = point(43.6542, -79.3822, 10, 40);
    const afterCorner = Array.from({ length: 10 }, (_, index) => point(43.6542, -79.3822 + index * 0.0001, 11 + index, 40));
    const route = [...straight, corner, ...afterCorner];

    const simplified = simplifyRoute(route, 10, [{ lat: corner.lat, lng: corner.lng }]);

    expect(simplified.length).toBeLessThan(route.length);
    expect(simplified.some((item) => item.lat === corner.lat && item.lng === corner.lng)).toBe(true);
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
    const badges = calculateAchievementBadges(trips);
    expect(badges).toHaveLength(26);
    expect(badges.find((badge) => badge.id === 'first_drive').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'perfect_trip').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'hundred_km').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'five_hundred_km').current).toBe(100);
  });

  it('unlocks expanded achievement milestones from driving behavior', () => {
    const routePoints = Array.from({ length: 20 }, (_, index) => ({
      lat: 43.6532 + index * 0.0001,
      lng: -79.3832,
      speed_kmh: 45,
      timestamp: new Date(Date.now() + index * 1000).toISOString(),
    }));
    const trips = Array.from({ length: 10 }, (_, index) => ({
      id: `trip-${index}`,
      status: 'completed',
      start_time: new Date(Date.now() - index * 86400000).toISOString(),
      duration_seconds: index === 0 ? 70 * 60 : 20 * 60,
      distance_km: 55,
      score_overall: 88,
      harsh_brakes_count: 0,
      rapid_accel_count: 0,
      sharp_turns_count: 0,
      speeding_events_count: 0,
      night_driving: index < 5,
      route_points: index === 0 ? routePoints : [],
    }));

    const badges = calculateAchievementBadges(trips);

    expect(badges.find((badge) => badge.id === 'ten_trips').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'five_hundred_km').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'steady_five').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'gentle_brakes').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'smooth_starts').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'corner_control').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'speed_sentinel').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'route_replay_ready').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'long_drive_clean').earned).toBe(true);
    expect(badges.find((badge) => badge.id === 'night_owl').earned).toBe(true);
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
    expect(calculateDrivingConsistency([todayTrip]).consistency_score).toBeNull();
    expect(buildDrivingCoachInsights([todayTrip], { threshold_speeding_kmh: 130 }).focus_area).toBe('acceleration');
    expect(analyzeTimeOfDay([todayTrip]).reduce((sum, bucket) => sum + bucket.trips, 0)).toBe(1);
    expect(analyzeDayOfWeek([todayTrip]).reduce((sum, day) => sum + day.trips, 0)).toBe(1);
  });

  it('computes auto tags, baselines, fuel savings, and vehicle stress impact', () => {
    const commute = {
      id: 'commute',
      status: 'completed',
      start_time: new Date(2026, 0, 5, 8, 0, 0).toISOString(),
      duration_seconds: 30 * 60,
      distance_km: 20,
      score_overall: 88,
      eco_driving_score: 90,
      driving_events: [{ type: 'harsh_brake', severity: 'medium' }],
    };
    const trips = Array.from({ length: 4 }, (_, index) => ({
      ...commute,
      id: `baseline-${index}`,
      start_time: new Date(Date.now() - index * 86400000).toISOString(),
      score_overall: 80 + index,
    }));

    expect(suggestTripTag(commute).auto_tag).toBe('work');
    expect(estimateTripEconomics(commute, { fuel_efficiency_l_per_100km: 10 }).fuel_saved_liters).toBeGreaterThan(0);
    expect(computePersonalBaseline(trips).baseline_avg).not.toBeNull();
    expect(calculateVehicleHealthImpact([commute], {}).extra_wear_km).toBe(32);
  });
});
