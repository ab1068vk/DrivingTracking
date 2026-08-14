/**
 * The single place that decides whether a driving event has a position worth
 * clustering on.
 *
 * This exists because of a specific, silent failure. Privacy masking does not
 * remove an event; it nulls the coordinates in place and flags the record
 * (`redactCoordinateFieldsForPrivacy` in `privacyZones.js`). The drop-filter
 * that would otherwise remove it calls `isPointInPrivacyZone`, which returns
 * null for a non-finite latitude, so a masked event survives with `lat: null`.
 *
 * Then the clustering read it as `Number(event.lat)`. `Number(null)` is 0, and
 * `Number.isFinite(0)` is true, so every masked event in the history collected
 * at (0, 0) — a real point in the Gulf of Guinea — and could form a phantom
 * "repeated event area" there built entirely out of the driver's private trips.
 * The same hole exists in `routeRiskIndex`, whose nearest-segment search has no
 * distance ceiling and would attach those events to whatever road is closest.
 *
 * So the rule is: a redaction flag disqualifies an event outright, and a
 * coordinate must be explicitly numeric. A genuine (0, 0) event is still
 * accepted — the guard is against null coercion, not against a coordinate that
 * happens to be zero.
 */

/** Any one of these means the coordinates were deliberately removed. */
const REDACTION_FLAGS = [
  'masked_for_privacy',
  'privacy_event_redacted',
  'privacy_purged',
  'privacy_live_redacted',
  'privacy_gap',
  'privacy_boundary',
];

/**
 * Strict coordinate parse. `Number(null)`, `Number('')` and `Number(false)` are
 * all 0, so a lenient parse silently invents a position.
 */
const coord = (value) => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** True when privacy masking removed this event's location. */
export function isRedactedEvent(event) {
  return REDACTION_FLAGS.some((flag) => event?.[flag] === true);
}

/**
 * The event's usable position, or null.
 * @param {any} event
 * @returns {{lat: number, lng: number} | null}
 */
export function eventPosition(event) {
  if (!event || isRedactedEvent(event)) return null;
  const lat = coord(event.lat);
  const lng = coord(event.lng);
  if (lat == null || lng == null) return null;
  // Outside these ranges the value is not a coordinate at all, whatever it parsed to.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Whether this event can take part in spatial clustering at all. */
export function hasUsablePosition(event) {
  return eventPosition(event) != null;
}
