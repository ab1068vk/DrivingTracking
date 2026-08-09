import { describe, expect, it } from 'vitest';
import {
  SPEED_COVERAGE_TIER_ORDER,
  describeTripSpeedCoverage,
  summarizeTripSpeedCoverage,
} from '@/lib/tripSpeedCoverage';

const point = (source, limitKmh = 50, extra = {}) => ({
  lat: 51.5,
  lng: -0.12,
  speed_kmh: 40,
  speed_limit_kmh: limitKmh,
  speed_limit_source: source,
  ...extra,
});

const tripOf = (points) => ({ route_points: points });

describe('summarizeTripSpeedCoverage', () => {
  it('counts every resolver source, not just the three legacy map ones', () => {
    // The regression this module exists for: these five sources all resolve a
    // limit, and the old inline block bucketed only the first and the last.
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('openstreetmap'),
      point('learned_local'),
      point('user_confirmed_posted_sign'),
      point('region_default_estimate'),
      point('osm_highway_default'),
    ]));

    expect(coverage.coveredCount).toBe(5);
    expect(coverage.coveragePercent).toBe(100);
    expect(coverage.counts.POSTED).toBe(2);
    expect(coverage.counts.LEARNED_LOCAL).toBe(1);
    expect(coverage.counts.REGION_DEFAULT).toBe(1);
    expect(coverage.counts.MAP_ESTIMATED).toBe(1);
    expect(coverage.unknownTierCount).toBe(0);
  });

  it('does not report a locally covered route as map-derived', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('learned_local'),
      point('local_road_memory'),
      point('inferred'),
      point('learned_local'),
    ]));

    expect(coverage.coveragePercent).toBe(100);
    expect(coverage.mapDerivedPercent).toBe(0);
    expect(coverage.locallyDerivedPercent).toBe(100);
  });

  it('excludes privacy-masked points from the denominator but keeps index alignment', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('openstreetmap'),
      { lat: 51.5, lng: -0.12, masked_for_privacy: true, speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
      { privacy_gap: true },
      point('openstreetmap'),
    ]));

    expect(coverage.sampleCount).toBe(2);
    expect(coverage.coveragePercent).toBe(100);
  });

  it('treats an uncovered point as a sample without coverage', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('openstreetmap'),
      { lat: 51.5, lng: -0.12, speed_kmh: 30 },
      { lat: 51.5, lng: -0.12, speed_kmh: 30 },
      { lat: 51.5, lng: -0.12, speed_kmh: 30 },
    ]));

    expect(coverage.sampleCount).toBe(4);
    expect(coverage.coveredCount).toBe(1);
    expect(coverage.coveragePercent).toBe(25);
    expect(coverage.percentages.POSTED).toBe(25);
  });

  it('prefers a driver-confirmed sign over the stored map limit', () => {
    const coverage = summarizeTripSpeedCoverage(
      tripOf([point('osm_highway_default', 60)]),
      {
        localKnowledgeResults: [
          { speed_limit_kmh: 40, speed_limit_source: 'user_confirmed_posted_sign' },
        ],
      }
    );

    expect(coverage.counts.POSTED).toBe(1);
    expect(coverage.counts.MAP_ESTIMATED).toBe(0);
  });

  it('falls back to local knowledge when the stored point has no limit', () => {
    const coverage = summarizeTripSpeedCoverage(
      tripOf([{ lat: 51.5, lng: -0.12, speed_kmh: 30 }]),
      { localKnowledgeResults: [{ speed_limit_kmh: 50, speed_limit_source: 'learned_local' }] }
    );

    expect(coverage.coveredCount).toBe(1);
    expect(coverage.counts.LEARNED_LOCAL).toBe(1);
  });

  it('keeps the tier shares summing to the coverage figure', () => {
    // Three equal thirds round to 33 each and would otherwise report 99.
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('openstreetmap'),
      point('learned_local'),
      point('inferred'),
    ]));

    const summed = SPEED_COVERAGE_TIER_ORDER
      .reduce((sum, tier) => sum + coverage.percentages[tier], 0);
    expect(summed).toBe(coverage.coveragePercent);
    expect(coverage.coveragePercent).toBe(100);
  });

  it('counts an unrecognised source as covered rather than dropping it', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('some_future_source'),
      point('openstreetmap'),
    ]));

    expect(coverage.coveredCount).toBe(2);
    expect(coverage.unknownTierCount).toBe(1);
    expect(coverage.coveragePercent).toBe(100);
  });

  it('returns a zeroed summary for a trip with no route points', () => {
    const coverage = summarizeTripSpeedCoverage({});
    expect(coverage.sampleCount).toBe(0);
    expect(coverage.coveragePercent).toBe(0);
    expect(coverage.mapDerivedPercent).toBe(0);
  });
});

describe('describeTripSpeedCoverage', () => {
  it('omits tiers with no samples instead of printing 0%', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      point('openstreetmap'),
      point('openstreetmap'),
    ]));
    const text = describeTripSpeedCoverage(coverage);

    expect(text).toBe('100% used posted limits (2 samples).');
    expect(text).not.toContain('GPS-inferred');
    expect(text).not.toContain('road-type estimates');
  });

  it('names the region for the regional default clause', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([point('region_default_estimate')]));
    expect(describeTripSpeedCoverage(coverage, { regionLabel: 'United Kingdom' }))
      .toContain('United Kingdom regional default estimates');
  });

  it('says so plainly when nothing resolved', () => {
    const coverage = summarizeTripSpeedCoverage(tripOf([
      { lat: 51.5, lng: -0.12, speed_kmh: 30 },
    ]));
    expect(describeTripSpeedCoverage(coverage)).toContain('No speed limit was resolved');
  });

  it('handles a trip with no samples at all', () => {
    expect(describeTripSpeedCoverage(summarizeTripSpeedCoverage({})))
      .toBe('No speed limit coverage recorded for this route.');
  });
});
