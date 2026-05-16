import { describe, expect, it } from 'vitest';
import { buildFatigueHeatmapData } from '@/lib/tripInsights';

const p = (index) => ({
  lat: 43.65 + index * 0.001,
  lng: -79.38,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, index, 0)).toISOString(),
});

describe('fatigue heatmap data', () => {
  it('handles missing fatigue progression', () => {
    expect(buildFatigueHeatmapData({ route_points: [] })).toEqual([]);
  });

  it('handles a single route point', () => {
    expect(buildFatigueHeatmapData({ route_points: [p(0)], fatigue_progression: [] })).toEqual([]);
  });

  it('builds deterministic heatmap entries', () => {
    const trip = {
      route_points: Array.from({ length: 9 }, (_, index) => p(index)),
      fatigue_progression: [
        { start_index: 0, end_index: 2, score: 80 },
        { start_index: 3, end_index: 5, score: 50 },
        { start_index: 6, end_index: 8, score: 20 },
      ],
    };
    const result = buildFatigueHeatmapData(trip);
    expect(result).toHaveLength(3);
    expect(result[2].fatigueLevel).toBeGreaterThan(result[0].fatigueLevel);
  });

  it('uses boundary colors for high fatigue', () => {
    const result = buildFatigueHeatmapData({
      route_points: Array.from({ length: 3 }, (_, index) => p(index)),
      fatigue_progression: [{ start_index: 0, end_index: 2, score: 30 }],
    });
    expect(result[0].color).toBe('#ef4444');
  });

  it('sorts heatmap entries by minute offset', () => {
    const result = buildFatigueHeatmapData({
      route_points: Array.from({ length: 6 }, (_, index) => p(index)),
      fatigue_progression: [{ start_index: 4, end_index: 5, score: 50 }, { start_index: 0, end_index: 1, score: 90 }],
    });
    expect(result[0].minuteOffset).toBeLessThan(result[1].minuteOffset);
  });
});
