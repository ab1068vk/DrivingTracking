export const NATIVE_MANUAL_TRIP_FINALIZED_EVENT = 'drivesense:native-manual-trip-finalized';

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

export function createNativeManualTripId(now = Date.now()) {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `manual_trip_${Math.round(Number(now) || Date.now())}_${suffix}`;
}

export function isNativeManualCompletionForActiveTrip(nativeTrip, activeTrip) {
  if (!nativeTrip || !activeTrip) return false;
  if (activeTrip.native_manual_background !== true) return false;
  if (nativeTrip.start_source !== 'native_manual') return false;

  const nativeId = String(nativeTrip.id || '');
  const activeId = String(activeTrip.id || '');
  if (nativeId && activeId && nativeId === activeId) return true;

  const nativeSessionId = String(nativeTrip.manual_session_id || '');
  const activeSessionId = String(activeTrip.manual_session_id || '');
  if (nativeSessionId && activeSessionId && nativeSessionId === activeSessionId) return true;

  const nativeStartMs = timestampMs(nativeTrip.start_time);
  const activeStartMs = timestampMs(activeTrip.start_time);
  const nativeEndMs = timestampMs(nativeTrip.end_time) || Date.now();
  if (nativeStartMs == null || activeStartMs == null) return false;

  const startsTogether = Math.abs(nativeStartMs - activeStartMs) <= 5 * 60 * 1000;
  const overlapsActiveStart = nativeStartMs <= activeStartMs + 5 * 60 * 1000 &&
    nativeEndMs >= activeStartMs;
  return startsTogether && overlapsActiveStart;
}

export function findNativeManualCompletion(trips, activeTrip) {
  if (!Array.isArray(trips)) return null;
  return trips.find((trip) => isNativeManualCompletionForActiveTrip(trip, activeTrip)) || null;
}

export function dispatchNativeManualTripFinalized(activeTrip, completedTrip) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(NATIVE_MANUAL_TRIP_FINALIZED_EVENT, {
    detail: {
      activeTripId: activeTrip?.id || null,
      activeStartTime: activeTrip?.start_time || null,
      completedTripId: completedTrip?.id || null,
      completedTrip,
    },
  }));
}
