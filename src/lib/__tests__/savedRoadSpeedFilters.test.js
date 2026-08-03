import { describe, expect, it } from 'vitest';
import {
  matchesSavedRoadSpeedFilter,
  savedRoadSpeedSearchText,
  sortSavedRoadSpeedRows,
} from '@/lib/savedRoadSpeedFilters';

const posted = {
  appliedAt: '2026-07-20T12:00:00Z',
  geohash: 'f2mxyz',
  limitKmh: 50,
  roadName: 'County Road 12',
  source: 'user_confirmed_posted_sign',
};
const estimate = {
  appliedAt: '2026-07-24T12:00:00Z',
  directionMode: 'forward',
  expiresAt: '2026-08-01T00:00:00Z',
  geohash: 'f2mabc',
  limitKmh: 80,
  roadName: 'Airport Parkway',
  source: 'user_entered_estimate',
};

describe('saved road speed filters', () => {
  it('searches real road, source, speed, note, and conflict evidence fields', () => {
    const search = savedRoadSpeedSearchText(
      { ...posted, note: 'School zone sign' },
      { observedLimitKmh: 60 },
    );

    expect(search).toContain('county road 12');
    expect(search).toContain('school zone sign');
    expect(search).toContain('user_confirmed_posted_sign');
    expect(search).toContain('50');
    expect(search).toContain('60');
  });

  it('preserves every existing filter rule', () => {
    expect(matchesSavedRoadSpeedFilter(posted, null, 'posted')).toBe(true);
    expect(matchesSavedRoadSpeedFilter(posted, null, 'estimates')).toBe(false);
    expect(matchesSavedRoadSpeedFilter(estimate, null, 'timeRules')).toBe(true);
    expect(matchesSavedRoadSpeedFilter(estimate, null, 'expiring')).toBe(true);
    expect(matchesSavedRoadSpeedFilter({ ...posted, historicalVersion: true }, null, 'historical')).toBe(true);
    expect(matchesSavedRoadSpeedFilter(posted, null, 'historical')).toBe(false);
    expect(matchesSavedRoadSpeedFilter(posted, { deltaKmh: 10 }, 'conflicts')).toBe(true);
    expect(matchesSavedRoadSpeedFilter(posted, null, 'all')).toBe(true);
  });

  it('sorts the same live rows by road, speed, impact, and update time', () => {
    const items = [
      { row: estimate, conflict: { deltaKmh: 5 } },
      { row: posted, conflict: { deltaKmh: 20 } },
    ];

    expect(sortSavedRoadSpeedRows(items, 'road')[0].row).toBe(estimate);
    expect(sortSavedRoadSpeedRows(items, 'limit')[0].row).toBe(posted);
    expect(sortSavedRoadSpeedRows(items, 'impact')[0].row).toBe(posted);
    expect(sortSavedRoadSpeedRows(items, 'updated')[0].row).toBe(estimate);
  });
});
