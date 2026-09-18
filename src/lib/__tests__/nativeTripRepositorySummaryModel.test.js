import { beforeEach, describe, expect, it, vi } from 'vitest';

// PH-2 regression. The native canonical bounded page returns the archive's own
// column names (`distance` in km, `duration` in seconds) and, unlike
// getTripMetadata, does not copy `distance_km`/`duration_seconds` out of the
// encrypted display metadata. Every trip list, trip card and history total in
// the app reads the app trip model, so an unmapped summary rendered every trip
// as "0 m" and "0m" on the native-authority path while canonical storage was
// correct. This pins the mapping at the adapter boundary.

const queryHistoryPage = vi.fn();
const overview = vi.fn();

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    queryHistoryPage: (...args) => queryHistoryPage(...args),
    overview: (...args) => overview(...args),
  },
  iterateNativeTripJsonArray: vi.fn(),
  readNativeTripPayload: vi.fn(),
  streamJsonToCanonicalCommit: vi.fn(),
}));

vi.mock('@/lib/tripFullFidelity', () => ({
  analyzeNativeTripFullFidelity: vi.fn(),
  splitNativeTripAtStopsStreamed: vi.fn(),
}));

const { nativeTripRepository } = await import('@/lib/nativeTripRepository');

const canonicalRow = (overrides = {}) => ({
  id: 'physical-h-trip',
  revision: 1,
  canonical_seq: 3,
  start_time_ms: 1_800_000_000_000,
  start_time: '2027-01-15T08:00:00Z',
  status: 'completed',
  point_count: 300,
  distance: 0.17900815420292046,
  duration: 300,
  ...overrides,
});

beforeEach(() => {
  queryHistoryPage.mockReset();
  overview.mockReset();
  queryHistoryPage.mockResolvedValue({ items: [canonicalRow()], nextCursor: null });
  overview.mockResolvedValue({ points: [] });
});

describe('native canonical summaries carry the app trip model', () => {
  it('maps distance and duration onto listSummaries rows', async () => {
    const [summary] = await nativeTripRepository.listSummaries();
    expect(summary.distance_km).toBe(0.17900815420292046);
    expect(summary.duration_seconds).toBe(300);
    // The canonical column names must survive untouched.
    expect(summary.distance).toBe(0.17900815420292046);
    expect(summary.duration).toBe(300);
  });

  it('maps list() rows too', async () => {
    const [summary] = await nativeTripRepository.list();
    expect(summary.distance_km).toBe(0.17900815420292046);
    expect(summary.duration_seconds).toBe(300);
  });

  it('maps listProjections rows and preserves the cursor contract', async () => {
    queryHistoryPage.mockResolvedValue({ items: [canonicalRow()], nextCursor: 'cursor-token' });
    const result = await nativeTripRepository.listProjections();
    expect(result.rows[0].distance_km).toBe(0.17900815420292046);
    expect(result.rows[0].duration_seconds).toBe(300);
    expect(result.nextCursor).toBe('cursor-token');
    expect(result.hasMore).toBe(true);
  });

  it('maps listForSpeedMap rows', async () => {
    const { trips } = await nativeTripRepository.listForSpeedMap();
    expect(trips[0].distance_km).toBe(0.17900815420292046);
    expect(trips[0].duration_seconds).toBe(300);
    expect(trips[0].route_overview_only).toBe(true);
  });

  it('never overwrites app-model fields a native row already supplies', async () => {
    queryHistoryPage.mockResolvedValue({
      items: [canonicalRow({ distance_km: 42, duration_seconds: 99 })],
      nextCursor: null,
    });
    const [summary] = await nativeTripRepository.listSummaries();
    expect(summary.distance_km).toBe(42);
    expect(summary.duration_seconds).toBe(99);
  });

  it('leaves rows alone when the canonical values are missing or unusable', async () => {
    queryHistoryPage.mockResolvedValue({
      items: [{ id: 'no-metrics', revision: 1 }, { id: 'bad-metrics', revision: 1, distance: 'x', duration: null }],
      nextCursor: null,
    });
    const [missing, unusable] = await nativeTripRepository.listSummaries();
    expect(missing.distance_km).toBeUndefined();
    expect(missing.duration_seconds).toBeUndefined();
    expect(unusable.distance_km).toBeUndefined();
    // `Number(null)` is 0, which is a truthful zero for a canonical NULL duration.
    expect(unusable.duration_seconds).toBe(0);
  });

  it('keeps unbounded queries forbidden', async () => {
    expect(() => nativeTripRepository.listAllSummaries()).toThrow(/unbounded/i);
    expect(() => nativeTripRepository.listAll()).toThrow(/unbounded/i);
  });
});
