import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeTripStore, saveLastMapCenter } from '@/lib/trackingStore';
import { truncateCoord, truncateRoutePoint, truncateRoutePoints, truncateTripCoordinates } from '@/lib/gps/sanitize';

describe('GPS coordinate sanitization', () => {
  let originalLocalStorage;
  let values;
  let setItemCalls;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    values = new Map();
    setItemCalls = [];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          setItemCalls.push([key, String(value)]);
          values.set(key, String(value));
        },
        removeItem: (key) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('quantizes coordinates to five decimals and altitude to whole meters', () => {
    expect(truncateCoord(43.65123456789)).toBe(43.65123);
    expect(truncateCoord(-79.38329876543)).toBe(-79.3833);
    expect(truncateRoutePoint({
      lat: 43.65123456789,
      lng: -79.38329876543,
      altitude: 184.72,
      alt: 184.21,
    })).toMatchObject({
      lat: 43.65123,
      lng: -79.3833,
      altitude: 185,
      alt: 184,
    });
  });

  it('sanitizes route point arrays and trip records before storage', () => {
    const points = truncateRoutePoints([
      { lat: 43.65123456789, lng: -79.38329876543 },
      { lat: 43.65123999999, lng: -79.38329111111 },
    ]);

    expect(points).toEqual([
      { lat: 43.65123, lng: -79.3833 },
      { lat: 43.65124, lng: -79.38329 },
    ]);
    expect(truncateTripCoordinates({ route_points: points, name: 'trip' })).toMatchObject({
      route_points: points,
      name: 'trip',
    });
  });

  it('sanitizes active trip and map-center persistence boundaries', () => {
    localStorage.clear();
    activeTripStore.set({
      start_time: '2026-01-01T12:00:00.000Z',
      status: 'active',
      route_points: [{ lat: 43.65123456789, lng: -79.38329876543, altitude: 184.72 }],
    });

    expect(activeTripStore.get().route_points[0]).toMatchObject({
      lat: 43.65123,
      lng: -79.3833,
      altitude: 185,
    });
    expect(JSON.parse(localStorage.getItem('road_sage_active_trip')).route_points).toBeUndefined();

    saveLastMapCenter({ lat: 43.65123456789, lng: -79.38329876543 });
    expect(JSON.parse(localStorage.getItem('road_sage_settings')).last_map_center).toMatchObject({
      lat: 43.65123,
      lng: -79.3833,
    });
  });

  it('appends live route points without writing active trip storage', () => {
    localStorage.clear();
    activeTripStore.set({
      start_time: '2026-01-01T12:00:00.000Z',
      status: 'active',
      route_points: [],
    });
    setItemCalls = [];

    const updated = activeTripStore.addPoint({
      lat: 43.65123456789,
      lng: -79.38329876543,
      altitude: 184.72,
    });

    expect(updated.route_points).toHaveLength(1);
    expect(updated.route_points[0]).toMatchObject({
      lat: 43.65123,
      lng: -79.3833,
      altitude: 185,
    });
    expect(setItemCalls.filter(([key]) => key === 'road_sage_active_trip')).toHaveLength(0);
  });
});
