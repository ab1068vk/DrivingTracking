import { describe, expect, it } from 'vitest';
import {
  isSpeedSectionExcluded,
  speedSectionExclusionKeys,
} from '@/lib/speedSectionExclusions';

describe('speed section exclusions', () => {
  it('matches the same road geometry even when the saved rule id is gone', () => {
    const savedRule = {
      id: 'saved-parking-tail',
      sectionPoints: [
        { lat: 43.410001, lng: -80.320001 },
        { lat: 43.410501, lng: -80.320201 },
        { lat: 43.411001, lng: -80.320401 },
      ],
    };
    const laterTripCandidate = {
      sectionKey: 'route-section-trip-1-2',
      sectionPoints: [
        { lat: 43.4100012, lng: -80.3200007 },
        { lat: 43.4105008, lng: -80.3202009 },
        { lat: 43.4110009, lng: -80.3204011 },
      ],
    };

    const excluded = new Set(speedSectionExclusionKeys(savedRule));

    expect(isSpeedSectionExcluded(laterTripCandidate, excluded)).toBe(true);
  });

  it('does not exclude a nearby different section by geohash alone', () => {
    const parkingLot = {
      geohash: 'dpwxyz',
      sectionPoints: [
        { lat: 43.410001, lng: -80.320001 },
        { lat: 43.410501, lng: -80.320201 },
        { lat: 43.411001, lng: -80.320401 },
      ],
    };
    const mainRoad = {
      geohash: 'dpwxyz',
      sectionPoints: [
        { lat: 43.412901, lng: -80.318101 },
        { lat: 43.413501, lng: -80.317801 },
        { lat: 43.414101, lng: -80.317501 },
      ],
    };

    const excluded = new Set(speedSectionExclusionKeys(parkingLot));

    expect(isSpeedSectionExcluded(mainRoad, excluded)).toBe(false);
  });
});
