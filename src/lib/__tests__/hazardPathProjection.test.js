/**
 * The live hazard warning used to say "N m ahead" without ever consulting a
 * heading, so a zone behind the car or on the parallel carriageway spoke exactly
 * like one on the road in front. These tests pin the geometry that replaced it:
 * behind is measured, off-path is measured, and the warning is expressed in
 * seconds so it does not silently shrink as speed rises.
 */
import { describe, expect, it } from 'vitest';
import {
  HAZARD_CORRIDOR_MAX_HALF_WIDTH_M,
  HAZARD_HORIZON_ALERT_SECONDS,
  HAZARD_PROJECTION_MAX_M,
  HAZARD_PROJECTION_MIN_M,
} from '@/lib/appConstants';
import {
  bearingDeltaDeg,
  projectHazardPath,
  relativeToProjectedPath,
  resolveTravelHeading,
} from '@/lib/hazard/hazardPathProjection';

const M_PER_DEG = 111320;
const ORIGIN = { lat: 51.5, lng: -0.12 };

/** Mirrors the module's own offset maths so fixtures are expressed in metres and bearings. */
const pointAt = (origin, bearingDeg, distanceM) => {
  const rad = (bearingDeg * Math.PI) / 180;
  const cosLat = Math.abs(Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: origin.lat + (Math.cos(rad) * distanceM) / M_PER_DEG,
    lng: origin.lng + (Math.sin(rad) * distanceM) / (M_PER_DEG * cosLat),
  };
};

/** `count` fixes ending at ORIGIN, spaced `spacingM` apart along `bearingDeg`, 1 s apart. */
const track = (bearingDeg, spacingM, count, startMs = 1_700_000_000_000) => {
  const points = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    points.push({
      ...pointAt(ORIGIN, (bearingDeg + 180) % 360, spacingM * i),
      timestamp: new Date(startMs + (count - 1 - i) * 1000).toISOString(),
    });
  }
  return points;
};

const eastwardPath = ({ speedKmh = 60, accuracyM = 0, turnRateDegPerS = 0 } = {}) => projectHazardPath({
  ...ORIGIN,
  headingDeg: 90,
  speedKmh,
  accuracyM,
  turnRateDegPerS,
  horizonSeconds: HAZARD_HORIZON_ALERT_SECONDS,
});

describe('bearingDeltaDeg', () => {
  it('does not fold a reciprocal bearing onto zero the way corridor alignment does', () => {
    // localCorridorGraph.bearingDelta returns 0 here because two road segments
    // pointing opposite ways are the same corridor. For a hazard, 180 is behind.
    expect(bearingDeltaDeg(90, 270)).toBe(180);
    expect(bearingDeltaDeg(10, 350)).toBe(20);
  });
});

describe('resolveTravelHeading', () => {
  it('trusts the reported GPS heading above the trust speed', () => {
    const points = track(90, 10, 4);
    points[points.length - 1].heading = 92;
    const result = resolveTravelHeading(points, { speedKmh: 60 });
    expect(result.source).toBe('gps');
    expect(result.headingDeg).toBe(92);
  });

  it('falls back to a derived heading when a reported heading exists but the vehicle is barely moving', () => {
    const points = track(90, 10, 5);
    points[points.length - 1].heading = 270;
    const result = resolveTravelHeading(points, { speedKmh: 4 });
    expect(result.source).toBe('derived');
    expect(bearingDeltaDeg(result.headingDeg, 90)).toBeLessThan(5);
  });

  it('derives a heading from a real baseline when none is reported', () => {
    const result = resolveTravelHeading(track(90, 6, 6), { speedKmh: 40 });
    expect(result.source).toBe('derived');
    expect(result.baselineM).toBeGreaterThanOrEqual(25);
    expect(bearingDeltaDeg(result.headingDeg, 90)).toBeLessThan(5);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('abstains when recent displacement is only a few metres', () => {
    // This is the headingForIndex trap: one GPS step at low speed is a baseline
    // inside the noise, and a bearing taken over it points anywhere.
    const result = resolveTravelHeading(track(90, 0.6, 6), { speedKmh: 40 });
    expect(result.source).toBe('none');
    expect(result.headingDeg).toBeNull();
  });

  it('will not derive a heading across a tracking gap', () => {
    // Tunnels, OEM kills and permission drops all resume tracking minutes later.
    // The points on the far side describe where the vehicle used to be pointing.
    const points = track(90, 10, 5, 1_700_000_000_000 - 120_000);
    points.push({ ...ORIGIN, timestamp: new Date(1_700_000_000_000).toISOString() });
    const result = resolveTravelHeading(points, { speedKmh: 40 });
    expect(result.source).toBe('none');
  });

  it('reads a steady curve as turn rate rather than as jitter', () => {
    const points = [];
    let cursor = { ...ORIGIN };
    for (let i = 0; i < 6; i += 1) {
      points.push({ ...cursor, timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString() });
      cursor = pointAt(cursor, 90 + i * 10, 15);
    }
    const result = resolveTravelHeading(points, { speedKmh: 54 });
    expect(result.turnRateDegPerS).toBeGreaterThan(5);
    expect(result.spreadDeg).toBeLessThan(2);
  });
});

describe('projectHazardPath', () => {
  it('clamps corridor length at both ends of the speed range', () => {
    expect(eastwardPath({ speedKmh: 200 }).lengthM).toBe(HAZARD_PROJECTION_MAX_M);
    expect(eastwardPath({ speedKmh: 16 }).lengthM).toBe(HAZARD_PROJECTION_MIN_M);
  });

  it('widens with distance but never past the cap', () => {
    const path = eastwardPath();
    const widths = [0, 100, 200, 400, 900].map((d) => path.halfWidthAt(d));
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
    expect(Math.max(...widths)).toBeLessThanOrEqual(HAZARD_CORRIDOR_MAX_HALF_WIDTH_M);
  });

  it('bends with the turn rate instead of running straight past the bend', () => {
    const straight = eastwardPath({ speedKmh: 72 });
    const turning = eastwardPath({ speedKmh: 72, turnRateDegPerS: 10 });
    const straightEnd = straight.points[straight.points.length - 1];
    const turningEnd = turning.points[turning.points.length - 1];
    expect(straight.lengthM).toBeCloseTo(turning.lengthM, 5);
    // Same distance travelled, materially different place.
    const separationM = Math.hypot(
      (turningEnd.lat - straightEnd.lat) * M_PER_DEG,
      (turningEnd.lng - straightEnd.lng) * M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)
    );
    expect(separationM).toBeGreaterThan(50);
  });

  it('returns null rather than a corridor when the vehicle is stopped', () => {
    expect(eastwardPath({ speedKmh: 0 })).toBeNull();
  });
});

describe('relativeToProjectedPath', () => {
  it('places a hazard dead ahead on the corridor centreline', () => {
    const path = eastwardPath();
    const result = relativeToProjectedPath(path, pointAt(ORIGIN, 90, 200));
    expect(result.alongTrackM).toBeCloseTo(200, 0);
    expect(result.crossTrackM).toBeLessThan(1);
    expect(result.onPath).toBe(true);
    expect(result.behind).toBe(false);
  });

  it('reports a hazard directly behind as behind, not as 200 m ahead', () => {
    const path = eastwardPath();
    const result = relativeToProjectedPath(path, pointAt(ORIGIN, 270, 200), { behindToleranceM: 15 });
    expect(result.alongTrackM).toBeLessThan(0);
    expect(result.behind).toBe(true);
    expect(result.onPath).toBe(false);
  });

  it('rejects a hazard on the parallel road 60 m to the side', () => {
    const path = eastwardPath();
    const beside = pointAt(pointAt(ORIGIN, 90, 200), 180, 60);
    const result = relativeToProjectedPath(path, beside);
    expect(result.alongTrackM).toBeCloseTo(200, 0);
    expect(result.crossTrackM).toBeCloseTo(60, 0);
    expect(path.halfWidthAt(200)).toBeLessThan(60);
    expect(result.onPath).toBe(false);
  });

  it('converts the same distance into very different warning times by speed', () => {
    // The old radius alerted at 140 m regardless. In seconds the two drives are
    // nothing alike: one is not worth speaking about yet, the other is nearly
    // past the point where a warning still helps.
    const target = pointAt(ORIGIN, 90, 140);
    const slow = relativeToProjectedPath(eastwardPath({ speedKmh: 30 }), target);
    const fast = relativeToProjectedPath(eastwardPath({ speedKmh: 110 }), target);
    expect(slow.etaSeconds).toBeCloseTo(16.8, 1);
    expect(fast.etaSeconds).toBeCloseTo(4.6, 1);
    expect(slow.etaSeconds).toBeGreaterThan(HAZARD_HORIZON_ALERT_SECONDS);
    expect(fast.etaSeconds).toBeLessThan(HAZARD_HORIZON_ALERT_SECONDS);
  });

  it('truncates a hazard beyond the corridor to the corridor end, keeping it outside the alert band', () => {
    // A corridor is only projected HAZARD_PROJECTION_SLACK past the alert band,
    // so anything past its end reports an eta above the band and is suppressed
    // rather than being silently pulled forward.
    const path = eastwardPath({ speedKmh: 30 });
    const result = relativeToProjectedPath(path, pointAt(ORIGIN, 90, 400));
    expect(result.alongTrackM).toBeCloseTo(path.lengthM, 0);
    expect(result.etaSeconds).toBeGreaterThan(HAZARD_HORIZON_ALERT_SECONDS);
  });

  it('keeps a hazard on the inside of a bend on the corridor', () => {
    const path = eastwardPath({ speedKmh: 72, turnRateDegPerS: 8 });
    const onArc = path.points[Math.floor(path.points.length / 2)];
    const result = relativeToProjectedPath(path, onArc);
    expect(result.crossTrackM).toBeLessThan(1);
    expect(result.onPath).toBe(true);
  });
});
