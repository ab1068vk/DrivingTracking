export const PERMISSION_STATES = Object.freeze({
  UNKNOWN: 'unknown',
  REQUESTING: 'requesting',
  GRANTED: 'granted',
  DENIED: 'denied',
  NEEDS_SETTINGS: 'needs_settings',
  NOT_REQUESTED: 'not_requested',
  UNAVAILABLE: 'unavailable',
});

const VALID_TRANSITIONS = Object.freeze({
  unknown: ['requesting', 'granted', 'denied', 'needs_settings', 'not_requested', 'unavailable'],
  not_requested: ['requesting', 'granted', 'denied', 'needs_settings', 'unavailable'],
  requesting: ['granted', 'denied', 'needs_settings', 'unknown', 'unavailable'],
  denied: ['requesting', 'needs_settings', 'granted', 'unknown'],
  needs_settings: ['granted', 'denied', 'unknown'],
  granted: ['denied', 'needs_settings', 'unknown', 'unavailable'],
  unavailable: ['unknown', 'requesting'],
});

export function normalizePermissionState(value) {
  if (value === true || value === PERMISSION_STATES.GRANTED) return PERMISSION_STATES.GRANTED;
  if (value === false || value == null) return PERMISSION_STATES.UNKNOWN;
  if (Object.values(PERMISSION_STATES).includes(value)) return value;
  return PERMISSION_STATES.UNKNOWN;
}

export function isValidTransition(from, to) {
  const current = normalizePermissionState(from);
  const next = normalizePermissionState(to);
  return current === next || (VALID_TRANSITIONS[current]?.includes(next) ?? false);
}

export function transitionPermissionState(from, to) {
  const current = normalizePermissionState(from);
  const next = normalizePermissionState(to);
  return isValidTransition(current, next) ? next : current;
}
