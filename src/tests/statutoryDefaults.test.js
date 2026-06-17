import { describe, expect, it, test } from 'vitest';

import { getRegionDefaultEstimate } from '@/lib/speedLimitSource';

// CHANGES (session):
// - Added Category C regional default estimate coverage tests for country, province, and GLOBAL fallback rows.
// - Renamed regional default estimate tests to getRegionDefaultEstimate.

describe('regional default estimates', () => {
  const cases = [
    ['CA', 'ON', 'urban', 50],
    ['CA', 'AB', 'rural', 100],
    ['US', null, 'highway', 104],
    ['GB', null, 'motorway', 112],
    ['DE', null, 'urban', 50],
    ['DE', null, 'highway', null],
    ['AU', null, 'urban', 50],
    ['FR', null, 'autoroute', 130],
    ['FR', null, 'secondary', 80],
  ];

  test.each(cases)(
    '%s/%s %s -> %s km/h',
    (country, province, context, expected) => {
      expect(getRegionDefaultEstimate(country, province, context)).toBe(expected);
    }
  );

  it('falls back to GLOBAL defaults for unknown country', () => {
    expect(getRegionDefaultEstimate('ZZ', null, 'urban')).toBe(50);
  });
});
