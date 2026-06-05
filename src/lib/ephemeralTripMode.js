import { removeJson } from '@/lib/mobileStorage';
import { legacyStorageKeysFor, resolveStorageKey } from '@/lib/storageKeyMigration';

let stealthNextTrip = false;
let ephemeralActive = false;
const listeners = new Set();

const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
const DIAGNOSTIC_EVENTS_KEY = 'road_sage_tracking_diagnostics';

function notify() {
  listeners.forEach((listener) => listener(getEphemeralTripModeState()));
}

function removeLocalStorageKeys(keys) {
  try {
    if (typeof localStorage === 'undefined') return;
    keys.forEach((key) => {
      localStorage.removeItem(resolveStorageKey(key));
      legacyStorageKeysFor(key).forEach((legacyKey) => localStorage.removeItem(legacyKey));
    });
  } catch {
    // Best-effort only. Ephemeral mode must not fail trip controls.
  }
}

async function removeMobileStorageKeys(keys) {
  await Promise.all(keys.map((key) => removeJson(key).catch(() => {})));
}

export function subscribeEphemeralTripMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEphemeralTripModeState() {
  return {
    stealthNextTrip,
    ephemeralActive,
  };
}

export function setStealthNextTrip(enabled) {
  if (ephemeralActive) return false;
  stealthNextTrip = enabled === true;
  notify();
  return stealthNextTrip;
}

export function isStealthNextTripEnabled() {
  return stealthNextTrip;
}

export async function activateEphemeralMode() {
  if (!ephemeralActive) {
    ephemeralActive = true;
    stealthNextTrip = false;
  }
  await clearEphemeralStorageArtifacts();
  notify();
  return true;
}

export async function consumeStealthNextTrip() {
  if (!stealthNextTrip || ephemeralActive) return false;
  await activateEphemeralMode();
  return true;
}

export function isEphemeralModeActive() {
  return ephemeralActive;
}

export async function clearEphemeralStorageArtifacts() {
  const keys = [
    ACTIVE_TRIP_KEY,
    DIAGNOSTIC_EVENTS_KEY,
  ];
  removeLocalStorageKeys(keys);
  await removeMobileStorageKeys(keys);
}

export function wipeTripObject(trip) {
  if (!trip || typeof trip !== 'object') return;

  if (Array.isArray(trip.route_points)) {
    trip.route_points.forEach((point) => {
      if (!point || typeof point !== 'object') return;
      point.lat = 0;
      point.lng = 0;
      if (point.alt != null) point.alt = 0;
      if (point.altitude != null) point.altitude = 0;
    });
    trip.route_points = [];
  }

  if (Array.isArray(trip.raw_route_points)) {
    trip.raw_route_points.forEach((point) => {
      if (!point || typeof point !== 'object') return;
      point.lat = 0;
      point.lng = 0;
      if (point.alt != null) point.alt = 0;
      if (point.altitude != null) point.altitude = 0;
    });
    trip.raw_route_points = [];
  }

  if (Array.isArray(trip.driving_events)) {
    trip.driving_events.forEach((event) => {
      if (!event || typeof event !== 'object') return;
      if (event.lat != null) event.lat = 0;
      if (event.lng != null) event.lng = 0;
    });
    trip.driving_events = [];
  }
}

export async function endEphemeralTrip(tripRef = null) {
  if (tripRef?.current) {
    wipeTripObject(tripRef.current);
    tripRef.current = null;
  }
  ephemeralActive = false;
  stealthNextTrip = false;
  await clearEphemeralStorageArtifacts();
  notify();
}
