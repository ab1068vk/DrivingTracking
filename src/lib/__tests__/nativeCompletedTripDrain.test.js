/**
 * AUD-005 — shipping completed-trip intake must drain in bounded pages.
 *
 * On the shipping (browser-authority) build the whole pending native journal crossed the
 * bridge as ONE payload, was retained as ONE JavaScript array, and was imported and
 * acknowledged as one unit. The cost of opening the app after a long offline stretch was
 * therefore proportional to everything that had accumulated — and a failure anywhere in
 * that single unit acknowledged nothing, so the next attempt paid the whole cost again.
 *
 * These regressions fix the shape of the intake, not the authority: the drain asks for a
 * bounded page, imports and acknowledges that page, and only then asks for the next one.
 * Nothing is dropped to stay bounded — what a turn does not reach stays queued and is
 * reported as remaining.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

const { nativeState } = vi.hoisted(() => ({
  nativeState: {
    android: true,
    queue: [],
    requests: [],
    acknowledged: [],
    acknowledgeFailsFrom: null,
    unreadableTripIds: [],
    oversizedTripIds: [],
    ignorePageSize: false,
  },
}));

vi.mock('@/lib/nativePlatform', async (importActual) => {
  const actual = await importActual();
  return { ...actual, isAndroid: () => nativeState.android };
});

// The Android branch routes payload crypto through the native SecureBridge plugin, which
// does not exist off-device. This stands in for it so the shipping intake path can be
// exercised in-process; it is a transport stand-in, not a change to what is stored.
vi.mock('@/lib/secureBridge', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    secureCall: async (_plugin, method, data = {}) => {
      // A fixed header keeps every "ciphertext" past the envelope's minimum length.
      const HEADER = 'ROADSAGE-TEST-TRANSPORT-HEADER00';
      const seal = (plaintext) => Buffer.from(HEADER + String(plaintext), 'utf8').toString('base64');
      const open = (ciphertext) => Buffer.from(String(ciphertext), 'base64')
        .toString('utf8').slice(HEADER.length);
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

vi.mock('@/lib/activityRecognition', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    // Round 2: the bridge answers with the journal's own verdict, not just trips.
    getNativeCompletedTripPage: async (options = {}) => {
      const maxItems = Number(options?.maxItems) || 0;
      nativeState.requests.push(maxItems);
      const pending = nativeState.queue.filter(
        (trip) => !nativeState.acknowledged.includes(trip.id),
      );
      const page = nativeState.ignorePageSize || maxItems <= 0
        ? pending
        : pending.slice(0, maxItems);
      const unreadableTripIds = nativeState.unreadableTripIds || [];
      return {
        trips: page,
        queueStatus: { pendingCount: pending.length + unreadableTripIds.length },
        oversizedTripIds: nativeState.oversizedTripIds || [],
        unreadableTripIds,
        blocked: unreadableTripIds.length > 0 || (nativeState.oversizedTripIds || []).length > 0,
        hasMore: page.length < pending.length
          || unreadableTripIds.length > 0
          || (nativeState.oversizedTripIds || []).length > 0,
      };
    },
    acknowledgeNativeCompletedTrips: async (ids = []) => {
      if (nativeState.acknowledgeFailsFrom != null
        && ids.some((id) => id === nativeState.acknowledgeFailsFrom)) {
        return { success: false };
      }
      nativeState.acknowledged.push(...ids);
      return { success: true };
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

let backing;

beforeEach(() => {
  backing = new FakeIndexedDb();
  nativeState.android = true;
  nativeState.queue = [];
  nativeState.requests = [];
  nativeState.acknowledged = [];
  nativeState.acknowledgeFailsFrom = null;
  nativeState.unreadableTripIds = [];
  nativeState.oversizedTripIds = [];
  nativeState.ignorePageSize = false;
  vi.stubGlobal('indexedDB', backing);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('AUD-005 bounded native completed-trip drain', () => {
  it('asks the bridge for a bounded page instead of the whole queue', async () => {
    const { syncNativeCompletedTrips, NATIVE_IMPORT_PAGE_SIZE } =
      await import('@/lib/localTripRepository');
    nativeState.queue = Array.from({ length: 9 }, (_, index) => tripFixture(`drain-${index}`));

    await syncNativeCompletedTrips();

    expect(NATIVE_IMPORT_PAGE_SIZE).toBeGreaterThan(0);
    expect(nativeState.requests.length).toBeGreaterThan(1);
    nativeState.requests.forEach((maxItems) => {
      expect(maxItems).toBeGreaterThan(0);
      expect(maxItems).toBeLessThanOrEqual(NATIVE_IMPORT_PAGE_SIZE);
    });
  });

  it('imports every queued trip across pages and acknowledges each page', async () => {
    const { syncNativeCompletedTrips, localTripRepository } =
      await import('@/lib/localTripRepository');
    nativeState.queue = Array.from({ length: 9 }, (_, index) => tripFixture(`drain-${index}`));

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(9);
    expect(nativeState.acknowledged).toHaveLength(9);
    // Every one of them is durable, not merely reported.
    for (const trip of nativeState.queue) {
      await expect(localTripRepository.getLegacyTripForMigration(trip.id))
        .resolves.toMatchObject({ id: trip.id });
    }
  });

  /** A page that succeeded must stay acknowledged even if a later page fails. */
  it('keeps earlier pages acknowledged when a later page cannot be acknowledged', async () => {
    const { syncNativeCompletedTrips, NATIVE_IMPORT_PAGE_SIZE } =
      await import('@/lib/localTripRepository');
    nativeState.queue = Array.from({ length: 9 }, (_, index) => tripFixture(`drain-${index}`));
    nativeState.acknowledgeFailsFrom = `drain-${NATIVE_IMPORT_PAGE_SIZE}`;   // first of page two

    await syncNativeCompletedTrips();

    expect(nativeState.acknowledged).toHaveLength(NATIVE_IMPORT_PAGE_SIZE);
    expect(nativeState.acknowledged).toContain('drain-0');
    expect(nativeState.acknowledged).not.toContain(`drain-${NATIVE_IMPORT_PAGE_SIZE}`);
  });

  /** Bounded must not mean lossy: what a turn does not reach is still queued. */
  it('reports remaining work instead of silently dropping it', async () => {
    const { syncNativeCompletedTrips, NATIVE_IMPORT_MAX_PAGES, NATIVE_IMPORT_PAGE_SIZE } =
      await import('@/lib/localTripRepository');
    const total = NATIVE_IMPORT_PAGE_SIZE * (NATIVE_IMPORT_MAX_PAGES + 2);
    nativeState.queue = Array.from({ length: total }, (_, index) => tripFixture(`bulk-${index}`));

    const result = await syncNativeCompletedTrips();

    expect(result.hasMore).toBe(true);
    expect(result.importedTrips.length)
      .toBe(NATIVE_IMPORT_PAGE_SIZE * NATIVE_IMPORT_MAX_PAGES);
    // Everything not imported is still pending natively — nothing was dropped.
    expect(nativeState.acknowledged).toHaveLength(result.importedTrips.length);
  });

  /** One turn must be bounded regardless of how much has accumulated. */
  it('does not grow the number of bridge reads with the size of the queue', async () => {
    const { syncNativeCompletedTrips, NATIVE_IMPORT_MAX_PAGES } =
      await import('@/lib/localTripRepository');
    nativeState.queue = Array.from({ length: 400 }, (_, index) => tripFixture(`huge-${index}`));

    await syncNativeCompletedTrips();

    expect(nativeState.requests.length).toBeLessThanOrEqual(NATIVE_IMPORT_MAX_PAGES + 1);
  });

  /** A queue that empties must stop, not spin on a bridge that keeps answering. */
  it('stops as soon as the queue is empty', async () => {
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');
    nativeState.queue = [tripFixture('only-one')];

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(nativeState.requests.length).toBeLessThanOrEqual(2);
  });
});

/**
 * Structural guards for the Android half of the drain.
 *
 * These are source assertions rather than behavioural tests on purpose: the Java they
 * defend cannot be exercised off-device, and the property at stake — that no code path
 * materialises the whole pending queue — is a property of the source, not of one run.
 */
describe('AUD-005 shipping intake boundedness (Android source)', () => {
  const read = async (path) => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  };
  const JOURNAL = 'android/app/src/main/java/com/drivesense/app/DriveSenseCompletedTripJournal.java';
  const STORE = 'android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java';
  const PLUGIN = 'android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java';

  it('has no whole-queue journal scan or enumeration left to call', async () => {
    const journal = await read(JOURNAL);
    expect(journal).not.toMatch(/List<LoadedTrip>/);
    expect(journal).not.toMatch(/static JSONArray getCompletedTrips\(Context context\)/);
    // Round 2: the whole-backlog list-read-sort is gone, replaced by a bounded page.
    expect(journal).not.toMatch(/orderedPendingTripIds/);
    expect(journal).toMatch(/static PendingPage pendingTripIdsPage\(Context context, int maxItems\)/);
    expect(journal).toMatch(/static JSONObject getCompletedTripPage\(Context context, int maxItems\)/);
  });

  it('bounds one compatibility turn by BYTES, not only by item count', async () => {
    const journal = await read(JOURNAL);
    expect(journal).toMatch(/MAX_PAGE_PLAINTEXT_BYTES/);
    // The size is checked against the manifest BEFORE the trip is materialized.
    const start = journal.indexOf('static JSONObject getCompletedTripPage');
    const body = journal.slice(start, journal.indexOf('static final class PendingPage', start));
    expect(body).toMatch(/optLong\("plaintext_bytes", 0L\)/);
    expect(body.indexOf('plaintext_bytes')).toBeLessThan(body.indexOf('readTrip(directory, stem, manifest)'));
    expect(body).toMatch(/oversized\.put\(tripId\)/);
  });

  it('takes its bounded page from the durable index or a bounded directory page', async () => {
    const journal = await read(JOURNAL);
    const start = journal.indexOf('static PendingPage pendingTripIdsPage');
    // Bound the slice to this method: the rest of the file legitimately still lists
    // manifests for whole-journal maintenance that is not on the page path.
    const body = journal.slice(start, journal.indexOf('static boolean hasCompletedTrip', start));
    expect(start).toBeGreaterThanOrEqual(0);
    // AUD-005: the same bounded index read, now with a keyset continuation.
    expect(body).toMatch(/oldestPage\(context, limit \+ 1, cursor\)/);
    expect(body).toMatch(/DriveSenseDirectoryStream\.visit\(/);
    // No global sort over the whole backlog.
    expect(body).not.toMatch(/manifestFiles\(directory\(context\)\)/);
  });

  it('bounds the chunk count a manifest may claim', async () => {
    const journal = await read(JOURNAL);
    expect(journal).not.toMatch(/MAX_CHUNKS_PER_TRIP\s*=\s*Integer\.MAX_VALUE/);
    const declared = journal.match(/MAX_CHUNKS_PER_TRIP\s*=\s*(\d+)/);
    expect(declared).not.toBeNull();
    expect(Number(declared[1])).toBeGreaterThan(0);
    // Comfortably above CODEX's 52+ MiB capture control at 320 KiB of plaintext a chunk.
    expect(Number(declared[1])).toBeGreaterThan((52 * 1024 * 1024) / (320 * 1024));
  });

  it('acknowledges pending emergency workflows one trip at a time', async () => {
    const store = await read(STORE);
    const start = store.indexOf('static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow');
    const end = store.indexOf('static void clearCompletedTrips', start);
    const body = store.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).not.toMatch(/getCompletedTrips\(context\)/);
    // Round 3: bounded TURNS driven to the action budget, with continuation observed.
    // AUD-005: each turn must resume after the previous one, not restart.
    expect(body).toMatch(/pendingTripIdsPage\(context, budget, cursor\)/);
    expect(body).toMatch(/MAX_EMERGENCY_ACK_TURNS/);
    expect(body).toMatch(/remaining = page\.hasMore/);
  });

  it('publishes a bounded page over the compatibility bridge', async () => {
    const plugin = await read(PLUGIN);
    const start = plugin.indexOf('public void getNativeCompletedTrips(PluginCall call)');
    const end = plugin.indexOf('public void acknowledgeNativeCompletedTrips', start);
    const body = plugin.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).not.toMatch(/getCompletedTrips\(getContext\(\)\)/);
    expect(body).toMatch(/getCompletedTripPage\(getContext\(\), maxItems\)/);
    expect(body).toMatch(/payload\.put\("hasMore"/);
  });

  it('asks the bridge for a page from JavaScript', async () => {
    const bridge = await read('src/lib/activityRecognition.js');
    const start = bridge.indexOf('export async function getNativeCompletedTripPage(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = bridge.slice(start);
    expect(body).toMatch(/maxItems/);
    // Round 3: `hasMore` is the native answer OR any preserved work — a `blocked` queue
    // can never report itself drained, however the boolean came back.
    expect(body).toMatch(/hasMore: result\?\.hasMore === true \|\| blocked/);
  });
});

/**
 * AUD-005 round 2 — the queue's truth, not JavaScript's inference.
 */
describe('AUD-005 truthful queue state', () => {
  it('does not report a drained queue while unreadable work is preserved', async () => {
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');
    nativeState.queue = [];
    nativeState.unreadableTripIds = ['preserved-1'];

    const result = await syncNativeCompletedTrips();

    expect(result.importedTrips).toHaveLength(0);
    expect(result.blocked).toBe(true);
    expect(result.hasMore).toBe(true);
    // And nothing was acknowledged into oblivion.
    expect(nativeState.acknowledged).toHaveLength(0);
  });

  it('surfaces an oversized refusal without acknowledging or truncating it', async () => {
    const { syncNativeCompletedTrips } = await import('@/lib/localTripRepository');
    nativeState.queue = [tripFixture('normal-1')];
    nativeState.oversizedTripIds = ['huge-1'];

    const result = await syncNativeCompletedTrips();

    expect(result.blocked).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(nativeState.acknowledged).not.toContain('huge-1');
    expect(nativeState.acknowledged).toContain('normal-1');
  });

  it('trusts the native hasMore over a short page', async () => {
    const { syncNativeCompletedTrips, NATIVE_IMPORT_PAGE_SIZE } =
      await import('@/lib/localTripRepository');
    // Fewer trips than a page, but the journal says work remains.
    nativeState.queue = [tripFixture('short-1')];
    nativeState.unreadableTripIds = ['still-there'];

    const result = await syncNativeCompletedTrips();

    expect(NATIVE_IMPORT_PAGE_SIZE).toBeGreaterThan(1);
    expect(result.hasMore).toBe(true);
  });
});
