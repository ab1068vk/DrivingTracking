import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  EVENT_TYPES,
  calculateSpeedLimitCompliance,
  calculateTripScores,
} from '@/lib/tripEngine';
import { isEveningRushHour, isMorningRushHour } from '@/lib/appConstants';
import { scoringValue } from '@/lib/scoringConstants';
import { explainTripScoreDrivers } from '@/lib/scoring/scoreExplainer';

/**
 * Regressions for the scoring-pipeline audit defects. Each test pins the concrete failure
 * case that motivated the fix, so a future refactor that reintroduces the defect fails here
 * rather than silently shifting every user's scores.
 */

const NIGHT_HOUR_UTC = 3; // inside the fixed 22:00-04:59 night window and the 02:00-04:59 deep-night band.

const nightRoute = (pointCount, metresPerStep) => Array.from({ length: pointCount }, (_, index) => ({
  lat: 43.65 + (index * metresPerStep) / 111_320,
  lng: -79.38,
  speed_kmh: 60,
  accuracy: 8,
  heading: 0,
  timestamp: new Date(Date.UTC(2026, 0, 1, NIGHT_HOUR_UTC, 0, index * 10)).toISOString(),
  utc_offset_minutes: 0,
}));

const scoreNightTrip = (distanceKm, pointCount) => calculateTripScores(
  [],
  { distance_km: distanceKm, duration_seconds: pointCount * 10, fatigue_risk_score: 0 },
  nightRoute(pointCount, (distanceKm * 1000) / (pointCount - 1)),
  { ...DEFAULT_THRESHOLDS, NIGHT_DETECTION_MODE: 'fixed', PHONE_USE_AFFECTS_SCORE: false },
  pointCount * 10,
  {},
  { includeRoadTypeSegments: false }
);

describe('A1: night-driving penalty is distance-independent', () => {
  it('scores identical all-night driving the same at 1 km and at 40 km', () => {
    const short = scoreNightTrip(1, 20);
    const long = scoreNightTrip(40, 20);

    // Before the fix the same behaviour scored 0 over 1 km and 88 over 40 km, because the
    // already point-count-normalized night ratio was fed through the per-km normalizer.
    expect(Math.abs(short.score_safety - long.score_safety)).toBeLessThanOrEqual(1);
  });

  it('never deducts more than the registered night cap', () => {
    const daytimeRoute = nightRoute(20, 50).map((routePoint, index) => ({
      ...routePoint,
      timestamp: new Date(Date.UTC(2026, 0, 1, 13, 0, index * 10)).toISOString(),
    }));
    const daytime = calculateTripScores(
      [],
      { distance_km: 1, duration_seconds: 200, fatigue_risk_score: 0 },
      daytimeRoute,
      { ...DEFAULT_THRESHOLDS, NIGHT_DETECTION_MODE: 'fixed', PHONE_USE_AFFECTS_SCORE: false },
      200,
      {},
      { includeRoadTypeSegments: false }
    );
    const night = scoreNightTrip(1, 20);

    expect(daytime.score_safety - night.score_safety)
      .toBeLessThanOrEqual(scoringValue('NIGHT_SAFETY_MAX_PENALTY'));
  });
});

describe('A2: confirmed phone use is charged once', () => {
  const phoneRoute = Array.from({ length: 20 }, (_, index) => ({
    lat: 43.65 + index * 0.0045,
    lng: -79.38,
    speed_kmh: 60,
    accuracy: 8,
    heading: 0,
    timestamp: new Date(Date.UTC(2026, 0, 1, 13, 0, index * 10)).toISOString(),
    utc_offset_minutes: 0,
  }));

  const phoneUse = {
    phone_use_events: [{
      type: EVENT_TYPES.PHONE_USE,
      severity: 'high',
      source: 'android_usage_access',
      confidence: 0.9,
      speed_kmh: 60,
      duration_seconds: 40,
      timestamp: phoneRoute[5].timestamp,
    }],
    phone_use_window_count: 1,
    phone_use_total_seconds: 40,
    phone_use_high_confidence_count: 1,
    phone_use_risk: 'medium',
    phone_use_score: 80,
    phone_use_score_available: true,
    phone_use_score_status: 'android_usage_access',
    phone_use_pct_of_trip: 20,
    phone_proxy_events: [],
    phone_proxy_count: 0,
    phone_proxy_risk: 'none',
    data_sources: ['android_usage_access'],
  };

  const scoreWithEvents = (events) => calculateTripScores(
    events,
    { distance_km: 10, duration_seconds: 200, fatigue_risk_score: 0 },
    phoneRoute,
    { ...DEFAULT_THRESHOLDS, NIGHT_DETECTION_MODE: 'fixed' },
    200,
    phoneUse,
    { includeRoadTypeSegments: false }
  );

  it('does not let a single confirmed window drive base Safety to the floor', () => {
    const withEvent = scoreWithEvents([{
      type: EVENT_TYPES.PHONE_USE,
      severity: 'high',
      source: 'android_usage_access',
      speed_kmh: 60,
      timestamp: phoneRoute[5].timestamp,
    }]);
    const withoutEvent = scoreWithEvents([]);

    // The window reaches Safety exactly once, through the weighted phone-use component,
    // so passing the same window as a scoring event as well must not change the score.
    expect(withEvent.score_safety).toBe(withoutEvent.score_safety);
    // Previously: safetyPenalty 65 over 10 km drove baseSafety to 0 while the phone-use
    // component read 80, and the two were blended as independent evidence to give 22.
    expect(withEvent.score_safety).toBeGreaterThan(22);
  });
});

describe('A3: compliance reflects how much of a trip was spent speeding', () => {
  const complianceRoute = (speedingPointCount, totalPoints) => Array.from(
    { length: totalPoints },
    (_, index) => ({
      lat: 43.65 + index * 0.00018,
      lng: -79.38,
      // 10 km/h over the 50 km/h fallback urban limit plus the 5 km/h allowance.
      speed_kmh: index < speedingPointCount ? 65 : 40,
      accuracy: 8,
      heading: 0,
      timestamp: new Date(Date.UTC(2026, 0, 1, 13, 0, index * 10)).toISOString(),
      utc_offset_minutes: 0,
    })
  );

  const complianceScore = (speedingPointCount, totalPoints) => calculateSpeedLimitCompliance(
    complianceRoute(speedingPointCount, totalPoints),
    Array.from({ length: totalPoints }, () => 'urban'),
    [],
    DEFAULT_THRESHOLDS
  ).overall_compliance_score;

  it('separates a driver who speeds once from a driver who speeds throughout', () => {
    const occasional = complianceScore(1, 100);
    const persistent = complianceScore(99, 100);

    // Both exceed the limit by the same amount, so before the fix - which divided by the
    // count of over-limit points only - these scored identically.
    expect(occasional).toBeGreaterThan(persistent);
  });

  it('scores a fully compliant trip at 100', () => {
    expect(complianceScore(0, 100)).toBe(100);
  });

  it('still reports mean over-limit severity separately from the score', () => {
    const result = calculateSpeedLimitCompliance(
      complianceRoute(1, 100),
      Array.from({ length: 100 }, () => 'urban'),
      [],
      DEFAULT_THRESHOLDS
    );
    const bucket = result.urban_compliance;

    expect(bucket.over_limit_point_count).toBe(1);
    expect(bucket.over_limit_severity).toBeGreaterThan(0);
    expect(bucket.score).toBeGreaterThan(100 - bucket.over_limit_severity);
  });
});

describe('A10: rush-hour windows are half-open on both ends', () => {
  it('excludes the end hour for morning and evening alike', () => {
    expect(isMorningRushHour(8)).toBe(true);
    expect(isMorningRushHour(9)).toBe(false);
    expect(isEveningRushHour(18)).toBe(true);
    expect(isEveningRushHour(19)).toBe(false);
  });
});

describe('A11: score drivers do not report one behaviour twice', () => {
  it('suppresses the event row when its component already appears', () => {
    const drivers = explainTripScoreDrivers({
      component_scores: {
        cornering_consistency: { value: 55, evidence: 'high' },
        smoothness_index: { value: 60, evidence: 'high' },
      },
      sharp_turns_count: 5,
      rapid_accel_count: 4,
    }, { limit: 4 });

    const factors = drivers.map(({ factor }) => factor);
    expect(factors).toContain('cornering_consistency');
    expect(factors).not.toContain('sharp_turns_count');
    expect(factors).not.toContain('rapid_accel_count');
  });
});
