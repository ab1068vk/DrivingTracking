import { describe, expect, it } from 'vitest';
import { calculateOvertakeQualityScore, EVENT_TYPES } from '@/lib/tripEngine';

const p = (index, speed, heading = 0) => ({
  lat: 43.65 + index * 0.0002,
  lng: -79.38,
  speed_kmh: speed,
  heading,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

describe('overtake quality', () => {
  it('handles empty route points', () => {
    expect(calculateOvertakeQualityScore([], []).overtake_quality_score).toBeNull();
  });

  it('handles a single route point', () => {
    expect(calculateOvertakeQualityScore([p(0, 90)], []).overtake_count).toBe(0);
  });

  it('scores a deterministic overtake window', () => {
    const points = Array.from({ length: 8 }, (_, index) => p(index, 90 + Math.min(index, 3) * 4, index));
    const result = calculateOvertakeQualityScore(points, [{ type: EVENT_TYPES.LANE_CHANGE, timestamp: points[3].timestamp, speed_kmh: 95 }]);
    expect(result.overtake_count).toBe(1);
    expect(result.overtake_quality_score).toBeGreaterThan(0);
  });

  it('penalizes unsafe re-entry after an overtake', () => {
    const points = Array.from({ length: 12 }, (_, index) => p(index, 90 + Math.min(index, 3) * 5, index));
    const clean = calculateOvertakeQualityScore(points, [{ type: EVENT_TYPES.AGGRESSIVE_OVERTAKE, timestamp: points[3].timestamp, speed_kmh: 105 }]);
    const unsafe = calculateOvertakeQualityScore(points, [
      { type: EVENT_TYPES.AGGRESSIVE_OVERTAKE, timestamp: points[3].timestamp, speed_kmh: 105 },
      { type: EVENT_TYPES.HARSH_BRAKE, timestamp: points[9].timestamp },
    ]);
    expect(clean.overtake_quality_score).toBeGreaterThan(unsafe.overtake_quality_score);
  });

  it('deduplicates overlapping overtake windows', () => {
    const points = Array.from({ length: 8 }, (_, index) => p(index, 95, index));
    const result = calculateOvertakeQualityScore(points, [
      { type: EVENT_TYPES.LANE_CHANGE, timestamp: points[3].timestamp, speed_kmh: 95 },
      { type: EVENT_TYPES.AGGRESSIVE_OVERTAKE, timestamp: points[4].timestamp },
    ]);
    expect(result.overtake_count).toBe(1);
  });

  it('does not count a steady highway lane change as an overtake', () => {
    const points = Array.from({ length: 10 }, (_, index) => p(index, 95, index < 5 ? index : 10 - index));
    const result = calculateOvertakeQualityScore(points, [
      { type: EVENT_TYPES.LANE_CHANGE, timestamp: points[4].timestamp, speed_kmh: 95 },
    ]);
    expect(result.overtake_count).toBe(0);
    expect(result.overtake_quality_score).toBeNull();
  });
});
