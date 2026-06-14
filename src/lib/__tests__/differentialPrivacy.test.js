import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDifferentialPrivacyToAggregates,
  laplace,
  noisyStat,
  PRIVACY_BUDGETS,
} from '@/lib/differentialPrivacy';

describe('differentialPrivacy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('samples calibrated Laplace noise from sensitivity and epsilon', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);

    expect(laplace(1, 0.8)).toBeCloseTo(0.866, 3);
  });

  it('clamps noised protected metrics to non-negative values', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);

    expect(noisyStat(0.1, 'distance_km')).toBe(0);
    expect(noisyStat(5, 'unknown_metric')).toBe(5);
    expect(PRIVACY_BUDGETS.phone_use_count).toMatchObject({ sensitivity: 1, epsilon: 0.8 });
  });

  it('marks aggregate noise as export-scoped', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);

    expect(applyDifferentialPrivacyToAggregates({ distance_km: 10 })).toMatchObject({
      distance_km: 10.26,
      _dpApplied: true,
      differential_privacy: {
        applied: true,
        mechanism: 'laplace',
        scope: 'export',
        noised_fields: ['distance_km'],
      },
    });
  });
});
