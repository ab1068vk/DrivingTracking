import { describe, expect, it } from 'vitest';
import {
  calculateNightPenalty,
  calculateJerkScore,
  calculateFuelBandScore,
  calculateSegmentMetrics,
  calculateSmoothBrakingRatio,
  calculateSpeedVariabilityIndex,
  classifyRoadType,
  calculateRouteSummary,
  calculateTripScores,
  calculateTripStats,
  calculateHillDrivingScore,
  calculateEcoDrivingScore,
  calculateReactionTimeProxy,
  calculateSpeedLimitCompliance,
  cleanRoutePoints,
  computeSmoothedAccelerations,
  detectDrivingEvents,
  detectSpeedCreep,
  detectHighwayMergeBehavior,
  inferSpeedZones,
  detectLaneChanges,
  detectErraticSpeedWindows,
  detectTailgateCycles,
  DEFAULT_THRESHOLDS,
  EVENT_TYPES,
  TRIP_STATES,
  haversineDistance,
  isNearRecentParkedLocation,
  isNightDrivingTime,
  shouldAcceptLocationPoint,
  simplifyRoute,
  splitTripAtStops,
  trimParkedTail,
  validateCandidateTrip,
} from '@/lib/tripEngine';
import { getLastParkedLocation, saveLastParkedLocation } from '@/lib/trackingStore';
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

  it('ignores privacy-masked null coordinates in segment and trip distances', () => {
    const points = [
      { lat: null, lng: null, speed_kmh: 30, timestamp: point(43.6532, -79.3832, 0).timestamp, masked_for_privacy: true },
      point(43.6532, -79.3832, 10, 30),
      point(43.6542, -79.3832, 20, 35),
      { lat: null, lng: null, speed_kmh: 0, timestamp: point(43.6542, -79.3832, 30).timestamp, masked_for_privacy: true },
    ];

    const maskedSegment = calculateSegmentMetrics(points[0], points[1]);
    expect(maskedSegment.distanceKm).toBe(0);
    expect(maskedSegment.isNoise).toBe(true);
    expect(haversineDistance(null, null, 43.6532, -79.3832)).toBe(0);

    const stats = calculateTripStats(points, points[0].timestamp, points[3].timestamp);
    expect(stats.distance_km).toBeGreaterThan(0.1);
    expect(stats.distance_km).toBeLessThan(0.12);

    const zones = inferSpeedZones(points);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((zone) => zone.startIndex > 0 && zone.endIndex < points.length - 1)).toBe(true);
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

  it('keeps first-commit distance and max-speed stats for recorded points', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0, 12),
      point(43.653235, -79.383225, 12, 16, 18),
      point(43.65318, -79.38326, 30, 14, 20),
      point(43.65322, -79.38321, 50, 15, 18),
    ];

    const stats = calculateTripStats(points, points[0].timestamp, points[3].timestamp);

    expect(stats.distance_km).toBeGreaterThan(0);
    expect(stats.avg_speed_kmh).toBeGreaterThan(0);
    expect(stats.max_speed_kmh).toBe(16);
  });

  it('keeps raw max speed while avoiding spike-generated speeding events', () => {
    const points = [40, 42, 180, 43, 41].map((speed, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 10, speed, 6)
    ));

    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const events = detectDrivingEvents(points).events;

    expect(stats.max_speed_kmh).toBe(180);
    expect(events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(false);
  });

  it('scores steady 105 km/h cruising inside the default eco cruise band', () => {
    const points = Array.from({ length: 6 }, (_, index) => (
      point(43.6532 + index * 0.0025, -79.3832, index * 10, 105, 6)
    ));

    const result = calculateEcoDrivingScore(points);

    expect(result.cruise_score).toBeGreaterThan(0);
  });

  it('uses the named eco cruise multiplier to give full cruise credit at roughly 77% cruise-band samples', () => {
    const points = Array.from({ length: 100 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, index < 77 ? 80 : 40, 6)
    ));

    expect(DEFAULT_THRESHOLDS.ECO_CRUISE_SCORE_MULTIPLIER).toBe(130);
    expect(calculateEcoDrivingScore(points).cruise_score).toBe(100);
  });

  it('keeps 50% cruise-band driving near 65 cruise points with the default multiplier', () => {
    const points = Array.from({ length: 100 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, index < 50 ? 80 : 40, 6)
    ));

    expect(calculateEcoDrivingScore(points).cruise_score).toBe(65);
  });

  it('keeps the default 1% avoidable idle eco penalty under two points', () => {
    const points = Array.from({ length: 10 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 80, 6)
    ));

    const result = calculateEcoDrivingScore(points, {
      duration_seconds: 1000,
      sustained_idle_seconds: 10,
    });

    expect(result.idle_penalty_points).toBe(1.5);
    expect(result.idle_penalty_points).toBeLessThan(2);
  });

  it('can lower the eco moving-speed floor for stop-and-go city scoring', () => {
    const points = Array.from({ length: 6 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 10, 6)
    ));

    expect(calculateEcoDrivingScore(points).eco_driving_score).toBe(50);
    expect(calculateEcoDrivingScore(points, {}, {
      ...DEFAULT_THRESHOLDS,
      ECO_MIN_MOVING_KMH: 5,
    }).eco_driving_score).toBeGreaterThan(50);
  });

  it('ignores low-quality altitude samples for hill control', () => {
    const points = [40, 45, 50, 45, 40].map((speed, index) => ({
      ...point(43.6532 + index * 0.001, -79.3832, index * 10, speed, 6),
      altitude: index % 2 === 0 ? 100 : 130,
      altitude_accuracy: 80,
    }));

    expect(calculateHillDrivingScore(points)).toMatchObject({
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
    });
  });

  it('keeps hill distance sensitive enough for short mapped climbs and descents', () => {
    const uphill = Array.from({ length: 12 }, (_, index) => ({
      ...point(43.6532 + index * 0.00009, -79.3832, index * 2, 25, 6),
      altitude: 100 + index * 0.55,
      altitude_accuracy: 8,
    }));
    const downhill = Array.from({ length: 12 }, (_, index) => ({
      ...point(43.6543 + index * 0.00009, -79.3832, 24 + index * 2, 25, 6),
      altitude: 106.05 - index * 0.55,
      altitude_accuracy: 8,
    }));

    const result = calculateHillDrivingScore([...uphill, ...downhill]);

    expect(result.climb_distance_km).toBeGreaterThanOrEqual(0.08);
    expect(result.descent_distance_km).toBeGreaterThanOrEqual(0.08);
  });

  it('does not let one speed spike distort compliance or speed creep', () => {
    const points = [90, 91, 92, 170].map((speed, index) => (
      point(43.6532 + index * 0.0025, -79.3832, index * 10, speed, 6)
    ));
    const stats = {
      speed_zones: [{ startIndex: 0, endIndex: points.length - 1, inferredZoneKmh: 100 }],
    };

    expect(calculateSpeedLimitCompliance(points, stats, DEFAULT_THRESHOLDS).overall_compliance_score).toBe(100);
    expect(detectSpeedCreep(points, DEFAULT_THRESHOLDS).speed_creep_event_count).toBe(0);
  });

  it('detects sharp turns using lateral G-force at running speed', () => {
    const points = [
      point(43.6532, -79.3832, 0, 80),
      point(43.6534, -79.3832, 1, 80),
      point(43.6536, -79.3832, 2, 80),
      point(43.6536, -79.3828, 3, 80),
    ];

    const events = detectDrivingEvents(points).events;
    const sharpTurn = events.find((event) => event.type === EVENT_TYPES.SHARP_TURN);

    expect(sharpTurn).toBeTruthy();
    expect(sharpTurn.value).toBeGreaterThan(0.45);
  });

  it('does not log sharp turns from a single noisy heading jump on a straight route', () => {
    const points = [
      { ...point(43.6532, -79.3832, 0, 60), heading: 0 },
      { ...point(43.6534, -79.3832, 1, 60), heading: 0 },
      { ...point(43.6536, -79.3832, 2, 60), heading: 80 },
      { ...point(43.6538, -79.3832, 3, 60), heading: 85 },
    ];

    const events = detectDrivingEvents(points).events;

    expect(events.some((event) => event.type === EVENT_TYPES.SHARP_TURN)).toBe(false);
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

  it('penalizes high-risk phone use in the distraction score', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_risk: 'high',
        phone_use_score: 45,
        phone_use_total_seconds: 300,
        phone_use_pct_of_trip: 50,
      },
      { includeRoadTypeSegments: false }
    );

    expect(scores.phone_use_risk).toBe('high');
    expect(scores.distraction_score).toBeLessThan(60);
  });

  it('keeps distraction score perfect when there are no phone or erratic-speed events', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.distraction_score).toBe(100);
  });

  it('caps persistent phone-use distraction at a 30 point floor', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_risk: 'high',
        phone_use_score: 0,
        phone_use_total_seconds: 600,
        phone_use_pct_of_trip: 100,
      },
      { includeRoadTypeSegments: false }
    );

    expect(scores.distraction_score).toBe(30);
  });

  it('caps safety and overall scores after road-condition bonuses', () => {
    const scores = calculateTripScores([], {
      distance_km: 5,
      fatigue_risk_score: 0,
      intersection_score: 100,
    }, [
      point(43.6532, -79.3832, 0, 60),
      point(43.6542, -79.3832, 10, 60),
    ]);

    expect(scores.score_safety).toBeLessThanOrEqual(100);
    expect(scores.score_overall).toBeLessThanOrEqual(100);
  });

  it('uses exponential near-miss scoring without a flat floor', () => {
    const oneNearMiss = calculateTripScores([
      { type: EVENT_TYPES.NEAR_MISS, severity: 'low' },
    ], { distance_km: 20, fatigue_risk_score: 0 }, []);
    const fourNearMisses = calculateTripScores(Array.from({ length: 4 }, () => ({
      type: EVENT_TYPES.NEAR_MISS,
      severity: 'low',
    })), { distance_km: 20, fatigue_risk_score: 0 }, []);

    expect(oneNearMiss.near_miss_score).toBe(60);
    expect(fourNearMisses.near_miss_score).toBe(13);
  });

  it('classifies road type and calculates advanced smoothness fields', () => {
    const highwayPoints = Array.from({ length: 8 }, (_, index) => ({
      ...point(43.6532 + index * 0.001, -79.3832, index * 5, 90),
      heading: [0, 3, 7, 10, 7, 3, 0, 0][index],
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

  it('scores 50 percent optimal fuel-band time as 70', () => {
    const points = [
      point(43.6532, -79.3832, 0, 70),
      point(43.6542, -79.3832, 10, 70),
      point(43.6552, -79.3832, 20, 30),
    ];

    const fuelBand = calculateFuelBandScore(points);

    expect(fuelBand.optimal_band_ratio).toBe(50);
    expect(fuelBand.fuel_band_score).toBe(70);
  });

  it('scales night penalty by night and deep-night route share', () => {
    const day = point(43.6532, -79.3832, 0, 40);
    const night = { ...day, timestamp: new Date(2026, 0, 1, 23, 0, 0).toISOString() };
    const deepNight = { ...day, timestamp: new Date(2026, 0, 1, 3, 0, 0).toISOString() };

    expect(calculateNightPenalty([day, night])).toBeGreaterThan(0);
    expect(calculateNightPenalty([deepNight, deepNight])).toBeGreaterThan(calculateNightPenalty([day, night]));
    expect(calculateNightPenalty(null)).toBe(0);
  });

  it('applies custom night windows to trip stats and scoring', () => {
    const eveningPoints = [
      { ...point(43.6532, -79.3832, 0, 40), timestamp: new Date(2026, 0, 1, 20, 0, 0).toISOString() },
      { ...point(43.6542, -79.3832, 10, 40), timestamp: new Date(2026, 0, 1, 20, 0, 10).toISOString() },
      { ...point(43.6552, -79.3832, 20, 40), timestamp: new Date(2026, 0, 1, 20, 0, 20).toISOString() },
    ];
    const customNight = {
      ...DEFAULT_THRESHOLDS,
      NIGHT_DETECTION_MODE: 'custom',
      NIGHT_START_TIME: '19:00',
      NIGHT_END_TIME: '05:00',
    };
    const customDay = {
      ...DEFAULT_THRESHOLDS,
      NIGHT_DETECTION_MODE: 'custom',
      NIGHT_START_TIME: '22:00',
      NIGHT_END_TIME: '06:00',
    };

    const nightStats = calculateTripStats(eveningPoints, eveningPoints[0].timestamp, eveningPoints[2].timestamp, customNight);
    const dayStats = calculateTripStats(eveningPoints, eveningPoints[0].timestamp, eveningPoints[2].timestamp, customDay);
    const nightScore = calculateTripScores([], { ...nightStats, fatigue_risk_score: 0 }, eveningPoints, customNight);
    const dayScore = calculateTripScores([], { ...dayStats, fatigue_risk_score: 0 }, eveningPoints, customDay);

    expect(nightStats.night_driving).toBe(true);
    expect(dayStats.night_driving).toBe(false);
    expect(nightScore.score_safety).toBeLessThan(dayScore.score_safety);
  });

  it('uses GPS sunset mode for night detection when coordinates exist', () => {
    const torontoWinterEvening = {
      lat: 43.6532,
      lng: -79.3832,
      timestamp: new Date(Date.UTC(2026, 0, 1, 22, 30, 0)).toISOString(),
    };
    const torontoWinterNoon = {
      ...torontoWinterEvening,
      timestamp: new Date(Date.UTC(2026, 0, 1, 17, 0, 0)).toISOString(),
    };
    const sunsetThresholds = { ...DEFAULT_THRESHOLDS, NIGHT_DETECTION_MODE: 'sunset', NIGHT_START_TIME: '22:00', NIGHT_END_TIME: '06:00' };

    expect(isNightDrivingTime(torontoWinterEvening, sunsetThresholds)).toBe(true);
    expect(isNightDrivingTime(torontoWinterNoon, sunsetThresholds)).toBe(false);
  });

  it('applies configured detection thresholds to event calculations', () => {
    const highwayPoints = Array.from({ length: 6 }, (_, index) => ({
      ...point(43.6532 + index * 0.001, -79.3832, index * 2, 100),
      heading: 0,
    }));

    const strict = detectDrivingEvents(highwayPoints, { ...DEFAULT_THRESHOLDS, SPEEDING_FALLBACK_KMH: 90 }).events;
    const lenient = detectDrivingEvents(highwayPoints, { ...DEFAULT_THRESHOLDS, SPEEDING_FALLBACK_KMH: 130 }).events;

    expect(strict.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(true);
    expect(lenient.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(false);
  });

  it('uses road-context fallback limits when OSM speed limits are missing', () => {
    const urbanFast = Array.from({ length: 6 }, (_, index) => ({
      ...point(43.6532 + index * 0.0002, -79.3832, index * 2, 70),
      heading: 0,
    }));
    const highwayCompliant = Array.from({ length: 6 }, (_, index) => ({
      ...point(43.6532 + index * 0.001, -79.3832, index * 2, 100),
      heading: 0,
    }));
    const osmTaggedUrbanRoad = urbanFast.map((routePoint) => ({
      ...routePoint,
      speed_limit_kmh: 80,
      speed_limit_source: 'openstreetmap',
    }));

    expect(detectDrivingEvents(urbanFast).events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(true);
    expect(detectDrivingEvents(highwayCompliant).events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(false);
    expect(detectDrivingEvents(osmTaggedUrbanRoad).events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(false);
  });

  it('keeps OSM highway-default speed sources separate from posted maxspeed', () => {
    const defaultTaggedUrbanRoad = Array.from({ length: 6 }, (_, index) => ({
      ...point(43.6532 + index * 0.0002, -79.3832, index * 2, 70),
      heading: 0,
      speed_limit_kmh: 60,
      speed_limit_source: 'osm_highway_default',
    }));

    const speeding = detectDrivingEvents(defaultTaggedUrbanRoad).events.find((event) => event.type === EVENT_TYPES.SPEEDING);
    expect(speeding?.speed_limit_source).toBe('osm_highway_default');
  });

  it('ignores low-speed parked jitter for jerk, reaction, and hill scoring', () => {
    const parkedJitter = [0, 4, 0, 5, 0].map((speed, index) => ({
      ...point(43.6532 + index * 0.00001, -79.3832, index * 5, speed, 6),
      altitude: 100 + (index % 2 === 0 ? 0 : 8),
      altitude_accuracy: 8,
    }));

    expect(calculateJerkScore(parkedJitter).jerk_event_count).toBe(0);
    expect(calculateReactionTimeProxy(parkedJitter, [{
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: parkedJitter[2].timestamp,
      speed_kmh: 4,
    }]).reaction_sample_count).toBe(0);
    expect(calculateHillDrivingScore(parkedJitter).hill_driving_score).toBeNull();
  });

  it('detects rapid acceleration and harsh braking in the first valid acceleration window', () => {
    const rapidStart = [
      point(43.6532, -79.3832, 0, 5),
      point(43.6535, -79.3832, 1, 28),
      point(43.6540, -79.3832, 2, 55),
    ];
    const hardStop = [
      point(43.6532, -79.3832, 0, 75),
      point(43.6535, -79.3832, 1, 35),
      point(43.6540, -79.3832, 2, 0),
    ];

    expect(detectDrivingEvents(rapidStart).events.some((event) => event.type === EVENT_TYPES.RAPID_ACCELERATION)).toBe(true);
    expect(detectDrivingEvents(hardStop).events.some((event) => event.type === EVENT_TYPES.HARSH_BRAKE)).toBe(true);
  });

  it('does not emit idle events below the 90 second traffic-stop grace period', () => {
    const points = [
      point(43.6532, -79.3832, 0, 30),
      point(43.6534, -79.3832, 10, 30),
      point(43.6536, -79.3832, 20, 0),
      point(43.6538, -79.3832, 80, 0),
    ];

    expect(detectDrivingEvents(points).events.some((event) => event.type === EVENT_TYPES.IDLE)).toBe(false);
  });

  it('counts terminal parked time in stats and idle events', () => {
    const points = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6534, -79.3832, 20, 35),
      point(43.6536, -79.3832, 40, 0),
    ];
    const endTime = new Date(Date.UTC(2026, 0, 1, 12, 2, 20)).toISOString();

    const stats = calculateTripStats(points, points[0].timestamp, endTime);
    const events = detectDrivingEvents(points, DEFAULT_THRESHOLDS, endTime).events;
    const scores = calculateTripScores(events, stats, points, DEFAULT_THRESHOLDS, stats.duration_seconds, {}, { endTime });

    expect(stats.idle_time_seconds).toBe(120);
    expect(stats.parking_stop_detected).toBe(true);
    expect(stats.parking_stop_duration_seconds).toBe(100);
    expect(scores.parking_stop_duration_seconds).toBe(100);
    expect(events.find((event) => event.type === EVENT_TYPES.IDLE)?.value).toBe(120);
  });

  it('tracks urban lane changes, following-gap cycles, and merge quality proxies', () => {
    const lanePoints = [0, 5, 10, 5, 0].map((heading, index) => ({
      ...point(43.6532 + index * 0.0003, -79.3832, index * 2, 60),
      heading,
    }));
    const followingPoints = [65, 66, 65, 45, 42].map((speed, index) => (
      point(43.6532 + index * 0.00035, -79.3832, index * 2, speed)
    ));
    const mergePoints = [45, 58, 72, 88].map((speed, index) => (
      point(43.6532 + index * 0.00045, -79.3832, index * 5, speed)
    ));

    expect(detectLaneChanges(lanePoints).length).toBeGreaterThan(0);
    expect(detectTailgateCycles(followingPoints).length).toBeGreaterThan(0);
    expect(detectHighwayMergeBehavior(mergePoints).merge_event_count).toBe(1);
  });

  it('detects gentler lane switches without counting sustained road curves', () => {
    const gentleLaneSwitch = [0, 2, 5, 7, 5, 2, 0].map((heading, index) => ({
      ...point(43.6532 + index * 0.00022, -79.3832, index * 2, 50),
      heading,
    }));
    const roadCurve = [0, 4, 8, 12, 16, 20, 24].map((heading, index) => ({
      ...point(43.6532 + index * 0.00022, -79.3832, index * 2, 50),
      heading,
    }));

    expect(detectLaneChanges(gentleLaneSwitch).length).toBeGreaterThan(0);
    expect(detectLaneChanges(roadCurve).length).toBe(0);
  });

  it('does not flag normal steady city speed as erratic speed', () => {
    const steady = Array.from({ length: 10 }, (_, index) => (
      point(43.6532 + index * 0.00022, -79.3832, index * 5, index % 2 === 0 ? 42 : 45)
    ));

    expect(detectErraticSpeedWindows(steady)).toHaveLength(0);
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

  it('splits trips at sustained parked stops and recalculates segment scores', () => {
    const points = [
      point(43.6532, -79.3832, 0, 40),
      point(43.6542, -79.3832, 30, 40),
      point(43.6552, -79.3832, 60, 40),
      point(43.6552, -79.3832, 90, 0),
      point(43.6552, -79.3832, 450, 0),
      point(43.6562, -79.3832, 480, 45),
      point(43.6572, -79.3832, 510, 45),
    ];
    const trip = {
      id: 'original-trip',
      status: 'completed',
      start_time: points[0].timestamp,
      end_time: points[points.length - 1].timestamp,
      route_points: points,
      vehicle_id: 'vehicle-1',
      tag: 'work',
      background_tracking: true,
    };

    const splits = splitTripAtStops(trip, 5);

    expect(splits).toHaveLength(2);
    expect(splits[0].start_time).toBe(points[0].timestamp);
    expect(splits[0].end_time).toBe(points[2].timestamp);
    expect(splits[1].start_time).toBe(points[5].timestamp);
    expect(splits[1].vehicle_id).toBe('vehicle-1');
    expect(splits[1].tag).toBe('work');
    expect(splits[0].score_overall).toBeGreaterThan(0);
    expect(splits[0].split_parent_id).toBe('original-trip');
  });

  it('infers speed zones from 60-second route windows', () => {
    const points = Array.from({ length: 7 }, (_, index) => point(43.6532 + index * 0.0002, -79.3832, index * 10, 45));

    const zones = inferSpeedZones(points);

    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].inferredZone).toBe('zone_50');
    expect(zones[0].inferredZoneKmh).toBe(50);
    expect(zones[0].confidence).toBe('high');
  });

  it('round-trips the last parked location through storage', async () => {
    const saved = await saveLastParkedLocation({
      lat: 43.6532,
      lng: -79.3832,
      timestamp: '2026-01-01T12:00:00.000Z',
      tripId: 'park-test',
      address: 'Toronto City Hall',
    });
    const loaded = await getLastParkedLocation();

    expect(saved.tripId).toBe('park-test');
    expect(loaded.lat).toBe(43.6532);
    expect(loaded.lng).toBe(-79.3832);
    expect(loaded.address).toBe('Toronto City Hall');
  });

  it('keeps auto-start responsive while requiring vehicle-like proof before confirmation', () => {
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const candidatePoints = [
      point(43.6532, -79.3832, 0, 5),
      point(43.6538, -79.3832, 10, 18),
      point(43.6546, -79.3832, 20, 24),
      point(43.6554, -79.3832, 30, 26),
    ];

    const decision = validateCandidateTrip({
      points: candidatePoints,
      startTime: start,
      now: candidatePoints.at(-1).timestamp,
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 82 },
    });

    expect(decision.state).toBe(TRIP_STATES.CONFIRMED);
    expect(decision.confirmed).toBe(true);
    expect(decision.reason).toBe('activity_in_vehicle');
  });

  it('discards hidden candidates that look like walking near a parked location', () => {
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const walkingPoints = [
      point(43.6532, -79.3832, 0, 5),
      point(43.65325, -79.3832, 10, 6),
      point(43.6533, -79.3832, 20, 6),
      point(43.65335, -79.3832, 190, 6),
    ];

    const decision = validateCandidateTrip({
      points: walkingPoints,
      startTime: start,
      now: walkingPoints.at(-1).timestamp,
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 95 },
      nearParkedLocation: true,
      forceFinal: true,
    });

    expect(decision.state).toBe(TRIP_STATES.DISCARDED);
    expect(decision.reason).toBe('movement_looked_like_walking');
  });

  it('does not confirm slow movement near parking even after enough distance', () => {
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const slowPoints = [
      point(43.6532, -79.3832, 0, 10),
      point(43.6540, -79.3832, 40, 10),
      point(43.6550, -79.3832, 90, 10),
      point(43.6560, -79.3832, 190, 10),
    ];

    const decision = validateCandidateTrip({
      points: slowPoints,
      startTime: start,
      now: slowPoints.at(-1).timestamp,
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 95 },
      nearParkedLocation: true,
      forceFinal: true,
    });

    expect(decision.state).toBe(TRIP_STATES.DISCARDED);
    expect(decision.reason).toBe('movement_looked_like_walking');
    expect(decision.confirmed).toBe(false);
  });

  it('requires the 10 km/h vehicle-speed segment near parking even if movement passes 250 meters', () => {
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const slowPoints = [
      point(43.6532, -79.3832, 0, 9),
      point(43.6540, -79.3832, 40, 9),
      point(43.6550, -79.3832, 90, 9),
      point(43.6560, -79.3832, 190, 9),
    ];

    const decision = validateCandidateTrip({
      points: slowPoints,
      startTime: start,
      now: slowPoints.at(-1).timestamp,
      activity: null,
      nearParkedLocation: true,
      forceFinal: true,
    });

    expect(decision.state).toBe(TRIP_STATES.DISCARDED);
    expect(decision.reason).toBe('no_vehicle_speed_segment');
    expect(decision.confirmed).toBe(false);
  });

  it('allows 10 km/h vehicle-speed proof near parking when walking is not detected', () => {
    const start = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
    const slowDrivePoints = [
      point(43.6532, -79.3832, 0, 10),
      point(43.6540, -79.3832, 40, 10),
      point(43.6550, -79.3832, 90, 10),
      point(43.6560, -79.3832, 190, 10),
      point(43.6570, -79.3832, 220, 10),
    ];

    const decision = validateCandidateTrip({
      points: slowDrivePoints,
      startTime: start,
      now: slowDrivePoints.at(-1).timestamp,
      activity: null,
      nearParkedLocation: true,
    });

    expect(decision.state).toBe(TRIP_STATES.CONFIRMED);
    expect(decision.metrics.required_speed_kmh).toBe(10);
    expect(decision.confirmed).toBe(true);
  });

  it('detects recent parked cooldown and trims walking after parking from saved routes', () => {
    const parked = {
      lat: 43.6532,
      lng: -79.3832,
      timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
    };
    expect(isNearRecentParkedLocation(
      point(43.65325, -79.3832, 120, 5),
      parked,
      { nowMs: Date.UTC(2026, 0, 1, 12, 2, 0) }
    )).toBe(true);

    const route = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6542, -79.3832, 20, 35),
      point(43.6552, -79.3832, 40, 0),
      point(43.65532, -79.3832, 60, 4),
      point(43.65544, -79.3832, 80, 4),
    ];
    const trimmed = trimParkedTail(route, {
      endTime: route.at(-1).timestamp,
      reason: 'auto_stop_parked_review',
    });

    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.removedPoints).toBe(2);
    expect(trimmed.points.at(-1).timestamp).toBe(route[2].timestamp);
  });
});

describe('auto tracking decision logic', () => {
  it('starts only when activity and speed strongly suggest driving', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 82 },
      currentSpeedKmh: 5,
      recentMovingSeconds: 2,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 90 },
      currentSpeedKmh: 0,
      recentMovingSeconds: 60,
    })).toBe(false);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 90 },
      currentSpeedKmh: 2,
      recentMovingSeconds: 20,
    })).toBe(false);

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
      stillSeconds: 90,
      gpsPositionDriftM: 3,
    })).toBe(true);
    // FIX: Stable STILL auto-stop tests now use the native-aligned 90-second threshold.

    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 70 },
      currentSpeedKmh: 0,
      stillSeconds: 240,
      gpsPositionDriftM: 6,
    })).toBe(false);

    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 20,
      gpsPositionDriftM: 3,
    })).toBe(true);
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

    expect(suggestTripTag(commute).auto_tag).toBe('commute');
    expect(estimateTripEconomics(commute, { fuel_efficiency_l_per_100km: 10 }).fuel_saved_liters).toBeGreaterThan(0);
    expect(computePersonalBaseline(trips).baseline_avg).not.toBeNull();
    expect(calculateVehicleHealthImpact([commute], {}).extra_wear_km).toBe(32);
  });
});
