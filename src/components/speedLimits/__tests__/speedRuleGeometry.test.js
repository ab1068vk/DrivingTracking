import { describe, expect, it } from 'vitest';
import {
  distanceMeters,
  hasTracedRoadGeometry,
  normalizePointForCompare,
  normalizeSectionPointsForCompare,
  sectionGeometryCompareKey,
  sectionLengthMeters,
  sectionMidpoint,
} from '../speedRuleGeometry';

describe('distanceMeters', () => {
  it('measures a known separation', () => {
    // 0.01 degrees of latitude is ~1.11 km anywhere on the globe.
    expect(distanceMeters({ lat: 51.5, lng: -0.12 }, { lat: 51.51, lng: -0.12 }))
      .toBeCloseTo(1112, 0);
    expect(distanceMeters({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBe(0);
  });

  it('returns Infinity rather than NaN for unusable coordinates', () => {
    // Callers compare against a radius, so a NaN here would silently match.
    expect(distanceMeters({}, {})).toBe(Infinity);
    expect(distanceMeters({ lat: undefined, lng: undefined }, { lat: 51.5, lng: -0.12 })).toBe(Infinity);
  });

  it('treats a redacted coordinate as missing, not as a position at 0,0', () => {
    // Privacy masking nulls coordinates out, and Number(null) is 0 — without an
    // explicit guard these points would read as a real location in the Gulf of
    // Guinea rather than as absent data.
    for (const blank of [null, '', '   ', [], {}, true]) {
      expect(distanceMeters({ lat: blank, lng: blank }, { lat: 51.5, lng: -0.12 })).toBe(Infinity);
      expect(distanceMeters({ lat: 51.5, lng: -0.12 }, { lat: blank, lng: blank })).toBe(Infinity);
    }
    // A genuine zero is still a coordinate.
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    // Numeric strings keep working.
    expect(distanceMeters({ lat: '51.5', lng: '-0.12' }, { lat: 51.51, lng: -0.12 }))
      .toBeCloseTo(1112, 0);
  });
});

describe('section geometry', () => {
  const line = [{ lat: 51.5, lng: -0.12 }, { lat: 51.51, lng: -0.12 }, { lat: 51.52, lng: -0.12 }];

  it('sums consecutive legs', () => {
    expect(sectionLengthMeters(line)).toBeCloseTo(2224, 0);
    expect(sectionLengthMeters([])).toBe(0);
    expect(sectionLengthMeters([line[0]])).toBe(0);
  });

  it('picks a usable midpoint and drops unusable points', () => {
    expect(sectionMidpoint(line)).toEqual({ lat: 51.51, lng: -0.12 });
    expect(sectionMidpoint([{ lat: 'x', lng: 'y' }])).toBeNull();
    expect(sectionMidpoint([])).toBeNull();
  });

  it('treats a degenerate line as untraced', () => {
    expect(hasTracedRoadGeometry({ sectionPoints: line })).toBe(true);
    // Two points at the same place is a dot, not a road line.
    expect(hasTracedRoadGeometry({ sectionPoints: [line[0], { ...line[0] }] })).toBe(false);
    expect(hasTracedRoadGeometry({ sectionPoints: [line[0]] })).toBe(false);
    expect(hasTracedRoadGeometry({})).toBe(false);
  });

  it('rejects out-of-range coordinates before counting points', () => {
    expect(hasTracedRoadGeometry({
      sectionPoints: [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 51.5, lng: -0.12 }],
    })).toBe(false);
  });
});

describe('geometry compare keys', () => {
  it('rounds to a stable precision so redraw noise is not a change', () => {
    expect(normalizePointForCompare({ lat: 51.500000004, lng: -0.120000004 }))
      .toEqual({ lat: 51.5, lng: -0.12 });
    expect(normalizePointForCompare({ lat: 'x', lng: 0 })).toBeNull();
  });

  it('falls back to the section itself when it carries no point list', () => {
    expect(normalizeSectionPointsForCompare({ lat: 51.5, lng: -0.12 }))
      .toEqual([{ lat: 51.5, lng: -0.12 }]);
    expect(normalizeSectionPointsForCompare({ sectionPoints: [], lat: 51.5, lng: -0.12 }))
      .toEqual([{ lat: 51.5, lng: -0.12 }]);
  });

  it('is equal for identical geometry and different for a moved point', () => {
    const a = { sectionPoints: [{ lat: 51.5, lng: -0.12 }, { lat: 51.51, lng: -0.12 }] };
    expect(sectionGeometryCompareKey(a)).toBe(sectionGeometryCompareKey({ ...a }));
    expect(sectionGeometryCompareKey(a))
      .not.toBe(sectionGeometryCompareKey({ sectionPoints: [{ lat: 51.5, lng: -0.12 }] }));
  });
});
