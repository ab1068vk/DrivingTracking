import { describe, expect, it } from 'vitest';
import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildRoadSectionIdentity, correctionSectionIdentity } from '@/lib/roadSectionIdentity';

const point = (lat, lng, roadName, timestamp) => ({
  lat,
  lng,
  speed_limit_road_name: roadName,
  timestamp,
});

describe('road section identity', () => {
  it('describes a driven cell with road, direction, time, and nearby road context', () => {
    const target = point(43.6532, -79.3832, 'Queen Street', '2026-06-17T16:30:00Z');
    const trip = {
      route_points: [
        point(43.6529, -79.3832, 'University Avenue', '2026-06-17T16:29:45Z'),
        target,
        point(43.6535, -79.3832, 'Queen Street', '2026-06-17T16:30:05Z'),
        point(43.6538, -79.3832, 'Queen Street', '2026-06-17T16:30:10Z'),
        point(43.6541, -79.3832, 'Dundas Street', '2026-06-17T16:30:20Z'),
      ],
    };

    const identity = buildRoadSectionIdentity(trip, geohashEncode(target.lat, target.lng));

    expect(identity.title).toBe('Queen Street');
    expect(identity.directionLabel).toBe('northbound');
    expect(identity.contextLabel).toContain('University Avenue');
    expect(identity.sectionPoints.length).toBeGreaterThan(1);
    expect(identity.sampleLat).toBe(target.lat);
  });

  it('uses stored local section metadata when a linked trip is unavailable', () => {
    const identity = correctionSectionIdentity({
      roadName: 'King Street',
      contextLabel: 'before Bay Street',
      directionLabel: 'eastbound',
      lat: 43.65,
      lng: -79.38,
      sectionPoints: [
        { lat: 43.65, lng: -79.381 },
        { lat: 43.65, lng: -79.38 },
      ],
    });

    expect(identity).toMatchObject({
      title: 'King Street',
      contextLabel: 'before Bay Street',
      directionLabel: 'eastbound',
    });
    expect(identity.sectionPoints).toHaveLength(2);
  });

  it('excludes null-island GPS placeholders from driven section geometry', () => {
    const target = point(43.6532, -79.3832, 'Queen Street', '2026-06-17T16:30:00Z');
    const trip = {
      route_points: [
        point(43.6531, -79.3832, 'Queen Street', '2026-06-17T16:29:50Z'),
        target,
        point(0, 0, 'Queen Street', '2026-06-17T16:29:55Z'),
        point(43.6533, -79.3832, 'Queen Street', '2026-06-17T16:30:10Z'),
      ],
    };

    const identity = buildRoadSectionIdentity(trip, geohashEncode(target.lat, target.lng));

    expect(identity.distanceM).toBeLessThan(100);
    expect(identity.sectionPoints).not.toContainEqual({ lat: 0, lng: 0 });
  });
});
