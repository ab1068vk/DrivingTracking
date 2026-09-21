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
