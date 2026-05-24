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
      route_points: Array.from({ length: 20 }, (_, index) => p(index)),
      fatigue_heatmap: {
        segments: Array.from({ length: 20 }, (_, index) => ({
          start_index: index,
          end_index: index,
          score: index < 7 ? 80 : index < 14 ? 50 : 20,
        })),
      },
    };
    const result = buildFatigueHeatmapData(trip);
    expect(result).toHaveLength(20);
    expect(result.at(-1).fatigueLevel).toBeGreaterThan(result[0].fatigueLevel);
  });

  it('uses boundary colors for high fatigue', () => {
    const result = buildFatigueHeatmapData({
      route_points: Array.from({ length: 20 }, (_, index) => p(index)),
      fatigue_heatmap: {
        segments: Array.from({ length: 20 }, (_, index) => ({ start_index: index, end_index: index, score: 30 })),
      },
    });
    expect(result[0].color).toBe('#ef4444');
  });

  it('sorts heatmap entries by minute offset', () => {
    const result = buildFatigueHeatmapData({
      route_points: Array.from({ length: 20 }, (_, index) => p(index)),
      fatigue_heatmap: {
        segments: Array.from({ length: 20 }, (_, index) => ({ start_index: 19 - index, end_index: 19 - index, score: 50 })),
      },
    });
    expect(result[0].minuteOffset).toBeLessThan(result[1].minuteOffset);
  });

  it('suppresses heatmaps with fewer than 20 segments', () => {
    expect(buildFatigueHeatmapData({
      route_points: Array.from({ length: 19 }, (_, index) => p(index)),
      fatigue_progression: Array.from({ length: 19 }, (_, index) => ({ start_index: index, end_index: index, score: 70 })),
    })).toEqual([]);
  });
});
