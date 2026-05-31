import { describe, expect, it } from 'vitest';
import { calculateBrakeOnsetSmoothness, EVENT_TYPES, scoreBrakeOnsetSmoothness } from '@/lib/tripEngine';

const p = (seconds, speed) => ({
  lat: 43.65 + seconds * 0.0002,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

const brakingSequences = (count = 5) => Array.from({ length: count }, (_, index) => {
  const offset = index * 10;
  return [p(offset, 80), p(offset + 1, 75), p(offset + 2, 60)];
}).flat();

const harshBrakeEvents = (points) => points
  .filter((_, index) => index % 3 === 2)
  .map((point) => ({ type: EVENT_TYPES.HARSH_BRAKE, timestamp: point.timestamp, speed_kmh: 60 }));

describe('brake onset smoothness', () => {
  it('stays unavailable until two braking sequences are observed', () => {
    const points = brakingSequences(1);
    expect(calculateBrakeOnsetSmoothness(points, harshBrakeEvents(points))).toMatchObject({
      brake_onset_smoothness_score: null,
      brake_onset_smoothness_confidence: 'low',
      brake_onset_sequence_count: 1,
    });
  });

  it('reports a low-confidence braking smoothness proxy after two sequences', () => {
    const points = brakingSequences(2);
    const result = calculateBrakeOnsetSmoothness(points, harshBrakeEvents(points));

    expect(result.brake_onset_sequence_count).toBe(2);
    expect(result.avg_brake_onset_ramp_seconds).toBe(2);
    expect(result.brake_onset_smoothness_score).toBeGreaterThan(0);
    expect(result.brake_onset_disclaimer).toContain('not human neurological reaction time');
  });

  it('scores a zero-duration onset as least smooth rather than reaction time', () => {
    expect(scoreBrakeOnsetSmoothness(4, 0)).toBe(0);
  });

  it('penalizes both onset rate and absolute braking severity', () => {
    expect(scoreBrakeOnsetSmoothness(6, 6)).toBe(76);
    expect(scoreBrakeOnsetSmoothness(9, 2)).toBe(24);
    expect(scoreBrakeOnsetSmoothness(600, 6)).toBe(0);
  });
});
