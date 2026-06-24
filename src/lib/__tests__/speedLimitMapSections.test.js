import { describe, expect, it } from 'vitest';
import {
  buildSplitCorrections,
  snapSectionPointsToTripRoutesWithStats,
} from '@/lib/speedLimitMapSections';

describe('speedLimitMapSections', () => {
  it('splits a two-point saved section by inserting a midpoint', () => {
    const parts = buildSplitCorrections({
      saved: true,
      geohash: 'test-cell',
      limitKmh: 50,
      roadName: 'Example Road',
      sectionPoints: [
        { lat: 43.65, lng: -79.38 },
        { lat: 43.65, lng: -79.37 },
      ],
    });

    expect(parts).toHaveLength(2);
    expect(parts[0].sectionPoints).toHaveLength(2);
    expect(parts[1].sectionPoints).toHaveLength(2);
    expect(parts[0].sectionPoints.at(-1)).toEqual(parts[1].sectionPoints[0]);
    expect(parts[0]).toMatchObject({ limitKmh: 50, splitPart: 1 });
    expect(parts[1]).toMatchObject({ limitKmh: 50, splitPart: 2 });
  });

  it('reports how route snapping changed section geometry', () => {
    const result = snapSectionPointsToTripRoutesWithStats(
      [
        { lat: 43.65, lng: -79.3800 },
        { lat: 43.65, lng: -79.3790 },
      ],
      [{
        route_points: [
          { lat: 43.6501, lng: -79.3801 },
          { lat: 43.6501, lng: -79.3791 },
        ],
      }],
      80
    );

    expect(result.points).toEqual([
      { lat: 43.6501, lng: -79.3801 },
      { lat: 43.6501, lng: -79.3791 },
    ]);
    expect(result.changedCount).toBe(2);
    expect(result.snappedCount).toBe(2);
    expect(result.maxMoveM).toBeGreaterThan(0);
    expect(result.routePointCount).toBe(2);
  });
});
