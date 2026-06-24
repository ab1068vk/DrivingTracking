import { describe, expect, it } from 'vitest';
import {
  buildSplitCorrections,
  findOverlappingSpeedSections,
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

  it('can expand a trace to one ordered recorded route segment', () => {
    const route = [
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6501, lng: -79.3808 },
      { lat: 43.6502, lng: -79.3806 },
      { lat: 43.6503, lng: -79.3804 },
    ];

    const result = snapSectionPointsToTripRoutesWithStats(
      [
        { lat: 43.65001, lng: -79.38101 },
        { lat: 43.65029, lng: -79.38039 },
      ],
      [{ id: 'trip-route-segment', route_points: route }],
      80,
      { expandToRouteSegment: true }
    );

    expect(result.matchType).toBe('route_segment');
    expect(result.tripId).toBe('trip-route-segment');
    expect(result.points).toEqual(route);
    expect(result.expandedPointCount).toBe(4);
  });

  it('blocks overlapping saved sections with conflicting active speeds', () => {
    const existing = {
      id: 'existing-50',
      saved: true,
      limitKmh: 50,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6503, lng: -79.3804 },
      ],
    };
    const draft = {
      id: 'draft-60',
      limitKmh: 60,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.65001, lng: -79.38101 },
        { lat: 43.65031, lng: -79.38041 },
      ],
    };

    const overlaps = findOverlappingSpeedSections(draft, [existing], { excludeKey: 'draft-60' });

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      sectionKey: 'existing-50',
      limitKmh: 50,
      limitDeltaKmh: 10,
      severity: 'block',
    });
  });

  it('does not treat adjacent split halves as overlapping duplicates', () => {
    const firstHalf = {
      id: 'split-1',
      saved: true,
      limitKmh: 50,
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6503, lng: -79.3804 },
      ],
    };
    const secondHalf = {
      id: 'split-2',
      limitKmh: 50,
      sectionPoints: [
        { lat: 43.6503, lng: -79.3804 },
        { lat: 43.6506, lng: -79.3798 },
      ],
    };

    expect(findOverlappingSpeedSections(secondHalf, [firstHalf], { excludeKey: 'split-2' })).toEqual([]);
  });
});
