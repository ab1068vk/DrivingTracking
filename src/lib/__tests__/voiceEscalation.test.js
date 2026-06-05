import { beforeEach, describe, expect, it } from 'vitest';

import {
  getCurrentLevel,
  recordImprovement,
  recordOffenseAndGetLevel,
  resetAllEscalation,
} from '@/lib/voiceEscalation';

describe('voice escalation', () => {
  beforeEach(() => {
    resetAllEscalation();
  });

  it('escalates repeated offenses up to level 2', () => {
    expect(recordOffenseAndGetLevel('harsh_brake', 1_000)).toBe(0);
    expect(recordOffenseAndGetLevel('harsh_brake', 2_000)).toBe(1);
    expect(recordOffenseAndGetLevel('harsh_brake', 3_000)).toBe(2);
    expect(recordOffenseAndGetLevel('harsh_brake', 4_000)).toBe(2);
    expect(getCurrentLevel('harsh_brake')).toBe(2);
  });

  it('resets after the key-specific clean driving window', () => {
    expect(recordOffenseAndGetLevel('phone_use', 1_000)).toBe(0);
    expect(recordOffenseAndGetLevel('phone_use', 2_000)).toBe(1);

    expect(recordOffenseAndGetLevel('phone_use', 2_000 + 15 * 60_000 + 1)).toBe(0);
  });

  it('can reset a single key on improvement', () => {
    recordOffenseAndGetLevel('speeding', 1_000);
    recordOffenseAndGetLevel('speeding', 2_000);

    recordImprovement('speeding');

    expect(getCurrentLevel('speeding')).toBe(0);
    expect(recordOffenseAndGetLevel('speeding', 3_000)).toBe(0);
  });

  it('resets all escalation state at trip end', () => {
    recordOffenseAndGetLevel('speeding', 1_000);
    recordOffenseAndGetLevel('speeding', 2_000);
    recordOffenseAndGetLevel('rapid_accel', 2_000);

    resetAllEscalation();

    expect(getCurrentLevel('speeding')).toBe(0);
    expect(getCurrentLevel('rapid_accel')).toBe(0);
  });
});
