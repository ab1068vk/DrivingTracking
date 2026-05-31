import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceState = vi.hoisted(() => ({
  values: new Map(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({ value: preferenceState.values.get(key) ?? null })),
    set: vi.fn(async ({ key, value }) => {
      preferenceState.values.set(key, value);
    }),
  },
}));

import { getPrivacyZones, isInPrivacyZone, savePrivacyZones } from '@/lib/trackingStore';

const PRIVACY_ZONES_KEY = 'road_sage_privacy_zones';

describe('trackingStore privacy zones', () => {
  beforeEach(() => {
    preferenceState.values.clear();
  });

  it('round-trips zones through Capacitor Preferences', async () => {
    const zones = [{ name: 'Home', lat: 43.65, lng: -79.38, radius: 200 }];

    await savePrivacyZones(zones);

    expect(JSON.parse(preferenceState.values.get(PRIVACY_ZONES_KEY))).toEqual(zones);
    expect(await getPrivacyZones()).toEqual(zones);
  });

  it('returns an empty list when stored JSON is invalid', async () => {
    preferenceState.values.set(PRIVACY_ZONES_KEY, '{bad json');

    expect(await getPrivacyZones()).toEqual([]);
  });

  it('matches coordinates inside a privacy zone', async () => {
    await savePrivacyZones([{ name: 'Home', lat: 43.65, lng: -79.38, radius: 200 }]);

    expect(await isInPrivacyZone(43.6505, -79.38)).toEqual({ inZone: true, zoneName: 'Home' });
    expect(await isInPrivacyZone(43.66, -79.38)).toEqual({ inZone: false, zoneName: null });
  });
});
