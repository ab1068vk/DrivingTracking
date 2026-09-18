/**
 * AUD-005 round 3 — the queue's truth has to survive every boundary it crosses.
 *
 * Round 2 gave the bridge a typed page, but the truth still leaked in two places:
 *
 *  1. **Java could honestly say `hasMore: false` while preserving unreadable work.** An
 *     index holding only `readable = 0` rows yields no page entries, so the page's own
 *     counters look empty — and `blocked: true, hasMore: false` was then trusted as
 *     "drained".
 *  2. **JavaScript dropped `blocked` through its zero-import shortcut**, returning a bare
 *     empty result. A caller was told "nothing to do" while the journal was deliberately
 *     holding work.
 *
 * These use the ACTUAL Java/plugin result shape rather than a bridge double that helpfully
 * manufactures `hasMore: true` — that mismatch is exactly why the round-2 suite missed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

const { nativeState } = vi.hoisted(() => ({
  nativeState: {
    android: true,
    // Shaped exactly like the plugin's payload, defaults included.
    page: {
      trips: [],
      queueStatus: { pendingCount: 0, unreadableCount: 0 },
      oversizedTripIds: [],
      unreadableTripIds: [],
      preservedUnreadableCount: 0,
      blocked: false,
      hasMore: false,
    },
    acknowledged: [],
    requests: [],
  },
}));

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => nativeState.android,
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: {
    getNativeCompletedTrips: vi.fn(async (options) => {
      nativeState.requests.push(Number(options?.maxItems) || 0);
      return nativeState.page;
    }),
    acknowledgeNativeCompletedTrips: vi.fn(async ({ tripIds }) => {
      nativeState.acknowledged.push(...(tripIds || []));
      return { success: true };
    }),
  },
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  recordSystemLog: vi.fn(),
}));

vi.mock('@/lib/secureBridge', async (importActual) => {
  const actual = await importActual();
  const HEADER = 'ROADSAGE-TEST-TRANSPORT-HEADER00';
  const seal = (plaintext) => Buffer.from(HEADER + String(plaintext), 'utf8').toString('base64');
  const open = (ciphertext) => Buffer.from(String(ciphertext), 'base64')
    .toString('utf8').slice(HEADER.length);
  return {
    ...actual,
    secureCall: async (_plugin, method, data = {}) => {
      if (Array.isArray(data?.items)) {
        return {
          batchVersion: 1,
          results: data.items.map((item, ordinal) => (method === 'encryptSensitivePayload'
            ? { ordinal, ok: true, ciphertext: seal(item.plaintext), keyVersion: Number(item.keyVersion) }
            : { ordinal, ok: true, plaintext: open(item.ciphertext) })),
        };
      }
      if (method === 'encryptSensitivePayload') return { ciphertext: seal(data.plaintext) };
      if (method === 'decryptSensitivePayload') return { plaintext: open(data.ciphertext) };
      return {};
    },
  };
});

const tripFixture = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  end_time: '2026-03-01T08:20:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.1, timestamp: '2026-03-01T08:00:00.000Z' }],
});

const nativePage = (overrides = {}) => ({
  trips: [],
  queueStatus: { pendingCount: 0, unreadableCount: 0 },
  oversizedTripIds: [],
  unreadableTripIds: [],
  preservedUnreadableCount: 0,
  blocked: false,
  hasMore: false,
  ...overrides,
});

describe('AUD-005 round 3 — queue truthfulness across the bridge', () => {
  let backing;

  beforeEach(() => {
    backing = new FakeIndexedDb();
    nativeState.android = true;
    nativeState.acknowledged = [];
    nativeState.requests = [];
    nativeState.page = nativePage();
    vi.stubGlobal('indexedDB', backing);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** 1 + 4. The exact Java shape CODEX reproduced: unreadable rows, hasMore false. */
  it('does not treat unreadable preserved work as a drained queue', async () => {
    nativeState.page = nativePage({
      queueStatus: { pendingCount: 0, unreadableCount: 1 },
      preservedUnreadableCount: 1,
      hasMore: false,
    });
    const { getNativeCompletedTripPage } = await import('@/lib/activityRecognition');

    const page = await getNativeCompletedTripPage({ maxItems: 4 });

    expect(page.blocked).toBe(true);
    expect(page.hasMore).toBe(true);
  });

  /** 2. Oversized preserved work is equally unresolved. */
  it('does not treat oversized preserved work as a drained queue', async () => {
    nativeState.page = nativePage({ oversizedTripIds: ['huge-1'], hasMore: false });
    const { getNativeCompletedTripPage } = await import('@/lib/activityRecognition');

    const page = await getNativeCompletedTripPage({ maxItems: 4 });

    expect(page.blocked).toBe(true);
    expect(page.hasMore).toBe(true);
  });

  /** 3. The zero-import shortcut must carry the reason out. */
  it('preserves blocked through an empty import result', async () => {
    nativeState.page = nativePage({
      queueStatus: { pendingCount: 0, unreadableCount: 2 },
      preservedUnreadableCount: 2,
      hasMore: false,
    });
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(0);
    expect(result.blocked).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.preservedUnreadableCount).toBe(2);
    expect(nativeState.acknowledged).toHaveLength(0);
  });

  /** 6. Unreadable ids are reported, not silently swallowed. */
  it('reports the unreadable entries it was told about', async () => {
    nativeState.page = nativePage({
      unreadableTripIds: ['bad-1', 'bad-2'],
      queueStatus: { pendingCount: 0, unreadableCount: 2 },
      hasMore: false,
    });
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');

    const result = await syncNativeCompletedTrips();

    expect(result.unreadableTripIds).toEqual(['bad-1', 'bad-2']);
    expect(result.blocked).toBe(true);
  });

  /** 9. A genuinely clean queue must still report drained. */
  it('still reports a clean empty queue as drained', async () => {
    nativeState.page = nativePage();
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(0);
    expect(result.blocked).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  /** 10. An ordinary small queue still imports and acknowledges exactly once. */
  it('imports and acknowledges a small ordinary queue exactly once', async () => {
    nativeState.page = nativePage({
      trips: [tripFixture('ordinary-1')],
      queueStatus: { pendingCount: 1, unreadableCount: 0 },
      hasMore: false,
    });
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(1);
    expect(nativeState.acknowledged).toEqual(['ordinary-1']);
    expect(result.blocked).toBe(false);
  });
});

/**
 * Structural guards for the Android half — the Java cannot be exercised off-device, and
 * these are properties of the source rather than of one run.
 */
describe('AUD-005 round 3 — Android source guards', () => {
  const read = async (path) => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  };
  const JOURNAL = 'android/app/src/main/java/com/drivesense/app/DriveSenseCompletedTripJournal.java';
  const PLUGIN = 'android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java';

  /** 5. The fallback advances past a stable unreadable prefix instead of starving. */
  it('advances the fallback scan past unreadable names', async () => {
    const journal = await read(JOURNAL);
    const start = journal.indexOf('static PendingPage pendingTripIdsPage');
    const body = journal.slice(start, journal.indexOf('static boolean hasCompletedTrip', start));
    // A durable watermark, and unreadable names step the cursor rather than stopping it.
    expect(body).toMatch(/readFallbackScanWatermark\(context\)/);
    expect(body).toMatch(/writeFallbackScanWatermark\(context,/);
    // AUD-005: it must still ADVANCE past an unreadable manifest — that is the gain
    // this test was written to protect — but it may no longer FORGET it, so the
    // literal early return became a recording branch.
    expect(body).toMatch(/if \(manifest == null\) \{[\s\S]{0,400}?return true;/);
    expect(body).toMatch(/unreadableTripIds\.add\(stem\)/);
    expect(body).toMatch(/MAX_FALLBACK_SCAN_ENTRIES/);
  });

  /** 1. Java's own hasMore accounts for preserved unreadable work. */
  it('accounts for preserved unreadable work in the page verdict', async () => {
    const journal = await read(JOURNAL);
    const start = journal.indexOf('static JSONObject getCompletedTripPage');
    const body = journal.slice(start, journal.indexOf('static final class PendingPage', start));
    expect(body).toMatch(/preservedUnreadable/);
    expect(body).toMatch(/preservedUnreadable > 0L/);

    const plugin = await read(PLUGIN);
    const pluginStart = plugin.indexOf('public void getNativeCompletedTrips(PluginCall call)');
    const pluginBody = plugin.slice(
      pluginStart, plugin.indexOf('public void acknowledgeNativeCompletedTrips', pluginStart),
    );
    expect(pluginBody).toMatch(/preservedUnreadableCount/);
  });

  /** 8. No whole-backlog scan may be reintroduced. */
  it('keeps every whole-backlog enumeration out of the journal', async () => {
    const journal = await read(JOURNAL);
    expect(journal).not.toMatch(/orderedPendingTripIds/);
    expect(journal).not.toMatch(/List<LoadedTrip>/);
    expect(journal).not.toMatch(/static JSONArray getCompletedTrips\(Context context\)/);
  });
});
