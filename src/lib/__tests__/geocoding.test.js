import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReverseGeocodePrivatePoint, reverseGeocodeIfPermitted } from '@/lib/geocoding';

describe('privacy-gated geocoding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not call Nominatim for coordinates inside a privacy zone guard', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const privacyZones = [{ id: 'home', lat: 43.65, lng: -79.38, radius_m: 100 }];
    const address = await reverseGeocodeIfPermitted(43.6501, -79.38, {
      privacyZones,
      settings: { reverse_geocoding_enabled: true },
    });

    expect(address).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isReverseGeocodePrivatePoint(43.6501, -79.38, privacyZones)).toBe(true);
  });

  it('calls Nominatim for public coordinates and returns the display name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ display_name: 'Queen Street West, Toronto, Ontario, Canada' }),
    })));

    const privacyZones = [{ id: 'home', lat: 43.65, lng: -79.38, radius_m: 100 }];
    const address = await reverseGeocodeIfPermitted(43.66, -79.38, {
      privacyZones,
      settings: { reverse_geocoding_enabled: true },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(address).toBe('Queen Street West, Toronto, Ontario, Canada');
  });

  it('does not call Nominatim unless reverse geocoding is explicitly enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const address = await reverseGeocodeIfPermitted(43.66, -79.38, {
      privacyZones: [],
      settings: { reverse_geocoding_enabled: false },
    });

    expect(address).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
