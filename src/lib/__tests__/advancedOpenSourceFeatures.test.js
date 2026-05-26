import { describe, expect, it, vi } from 'vitest';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { parseObdPidResponse } from '@/lib/obdBluetooth';
import { buildSensorFusionSummary, detectCrashIncident, enrichEventsWithSensorContext, getMotionSensorSupport } from '@/lib/sensorFusionModel';
import { estimatePredictiveRouteRisk, ROUTE_RISK_CONSTANTS } from '@/lib/predictiveRouteRisk';
import { buildWeeklyCoachSummary } from '@/lib/weeklyCoaching';
import { buildHabitProfile } from '@/lib/habitProfile';

const trip = (score, index = 0, patch = {}) => ({
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 0, index + 1, 18)).toISOString(),
  distance_km: 10,
  score_overall: score,
  score_smoothness: score,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  ...patch,
});

describe('advanced open-source features', () => {
  it('summarizes motion samples and detects possible crash incidents', () => {
    const now = Date.now();
    const samples = [
      { ax: 0, ay: 0, az: 9.8, alpha: 0, beta: 0, gamma: 0, timestamp: new Date(now - 2000).toISOString() },
      { ax: 26, ay: 1, az: 9.8, alpha: 120, beta: 80, gamma: 40, timestamp: new Date(now - 1000).toISOString() },
      { ax: 0, ay: 0, az: 9.8, alpha: 0, beta: 0, gamma: 0, timestamp: new Date(now).toISOString() },
    ];
    const points = [
      { lat: 43.65, lng: -79.38, speed_kmh: 45, timestamp: new Date(now - 12000).toISOString() },
      { lat: 43.6501, lng: -79.38, speed_kmh: 0, timestamp: new Date(now - 10000).toISOString() },
      { lat: 43.6501, lng: -79.38, speed_kmh: 0, timestamp: new Date(now).toISOString() },
    ];
    expect(buildSensorFusionSummary(samples, points).impact_like_count).toBeGreaterThan(0);
    expect(detectCrashIncident({ routePoints: points, motionSamples: samples })?.type).toBe('possible_crash');
  });

  it('adds sensor confirmation to driving events', () => {
    const timestamp = new Date().toISOString();
    const events = [{ type: 'harsh_brake', timestamp }];
    const enriched = enrichEventsWithSensorContext(events, [{ ax: 15, ay: 0, az: 9.8, timestamp }]);
    expect(enriched[0].sensor_confirmed).toBe(true);
  });

  it('reports motion sensor support for permission checks', () => {
    expect(['granted', 'not_requested', 'unavailable']).toContain(getMotionSensorSupport().status);
  });

  it('parses common OBD-II PID responses', () => {
    expect(parseObdPidResponse('41 0C 1A F8')?.value).toBe(1726);
    expect(parseObdPidResponse('41 11 80')?.label).toBe('Throttle');
  });

  it('scores unusual trips against a local driver model', () => {
    const normal = Array.from({ length: 10 }, (_, index) => trip(90, index));
    const model = buildOnDeviceDriverModel(normal);
    const anomaly = scoreTripAnomaly(trip(45, 11, { harsh_brakes_count: 6, rapid_accel_count: 4 }), model);
    expect(anomaly.anomaly_score).toBeGreaterThan(40);
    expect(anomaly.reasons.length).toBeGreaterThan(0);
  });

  it('does not treat missing anomaly score dimensions as poor values', () => {
    const normal = Array.from({ length: 10 }, (_, index) => trip(90, index, {
      score_overall: null,
      score_smoothness: null,
    }));
    const model = buildOnDeviceDriverModel(normal);
    const anomaly = scoreTripAnomaly(trip(null, 11, { score_smoothness: null }), model);

    expect(model.features.score).toBeUndefined();
    expect(model.features.smoothness).toBeUndefined();
    expect(anomaly.reasons).not.toContain('score');
    expect(anomaly.reasons).not.toContain('smoothness');
  });

  it('includes repeated event areas in historical context risk', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(80, 1)],
      currentLocation: { lat: 43.65, lng: -79.38 },
      dangerZones: [{ id: 'dz1', lat: 43.6501, lng: -79.3801, riskLevel: 'high' }],
    });
    expect(risk.nearbyDangerZoneCount).toBe(1);
    expect(risk.dangerZoneRisk).toBe(9);
    expect(risk.primaryFactor).toBe('Repeated driving-event areas nearby (1 area within 2 km)');
  });

  it('caps dense repeated-area contribution without pinning context risk to 100', () => {
    const dangerZones = Array.from({ length: 15 }, (_, index) => ({
      id: `dz${index}`,
      lat: 43.65 + index * 0.00001,
      lng: -79.38,
      riskLevel: 'high',
    }));

    const risk = estimatePredictiveRouteRisk({
      trips: [trip(80, 1)],
      currentLocation: { lat: 43.65, lng: -79.38 },
      dangerZones,
      now: new Date(2026, 0, 10, 12),
    });

    expect(risk.nearbyDangerZoneCount).toBe(15);
    expect(risk.dangerZoneRisk).toBeLessThanOrEqual(30);
    expect(risk.riskScore).toBeLessThan(100);
    expect(risk.primaryFactor).toBe('Repeated driving-event areas nearby (15 areas within 2 km)');
  });

  it('uses the newest completed trips for historical context risk even when input is unsorted', () => {
    const oldExcellentTrips = Array.from({ length: 20 }, (_, index) => trip(100, index, {
      start_time: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
    }));
    const newerPoorTrips = Array.from({ length: 20 }, (_, index) => trip(20, index, {
      startTime: new Date(Date.UTC(2026, 1, index + 1, 12)).toISOString(),
      start_time: undefined,
    }));

    const risk = estimatePredictiveRouteRisk({
      trips: [...oldExcellentTrips, ...newerPoorTrips],
      now: new Date(2026, 0, 10, 12),
    });

    expect(risk.riskScore).toBe(28);
  });

  it('gates tiny trips out of predictive event-density risk and uses eligible distance', () => {
    const baseTrip = trip(90, 1, { distance_km: 1, harsh_brakes_count: 1 });
    const withBase = estimatePredictiveRouteRisk({
      trips: [baseTrip],
      now: new Date(2026, 0, 10, 12),
    });
    const withTinyTrip = estimatePredictiveRouteRisk({
      trips: [baseTrip, trip(90, 2, { distance_km: 0.2, harsh_brakes_count: 10 })],
      now: new Date(2026, 0, 10, 12),
    });
    const withMoreEligibleDistance = estimatePredictiveRouteRisk({
      trips: [trip(90, 1, { distance_km: 2, harsh_brakes_count: 1 })],
      now: new Date(2026, 0, 10, 12),
    });

    expect(withTinyTrip.riskScore).toBe(withBase.riskScore);
    expect(withMoreEligibleDistance.riskScore).toBeLessThan(withBase.riskScore);
  });

  it('exposes provisional route-risk normalization saturation and component contributions', () => {
    expect(ROUTE_RISK_CONSTANTS.EVENT_DENSITY_MAX_EVENTS_PER_KM).toBe(5);
    expect(ROUTE_RISK_CONSTANTS.DANGER_ZONE_SATURATION_COUNT).toBe(5);

    const dangerZones = Array.from({ length: 5 }, (_, index) => ({
      id: `zone-${index}`,
      lat: 43.65 + index * 0.00001,
      lng: -79.38,
      riskLevel: 'high',
    }));
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(90, 1, { distance_km: 1, harsh_brakes_count: 5 })],
      currentLocation: { lat: 43.65, lng: -79.38 },
      dangerZones,
      now: new Date(2026, 0, 10, 12),
    });
    const events = risk.componentBreakdown.find((component) => component.key === 'events');
    const zones = risk.componentBreakdown.find((component) => component.key === 'zones');

    expect(events).toMatchObject({ normalizedRisk: 100, contribution: 25 });
    expect(zones).toMatchObject({ normalizedRisk: 100, contribution: 15 });
  });

  it('withholds historical context risk until completed distance exists', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [],
      now: new Date(2026, 0, 10, 12),
    });

    expect(risk).toMatchObject({
      status: 'insufficient_history',
      insufficientHistory: true,
      riskScore: null,
      riskLevel: null,
      primaryFactor: 'Not enough driving history',
      componentBreakdown: [],
    });
    expect(ROUTE_RISK_CONSTANTS.DEFAULT_AVG_SCORE).toBeUndefined();
  });

  it('withholds historical context risk when completed distance has no scored baseline', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(null, 1, { distance_km: 12, harsh_brakes_count: 5 })],
      now: new Date(2026, 0, 10, 12),
    });

    expect(risk).toMatchObject({
      status: 'insufficient_history',
      insufficientHistory: true,
      riskScore: null,
      riskLevel: null,
      primaryFactor: 'Not enough scored driving history',
      componentBreakdown: [],
    });
  });

  it('excludes unverified current or legacy brake-turn alerts from context risk', () => {
    const withHarshBrakes = estimatePredictiveRouteRisk({
      trips: [trip(90, 1, { distance_km: 1, harsh_brakes_count: 2 })],
      now: new Date(2026, 0, 10, 12),
    });
    const withEstimatedAlerts = estimatePredictiveRouteRisk({
      trips: [trip(90, 1, { distance_km: 1, close_proximity_count: 2 })],
      now: new Date(2026, 0, 10, 12),
    });
    const withLegacyAlerts = estimatePredictiveRouteRisk({
      trips: [trip(90, 1, { distance_km: 1, near_miss_count: 2 })],
      now: new Date(2026, 0, 10, 12),
    });

    expect(withEstimatedAlerts.riskScore).toBeLessThan(withHarshBrakes.riskScore);
    expect(withLegacyAlerts.riskScore).toBeLessThan(withHarshBrakes.riskScore);
  });

  it('clamps weather risk before applying predictive weighting', () => {
    const normalWeather = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
      weatherRiskScore: 100,
      now: new Date(2026, 0, 10, 12),
    });
    const invalidWeather = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
      weatherRiskScore: 1000,
      now: new Date(2026, 0, 10, 12),
    });
    expect(invalidWeather.riskScore).toBe(normalWeather.riskScore);
  });

  it('marks unavailable weather separately from low-risk weather', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
      weatherRiskScore: null,
      now: new Date(2026, 0, 10, 12),
    });
    const weather = risk.componentBreakdown.find((component) => component.key === 'weather');

    expect(weather).toMatchObject({
      detail: 'Unavailable',
      normalizedRisk: null,
      contribution: 0,
    });
  });

  it('does not describe late-night route timing as acceptable', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 0, 45));
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
    });

    expect(risk.safestWindow).toContain('Late night is higher risk');
    vi.useRealTimers();
  });

  it('recommends a personal safer window when hourly risk is calibrated', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
      now: new Date(2026, 0, 10, 0, 45),
      habitProfile: {
        confidence: 0.6,
        allTimeAvgScore: 85,
        hourlyRisk: {
          0: { riskScore: 80, tripCount: 3 },
          1: { riskScore: 70, tripCount: 3 },
          2: { riskScore: 50, tripCount: 3 },
          3: { riskScore: 10, tripCount: 3 },
          4: { riskScore: 20, tripCount: 3 },
          5: { riskScore: 30, tripCount: 3 },
        },
      },
    });

    expect(risk.safestWindow).toContain('3:00 AM');
  });

  it('uses generic safer-window copy when the best hour has sparse evidence', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(90, 1)],
      now: new Date(2026, 0, 10, 0, 45),
      habitProfile: {
        confidence: 0.6,
        allTimeAvgScore: 85,
        hourlyRisk: {
          0: { riskScore: 80, tripCount: 2 },
          1: { riskScore: 70, tripCount: 2 },
          2: { riskScore: 50, tripCount: 2 },
          3: { riskScore: 10, tripCount: 2 },
          4: { riskScore: 20, tripCount: 2 },
          5: { riskScore: 30, tripCount: 2 },
        },
      },
    });

    expect(ROUTE_RISK_CONSTANTS.MIN_PERSONAL_WINDOW_TRIP_COUNT).toBe(3);
    expect(risk.safestWindow).toBe('Lower-risk hours vary; see your trip history for patterns.');
  });

  it('builds a local weekly coaching sentence without AI services', () => {
    const summary = buildWeeklyCoachSummary([
      trip(75, 1, { harsh_brakes_count: 2, road_type: 'urban', duration_seconds: 1200 }),
      trip(78, 2, { harsh_brakes_count: 1, road_type: 'urban', duration_seconds: 1100 }),
      trip(85, 3),
    ]);
    expect(summary.headline.toLowerCase()).toContain('late braking');
    expect(summary.insight).toContain('No AI service');
  });

  it('withholds weekly coaching when completed trips have no valid scored distance', () => {
    const summary = buildWeeklyCoachSummary([
      trip(null, 1, { distance_km: 10, score_overall: null }),
      trip(null, 2, { distance_km: 10, score_overall: null }),
      trip(null, 3, { distance_km: 10, score_overall: null }),
    ]);

    expect(summary.confidence).toBe('unavailable');
    expect(summary.headline).toContain('waiting for scored driving distance');
    expect(summary.insight).toContain('No AI service was used');
  });
});

describe('buildHabitProfile', () => {
  it('returns safe defaults for an empty trips array', () => {
    const profile = buildHabitProfile([]);

    expect(profile.confidence).toBe(0);
    expect(profile.fatigueOnsetMinutes).toBe(90);
    expect(Object.values(profile.timeBuckets).every((bucket) => bucket.insufficient)).toBe(true);
  });

  it('marks all time buckets insufficient with four spread-out trips', () => {
    const trips = [
      trip(90, 1, { start_time: new Date(2026, 0, 1, 6).toISOString() }),
      trip(90, 2, { start_time: new Date(2026, 0, 2, 13).toISOString() }),
      trip(90, 3, { start_time: new Date(2026, 0, 3, 18).toISOString() }),
      trip(90, 4, { start_time: new Date(2026, 0, 4, 23).toISOString() }),
    ];
    const profile = buildHabitProfile(trips);

    expect(profile.confidence).toBeLessThan(0.3);
    expect(Object.values(profile.timeBuckets).every((bucket) => bucket.insufficient)).toBe(true);
  });

  it('calibrates night risk from thirty night trips', () => {
    const scores = Array.from({ length: 30 }, (_, index) => 70 + (index % 3) * 5);
    const trips = scores.map((score, index) => trip(score, index, {
      start_time: new Date(2026, 0, index + 1, 23).toISOString(),
    }));
    const profile = buildHabitProfile(trips);
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;

    expect(profile.confidence).toBe(1);
    expect(profile.timeBuckets.Night.insufficient).toBe(false);
    expect(profile.timeBuckets.Night.riskScore).toBe(Math.round(100 - mean));
  });

  it('calculates trendRisk from the most recent twenty trips', () => {
    const trips = Array.from({ length: 25 }, (_, index) => trip(index < 5 ? 50 : 90, index, {
      start_time: new Date(2026, 0, index + 1, 12).toISOString(),
    }));
    const profile = buildHabitProfile(trips);

    expect(profile.recentAvgScore).toBe(90);
    expect(profile.allTimeAvgScore).toBe(82);
    expect(profile.trendRisk).toBe(10);
  });

  it('detects fatigue onset when scores drop after cumulative daily driving', () => {
    const trips = Array.from({ length: 10 }, (_, index) => {
      const day = index + 1;
      return [
        trip(95, index * 2, {
          start_time: new Date(2026, 0, day, 8).toISOString(),
          end_time: new Date(2026, 0, day, 8, 30).toISOString(),
          duration_seconds: 30 * 60,
        }),
        trip(70, index * 2 + 1, {
          start_time: new Date(2026, 0, day, 9).toISOString(),
          end_time: new Date(2026, 0, day, 9, 45).toISOString(),
          duration_seconds: 45 * 60,
        }),
      ];
    }).flat();
    const profile = buildHabitProfile(trips);

    expect(profile.fatigueOnsetMinutes).toBeGreaterThanOrEqual(60);
    expect(profile.fatigueOnsetMinutes).toBeLessThanOrEqual(75);
  });
});
