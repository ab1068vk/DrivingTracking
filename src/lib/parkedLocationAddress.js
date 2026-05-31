const PARKED_GEOCODE_TIMEOUT_MS = 4000;
const parkedGeocodeRequests = new Map();

const parkedGeocodeKey = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

export const shortenParkedAddress = (address) => {
  const trimmed = String(address || '').trim();
  if (!trimmed) return null;

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return trimmed;
};

export async function reverseGeocodeParkedLocation(lat, lng) {
  if (typeof fetch !== 'function') return null;

  const key = parkedGeocodeKey(lat, lng);
  if (parkedGeocodeRequests.has(key)) return parkedGeocodeRequests.get(key);

  const request = (async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), PARKED_GEOCODE_TIMEOUT_MS)
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
        headers: { Accept: 'application/json' },
        signal: controller?.signal,
      });
      if (!response.ok) return null;

      const data = await response.json();
      return shortenParkedAddress(data?.display_name);
    } catch {
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  parkedGeocodeRequests.set(key, request);
  try {
    return await request;
  } finally {
    parkedGeocodeRequests.delete(key);
  }
}
