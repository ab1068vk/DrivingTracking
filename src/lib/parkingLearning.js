import { getJson, setJson } from '@/lib/mobileStorage';

export const PARKING_LEARNING_KEY = 'drivesense_parking_learning_v1';
export const PARKING_LEARNING_CHANGED_EVENT = 'roadsage-parking-learning-changed';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const count = (value) => Math.round(clamp(value, 0, 1000));

const deriveProfile = (value = {}) => {
  value = value && typeof value === 'object' ? value : {};
  const rejected_count = count(value.rejected_count);
  const marker_correction_count = count(value.marker_correction_count);
  const large_marker_correction_count = count(value.large_marker_correction_count);
  const verified_count = count(value.verified_count);
  const feedback_count = rejected_count + marker_correction_count + verified_count;
  const average_marker_move_m = marker_correction_count > 0
    ? Math.round(clamp(value.average_marker_move_m, 0, 1000))
    : 0;
  const errorWeight = rejected_count * 2 +
    marker_correction_count * 0.5 +
    large_marker_correction_count;
  const reviewedWeight = Math.max(1, feedback_count);
  const errorRate = errorWeight / reviewedWeight;
  const strictness_level = errorWeight >= 3 && errorRate >= 0.35
    ? 2
    : errorWeight >= 1 && errorRate >= 0.2 ? 1 : 0;
  const extendedRefinement = average_marker_move_m >= 20 ||
    large_marker_correction_count > 0;

  return {
    version: 1,
    rejected_count,
    marker_correction_count,
    large_marker_correction_count,
    verified_count,
    feedback_count,
    average_marker_move_m,
    strictness_level,
    short_stop_max_seconds: 45 + strictness_level * 10,
    in_vehicle_stop_max_seconds: 120 + strictness_level * 30,
    minimum_automatic_confidence: 40 + strictness_level * 10,
    refinement_duration_ms: extendedRefinement ? 60_000 : 30_000,
    refinement_max_fixes: extendedRefinement ? 12 : 6,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
  };
};

export const defaultParkingLearningProfile = () => deriveProfile();

export async function getParkingLearningProfile() {
  return deriveProfile(await getJson(PARKING_LEARNING_KEY, null));
}

const dispatchChanged = (profile) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PARKING_LEARNING_CHANGED_EVENT, {
    detail: { profile },
  }));
};

/**
 * Records only aggregate feedback. Coordinates, trip IDs, notes, and photos are
 * never written to this profile.
 *
 * @param {{ kind?: string, movementM?: number }} [feedback]
 */
export async function recordParkingLearningFeedback({
  kind,
  movementM = 0,
} = {}) {
  const current = await getParkingLearningProfile();
  const next = { ...current };
  if (kind === 'rejected') {
    next.rejected_count += 1;
  } else if (kind === 'marker_moved') {
    const movement = clamp(movementM, 0, 1000);
    const priorTotal = current.average_marker_move_m * current.marker_correction_count;
    next.marker_correction_count += 1;
    next.average_marker_move_m = (priorTotal + movement) / next.marker_correction_count;
    if (movement >= 25) next.large_marker_correction_count += 1;
  } else if (kind === 'verified') {
    next.verified_count += 1;
  } else {
    return current;
  }
  next.updated_at = new Date().toISOString();
  const normalized = deriveProfile(next);
  await setJson(PARKING_LEARNING_KEY, normalized);
  dispatchChanged(normalized);
  return normalized;
}

export function parkingPointDistanceM(first, second) {
  const lat1 = Number(first?.lat);
  const lng1 = Number(first?.lng);
  const lat2 = Number(second?.lat);
  const lng2 = Number(second?.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const firstLat = lat1 * Math.PI / 180;
  const secondLat = lat2 * Math.PI / 180;
  const dLat = secondLat - firstLat;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}
