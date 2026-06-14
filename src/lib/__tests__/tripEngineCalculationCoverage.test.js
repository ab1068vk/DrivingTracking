import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSE_PROXIMITY_DECAY_BASE,
  DEFAULT_THRESHOLDS,
  ECO_SPEED_STABILITY_CV_MULTIPLIER,
  EVENT_TYPES,
  HEADING_DRIFT_CIRCADIAN_MULTIPLIER,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN,
  STOP_START_NORMALISATION_WINDOW_KM,
  SVI_DEFAULTS,
  applyDifferentialPrivacyToTripAggregates,
  calculateAcceleration,
  calculateAggressiveDrivingScore,
  calculateBearing,
  calculateDefensiveDrivingScore,
  calculateEcoDrivingScore,
  calculateFuelBandScore,
  calculateJerkScore,
  calculateNightPenalty,
  calculateRouteSummary,
  calculateSpeedKmh,
  calculateSpeedVariabilityIndex,
  calculateTireWearUnits,
  calculateTripScores,
  calculateTripStats,
  classifyRoadType,
  cleanRoutePoints,
  detectHeadingDriftBeta,
  detectDrivingEvents,
  extractBrakingSequences,
  headingDiff,
  inferSpeedZones,
  splitTripAtStops,
  speedSourceForPoint,
  trimParkedTail,
  validateCandidateTrip,
  vehicleSpeedKmh,
} from '@/lib/tripEngine';
import { FATIGUE_SAFETY_MAX_PENALTY, FATIGUE_SAFETY_PENALTY_SCALE, PENALTY_SCALE_FACTOR } from '@/lib/appConstants';

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
const point = (index, patch = {}) => ({
  lat: 43.65 + index * 0.00018,
  lng: -79.38,
  speed_kmh: 45,
  accuracy: 8,
  heading: 0,
  timestamp: at(index * 10),
  ...patch,
});

const headingDriftPointsAtHour = (hour) => Array.from({ length: 31 }, (_, index) => point(index, {
  speed_kmh: 90,
  heading: index % 2 === 0 ? -12 : 12,
  timestamp: new Date(2026, 0, 1, hour, 0, index * 10).toISOString(),
}));

describe('trip engine calculation coverage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps base geometry calculations finite and direction-aware', () => {
    expect(calculateSpeedKmh(1, 60)).toBe(60);
    expect(calculateAcceleration(36, 72, 10)).toBeCloseTo(1, 1);
    expect(calculateBearing(43.65, -79.38, 43.66, -79.38)).toBeCloseTo(0, 0);
    expect(headingDiff(355, 5)).toBe(10);
  });

  it('preserves route points when parked-tail evidence is absent', () => {
    const moving = Array.from({ length: 8 }, (_, index) => point(index, { speed_kmh: 35 }));
    const parked = Array.from({ length: 8 }, (_, index) => point(8 + index, {
      lat: moving.at(-1).lat + index * 0.000001,
      speed_kmh: 0,
    }));

    const trimmed = trimParkedTail([...moving, ...parked]);

    expect(trimmed.trimmed).toBe(false);
    expect(trimmed.removedPoints).toBe(0);
    expect(trimmed.points.length).toBeGreaterThanOrEqual(moving.length);
  });

  it('validates candidate trips using movement, duration, and distance', () => {
    const route = Array.from({ length: 12 }, (_, index) => point(index, { speed_kmh: 32 }));

    expect(validateCandidateTrip({
      points: route,
      startTime: route[0].timestamp,
      now: route.at(-1).timestamp,
    }).confirmed).toBe(true);
    expect(validateCandidateTrip({
      points: route.slice(0, 2),
      startTime: route[0].timestamp,
      now: route[1].timestamp,
      forceFinal: true,
    }).discarded).toBe(true);
  });

  it('infers vehicle movement when GPS reports zero speed but coordinates move', () => {
    const route = Array.from({ length: 6 }, (_, index) => point(index, {
      lat: 43.65 + index * 0.001,
      speed_kmh: 0,
    }));
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);

    expect(stats.distance_km).toBeGreaterThan(0.5);
    expect(stats.max_speed_kmh).toBeGreaterThan(35);
    expect(validateCandidateTrip({
      points: route,
      startTime: route[0].timestamp,
      now: route.at(-1).timestamp,
    }).confirmed).toBe(true);
  });

  it('excludes stale GPS jumps from distance and marks the route break', () => {
    const route = [
      point(0, { lat: 43.65, speed_kmh: 40, timestamp: at(0) }),
      point(1, { lat: 43.651, speed_kmh: 40, timestamp: at(10) }),
      point(2, { lat: 45.9, speed_kmh: 0, timestamp: at(3 * 60 * 60) }),
      point(3, { lat: 45.901, speed_kmh: 40, timestamp: at(3 * 60 * 60 + 10) }),
    ];

    const clean = cleanRoutePoints(route);
    const stats = calculateTripStats(clean, route[0].timestamp, route.at(-1).timestamp);

    expect(clean[2].tracking_gap).toBe(true);
    expect(stats.distance_km).toBeLessThan(0.3);
    expect(stats.gap_seconds).toBeGreaterThan(120);
    expect(stats.max_speed_kmh).toBeLessThan(80);
  });

  it('estimates distance traveled through privacy-zone masked gaps', () => {
    const route = [
      point(0, {
        lat: 43.65,
        lng: -79.38,
        privacy_boundary: true,
        privacy_zone_id: 'home',
        timestamp: at(0),
      }),
      point(1, {
        lat: null,
        lng: null,
        masked_for_privacy: true,
        privacy_zone_id: 'home',
        timestamp: at(150),
      }),
      point(2, {
        lat: 43.652,
        lng: -79.38,
        privacy_boundary: true,
        privacy_zone_id: 'home',
        timestamp: at(300),
      }),
    ];

    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);

    expect(stats.estimated_private_distance_km).toBeGreaterThan(0.2);
    expect(stats.estimated_private_distance_km).toBeLessThan(0.25);
    expect(stats.distance_km).toBeGreaterThanOrEqual(stats.estimated_private_distance_km);
    expect(stats.duration_seconds).toBe(300);
  });

  it('detects braking sequences and harsher event scores on abrupt speed drops', () => {
    const route = [
      point(0, { speed_kmh: 100, timestamp: at(0) }),
      point(1, { speed_kmh: 96, timestamp: at(2) }),
      point(2, { speed_kmh: 0, timestamp: at(4) }),
      point(3, { speed_kmh: 0, timestamp: at(6) }),
      point(4, { speed_kmh: 45, timestamp: at(10) }),
    ];
    const detection = detectDrivingEvents(route, DEFAULT_THRESHOLDS);
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const aggressive = calculateAggressiveDrivingScore(detection.events, stats);

    expect(extractBrakingSequences(route).length).toBeGreaterThan(0);
    expect(detection.events.some((event) => event.type === 'harsh_brake')).toBe(true);
    expect(aggressive.aggressive_driving_score).toBeLessThan(100);
  });

  it('scores smooth eco cruising above stop-and-go driving', () => {
    const cruise = Array.from({ length: 18 }, (_, index) => point(index, { speed_kmh: 82 }));
    const stopGo = Array.from({ length: 18 }, (_, index) => point(index, { speed_kmh: index % 3 === 0 ? 0 : 28 }));
    const cruiseStats = calculateTripStats(cruise, cruise[0].timestamp, cruise.at(-1).timestamp);
    const stopGoStats = calculateTripStats(stopGo, stopGo[0].timestamp, stopGo.at(-1).timestamp);

    expect(calculateEcoDrivingScore(cruise, cruiseStats, DEFAULT_THRESHOLDS).eco_driving_score).toBeGreaterThan(
      calculateEcoDrivingScore(stopGo, stopGoStats, DEFAULT_THRESHOLDS).eco_driving_score
    );
    expect(calculateFuelBandScore(cruise, DEFAULT_THRESHOLDS).fuel_band_score).toBeGreaterThan(
      calculateFuelBandScore(stopGo, DEFAULT_THRESHOLDS).fuel_band_score
    );
  });

  it('does not invent an eco score when a trip has no route points', () => {
    expect(calculateEcoDrivingScore([], {}, DEFAULT_THRESHOLDS).eco_driving_score).toBeNull();
  });

  it('excludes driving events inside the privacy-zone event guard from scores and storage', () => {
    const privacyZones = [{ id: 'home', lat: 43.65, lng: -79.38, radius_m: 100 }];
    const nearBoundaryEvent = {
      type: EVENT_TYPES.HARSH_BRAKE,
      severity: 'medium',
      lat: 43.65115,
      lng: -79.38,
      timestamp: at(10),
      value: 5.2,
    };

    const scores = calculateTripScores(
      [nearBoundaryEvent],
      { distance_km: 5, duration_seconds: 300, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      300,
      {},
      { privacyZones }
    );

    expect(scores.harsh_brakes_count).toBe(0);
    expect(scores.driving_events).toEqual([]);
  });

  it('adds differential privacy noise only to aggregates for zone-touched trips', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const privacyZones = [{ id: 'home', lat: 43.65, lng: -79.38, radius_m: 100 }];
    const route = [
      point(0),
      point(1),
      point(2),
    ];
    const trip = {
      distance_km: 10,
      avg_speed_kmh: 50,
      idle_time_seconds: 60,
      harsh_brakes_count: 1,
      phone_use_window_count: 0,
      route_points: route,
    };

    const publicTrip = applyDifferentialPrivacyToTripAggregates(trip, [point(20), point(21)], privacyZones);
    const privateTrip = applyDifferentialPrivacyToTripAggregates(trip, route, privacyZones);

    expect(publicTrip).toBe(trip);
    expect(privateTrip).toMatchObject({
      _dpApplied: true,
      distance_km: 10.26,
      avg_speed_kmh: 52.1,
      idle_time_seconds: 112,
      harsh_brakes_count: 2,
      phone_use_window_count: 1,
    });
    expect(privateTrip.differential_privacy.noised_fields).toEqual(expect.arrayContaining([
      'distance_km',
      'avg_speed_kmh',
      'idle_time_seconds',
      'harsh_brakes_count',
      'phone_use_window_count',
    ]));
  });

  it('maps speed coefficient of variation to stable eco speed-stability scores', () => {
    const steady = [60, 60, 60, 60].map((speed, index) => point(index, { speed_kmh: speed }));
    const uneven = [30, 30, 90, 90].map((speed, index) => point(index, { speed_kmh: speed }));
    const expectedHalfCvScore = Math.round(100 - 0.5 * ECO_SPEED_STABILITY_CV_MULTIPLIER);

    expect(calculateEcoDrivingScore(steady, { duration_seconds: 60 }, DEFAULT_THRESHOLDS).speed_stability).toBe(100);
    expect(calculateEcoDrivingScore(uneven, { duration_seconds: 60 }, DEFAULT_THRESHOLDS).speed_stability).toBe(expectedHalfCvScore);
  });

  it('maps SVI stratum standard deviation to city and highway scores', () => {
    const city = [40, 40, 40, 40, 40, 60, 60, 60, 60, 60]
      .map((speed, index) => point(index, { speed_kmh: speed }));
    const highway = [90, 90, 90, 90, 90, 110, 110, 110, 110, 110]
      .map((speed, index) => point(index, { speed_kmh: speed }));

    expect(calculateSpeedVariabilityIndex(city, DEFAULT_THRESHOLDS).svi_score).toBe(
      Math.round(100 - 10 * SVI_DEFAULTS.CITY_MULTIPLIER)
    );
    expect(calculateSpeedVariabilityIndex(highway, DEFAULT_THRESHOLDS).svi_score).toBe(
      Math.round(100 - 10 * SVI_DEFAULTS.HIGHWAY_MULTIPLIER)
    );
  });

  it('applies the documented circadian multiplier to heading drift beta contribution', () => {
    const daytime = detectHeadingDriftBeta(headingDriftPointsAtHour(12), 300, DEFAULT_THRESHOLDS);
    const circadian = detectHeadingDriftBeta(headingDriftPointsAtHour(3), 300, DEFAULT_THRESHOLDS);

    expect(daytime.heading_drift_beta_window_count).toBe(1);
    expect(circadian.heading_drift_beta_window_count).toBe(1);
    expect(circadian.heading_drift_beta_weighted_contribution).toBeCloseTo(
      daytime.heading_drift_beta_weighted_contribution * HEADING_DRIFT_CIRCADIAN_MULTIPLIER,
      5
    );
  });

  it('classifies route types and speed zones from observed speeds', () => {
    const highway = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 104 }));
    const residential = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 18 }));
    const highwayZones = inferSpeedZones(highway, DEFAULT_THRESHOLDS);

    expect(classifyRoadType(highway).road_type).toBe('highway');
    expect(classifyRoadType(residential).road_type).toBe('residential');
    expect(highwayZones.some((zone) => zone.inferredZoneKmh >= 100)).toBe(true);
  });

  it('combines stats, events, and phone-use evidence into finite trip scores', () => {
    const route = Array.from({ length: 40 }, (_, index) => point(index, { speed_kmh: index % 5 === 0 ? 95 : 52 }));
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const events = detectDrivingEvents(route, DEFAULT_THRESHOLDS).events;
    const scores = calculateTripScores(events, stats, route, DEFAULT_THRESHOLDS, stats.duration_seconds, {
      phone_use_score_available: true,
      phone_use_score: 55,
      phone_use_risk: 'medium',
      phone_use_total_seconds: 30,
    });

    expect(scores.score_overall).toBeGreaterThanOrEqual(0);
    expect(scores.score_overall).toBeLessThanOrEqual(100);
    expect(Number.isFinite(scores.score_safety)).toBe(true);
    const defensive = calculateDefensiveDrivingScore(scores).defensive_driving_score;
    expect(defensive == null || defensive <= 100).toBe(true);
  });

  it('keeps every emitted numeric score finite for a 0.01 km trip', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 0.01, duration_seconds: 1, fatigue_risk_score: 0 },
      [],
      DEFAULT_THRESHOLDS,
      1
    );
    const checkScoreFields = (object) => Object.entries(object).forEach(([key, value]) => {
      if (/score/i.test(key) && typeof value === 'number') {
        expect(Number.isFinite(value), key).toBe(true);
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        checkScoreFields(value);
      }
    });

    checkScoreFields(scores);
  });

  it('floors Safety at zero at the documented 2.5 penalty-points-per-km threshold', () => {
    const route = Array.from({ length: 20 }, (_, index) => point(0, {
      timestamp: new Date(Date.UTC(2026, 0, 1, 18, 0, index * 10)).toISOString(),
      speed_kmh: 0,
    }));
    const scores = calculateTripScores(
      [{ type: EVENT_TYPES.ERRATIC_SPEED, severity: 'high' }],
      { distance_km: 4, duration_seconds: 200, fatigue_risk_score: 0 },
      route,
      { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false },
      200,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(PENALTY_SCALE_FACTOR).toBe(40);
    expect(scores.score_safety).toBe(0);
  });

  it('adds exactly the documented maximum fatigue penalty to Safety after normalization', () => {
    const route = Array.from({ length: 20 }, (_, index) => point(0, {
      timestamp: new Date(Date.UTC(2026, 0, 1, 18, 0, index * 10)).toISOString(),
      speed_kmh: 0,
    }));
    const stats = { distance_km: 12, duration_seconds: 200, fatigue_risk_score: 100 };
    const scores = calculateTripScores(
      [],
      stats,
      route,
      { ...DEFAULT_THRESHOLDS, PHONE_USE_AFFECTS_SCORE: false },
      stats.duration_seconds,
      {},
      { includeRoadTypeSegments: false }
    );
    const fatiguePenalty = Math.min(
      FATIGUE_SAFETY_MAX_PENALTY,
      FATIGUE_SAFETY_PENALTY_SCALE * stats.fatigue_risk_score
    );

    expect(fatiguePenalty).toBe(15);
    expect(scores.score_safety).toBe(100 - fatiguePenalty);
  });

  it('uses the missing-speed tire-wear default for an explicitly null event speed', () => {
    expect(calculateTireWearUnits([
      { type: EVENT_TYPES.HARSH_BRAKE, severity: 'medium', speed_kmh: null },
    ])).toEqual({
      trip_tire_wear_units: 2.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    });
  });

  it('filters duplicate timestamps and extreme reported-speed spikes from cleaned GPS samples', () => {
    const route = [
      point(0, { speed_kmh: 40 }),
      point(1, { timestamp: at(0), speed_kmh: 40 }),
      point(2, { speed_kmh: 320 }),
      point(3, { speed_kmh: 42 }),
    ];
    const cleaned = cleanRoutePoints(route, DEFAULT_THRESHOLDS);

    expect(cleaned).toHaveLength(2);
    expect(cleaned.some((sample) => sample.speed_kmh > 300)).toBe(false);
    expect(detectDrivingEvents(cleaned, DEFAULT_THRESHOLDS).events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(false);
  });

  it('collects heading events when Advanced Safety scoring is off', () => {
    const headings = [0, 0, 0, 8, 0, 0, 0];
    const route = headings.map((heading, index) => point(index, {
      lat: 43.65 + index * 0.0002,
      speed_kmh: 90,
      heading,
      timestamp: at(index * 5),
    }));
    const thresholds = { ...DEFAULT_THRESHOLDS, ADVANCED_SAFETY_DETECTION_ENABLED: false };
    const detection = detectDrivingEvents(route, thresholds);
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp, thresholds);
    const scores = calculateTripScores(detection.events, stats, route, thresholds, stats.duration_seconds);

    expect(detection.events.some((event) => event.type === EVENT_TYPES.HEADING_DEVIATION)).toBe(true);
    expect(scores.heading_deviation_count).toBeGreaterThan(0);
    expect(scores.heading_deviation_available).toBe(true);
    expect(scores.heading_deviation_scoring_enabled).toBe(false);
    expect(scores.driving_events.some((event) => event.type === EVENT_TYPES.HEADING_DEVIATION)).toBe(true);
  });

  it('uses recent OBD speed when GPS accuracy is weak', () => {
    const timestamp = at(0);
    const pointWithWeakGps = point(0, {
      speed_kmh: 8,
      accuracy: 30,
      obd_speed_kmh: 24,
      obd_speed_timestamp: timestamp,
      timestamp,
    });
    const pointWithGoodGps = { ...pointWithWeakGps, accuracy: 8 };

    expect(speedSourceForPoint(pointWithWeakGps, DEFAULT_THRESHOLDS)).toBe('obd_bluetooth');
    expect(vehicleSpeedKmh(pointWithWeakGps, DEFAULT_THRESHOLDS)).toBe(24);
    expect(speedSourceForPoint(pointWithGoodGps, DEFAULT_THRESHOLDS)).toBe('gps');
    expect(vehicleSpeedKmh(pointWithGoodGps, DEFAULT_THRESHOLDS)).toBe(8);
  });

  it('adds OBD powertrain evidence to eco scoring and component sources', () => {
    const route = Array.from({ length: 12 }, (_, index) => point(index, {
      speed_kmh: 4,
      accuracy: 25,
      obd_speed_kmh: index < 3 ? 0 : 55,
      obd_speed_timestamp: at(index * 10),
      obd_rpm: index < 3 ? 800 : index === 6 ? 3800 : 1800,
      obd_throttle_pct: index === 7 ? 90 : 35,
    }));
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const eco = calculateEcoDrivingScore(route, stats, DEFAULT_THRESHOLDS);
    const scores = calculateTripScores([], stats, route, DEFAULT_THRESHOLDS, stats.duration_seconds);

    expect(eco.obd_powertrain_sample_count).toBe(route.length);
    expect(eco.obd_idle_seconds).toBeGreaterThan(0);
    expect(eco.obd_over_rev_count).toBe(1);
    expect(scores.component_scores.eco.dataSource).toContain('obd_bluetooth');
  });

  it('keeps confirmed phone-use distraction scoring independent of trip distance', () => {
    const route = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 52 }));
    const phoneUse = {
      phone_use_score_available: true,
      phone_use_score: 70,
      phone_use_risk: 'medium',
      phone_use_pct_of_trip: 10,
    };

    const shortTrip = calculateTripScores([], { distance_km: 5, duration_seconds: 600 }, route, DEFAULT_THRESHOLDS, 600, phoneUse);
    const longTrip = calculateTripScores([], { distance_km: 50, duration_seconds: 6000 }, route, DEFAULT_THRESHOLDS, 6000, phoneUse);

    expect(shortTrip.distraction_score).toBe(65);
    expect(longTrip.distraction_score).toBe(shortTrip.distraction_score);
  });

  it('requires enough stop-start samples before defensive scoring uses that component', () => {
    expect(STOP_START_NORMALISATION_WINDOW_KM).toBe(5);

    const sharedScores = {
      total_stops_detected: 1,
      smooth_braking_ratio: 100,
      intersection_score: 100,
      svi_score: 100,
      stop_start_pattern_score: 0,
    };

    const sparse = calculateDefensiveDrivingScore({
      ...sharedScores,
      stop_start_pattern_sample_count: STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT - 1,
    });
    const sufficient = calculateDefensiveDrivingScore({
      ...sharedScores,
      stop_start_pattern_sample_count: STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT,
    });
    const urban = calculateDefensiveDrivingScore({
      ...sharedScores,
      stop_start_pattern_score: 0,
      stop_start_pattern_sample_count: STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN,
      stop_start_pattern_urban_count: STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN,
    });

    expect(sparse.defensive_driving_score).toBe(100);
    expect(sufficient.defensive_driving_score).toBe(70);
    expect(urban.defensive_driving_score).toBe(70);
  });

  it('omits close-proximity score when no proximity events are detected', () => {
    const route = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 52 }));
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const noEvents = calculateTripScores([], stats, route, DEFAULT_THRESHOLDS, stats.duration_seconds);
    const proximityEvents = calculateTripScores([
      { type: EVENT_TYPES.CLOSE_PROXIMITY, severity: 'medium' },
      { type: EVENT_TYPES.NEAR_MISS, severity: 'medium' },
    ], stats, route, DEFAULT_THRESHOLDS, stats.duration_seconds);

    expect(noEvents.close_proximity_count).toBe(0);
    expect(noEvents.close_proximity_score).toBeNull();
    expect(proximityEvents.stop_start_pattern_sample_count).toBe(0);
    expect(proximityEvents.close_proximity_count).toBe(1);
    expect(proximityEvents.close_proximity_score).toBe(Math.round(100 * CLOSE_PROXIMITY_DECAY_BASE));
  });

  it('summarizes full routes and applies night penalties to overnight samples', () => {
    const route = Array.from({ length: 40 }, (_, index) => point(index, {
      timestamp: new Date(Date.UTC(2026, 0, 2, 3, index, 0)).toISOString(),
      speed_kmh: 50,
    }));
    const summary = calculateRouteSummary(route, route[0].timestamp, route.at(-1).timestamp);

    expect(summary.stats.distance_km).toBeGreaterThan(0);
    expect(summary.scores.score_overall).toBeGreaterThan(0);
    expect(calculateNightPenalty(route, DEFAULT_THRESHOLDS)).toBeGreaterThan(0);
    expect(calculateJerkScore(route, DEFAULT_THRESHOLDS)).toMatchObject({
      jerk_score: 100,
      jerk_score_confidence: 'low',
    });
  });

  it('splits trips around long parked stops', () => {
    const firstLeg = Array.from({ length: 8 }, (_, index) => point(index, { timestamp: at(index * 30), speed_kmh: 35 }));
    const stop = Array.from({ length: 12 }, (_, index) => point(8 + index, {
      lat: firstLeg.at(-1).lat,
      timestamp: at(240 + index * 30),
      speed_kmh: 0,
    }));
    const secondLeg = Array.from({ length: 8 }, (_, index) => point(20 + index, {
      timestamp: at(600 + index * 30),
      speed_kmh: 38,
    }));

    const parts = splitTripAtStops({
      id: 'trip-1',
      start_time: firstLeg[0].timestamp,
      end_time: secondLeg.at(-1).timestamp,
      route_points: [...firstLeg, ...stop, ...secondLeg],
    }, 5);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((part) => part.route_points.length > 1)).toBe(true);
  });
});
