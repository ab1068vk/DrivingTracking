import { describe, expect, it } from 'vitest';
import { LIVE_ROUTE_BUCKET_POINT_STEP, liveRouteBucketKey } from '@/lib/liveTrackingTelemetry';

const points = (count) => Array.from({ length: count }, (_, index) => ({ lat: 1 + index / 1000, lng: 2 }));

describe('liveRouteBucketKey', () => {
  it('keeps a stable key while fewer than one step of new points arrive', () => {
    const base = liveRouteBucketKey(points(10));
    expect(liveRouteBucketKey(points(11))).toBe(base);
    expect(liveRouteBucketKey(points(12))).toBe(base);
    expect(liveRouteBucketKey(points(13))).toBe(base);
    expect(liveRouteBucketKey(points(14))).toBe(base);
  });

  it('advances once a full step of new points has arrived', () => {
    expect(liveRouteBucketKey(points(15))).not.toBe(liveRouteBucketKey(points(10)));
  });

  it('does not change when the same array is re-read on a render tick', () => {
    const route = points(37);
    expect(liveRouteBucketKey(route)).toBe(liveRouteBucketKey(route));
  });

  it('honours a custom step and encodes it in the key', () => {
    expect(liveRouteBucketKey(points(20), { pointStep: 10 })).toBe('10:2');
    expect(liveRouteBucketKey(points(20))).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:4`);
  });

  it('degrades safely on missing, empty, or invalid input', () => {
    expect(liveRouteBucketKey(undefined)).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:0`);
    expect(liveRouteBucketKey(null)).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:0`);
    expect(liveRouteBucketKey([])).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:0`);
    expect(liveRouteBucketKey('not an array')).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:0`);
    // A zero/NaN step falls back to the default rather than clamping to 1,
    // because a step of 1 would refit the map on every fix.
    expect(liveRouteBucketKey(points(9), { pointStep: 0 })).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:1`);
    expect(liveRouteBucketKey(points(9), { pointStep: Number.NaN })).toBe(`${LIVE_ROUTE_BUCKET_POINT_STEP}:1`);
    expect(liveRouteBucketKey(points(9), { pointStep: -3 })).toBe('1:9');
  });
});
