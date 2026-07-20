const MAX_TERMINAL_WINDOW_MS = 5 * 60 * 1000;
const MAX_TERMINAL_POINTS = 32;
const VEHICLE_SPEED_KMH = 12;
const STOP_SPEED_KMH = 8;
const MAX_STOP_CLUSTER_RADIUS_M = 60;

const validCoordinate = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0);
};

const timestampMs = (point) => {
  const parsed = Date.parse(String(point?.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const distanceM = (first, second) => {
  const toRad = Math.PI / 180;
  const lat1 = Number(first.lat) * toRad;
  const lat2 = Number(second.lat) * toRad;
  const dLat = lat2 - lat1;
  const dLng = (Number(second.lng) - Number(first.lng)) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
};

const pointAccuracyM = (point) => {
  const value = Number(point?.accuracy);
  return Number.isFinite(value) && value >= 0 ? value : 100;
};

const selectRecordedMedoid = (points) => points.reduce((best, candidate) => {
  const distanceScore = points.reduce((sum, point) => sum + Math.min(200, distanceM(candidate, point)), 0);
  const score = distanceScore + pointAccuracyM(candidate) * 0.35;
  return !best || score < best.score ? { point: candidate, score } : best;
}, null)?.point || points[points.length - 1];

const buildTerminalWindow = (points) => {
  const valid = (Array.isArray(points) ? points : []).filter(validCoordinate);
  if (!valid.length) return [];
  const endpointMs = timestampMs(valid[valid.length - 1]);
  return valid
    .filter((point) => !endpointMs || !timestampMs(point) || endpointMs - timestampMs(point) <= MAX_TERMINAL_WINDOW_MS)
    .slice(-MAX_TERMINAL_POINTS);
};

const terminalStopCluster = (window) => {
  let lastVehicleIndex = -1;
  window.forEach((point, index) => {
    if (Number(point?.speed_kmh) >= VEHICLE_SPEED_KMH && pointAccuracyM(point) <= 60) lastVehicleIndex = index;
  });

  if (lastVehicleIndex >= 0 && lastVehicleIndex < window.length - 1) {
    const cluster = [];
    let anchor = null;
    for (const point of window.slice(lastVehicleIndex + 1)) {
      if (pointAccuracyM(point) > 50) continue;
      const speed = Number(point?.speed_kmh);
      if (Number.isFinite(speed) && speed > STOP_SPEED_KMH) {
        if (cluster.length) break;
        continue;
      }
      anchor ||= point;
      if (distanceM(anchor, point) > MAX_STOP_CLUSTER_RADIUS_M) break;
      cluster.push(point);
    }
    if (cluster.length) return cluster;
  }

  const endpoint = window[window.length - 1];
  return window.slice(-8).filter((point) => {
    const speed = Number(point?.speed_kmh);
    return distanceM(endpoint, point) <= MAX_STOP_CLUSTER_RADIUS_M &&
      (!Number.isFinite(speed) || speed <= STOP_SPEED_KMH);
  });
};

/**
 * Resolves a privacy-safe parking candidate from the terminal GPS fixes.
 * The returned coordinate is always one of the recorded fixes, never a fabricated centroid.
 */
export function resolveParkedLocation(points, { endTime } = {}) {
  const sourcePoints = Array.isArray(points) ? points : [];
  const rawEndpoint = sourcePoints[sourcePoints.length - 1];
  if (rawEndpoint?.masked_for_privacy || rawEndpoint?.privacy_gap || rawEndpoint?.privacy_live_redacted) {
    return { location: null, suppressionReason: 'privacy_zone' };
  }
  if (!validCoordinate(rawEndpoint)) {
    return { location: null, suppressionReason: 'trip_end_unavailable' };
  }

  const window = buildTerminalWindow(sourcePoints);
  const cluster = terminalStopCluster(window);
  const candidates = cluster.length ? cluster : [rawEndpoint];
  const selected = selectRecordedMedoid(candidates);
  const spreadM = Math.max(0, ...candidates.map((point) => distanceM(selected, point)));
  const firstMs = timestampMs(candidates[0]);
  const lastMs = timestampMs(candidates[candidates.length - 1]);
  const durationSeconds = firstMs && lastMs ? Math.max(0, (lastMs - firstMs) / 1000) : 0;
  const accuracyM = pointAccuracyM(selected);
  const confidence = candidates.length >= 3 && durationSeconds >= 20 && spreadM <= 25 && accuracyM <= 20
    ? 'high'
    : candidates.length >= 2 && spreadM <= 60 && accuracyM <= 40
      ? 'medium'
      : 'estimated';

  return {
    location: {
      lat: Number(selected.lat),
      lng: Number(selected.lng),
      endpointLat: Number(rawEndpoint.lat),
      endpointLng: Number(rawEndpoint.lng),
      timestamp: endTime || selected.timestamp || new Date().toISOString(),
      accuracyM: Number.isFinite(accuracyM) ? Math.round(accuracyM) : null,
      confidence,
      strategy: candidates.length > 1 ? 'terminal_stop_cluster' : 'last_trip_point',
      sampleCount: candidates.length,
      spreadM: Math.round(spreadM),
    },
    suppressionReason: null,
  };
}
