import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import DriveSenseNative from '@/lib/driveSenseNativePlugin';
import { isNativePlatform } from '@/lib/nativePlatform';

export const PARKING_HISTORY_KEY = 'drivesense_parking_history_v1';
export const PARKING_VEHICLE_STATES_KEY = 'drivesense_parking_vehicle_states_v1';
export const PARKING_HISTORY_CHANGED_EVENT = 'roadsage-parking-history-changed';
export const MAX_PARKING_HISTORY_RECORDS = 30;
export const PARKING_HISTORY_PAGE_SIZE = 6;
export const MAX_PARKING_NOTE_LENGTH = 160;
export const MAX_PARKING_PHOTO_DATA_URL_LENGTH = 1_600_000;

export const getParkingHistoryPageWindow = (
  total,
  requestedPage,
  pageSize = PARKING_HISTORY_PAGE_SIZE,
) => {
  const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
  const safePageSize = Math.max(1, Math.floor(Number(pageSize) || PARKING_HISTORY_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(Math.max(0, Math.floor(Number(requestedPage) || 0)), pageCount - 1);
  const offset = page * safePageSize;
  return {
    page,
    pageCount,
    offset,
    start: safeTotal === 0 ? 0 : offset + 1,
    end: Math.min(safeTotal, offset + safePageSize),
  };
};

const parkingTimestampMs = (record) => {
  const parsed = Date.parse(String(record?.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const coordinate = (value, limit) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
};

const cleanText = (value, maxLength) => String(value || '').trim().slice(0, maxLength);

const safePhotoDataUrl = (value) => {
  const photo = String(value || '');
  if (!/^data:image\/(?:jpeg|png|webp);base64,/i.test(photo)) return null;
  return photo.length <= MAX_PARKING_PHOTO_DATA_URL_LENGTH ? photo : null;
};

const safePhotoExpiry = (value) => {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const safePhotoRetentionHours = (value) => {
  if (value == null || value === '') return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? Math.max(0, Math.min(720, Math.round(hours))) : null;
};

const safePhotoFileId = (value) => (
  /^[0-9a-fA-F-]{36}$/.test(String(value || '')) ? String(value) : null
);

export const isParkingPhotoExpired = (record, now = Date.now()) => {
  if ((!record?.photo_data_url && !record?.photo_file_id) || !record.photo_expires_at) return false;
  const expiresAt = Date.parse(String(record.photo_expires_at));
  return Number.isFinite(expiresAt) && expiresAt <= Number(now);
};

const parkingRecordId = (state = {}) => {
  const tripId = state.tripId ?? state.location?.tripId;
  if (tripId != null && String(tripId).trim()) return `trip:${String(tripId).trim()}`;
  return `parking:${state.timestamp || state.location?.timestamp || new Date().toISOString()}`;
};

const normalizePublicLocation = (location = {}) => {
  const lat = coordinate(location.lat, 90);
  const lng = coordinate(location.lng, 180);
  if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
  return {
    lat,
    lng,
    address: cleanText(location.address, 240) || null,
    accuracy_m: Number.isFinite(Number(location.accuracy_m))
      ? Math.max(0, Math.round(Number(location.accuracy_m)))
      : null,
    confidence: ['high', 'medium', 'estimated'].includes(location.confidence)
      ? location.confidence
      : 'estimated',
    confidence_score: Number.isFinite(Number(location.confidence_score))
      ? Math.max(0, Math.min(100, Math.round(Number(location.confidence_score))))
      : null,
    evidence: Array.from(new Set(
      (Array.isArray(location.evidence) ? location.evidence : [])
        .map((item) => cleanText(item, 64))
        .filter(Boolean)
    )).slice(0, 16),
    strategy: cleanText(location.strategy, 64) || 'last_trip_point',
    state_revision: Number.isSafeInteger(Number(location.state_revision))
      ? Math.max(0, Number(location.state_revision))
      : 0,
    vehicle_id: location.vehicle_id ?? null,
    vehicle_name: cleanText(location.vehicle_name, 80) || null,
    refinement_count: Math.max(0, Math.round(Number(location.refinement_count) || 0)),
    spread_m: Number.isFinite(Number(location.spread_m))
      ? Math.max(0, Math.round(Number(location.spread_m)))
      : null,
    indoor_estimated: location.indoor_estimated === true,
    garage_entrance: normalizeGarageEntrance(location.garage_entrance),
    garage_hint: cleanText(location.garage_hint, 160) || null,
  };
};

const normalizeGarageEntrance = (entrance) => {
  const lat = coordinate(entrance?.lat, 90);
  const lng = coordinate(entrance?.lng, 180);
  if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
  return {
    lat,
    lng,
    accuracy_m: Number.isFinite(Number(entrance?.accuracy_m))
      ? Math.max(0, Math.round(Number(entrance.accuracy_m)))
      : null,
  };
};

const normalizeRecord = (record = {}) => {
  const status = ['saved', 'private', 'unavailable'].includes(record.status)
    ? record.status
    : 'unavailable';
  const timestamp = record.timestamp || new Date().toISOString();
  const normalized = {
    id: cleanText(record.id, 180) || parkingRecordId(record),
    status,
    timestamp,
    tripId: record.tripId ?? null,
    source: cleanText(record.source, 80) || 'unknown',
    state_revision: Number.isSafeInteger(Number(record.state_revision))
      ? Math.max(0, Number(record.state_revision))
      : 0,
    vehicle_id: record.vehicle_id ?? record.location?.vehicle_id ?? null,
    vehicle_name: cleanText(record.vehicle_name || record.location?.vehicle_name, 80) || null,
    verified: record.verified === true,
    rejected: record.rejected === true,
    correction_reason: cleanText(record.correction_reason, 80) || null,
    corrected_at: record.corrected_at || null,
  };
  if (status !== 'saved') return normalized;
  const location = normalizePublicLocation(record.location);
  if (!location) return { ...normalized, status: 'unavailable' };
  const photoFileId = safePhotoFileId(record.photo_file_id);
  // Android keeps the encrypted full image in a private file. Avoid duplicating
  // its thumbnail in both current-parking and history encrypted preferences.
  const photoDataUrl = photoFileId ? null : safePhotoDataUrl(record.photo_data_url);
  const hasPhoto = Boolean(photoDataUrl || photoFileId);
  return {
    ...normalized,
    location,
    note: cleanText(record.note, MAX_PARKING_NOTE_LENGTH) || null,
    photo_data_url: photoDataUrl,
    photo_file_id: photoFileId,
    photo_expires_at: hasPhoto ? safePhotoExpiry(record.photo_expires_at) : null,
    photo_retention_hours: hasPhoto
      ? safePhotoRetentionHours(record.photo_retention_hours)
      : null,
  };
};

const stateToRecord = (state = {}) => normalizeRecord({
  id: parkingRecordId(state),
  status: state.status,
  timestamp: state.timestamp || state.location?.timestamp,
  tripId: state.tripId ?? state.location?.tripId ?? null,
  source: state.source || state.location?.source,
  state_revision: state.state_revision || state.location?.state_revision,
  vehicle_id: state.vehicle_id ?? state.location?.vehicle_id ?? null,
  vehicle_name: state.vehicle_name || state.location?.vehicle_name,
  verified: state.verified === true || state.location?.verified === true,
  correction_reason: state.correction_reason || state.location?.correction_reason,
  corrected_at: state.corrected_at || state.location?.corrected_at,
  location: state.status === 'saved' ? state.location : null,
  note: state.location?.note,
  photo_data_url: state.location?.photo_data_url,
  photo_file_id: state.location?.photo_file_id,
  photo_expires_at: state.location?.photo_expires_at,
  photo_retention_hours: state.location?.photo_retention_hours,
});

const vehicleKey = (record) => {
  const value = record?.vehicle_id ?? record?.location?.vehicle_id;
  return value == null || String(value).trim() === '' ? null : String(value);
};

export async function getVehicleParkingStates() {
  const stored = await getEncryptedJson(PARKING_VEHICLE_STATES_KEY, {});
  const entries = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? Object.entries(stored)
    : [];
  let changed = false;
  const expiredPhotoIds = [];
  const states = entries.reduce((result, [key, value]) => {
    const normalized = normalizeRecord(value);
    if (vehicleKey(normalized) !== key) return result;
    if (isParkingPhotoExpired(normalized)) {
      changed = true;
      if (normalized.photo_file_id) expiredPhotoIds.push(normalized.photo_file_id);
      result[key] = {
        ...normalized,
        photo_data_url: null,
        photo_file_id: null,
        photo_expires_at: null,
        photo_retention_hours: null,
      };
    } else {
      result[key] = normalized;
    }
    return result;
  }, {});
  if (changed) {
    await setEncryptedJson(PARKING_VEHICLE_STATES_KEY, states);
    await deleteNativeParkingPhotos(expiredPhotoIds);
  }
  return states;
}

const saveVehicleParkingState = async (record) => {
  const key = vehicleKey(record);
  if (!key) return null;
  const states = await getVehicleParkingStates();
  const next = { ...states, [key]: record };
  await setEncryptedJson(PARKING_VEHICLE_STATES_KEY, next);
  return record;
};

const dispatchChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PARKING_HISTORY_CHANGED_EVENT));
  }
};

const deleteNativeParkingPhotos = async (photoIds = []) => {
  if (!isNativePlatform()) return;
  await Promise.all(Array.from(new Set(photoIds.filter(Boolean))).map((photoId) => (
    DriveSenseNative.deleteParkingPhoto({ photoId }).catch(() => {})
  )));
};

export async function getParkingHistory() {
  const stored = await getEncryptedJson(PARKING_HISTORY_KEY, []);
  const history = (Array.isArray(stored) ? stored : [])
    .map(normalizeRecord)
    .filter((record) => record.timestamp)
    .sort((a, b) => parkingTimestampMs(b) - parkingTimestampMs(a))
    .slice(0, MAX_PARKING_HISTORY_RECORDS);
  let expiredPhotoRemoved = false;
  const expiredPhotoIds = [];
  const activeHistory = history.map((record) => {
    if (!isParkingPhotoExpired(record)) return record;
    expiredPhotoRemoved = true;
    if (record.photo_file_id) expiredPhotoIds.push(record.photo_file_id);
    return {
      ...record,
      photo_data_url: null,
      photo_file_id: null,
      photo_expires_at: null,
      photo_retention_hours: null,
    };
  });
  if (expiredPhotoRemoved) {
    await setEncryptedJson(PARKING_HISTORY_KEY, activeHistory);
    await deleteNativeParkingPhotos(expiredPhotoIds);
  }
  return activeHistory;
}

export async function recordParkingHistoryState(state, { preserveManualDetails = true } = {}) {
  if (!state?.status || !state?.timestamp) return null;
  const incoming = stateToRecord(state);
  const history = await getParkingHistory();
  const supersededPhotoIds = [];
  const incomingVehicleKey = vehicleKey(incoming);
  const historyWithoutExpiredPhotos = history.map((record) => {
    const isCurrentPublicRecord = incoming.status === 'saved' && record.id === incoming.id;
    const sameVehicle = incomingVehicleKey
      ? vehicleKey(record) === incomingVehicleKey
      : true;
    if (
      isCurrentPublicRecord ||
      !sameVehicle ||
      (!record.photo_data_url && !record.photo_file_id)
    ) return record;
    if (record.photo_file_id) supersededPhotoIds.push(record.photo_file_id);
    return {
      ...record,
      photo_data_url: null,
      photo_file_id: null,
      photo_expires_at: null,
      photo_retention_hours: null,
    };
  });
  const existing = historyWithoutExpiredPhotos.find((record) => record.id === incoming.id);
  const incomingPhotoDisablesTimedExpiry =
    Boolean(incoming.photo_data_url || incoming.photo_file_id) && incoming.photo_retention_hours === 0;
  const merged = normalizeRecord({
    ...existing,
    ...incoming,
    location: incoming.location || existing?.location,
    note: preserveManualDetails ? incoming.note || existing?.note : incoming.note,
    photo_data_url: incoming.photo_file_id
      ? null
      : preserveManualDetails
        ? incoming.photo_data_url || existing?.photo_data_url
        : incoming.photo_data_url,
    photo_file_id: preserveManualDetails
      ? incoming.photo_file_id || existing?.photo_file_id
      : incoming.photo_file_id,
    photo_expires_at: incomingPhotoDisablesTimedExpiry
      ? null
      : preserveManualDetails
        ? incoming.photo_expires_at || existing?.photo_expires_at
        : incoming.photo_expires_at,
    photo_retention_hours: preserveManualDetails
      ? incoming.photo_retention_hours ?? existing?.photo_retention_hours
      : incoming.photo_retention_hours,
    verified: incoming.verified || existing?.verified,
    rejected: incoming.rejected || existing?.rejected,
  });
  const ordered = [merged, ...historyWithoutExpiredPhotos.filter((record) => record.id !== merged.id)]
    .sort((a, b) => parkingTimestampMs(b) - parkingTimestampMs(a))
  const dropped = ordered.slice(MAX_PARKING_HISTORY_RECORDS);
  const next = ordered.slice(0, MAX_PARKING_HISTORY_RECORDS);
  await setEncryptedJson(PARKING_HISTORY_KEY, next);
  try {
    await saveVehicleParkingState(merged);
  } catch (error) {
    await setEncryptedJson(PARKING_HISTORY_KEY, history);
    throw error;
  }
  await deleteNativeParkingPhotos([
    ...supersededPhotoIds,
    ...dropped.map((record) => record.photo_file_id),
  ]);
  dispatchChanged();
  return merged;
}

export async function updateParkingHistoryRecord(id, patch = {}) {
  const history = await getParkingHistory();
  const index = history.findIndex((record) => record.id === id);
  if (index < 0) return null;
  const current = history[index];
  if (current.status !== 'saved') return current;
  const nextRecord = normalizeRecord({
    ...current,
    ...patch,
    location: {
      ...current.location,
      ...(patch.location || {}),
    },
    corrected_at: patch.corrected_at || new Date().toISOString(),
  });
  const next = [...history];
  next[index] = nextRecord;
  await setEncryptedJson(PARKING_HISTORY_KEY, next);
  dispatchChanged();
  return nextRecord;
}

export async function rejectParkingHistoryRecord(id, reason = 'not_where_parked') {
  return updateParkingHistoryRecord(id, {
    rejected: true,
    verified: false,
    correction_reason: reason,
    corrected_at: new Date().toISOString(),
  });
}

export async function deleteParkingHistoryRecord(id) {
  const recordId = String(id || '').trim();
  if (!recordId) return false;
  const history = await getParkingHistory();
  const next = history.filter((record) => record.id !== recordId);
  if (next.length === history.length) return false;
  await setEncryptedJson(PARKING_HISTORY_KEY, next);
  dispatchChanged();
  return true;
}

export async function clearParkingHistory() {
  await removeEncryptedJson(PARKING_HISTORY_KEY);
  dispatchChanged();
}

export async function replaceParkingHistory(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter((record) => record.timestamp)
    .sort((a, b) => parkingTimestampMs(b) - parkingTimestampMs(a))
    .slice(0, MAX_PARKING_HISTORY_RECORDS);
  await setEncryptedJson(PARKING_HISTORY_KEY, normalized);
  dispatchChanged();
  return normalized;
}
