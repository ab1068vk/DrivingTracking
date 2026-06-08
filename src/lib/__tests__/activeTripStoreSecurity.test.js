import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeTripStore, localSettings } from '@/lib/trackingStore';

describe('activeTripStore encryption', () => {
  afterEach(async () => {
    activeTripStore.clear();
    await activeTripStore.flush();
    vi.unstubAllGlobals();
  });

  it('keeps crash-recovery GPS coordinates out of plaintext storage', async () => {
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const trip = {
      id: 'active-trip',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    };

    activeTripStore.set(trip);
    await activeTripStore.flush();

    const stored = values.get('drivesense_active_trip');
    expect(stored).toContain('"encrypted":true');
    expect(stored).not.toContain('43.6532');
    expect(stored).not.toContain('-79.3832');
    await expect(activeTripStore.hydrate()).resolves.toEqual(trip);
  });

  it('migrates legacy plaintext crash-recovery data during hydration', async () => {
    const values = new Map([[
      'drivesense_active_trip',
      JSON.stringify({ route_points: [{ lat: 43.65, lng: -79.38 }] }),
    ]]);
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const recovered = await activeTripStore.hydrate();
    const stored = values.get('drivesense_active_trip');

    expect(recovered.route_points[0]).toEqual({ lat: 43.65, lng: -79.38 });
    expect(stored).toContain('"encrypted":true');
    expect(stored).not.toContain('43.65');
    expect(stored).not.toContain('-79.38');
  });

  it('redacts private live points added directly to the active trip store', async () => {
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    localSettings.set({
      ...localSettings.get(),
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 150 }],
    });
    activeTripStore.set({ id: 'active-trip', route_points: [] });

    activeTripStore.addPoint({
      lat: 43.65,
      lng: -79.38,
      latitude: 43.65,
      longitude: -79.38,
      original_lat: 43.65,
      original_lng: -79.38,
      speed_kmh: 12,
      timestamp: '2026-01-01T12:00:00.000Z',
    });
    await activeTripStore.flush();

    const storedPoint = activeTripStore.get().route_points[0];
    expect(storedPoint).toMatchObject({
      lat: null,
      lng: null,
      speed_kmh: 12,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_live_redacted: true,
      privacy_zone_id: 'home',
    });
    expect(JSON.stringify(storedPoint)).not.toContain('43.65');
    expect(JSON.stringify(storedPoint)).not.toContain('-79.38');
    expect(storedPoint.latitude).toBeUndefined();
    expect(storedPoint.longitude).toBeUndefined();

    const stored = values.get('drivesense_active_trip');
    expect(stored).toContain('"encrypted":true');
    expect(stored).not.toContain('43.65');
    expect(stored).not.toContain('-79.38');
  });
});
