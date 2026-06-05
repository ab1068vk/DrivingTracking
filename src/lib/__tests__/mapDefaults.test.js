import { describe, expect, it } from 'vitest';
import { getBestMapCenter, isValidLatLng } from '@/lib/mapDefaults';

describe('map defaults', () => {
  it('returns null center when no trip, parked location, or known location exists', () => {
    expect(getBestMapCenter({ trip: null, lastParked: null, lastKnownLocation: null })).toBeNull();
  });

  it('prefers trip route midpoint over parked location', () => {
    const center = getBestMapCenter({
      trip: { route_points: [{ lat: 51.5, lng: -0.1 }, { lat: 52.0, lng: -0.5 }] },
      lastParked: { lat: 43.6, lng: -79.4 },
      lastKnownLocation: null,
    });

    expect(center[0]).toBeCloseTo(51.75, 1);
    expect(center[1]).toBeCloseTo(-0.3, 1);
  });

  it('falls back from parked location to last known location', () => {
    expect(getBestMapCenter({
      trip: { route_points: [] },
      lastParked: { lat: 0, lng: 0 },
      lastKnownLocation: { lat: -1.29, lng: 36.82 },
    })).toEqual([-1.29, 36.82]);
  });

  it('rejects invalid and null-sentinel coordinates', () => {
    expect(isValidLatLng(0, 0)).toBe(false);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(12.34, 56.78)).toBe(true);
  });
});
