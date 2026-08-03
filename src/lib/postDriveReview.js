import { getJson, removeJson, setJson } from '@/lib/mobileStorage';

export const POST_DRIVE_REVIEW_STORAGE_KEY = 'roadsage_pending_post_drive_review_v1';
export const POST_DRIVE_REVIEW_CHANGED_EVENT = 'roadsage:post-drive-review-changed';

const tripId = (trip) => {
  const value = trip?.id;
  return value == null || value === '' ? null : String(value);
};

const completedAt = (trip) => (
  trip?.end_time || trip?.updated_at || trip?.start_time || new Date().toISOString()
);

const emitChange = (entry, trip = null) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(POST_DRIVE_REVIEW_CHANGED_EVENT, {
    detail: { entry, trip },
  }));
};

export function buildPendingPostDriveReview(trip, source = 'trip_completed') {
  const id = tripId(trip);
  if (!id) return null;
  return {
    tripId: id,
    completedAt: completedAt(trip),
    source,
    createdAt: new Date().toISOString(),
  };
}

const timestampValue = (value) => {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export function shouldReplacePendingPostDriveReview(current, next) {
  if (!next?.tripId) return false;
  if (!current?.tripId || String(current.tripId) === String(next.tripId)) return true;
  const currentTime = timestampValue(current.completedAt) ?? timestampValue(current.createdAt);
  const nextTime = timestampValue(next.completedAt) ?? timestampValue(next.createdAt);
  if (currentTime == null) return true;
  if (nextTime == null) return false;
  return nextTime >= currentTime;
}

export async function loadPendingPostDriveReview() {
  const stored = await getJson(POST_DRIVE_REVIEW_STORAGE_KEY, null);
  if (!stored?.tripId) return null;
  return {
    ...stored,
    tripId: String(stored.tripId),
  };
}

export async function markTripForPostDriveReview(trip, source = 'trip_completed') {
  const entry = buildPendingPostDriveReview(trip, source);
  if (!entry) return null;
  const current = await loadPendingPostDriveReview();
  if (!shouldReplacePendingPostDriveReview(current, entry)) return current;
  await setJson(POST_DRIVE_REVIEW_STORAGE_KEY, entry);
  emitChange(entry, trip);
  return entry;
}

export async function markLatestTripForPostDriveReview(trips = [], source = 'background_import') {
  const latest = [...(Array.isArray(trips) ? trips : [])]
    .filter((trip) => tripId(trip))
    .sort((a, b) => new Date(completedAt(b)).getTime() - new Date(completedAt(a)).getTime())[0];
  return latest ? markTripForPostDriveReview(latest, source) : null;
}

export async function clearPendingPostDriveReview(expectedTripId = null) {
  if (expectedTripId != null) {
    const current = await loadPendingPostDriveReview();
    if (current && current.tripId !== String(expectedTripId)) return false;
  }
  await removeJson(POST_DRIVE_REVIEW_STORAGE_KEY);
  emitChange(null);
  return true;
}
