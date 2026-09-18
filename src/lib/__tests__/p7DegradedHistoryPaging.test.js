import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P7-IMPL-F07 — Q1 continuation on a platform with no IndexedDB.
 *
 * The degraded path was added so a migrated page would not report the store as
 * unreadable where the read it replaced had a fallback source. It returned a
 * real continuation — and then ignored it: `degradedHistoryPage` always sliced
 * from zero, so page two was page one, for as long as the caller kept asking.
 *
 * Any consumer that pages to EOF — the Report's finish action, an export, a
 * Q10 reducer run — therefore never terminated, and a list that appended pages
 * showed the newest drives over and over.
 *
 * The tests below page to EOF and assert the three properties a continuation
 * exists to provide: every eligible row exactly once, in the requested order,
 * under the requested filters. They also assert the degradation stays visible
 * in the counter, because this path is genuinely not bounded work — presenting
 * it as an ordinary page is the other half of the finding.
 */

const DAY = 86400000;
const BASE = Date.UTC(2026, 5, 1, 9);

/** The fallback blob is the primary store on this platform. */
const TRIPS = Array.from({ length: 47 }, (_, index) => ({
  id: `trip-${String(index + 1).padStart(3, '0')}`,
  status: index % 7 === 0 ? 'draft' : 'completed',
  start_time: new Date(BASE + index * DAY).toISOString(),
  end_time: new Date(BASE + index * DAY + 900000).toISOString(),
  distance_km: 4 + (index % 9),
  duration_seconds: 600 + (index % 5) * 60,
  score_overall: 55 + (index % 40),
  driver_metric_eligible: true,
  score_confidence: 0.9,
  vehicle_id: 'car-a',
  route_points: [],
}));

const store = new Map();

vi.mock('@/lib/mobileStorage', () => ({
  STORAGE_PRESENCE: { PRESENT: 'present', ABSENT: 'absent', UNKNOWN: 'unknown' },
  getJson: vi.fn(async (key, fallback = null) => (store.has(key) ? store.get(key) : fallback)),
  setJson: vi.fn(async (key, value) => { store.set(key, value); }),
  removeJson: vi.fn(async (key) => { store.delete(key); }),
  probeStoredJson: vi.fn(async () => ({ presence: 'absent', value: null })),
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: {
    get: () => ({ settings_defaults_version: 11, data_retention_days: 3650, privacy_zones: [] }),
    set: () => {},
  },
}));

let repository;

beforeEach(async () => {
  store.clear();
  store.set('drivesense_trips', TRIPS);
  // No IndexedDB at all: this is the platform the degraded path exists for.
  vi.stubGlobal('indexedDB', undefined);
  vi.resetModules();
  repository = await import('@/lib/localTripRepository');
});

/** Page to EOF, returning every row seen and how many turns it took. */
const pageToEof = async (request, { maxTurns = 100 } = {}) => {
  const rows = [];
  const pages = [];
  let cursor = null;
  let turns = 0;
  for (; turns < maxTurns; turns += 1) {
    const page = await repository.queryTripHistoryPage({ ...request, cursor });
    expect(page.unavailable, `turn ${turns}`).toBeUndefined();
    pages.push(page);
    rows.push(...page.data);
    cursor = page.continuation;
    if (!cursor) break;
  }
  return { rows, pages, turns: turns + 1 };
};

describe('P7-IMPL-F07 — the degraded page honours its own continuation', () => {
  it('page two is not page one', async () => {
    const first = await repository.queryTripHistoryPage({ limit: 10, status: 'completed' });
    expect(first.data).toHaveLength(10);
    expect(first.continuation).toBeTruthy();

    const second = await repository.queryTripHistoryPage({
      limit: 10, status: 'completed', cursor: first.continuation,
    });
    expect(second.data).toHaveLength(10);

    const firstIds = first.data.map((row) => row.id);
    const secondIds = second.data.map((row) => row.id);
    expect(secondIds).not.toEqual(firstIds);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  it('reaches EOF with every eligible row exactly once, in order', async () => {
    const { rows, turns } = await pageToEof({ limit: 10, status: 'completed' });
    const eligible = TRIPS.filter((trip) => trip.status === 'completed');

    const ids = rows.map((row) => row.id);
    expect(ids).toHaveLength(eligible.length);
    expect(new Set(ids).size).toBe(ids.length);
    // Newest first, the requested order, with no re-sorting between pages.
    const times = rows.map((row) => Date.parse(row.start_time));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    expect(turns).toBe(Math.ceil(eligible.length / 10));
  });

  it('preserves the status filter across every page', async () => {
    const { rows } = await pageToEof({ limit: 6, status: 'completed' });
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
    expect(rows.some((row) => row.status === 'draft')).toBe(false);
  });

  it('preserves the date range across every page', async () => {
    const range = { fromMs: BASE + 10 * DAY, toMs: BASE + 30 * DAY };
    const { rows } = await pageToEof({ limit: 5, status: 'completed', range });

    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      const at = Date.parse(row.start_time);
      expect(at).toBeGreaterThanOrEqual(range.fromMs);
      // Half-open on both authorities.
      expect(at).toBeLessThan(range.toMs);
    }
    const expected = TRIPS.filter((trip) => {
      const at = Date.parse(trip.start_time);
      return trip.status === 'completed' && at >= range.fromMs && at < range.toMs;
    });
    expect(rows.map((row) => row.id).sort()).toEqual(expected.map((trip) => trip.id).sort());
  });

  it('pages an unfiltered request, where "any" is not a status value', async () => {
    // The status-binding half of the correction: `normalizeCursorBind` renders
    // "no status filter" as the literal `any`, which matches no row.
    const { rows } = await pageToEof({ limit: 12 });
    expect(rows).toHaveLength(TRIPS.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(TRIPS.length);
  });

  it('preserves the oldest-first ordering too', async () => {
    const { rows } = await pageToEof({ limit: 9, sort: 'start_time', status: 'completed' });
    const times = rows.map((row) => Date.parse(row.start_time));
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('refuses a continuation replayed under a different query', async () => {
    const first = await repository.queryTripHistoryPage({ limit: 10, status: 'completed' });
    const crossed = await repository.queryTripHistoryPage({
      limit: 10, status: 'draft', cursor: first.continuation,
    });
    expect(crossed.data).toBeNull();
    expect(crossed.unavailable.code).toBe('CURSOR_QUERY_MISMATCH');
  });

  it('keeps the degradation visible in the counter, one sort per turn', async () => {
    const before = repository.__projectionCountersForTests().historySorts;
    const { turns } = await pageToEof({ limit: 10, status: 'completed' });
    const after = repository.__projectionCountersForTests().historySorts;
    // Each turn reads the whole fallback blob: this path is NOT bounded work,
    // and the counter is how a caller and the release audit can see that. It is
    // never presented as an ordinary bounded page.
    expect(after - before).toBe(turns);
  });

  it('a page that consumed its continuation reports EXACT at EOF', async () => {
    const { pages } = await pageToEof({ limit: 10, status: 'completed' });
    for (const page of pages.slice(0, -1)) {
      expect(page.continuation).toBeTruthy();
      expect(page.completeness).toBe('EXACT');
    }
    expect(pages.at(-1).continuation).toBeNull();
    expect(pages.at(-1).completeness).toBe('EXACT');
  });
});
