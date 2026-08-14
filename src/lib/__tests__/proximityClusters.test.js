/**
 * These pin the property the repeated-event-area engine was missing: whether two
 * events cluster must depend on how far apart they are, and on nothing else.
 *
 * The engine previously keyed events onto a rounded lat/lng grid, so membership
 * depended on which side of an invisible line each event fell. The first test
 * here is the exact case that produced "no repeated event area" for a place the
 * driver braked at repeatedly, reproduced against the real numbers.
 */
import { describe, expect, it } from 'vitest';
import { clusterByProximity, clusterCenter, haversineMeters } from '@/lib/geo/proximityClusters';

const M_PER_DEG = 111320;
/** Offset a point by metres north, so fixtures read in metres rather than degrees. */
const north = (origin, metres) => ({ lat: origin.lat + metres / M_PER_DEG, lng: origin.lng });
const east = (origin, metres) => ({
  lat: origin.lat,
  lng: origin.lng + metres / (M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180)),
});

describe('clusterByProximity', () => {
  it('keeps three events twelve metres apart in one cluster wherever the old grid line fell', () => {
    // The old engine used Math.round(lat / (80/111320)) * step. Placing these
    // astride a boundary split them 2/1 and the 3-event threshold was never met.
    const latStep = 80 / M_PER_DEG;
    const boundaryLat = (Math.round(51.5 / latStep) + 0.5) * latStep;
    const events = [-6, 0, 6].map((d) => ({ lat: boundaryLat + d / M_PER_DEG, lng: -0.12 }));

    const clusters = clusterByProximity(events, { radiusM: 60 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('is translation invariant: the same shape clusters the same anywhere', () => {
    const shape = (origin) => [origin, north(origin, 20), east(origin, 25)];
    const counts = [
      { lat: 51.5, lng: -0.12 },
      { lat: 51.5 + 0.0003, lng: -0.12 + 0.0007 },
      { lat: -33.86, lng: 151.2 },
    ].map((origin) => clusterByProximity(shape(origin), { radiusM: 60 }).length);

    expect(counts).toEqual([1, 1, 1]);
  });

  it('separates points beyond the radius', () => {
    const origin = { lat: 51.5, lng: -0.12 };
    const clusters = clusterByProximity([origin, north(origin, 500)], { radiusM: 60 });
    expect(clusters).toHaveLength(2);
  });

  it('joins a chain transitively, so a run of events along a road is one area', () => {
    // Each step is inside the radius but the ends are not. Union-find is what
    // makes this one cluster rather than several overlapping ones.
    const origin = { lat: 51.5, lng: -0.12 };
    const chain = [0, 50, 100, 150].map((d) => north(origin, d));
    const clusters = clusterByProximity(chain, { radiusM: 60 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(4);
  });

  it('scales longitude with latitude, so the radius stays circular near the pole', () => {
    // At 70 degrees a degree of longitude is about a third of a degree at the
    // equator. A bucket sweep that ignored that would scan a sliver and miss
    // neighbours that are genuinely within the radius.
    const arctic = { lat: 70, lng: 25 };
    const clusters = clusterByProximity([arctic, east(arctic, 40)], { radiusM: 60 });
    expect(clusters).toHaveLength(1);
  });

  it('drops points with no usable position rather than clustering them at zero', () => {
    // Number(null) is 0, which is a real coordinate in the Gulf of Guinea. A
    // masked event must not become an area there.
    const origin = { lat: 51.5, lng: -0.12 };
    const clusters = clusterByProximity(
      [origin, { lat: null, lng: null }, { lat: 'x', lng: 2 }, { lat: undefined, lng: undefined }],
      { radiusM: 60 }
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toEqual([origin]);
  });

  it('reads positions through positionOf so callers can cluster records, not coordinates', () => {
    const origin = { lat: 51.5, lng: -0.12 };
    const records = [
      { id: 'a', at: origin },
      { id: 'b', at: north(origin, 15) },
      { id: 'c', at: north(origin, 900) },
    ];
    const clusters = clusterByProximity(records, { radiusM: 60, positionOf: (r) => r.at })
      .map((group) => group.map((r) => r.id).sort());
    expect(clusters).toHaveLength(2);
    expect(clusters).toContainEqual(['a', 'b']);
    expect(clusters).toContainEqual(['c']);
  });

  it('returns nothing for empty or nonsensical input instead of throwing', () => {
    expect(clusterByProximity([], { radiusM: 60 })).toEqual([]);
    expect(clusterByProximity(null, { radiusM: 60 })).toEqual([]);
    expect(clusterByProximity([{ lat: 1, lng: 1 }], { radiusM: 0 })).toEqual([]);
  });
});

describe('haversineMeters', () => {
  it('measures a known separation', () => {
    const origin = { lat: 51.5, lng: -0.12 };
    expect(haversineMeters(origin, north(origin, 100))).toBeCloseTo(100, 0);
  });

  it('is infinite for an unusable point, so it can never fall inside a radius', () => {
    expect(haversineMeters({ lat: 51.5, lng: -0.12 }, { lat: null, lng: null }))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe('clusterCenter', () => {
  it('averages members and ignores unusable ones', () => {
    const center = clusterCenter([{ lat: 51.5, lng: -0.12 }, { lat: 51.502, lng: -0.12 }, { lat: null, lng: null }]);
    expect(center.lat).toBeCloseTo(51.501, 6);
    expect(center.lng).toBeCloseTo(-0.12, 6);
  });

  it('returns null when nothing is usable', () => {
    expect(clusterCenter([{ lat: null, lng: null }])).toBeNull();
    expect(clusterCenter([])).toBeNull();
  });
});
