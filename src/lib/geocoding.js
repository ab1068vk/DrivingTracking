const REVERSE_GEOCODE_TIMEOUT_MS = 8000;
const PRIVACY_GUARD_M = 50;
const EARTH_RADIUS_M = 6371000;
const reverseGeocodeRequests = new Map();

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const distanceMeters = (a, b) => {
  const aLat = finiteNumber(a?.lat);
  const aLng = finiteNumber(a?.lng);
  const bLat = finiteNumber(b?.lat);
  const bLng = finiteNumber(b?.lng);
  if (aLat == null || aLng == null || bLat == null || bLng == null) return Number.POSITIVE_INFINITY;

  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};

const zoneRadiusM = (zone) => {
  const radius = finiteNumber(zone?.radius_m) ?? finiteNumber(zone?.radius);
  return radius != null && radius > 0 ? radius : 0;
};

export const isReverseGeocodePrivatePoint = (lat, lng, privacyZones = [], guardM = PRIVACY_GUARD_M) => {
  if (finiteNumber(lat) == null || finiteNumber(lng) == null) return true;
  const point = { lat: Number(lat), lng: Number(lng) };
  return (Array.isArray(privacyZones) ? privacyZones : []).some((zone) => {
    const radiusM = zoneRadiusM(zone);
    return radiusM > 0 && distanceMeters(point, zone) <= radiusM + guardM;
  });
};

export async function reverseGeocodeIfPermitted(lat, lng, options = {}) {
  const {
    privacyZones = [],
    guardM = PRIVACY_GUARD_M,
    shorten = false,
    shortenAddress,
  } = options;

  if (typeof fetch !== 'function') return null;
  if (isReverseGeocodePrivatePoint(lat, lng, privacyZones, guardM)) return null;

  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)},${shorten ? 'short' : 'full'}`;
  if (reverseGeocodeRequests.has(key)) return reverseGeocodeRequests.get(key);

  const request = (async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), REVERSE_GEOCODE_TIMEOUT_MS)
      : null;

    try {
      const params = new URLSearchParams({
        format: 'jsonv2',
        lat: String(lat),
        lon: String(lng),
        zoom: '17',
        addressdetails: '0',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
        },
        signal: controller?.signal,
      });
      if (!response.ok) return null;

      const data = await response.json();
      const address = data?.display_name || null;
      return shorten && typeof shortenAddress === 'function' ? shortenAddress(address) : address;
    } catch {
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  reverseGeocodeRequests.set(key, request);
  try {
    return await request;
  } finally {
    reverseGeocodeRequests.delete(key);
  }
}
