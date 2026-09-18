import { speedLimitReviewNeededForTrip } from '@/lib/speedLimitReview';

/**
 * Route-stable derived context (HPR-002 + HPR-007).
 *
 * Trip Detail can hold a full inline route — legacy and imported records carry
 * their whole `route_points` array — and several of its derived values are
 * route-sized. Recomputing them because a modal opened is work the route did
 * not ask for, and the phone-use summary went further: it scanned the whole
 * route once per confirmed event.
 *
 * Every derivation here is keyed on the **route array identity**, so the cache
 * cannot outlive the route it describes: a new record, an edited trip or a
 * replaced route produces a new array and therefore a new entry, and the old one
 * is collected with the old array. Nothing is keyed by trip id, nothing hashes
 * or deep-compares the route, and no derivation copies the point objects.
 *
 * Semantics are preserved exactly; this module only decides *when* the existing
 * computations run.
 */

const NO_ROUTE = Object.freeze([]);

const routeOf = (value) => (Array.isArray(value) ? value : NO_ROUTE);

/**
 * One cache per derivation, keyed by the route array.
 *
 * `length` is stored beside the value as a cheap tamper check: a route that is
 * mutated in place keeps its identity, and an O(1) length comparison catches the
 * reachable form of that (points appended or removed) without an O(P) scan. A
 * same-length in-place content edit is outside the supported contract — the same
 * limit a `useMemo` keyed on the array reference has.
 */
const cacheFor = () => {
  const store = new WeakMap();
  return (route, compute) => {
    const points = routeOf(route);
    if (points === NO_ROUTE) return compute(points);
    const existing = store.get(points);
    if (existing && existing.length === points.length) return existing.value;
    const value = compute(points);
    store.set(points, { length: points.length, value });
    return value;
  };
};

const availabilityCache = cacheFor();
const countryCache = cacheFor();
const reviewCache = cacheFor();
const timeIndexCache = cacheFor();

/**
 * Does any point carry a usable posted/derived speed limit?
 *
 * Replaces a full `filter` whose result was only ever read as `length > 0`.
 * @param {Array<any>|null|undefined} route
 * @returns {boolean}
 */
export function hasSpeedLimitEvidencePoints(route) {
  return availabilityCache(route, (points) => points.some((point) => (
    Number.isFinite(Number(point?.speed_limit_kmh)) && Number(point.speed_limit_kmh) > 0
  )));
}

/**
 * The upper-cased default-country profiles this trip's evidence mentions.
 *
 * The route contributes two fields per point and the events two more; the
 * per-route part is cached, and the small event/context part is folded on top.
 * @param {Record<string, any>} trip
 * @param {string|null|undefined} contextFallbackCountry
 * @returns {string[]}
 */
export function routeDefaultCountries(trip = {}, contextFallbackCountry = null) {
  const routeCountries = countryCache(trip?.route_points, (points) => {
    const found = new Set();
    for (const point of points) {
      if (point?.fallback_country) found.add(point.fallback_country);
      if (point?.speed_limit_default_country) found.add(point.speed_limit_default_country);
    }
    return [...found];
  });
  const events = Array.isArray(trip?.driving_events) ? trip.driving_events : NO_EVENTS;
  // The event contribution is keyed by the **events array identity**, not by its
  // length: React Query's structural sharing keeps a deep-equal route array while
  // replacing a changed events array, so a same-length country change arrives as
  // a new array and must be re-folded. Events are a small collection, so this
  // fold never touches route-sized work.
  const eventCountries = eventCountryCache(events, (rows) => {
    const found = new Set();
    for (const event of rows) {
      if (event?.fallback_country) found.add(event.fallback_country);
      if (event?.speed_limit_default_country) found.add(event.speed_limit_default_country);
    }
    return [...found];
  });
  const context = contextFallbackCountry ?? '';
  const byEvents = combinedCountryCache.get(routeCountries) || new WeakMap();
  if (!combinedCountryCache.has(routeCountries)) combinedCountryCache.set(routeCountries, byEvents);
  const byContext = byEvents.get(eventCountries) || new Map();
  if (!byEvents.has(eventCountries)) byEvents.set(eventCountries, byContext);
  if (byContext.has(context)) return byContext.get(context);
  const combined = [...new Set([
    contextFallbackCountry,
    ...routeCountries,
    ...eventCountries,
  ].filter(Boolean))].map((country) => String(country).toUpperCase());
  byContext.set(context, combined);
  return combined;
}

const NO_EVENTS = Object.freeze([]);

/** Event-country folds, keyed by the events array identity. */
const eventCountryCache = (() => {
  const store = new WeakMap();
  return (events, compute) => {
    if (!Array.isArray(events) || !events.length) return EMPTY_COUNTRIES;
    const existing = store.get(events);
    if (existing && existing.length === events.length) return existing.value;
    const value = compute(events);
    store.set(events, { length: events.length, value });
    return value;
  };
})();

const EMPTY_COUNTRIES = Object.freeze([]);

/** route contribution -> events contribution -> context -> combined answer. */
const combinedCountryCache = new WeakMap();

/**
 * Does this trip still need a speed-limit review decision?
 *
 * The predicate reads the route *and* a few trip-level flags, so the cache is
 * keyed by route identity and then by those flags — a resolved review is a new
 * answer over the same route.
 * @param {Record<string, any>} trip
 * @returns {boolean}
 */
export function speedLimitReviewNeeded(trip = {}) {
  const byFlags = reviewCache(trip?.route_points, () => new Map());
  const key = [
    trip?.speed_limit_review_required === true ? 'required' : trip?.speed_limit_review_required === false ? 'resolved' : 'unset',
    trip?.start_source ?? '',
    trip?.imported_from_native === true ? 'imported' : '',
    trip?.id ?? '',
  ].join('|');
  if (byFlags.has(key)) return byFlags.get(key);
  const needed = speedLimitReviewNeededForTrip(trip);
  byFlags.set(key, needed);
  return needed;
}

const CONTEXT_TIMESTAMP_FIELDS = ['timestamp', 'time'];

const pointTimeMs = (point) => {
  for (const field of CONTEXT_TIMESTAMP_FIELDS) {
    const raw = point?.[field];
    if (raw == null) continue;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/**
 * A searchable view of a route's timestamps, built once per route.
 *
 * Points without a usable timestamp are excluded, exactly as the linear scan
 * skipped them. Entries are ordered by time and, within one time, by their
 * original position, so "the first point in array order" survives as the tie
 * rule. Auxiliary memory is one `Float64Array` of times plus one index array —
 * no point object is copied.
 *
 * @param {Array<any>|null|undefined} route
 */
export function routeTimeIndex(route) {
  return timeIndexCache(route, (points) => {
    const times = [];
    const order = [];
    let sorted = true;
    for (let index = 0; index < points.length; index += 1) {
      const ms = pointTimeMs(points[index]);
      if (ms == null) continue;
      if (times.length && ms < times[times.length - 1]) sorted = false;
      times.push(ms);
      order.push(index);
    }
    if (!sorted) {
      const slots = times.map((_, slot) => slot);
      slots.sort((a, b) => (times[a] - times[b]) || (order[a] - order[b]));
      const orderedTimes = slots.map((slot) => times[slot]);
      const orderedPositions = slots.map((slot) => order[slot]);
      return buildTimeBlocks(orderedTimes, orderedPositions, points);
    }
    return buildTimeBlocks(times, order, points);
  });
}

/** The context window the linear scan used: beyond it there is no nearest point. */
export const ROUTE_CONTEXT_WINDOW_MS = 30_000;

/**
 * The route point nearest to `targetMs`, or null.
 *
 * Identical to the scan it replaces: unusable timestamps are skipped, an exact
 * tie keeps the earlier array position, and a match further than the context
 * window is not a match. O(log P) per call once the route's index exists.
 *
 * @param {Array<any>|null|undefined} route
 * @param {number|null|undefined} targetMs
 */
export function nearestRoutePointByTime(route, targetMs = null) {
  if (targetMs == null || !Number.isFinite(Number(targetMs))) return null;
  const index = routeTimeIndex(route);
  if (!index.blockCount) return null;
  const { blockTimes, blockOrder, points } = index;

  let low = 0;
  let high = index.blockCount;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (blockTimes[mid] < targetMs) low = mid + 1;
    else high = mid;
  }

  let best = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  // Only the two blocks adjacent to the target can hold the minimum, and each
  // block already knows its earliest original position, so a duplicate block is
  // never walked at query time.
  for (const block of [low - 1, low]) {
    if (block < 0 || block >= index.blockCount) continue;
    const delta = Math.abs(blockTimes[block] - targetMs);
    if (delta < bestDelta || (delta === bestDelta && best >= 0 && blockOrder[block] < blockOrder[best])) {
      best = block;
      bestDelta = delta;
    }
  }
  if (best < 0 || bestDelta > ROUTE_CONTEXT_WINDOW_MS) return null;
  return points[blockOrder[best]] ?? null;
}

/**
 * Collapse equal-time runs into blocks.
 *
 * Every point sharing one timestamp is the same distance from any target, so the
 * only one that can ever win is the block's earliest original position — the
 * first entry of the run, because entries are ordered by time and then by
 * position. Keeping one time and one position per **distinct** time is what
 * makes a lookup logarithmic on a route that holds a large duplicate block; the
 * previous shape had to walk that block on every lookup to find where it began.
 */
const buildTimeBlocks = (times, positions, points) => {
  const blockTimes = [];
  const blockOrder = [];
  for (let slot = 0; slot < times.length; slot += 1) {
    if (slot === 0 || times[slot] !== times[slot - 1]) {
      blockTimes.push(times[slot]);
      blockOrder.push(positions[slot]);
    }
  }
  return {
    size: times.length,
    blockCount: blockTimes.length,
    blockTimes: Float64Array.from(blockTimes),
    blockOrder: Int32Array.from(blockOrder),
    points,
  };
};
