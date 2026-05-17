import { describe, expect, it } from 'vitest';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { parseObdPidResponse } from '@/lib/obdBluetooth';
import { buildSensorFusionSummary, detectCrashIncident, enrichEventsWithSensorContext, getMotionSensorSupport } from '@/lib/sensorFusionModel';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
import { buildWeeklyCoachSummary } from '@/lib/weeklyCoaching';

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
