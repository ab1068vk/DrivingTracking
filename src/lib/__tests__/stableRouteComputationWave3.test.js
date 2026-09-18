import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hasSpeedLimitEvidencePoints,
  routeDefaultCountries,
  speedLimitReviewNeeded,
  routeTimeIndex,
  nearestRoutePointByTime,
} from '@/lib/routeDerivedContext';
import { replaceEqualDeep } from '@tanstack/query-core';
import { summarizeTripPhoneUse } from '@/lib/phoneUseSummary';
import { buildPhoneUseFromTripEvidence } from '@/lib/phoneUsageAccess';

/**
 * Stable Route Computation — Wave 3 (HPR-002 + HPR-007).
 *
 * Both findings are about repeated route-sized work over a route that has not
 * changed. The counters below are deterministic: every point exposes its fields
 * through getters, so a "read" is an actual traversal of that point, and an
 * assertion can state exactly how many traversals a derivation is allowed.
 */

const counters = { timestamp: 0, speedLimit: 0, country: 0, lat: 0 };
const resetCounters = () => Object.keys(counters).forEach((key) => { counters[key] = 0; });

class CountingPoint {
  constructor(index, startMs, options = {}) {
    this._t = new Date(startMs + index * 1_000).toISOString();
    this._limit = options.limitKmh ?? 50;
    this._country = options.country ?? 'gb';
    this._lat = 51.5 + index / 1_000_000;
    this._lng = -0.12 + index / 1_000_000;
  }

  get timestamp() { counters.timestamp += 1; return this._t; }

  get speed_limit_kmh() { counters.speedLimit += 1; return this._limit; }

  get fallback_country() { counters.country += 1; return this._country; }

  get speed_limit_default_country() { counters.country += 1; return this._country; }

  get lat() { counters.lat += 1; return this._lat; }

  get speed_kmh() { return 40; }

  get lng() { return this._lng; }

  get speed_limit_source() { return 'openstreetmap'; }
}

const START_MS = Date.UTC(2026, 5, 1, 8, 0, 0);

const countingRoute = (count, options = {}) => Array.from(
  { length: count },
  (_, index) => new CountingPoint(index, START_MS, options),
);

const plainRoute = (count, { stepMs = 1_000, startMs = START_MS } = {}) => Array.from(
  { length: count },
  (_, index) => ({
    timestamp: new Date(startMs + index * stepMs).toISOString(),
    lat: 51.5 + index / 1_000_000,
    lng: -0.12 + index / 1_000_000,
    speed_kmh: 40,
    speed_limit_kmh: 50,
    speed_limit_source: 'openstreetmap',
  }),
);

/** One Android usage session: the only source of a *confirmed* phone-use event. */
const usageSession = (index, offsetMs, durationMs = 12_000) => ({
  package_name: 'com.example.messages',
  start_ms: START_MS + offsetMs,
  end_ms: START_MS + offsetMs + durationMs,
  started_after_unlock: true,
});

const phoneTrip = (route, sessions) => ({
  id: 'wave3-phone-trip',
  status: 'completed',
  start_time: new Date(START_MS).toISOString(),
  end_time: new Date(START_MS + route.length * 1_000).toISOString(),
  duration_seconds: route.length,
  route_points: route,
  driving_events: [],
  native_phone_usage_access_granted: true,
  native_phone_usage_events: sessions,
  native_phone_usage_event_count: sessions.length,
});

beforeEach(resetCounters);

describe('HPR-002 — route-derived values are reused while the route is unchanged', () => {
  it('answers speed-limit availability once per route', () => {
    const route = countingRoute(2_000);
    expect(hasSpeedLimitEvidencePoints(route)).toBe(true);
    const afterFirst = counters.speedLimit;
    expect(afterFirst).toBeGreaterThan(0);

    // An unrelated rerender asks the same question about the same route.
    expect(hasSpeedLimitEvidencePoints(route)).toBe(true);
    expect(hasSpeedLimitEvidencePoints(route)).toBe(true);
    expect(counters.speedLimit).toBe(afterFirst);

    // A genuinely different route must be examined.
    const replacement = countingRoute(10, { limitKmh: 0 });
    expect(hasSpeedLimitEvidencePoints(replacement)).toBe(false);
    expect(counters.speedLimit).toBeGreaterThan(afterFirst);
  });

  it('keeps the same availability answer as the expression it replaces', () => {
    const withLimits = plainRoute(5);
    const withoutLimits = plainRoute(5).map((point) => ({ ...point, speed_limit_kmh: 0 }));
    const legacy = (route) => route.filter((point) => (
      Number.isFinite(Number(point.speed_limit_kmh)) && Number(point.speed_limit_kmh) > 0
    )).length > 0;
    expect(hasSpeedLimitEvidencePoints(withLimits)).toBe(legacy(withLimits));
    expect(hasSpeedLimitEvidencePoints(withoutLimits)).toBe(legacy(withoutLimits));
    expect(hasSpeedLimitEvidencePoints([])).toBe(false);
    expect(hasSpeedLimitEvidencePoints(null)).toBe(false);
  });

  it('derives default countries once per route and event set', () => {
    const route = countingRoute(2_000, { country: 'gb' });
    const trip = { route_points: route, driving_events: [{ fallback_country: 'fr' }] };
    const first = routeDefaultCountries(trip, 'de');
    expect(first).toEqual(['DE', 'GB', 'FR']);
    const afterFirst = counters.country;
    expect(afterFirst).toBeGreaterThan(0);

    expect(routeDefaultCountries(trip, 'de')).toBe(first);
    expect(routeDefaultCountries(trip, 'de')).toBe(first);
    expect(counters.country).toBe(afterFirst);

    // A different context value is a different answer, folded on top of the same
    // cached route contribution rather than another route traversal.
    expect(routeDefaultCountries(trip, 'es')).toEqual(['ES', 'GB', 'FR']);
    expect(counters.country).toBe(afterFirst);

    // A genuinely different route is examined.
    expect(routeDefaultCountries({ route_points: countingRoute(5, { country: 'it' }) }, 'gb'))
      .toEqual(['GB', 'IT']);
    expect(counters.country).toBeGreaterThan(afterFirst);
  });

  it('answers the speed-limit review predicate once per route and review state', () => {
    const route = countingRoute(2_000);
    const trip = { route_points: route, start_source: 'native_auto' };
    expect(speedLimitReviewNeeded(trip)).toBe(true);
    const afterFirst = counters.lat;
    expect(afterFirst).toBeGreaterThan(0);

    expect(speedLimitReviewNeeded(trip)).toBe(true);
    expect(speedLimitReviewNeeded(trip)).toBe(true);
    expect(counters.lat).toBe(afterFirst);

    // The predicate depends on more than the route: a resolved review is a new answer.
    expect(speedLimitReviewNeeded({ ...trip, speed_limit_review_required: false })).toBe(false);
    expect(counters.lat).toBeGreaterThan(afterFirst);
  });

  it('keeps Trip Detail on the stable derivations', () => {
    const page = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');
    expect(page).toContain('hasSpeedLimitEvidencePoints(');
    expect(page).toContain('routeDefaultCountries(');
    expect(page).toContain('speedLimitReviewNeeded(');
    // The render body must not rebuild these route-sized structures itself.
    expect(page).not.toMatch(/const rawSpeedLimitPoints = \(trip\.route_points \|\| \[\]\)\.filter/);
    expect(page).not.toMatch(/\.\.\.\(trip\.route_points \|\| \[\]\)\.map\(\(point\) => point\.fallback_country\)/);
    expect(page).not.toContain('speedLimitReviewNeededForTrip(trip)');
  });
});

describe('HPR-007 — nearest route point keeps its semantics without scanning per event', () => {
  const route = plainRoute(5); // 08:00:00 … 08:00:04

  const at = (offsetMs) => START_MS + offsetMs;

  it('matches an exact timestamp', () => {
    expect(nearestRoutePointByTime(route, at(2_000))).toBe(route[2]);
  });

  it('matches the nearest point before and after', () => {
    expect(nearestRoutePointByTime(route, at(2_400))).toBe(route[2]);
    expect(nearestRoutePointByTime(route, at(2_600))).toBe(route[3]);
  });

  it('breaks an exact tie toward the earlier array position', () => {
    // 500 ms from index 2 and from index 3; the scan it replaces kept the first.
    expect(nearestRoutePointByTime(route, at(2_500))).toBe(route[2]);
  });

  it('returns null outside the context window and for a missing target', () => {
    expect(nearestRoutePointByTime(route, at(-60_000))).toBeNull();
    expect(nearestRoutePointByTime(route, at(120_000))).toBeNull();
    expect(nearestRoutePointByTime(route, null)).toBeNull();
    expect(nearestRoutePointByTime([], at(0))).toBeNull();
  });

  it('keeps the first of duplicate timestamps and ignores unusable ones', () => {
    const duplicated = [
      { timestamp: new Date(at(0)).toISOString(), id: 'a' },
      { timestamp: new Date(at(0)).toISOString(), id: 'b' },
      { timestamp: 'not-a-date', id: 'c' },
      { id: 'd' },
      { time: new Date(at(1_000)).toISOString(), id: 'e' },
    ];
    expect(nearestRoutePointByTime(duplicated, at(0)).id).toBe('a');
    expect(nearestRoutePointByTime(duplicated, at(900)).id).toBe('e');
  });

  it('is correct when the route is not stored in time order', () => {
    const shuffled = [plainRoute(5)[3], plainRoute(5)[0], plainRoute(5)[4], plainRoute(5)[1], plainRoute(5)[2]];
    expect(nearestRoutePointByTime(shuffled, at(0)).timestamp).toBe(shuffled[1].timestamp);
    expect(nearestRoutePointByTime(shuffled, at(4_000)).timestamp).toBe(shuffled[2].timestamp);
    expect(nearestRoutePointByTime(shuffled, at(2_400)).timestamp).toBe(shuffled[4].timestamp);
  });

  it('examines each point once per route, not once per event', () => {
    const points = 5_000;
    const route = countingRoute(points);
    const index = routeTimeIndex(route);
    expect(index.size).toBe(points);
    const afterBuild = counters.timestamp;
    expect(afterBuild).toBe(points);

    for (let event = 0; event < 60; event += 1) {
      expect(nearestRoutePointByTime(route, START_MS + event * 50_000)).toBeTruthy();
    }
    // Searching reads the prepared index, never the points again.
    expect(counters.timestamp).toBe(afterBuild);
  });
});

describe('HPR-007 — the phone-use summary is no longer E x P', () => {
  it('builds one route index for the whole event set', () => {
    const points = 5_000;
    const route = countingRoute(points);
    const events = Array.from({ length: 60 }, (_, index) => usageSession(index, index * 50_000));
    const summary = summarizeTripPhoneUse(phoneTrip(route, events), {});
    expect(summary.timeline.length).toBe(60);
    // One traversal for the evidence pass plus one for the index; never 60 x P.
    expect(counters.timestamp).toBeLessThanOrEqual(points * 3);
  });

  it('holds at a route size the old shape could not survive', () => {
    const points = 100_000;
    const route = countingRoute(points);
    const events = Array.from({ length: 60 }, (_, index) => usageSession(index, index * 1_000_000));
    const summary = summarizeTripPhoneUse(phoneTrip(route, events), {});
    expect(summary.timeline.length).toBe(60);
    expect(counters.timestamp).toBeLessThanOrEqual(points * 3);
  });

  it('reuses the whole summary while the record is unchanged', () => {
    const route = countingRoute(4_000);
    const trip = phoneTrip(route, [usageSession(0, 5_000)]);
    const first = summarizeTripPhoneUse(trip, {});
    const afterFirst = counters.timestamp;
    expect(afterFirst).toBeGreaterThan(0);

    // Trip Detail reads this below its early returns, so the reuse is keyed on
    // the record itself: five unrelated rerenders, one computation.
    for (let rerender = 0; rerender < 5; rerender += 1) {
      expect(summarizeTripPhoneUse(trip, {})).toBe(first);
    }
    expect(counters.timestamp).toBe(afterFirst);

    // A different answer is still a different question.
    expect(summarizeTripPhoneUse(trip, { wasDriver: 'no' })).not.toBe(first);
    // A refetched or edited record is a new object and is recomputed.
    expect(summarizeTripPhoneUse({ ...trip }, {})).not.toBe(first);
    expect(counters.timestamp).toBeGreaterThan(afterFirst);
  });

  it('produces the same context as a per-event linear scan', () => {
    const route = plainRoute(400);
    const events = Array.from({ length: 6 }, (_, index) => usageSession(index, index * 60_000));
    const summary = summarizeTripPhoneUse(phoneTrip(route, events), {});
    const legacyNearest = (targetMs) => {
      let nearest = null;
      let nearestDelta = Number.POSITIVE_INFINITY;
      route.forEach((point) => {
        const ms = new Date(point.timestamp).getTime();
        const delta = Math.abs(ms - targetMs);
        if (delta < nearestDelta) { nearest = point; nearestDelta = delta; }
      });
      return nearestDelta <= 30_000 ? nearest : null;
    };
    summary.timeline.forEach((entry, index) => {
      const expected = legacyNearest(START_MS + index * 60_000);
      expect(entry.speedKmh).toBe(expected ? 40 : 0);
    });
  });

  it('does not reuse an index across a changed route', () => {
    const first = plainRoute(50);
    const second = plainRoute(50, { startMs: START_MS + 10_000_000 });
    const events = [usageSession(0, 10_000)];
    const one = summarizeTripPhoneUse(phoneTrip(first, events), {});
    const two = summarizeTripPhoneUse(phoneTrip(second, events), {});
    // The session overlaps the first route and nothing in the replacement, so a
    // reused index would have to invent a window that the new route cannot support.
    expect(one.timeline.length).toBe(1);
    expect(one.timeline[0].speedKmh).toBeGreaterThan(0);
    expect(two.timeline.length).toBe(0);
    // And the shared search agrees about the two routes independently.
    expect(nearestRoutePointByTime(first, START_MS + 10_000)).toBe(first[10]);
    expect(nearestRoutePointByTime(second, START_MS + 10_000)).toBeNull();
  });
});

describe('Wave 3 — representation boundaries and composition', () => {
  it('leaves a bounded or absent route bounded', () => {
    // A native overview (bounded) and a projection row (no inline route at all)
    // must not be turned into route-sized work by the shared derivations.
    const overview = plainRoute(900);
    expect(hasSpeedLimitEvidencePoints(overview)).toBe(true);
    expect(routeTimeIndex(overview).size).toBe(900);
    const projectionRow = { id: 'p', route_points_map_count: 100_000 };
    expect(hasSpeedLimitEvidencePoints(projectionRow.route_points)).toBe(false);
    expect(routeTimeIndex(projectionRow.route_points).size).toBe(0);
    expect(nearestRoutePointByTime(projectionRow.route_points, START_MS)).toBeNull();
    expect(summarizeTripPhoneUse({ ...projectionRow, status: 'completed' }, {}).timeline).toEqual([]);
  });

  it('reuses every route-derived structure across unrelated rerenders, then invalidates on real change', () => {
    const route = countingRoute(3_000);
    const trip = {
      id: 'wave3-composed',
      status: 'completed',
      start_time: new Date(START_MS).toISOString(),
      duration_seconds: 3_000,
      route_points: route,
      driving_events: [],
      start_source: 'native_auto',
      native_phone_usage_events: [usageSession(0, 5_000)],
      native_phone_usage_event_count: 1,
      phone_use_score_available: true,
      native_phone_usage_access_granted: true,
    };

    const render = () => ({
      availability: hasSpeedLimitEvidencePoints(trip.route_points),
      countries: routeDefaultCountries(trip, 'gb'),
      review: speedLimitReviewNeeded(trip),
      index: routeTimeIndex(trip.route_points),
    });

    const first = render();
    const afterFirst = { ...counters };
    expect(afterFirst.timestamp + afterFirst.speedLimit + afterFirst.country + afterFirst.lat).toBeGreaterThan(0);

    for (let rerender = 0; rerender < 5; rerender += 1) {
      const again = render();
      expect(again.availability).toBe(first.availability);
      expect(again.countries).toBe(first.countries);
      expect(again.review).toBe(first.review);
      expect(again.index).toBe(first.index);
    }
    expect(counters).toEqual(afterFirst);

    // A real route change invalidates everything keyed to the route.
    const changed = { ...trip, route_points: countingRoute(10) };
    const next = render.call(null) && {
      availability: hasSpeedLimitEvidencePoints(changed.route_points),
      countries: routeDefaultCountries(changed, 'gb'),
      index: routeTimeIndex(changed.route_points),
    };
    expect(next.index).not.toBe(first.index);
    expect(counters.timestamp).toBeGreaterThan(afterFirst.timestamp);
  });
});

// ---------------------------------------------------------------------------
// Wave 3 correction pass — the three mechanisms CODEX reproduced against the
// frozen implementation: a repeated long-session display scan, an event-country
// cache that cannot see changed event content, and duplicate timestamp blocks
// that walk the block on every lookup.
// ---------------------------------------------------------------------------

/** One long foreground session spanning almost the whole route. */
const longSession = (route) => ({
  package_name: 'com.example.messages',
  start_ms: START_MS + 1_000,
  end_ms: START_MS + (route.length - 2) * 1_000,
  started_after_unlock: true,
});

const evidenceTrip = (route, sessions, overrides = {}) => ({
  id: 'wave3-display-trip',
  status: 'completed',
  start_time: new Date(START_MS).toISOString(),
  end_time: new Date(START_MS + route.length * 1_000).toISOString(),
  duration_seconds: route.length,
  route_points: route,
  driving_events: [],
  native_phone_usage_access_granted: true,
  native_phone_usage_events: sessions,
  native_phone_usage_event_count: sessions.length,
  ...overrides,
});

/**
 * Exactly what TripDetail's render body does, including the fresh `{}` it passes
 * for detection evidence on every render.
 */
const renderDisplayPhoneUse = (trip) => buildPhoneUseFromTripEvidence(
  trip,
  trip.route_points || [],
  trip.duration_seconds || 0,
  {},
);

/**
 * Count reads of the cached index's own arrays, the way the search sees them.
 * The index object is the cached one, so replacing its arrays with counting
 * proxies measures the real query path rather than a copy.
 */
const instrumentRouteIndex = (route) => {
  const index = routeTimeIndex(route);
  const reads = { count: 0 };
  for (const key of Object.keys(index)) {
    const value = index[key];
    if (!ArrayBuffer.isView(value)) continue;
    index[key] = new Proxy(value, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
  }
  return reads;
};

describe('HPR-002 correction — unchanged render reuses the display phone evidence', () => {
  it('does not walk the route again for an unrelated rerender', () => {
    const route = countingRoute(5_000);
    const trip = evidenceTrip(route, [longSession(route)]);

    const first = renderDisplayPhoneUse(trip);
    expect(first.phone_use_events.length).toBeGreaterThan(0);
    const afterWarm = counters.timestamp;
    expect(afterWarm).toBeGreaterThan(0);

    // Five unrelated rerenders: same record, same route, a fresh `{}` each time.
    for (let rerender = 0; rerender < 5; rerender += 1) {
      const again = renderDisplayPhoneUse(trip);
      expect(again).toEqual(first);
    }
    expect(counters.timestamp - afterWarm).toBeLessThan(100);
  });

  it('recomputes when any input the builder actually reads changes', () => {
    const route = countingRoute(400);
    const sessions = [longSession(route)];
    const trip = evidenceTrip(route, sessions);
    const baseline = renderDisplayPhoneUse(trip);
    const warm = counters.timestamp;

    // A refetched or edited record is a new object.
    const refetched = renderDisplayPhoneUse({ ...trip });
    expect(refetched).toEqual(baseline);
    expect(counters.timestamp).toBeGreaterThan(warm);

    // A replaced route is different evidence.
    const otherRoute = countingRoute(400);
    const movedTrip = evidenceTrip(otherRoute, sessions, { id: 'wave3-display-trip-2' });
    expect(renderDisplayPhoneUse(movedTrip)).toBeTruthy();

    // Changed sessions, duration and stored evidence all change the answer.
    const noSessions = evidenceTrip(route, [], { id: 'wave3-display-trip-3' });
    expect(renderDisplayPhoneUse(noSessions).phone_use_events.length).toBe(0);
    const shorter = evidenceTrip(route, sessions, { id: 'wave3-display-trip-4', duration_seconds: 5 });
    expect(renderDisplayPhoneUse(shorter)).not.toEqual(baseline);
  });
});

describe('HPR-002 correction — event-country authority sees changed event content', () => {
  const routeFor = () => countingRoute(1_000, { country: 'gb' });

  it('updates when structural sharing keeps the route but replaces the events', () => {
    const route = routeFor();
    const before = {
      id: 'wave3-country',
      route_points: route,
      driving_events: [{ type: 'speeding', fallback_country: 'fr' }],
    };
    expect(routeDefaultCountries(before, 'de')).toEqual(['DE', 'GB', 'FR']);
    const afterRouteFold = counters.country;

    // What React Query actually does to the next detail payload: the route is
    // deep-equal so its array identity is preserved, while the changed events
    // array is replaced.
    const next = replaceEqualDeep(before, {
      id: 'wave3-country',
      route_points: route,
      driving_events: [{ type: 'speeding', fallback_country: 'it' }],
    });
    expect(next).not.toBe(before);
    expect(next.route_points).toBe(route);
    expect(next.driving_events).not.toBe(before.driving_events);
    expect(next.driving_events.length).toBe(before.driving_events.length);

    expect(routeDefaultCountries(next, 'de')).toEqual(['DE', 'GB', 'IT']);
    // The route contribution is still the cached one.
    expect(counters.country).toBe(afterRouteFold);
  });

  it('keeps reusing while the event array is genuinely unchanged', () => {
    const route = routeFor();
    const events = [{ type: 'speeding', fallback_country: 'fr' }];
    const trip = { id: 'wave3-country-stable', route_points: route, driving_events: events };
    const first = routeDefaultCountries(trip, 'de');
    const warm = counters.country;
    // Structural sharing preserves both arrays when nothing changed.
    const next = replaceEqualDeep(trip, { id: 'wave3-country-stable', route_points: route, driving_events: [{ type: 'speeding', fallback_country: 'fr' }] });
    expect(next.driving_events).toBe(events);
    expect(routeDefaultCountries(next, 'de')).toBe(first);
    expect(counters.country).toBe(warm);
  });

  it('still separates the context and route authorities', () => {
    const route = routeFor();
    const trip = { id: 'wave3-country-ctx', route_points: route, driving_events: [] };
    const de = routeDefaultCountries(trip, 'de');
    const warm = counters.country;
    expect(de).toEqual(['DE', 'GB']);
    expect(routeDefaultCountries(trip, 'es')).toEqual(['ES', 'GB']);
    expect(counters.country).toBe(warm);
    expect(routeDefaultCountries({ ...trip, route_points: countingRoute(4, { country: 'it' }) }, 'de'))
      .toEqual(['DE', 'IT']);
    expect(counters.country).toBeGreaterThan(warm);
  });
});

describe('HPR-007 correction — duplicate timestamp blocks stay bounded', () => {
  const duplicateRoute = (count) => {
    const stamp = new Date(START_MS).toISOString();
    return Array.from({ length: count }, (_, index) => ({
      timestamp: stamp,
      lat: 51.5 + index / 1_000_000,
      lng: -0.12,
      speed_kmh: 40,
      id: `dup-${index}`,
    }));
  };

  const legacyNearest = (route, targetMs) => {
    let nearest = null;
    let nearestDelta = Number.POSITIVE_INFINITY;
    route.forEach((point) => {
      const ms = new Date(point.timestamp).getTime();
      if (!Number.isFinite(ms)) return;
      const delta = Math.abs(ms - targetMs);
      if (delta < nearestDelta) { nearest = point; nearestDelta = delta; }
    });
    return nearestDelta <= 30_000 ? nearest : null;
  };

  it('A: 5,000 identical timestamps, 60 lookups, bounded index work', () => {
    const route = duplicateRoute(5_000);
    const reads = instrumentRouteIndex(route);
    for (let event = 0; event < 60; event += 1) {
      const target = START_MS + 1 + event;
      expect(nearestRoutePointByTime(route, target)).toBe(legacyNearest(route, target));
    }
    expect(reads.count).toBeLessThan(5_000);
  });

  it('B: 100,000 identical timestamps stay bounded by the same law', () => {
    const route = duplicateRoute(100_000);
    const reads = instrumentRouteIndex(route);
    for (let event = 0; event < 60; event += 1) {
      expect(nearestRoutePointByTime(route, START_MS + 1 + event).id).toBe('dup-0');
    }
    expect(reads.count).toBeLessThan(5_000);
  });

  it('C: lookup work does not grow with the route inside the block', () => {
    const small = duplicateRoute(1_000);
    const large = duplicateRoute(50_000);
    const smallReads = instrumentRouteIndex(small);
    const largeReads = instrumentRouteIndex(large);
    for (const events of [1, 10, 60]) {
      for (let event = 0; event < events; event += 1) {
        nearestRoutePointByTime(small, START_MS + 1 + event);
        nearestRoutePointByTime(large, START_MS + 1 + event);
      }
    }
    // A fifty-times larger duplicate block must not cost fifty times more.
    expect(largeReads.count).toBeLessThan(smallReads.count * 2);
  });

  it('keeps the earliest original position across mixed duplicate blocks', () => {
    const stampA = new Date(START_MS).toISOString();
    const stampB = new Date(START_MS + 1_000).toISOString();
    const route = [
      { timestamp: stampB, id: 'b-first' },
      { timestamp: stampA, id: 'a-first' },
      { timestamp: stampA, id: 'a-second' },
      { timestamp: stampB, id: 'b-second' },
    ];
    // Equidistant between the two blocks: the earliest original position wins.
    expect(nearestRoutePointByTime(route, START_MS + 500).id).toBe('b-first');
    expect(nearestRoutePointByTime(route, START_MS + 100).id).toBe('a-first');
    expect(nearestRoutePointByTime(route, START_MS + 900).id).toBe('b-first');
  });
});

describe('Wave 3 correction — composed', () => {
  it('holds every layer together, then invalidates exactly what changed', () => {
    const stamp = (index) => new Date(START_MS + (index < 2_000 ? index : 2_000) * 1_000).toISOString();
    const route = Array.from({ length: 3_000 }, (_, index) => ({
      timestamp: stamp(index),
      lat: 51.5 + index / 1_000_000,
      lng: -0.12,
      speed_kmh: 40,
      speed_limit_kmh: 50,
      fallback_country: 'gb',
    }));
    const trip = {
      id: 'wave3-composed-correction',
      status: 'completed',
      start_time: new Date(START_MS).toISOString(),
      end_time: new Date(START_MS + 3_000_000).toISOString(),
      duration_seconds: 3_000,
      route_points: route,
      driving_events: [{ type: 'speeding', fallback_country: 'fr' }],
      native_phone_usage_access_granted: true,
      native_phone_usage_events: [longSession(route)],
      native_phone_usage_event_count: 1,
    };

    const render = () => ({
      display: renderDisplayPhoneUse(trip),
      countries: routeDefaultCountries(trip, 'de'),
      availability: hasSpeedLimitEvidencePoints(trip.route_points),
      summary: summarizeTripPhoneUse(trip, {}),
    });

    const first = render();
    const reads = instrumentRouteIndex(route);
    const warm = counters.timestamp;
    for (let rerender = 0; rerender < 4; rerender += 1) {
      const again = render();
      expect(again.display).toEqual(first.display);
      expect(again.countries).toBe(first.countries);
      expect(again.availability).toBe(first.availability);
      expect(again.summary).toBe(first.summary);
    }
    expect(counters.timestamp - warm).toBeLessThan(100);
    expect(reads.count).toBeLessThan(5_000);

    // Realistic update: route identity preserved, events replaced with new content.
    const next = replaceEqualDeep(trip, { ...trip, driving_events: [{ type: 'speeding', fallback_country: 'it' }] });
    expect(next.route_points).toBe(route);
    expect(routeDefaultCountries(next, 'de')).toEqual(['DE', 'GB', 'IT']);
    // The route layers are untouched by an event-only change.
    expect(hasSpeedLimitEvidencePoints(next.route_points)).toBe(first.availability);

    // A replaced route invalidates the route-keyed layers.
    const replacedRoute = route.slice(0, 500);
    expect(routeTimeIndex(replacedRoute)).not.toBe(routeTimeIndex(route));
  });
});
