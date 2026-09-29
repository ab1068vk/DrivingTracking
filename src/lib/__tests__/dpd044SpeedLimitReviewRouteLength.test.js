import { describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ geohash: 0 }));
vi.mock('@/lib/localSpeedKnowledge', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    geohashEncode: (...args) => { counter.geohash += 1; return original.geohashEncode(...args); },
  };
});

import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildRoadSectionIdentity, correctionSectionIdentity, isPublicPoint } from '@/lib/roadSectionIdentity';
import { buildTripSpeedLimitCoverageCells, buildTripSpeedLimitReviewCells } from '@/lib/speedLimitReview';
import { buildSpeedLimitRoute } from './helpers/speedLimitRouteFixture';

/**
 * DPD-044 — the speed-limit review must not rescan the route for every road section.
 *
 * `buildTripSpeedLimitCells` geohashes every route point once to group them into
 * cells, then built each cell's road-section identity with a helper that
 * re-encoded every route point again to find that cell's points: O(points ×
 * cells). On the A54 a 5,000-point Trip Detail blocked the main thread 1.0–1.8 s;
 * a 50,000-point synthetic route took ~57 s on a desktop.
 *
 * The routes here are synthetic (`speedLimitRouteFixture`): algorithmic
 * regression only, not device or production-pipeline proof.
 */

const publicPointCount = (trip) => trip.route_points.filter(isPublicPoint).length;
const withoutClock = (value) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'evaluatedAtMs' ? '<clock>' : v)));

/** The fields `buildRoadSectionIdentity` contributes to a cell. */
const IDENTITY_FIELDS = ['roadName', 'title', 'contextLabel', 'directionLabel', 'timeLabel', 'distanceM', 'sampleCount',
  'sampleLat', 'sampleLng', 'sectionPoints'];
const identityOf = (cell) => Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, cell[field]]));

describe('DPD-044: the review geohashes each route point once', () => {
  it.each([5000, 50000])('%i-point route: geohash calls equal the public point count (was points × cells)', (size) => {
    const trip = buildSpeedLimitRoute(size);
    counter.geohash = 0;
    const review = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
    expect(review.length).toBeGreaterThan(100);
    expect(counter.geohash).toBe(publicPointCount(trip));

    counter.geohash = 0;
    const coverage = buildTripSpeedLimitCoverageCells(trip, { maxCells: Infinity });
    expect(coverage.length).toBeGreaterThan(review.length);
    expect(counter.geohash).toBe(publicPointCount(trip));
  });

  it('the work does not grow with the number of cells', () => {
    const perPoint = [1000, 3000, 10000].map((size) => {
      const trip = buildSpeedLimitRoute(size);
      counter.geohash = 0;
      buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
      return counter.geohash / trip.route_points.length;
    });
    perPoint.forEach((ratio) => expect(ratio).toBeLessThanOrEqual(1));
  });
});

describe('DPD-044: the output is unchanged', () => {
  it.each([100, 500, 1000, 3000, 5000])('%i points: every cell equals the full-scan identity', (size) => {
    const trip = buildSpeedLimitRoute(size, { seed: size % 13 });
    const cells = buildTripSpeedLimitCoverageCells(trip, { maxCells: Infinity });
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach((cell) => {
      // No `cellIndexes`: the pre-DPD-044 whole-route scan, kept for single lookups.
      const reference = buildRoadSectionIdentity(trip, cell.geohash);
      expect(identityOf(cell)).toEqual(identityOf(reference));
    });
  });

  it('review cells are the decision-requiring subset of the coverage cells, in the same order rules', () => {
    const trip = buildSpeedLimitRoute(3000);
    const coverage = buildTripSpeedLimitCoverageCells(trip, { maxCells: Infinity });
    const review = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
    const decided = new Set(coverage.filter((cell) => cell.requiresDecision).map((cell) => cell.geohash));
    expect(new Set(review.map((cell) => cell.geohash))).toEqual(decided);
    expect(new Set(review.map((cell) => cell.geohash)).size).toBe(review.length); // no duplicate sections
  });

  it('is deterministic for the same trip (nothing but the evaluation clock differs)', () => {
    const trip = buildSpeedLimitRoute(2000, { seed: 3 });
    const first = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
    const second = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
    expect(withoutClock(second)).toEqual(withoutClock(first));
  });

  it('maxCells still returns the highest-priority cells of the full set', () => {
    const trip = buildSpeedLimitRoute(3000);
    const all = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
    const top = buildTripSpeedLimitReviewCells(trip, { maxCells: 8 });
    expect(withoutClock(top)).toEqual(withoutClock(all.slice(0, 8)));
  });
});

describe('DPD-044: edge cases behave as before', () => {
  const trip = (points) => ({ id: 'edge', status: 'completed', trip_utc_offset_minutes: 0, route_points: points });
  const p = (lat, lng, extra = {}) => ({ lat, lng, timestamp: 1_700_000_000_000, speed_limit_road_name: 'Main St',
    speed_limit_source: 'region_default_estimate', speed_limit_kmh: 50, ...extra });

  it('empty and missing routes give no cells', () => {
    expect(buildTripSpeedLimitReviewCells(trip([]), { maxCells: Infinity })).toEqual([]);
    expect(buildTripSpeedLimitReviewCells({ id: 'none', status: 'completed' }, { maxCells: Infinity })).toEqual([]);
  });

  it('a one-point route gives one cell with the full-scan identity', () => {
    const t = trip([p(43.65, -79.38)]);
    const [cell] = buildTripSpeedLimitReviewCells(t, { maxCells: Infinity });
    expect(identityOf(cell)).toEqual(identityOf(buildRoadSectionIdentity(t, cell.geohash)));
    expect(cell.sampleCount).toBe(1);
  });

  // A literal `null` route point throws in `isPublicPoint` before and after DPD-044 alike (stored route
  // points are sanitised objects); that pre-existing behaviour is out of this correction's scope.
  it('masked, null-island and non-finite points are skipped exactly as the full scan skips them', () => {
    const t = trip([
      p(43.65, -79.38), p(Number.NaN, -79.38), p(0, 0), p(43.6501, -79.3801, { masked_for_privacy: true }),
      p(43.6502, -79.3802), p(43.6502, -79.3802), p(43.6503, -79.3803, { privacy_gap: true }), p(43.6504, -79.3804),
    ]);
    const cells = buildTripSpeedLimitCoverageCells(t, { maxCells: Infinity });
    cells.forEach((cell) => expect(identityOf(cell)).toEqual(identityOf(buildRoadSectionIdentity(t, cell.geohash))));
  });

  it('all-masked routes give no cells', () => {
    const t = trip([p(43.65, -79.38, { masked_for_privacy: true }), p(43.66, -79.39, { privacy_live_redacted: true })]);
    expect(buildTripSpeedLimitCoverageCells(t, { maxCells: Infinity })).toEqual([]);
  });

  it('a section revisited later in the trip (overlapping) keeps the longest contiguous run, as before', () => {
    const route = buildSpeedLimitRoute(1500, { seed: 4 });
    const cells = buildTripSpeedLimitCoverageCells(route, { maxCells: Infinity });
    const revisited = cells.filter((cell) => {
      const idx = route.route_points.map((pt, i) => (isPublicPoint(pt) && geohashEncode(pt.lat, pt.lng) === cell.geohash ? i : -1)).filter((i) => i >= 0);
      return idx.some((value, i) => i > 0 && value - idx[i - 1] > 1);
    });
    expect(revisited.length).toBeGreaterThan(0);
    revisited.forEach((cell) => expect(identityOf(cell)).toEqual(identityOf(buildRoadSectionIdentity(route, cell.geohash))));
  });

  it('a saved correction still resolves its section from the trip by a single scan', () => {
    const route = buildSpeedLimitRoute(800, { seed: 2 });
    const [cell] = buildTripSpeedLimitCoverageCells(route, { maxCells: 1 });
    const identity = correctionSectionIdentity({ geohash: cell.geohash }, route);
    expect(identityOf(identity)).toEqual(identityOf(buildRoadSectionIdentity(route, cell.geohash)));
  });
});
