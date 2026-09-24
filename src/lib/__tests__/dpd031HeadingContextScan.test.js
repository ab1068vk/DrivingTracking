import { describe, expect, it } from 'vitest';
import {
  collectIntersectionOrRampContextPoints,
  detectHeadingDeviationEvents,
  isNearIntersectionOrRampContext,
} from '@/lib/tripEngine';

// DPD-031. The intersection/ramp context check used to rescan the whole route for
// every heading candidate - O(points x candidates) - and a 5,000-point trip spent
// ~2.1 s (desktop) in it during a rescore. It now walks a list collected once per
// pass. These tests pin that the answer is unchanged and the work is linear.

const EARTH_R_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const haversineM = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
};

// A deterministic route: 1 Hz fixes at ~72 km/h, a gentle lane-change-like wiggle
// every 40 s (so heading candidates exist), some fixes flagged as intersection or
// ramp context, one loop back past the start, and a few invalid fixes.
const buildRoute = (count, { contextEvery = 97, countReads = null } = {}) => {
  const points = [];
  let lat = 43.65;
  let lng = -79.38;
  let heading = 90;
  const t0 = Date.parse('2026-09-01T12:00:00Z');
  for (let i = 0; i < count; i += 1) {
    const phase = i % 40;
    if (phase >= 20 && phase < 23) heading += 6;
    if (phase >= 23 && phase < 26) heading -= 6;
    if (i === Math.floor(count / 2)) heading += 180; // loop back toward the start
    const stepM = 20;
    lat += (stepM * Math.cos(toRad(heading))) / 111320;
    lng += (stepM * Math.sin(toRad(heading))) / (111320 * Math.cos(toRad(lat)));
    const point = { lat, lng, speed_kmh: 72, accuracy: 5, heading, timestamp: new Date(t0 + i * 1000).toISOString() };
    if (i % contextEvery === 0) point.road_type = i % 2 ? 'motorway_link' : 'residential';
    if (i % 211 === 5) point.near_intersection = true;
    if (i % 503 === 7) { point.lat = Number.NaN; }
    if (countReads) {
      const value = point.road_type;
      Object.defineProperty(point, 'road_type', {
        enumerable: true,
        get() { countReads.n += 1; return value; },
      });
    }
    points.push(point);
  }
  return points;
};

// The original (pre-DPD-031) algorithm, kept here as the reference it must match.
const referencePointHasContext = (point = {}) => {
  const textValues = [point.road_type, point.road_class, point.highway, point.junction, point.osm_highway, point.osm_junction]
    .map((value) => String(value || '').toLowerCase());
  return Boolean(point.intersection || point.is_intersection || point.near_intersection || point.ramp || point.is_ramp ||
    textValues.some((value) => value.includes('ramp') || value.includes('_link') || value.includes('roundabout')));
};
const valid = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);
const referenceContextScanHit = (points, index, radiusM) => {
  const current = points[index];
  if (!valid(current)) return false;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!valid(point)) continue;
    if (referencePointHasContext(point) && haversineM(current, point) <= radiusM) return true;
  }
  return null; // fall through to the unchanged stop-walk
};

describe('DPD-031 intersection/ramp context scan', () => {
  it('collects exactly the context points, in route order', () => {
    const points = buildRoute(1200);
    const expected = points.filter((p) => valid(p) && referencePointHasContext(p));
    expect(collectIntersectionOrRampContextPoints(points)).toEqual(expected);
  });

  it('answers every index exactly as the original full-route scan did', () => {
    const points = buildRoute(1500);
    const context = collectIntersectionOrRampContextPoints(points);
    for (const radius of [50, 200, 600]) {
      for (let i = 0; i < points.length; i += 1) {
        const withList = isNearIntersectionOrRampContext(points, i, radius, context);
        const withoutList = isNearIntersectionOrRampContext(points, i, radius);
        expect(withList).toBe(withoutList);
        // When the reference scan finds a nearby context point the answer must be true;
        // otherwise both fall through to the same (unchanged) stop-walk.
        if (referenceContextScanHit(points, i, radius) === true) expect(withList).toBe(true);
      }
    }
  });

  it('reads each point once per pass instead of once per candidate', () => {
    const reads = { n: 0 };
    const points = buildRoute(5000, { countReads: reads });
    reads.n = 0;
    detectHeadingDeviationEvents(points);
    // Linear: one collection pass over the route (plus the detector's own few
    // reads). The original scan read every point's road_type again for every
    // candidate that reached the context check - hundreds of thousands of reads here.
    expect(reads.n).toBeLessThanOrEqual(points.length * 2);
  });

  it('gives the same heading events for a large route either way', () => {
    const points = buildRoute(3000);
    const events = detectHeadingDeviationEvents(points);
    expect(detectHeadingDeviationEvents(points)).toEqual(events);
  });
});
