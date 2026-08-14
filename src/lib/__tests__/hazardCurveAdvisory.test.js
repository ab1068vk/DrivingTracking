/**
 * "You usually brake hard here" is a claim about a habit, so these tests pin the
 * evidence that has to exist before the app is allowed to make it — and pin that
 * the copy can only ever quote numbers the evidence actually contains.
 */
import { describe, expect, it } from 'vitest';
import { buildCurveEntryAdvisory } from '@/lib/hazard/hazardCurveAdvisory';

const segment = (overrides = {}) => ({
  lat: 45.42,
  lng: -75.69,
  tripCount: 8,
  harshCount: 4,
  totalEvents: 4,
  avgSpeed: 50,
  riskScore: 62,
  riskLevel: 'high',
  eventTypes: { harsh_brake: 4 },
  ...overrides,
});

describe('buildCurveEntryAdvisory', () => {
  it('refuses to speak from thin data', () => {
    const result = buildCurveEntryAdvisory({
      segment: segment({ tripCount: 4, harshCount: 3 }),
      approachSpeedKmh: 70,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('insufficient_passes');
  });

  it('refuses when it happened once rather than repeatedly', () => {
    const result = buildCurveEntryAdvisory({
      segment: segment({ tripCount: 8, harshCount: 1, eventTypes: { harsh_brake: 1 } }),
      approachSpeedKmh: 70,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('event_rate_below_floor');
  });

  it('stays quiet for a driver who has learned the corner', () => {
    // Approaching at or below their own typical entry speed is the signal that
    // the habit has changed. No decay logic needed.
    const result = buildCurveEntryAdvisory({ segment: segment(), approachSpeedKmh: 52 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not_faster_than_typical');
  });

  it('treats the stated floors as necessary but not sufficient', () => {
    // Exactly on both floors: 5 passes, 40%. Confidence is 0.33, so the first
    // thing said about a specific corner is never the weakest possible case.
    const result = buildCurveEntryAdvisory({
      segment: segment({ tripCount: 5, harshCount: 2, eventTypes: { harsh_brake: 2 } }),
      approachSpeedKmh: 70,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('low_confidence');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('speaks when the driver is repeatedly braking hard here and is faster than usual', () => {
    const result = buildCurveEntryAdvisory({ segment: segment(), approachSpeedKmh: 62 });
    expect(result.eligible).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.passes).toBe(8);
    expect(result.brakingPasses).toBe(4);
    expect(result.typicalEntryKmh).toBe(50);
    expect(result.overTypicalKmh).toBe(12);
    expect(result.dominantType).toBe('harsh_brake');
  });

  it('counts sharp turns at the same cell as the same story', () => {
    const result = buildCurveEntryAdvisory({
      segment: segment({ harshCount: 1, eventTypes: { harsh_brake: 1, sharp_turn: 4 } }),
      approachSpeedKmh: 62,
    });
    expect(result.eligible).toBe(true);
    expect(result.brakingPasses).toBe(5);
    expect(result.dominantType).toBe('sharp_turn');
  });

  it('never reports more braking passes than passes', () => {
    const result = buildCurveEntryAdvisory({
      segment: segment({ tripCount: 6, harshCount: 9, eventTypes: { harsh_brake: 9 } }),
      approachSpeedKmh: 70,
    });
    expect(result.brakingPasses).toBeLessThanOrEqual(result.passes);
    expect(result.harshRate).toBeLessThanOrEqual(1);
  });

  it('carries a posted limit through as evidence without gating on it', () => {
    // The corridor graph that supplies a limit is deferred, so this only has to
    // survive being absent and be reported faithfully when present.
    expect(buildCurveEntryAdvisory({ segment: segment(), approachSpeedKmh: 62 }).limitKmh).toBeNull();
    expect(buildCurveEntryAdvisory({
      segment: segment(), approachSpeedKmh: 62, limitKmh: 60,
    }).limitKmh).toBe(60);
  });

  it('handles a missing or malformed segment without throwing', () => {
    expect(buildCurveEntryAdvisory({}).reason).toBe('no_segment');
    expect(buildCurveEntryAdvisory({ segment: {}, approachSpeedKmh: 60 }).eligible).toBe(false);
    expect(buildCurveEntryAdvisory({
      segment: segment({ tripCount: 'x', harshCount: null, avgSpeed: undefined }),
      approachSpeedKmh: 60,
    }).eligible).toBe(false);
  });
});
