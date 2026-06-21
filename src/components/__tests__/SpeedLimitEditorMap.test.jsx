import { describe, expect, it } from 'vitest';
import {
  buildSpeedMapSections,
  buildSplitCorrections,
  findMergeableSpeedSection,
  filterSpeedMapSections,
  mergeSpeedSections,
  snapSectionPointsToTripRoutes,
  speedLimitColor,
  summarizeSpeedMapSections,
} from '@/lib/speedLimitMapSections';
import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { tripCrossesCorrection } from '@/lib/localSpeedScoreRefresh';

describe('SpeedLimitEditorMap helpers', () => {
  it('builds separate saved and unset road sections from trip points', () => {
    const first = { lat: 43.6501, lng: -79.3801, speed_limit_road_name: 'King Street' };
    const second = { lat: 43.6502, lng: -79.3802, speed_limit_road_name: 'King Street' };
    const third = { lat: 43.662, lng: -79.395, speed_limit_road_name: 'Queen Street' };
    const savedHash = geohashEncode(first.lat, first.lng);
    const sections = buildSpeedMapSections([
      {
        id: 'trip-1',
        status: 'completed',
        route_points: [first, second, third],
      },
    ], [{
      geohash: savedHash,
      lat: first.lat,
      lng: first.lng,
      limitKmh: 40,
      source: 'user_confirmed_posted_sign',
    }]);

    expect(sections.some((section) => section.geohash === savedHash && section.saved && section.limitKmh === 40)).toBe(true);
    expect(sections.some((section) => !section.saved)).toBe(true);
  });

  it('keeps opposite-direction saved rules separate on the map', () => {
    const point = { lat: 43.6501, lng: -79.3801, speed_limit_road_name: 'King Street' };
    const geohash = geohashEncode(point.lat, point.lng);
    const sections = buildSpeedMapSections([], [
      {
        id: 'eastbound',
        geohash,
        ...point,
        limitKmh: 40,
        directionMode: 'forward',
        source: 'user_confirmed_posted_sign',
      },
      {
        id: 'westbound',
        geohash,
        ...point,
        limitKmh: 50,
        directionMode: 'reverse',
        source: 'user_confirmed_posted_sign',
      },
    ]);

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.sectionKey).sort()).toEqual(['eastbound', 'westbound']);
    expect(sections.map((section) => section.limitKmh).sort()).toEqual([40, 50]);
  });

  it('uses distinct colors for unset, urban, and highway limits', () => {
    expect(speedLimitColor(null)).toBe('#94a3b8');
    expect(speedLimitColor(40)).not.toBe(speedLimitColor(80));
    expect(speedLimitColor(80)).not.toBe(speedLimitColor(100));
  });

  it('colors recorded road sections from user-labeled trip speed limits', () => {
    const point = {
      lat: 43.6501,
      lng: -79.3801,
      speed_limit_road_name: 'King Street',
      speed_limit_kmh: 40,
      speed_limit_source: 'user_entered_estimate',
    };
    const [section] = buildSpeedMapSections([{
      id: 'trip-user-label',
      status: 'completed',
      route_points: [point, { ...point, lat: 43.6502, lng: -79.3802 }],
    }], []);

    expect(section.saved).toBe(false);
    expect(section.limitKmh).toBeNull();
    expect(section.observedLimitKmh).toBe(40);
    expect(section.effectiveLimitKmh).toBe(40);
    expect(speedLimitColor(section.effectiveLimitKmh)).toBe(speedLimitColor(40));
  });

  it('uses saved correction speed before observed route labels for map section colors', () => {
    const point = {
      lat: 43.6501,
      lng: -79.3801,
      speed_limit_road_name: 'King Street',
      speed_limit_kmh: 70,
      speed_limit_source: 'openstreetmap',
    };
    const geohash = geohashEncode(point.lat, point.lng);
    const [section] = buildSpeedMapSections([{
      id: 'trip-saved-priority',
      status: 'completed',
      route_points: [point],
    }], [{
      geohash,
      lat: point.lat,
      lng: point.lng,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    }]);

    expect(section.saved).toBe(true);
    expect(section.observedLimitKmh).toBe(70);
    expect(section.limitKmh).toBe(50);
    expect(section.effectiveLimitKmh).toBe(50);
  });

  it('marks saved sections that conflict with observed trip speed data', () => {
    const point = {
      lat: 43.6501,
      lng: -79.3801,
      speed_limit_road_name: 'King Street',
      speed_limit_kmh: 70,
      speed_limit_source: 'openstreetmap',
    };
    const geohash = geohashEncode(point.lat, point.lng);
    const [section] = buildSpeedMapSections([{
      id: 'trip-conflict',
      status: 'completed',
      route_points: [point],
    }], [{
      geohash,
      lat: point.lat,
      lng: point.lng,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    }]);

    expect(section.conflict).toMatchObject({
      savedLimitKmh: 50,
      observedLimitKmh: 70,
      deltaKmh: 20,
    });
  });

  it('does not reopen an acknowledged saved-vs-observed conflict until evidence changes', () => {
    const point = {
      lat: 43.6501,
      lng: -79.3801,
      speed_limit_road_name: 'King Street',
      speed_limit_kmh: 70,
      speed_limit_source: 'openstreetmap',
    };
    const geohash = geohashEncode(point.lat, point.lng);
    const [section] = buildSpeedMapSections([{
      id: 'trip-acknowledged-conflict',
      status: 'completed',
      route_points: [point],
    }], [{
      geohash,
      lat: point.lat,
      lng: point.lng,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      conflictResolution: {
        savedLimitKmh: 50,
        observedLimitKmh: 70,
        deltaKmh: 20,
        action: 'kept_saved_limit',
      },
    }]);

    expect(section.conflict).toBeNull();

    const [changedEvidenceSection] = buildSpeedMapSections([{
      id: 'trip-reopened-conflict',
      status: 'completed',
      route_points: [{ ...point, speed_limit_kmh: 80 }],
    }], [{
      geohash,
      lat: point.lat,
      lng: point.lng,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      conflictResolution: {
        savedLimitKmh: 50,
        observedLimitKmh: 70,
        deltaKmh: 20,
        action: 'kept_saved_limit',
      },
    }]);

    expect(changedEvidenceSection.conflict).toMatchObject({
      savedLimitKmh: 50,
      observedLimitKmh: 80,
      deltaKmh: 30,
    });
  });

  it('limits rendered geometry for dense road sections while retaining endpoints', () => {
    const points = Array.from({ length: 500 }, (_, index) => ({
      lat: 43.65 + index * 0.000001,
      lng: -79.38 + index * 0.000001,
      speed_limit_road_name: 'Dense Street',
    }));
    const [section] = buildSpeedMapSections([{
      id: 'trip-dense',
      status: 'completed',
      route_points: points,
    }], []);

    expect(section.sectionPoints.length).toBeLessThanOrEqual(80);
    expect(section.sectionPoints[0]).toEqual({ lat: points[0].lat, lng: points[0].lng });
    expect(section.sectionPoints.at(-1)).toEqual({ lat: points.at(-1).lat, lng: points.at(-1).lng });
  });

  it('summarizes and filters advanced map layers', () => {
    const savedPoint = {
      lat: 43.6501,
      lng: -79.3801,
      speed_limit_road_name: 'King Street',
      speed_limit_kmh: 70,
      speed_limit_source: 'openstreetmap',
    };
    const observedPoint = {
      lat: 43.6601,
      lng: -79.3901,
      speed_limit_road_name: 'Queen Street',
      speed_limit_kmh: 40,
      speed_limit_source: 'region_default_estimate',
    };
    const unsetPoint = {
      lat: 43.6701,
      lng: -79.4001,
      speed_limit_road_name: 'Dundas Street',
    };
    const sections = buildSpeedMapSections([{
      id: 'trip-layers',
      status: 'completed',
      route_points: [savedPoint, observedPoint, unsetPoint],
    }], [{
      geohash: geohashEncode(savedPoint.lat, savedPoint.lng),
      lat: savedPoint.lat,
      lng: savedPoint.lng,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
    }]);

    expect(summarizeSpeedMapSections(sections)).toMatchObject({
      total: 3,
      conflicts: 1,
      observed: 1,
      unset: 1,
      savedRules: 1,
    });
    expect(filterSpeedMapSections(sections, {
      layers: { conflicts: false, saved: false, observed: true, unset: false },
    }).map((section) => section.roadName)).toEqual(['Queen Street']);
    expect(filterSpeedMapSections(sections, { query: 'dundas' })).toHaveLength(1);
  });

  it('splits traced saved sections into two child corrections', () => {
    const section = {
      geohash: 'original',
      roadName: 'King Street',
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6502, lng: -79.3808 },
        { lat: 43.6504, lng: -79.3806 },
        { lat: 43.6506, lng: -79.3804 },
      ],
    };

    const parts = buildSplitCorrections(section);
    expect(parts).toHaveLength(2);
    expect(parts[0].sectionPoints.at(-1)).toEqual(parts[1].sectionPoints[0]);
    expect(parts.every((part) => part.limitKmh === 50)).toBe(true);
    expect(parts.every((part) => part.geohash && part.geohash !== 'original')).toBe(true);
  });

  it('does not include privacy-masked route points', () => {
    const sections = buildSpeedMapSections([{
      id: 'trip-private',
      status: 'completed',
      route_points: [
        { lat: 43.65, lng: -79.38, masked_for_privacy: true },
        { lat: 43.651, lng: -79.381, privacy_live_redacted: true },
      ],
    }], []);

    expect(sections).toEqual([]);
  });

  it('detects trips crossing a curved correction', () => {
    const correction = {
      geohash: 'example',
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6504, lng: -79.3806 },
        { lat: 43.6508, lng: -79.3808 },
      ],
    };
    expect(tripCrossesCorrection({
      route_points: [{ lat: 43.65042, lng: -79.38061 }],
    }, correction)).toBe(true);
    expect(tripCrossesCorrection({
      route_points: [{ lat: 43.655, lng: -79.3806 }],
    }, correction)).toBe(false);
  });

  it('snaps traced points to nearby recorded route geometry', () => {
    const snapped = snapSectionPointsToTripRoutes([
      { lat: 43.65005, lng: -79.38095 },
      { lat: 43.65005, lng: -79.38005 },
    ], [{
      route_points: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    }]);

    expect(snapped).toEqual([
      { lat: 43.6500, lng: -79.3810 },
      { lat: 43.6500, lng: -79.3800 },
    ]);
  });

  it('finds and merges compatible nearby saved sections', () => {
    const first = {
      geohash: 'first',
      saved: true,
      roadName: 'King Street',
      limitKmh: 50,
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3805 },
      ],
    };
    const second = {
      geohash: 'second',
      saved: true,
      roadName: 'King Street',
      limitKmh: 50,
      sectionPoints: [
        { lat: 43.6500, lng: -79.38045 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    };

    expect(findMergeableSpeedSection(first, [first, second])?.candidate.geohash).toBe('second');
    const merged = mergeSpeedSections(first, second);
    expect(merged.mergedGeohashes).toEqual(['first', 'second']);
    expect(merged.sectionPoints.length).toBeGreaterThanOrEqual(3);
  });
});
