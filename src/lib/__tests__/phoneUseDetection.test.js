import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, detectPhoneUseWindows } from '@/lib/tripEngine';

const baseTime = Date.UTC(2026, 0, 1, 12, 0, 0);

const straightPoint = (index, speed = 60) => ({
  lat: 43.65 + index * 0.00015,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(baseTime + index * 1000).toISOString(),
});

function oscillationBlock(startIndex, count = 14, speed = 70, amplitude = 0.000015) {
  return Array.from({ length: count }, (_, offset) => ({
    lat: 43.65 + (startIndex + offset) * 0.00015,
    lng: -79.38 + (offset % 2 === 0 ? -amplitude : amplitude),
    speed_kmh: speed,
    timestamp: new Date(baseTime + (startIndex + offset) * 1000).toISOString(),
  }));
}

describe('phone use detection', () => {
  it('handles empty route points', () => {
    const result = detectPhoneUseWindows([]);
    expect(result.phone_use_events).toEqual([]);
    expect(result.phone_use_risk).toBe('none');
  });

  it('does not flag a straight constant-speed trip', () => {
    const result = detectPhoneUseWindows(Array.from({ length: 30 }, (_, index) => straightPoint(index)));
    expect(result.phone_use_events).toEqual([]);
    expect(result.phone_use_risk).toBe('none');
  });

  it('detects injected micro-steer oscillations', () => {
    const result = detectPhoneUseWindows(oscillationBlock(0), {
      ...DEFAULT_THRESHOLDS,
      PHONE_CONFIDENCE_THRESHOLD: 0.35,
    });

    expect(result.phone_use_window_count).toBeGreaterThanOrEqual(1);
    expect(result.phone_use_events[0].confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.phone_use_events[0].signals_triggered).toContain('micro_steer');
  });

  it('merges two windows separated by a brief gap', () => {
    const points = [
      ...oscillationBlock(0, 12),
      ...Array.from({ length: 5 }, (_, index) => straightPoint(12 + index, 70)),
      ...oscillationBlock(17, 12),
    ];
    const result = detectPhoneUseWindows(points, {
      ...DEFAULT_THRESHOLDS,
      PHONE_CONFIDENCE_THRESHOLD: 0.30,
    });

    expect(result.phone_use_window_count).toBe(1);
    expect(result.phone_use_events[0].durationS).toBeGreaterThan(15);
  });

  it('discards windows shorter than the minimum duration', () => {
    const result = detectPhoneUseWindows(oscillationBlock(0, 4), {
      ...DEFAULT_THRESHOLDS,
      PHONE_MICRO_STEER_COUNT: 1,
      PHONE_CONFIDENCE_THRESHOLD: 0.05,
      PHONE_MIN_WINDOW_S: 4,
    });

    expect(result.phone_use_events).toEqual([]);
    expect(result.phone_use_risk).toBe('none');
  });

  it('grades risk from low to high based on high-confidence windows', () => {
    const low = detectPhoneUseWindows(oscillationBlock(0, 6, 45, 0.00001), {
      ...DEFAULT_THRESHOLDS,
      PHONE_MICRO_STEER_COUNT: 3,
      PHONE_COUPLING_THRESHOLD: -1,
      PHONE_LANE_DRIFT_DEG: 999,
      PHONE_CONFIDENCE_THRESHOLD: 0.15,
    });
    const high = detectPhoneUseWindows([
      ...oscillationBlock(0, 14, 90),
      ...Array.from({ length: 25 }, (_, index) => straightPoint(14 + index, 90)),
      ...oscillationBlock(39, 14, 90),
      ...Array.from({ length: 25 }, (_, index) => straightPoint(53 + index, 90)),
      ...oscillationBlock(78, 14, 90),
    ], {
      ...DEFAULT_THRESHOLDS,
      PHONE_CONFIDENCE_THRESHOLD: 0.30,
    });

    expect(low.phone_use_risk).toBe('low');
    expect(high.phone_use_high_confidence_count).toBeGreaterThanOrEqual(3);
    expect(high.phone_use_risk).toBe('high');
  });

  it('reduces score monotonically as phone use windows increase', () => {
    const one = detectPhoneUseWindows(oscillationBlock(0, 14), {
      ...DEFAULT_THRESHOLDS,
      PHONE_CONFIDENCE_THRESHOLD: 0.30,
    });
    const three = detectPhoneUseWindows([
      ...oscillationBlock(0, 14),
      ...Array.from({ length: 25 }, (_, index) => straightPoint(14 + index, 70)),
      ...oscillationBlock(39, 14),
      ...Array.from({ length: 25 }, (_, index) => straightPoint(53 + index, 70)),
      ...oscillationBlock(78, 14),
    ], {
      ...DEFAULT_THRESHOLDS,
      PHONE_CONFIDENCE_THRESHOLD: 0.30,
    });

    expect(three.phone_use_score).toBeLessThan(one.phone_use_score);
  });
});
