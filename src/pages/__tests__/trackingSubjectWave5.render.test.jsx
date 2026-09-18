import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Canonical Detail Identity — Wave 5 (HPR-017), at the three destinations.
 *
 * The identity authority is unit-tested in
 * `src/lib/__tests__/canonicalDetailIdentityWave5.test.js`. What is proved here is
 * the load-bearing wiring: that Map Workspace, Event Timeline and Data Quality
 * actually read the `?trip=` their callers emit, actually ask their id-addressed
 * detail query about that trip, and actually render that trip.
 *
 * The query mock is deliberately **parameter-sensitive**: a `['p7','detail',<id>]`
 * key is answered from that id's own fixture, and a history/geometry key from the
 * bounded window. A page that asks the wrong question is handed the wrong answer
 * rather than the right one by accident, which is what makes these assertions
 * discriminate.
 */

let search = '';
const detailById = new Map();
const detailErrors = new Set();
let windowRows = [];

const visibleText = (html) => String(html)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useLocation: () => ({ pathname: '/tracking/events', search, hash: '', state: null }),
  useSearchParams: () => [new URLSearchParams(search), vi.fn()],
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useQuery: ({ queryKey, enabled }) => {
    if (enabled === false) {
      return { data: undefined, isLoading: false, isPending: true, isError: false, isFetching: false };
    }
    const [family, kind, id] = Array.isArray(queryKey) ? queryKey : [];
    if (family === 'p7' && kind === 'detail') {
      if (detailErrors.has(String(id))) {
        return { data: undefined, isLoading: false, isPending: false, isError: true, isFetching: false };
      }
      const trip = detailById.get(String(id));
      return {
        data: trip,
        isLoading: false,
        isPending: !trip,
        isError: false,
        isFetching: false,
      };
    }
    if (family === 'p7' && kind === 'history') {
      return {
        data: { rows: windowRows, exact: false, continuation: 'cursor', unavailable: null },
        isLoading: false, isPending: false, isError: false, isFetching: false,
      };
    }
    if (family === 'p7' && kind === 'geom') {
      return {
        data: { trips: windowRows, exact: false, nextCursor: 'cursor', unavailable: null, readiness: null },
        isLoading: false, isPending: false, isError: false, isFetching: false,
      };
    }
    return { data: undefined, isLoading: false, isPending: false, isError: false, isFetching: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn(), prefetchQuery: vi.fn() }),
}));

vi.mock('@/components/TripMap', () => ({ default: () => <div>Trip map placeholder</div> }));
vi.mock('@/components/TripPlayback', () => ({ default: () => <div>Trip playback placeholder</div> }));
vi.mock('@/hooks/useTripSpeedKnowledge', () => ({
  useTripSpeedKnowledge: () => ({ results: [], failed: false, reload: vi.fn() }),
}));
vi.mock('@/lib/dangerZoneEngine', () => ({ loadDangerZones: () => [] }));

const settings = { units: 'metric', experience_mode: 'tracking' };
vi.mock('@/hooks/useLocalSettings', () => ({ default: () => settings }));

/**
 * Two deliberately incompatible trips. Every rendered number differs, so a
 * cross-subject contamination shows up as a value rather than as an id.
 */
const TRIP_X = {
  id: 'trip-X-archived',
  status: 'completed',
  start_time: '2024-02-29T03:07:00.000Z',
  end_time: '2024-02-29T04:07:00.000Z',
  distance_km: 412.5,
  duration_seconds: 3_600,
  score: 41,
  // Seven points against Y's two: the Map inspector names its subject by date and
  // retained-point count, so the two trips cannot be confused there either.
  route_points: Array.from({ length: 7 }, (_, index) => ({
    lat: 51.5001 + (index / 10_000),
    lng: -0.1001 - (index / 10_000),
    speed_kmh: 109 + index,
    timestamp: `2024-02-29T03:0${index}:00.000Z`,
  })),
  driving_events: [{
    type: 'harsh_brake',
    timestamp: '2024-02-29T03:08:00.000Z',
    speed_kmh: 113,
    speed_limit_kmh: 70,
    source: 'gps',
    lat: 51.5002,
    lng: -0.1002,
  }],
};

const TRIP_Y = {
  id: 'trip-Y-newest',
  status: 'completed',
  start_time: '2026-09-16T18:45:00.000Z',
  end_time: '2026-09-16T18:50:00.000Z',
  distance_km: 2.25,
  duration_seconds: 300,
  score: 97,
  route_points: [
    { lat: 43.6501, lng: -79.3801, speed_kmh: 22, timestamp: '2026-09-16T18:45:00.000Z' },
    { lat: 43.6502, lng: -79.3802, speed_kmh: 24, timestamp: '2026-09-16T18:46:00.000Z' },
  ],
  driving_events: [{
    type: 'rapid_acceleration',
    timestamp: '2026-09-16T18:46:00.000Z',
    speed_kmh: 24,
    speed_limit_kmh: 40,
    source: 'gps',
    lat: 43.6502,
    lng: -79.3802,
  }],
};

const summaryOf = (trip) => ({
  id: trip.id,
  status: trip.status,
  start_time: trip.start_time,
  end_time: trip.end_time,
  distance_km: trip.distance_km,
  duration_seconds: trip.duration_seconds,
  score: trip.score,
});

/** The window holds Y and 49 filler rows. X is outside it — as the defect requires. */
const seedWindowWithoutX = () => {
  windowRows = [
    summaryOf(TRIP_Y),
    ...Array.from({ length: 49 }, (_, index) => ({
      id: `trip-filler-${index}`,
      status: 'completed',
      start_time: `2026-08-${String(1 + (index % 28)).padStart(2, '0')}T09:00:00.000Z`,
      distance_km: 5 + index,
      duration_seconds: 900,
      score: 80,
    })),
  ];
};

const renderPage = async (moduleId) => {
  const { default: Page } = await import(moduleId);
  return renderToStaticMarkup(<Page />);
};

const DESTINATIONS = [
  ['Event Timeline', '@/pages/TrackingEvents'],
  ['Data Quality', '@/pages/TrackingEvidenceConsole'],
  ['Map Workspace', '@/pages/TrackingMapWorkspace'],
];

beforeEach(() => {
  search = '';
  detailById.clear();
  detailErrors.clear();
  detailById.set(TRIP_X.id, TRIP_X);
  detailById.set(TRIP_Y.id, TRIP_Y);
  seedWindowWithoutX();
});

/** How this machine renders Y's start time, so the Map's subject can be named. */
const newestWhen = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(TRIP_Y.start_time));

/** The Map names its subject in the inspector, not in a `<select value>`. */
const mapSubject = (text) => {
  const at = /Selected trip ([A-Za-z]{3} \d{1,2},[^R]*)Route points retained (\d+)/.exec(text);
  return at ? { when: at[1].trim(), points: at[2] } : null;
};

describe('HPR-017 — every destination renders the trip its link named', () => {
  it.each(DESTINATIONS)('%s asks its detail query about the requested trip', async (name, moduleId) => {
    search = `?trip=${encodeURIComponent(TRIP_X.id)}`;
    const asked = [];
    const query = await import('@tanstack/react-query');
    const original = query.useQuery;
    const spy = vi.spyOn(query, 'useQuery').mockImplementation((options) => {
      const key = options?.queryKey;
      if (Array.isArray(key) && key[0] === 'p7' && key[1] === 'detail' && options.enabled !== false) {
        asked.push(String(key[2]));
      }
      return original(options);
    });

    await renderPage(moduleId);

    expect(asked, name).toContain(TRIP_X.id);
    expect(asked, name).not.toContain(TRIP_Y.id);
    spy.mockRestore();
  });

  it("Event Timeline shows the linked trip's event, not the newest trip's", async () => {
    search = `?trip=${encodeURIComponent(TRIP_X.id)}`;
    const html = await renderPage('@/pages/TrackingEvents');
    const text = visibleText(html);

    expect(text).toContain('Harsh Brake');
    expect(text).not.toContain('Rapid Acceleration');
    // The picker shows the subject on screen, even though the window omits it.
    expect(html).toContain(`value="${TRIP_X.id}"`);
    expect(html).toContain('(linked)');
  });

  it('Event Timeline shows the newest trip when nothing was named', async () => {
    search = '';
    const html = await renderPage('@/pages/TrackingEvents');
    const text = visibleText(html);

    // RED 4: the legitimate no-id default is preserved.
    expect(text).toContain('Rapid Acceleration');
    expect(text).not.toContain('Harsh Brake');
    expect(html).not.toContain('(linked)');
  });

  it("Data Quality reports the linked trip's evidence, not the newest trip's", async () => {
    search = `?trip=${encodeURIComponent(TRIP_X.id)}`;
    const html = await renderPage('@/pages/TrackingEvidenceConsole');
    const text = visibleText(html);

    expect(text).toContain('Data Quality');
    expect(html).toContain(`value="${TRIP_X.id}"`);
    expect(html).toContain('(linked)');
    // Evidence is built from X's record: its distance and its single harsh brake.
    expect(text).toMatch(/412/);
    expect(text).not.toMatch(/2\.25/);
  });

  it('Data Quality falls back to the newest trip only when nothing was named', async () => {
    search = '';
    const html = await renderPage('@/pages/TrackingEvidenceConsole');

    expect(html).toContain(`value="${TRIP_Y.id}"`);
    expect(html).not.toContain('(linked)');
  });

  it("Map Workspace draws the linked trip's route, not the newest trip's", async () => {
    search = `?trip=${encodeURIComponent(TRIP_X.id)}`;
    const text = visibleText(await renderPage('@/pages/TrackingMapWorkspace'));

    expect(text).toContain('Trip map placeholder');
    // Seven retained points are X's; Y has two. The formatted date is asserted
    // against Y's rather than against a fixed string, because the render locale
    // and time zone are the machine's, not the fixture's.
    expect(mapSubject(text).points).toBe('7');
    expect(mapSubject(text).when).not.toBe(newestWhen);
    // The selector offers the linked trip even though the geometry page omits it.
    expect(text).toContain('Linked trip');
  });

  it('Map Workspace shows the newest trip when nothing was named', async () => {
    search = '';
    const text = visibleText(await renderPage('@/pages/TrackingMapWorkspace'));

    expect(mapSubject(text).points).toBe('2');
    expect(mapSubject(text).when).toBe(newestWhen);
    expect(text).not.toContain('Linked trip');
  });
});

describe('HPR-017 — an unresolvable link is reported, never substituted', () => {
  it.each(DESTINATIONS)('%s states the trip is unavailable', async (name, moduleId) => {
    search = '?trip=trip-never-existed';
    detailErrors.add('trip-never-existed');
    const text = visibleText(await renderPage(moduleId));

    expect(text, name).toContain('trip-never-existed');
    expect(text, name).toMatch(/is not available on this device/);
    expect(text, name).toMatch(/No other trip has been shown in its place/);
  });

  it.each(DESTINATIONS)('%s refuses a malformed link without falling back', async (name, moduleId) => {
    search = `?trip=${'x'.repeat(400)}`;
    const text = visibleText(await renderPage(moduleId));

    expect(text, name).toMatch(/does not name a trip this device can open/);
  });

  it('no substituted subject survives on any destination', async () => {
    search = '?trip=trip-never-existed';
    detailErrors.add('trip-never-existed');

    const events = visibleText(await renderPage('@/pages/TrackingEvents'));
    expect(events).not.toContain('Rapid Acceleration');
    expect(events).not.toContain('Harsh Brake');

    const evidence = visibleText(await renderPage('@/pages/TrackingEvidenceConsole'));
    expect(evidence).not.toMatch(/412/);
    expect(evidence).not.toMatch(/2\.25/);

    const map = visibleText(await renderPage('@/pages/TrackingMapWorkspace'));
    expect(mapSubject(map)).toBeNull();
    expect(map).toContain('Selected trip source unavailable');
    expect(map).toContain('Linked trip unavailable');
  });
});
