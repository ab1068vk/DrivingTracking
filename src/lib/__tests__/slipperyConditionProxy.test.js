import { describe, expect, it } from 'vitest';
import { detectSlipperyConditionProxy } from '@/lib/tripEngine';

const p = (index, speed, latStep = 0.00025) => ({
  lat: 43.65 + index * latStep,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 2)).toISOString(),
});

const stop = (offset, latStep = 0.00035) => [50, 40, 30, 20, 10, 4].map((speed, index) => ({
  ...p(offset + index, speed, latStep),
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, (offset + index) * 2)).toISOString(),
}));

describe('slippery condition proxy', () => {
  it('handles empty route points', () => {
    expect(detectSlipperyConditionProxy([], []).slippery_proxy).toBe('insufficient_data');
  });

  it('handles a single route point', () => {
    expect(detectSlipperyConditionProxy([p(0, 50)], []).wet_signal_count).toBe(0);
  });

  it('detects likely wet conditions from long stopping distances', () => {
    const points = [...stop(0, 0.00055), ...stop(10, 0.00055), ...stop(20, 0.00055)];
    expect(detectSlipperyConditionProxy(points, []).slippery_proxy).toBe('likely_wet');
  });

  it('grades dry stops below wet stops', () => {
    const dry = detectSlipperyConditionProxy([...stop(0, 0.00008), ...stop(10, 0.00008), ...stop(20, 0.00008)], []);
    const wet = detectSlipperyConditionProxy([...stop(0, 0.00055), ...stop(10, 0.00055), ...stop(20, 0.00055)], []);
    expect(wet.avg_distance_ratio).toBeGreaterThan(dry.avg_distance_ratio);
  });

  it('keeps same-ratio stops stable when repeated', () => {
    const three = [...stop(0, 0.00055), ...stop(10, 0.00055), ...stop(20, 0.00055)];
    const six = [...three, ...stop(30, 0.00055), ...stop(40, 0.00055), ...stop(50, 0.00055)];
    expect(Math.abs(
      detectSlipperyConditionProxy(three, []).wet_ratio -
      detectSlipperyConditionProxy(six, []).wet_ratio
    )).toBeLessThanOrEqual(0.05);
  });
});
