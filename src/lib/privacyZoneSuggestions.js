import { localTripRepository } from '@/lib/localTripRepository';
import {
  getHydratedPrivacyZones,
  PRIVACY_RADIUS_DEFAULT_M,
  PRIVACY_RADIUS_MAX_M,
  PRIVACY_RADIUS_MIN_M,
  privacyZoneDistanceM,
} from '@/lib/privacyZones';
import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { logSystemFailure } from '@/lib/systemLog';
import { localSettings } from '@/lib/trackingStore';

export const PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY = 'drivesense_privacy_zone_suggestion_dismissals_v1';
export const PRIVACY_ZONE_SUGGESTION_MIN_OCCURRENCE_DAYS = 5;
export const PRIVACY_ZONE_SUGGESTION_DISMISSAL_MS = 90 * 24 * 60 * 60 * 1000;
export const PRIVACY_ZONE_SUGGESTION_CLUSTER_RADIUS_M = PRIVACY_RADIUS_DEFAULT_M;

const finiteCoordinate = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isRawEndpoint = (point = {}) => (
  finiteCoordinate(point.lat) != null &&
  finiteCoordinate(point.lng) != null &&
  point.masked_for_privacy !== true &&
  point.privacy_gap !== true &&
  point.privacy_boundary !== true &&
  point.privacy_purged !== true &&
  point.privacy_live_redacted !== true
);

const localDayKey = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
};

const endpointFromTrip = (trip, edge) => {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const ordered = edge === 'start' ? routePoints : [...routePoints].reverse();
  const point = ordered.find(isRawEndpoint);
  if (!point) return null;
  const timestamp = new Date(
    edge === 'start'
      ? trip.start_time || point.timestamp
      : trip.end_time || point.timestamp
  ).getTime();
  const dayKey = localDayKey(timestamp);
  if (!dayKey) return null;
  return {
    lat: Number(point.lat),
    lng: Number(point.lng),
    timestamp,
    dayKey,
  };
};

const tripEndpoints = (trips = []) => (
  (Array.isArray(trips) ? trips : []).flatMap((trip) => (
    [endpointFromTrip(trip, 'start'), endpointFromTrip(trip, 'end')].filter(Boolean)
  ))
);

const clusterEndpoints = (points = []) => {
  const parents = points.map((_, index) => index);
  const ranks = points.map(() => 0);
  const buckets = new Map();
  const cellSizeM = PRIVACY_ZONE_SUGGESTION_CLUSTER_RADIUS_M;
  const find = (index) => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (ranks[rootA] < ranks[rootB]) parents[rootA] = rootB;
    else if (ranks[rootA] > ranks[rootB]) parents[rootB] = rootA;
    else {
      parents[rootB] = rootA;
      ranks[rootA] += 1;
    }
  };
  const projectedCell = (point) => {
    const latitudeRadians = point.lat * Math.PI / 180;
    return {
      x: Math.floor((point.lng * 111320 * Math.cos(latitudeRadians)) / cellSizeM),
      y: Math.floor((point.lat * 111320) / cellSizeM),
    };
  };

  points.forEach((point, index) => {
    const cell = projectedCell(point);
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = buckets.get(`${cell.x + xOffset}:${cell.y + yOffset}`) || [];
        nearby.forEach((candidateIndex) => {
          if (
            privacyZoneDistanceM(point, points[candidateIndex]) <=
            PRIVACY_ZONE_SUGGESTION_CLUSTER_RADIUS_M
          ) {
            union(index, candidateIndex);
          }
        });
      }
    }
    const key = `${cell.x}:${cell.y}`;
    buckets.set(key, [...(buckets.get(key) || []), index]);
  });

  return Array.from(points.reduce((groups, point, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(point);
    groups.set(root, group);
    return groups;
  }, new Map()).values());
};

const clusterCenter = (points) => ({
  lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
  lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
});

const percentileRadius = (points, center) => {
  const distances = points
    .map((point) => privacyZoneDistanceM(point, center))
    .sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(distances.length * 0.9) - 1);
  return Math.max(
    PRIVACY_RADIUS_MIN_M,
    Math.min(PRIVACY_RADIUS_MAX_M, Math.ceil(distances[index] || 0))
  );
};

const fingerprintForCenter = async (center) => {
  const input = `${Number(center.lat).toFixed(3)}|${Number(center.lng).toFixed(3)}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === 'undefined') {
    throw new Error('Privacy-zone suggestion fingerprinting requires SHA-256 support.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const activeDismissals = async (now) => {
  const stored = await getEncryptedJson(PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY, []);
  const normalized = (Array.isArray(stored) ? stored : [])
    .filter((item) => (
      typeof item?.fingerprint === 'string' &&
      Number.isFinite(Number(item?.expiresAt)) &&
      Number(item.expiresAt) > now
    ))
    .map((item) => ({
      fingerprint: item.fingerprint,
      expiresAt: Number(item.expiresAt),
    }));
  if (normalized.length !== (Array.isArray(stored) ? stored.length : 0)) {
    await setEncryptedJson(PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY, normalized);
  }
  return normalized;
};

export async function getPrivacyZoneSuggestions({
  trips = null,
  zones = null,
  now = Date.now(),
} = {}) {
  try {
    const sourceTrips = Array.isArray(trips)
      ? trips
      : await localTripRepository.listAll({ sort: '-start_time' });
    const existingZones = Array.isArray(zones)
      ? zones
      : await getHydratedPrivacyZones(localSettings.get()).catch((error) => {
        logSystemFailure('privacy_zone_suggestions_zone_load_failed', error, {});
        return [];
      });
    const dismissals = await activeDismissals(now);
    const dismissed = new Set(dismissals.map((item) => item.fingerprint));
    const candidates = [];

    for (const points of clusterEndpoints(tripEndpoints(sourceTrips))) {
      const occurrenceDays = new Set(points.map((point) => point.dayKey)).size;
      if (occurrenceDays < PRIVACY_ZONE_SUGGESTION_MIN_OCCURRENCE_DAYS) continue;
      const suggestedCenter = clusterCenter(points);
      if (existingZones.some((zone) => (
        privacyZoneDistanceM(zone, suggestedCenter) <= PRIVACY_RADIUS_MAX_M
      ))) continue;
      if (dismissed.has(await fingerprintForCenter(suggestedCenter))) continue;

      candidates.push({
        suggestedCenter,
        suggestedRadiusM: percentileRadius(points, suggestedCenter),
        occurrenceDays,
        firstSeenAt: Math.min(...points.map((point) => point.timestamp)),
        lastSeenAt: Math.max(...points.map((point) => point.timestamp)),
      });
    }

    return candidates.sort((a, b) => (
      b.occurrenceDays - a.occurrenceDays ||
      b.lastSeenAt - a.lastSeenAt
    ));
  } catch (error) {
    logSystemFailure('privacy_zone_suggestions_failed', error, {
      trip_count: Array.isArray(trips) ? trips.length : undefined,
      zone_count: Array.isArray(zones) ? zones.length : undefined,
    });
    return [];
  }
}

export async function dismissPrivacyZoneSuggestion(suggestion, now = Date.now()) {
  try {
    const fingerprint = await fingerprintForCenter(suggestion?.suggestedCenter || {});
    const dismissals = await activeDismissals(now);
    const next = dismissals
      .filter((item) => item.fingerprint !== fingerprint)
      .concat({
        fingerprint,
        expiresAt: now + PRIVACY_ZONE_SUGGESTION_DISMISSAL_MS,
      });
    await setEncryptedJson(PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY, next);
  } catch (error) {
    logSystemFailure('privacy_zone_suggestion_dismiss_failed', error, {
      has_suggestion: Boolean(suggestion),
    });
    throw error;
  }
}

export function privacyZoneDraftFromSuggestion(suggestion = {}) {
  return {
    label: 'Suggested private place',
    radius_m: String(Math.round(Number(suggestion.suggestedRadiusM) || PRIVACY_RADIUS_DEFAULT_M)),
    location: {
      lat: Number(suggestion?.suggestedCenter?.lat),
      lng: Number(suggestion?.suggestedCenter?.lng),
    },
  };
}
