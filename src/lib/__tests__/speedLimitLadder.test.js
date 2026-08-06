import { describe, expect, it } from 'vitest';
import {
  IMPERIAL_LIMIT_LADDER_KMH,
  METRIC_LIMIT_LADDER_KMH,
  isLadderLimit,
  ladderLimitKmh,
  snapToSpeedLimitLadder,
  speedLimitLadderForSettings,
  speedLimitLadderUnits,
} from '@/lib/speed/speedLimitLadder';

describe('speed limit ladder selection', () => {
  it('follows the units setting when one is present', () => {
    expect(speedLimitLadderUnits({ units: 'imperial' })).toBe('imperial');
    expect(speedLimitLadderUnits({ units: 'metric' })).toBe('metric');
    expect(speedLimitLadderForSettings({ units: 'imperial' })).toBe(IMPERIAL_LIMIT_LADDER_KMH);
  });

  it('defaults to metric, and never infers mph from a region', () => {
    // km/h is the default and the only fallback. country_code and the
    // speed-limit lookup country exist for other purposes and must not quietly
    // switch the learner onto mph rungs.
    expect(speedLimitLadderUnits({})).toBe('metric');
    expect(speedLimitLadderUnits()).toBe('metric');
    expect(speedLimitLadderUnits({ units: '' })).toBe('metric');
    expect(speedLimitLadderUnits({ units: null })).toBe('metric');
    expect(speedLimitLadderUnits({ country_code: 'us' })).toBe('metric');
    expect(speedLimitLadderUnits({ country_code: 'gb' })).toBe('metric');
    expect(speedLimitLadderUnits({ speed_limit_default_country: 'us' })).toBe('metric');
    expect(speedLimitLadderUnits({ configurable_country_defaults: 'us' })).toBe('metric');
    expect(speedLimitLadderUnits({ units: 'nonsense' })).toBe('metric');
  });

  it('only uses mph rungs when units are explicitly imperial', () => {
    expect(speedLimitLadderUnits({ units: 'imperial' })).toBe('imperial');
    expect(speedLimitLadderUnits({ units: 'imperial', country_code: 'de' })).toBe('imperial');
    expect(speedLimitLadderForSettings({})).toBe(METRIC_LIMIT_LADDER_KMH);
  });
});

describe('snapToSpeedLimitLadder', () => {
  it('learns mph roads as mph limits instead of metric rungs', () => {
    // 35 mph = 56.3 km/h. The metric-only ladder used to learn this as 60.
    expect(ladderLimitKmh(56.3, { units: 'imperial' })).toBe(56);
    // 55 mph = 88.5 km/h, previously learned as 90.
    expect(ladderLimitKmh(88.5, { units: 'imperial' })).toBe(89);
    expect(ladderLimitKmh(40.2, { units: 'imperial' })).toBe(40);
  });

  it('still snaps metric observations onto the metric ladder', () => {
    expect(ladderLimitKmh(48, { units: 'metric' })).toBe(50);
    expect(ladderLimitKmh(78.4, { units: 'metric' })).toBe(80);
    expect(ladderLimitKmh(128, { units: 'metric' })).toBe(130);
  });

  it('refuses to answer for an observation exactly between two rungs', () => {
    const result = snapToSpeedLimitLadder(55, { units: 'metric' });
    expect(result.limitKmh).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toBe('between_rungs');
  });

  it('does not clamp an out-of-range observation onto an end rung', () => {
    // The old reduce pulled everything into [30, 120].
    const fast = snapToSpeedLimitLadder(165, { units: 'metric' });
    expect(fast.limitKmh).toBeNull();
    expect(fast.reason).toBe('outside_ladder');

    const slow = snapToSpeedLimitLadder(12, { units: 'metric' });
    expect(slow.limitKmh).toBeNull();
    expect(slow.reason).toBe('outside_ladder');
  });

  it('accepts an observation just outside the ladder but within tolerance', () => {
    expect(ladderLimitKmh(132, { units: 'metric' })).toBe(130);
    expect(ladderLimitKmh(27, { units: 'metric' })).toBe(30);
  });

  it('treats a non-speed as ambiguous rather than defaulting', () => {
    for (const value of [null, undefined, NaN, 0, -30, 'fast']) {
      const result = snapToSpeedLimitLadder(value);
      expect(result.limitKmh).toBeNull();
      expect(result.ambiguous).toBe(true);
    }
  });

  it('never returns a value that is not a rung of the chosen ladder', () => {
    for (let speed = 1; speed <= 200; speed += 0.25) {
      for (const units of ['metric', 'imperial']) {
        const { limitKmh, ambiguous } = snapToSpeedLimitLadder(speed, { units });
        if (ambiguous) {
          expect(limitKmh).toBeNull();
        } else {
          expect(isLadderLimit(limitKmh, { units })).toBe(true);
        }
      }
    }
  });

  it('honours an explicit tolerance', () => {
    expect(snapToSpeedLimitLadder(52, { units: 'metric', toleranceKmh: 1 }).limitKmh).toBeNull();
    expect(snapToSpeedLimitLadder(52, { units: 'metric', toleranceKmh: 3 }).limitKmh).toBe(50);
  });

  it('exposes ladders that are ordered and strictly increasing', () => {
    for (const ladder of [METRIC_LIMIT_LADDER_KMH, IMPERIAL_LIMIT_LADDER_KMH]) {
      for (let index = 1; index < ladder.length; index += 1) {
        expect(ladder[index]).toBeGreaterThan(ladder[index - 1]);
      }
    }
  });
});
