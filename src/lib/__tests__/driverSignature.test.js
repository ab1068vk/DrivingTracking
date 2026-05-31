import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDriverSignature } from '@/lib/tripInsights';

const trip = (index, overrides = {}) => ({
  id: `trip-${index}`,
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  aggressive_driving_score: 90,
  score_smoothness: 85,
  score_eco: 80,
  avg_speed_kmh: 55,
  braking_efficiency_score: 85,
  score_overall: 85,
  ...overrides,
});

describe('driver signature', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for no trips', () => {
    expect(buildDriverSignature([])).toBeNull();
  });

  it('returns null for fewer than five trips', () => {
    expect(buildDriverSignature([trip(0), trip(1), trip(2), trip(3)])).toBeNull();
  });

  it('builds a deterministic eco-conscious signature', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index)));
    expect(result.archetype).toBe('eco_conscious');
    expect(result.trip_count_used).toBe(6);
  });

  it('leaves braking style unavailable without braking evidence', () => {
    const result = buildDriverSignature(Array.from({ length: 5 }, (_, index) => trip(index, {
      braking_efficiency_score: null,
    })));

    expect(result.dimensions.brakingStyle).toBeNull();
    expect(result.braking_confidence).toBe(0);
  });

  it('requires three scored braking trips before exposing braking style', () => {
    const result = buildDriverSignature(Array.from({ length: 5 }, (_, index) => trip(index, {
      braking_efficiency_score: index < 2 ? 80 : null,
    })));
    const thresholdResult = buildDriverSignature(Array.from({ length: 5 }, (_, index) => trip(index, {
      braking_efficiency_score: index < 3 ? 80 : null,
    })));

    expect(result.dimensions.brakingStyle).toBeNull();
    expect(result.braking_confidence).toBe(0.2);
    expect(thresholdResult.dimensions.brakingStyle).toBe(0.8);
    expect(thresholdResult.braking_confidence).toBe(0.3);
  });

  it('averages only observed braking trips and reports confidence', () => {
    const result = buildDriverSignature(Array.from({ length: 10 }, (_, index) => trip(index, {
      braking_efficiency_score: 80,
    })));

    expect(result.dimensions.brakingStyle).toBeCloseTo(0.8);
    expect(result.braking_confidence).toBe(1);
  });

  it('bases braking confidence on recent braking evidence only', () => {
    vi.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));

    const recentWithoutBraking = Array.from({ length: 10 }, (_, index) => trip(index, {
      start_time: new Date(Date.UTC(2026, 4, 27 - index)).toISOString(),
      braking_efficiency_score: null,
    }));
    const staleWithBraking = Array.from({ length: 10 }, (_, index) => trip(index + 20, {
      start_time: new Date(Date.UTC(2026, 0, 10 - index)).toISOString(),
      braking_efficiency_score: 80,
    }));

    const result = buildDriverSignature([...recentWithoutBraking, ...staleWithBraking]);

    expect(result.dimensions.brakingStyle).toBeNull();
    expect(result.braking_confidence).toBe(0);
  });

  it('classifies aggressive commuter boundary patterns', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index, {
      aggressive_driving_score: 35,
      avg_speed_kmh: 95,
      distance_km: 5,
      speeding_events_count: 3,
      score_smoothness: 60,
    })));
    expect(result.archetype).toBe('aggressive_commuter');
  });

  it('leaves missing score-derived dimensions unavailable instead of treating them as poor', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index, {
      aggressive_driving_score: null,
      score_smoothness: null,
      score_eco: null,
      score_overall: null,
    })));

    expect(result.dimensions.aggression).toBeNull();
    expect(result.dimensions.smoothness).toBeNull();
    expect(result.dimensions.ecoMindedness).toBeNull();
    expect(result.dimensions.consistencyIdx).toBeNull();
    expect(result.archetype).toBe('balanced');
  });

  it('adds OBD-backed powertrain stress when engine telemetry exists', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index, {
      engine_stress_score: 70,
      obd_powertrain_sample_count: 20,
    })));

    expect(result.dimensions.powertrainStress).toBe(0.3);
  });

  it('detects an increasing aggression style shift', () => {
    const trips = [
      ...Array.from({ length: 5 }, (_, index) => trip(index + 15, { aggressive_driving_score: 45 })),
      ...Array.from({ length: 15 }, (_, index) => trip(index, { aggressive_driving_score: 95 })),
    ];
    expect(buildDriverSignature(trips).style_shifts.some((shift) => shift.dimension === 'aggression')).toBe(true);
  });
});
