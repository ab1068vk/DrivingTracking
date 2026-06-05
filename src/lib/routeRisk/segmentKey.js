import {
  ROUTE_RISK_GEOHASH_LOOKUP_PRECISION,
  ROUTE_RISK_GEOHASH_PRECISION,
} from '@/lib/routeRisk/constants';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BASE32_INDEX = new Map([...BASE32].map((char, index) => [char, index]));

const finiteCoord = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function geohashEncode(lat, lng, precision = ROUTE_RISK_GEOHASH_PRECISION) {
  const pointLat = finiteCoord(lat);
  const pointLng = finiteCoord(lng);
  const hashPrecision = Math.max(1, Math.floor(Number(precision) || ROUTE_RISK_GEOHASH_PRECISION));
  if (pointLat == null || pointLng == null) return null;

  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  while (geohash.length < hashPrecision) {
    if (evenBit) {
      const lngMid = (lngMin + lngMax) / 2;
      if (pointLng >= lngMid) {
        idx = (idx << 1) | 1;
        lngMin = lngMid;
      } else {
        idx <<= 1;
        lngMax = lngMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (pointLat >= latMid) {
        idx = (idx << 1) | 1;
        latMin = latMid;
      } else {
        idx <<= 1;
        latMax = latMid;
      }
    }

    evenBit = !evenBit;
    bit += 1;
    if (bit === 5) {
      geohash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

export function geohashBounds(hash) {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized || [...normalized].some((char) => !BASE32_INDEX.has(char))) return null;

  let evenBit = true;
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  for (const char of normalized) {
    let idx = BASE32_INDEX.get(char);
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (evenBit) {
        const lngMid = (lngMin + lngMax) / 2;
        if (idx & mask) lngMin = lngMid;
        else lngMax = lngMid;
      } else {
        const latMid = (latMin + latMax) / 2;
        if (idx & mask) latMin = latMid;
        else latMax = latMid;
      }
      evenBit = !evenBit;
    }
  }

  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax };
}

export function geohashCenter(hash) {
  const bounds = geohashBounds(hash);
  return bounds
    ? { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 }
    : null;
}

export function isRouteRiskHash(value, precision = ROUTE_RISK_GEOHASH_PRECISION) {
  const hash = String(value || '').toLowerCase();
  return hash.length === precision && [...hash].every((char) => BASE32_INDEX.has(char));
}

export function routeRiskLookupPrefixForHash(hash) {
  return String(hash || '').slice(0, ROUTE_RISK_GEOHASH_LOOKUP_PRECISION);
}

/**
 * Returns a privacy-preserving route segment identifier from two coordinates.
 * The key is order-independent because it stores the segment midpoint geohash,
 * not exact endpoint coordinates.
 */
export function segmentKey(lat1, lng1, lat2, lng2) {
  const firstLat = finiteCoord(lat1);
  const firstLng = finiteCoord(lng1);
  const secondLat = finiteCoord(lat2);
  const secondLng = finiteCoord(lng2);
  if (firstLat == null || firstLng == null || secondLat == null || secondLng == null) return null;

  return geohashEncode(
    (firstLat + secondLat) / 2,
    (firstLng + secondLng) / 2,
    ROUTE_RISK_GEOHASH_PRECISION
  );
}
