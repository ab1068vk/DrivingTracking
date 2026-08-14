/**
 * The case these exist for: a driver with clean braking who speeds on the same
 * road every day, and who was shown "no repeated event areas" forever because a
 * speeding event is placed at whichever fix was fastest and so never repeats in
 * one spot. A stretch aggregates along the road and divides by passes, which is
 * where the habit actually shows up.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSpeedingStretches,
  SPEEDING_STRETCH_LINK_RADIUS_M,
} from '@/lib/dangerZone/speedingStretches';
import {
  SPEEDING_STRETCH_MIN_PASSES,
  SPEEDING_STRETCH_MIN_RATE,
} from '@/lib/appConstants';

/** A route-risk segment as `buildRouteRiskIndex` stores it. */
const segment = ({ lat = 43.65, lng = -79.38, passes = 5, speeding = 0, avgSpeed = 62 } = {}) => ({
  lat,
  lng,
  tripCount: passes,
  totalEvents: speeding,
  eventTypes: speeding ? { speeding } : {},
  avgSpeed,
  riskScore: 20,
  riskLevel: 'low',
});

/** `count` consecutive segments of one road, ~100 m apart. */
const road = (count, lat = 43.65, lng = -79.38) => (
  Array.from({ length: count }, (_, i) => ({ lat: lat + i * 0.0009, lng }))
);

describe('buildSpeedingStretches', () => {
  it('returns [] for an empty or missing index', () => {
    expect(buildSpeedingStretches(new Map())).toEqual([]);
    expect(buildSpeedingStretches(undefined)).toEqual([]);
    expect(buildSpeedingStretches([])).toEqual([]);
  });

  it('finds the habit even though no two events land in the same place', () => {
    // Five passes, one over-limit run each, and the peak-speed fix lands on a
    // different segment every time. Point clustering sees five isolated events;
    // the stretch sees five of five passes.
    const stretch = buildSpeedingStretches(
      road(5).map((at) => segment({ ...at, passes: 5, speeding: 1 }))
    );

    expect(stretch).toHaveLength(1);
    expect(stretch[0].kind).toBe('speeding_stretch');
    expect(stretch[0].eventCount).toBe(5);
    expect(stretch[0].passes).toBe(5);
    expect(stretch[0].eventRate).toBe(1);
    expect(stretch[0].segmentCount).toBe(5);
    expect(stretch[0].riskLevel).toBe('high');
  });

  it('qualifies a road speeded on 4 of 5 passes', () => {
    const stretch = buildSpeedingStretches([
      segment({ ...road(1)[0], passes: 5, speeding: 3 }),
      segment({ ...road(2)[1], passes: 5, speeding: 1 }),
    ]);

    expect(stretch).toHaveLength(1);
    expect(stretch[0].eventRate).toBeCloseTo(0.8, 5);
    expect(stretch[0].tripCount).toBe(4);
  });

  it('does not qualify a road speeded on 4 of 40 passes', () => {
    // The same four events. Only exposure differs, and that is the whole point:
    // four times on a road driven forty times is not a habit.
    expect(buildSpeedingStretches([
      segment({ ...road(1)[0], passes: 40, speeding: 3 }),
      segment({ ...road(2)[1], passes: 40, speeding: 1 }),
    ])).toEqual([]);
  });

  it('needs enough passes before calling anything a habit', () => {
    // Speeding on the only pass is a rate of 1.0 and means nothing.
    expect(buildSpeedingStretches([segment({ passes: 1, speeding: 1 })])).toEqual([]);
    expect(buildSpeedingStretches([segment({ passes: 3, speeding: 3 })])).toEqual([]);
    expect(buildSpeedingStretches([segment({ passes: 4, speeding: 4 })])).toHaveLength(1);
  });

  it('keeps the documented thresholds', () => {
    expect(SPEEDING_STRETCH_MIN_PASSES).toBe(4);
    expect(SPEEDING_STRETCH_MIN_RATE).toBe(0.5);
  });

  it('ignores segments with no speeding at all', () => {
    expect(buildSpeedingStretches([
      segment({ passes: 20, speeding: 0 }),
      segment({ lat: 43.66, passes: 20, speeding: 0 }),
    ])).toEqual([]);
  });

  it('keeps separate roads separate', () => {
    const stretches = buildSpeedingStretches([
      ...road(3).map((at) => segment({ ...at, passes: 5, speeding: 2 })),
      ...road(3, 43.80).map((at) => segment({ ...at, passes: 5, speeding: 2 })),
    ]);

    expect(stretches).toHaveLength(2);
    expect(Math.abs(stretches[0].lat - stretches[1].lat)).toBeGreaterThan(0.1);
  });

  it('chains a long road into one stretch rather than many fragments', () => {
    const stretches = buildSpeedingStretches(
      road(20).map((at) => segment({ ...at, passes: 10, speeding: 1 }))
    );

    expect(stretches).toHaveLength(1);
    expect(stretches[0].segmentCount).toBe(20);
    // ~19 gaps of 100 m, and the radius covers the run rather than its middle.
    expect(stretches[0].lengthM).toBeGreaterThan(1500);
    expect(stretches[0].radiusM).toBeGreaterThan(SPEEDING_STRETCH_LINK_RADIUS_M);
  });

  it('caps the rate at one pass-worth, because a run can re-arm mid-pass', () => {
    const stretch = buildSpeedingStretches([segment({ passes: 5, speeding: 12 })])[0];
    expect(stretch.eventRate).toBe(1);
    expect(stretch.tripCount).toBe(5);
  });

  it('reports lastSeen as unknown rather than inventing a date', () => {
    // Route-risk segments carry no timestamps. Zero would read as "never".
    expect(buildSpeedingStretches([segment({ passes: 5, speeding: 5 })])[0].lastSeen).toBeNull();
  });

  it('accepts the index as the Map the store actually holds', () => {
    const index = new Map(road(4).map((at, i) => [`seg-${i}`, segment({ ...at, passes: 6, speeding: 2 })]));
    expect(buildSpeedingStretches(index)).toHaveLength(1);
  });

  it('ranks the more consistent habit first', () => {
    const stretches = buildSpeedingStretches([
      segment({ ...road(1)[0], passes: 10, speeding: 6 }),
      segment({ lat: 43.80, passes: 10, speeding: 10 }),
    ]);

    expect(stretches.map((s) => s.eventRate)).toEqual([1, 0.6]);
  });

  it('ignores segments whose midpoint was never recorded', () => {
    expect(buildSpeedingStretches([
      { tripCount: 20, eventTypes: { speeding: 20 } },
      { lat: null, lng: null, tripCount: 20, eventTypes: { speeding: 20 } },
    ])).toEqual([]);
  });

  it('gives a stable id across rebuilds', () => {
    const build = () => buildSpeedingStretches(road(3).map((at) => segment({ ...at, passes: 5, speeding: 2 })));
    expect(build()[0].id).toBe(build()[0].id);
    expect(build()[0].id.startsWith('sz_')).toBe(true);
  });
});
