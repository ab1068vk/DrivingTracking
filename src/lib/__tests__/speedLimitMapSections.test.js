import { describe, expect, it } from 'vitest';
import {
  buildSpeedMapSections,
  buildSpeedZoneReviewItems,
  buildSplitCorrections,
  filterSpeedMapSections,
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

  it('keeps continuous unset route geometry together instead of slicing by geohash cells', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-unset-road',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street' },
        { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street' },
        { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'King Street' },
        { lat: 43.6503, lng: -79.3840, speed_limit_road_name: 'King Street' },
        { lat: 43.6504, lng: -79.3820, speed_limit_road_name: 'King Street' },
      ],
    }], []);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      saved: false,
      roadName: 'King Street',
      effectiveLimitKmh: null,
      sampleCount: 5,
    });
    expect(sections[0].sectionKey).toMatch(/^route-section-/);
    expect(sections[0].sectionPoints).toHaveLength(5);
  });

  it('drops isolated one-point unset route samples from the map model', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-single-sample',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street' },
      ],
    }], []);

    expect(sections).toEqual([]);
  });

  it('splits unset candidates on actual road changes', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-two-roads',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street' },
        { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street' },
        { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'Queen Street' },
        { lat: 43.6503, lng: -79.3840, speed_limit_road_name: 'Queen Street' },
      ],
    }], []);

    expect(sections.map((section) => section.roadName)).toEqual(['King Street', 'Queen Street']);
    expect(sections.every((section) => section.sectionPoints.length >= 2)).toBe(true);
  });

  it('splits one trip into editable sections when observed speeds change', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-speed-zones',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street', speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street' },
        { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'King Street', speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
        { lat: 43.6503, lng: -79.3840, speed_limit_road_name: 'King Street', speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      ],
    }], []);

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.effectiveLimitKmh)).toEqual([50, 60]);
    expect(sections.every((section) => section.roadName === 'King Street')).toBe(true);
    expect(sections.every((section) => section.sectionKey.match(/^route-section-/))).toBe(true);
  });

  it('queues each observed zone from a multi-speed trip for segment review', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-review-zones',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street', speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street', speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'King Street', speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
        { lat: 43.6503, lng: -79.3840, speed_limit_road_name: 'King Street', speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
        { lat: 43.6504, lng: -79.3820, speed_limit_road_name: 'King Street', speed_limit_kmh: 80, speed_limit_source: 'openstreetmap' },
        { lat: 43.6505, lng: -79.3800, speed_limit_road_name: 'King Street', speed_limit_kmh: 80, speed_limit_source: 'openstreetmap' },
      ],
    }], []);

    const queue = buildSpeedZoneReviewItems(sections);

    expect(queue.map((item) => item.limitKmh)).toEqual([50, 60, 80]);
    expect(queue.map((item) => item.zoneIndex)).toEqual([1, 2, 3]);
    expect(queue.every((item) => item.kind === 'speedZone')).toBe(true);
    expect(queue.every((item) => item.zoneCount === 3)).toBe(true);
  });

  it('does not queue a trip with only one observed speed zone', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-with-one-zone',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street', speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street', speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
      ],
    }], []);

    expect(buildSpeedZoneReviewItems(sections)).toEqual([]);
  });

  it('does not leave a duplicate unset section under saved traced geometry', () => {
    const route = [
      { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street' },
      { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street' },
      { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'King Street' },
    ];
    const sections = buildSpeedMapSections([{
      id: 'trip-covered-by-rule',
      status: 'completed',
      route_points: route,
    }], [{
      id: 'saved-rule',
      geohash: 'dpz83b',
      lat: 43.6501,
      lng: -79.3880,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      sectionPoints: route.map(({ lat, lng }) => ({ lat, lng })),
    }]);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      id: 'saved-rule',
      saved: true,
      roadName: 'King Street',
      affectedTripCount: 1,
    });
  });

  it('does not leave a duplicate unset section when a saved trace covers a meaningful part of the route', () => {
    const route = [
      { lat: 43.6500, lng: -79.3900, speed_limit_road_name: 'King Street' },
      { lat: 43.6501, lng: -79.3880, speed_limit_road_name: 'King Street' },
      { lat: 43.6502, lng: -79.3860, speed_limit_road_name: 'King Street' },
      { lat: 43.6503, lng: -79.3840, speed_limit_road_name: 'King Street' },
      { lat: 43.6504, lng: -79.3820, speed_limit_road_name: 'King Street' },
    ];
    const sections = buildSpeedMapSections([{
      id: 'trip-partly-covered-by-rule',
      status: 'completed',
      route_points: route,
    }], [{
      id: 'saved-rule',
      geohash: 'dpz83b',
      lat: 43.6501,
      lng: -79.3880,
      limitKmh: 40,
      source: 'user_entered_estimate',
      sectionPoints: route.slice(1, 3).map(({ lat, lng }) => ({ lat, lng })),
    }]);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      id: 'saved-rule',
      saved: true,
      limitKmh: 40,
    });
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

  it('shows intelligence matches when road-state layers are all disabled', () => {
    const sections = [
      {
        id: 'posted-section',
        saved: true,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        sectionPoints: [
          { lat: 43.65, lng: -79.38 },
          { lat: 43.651, lng: -79.381 },
        ],
      },
      {
        id: 'estimate-section',
        saved: true,
        limitKmh: 60,
        source: 'user_entered_estimate',
        sectionPoints: [
          { lat: 43.66, lng: -79.39 },
          { lat: 43.661, lng: -79.391 },
        ],
      },
      {
        id: 'unset-section',
        saved: false,
        sectionPoints: [
          { lat: 43.67, lng: -79.40 },
          { lat: 43.671, lng: -79.401 },
        ],
      },
    ];

    const filtered = filterSpeedMapSections(sections, {
      layers: {
        conflicts: false,
        saved: false,
        observed: false,
        unset: false,
        posted: true,
        estimates: false,
        lowConfidence: false,
        stale: false,
        expiring: false,
        missingGeometry: false,
      },
    });

    expect(filtered.map((section) => section.id)).toEqual(['posted-section']);
  });
});
