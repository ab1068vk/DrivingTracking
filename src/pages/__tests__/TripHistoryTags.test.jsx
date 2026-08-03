import { describe, expect, it } from 'vitest';
import {
  buildTripTagCounts,
  matchesTripTags,
} from '@/pages/TripHistory';

describe('Trip History smart tag filters', () => {
  const trip = {
    tags: ['commute', 'highway', 'rain'],
  };

  it('supports match-all and match-any multi-tag filtering', () => {
    expect(matchesTripTags(trip, ['commute', 'rain'], 'all')).toBe(true);
    expect(matchesTripTags(trip, ['commute', 'snow'], 'all')).toBe(false);
    expect(matchesTripTags(trip, ['snow', 'rain'], 'any')).toBe(true);
    expect(matchesTripTags(trip, [], 'all')).toBe(true);
  });

  it('counts each tag once per trip, including custom tags', () => {
    const counts = buildTripTagCounts([
      { tags: ['commute', 'rain', 'rain'] },
      { tags: ['commute', 'client_visit'] },
    ]);

    expect(counts.get('commute')).toBe(2);
    expect(counts.get('rain')).toBe(1);
    expect(counts.get('client_visit')).toBe(1);
  });
});
