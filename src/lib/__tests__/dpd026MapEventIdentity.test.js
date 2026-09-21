import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { contentSignature, mapEventIdentity, nextStableList } from '@/lib/mapEventIdentity';

/**
 * DPD-026 -- the Trip Detail map redrew its whole route layer on every render of
 * the page that owns it.
 *
 * Measured on the A54 at 500 trips, with the page open and untouched:
 * ~5 full redraws per second, ~900 polyline segments each, a ~380 ms long task
 * per redraw and ~110,000 DOM mutations per six seconds. The `/reports` control
 * page produced 7 mutations over the same window. Container and pane survived,
 * but every `path` element was destroyed and recreated, so the effect was
 * re-running rather than the component remounting.
 *
 * The cause was identity, not volume: `TripDetail.jsx` builds `mapDisplayEvents`
 * and `mapEvents` with `.filter()` during render, so a fresh array arrived on
 * every render. That array is a dependency of the layer-draw effect, so the
 * effect re-ran, cleared the layer group and rebuilt every segment.
 *
 * `nextStableList` is the whole decision the fix makes; `useContentStableList` is
 * the `useRef` plumbing around it. These tests exercise the decision, because
 * reference equality is the thing that actually drove the redraws.
 */
describe('DPD-026 map event list identity', () => {
  const sign = (list) => contentSignature(list, mapEventIdentity);

  it('keeps the held reference when a rebuilt array says the same thing', () => {
    const held = [
      { type: 'harsh_brake', timestamp: 1000, lat: 43.6, lng: -79.4, severity: 'high' },
      { type: 'speeding', timestamp: 2000, lat: 43.7, lng: -79.5, severity: 'low' },
    ];
    // What a `.filter()`/`.map()` during render produces: same contents, new
    // array, and new element objects too.
    const rebuilt = held.map((event) => ({ ...event }));

    const next = nextStableList(held, sign(held), rebuilt, mapEventIdentity);

    expect(next.adopted).toBe(false);
    expect(next.list).toBe(held);
    expect(next.list).not.toBe(rebuilt);
  });

  it('adopts the new array when an event is added', () => {
    const held = [{ type: 'harsh_brake', timestamp: 1000, lat: 43.6, lng: -79.4 }];
    const grown = [...held, { type: 'speeding', timestamp: 3000, lat: 43.8, lng: -79.6 }];

    const next = nextStableList(held, sign(held), grown, mapEventIdentity);

    expect(next.adopted).toBe(true);
    expect(next.list).toBe(grown);
  });

  it('adopts the new array when an event is removed', () => {
    const held = [
      { type: 'harsh_brake', timestamp: 1000, lat: 43.6, lng: -79.4 },
      { type: 'speeding', timestamp: 2000, lat: 43.7, lng: -79.5 },
    ];
    const filtered = [held[0]];

    const next = nextStableList(held, sign(held), filtered, mapEventIdentity);

    expect(next.adopted).toBe(true);
    expect(next.list).toBe(filtered);
  });

  it('distinguishes events that differ only in position', () => {
    const held = [{ type: 'speeding', timestamp: 2000, lat: 43.7, lng: -79.5 }];
    const moved = [{ type: 'speeding', timestamp: 2000, lat: 43.9, lng: -79.5 }];

    expect(sign(held)).not.toBe(sign(moved));
    expect(nextStableList(held, sign(held), moved, mapEventIdentity).adopted).toBe(true);
  });

  it('distinguishes events that differ only in severity', () => {
    const held = [{ type: 'harsh_brake', timestamp: 1, lat: 1, lng: 2, severity: 'low' }];
    const escalated = [{ type: 'harsh_brake', timestamp: 1, lat: 1, lng: 2, severity: 'high' }];

    expect(nextStableList(held, sign(held), escalated, mapEventIdentity).adopted).toBe(true);
  });

  it('distinguishes reordered events, because the map draws them in order', () => {
    const held = [
      { type: 'harsh_brake', timestamp: 1000, lat: 43.6, lng: -79.4 },
      { type: 'speeding', timestamp: 2000, lat: 43.7, lng: -79.5 },
    ];
    const reversed = [held[1], held[0]];

    expect(nextStableList(held, sign(held), reversed, mapEventIdentity).adopted).toBe(true);
  });

  it('treats two empty arrays as the same list', () => {
    const held = [];

    const next = nextStableList(held, sign(held), [], mapEventIdentity);

    expect(next.adopted).toBe(false);
    expect(next.list).toBe(held);
  });

  it('gives malformed events a stable identity rather than throwing', () => {
    const held = [null, undefined, 'not-an-event', { type: 'speeding' }];
    const rebuilt = [null, undefined, 'not-an-event', { type: 'speeding' }];

    const next = nextStableList(held, sign(held), rebuilt, mapEventIdentity);

    expect(next.adopted).toBe(false);
    expect(next.list).toBe(held);
  });

  it('treats a missing list as empty without throwing', () => {
    expect(sign(undefined)).toBe('');
    expect(sign(null)).toBe('');
    expect(nextStableList([], '', undefined, mapEventIdentity).adopted).toBe(false);
  });

  it('does not collapse distinct events into one signature', () => {
    const a = [{ type: 'speeding', timestamp: 1, lat: 1, lng: 2 }];
    const b = [{ type: 'speeding', timestamp: 1, lat: 1, lng: 2 },
      { type: 'speeding', timestamp: 1, lat: 1, lng: 2 }];

    expect(sign(a)).not.toBe(sign(b));
  });
});

/**
 * The pure decision above is only useful if the map actually depends on its
 * result. Without this, reverting the effect's dependency back to the raw
 * `events` prop would restore the defect with every test still green.
 */
describe('DPD-026 the map layer effect depends on the stabilised list', () => {
  const source = readFileSync('src/components/TripMap.jsx', 'utf8');

  it('derives a stable list from the events prop', () => {
    expect(source).toMatch(/const stableEvents = useContentStableList\(events, mapEventIdentity\)/);
  });

  it('feeds the stabilised list to the layer-draw effect, not the raw prop', () => {
    const deps = source.match(/\}, \[mapFailed, ready, routePoints, routes, ([a-zA-Z]+),/);
    expect(deps, 'the layer-draw dependency array could not be found').not.toBeNull();
    expect(deps[1]).toBe('stableEvents');
  });

  it('masks the stabilised list inside the effect, so the dependency is honest', () => {
    expect(source).toMatch(/maskEventsForPrivacy\(stableEvents \|\| \[\], privacySettings\)/);
  });
});

/**
 * The first version of this fix signed only type/timestamp/lat/lng/severity.
 * Independent review found that the layer-draw effect renders eleven more fields,
 * and that `confidence_level` decides the marker colour. Each of these would have
 * changed on screen with no redraw at all.
 */
describe('DPD-026 every field the map renders participates in identity', () => {
  const sign = (list) => contentSignature(list, mapEventIdentity);
  const base = { type: 'speeding', timestamp: 1000, lat: 43.6, lng: -79.4, severity: 'high' };

  const RENDERED_FIELDS = {
    speed_kmh: [61, 84],
    speed_limit_kmh: [50, 60],
    inferred_zone_kmh: [40, 70],
    speed_limit_source: ['posted', 'inferred'],
    source: ['osm', 'learned'],
    duration_seconds: [12, 30],
    durationS: [12, 30],
    value: [3, 9],
    zone_confidence: [0.4, 0.9],
    confidence_level: ['medium', 'high'],
    signals_triggered: [['a'], ['a', 'b']],
  };

  Object.entries(RENDERED_FIELDS).forEach(([field, [before, after]]) => {
    it(`adopts the new list when ${field} changes`, () => {
      const held = [{ ...base, [field]: before }];
      const changed = [{ ...base, [field]: after }];

      expect(sign(held)).not.toBe(sign(changed));
      expect(nextStableList(held, sign(held), changed, mapEventIdentity).adopted).toBe(true);
    });
  });

  it('adopts the new list when a field appears that was previously absent', () => {
    const held = [{ ...base }];
    const enriched = [{ ...base, confidence_level: 'high' }];

    expect(nextStableList(held, sign(held), enriched, mapEventIdentity).adopted).toBe(true);
  });

  it('still holds identity when nothing at all changed', () => {
    const held = [{ ...base, speed_kmh: 61, confidence_level: 'high' }];
    const rebuilt = held.map((event) => ({ ...event }));

    expect(nextStableList(held, sign(held), rebuilt, mapEventIdentity).adopted).toBe(false);
  });

  it('does not throw on an unserialisable event, and redraws instead', () => {
    const cyclic = { ...base };
    cyclic.self = cyclic;

    expect(() => sign([cyclic])).not.toThrow();
    // Two signatures of the same cyclic event differ, so the map redraws rather
    // than risking stale content -- the safe direction.
    expect(sign([cyclic])).not.toBe(sign([cyclic]));
  });
});
