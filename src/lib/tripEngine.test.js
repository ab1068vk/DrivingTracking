import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeIntersectionBehavior,
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
  calculateLaneChangingScore,
  buildDrivingThresholds,
  calculateTireWearUnits,
  calculateBrakeOnsetSmoothness,
  scoreBrakeOnsetSmoothness,
  calculateSpeedLimitCompliance,
  cleanRoutePoints,
  computeSmoothedAccelerations,
  detectDrivingEvents,
  detectSpeedCreepWithThresholds,
  detectHighwayMergeBehavior,
  inferSpeedZones,
  getInferredLimitForPoint,
  resolveEffectiveSpeedLimitForIndex,
  detectHeadingDeviationEvents,
  detectLaneChanges,
  detectErraticSpeedWindows,
  detectStopStartPatterns,
  detectCloseProximityManeuverAlerts,
  CONFIDENCE_LEVELS,
  DEFAULT_THRESHOLDS,
  ECO_DEFAULTS,
  SVI_DEFAULTS,
  TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH,
  TIRE_WEAR_DEFAULT_SPEED_TURN_KMH,
  EVENT_TYPES,
  componentConfidence,
  buildScoreConstantsSnapshot,
  getTripComponentScore,
  getScoreProvenanceStatus,
  getScoreColor,
  SCORING_VERSION,
  TRIP_STATES,
  haversineDistance,
  isNearRecentParkedLocation,
  isNightDrivingTime,
  shouldAcceptLocationPoint,
  simplifyRoute,
  splitTripAtStops,
  trimParkedTail,
  validateCandidateTrip,
  tripsToCSV,
} from '@/lib/tripEngine';
import { FATIGUE_SAFETY_MAX_PENALTY, FATIGUE_SAFETY_PENALTY_SCALE, PENALTY_SCALE_FACTOR } from '@/lib/appConstants';
import { LANE_CHANGING_SAFETY_WEIGHT, scoringValue } from '@/lib/scoringConstants';
import {
  getLastParkedLocation,
  localSettings,
  DEFAULT_SETTINGS,
  PARKED_LOCATION_PRIVACY_GUARD_M,
  saveLastParkedLocation,
  sanitizeImportedSettings,
} from '@/lib/trackingStore';
import {
  shouldAutoStartTracking,
  shouldAutoStopTracking,
  ACTIVITY_TYPES,
} from '@/lib/activityRecognition';
import { maskRoutePointsForPrivacy } from '@/lib/privacyZones';
import {
  buildScoreTips,
  buildSpeedSegments,
  buildDrivingCoachInsights,
  calculateAchievementBadges,
  calculateFatigueRisk,
  calculateDrivingConsistency,
  calculateNoHarshBrakeStreak,
  calculateRiskEventRate,
  calculatePeakHourStress,
  calculateSpeedDiscipline,
  calculateWeeklyDrivingGoals,
  calculateVehicleHealthImpact,
  computePersonalBaseline,
  detectTripStops,
  estimateTripEconomics,
  PERSONAL_BASELINE_INTERVAL_METHOD,
  PERSONAL_BASELINE_INTERVAL_NOTE,
  suggestTripTag,
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  getMaintenanceStatus,
  getVehicleOdometerKm,
} from '@/lib/tripInsights';

afterEach(() => {
  vi.unstubAllGlobals();
});

const point = (lat, lng, seconds, speedKmh = 40, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh: speedKmh,
  accuracy,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

const pointNorthOf = ({ lat, lng }, meters) => ({
  lat: Number(lat) + (meters / 6371000) * (180 / Math.PI),
  lng: Number(lng),
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

  it('excludes long background tracking gaps from effective driving duration', () => {
    const points = [
      point(43.6532, -79.3832, 0, 40),
      point(43.6542, -79.3832, 10, 40),
      point(43.6552, -79.3832, 610, 40),
      point(43.6562, -79.3832, 620, 40),
    ];
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    expect(stats.wall_clock_duration_seconds).toBe(620);
    expect(stats.gap_seconds).toBe(600);
    expect(stats.duration_seconds).toBe(20);
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
    expect(summary.scores.score_overall).toBeNull();
    expect(summary.scores.score_confidence_label).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
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

  it('flags score confidence when a long route gap overlaps native location permission loss', () => {
    const points = [
      point(43.6532, -79.3832, 0, 50),
      point(43.6538, -79.3832, 30, 50),
      point(43.6570, -79.3832, 210, 50),
      point(43.6576, -79.3832, 240, 50),
    ];
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp, DEFAULT_THRESHOLDS, {
      native_tracking_timeline: [{
        type: 'location_permission_lost',
        timestamp: new Date(Date.UTC(2026, 0, 1, 12, 1, 30)).toISOString(),
      }],
    });

    expect(stats.gap_seconds).toBe(180);
    expect(stats.score_confidence_flag).toBe('data_gap_detected');
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

  it('uses named eco fallbacks for missing or malformed threshold objects', () => {
    const points = Array.from({ length: 100 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, index < 50 ? 80 : 40, 6)
    ));

    expect(ECO_DEFAULTS).toMatchObject({
      CRUISE_SCORE_MULTIPLIER: 130,
      IDLE_PENALTY_MULTIPLIER: 150,
      IDLE_MAX_PENALTY: 25,
    });
    expect(calculateEcoDrivingScore(points, {}, {}).cruise_score).toBe(65);
    expect(calculateEcoDrivingScore(points, {}, null).cruise_score).toBe(65);
    expect(calculateEcoDrivingScore(points, {}, {
      ECO_CRUISE_SCORE_MULTIPLIER: null,
      ECO_IDLE_PENALTY_MULTIPLIER: '',
      ECO_IDLE_MAX_PENALTY: null,
    }).cruise_score).toBe(65);
  });

  it('keeps eco scoring available with default settings thresholds', () => {
    const points = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.0002, -79.3832, index * 10, index < 9 ? 80 : 45, 6)
    ));
    const thresholds = buildDrivingThresholds(DEFAULT_SETTINGS);
    const result = calculateEcoDrivingScore(points, { duration_seconds: 120 }, thresholds);

    expect(result.eco_score_confidence).toBe('observed');
    expect(result.eco_driving_score).not.toBeNull();
    expect(Number.isFinite(result.eco_driving_score)).toBe(true);
  });

  it('repairs imported eco settings when both scoring multipliers are missing or zero', () => {
    const repairedZeroes = sanitizeImportedSettings({
      eco_cruise_score_multiplier: 0,
      eco_idle_penalty_multiplier: 0,
    });
    const repairedMissing = sanitizeImportedSettings({
      tracking_mode: 'manual',
    });

    expect(repairedZeroes.eco_cruise_score_multiplier).toBe(ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER);
    expect(repairedZeroes.eco_idle_penalty_multiplier).toBe(ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER);
    expect(repairedMissing.eco_cruise_score_multiplier).toBe(ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER);
    expect(repairedMissing.eco_idle_penalty_multiplier).toBe(ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER);
  });

  it('marks eco evidence unavailable when both effective multipliers are zero', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const points = Array.from({ length: 8 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 80, 6)
    ));
    const invalidThresholds = {
      ...DEFAULT_THRESHOLDS,
      ECO_CRUISE_SCORE_MULTIPLIER: 0,
      ECO_IDLE_PENALTY_MULTIPLIER: 0,
    };

    const result = calculateEcoDrivingScore(points, {}, invalidThresholds);
    const scores = calculateTripScores([], { distance_km: 2, duration_seconds: 40 }, points, invalidThresholds, 40, {}, { includeRoadTypeSegments: false });

    expect(result).toMatchObject({
      eco_driving_score: null,
      eco_score_confidence: 'invalid_thresholds',
      cruise_score: null,
      idle_penalty_points: null,
    });
    expect(scores.eco_driving_score).toBeNull();
    expect(Number.isFinite(scores.score_eco)).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('multipliers cannot both be zero'));
    errorSpy.mockRestore();
  });

  it('marks eco evidence unavailable without enough moving speed samples', () => {
    expect(calculateEcoDrivingScore([])).toMatchObject({
      eco_driving_score: null,
      eco_score_confidence: 'insufficient_data',
      speed_stability: null,
      cruise_score: null,
    });
  });

  it('clamps avoidable idle ratio before applying its penalty multiplier', () => {
    const points = Array.from({ length: 8 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 80, 6)
    ));

    const result = calculateEcoDrivingScore(points, {
      duration_seconds: 100,
      sustained_idle_seconds: 200,
    }, {
      ...DEFAULT_THRESHOLDS,
      ECO_IDLE_PENALTY_MULTIPLIER: 10,
      ECO_IDLE_MAX_PENALTY: 100,
    });

    expect(result.idle_penalty_points).toBe(10);
  });

  it('can lower the eco moving-speed floor for stop-and-go city scoring', () => {
    const points = Array.from({ length: 6 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 10, 6)
    ));

    expect(calculateEcoDrivingScore(points).eco_driving_score).toBeNull();
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

  it('uses named provisional hill acceleration and per-km infraction penalty thresholds', () => {
    const routeWithOneHillInfraction = (spacingDegrees) => Array.from({ length: 30 }, (_, index) => ({
      ...point(43.6532 + index * spacingDegrees, -79.3832, index * 2, index < 2 ? 20 : 45, 6),
      altitude: 100 + index * spacingDegrees * 12000,
      altitude_accuracy: 8,
    }));
    const uphill = routeWithOneHillInfraction(0.0001);
    const longerUphill = routeWithOneHillInfraction(0.001);

    expect(DEFAULT_THRESHOLDS.HILL_ACCEL_THRESHOLD_MS2).toBe(2.5);
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS).toBe(10);
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS_PER_KM).toBe(8);

    const result = calculateHillDrivingScore(uphill);
    const longerResult = calculateHillDrivingScore(longerUphill);
    const expectedRate = result.hill_infraction_count / Math.max(1, result.climb_distance_km + result.descent_distance_km);
    const expectedScore = Math.max(
      0,
      Math.round(100 - expectedRate * DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS_PER_KM)
    );

    expect(result.hill_route).toBe(true);
    expect(result.hill_infraction_count).toBeGreaterThan(0);
    expect(result.hill_infraction_rate_per_km).toBeCloseTo(expectedRate, 2);
    expect(result.hill_driving_score).toBe(expectedScore);
    expect(longerResult.hill_infraction_count).toBe(result.hill_infraction_count);
    expect(longerResult.climb_distance_km).toBeGreaterThan(result.climb_distance_km);
    expect(longerResult.hill_driving_score).toBeGreaterThan(result.hill_driving_score);
  });

  it('flags tire-wear events whose speed factor cannot be measured', () => {
    expect({
      harshBrake: TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH,
      sharpTurn: TIRE_WEAR_DEFAULT_SPEED_TURN_KMH,
    }).toEqual({ harshBrake: 50, sharpTurn: 40 });
    expect(calculateTireWearUnits([
      { type: EVENT_TYPES.HARSH_BRAKE, severity: 'low', speed_kmh: TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH },
      { type: EVENT_TYPES.SHARP_TURN, severity: 'low', speed_kmh: TIRE_WEAR_DEFAULT_SPEED_TURN_KMH },
    ]).trip_tire_wear_units).toBe(2);

    expect(calculateTireWearUnits([
      { type: EVENT_TYPES.HARSH_BRAKE, severity: 'medium' },
      { type: EVENT_TYPES.SHARP_TURN, severity: 'low', speed_kmh: 40 },
    ])).toEqual({
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    });
  });

  it('does not let one speed spike distort compliance or speed creep', () => {
    const points = [90, 91, 92, 170].map((speed, index) => (
      point(43.6532 + index * 0.0025, -79.3832, index * 10, speed, 6)
    ));
    const stats = {
      speed_zones: [{ startIndex: 0, endIndex: points.length - 1, inferredZoneKmh: 100 }],
    };

    expect(calculateSpeedLimitCompliance(points, stats, DEFAULT_THRESHOLDS).overall_compliance_score).toBe(100);
    expect(detectSpeedCreepWithThresholds(points, DEFAULT_THRESHOLDS).speed_creep_event_count).toBe(0);
  });

  it('normalizes speed-creep diagnostics by trip distance', () => {
    const speeds = [
      82, 85, 88, 90, 82, 82, 82,
      82, 85, 88, 90, 82, 82, 82,
      82, 85, 88, 90,
    ];
    const route = (distanceKm) => speeds.map((speed, index) => (
      point(43.6532 + (distanceKm / 111) * (index / (speeds.length - 1)), -79.3832, index * 10, speed, 6)
    ));

    const shortTrip = detectSpeedCreepWithThresholds(route(5), DEFAULT_THRESHOLDS);
    const longTrip = detectSpeedCreepWithThresholds(route(100), DEFAULT_THRESHOLDS);

    expect(shortTrip.speed_creep_event_count).toBe(3);
    expect(longTrip.speed_creep_event_count).toBe(3);
    expect(shortTrip.speed_creep_rate_per_10km).toBeGreaterThan(longTrip.speed_creep_rate_per_10km);
    expect(shortTrip.speed_creep_score).toBeLessThan(longTrip.speed_creep_score);
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

  it('applies the named penalty scale and its current score-floor threshold', () => {
    expect(PENALTY_SCALE_FACTOR).toBe(40);

    const partialDeduction = calculateTripScores(
      [{ type: EVENT_TYPES.RAPID_ACCELERATION, severity: 'low' }],
      { distance_km: 4, fatigue_risk_score: 0 },
      []
    );
    const scoreFloor = calculateTripScores(
      [{ type: EVENT_TYPES.RAPID_ACCELERATION, severity: 'medium' }],
      { distance_km: 2, fatigue_risk_score: 0 },
      []
    );

    expect(partialDeduction.score_smoothness).toBeNull();
    expect(partialDeduction.component_scores.smoothness.value).toBeNull();
    expect(scoreFloor.score_smoothness).toBeNull();
  });

  it('applies the named provisional fatigue-to-safety penalty scale as a flat deduction', () => {
    expect(FATIGUE_SAFETY_PENALTY_SCALE).toBe(0.15);
    expect(FATIGUE_SAFETY_MAX_PENALTY).toBe(15);

    const routeForDistance = (distanceKm) => [
      point(43.6532, -79.3832, 0, 80),
      point(43.6532 + distanceKm / 111, -79.3832, 30, 80),
    ];
    const thresholds = { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false };
    const scoreAt = (distanceKm, fatigueRiskScore) => calculateTripScores(
      [],
      { distance_km: distanceKm, duration_seconds: 300, fatigue_risk_score: fatigueRiskScore },
      routeForDistance(distanceKm),
      thresholds,
      300,
      {},
      { includeRoadTypeSegments: false }
    ).score_safety;

    const shortDeduction = scoreAt(1, 0) - scoreAt(1, 100);
    const longDeduction = scoreAt(200, 0) - scoreAt(200, 100);

    expect(shortDeduction).toBeGreaterThanOrEqual(FATIGUE_SAFETY_MAX_PENALTY - 2);
    expect(shortDeduction).toBeLessThanOrEqual(FATIGUE_SAFETY_MAX_PENALTY);
    expect(longDeduction).toBeGreaterThanOrEqual(shortDeduction);
  });

  it('scores stop-start patterns only after enough highway GPS evidence', () => {
    const patternEvents = (count, speedKmh, severity) => Array.from({ length: count }, () => ({
      type: EVENT_TYPES.STOP_START_PATTERN,
      severity,
      speed_kmh: speedKmh,
    }));
    const stats = (distanceKm) => ({ distance_km: distanceKm, fatigue_risk_score: 0, intersection_score: 100 });
    const highwayRoute = Array.from({ length: 70 }, (_, index) => point(43.6532 + index * 0.001, -79.3832, index * 5, 100));

    const noEvents = calculateTripScores([], stats(8), highwayRoute);
    const highway = calculateTripScores(patternEvents(3, 120, 'high'), stats(8), highwayRoute);
    const noHighwayEvidence = calculateTripScores(patternEvents(3, 50, 'medium'), stats(8), []);

    expect(noEvents.stop_start_pattern_score).toBe(100);
    expect(highway.stop_start_pattern_score).toBeLessThan(100);
    expect(highway.stop_start_pattern_score_confidence).not.toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
    expect(noHighwayEvidence.stop_start_pattern_score).toBeNull();
  });

  it('detects and scores stop-start patterns on city-speed trips after urban evidence', () => {
    const urbanRoute = Array.from({ length: 24 }, (_, index) => {
      const pattern = [35, 35, 35, 24, 18, 32];
      return point(43.6532 + index * 0.0009, -79.3832, index * 2, pattern[index % pattern.length]);
    });
    const urbanEvents = detectStopStartPatterns(urbanRoute, DEFAULT_THRESHOLDS);
    const stats = calculateTripStats(urbanRoute, urbanRoute[0].timestamp, urbanRoute.at(-1).timestamp);
    const scores = calculateTripScores(urbanEvents, stats, urbanRoute, DEFAULT_THRESHOLDS, stats.duration_seconds);

    expect(stats.distance_km).toBeGreaterThanOrEqual(2);
    expect(urbanEvents.some((event) => event.stop_start_context === 'urban')).toBe(true);
    expect(scores.stop_start_pattern_urban_count).toBeGreaterThan(0);
    expect(scores.stop_start_pattern_highway_count).toBe(0);
    expect(scores.stop_start_pattern_urban_distance_km).toBeGreaterThanOrEqual(2);
    expect(scores.stop_start_pattern_score).not.toBeNull();
    expect(scores.stop_start_pattern_score_confidence).not.toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
  });

  it('does not score stop-start patterns without highway evidence or from masked events', () => {
    const event = {
      type: EVENT_TYPES.STOP_START_PATTERN,
      severity: 'high',
      speed_kmh: 120,
    };
    const highwayRoute = Array.from({ length: 70 }, (_, index) => point(43.6532 + index * 0.001, -79.3832, index * 5, 100));
    const shortTrip = calculateTripScores([event], { distance_km: 0.3, fatigue_risk_score: 0 }, []);
    const masked = calculateTripScores(
      [{ ...event, masked_for_privacy: true }],
      { distance_km: 8, fatigue_risk_score: 0 },
      highwayRoute
    );

    expect(shortTrip.stop_start_pattern_score).toBeNull();
    expect(shortTrip.stop_start_pattern_score_confidence).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
    expect(shortTrip.score_safety).toBeNull();
    expect(masked.stop_start_pattern_score).toBe(100);
    expect(masked.stop_start_pattern_count).toBe(0);
  });

  it('keeps short-trip stop-start patterns out of Safety scoring', () => {
    const event = {
      type: EVENT_TYPES.STOP_START_PATTERN,
      severity: 'high',
      speed_kmh: 120,
    };
    const shortHighwayRoute = Array.from({ length: 40 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 5, 100)
    ));
    const stats = calculateTripStats(
      shortHighwayRoute,
      shortHighwayRoute[0].timestamp,
      shortHighwayRoute.at(-1).timestamp
    );
    const baseline = calculateTripScores([], stats, shortHighwayRoute);
    const withStopStart = calculateTripScores([event], stats, shortHighwayRoute);

    expect(stats.distance_km).toBeLessThan(5);
    expect(baseline.score_safety).not.toBeNull();
    expect(withStopStart.stop_start_pattern_score).toBeNull();
    expect(withStopStart.stop_start_pattern_score_confidence).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
    expect(withStopStart.score_safety).toBe(baseline.score_safety);
    expect(withStopStart.component_scores.safety.value).toBe(baseline.component_scores.safety.value);
  });

  it('penalizes high-risk phone use in the distraction score', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_score_available: true,
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

  it('leaves distraction score unavailable when there are no phone or erratic-speed events', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.distraction_score).toBeNull();
    expect(scores.distraction_score_confidence).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
  });

  it('returns confidence metadata for exported component scores', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: null },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores).toMatchObject({
      score_confidence: 0,
      score_confidence_label: CONFIDENCE_LEVELS.UNAVAILABLE,
      score_safety_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      score_smoothness_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      score_eco_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      distraction_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      close_proximity_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      fuel_band_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      smooth_braking_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      engine_stress_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      speed_creep_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      phone_use_score_confidence: 'usage_access_required',
      hill_driving_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      brake_onset_smoothness_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      heading_deviation_available: true,
      heading_drift_beta_available: true,
      cornering_consistency_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      braking_efficiency_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      defensive_driving_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
    });
  });

  it('classifies component evidence from its own distance and sample requirements', () => {
    expect(componentConfidence(0.4, 0.5, 10, 2)).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
    expect(componentConfidence(0.75, 0.5, 2, 2)).toBe(CONFIDENCE_LEVELS.LOW);
    expect(componentConfidence(1.5, 0.5, 2, 2)).toBe(CONFIDENCE_LEVELS.DEVELOPING);
    expect(componentConfidence(2.5, 0.5, 2, 2)).toBe(CONFIDENCE_LEVELS.HIGH);
    expect(componentConfidence(10, 0.5, 1, 2)).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
  });

  it('returns typed component evidence and reads legacy flat scores through the adapter', () => {
    const points = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 10, 45, 6)
    ));
    const scores = calculateTripScores(
      [],
      { distance_km: 10, fatigue_risk_score: 0, intersection_score: 90, traffic_stop_count: 2 },
      points,
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_score_available: true,
        phone_use_score: 100,
        phone_use_risk: 'none',
        phone_use_window_count: 0,
        data_sources: ['android_usage_access'],
      },
      { includeRoadTypeSegments: false }
    );

    expect(scores.component_scores.safety).toMatchObject({
      value: scores.score_safety,
      evidence: scores.score_safety_confidence,
      dataSource: expect.arrayContaining(['gps', 'android_usage_access']),
    });
    expect(scores.component_scores.phone_use).toMatchObject({
      value: 100,
      dataSource: ['android_usage_access'],
      sampleCount: 0,
    });
    expect(scores.component_scores.intersection).toMatchObject({
      value: 90,
      sampleCount: 2,
    });
    expect(scores.score_provenance).toMatchObject({
      scoring_version: SCORING_VERSION,
      calibration_status: 'approximate',
      provisional_constants: expect.arrayContaining(['PENALTY_SCALE_FACTOR']),
      components: {
        safety: scores.component_scores.safety.evidence,
        overall: scores.component_scores.overall.evidence,
      },
      constants_snapshot: {
        PENALTY_SCALE_FACTOR: 40,
        HILL_ACCEL_THRESHOLD_MS2: DEFAULT_THRESHOLDS.HILL_ACCEL_THRESHOLD_MS2,
      },
    });
    expect(new Date(scores.score_provenance.computed_at).toISOString()).toBe(scores.score_provenance.computed_at);
    expect(getTripComponentScore({
      score_eco: 72,
      score_eco_confidence: 'low',
    }, 'eco')).toMatchObject({
      value: 72,
      evidence: 'low',
      dataSource: [],
    });
    expect(getTripComponentScore({
      component_scores: { eco: { value: 72, evidence: 'high', dataSource: 'invalid' } },
    }, 'eco').dataSource).toEqual([]);
    expect(getTripComponentScore({
      component_scores: { eco: { value: 72, evidence: 'unavailable', dataSource: ['gps'] } },
    }, 'eco').value).toBeNull();
    expect(getTripComponentScore({ score_eco: 72 }, 'eco')).toMatchObject({
      value: 72,
      evidence: 'low',
    });
  });

  it('detects missing or changed score provenance without comparing score values', () => {
    expect(getScoreProvenanceStatus({}).status).toBe('missing');

    const currentTrip = {
      score_provenance: {
        scoring_version: SCORING_VERSION,
        constants_snapshot: buildScoreConstantsSnapshot(DEFAULT_THRESHOLDS),
      },
    };
    expect(getScoreProvenanceStatus(currentTrip)).toMatchObject({
      status: 'current',
      needsRescore: false,
    });
    expect(getScoreProvenanceStatus(JSON.parse(JSON.stringify(currentTrip)))).toMatchObject({
      status: 'current',
      needsRescore: false,
    });

    const staleTrip = {
      score_provenance: {
        ...currentTrip.score_provenance,
        constants_snapshot: {
          ...currentTrip.score_provenance.constants_snapshot,
          PENALTY_SCALE_FACTOR: 41,
        },
      },
    };
    expect(getScoreProvenanceStatus(staleTrip)).toMatchObject({
      status: 'outdated',
      needsRescore: true,
      changedConstants: ['PENALTY_SCALE_FACTOR'],
    });
  });

  it('does not report high Safety confidence without phone-use evidence', () => {
    const points = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 10, 45, 6)
    ));
    const scores = calculateTripScores(
      [],
      { distance_km: 10, fatigue_risk_score: 0, intersection_score: null },
      points,
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.phone_use_score).toBeNull();
    expect(scores.score_safety_confidence).not.toBe(CONFIDENCE_LEVELS.HIGH);
    expect(scores.score_confidence_label).not.toBe(CONFIDENCE_LEVELS.HIGH);
  });

  it('does not report high Overall confidence when intersection evidence is unavailable', () => {
    const points = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 10, 45, 6)
    ));
    const scores = calculateTripScores(
      [],
      { distance_km: 10, fatigue_risk_score: 0, intersection_score: null },
      points,
      DEFAULT_THRESHOLDS,
      600,
      { phone_use_score_available: true, phone_use_score: 100, phone_use_risk: 'none' },
      { includeRoadTypeSegments: false }
    );

    expect(scores.intersection_score).toBeNull();
    expect(scores.score_confidence_label).not.toBe(CONFIDENCE_LEVELS.HIGH);
  });

  it('marks advanced GPS beta surfaces unavailable when advanced detection is disabled', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      { ...DEFAULT_THRESHOLDS, ADVANCED_SAFETY_DETECTION_ENABLED: false },
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.heading_deviation_available).toBe(false);
    expect(scores.heading_drift_beta_available).toBe(false);
  });

  it('caps persistent confirmed phone-use distraction at a 30 point floor', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_score_available: true,
        phone_use_risk: 'high',
        phone_use_score: 0,
        phone_use_total_seconds: 600,
        phone_use_pct_of_trip: 100,
      },
      { includeRoadTypeSegments: false }
    );

    expect(scores.distraction_score).toBe(30);
    expect(scores.score_explanation.safety[0]).toMatchObject({
      factor: 'phone_use',
      label: 'Phone use detected while driving',
      impact: -100,
    });
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

  it('uses exponential close-proximity scoring without a flat floor', () => {
    const oneAlert = calculateTripScores([
      { type: EVENT_TYPES.CLOSE_PROXIMITY, severity: 'low' },
    ], { distance_km: 20, fatigue_risk_score: 0 }, []);
    const fourAlerts = calculateTripScores(Array.from({ length: 4 }, () => ({
      type: EVENT_TYPES.CLOSE_PROXIMITY,
      severity: 'low',
    })), { distance_km: 20, fatigue_risk_score: 0 }, []);

    expect(oneAlert.close_proximity_score).toBe(60);
    expect(fourAlerts.close_proximity_score).toBe(13);
  });

  it('keeps estimated and legacy brake-turn alert proxies out of Safety scoring', () => {
    const tripStats = { distance_km: 8, fatigue_risk_score: 0, intersection_score: 100 };
    const base = calculateTripScores([], tripStats, []);
    const estimatedAlert = calculateTripScores([
      { type: EVENT_TYPES.CLOSE_PROXIMITY, severity: 'high' },
    ], tripStats, []);
    const legacyAlert = calculateTripScores([
      { type: EVENT_TYPES.NEAR_MISS, severity: 'high' },
    ], tripStats, []);

    expect(estimatedAlert.close_proximity_count).toBe(1);
    expect(estimatedAlert.close_proximity_score).toBeLessThan(100);
    expect(estimatedAlert.score_safety).toBe(base.score_safety);
    expect(estimatedAlert.score_overall).toBe(base.score_overall);
    expect(legacyAlert.score_safety).toBe(base.score_safety);
    expect(legacyAlert.score_overall).toBe(base.score_overall);
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
    expect(detectHeadingDeviationEvents(highwayPoints).length).toBeGreaterThan(0);
  });

  it('does not report a jerk score without enough usable distance or movement', () => {
    const shortRoughTrip = Array.from({ length: 8 }, (_, index) => (
      point(43.6532 + index * 0.0003, -79.3832, index, index % 2 === 0 ? 35 : 100)
    ));
    const parkedTrip = Array.from({ length: 5 }, (_, index) => (
      point(43.6532, -79.3832, index * 5, 0)
    ));

    expect(calculateJerkScore([], 0)).toMatchObject({
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
      jerk_event_count: 0,
    });
    expect(calculateJerkScore(shortRoughTrip, 0.3)).toMatchObject({
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
    });
    expect(calculateJerkScore(parkedTrip)).toMatchObject({
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
      jerk_event_count: 0,
    });
  });

  it('removes the jerk-score floor for well-observed long trips', () => {
    const steadyTrip = Array.from({ length: 8 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 2, 60)
    ));
    const roughLongTrip = Array.from({ length: 402 }, (_, index) => (
      point(43.6532 + index * 0.0003, -79.3832, index, index % 2 === 0 ? 35 : 100)
    ));

    expect(calculateJerkScore(steadyTrip, 10)).toMatchObject({
      jerk_score: 100,
      jerk_score_confidence: 'high',
    });
    expect(calculateJerkScore(roughLongTrip, 2)).toMatchObject({
      jerk_score: 0,
      jerk_score_confidence: 'low',
    });
    expect(calculateJerkScore(roughLongTrip, 50)).toMatchObject({
      jerk_score: 0,
      jerk_score_confidence: 'high',
    });
  });

  it('keeps insufficient jerk data neutral in the smoothness composite', () => {
    const scores = calculateTripScores([], {
      distance_km: 0.3,
      fatigue_risk_score: 0,
      intersection_score: 100,
    }, []);

    expect(scores.jerk_score).toBeNull();
    expect(scores.jerk_score_confidence).toBe(CONFIDENCE_LEVELS.UNAVAILABLE);
    expect(scores.score_smoothness).toBeNull();
  });

  it('detects sampled traffic stops and scores repeated rolling approaches without a floor', () => {
    const trafficStopRoute = (minimumSpeeds = [], includeLateStops = 0) => {
      const route = [];
      let index = 0;
      let seconds = 0;
      const add = (speed, elapsed = 5) => {
        if (route.length) seconds += elapsed;
        route.push(point(43.6532 + index * 0.001, -79.3832, seconds, speed));
        index += 1;
      };

      add(35, 0);
      minimumSpeeds.forEach((minimumSpeed) => {
        add(18);
        add(minimumSpeed);
        add(minimumSpeed);
        add(minimumSpeed);
        add(35);
      });
      for (let i = 0; i < includeLateStops; i++) {
        add(45);
        add(0, 1);
        add(0);
        add(35);
      }
      return route;
    };

    const fiveTrafficStops = analyzeIntersectionBehavior(trafficStopRoute([8, 8, 8, 8, 8]));
    expect(fiveTrafficStops.traffic_stop_count).toBe(5);
    expect(fiveTrafficStops.rolling_stop_count).toBe(5);
    expect(fiveTrafficStops.intersection_score).toBeGreaterThanOrEqual(50);
    expect(fiveTrafficStops.intersection_score).toBeLessThanOrEqual(85);

    const fiveRedLightStops = analyzeIntersectionBehavior(trafficStopRoute([0, 0, 0, 0], 1));
    expect(fiveRedLightStops.traffic_stop_count).toBe(5);
    expect(fiveRedLightStops.rolling_stop_count).toBe(0);
    expect(fiveRedLightStops.intersection_score).toBeGreaterThanOrEqual(50);
    expect(fiveRedLightStops.intersection_score).toBeLessThanOrEqual(85);

    const threeRollingStops = analyzeIntersectionBehavior(trafficStopRoute([8, 8, 8]));
    expect(threeRollingStops).toMatchObject({
      traffic_stop_count: 3,
      rolling_stop_count: 3,
      intersection_score: 73,
    });

    const unsafeStops = analyzeIntersectionBehavior(trafficStopRoute(Array(10).fill(8), 3));
    expect(unsafeStops.traffic_stop_count).toBe(13);
    expect(unsafeStops.intersection_score).toBeLessThan(40);
  });

  it('leaves intersection scoring unobserved for highways, low-speed-only trips, and masked stop windows', () => {
    const highwayRoute = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.002, -79.3832, index * 5, 95)
    ));
    const parkingLotRoute = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 5, 6)
    ));
    const singleLowSample = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6552, -79.3832, 5, 0),
      point(43.6572, -79.3832, 10, 35),
    ];
    const maskedStopWindow = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6562, -79.3832, 5, 18),
      point(43.6592, -79.3832, 10, 8),
      { ...point(43.6622, -79.3832, 15, 8), lat: null, lng: null, masked_for_privacy: true },
      point(43.6652, -79.3832, 20, 8),
      point(43.6682, -79.3832, 25, 35),
    ];
    const shortObservedStop = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6533, -79.3832, 5, 8),
      point(43.6534, -79.3832, 10, 8),
      point(43.6535, -79.3832, 15, 35),
    ];
    const interruptedLowSpeedWindow = [
      point(43.6532, -79.3832, 0, 35),
      point(43.6552, -79.3832, 5, 8),
      point(43.6572, -79.3832, 25, 8),
      point(43.6592, -79.3832, 30, 35),
    ];

    expect(analyzeIntersectionBehavior(highwayRoute)).toMatchObject({
      intersection_score: null,
      intersection_score_confidence: 'no_traffic_stops',
      traffic_stop_count: 0,
    });
    expect(analyzeIntersectionBehavior(parkingLotRoute).traffic_stop_count).toBe(0);
    expect(analyzeIntersectionBehavior(singleLowSample).traffic_stop_count).toBe(0);
    expect(analyzeIntersectionBehavior(maskedStopWindow).traffic_stop_count).toBe(0);
    expect(analyzeIntersectionBehavior(interruptedLowSpeedWindow).traffic_stop_count).toBe(0);
    expect(analyzeIntersectionBehavior(shortObservedStop)).toMatchObject({
      intersection_score: null,
      intersection_score_confidence: 'insufficient_data',
      traffic_stop_count: 1,
    });

    const highwayStats = calculateTripStats(highwayRoute, highwayRoute[0].timestamp, highwayRoute.at(-1).timestamp);
    const highwayScores = calculateTripScores([], highwayStats, highwayRoute);
    expect(highwayStats.intersection_score).toBeNull();
    expect(highwayScores.intersection_score).toBeNull();
    expect(Number.isFinite(highwayScores.score_overall)).toBe(true);
  });

  it('scores intersection stops from raw points when display route is privacy-masked', () => {
    const privateStopRoute = [
      point(43.6470, -79.38, 0, 35),
      point(43.6496, -79.38, 10, 25),
      point(43.6500, -79.38, 15, 0),
      point(43.6500, -79.38, 20, 0),
      point(43.6530, -79.38, 30, 35),
    ];
    const privacyZone = { id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 150 };
    const maskedRoute = maskRoutePointsForPrivacy(privateStopRoute, { privacy_zones: [privacyZone] });
    const stats = calculateTripStats(
      maskedRoute,
      privateStopRoute[0].timestamp,
      privateStopRoute.at(-1).timestamp,
      DEFAULT_THRESHOLDS,
      { raw_route_points: privateStopRoute }
    );

    expect(analyzeIntersectionBehavior(maskedRoute).traffic_stop_count).toBe(0);
    expect(stats.traffic_stop_count).toBe(1);
    expect(stats.intersection_score_confidence).toBe('observed_stops');
    expect(stats.intersection_events[0]).toMatchObject({ coordinates_private: true });
    expect(stats.intersection_events[0]).not.toHaveProperty('lat');
    expect(stats.intersection_events[0]).not.toHaveProperty('lng');
  });

  it('computes second-wave advanced score components from route points', () => {
    const points = [
      point(43.6532, -79.3832, 0, 70),
      point(43.6542, -79.3832, 5, 72),
      point(43.6552, -79.3832, 10, 74),
      point(43.6562, -79.3832, 15, 20),
      point(43.6572, -79.3832, 20, 0),
    ];

    expect(calculateSpeedVariabilityIndex(points)).toMatchObject({
      speed_variability_index: null,
      svi_score: null,
      svi_score_confidence: 'insufficient_data',
    });
    expect(calculateFuelBandScore(points).fuel_band_score).toBeGreaterThan(0);
    expect(calculateSmoothBrakingRatio(points).total_stops_detected).toBe(1);
    const scores = calculateTripScores([], { distance_km: 2, fatigue_risk_score: 0, intersection_score: 100 }, points);
    expect(scores.defensive_driving_score).toBeGreaterThan(0);
    expect(scores.aggressive_driving_score).toBeGreaterThan(0);
  });

  it('excludes stopped samples and leaves undersampled SVI unavailable', () => {
    const parkingLot = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.00001, -79.3832, index * 5, 0, 6)
    ));
    const shortDrive = Array.from({ length: 9 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, 45, 6)
    ));
    const signalledCityDrive = Array.from({ length: 20 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, index % 2 === 0 ? 0 : 50, 6)
    ));

    expect(calculateSpeedVariabilityIndex(parkingLot).svi_score).toBeNull();
    expect(calculateSpeedVariabilityIndex(shortDrive).svi_score).toBeNull();
    expect(calculateSpeedVariabilityIndex(signalledCityDrive)).toMatchObject({
      speed_variability_index: 0,
      svi_score: 100,
      svi_score_confidence: 'road_type_stratified',
      svi_moving_sample_count: 10,
    });
  });

  it('uses a stricter SVI multiplier for highway variability than city variability', () => {
    const city = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.0001, -79.3832, index * 5, index % 2 === 0 ? 40 : 60, 6)
    ));
    const highway = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.001, -79.3832, index * 5, index % 2 === 0 ? 90 : 110, 6)
    ));

    expect(SVI_DEFAULTS).toMatchObject({ CITY_MULTIPLIER: 1, HIGHWAY_MULTIPLIER: 2 });
    expect(calculateSpeedVariabilityIndex(city).svi_score).toBe(90);
    expect(calculateSpeedVariabilityIndex(highway).svi_score).toBe(80);
  });

  it('weights mixed-route SVI by segment distance rather than sample count', () => {
    const speeds = [
      ...Array.from({ length: 10 }, (_, index) => index % 2 === 0 ? 40 : 60),
      ...Array.from({ length: 10 }, () => 100),
    ];
    let lat = 43.6532;
    const mixed = speeds.map((speed, index) => {
      if (index > 0) lat += speed >= SVI_DEFAULTS.HIGHWAY_MIN_KMH ? 0.001 : 0.0001;
      return point(lat, -79.3832, index * 5, speed, 6);
    });

    const result = calculateSpeedVariabilityIndex(mixed);

    expect(result.svi_score).toBeGreaterThan(95);
    expect(result.svi_score_confidence).toBe('road_type_stratified');
  });

  it('does not award an inflated fuel-band score for 50 percent optimal time', () => {
    const points = [
      point(43.6532, -79.3832, 0, 70),
      point(43.6542, -79.3832, 10, 70),
      point(43.6552, -79.3832, 20, 30),
    ];

    const fuelBand = calculateFuelBandScore(points);

    expect(fuelBand.optimal_band_ratio).toBe(50);
    expect(fuelBand.fuel_band_score).toBe(55);
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
    expect(nightScore.score_safety).toBeNull();
    expect(dayScore.score_safety).toBeNull();
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

  it('uses the shared fixed-hour fallback boundary when coordinates are unavailable', () => {
    const beforeEnd = { timestamp: new Date(2026, 0, 1, 4, 59, 0).toISOString() };
    const atEnd = { timestamp: new Date(2026, 0, 1, 5, 0, 0).toISOString() };

    expect(isNightDrivingTime(beforeEnd)).toBe(true);
    expect(isNightDrivingTime(atEnd)).toBe(false);
  });

  it('keeps 2,000-point trip stats and scoring stable under the route hot-path budget', () => {
    const startMs = Date.UTC(2026, 0, 1, 17, 0, 0);
    const points = Array.from({ length: 2000 }, (_, index) => ({
      lat: 43.6532 + index * 0.0001497,
      lng: -79.3832,
      speed_kmh: 60,
      accuracy: 6,
      timestamp: new Date(startMs + index * 1000).toISOString(),
    }));

    const startedAt = performance.now();
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const scores = calculateTripScores([], stats, points, DEFAULT_THRESHOLDS, stats.duration_seconds, {}, { includeRoadTypeSegments: false });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2500);
    expect(stats.distance_km).toBeCloseTo(33.3, 1);
    expect(stats.avg_speed_kmh).toBe(59.9);
    expect(stats.avg_running_speed_kmh).toBe(59.9);
    expect(stats.max_speed_kmh).toBe(60);
    expect(stats.idle_time_seconds).toBe(0);
    expect(stats.night_driving).toBe(false);
    expect(stats.speed_zones[0]).toMatchObject({
      inferredZone: 'zone_60_70',
      inferredZoneKmh: 70,
      confidence: 'high',
      road_type: 'urban',
    });
    expect(scores.score_overall).toBeGreaterThanOrEqual(90);
    expect(scores.score_safety).toBe(98);
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

  it('emits inferred-limit speeding events when OSM speed limits are missing', () => {
    const points = Array.from({ length: 40 }, (_, index) => {
      const speed = index >= 20 && index <= 24 ? 60 : 45;
      return {
        ...point(43.6532 + index * 0.00008, -79.3832, index, speed),
        heading: 0,
      };
    });

    const speeding = detectDrivingEvents(points).events.find((event) => event.type === EVENT_TYPES.SPEEDING);
    const liveLimit = resolveEffectiveSpeedLimitForIndex(points, 22).effectiveLimitKmh;
    const inferredLimit = getInferredLimitForPoint(points, points[22]);
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const scores = calculateTripScores(detectDrivingEvents(points), stats, points);

    expect(speeding).toMatchObject({
      severity: 'low',
      speed_kmh: 60,
      speed_limit_kmh: 50,
      speed_limit_source: 'inferred',
      inferred_zone_kmh: 50,
    });
    expect(liveLimit).toBe(50);
    expect(inferredLimit).toBe(50);
    expect(scores.component_scores.speed_limit_compliance.dataSource).toContain('gps_inferred_speed_limit');
    expect(scores.component_scores.speed_limit_compliance.note).toContain('inferred road-type limits');
    expect(scores.component_scores.safety.note).toContain('speeding penalties are half-weighted');
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

  it('ignores low-speed parked jitter for jerk, brake onset, and hill scoring', () => {
    const parkedJitter = [0, 4, 0, 5, 0].map((speed, index) => ({
      ...point(43.6532 + index * 0.00001, -79.3832, index * 5, speed, 6),
      altitude: 100 + (index % 2 === 0 ? 0 : 8),
      altitude_accuracy: 8,
    }));

    expect(calculateJerkScore(parkedJitter).jerk_event_count).toBe(0);
    expect(calculateBrakeOnsetSmoothness(parkedJitter, [{
      type: EVENT_TYPES.HARSH_BRAKE,
      timestamp: parkedJitter[2].timestamp,
      speed_kmh: 4,
    }]).brake_onset_sequence_count).toBe(0);
    expect(calculateHillDrivingScore(parkedJitter).hill_driving_score).toBeNull();
  });

  it('penalizes slow-ramp hard braking more than slow-ramp gentle braking', () => {
    expect(scoreBrakeOnsetSmoothness(6.5, 2)).toBe(54);
    expect(scoreBrakeOnsetSmoothness(3.75, 2)).toBe(85);
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

  it('tracks heading deviations and stop-start patterns as low-confidence proxies', () => {
    const lanePoints = [0, 5, 10, 5, 0].map((heading, index) => ({
      ...point(43.6532 + index * 0.0003, -79.3832, index * 2, 60),
      heading,
    }));
    const followingPoints = [65, 66, 65, 45, 42].map((speed, index) => (
      point(43.6532 + index * 0.00035, -79.3832, index * 2, speed)
    ));
    const cityFollowingPoints = [50, 51, 50, 30, 28].map((speed, index) => (
      point(43.6532 + index * 0.00035, -79.3832, index * 2, speed)
    ));
    const maskedFollowingPoints = [65, 66, 65, 45, 42].map((speed, index) => (
      index === 2
        ? { ...point(43.6532 + index * 0.00035, -79.3832, index * 2, speed), lat: null, lng: null, masked_for_privacy: true }
        : point(43.6532 + index * 0.00035, -79.3832, index * 2, speed)
    ));
    const mergePoints = [45, 58, 72, 88].map((speed, index) => (
      point(43.6532 + index * 0.00045, -79.3832, index * 5, speed)
    ));

    expect(detectHeadingDeviationEvents(lanePoints)[0]).toMatchObject({ type: EVENT_TYPES.HEADING_DEVIATION, confidence: 'low' });
    expect(detectStopStartPatterns(followingPoints)[0]).toMatchObject({ type: EVENT_TYPES.STOP_START_PATTERN, confidence: 'low' });
    expect(detectStopStartPatterns(cityFollowingPoints).length).toBeGreaterThan(0);
    expect(detectStopStartPatterns(maskedFollowingPoints)).toHaveLength(0);
    expect(detectHighwayMergeBehavior(mergePoints).merge_event_count).toBe(1);
  });

  it('scores highway merge quality by event ratio instead of absolute count', () => {
    const mergeSequence = (startSeconds, poor = false) => [
      point(43.6532 + startSeconds * 0.00001, -79.3832, startSeconds, 45),
      point(43.6532 + (startSeconds + (poor ? 4 : 10)) * 0.00001, -79.3832, startSeconds + (poor ? 4 : 10), 88),
    ];
    const route = (poorCount) => Array.from({ length: 5 }, (_, index) => (
      mergeSequence(index * 30, index < poorCount)
    )).flat();

    const onePoor = detectHighwayMergeBehavior(route(1));
    const fourPoor = detectHighwayMergeBehavior(route(4));

    expect(onePoor).toMatchObject({
      merge_event_count: 5,
      poor_merge_count: 1,
      merge_score: 92,
    });
    expect(fourPoor).toMatchObject({
      merge_event_count: 5,
      poor_merge_count: 4,
      merge_score: 68,
    });
  });

  it('detects heading deviations without counting sustained road curves', () => {
    const gentleLaneSwitch = [0, 2, 5, 7, 5, 2, 0].map((heading, index) => ({
      ...point(43.6532 + index * 0.00022, -79.3832, index * 2, 60),
      heading,
    }));
    const roadCurve = [0, 4, 8, 12, 16, 20, 24].map((heading, index) => ({
      ...point(43.6532 + index * 0.00022, -79.3832, index * 2, 60),
      heading,
    }));

    expect(detectHeadingDeviationEvents(gentleLaneSwitch).length).toBeGreaterThan(0);
    expect(detectHeadingDeviationEvents(roadCurve).length).toBe(0);
  });

  it('detects calibrated IMU bilateral-yaw lane changes', () => {
    const route = Array.from({ length: 12 }, (_, index) => ({
      ...point(43.6532 + index * 0.00025, -79.3832, index, 92, 8),
      heading: [0, 0, 2, 4, 3, 1, 0, 0, 0, 0, 0, 0][index],
    }));
    const baseMs = new Date(route[2].timestamp).getTime();
    const motionSamples = [0, 700, 1400, 2100, 2800, 3500, 4200, 4900].map((offset, index) => ({
      timestamp: new Date(baseMs + offset).toISOString(),
      ax: index < 4 ? 1.25 : 0.95,
      ay: index === 2 ? -3.1 : -0.2,
      az: 0.1,
      gz_deg_s: index < 4 ? 5 : -5,
      has_axes: true,
    }));

    const result = detectLaneChanges(route, motionSamples, {
      calibrated: true,
      longitudinal_axis: 'ay',
      lateral_axis: 'ax',
    });

    expect(result).toMatchObject({
      lane_change_count: 1,
      unsafe_lane_changes: 1,
      confidence: 'imu_calibrated',
      detection_method: 'imu_yaw_bilateral',
    });
    expect(result.lane_changes[0]).toMatchObject({
      type: 'lane_change_detected',
      detection_method: 'imu_yaw_bilateral',
      confidence: 'high',
      direction: 'right',
      simultaneous_braking: true,
    });
    expect(result.lane_changes[0].lateral_g).toBeGreaterThanOrEqual(0.08);
  });

  it('detects low-confidence GPS bilateral-heading lane changes without IMU calibration', () => {
    const route = [0, 0, 3, 6, 4, 1, 0, 0, 0, 0, 0].map((heading, index) => ({
      ...point(43.6532 + index * 0.00025, -79.3832, index, 88, 8),
      heading,
    }));

    const result = detectLaneChanges(route, [], null);

    expect(result).toMatchObject({
      lane_change_count: 1,
      unsafe_lane_changes: 0,
      confidence: 'gps_only',
      detection_method: 'gps_bilateral_heading',
    });
    expect(result.lane_changes[0]).toMatchObject({
      type: 'lane_change_detected',
      detection_method: 'gps_bilateral_heading',
      confidence: 'low',
      lateral_g: null,
    });
  });

  it('scores lane-changing rate and unsafe lane changes', () => {
    const scored = calculateLaneChangingScore({
      confidence: 'imu_calibrated',
      unsafe_lane_changes: 1,
      lane_changes: [
        { type: 'lane_change_detected', simultaneous_braking: true },
        { type: 'lane_change_detected', simultaneous_braking: false },
      ],
    }, 10);
    const sparse = calculateLaneChangingScore({
      confidence: 'imu_calibrated',
      unsafe_lane_changes: 0,
      lane_changes: [{ type: 'lane_change_detected' }],
    }, 10);

    expect(scored).toMatchObject({
      lane_changing_score: 73,
      lane_changing_rate_per_10km: 2,
      unsafe_lane_changes: 1,
      lane_changing_grade: 'acceptable',
      lane_changing_confidence: 'imu_calibrated',
    });
    expect(sparse).toMatchObject({
      lane_changing_score: null,
      lane_changing_confidence: 'insufficient_data',
    });
  });

  it('golden: scores IMU lane changes and blends them into Safety', () => {
    const route = Array.from({ length: 40 }, (_, index) => ({
      ...point(43.6532 + index * 0.00025, -79.3832, index, 92, 8),
      timestamp: new Date(Date.UTC(2026, 5, 1, 17, 0, index)).toISOString(),
      heading: 0,
    }));
    const laneStarts = [2, 13, 24];
    const motionSamples = laneStarts.flatMap((startIndex, laneIndex) => {
      const baseMs = new Date(route[startIndex].timestamp).getTime();
      const sign = laneIndex % 2 === 0 ? 1 : -1;
      return [0, 700, 1400, 2100, 2800, 3500, 4200, 4900].map((offset, sampleIndex) => ({
        timestamp: new Date(baseMs + offset).toISOString(),
        ax: sign * (sampleIndex < 4 ? 1.25 : 0.95),
        ay: laneIndex === 0 && sampleIndex === 2 ? -3.1 : -0.2,
        az: 0.1,
        gz_deg_s: sign * (sampleIndex < 4 ? 5 : -5),
        has_axes: true,
      }));
    });

    const thresholds = { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false };
    const laneChangeResult = detectLaneChanges(route, motionSamples, {
      calibrated: true,
      longitudinal_axis: 'ay',
      lateral_axis: 'ax',
    }, thresholds);
    const scored = calculateTripScores([], {
      distance_km: 10,
      fatigue_risk_score: 0,
      intersection_score: 100,
    }, route, thresholds, 600, {}, {
      includeRoadTypeSegments: false,
      motionSamples,
      orientationCalibration: {
        calibrated: true,
        longitudinal_axis: 'ay',
        lateral_axis: 'ax',
      },
    });
    const complianceScore = scored.overall_compliance_score;
    const safetyBlend = scoringValue('SAFETY_SCORE_BLEND_WEIGHTS');
    const expectedSafety = Math.round((
      100 * safetyBlend.base +
      complianceScore * safetyBlend.compliance +
      scored.lane_changing_score * LANE_CHANGING_SAFETY_WEIGHT
    ) / (safetyBlend.base + safetyBlend.compliance + LANE_CHANGING_SAFETY_WEIGHT));
    expect(laneChangeResult).toMatchObject({
      lane_change_count: 3,
      unsafe_lane_changes: 1,
      confidence: 'imu_calibrated',
      detection_method: 'imu_yaw_bilateral',
    });
    expect(scored.lane_changing_score).toBeGreaterThanOrEqual(65);
    expect(scored.lane_changing_score).toBeLessThanOrEqual(69);
    expect(scored).toMatchObject({
      lane_change_count: 3,
      unsafe_lane_changes: 1,
      lane_changing_confidence: 'imu_calibrated',
      lane_changing_confidence_multiplier: 1,
      lane_changing_safety_weight: LANE_CHANGING_SAFETY_WEIGHT,
    });
    expect(scored.score_safety).toBe(expectedSafety);
  });

  it('golden: detects GPS-only bilateral lane changes without Safety weight', () => {
    const route = Array.from({ length: 28 }, (_, index) => ({
      ...point(43.6532 + index * 0.00025, -79.3832, index, 90, 8),
      timestamp: new Date(Date.UTC(2026, 5, 1, 17, 0, index)).toISOString(),
      heading: 0,
    }));
    [2, 13].forEach((startIndex) => {
      [3, 6, 4, 1, 0].forEach((heading, offset) => {
        route[startIndex + offset].heading = heading;
      });
    });
    const thresholds = { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false };
    const laneChangeResult = detectLaneChanges(route, [], null, thresholds);
    const scored = calculateTripScores([], {
      distance_km: 10,
      fatigue_risk_score: 0,
      intersection_score: 100,
    }, route, thresholds, 600, {}, {
      includeRoadTypeSegments: false,
    });

    expect(laneChangeResult).toMatchObject({
      lane_change_count: 2,
      unsafe_lane_changes: 0,
      confidence: 'gps_only',
      detection_method: 'gps_bilateral_heading',
    });
    expect(laneChangeResult.lane_changes[0]).toMatchObject({
      type: 'lane_change_detected',
      confidence: 'low',
      detection_method: 'gps_bilateral_heading',
    });
    expect(scored).toMatchObject({
      lane_change_count: 2,
      lane_changing_confidence: 'gps_only',
      lane_changing_confidence_multiplier: 0.7,
    });
    expect(scored.lane_changing_safety_weight).toBe(0);
  });

  it('keeps scored lane changing diagnostic out of Safety', () => {
    const route = Array.from({ length: 12 }, (_, index) => (
      point(43.6532 + index * 0.01, -79.3832, index * 5, 88, 8)
    ));
    const stats = { distance_km: 10, fatigue_risk_score: 0, intersection_score: 100 };
    const thresholds = { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false };
    const base = calculateTripScores([], stats, route, thresholds, 600, {}, {
      includeRoadTypeSegments: false,
      laneChangeResult: {
        confidence: 'insufficient_data',
        unsafe_lane_changes: 0,
        lane_changes: [],
      },
    });
    const withLaneChanging = calculateTripScores([], stats, route, thresholds, 600, {}, {
      includeRoadTypeSegments: false,
      laneChangeResult: {
        confidence: 'imu_calibrated',
        unsafe_lane_changes: 3,
        lane_changes: [
          { type: 'lane_change_detected', simultaneous_braking: true },
          { type: 'lane_change_detected', simultaneous_braking: false },
        ],
      },
    });

    expect(base.lane_changing_score).toBeNull();
    expect(base.score_safety).toBe(withLaneChanging.score_safety);
    expect(withLaneChanging).toMatchObject({
      lane_changing_score: 48,
      lane_change_count: 2,
      unsafe_lane_changes: 3,
      lane_changing_confidence: 'imu_calibrated',
    });
    expect(withLaneChanging.component_scores.lane_changing).toMatchObject({
      value: 48,
      evidence: 'developing',
      note: 'Diagnostic only until 200 dashcam-reviewed labeled trips reach 85% agreement and curved-road false positives stay below 10%; not included in Safety.',
    });
  });

  it('suppresses lane-change detections during sustained curved-road windows', () => {
    const start = Date.UTC(2026, 5, 1, 17, 0, 0);
    const route = Array.from({ length: 16 }, (_, index) => ({
      ...point(43.6532 + index * 0.0002, -79.3832 + index * 0.00002, index, 90, 8),
      timestamp: new Date(start + index * 1000).toISOString(),
      heading: index * 8,
    }));
    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M: 8,
      LANE_CHANGE_CURVE_SUPPRESSION_SECONDS: 4,
    };
    const laneChangeResult = detectLaneChanges(route, [], null, thresholds);

    expect(laneChangeResult.lane_change_count).toBe(0);
    expect(laneChangeResult.curved_road_suppression_window_count).toBeGreaterThan(0);
  });

  it('keeps heading-deviation events out of the safety score', () => {
    const base = calculateTripScores([], { distance_km: 8, fatigue_risk_score: 0, intersection_score: 100 }, []);
    const withHeadingEvent = calculateTripScores([
      { type: EVENT_TYPES.HEADING_DEVIATION, severity: 'high' },
    ], { distance_km: 8, fatigue_risk_score: 0, intersection_score: 100 }, []);
    expect(withHeadingEvent.score_safety).toBe(base.score_safety);
  });

  it('keeps aggressive overtake diagnostics out of the safety score', () => {
    const stats = { distance_km: 8, fatigue_risk_score: 0, intersection_score: 100 };
    const base = calculateTripScores([], stats, []);
    const withOvertake = calculateTripScores([
      { type: EVENT_TYPES.AGGRESSIVE_OVERTAKE, severity: 'high', diagnostic_only: true },
    ], stats, []);

    expect(withOvertake.score_safety).toBe(base.score_safety);
    expect(withOvertake.overtake_event_count).toBe(1);
    expect(withOvertake.overtake_affects_score).toBe(false);
  });

  it('requires sustained brake-turn evidence before emitting an estimated alert', () => {
    const shortSpike = [
      { ...point(43.6532, -79.3832, 0, 60), heading: 0 },
      { ...point(43.6533, -79.3832, 1, 40), heading: 30 },
    ];
    const sustained = [
      { ...point(43.6532, -79.3832, 0, 80), heading: 0 },
      { ...point(43.6533, -79.3832, 1, 60), heading: 30 },
      { ...point(43.6534, -79.3832, 2, 40), heading: 60 },
    ];
    expect(detectCloseProximityManeuverAlerts(shortSpike)).toHaveLength(0);
    expect(detectCloseProximityManeuverAlerts(sustained)[0]).toMatchObject({ type: EVENT_TYPES.CLOSE_PROXIMITY, confidence: 'low' });
  });

  it('exports proxy-safe score labels in CSV reports', () => {
    const csv = tripsToCSV([]);
    expect(csv).toContain('Brake Onset Smoothness Score');
    expect(csv).toContain('Stop-Start Pattern Estimate');
    expect(csv).toContain('GPS Attention Signal');
    expect(csv).toContain('Speed Limit Sources');
    expect(csv).not.toContain('Reaction Time');
    expect(csv).not.toContain('Lane Changes');
    expect(csv).not.toContain('Tailgate');
  });

  it('exports speed-limit provenance in CSV reports', () => {
    const csv = tripsToCSV([{
      id: 'trip-speed-source',
      route_points: [{
        lat: 43.65,
        lng: -79.38,
        speed_limit_source: 'osm_highway_default',
        speed_limit_default_country: 'gb',
      }],
      driving_events: [{ type: EVENT_TYPES.SPEEDING, speed_limit_source: 'openstreetmap' }],
    }]);

    expect(csv).toContain('Speed Limit Sources');
    expect(csv).toContain('Speed Limit Default Countries');
    expect(csv).toContain('openstreetmap;osm_highway_default');
    expect(csv).toContain('gb');
  });

  it('does not flag normal steady city speed as erratic speed', () => {
    const steady = Array.from({ length: 10 }, (_, index) => (
      point(43.6532 + index * 0.00022, -79.3832, index * 5, index % 2 === 0 ? 42 : 45)
    ));

    expect(detectErraticSpeedWindows(steady)).toHaveLength(0);
  });

  it('flags repeated speed oscillation in a sliding city-speed window', () => {
    const oscillating = [20, 60, 20, 60, 20, 60, 20].map((speed, index) => (
      point(43.6532 + index * 0.00022, -79.3832, index * 5, speed)
    ));

    expect(detectErraticSpeedWindows(oscillating)).toHaveLength(1);
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
    expect(splits[0].score_overall).toBeNull();
    expect(splits[0].split_parent_id).toBe('original-trip');
  });

  it('infers speed zones from 60-second route windows', () => {
    const points = Array.from({ length: 7 }, (_, index) => point(43.6532 + index * 0.0002, -79.3832, index * 10, 45));

    const zones = inferSpeedZones(points);

    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].inferredZone).toBe('zone_50');
    expect(zones[0].inferredZoneKmh).toBe(50);
    expect(zones[0].inferredLimitKmh).toBe(50);
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

  it('reverse-geocodes a web-originated parked location when no address is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ display_name: 'Queen Street West, Toronto, Ontario, Canada' }),
    })));
    const previousReverseGeocoding = localSettings.get().reverse_geocoding_enabled;
    localSettings.update({ reverse_geocoding_enabled: true });

    try {
      const saved = await saveLastParkedLocation({
        lat: 43.6532,
        lng: -79.3832,
        timestamp: '2026-01-01T12:00:00.000Z',
        tripId: 'park-geocode-test',
      });
      const loaded = await getLastParkedLocation();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(saved.address).toBe('Queen Street West, Toronto');
      expect(loaded.address).toBe('Queen Street West, Toronto');
    } finally {
      localSettings.update({ reverse_geocoding_enabled: previousReverseGeocoding === true });
    }
  });

  it('does not store the last parked location inside a privacy zone guard', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })));

    const previousZones = localSettings.get().privacy_zones;
    const privacyZone = { id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 };
    const guardBoundaryM = privacyZone.radius_m + PARKED_LOCATION_PRIVACY_GUARD_M;
    const publicParkedLocation = pointNorthOf(privacyZone, guardBoundaryM + 25);
    const privateParkedLocation = pointNorthOf(privacyZone, guardBoundaryM - 1);

    const previousReverseGeocoding = localSettings.get().reverse_geocoding_enabled;

    localSettings.update({
      privacy_zones: [privacyZone],
      reverse_geocoding_enabled: true,
    });

    try {
      await saveLastParkedLocation({
        ...publicParkedLocation,
        timestamp: '2026-01-01T12:00:00.000Z',
        tripId: 'public-park',
      });
      const savedPrivate = await saveLastParkedLocation({
        ...privateParkedLocation,
        timestamp: '2026-01-01T12:05:00.000Z',
        tripId: 'private-park',
      });

      expect(savedPrivate).toBeNull();
      expect(await getLastParkedLocation()).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      localSettings.update({
        privacy_zones: previousZones || [],
        reverse_geocoding_enabled: previousReverseGeocoding === true,
      });
    }
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

  it('provides fill classes from the canonical score color tiers', () => {
    expect(getScoreColor(85).fill).toBe('bg-green-500');
    expect(getScoreColor(70).fill).toBe('bg-blue-500');
    expect(getScoreColor(55).fill).toBe('bg-yellow-500');
    expect(getScoreColor(40).fill).toBe('bg-orange-500');
    expect(getScoreColor(39).fill).toBe('bg-red-500');
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
        score_confidence: 1,
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
    expect(buildScoreTips([{ ...trips[0], score_confidence: undefined }])[0]).toContain('Not enough data yet');
    const badges = calculateAchievementBadges(trips);
    expect(badges).toHaveLength(25);
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
    expect(calculateRiskEventRate([{ ...todayTrip, distance_km: 4 }])).toMatchObject({
      events_per_100km: null,
      insufficient_data: true,
      minimum_distance_km: 50,
    });
    expect(calculatePeakHourStress([{ ...todayTrip, distance_km: 0.3 }])).toMatchObject({
      peak_stress_score: null,
      stress_ratio: null,
      peak_stress_label: 'insufficient off-peak data',
      insufficient_data: true,
    });
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
      score_provenance: { scoring_version: SCORING_VERSION },
      eco_driving_score: 90,
      driving_events: [{ type: 'harsh_brake', severity: 'medium' }],
    };
    const trips = Array.from({ length: 10 }, (_, index) => ({
      ...commute,
      id: `baseline-${index}`,
      start_time: new Date(Date.now() - index * 86400000).toISOString(),
      score_overall: 80 + index,
    }));

    expect(suggestTripTag(commute).auto_tag).toBe('commute');
    expect(suggestTripTag({ ...commute, start_time: new Date(2026, 0, 5, 19, 0, 0).toISOString() }).auto_tag).toBe('city');
    expect(suggestTripTag({ ...commute, start_time: new Date(2026, 0, 5, 5, 0, 0).toISOString() }).auto_tag).not.toBe('night');
    expect(estimateTripEconomics(commute, { fuel_efficiency_l_per_100km: 10 }).fuel_saved_liters).toBeGreaterThan(0);
    const baseline = computePersonalBaseline(trips);
    expect(baseline.baseline_avg).not.toBeNull();
    expect(baseline.baseline_confidence_interval).not.toBeNull();
    expect(baseline.baseline_confidence_interval_method).toBe(PERSONAL_BASELINE_INTERVAL_METHOD);
    expect(baseline.baseline_confidence_interval_note).toBe(PERSONAL_BASELINE_INTERVAL_NOTE);
    const healthImpact = calculateVehicleHealthImpact([{
      ...commute,
      trip_tire_wear_units: 2.5,
    }], {});
    expect(healthImpact.extra_wear_km).toBe(32);
    expect(healthImpact.tire_wear_has_missing_speed_data).toBe(true);
    expect(healthImpact.tire_wear_missing_speed_event_count).toBe(1);
  });

  it('does not unlock a personal baseline before ten completed trips', () => {
    const trips = Array.from({ length: 9 }, (_, index) => ({
      status: 'completed',
      start_time: new Date(Date.now() - index * 86400000).toISOString(),
      distance_km: 5,
      score_overall: 80,
      score_provenance: { scoring_version: SCORING_VERSION },
    }));
    expect(computePersonalBaseline(trips).baseline_avg).toBeNull();
  });

  it('weights personal baseline by recency without distance bias', () => {
    const trips = Array.from({ length: 10 }, (_, index) => ({
      status: 'completed',
      start_time: new Date(Date.now() - index * 86400000).toISOString(),
      distance_km: index === 9 ? 1 : 5,
      score_overall: index === 0 ? 60 : 90,
      score_provenance: { scoring_version: SCORING_VERSION },
    }));
    const longOldTrip = trips.map((trip, index) => (index === 9 ? { ...trip, distance_km: 1000 } : trip));
    expect(computePersonalBaseline(trips).baseline_avg).toBe(computePersonalBaseline(longOldTrip).baseline_avg);
  });
});
