import { describe, expect, it, vi } from 'vitest';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { parseObdPidResponse } from '@/lib/obdBluetooth';
import { buildSensorFusionSummary, detectCrashIncident, enrichEventsWithSensorContext, getMotionSensorSupport } from '@/lib/sensorFusionModel';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
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

  it('includes known danger zones in predictive route risk', () => {
    const risk = estimatePredictiveRouteRisk({
      trips: [trip(80, 1)],
      currentLocation: { lat: 43.65, lng: -79.38 },
      dangerZones: [{ id: 'dz1', lat: 43.6501, lng: -79.3801, riskLevel: 'high' }],
    });
    expect(risk.nearbyDangerZoneCount).toBe(1);
    expect(risk.primaryFactor).toBe('Known danger zones nearby');
  });

  it('uses the newest completed trips for predictive route risk even when input is unsorted', () => {
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

    expect(risk.riskScore).toBe(36);
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
          0: { riskScore: 80, tripCount: 2 },
          1: { riskScore: 70, tripCount: 2 },
          2: { riskScore: 50, tripCount: 2 },
          3: { riskScore: 10, tripCount: 2 },
          4: { riskScore: 20, tripCount: 2 },
          5: { riskScore: 30, tripCount: 2 },
        },
      },
    });

    expect(risk.safestWindow).toContain('3:00 AM');
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
