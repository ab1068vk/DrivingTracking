/**
 * AUD-007 ARCHITECTURE REDESIGN — no persistent ciphertext may reach a durable
 * transaction outside a live publication.
 *
 * CODEX's consolidated window falsified the "final" correction twice inside a module the
 * inventory had already classified as a correct PRODUCER:
 *
 *   A. `runLegacyBrowserRawGpsRetention()` calls `encodeTripRecord` /
 *      `encodeTripSummaryRecord` and commits the result several awaits later.
 *   B. `writeTripSummariesToDb()` calls `encodeTripSummaryRecords` and commits the rows
 *      in its own transaction.
 *
 * Neither owned `withDurableKeyPublication`, so the outgoing key could be finalized in
 * between and the write would durably commit ciphertext nothing can read.
 *
 * These regressions do not park a timer or guess at a window. They sample admission at
 * the moment every read-write transaction OPENS. A durable write that carries
 * root-key-bound bytes and finds admission false at that instant is the defect, whatever
 * route reached it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from './helpers/fakeTripIndexedDb';

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));
/**
 * The P6 evidence disposition is a precondition of the retention rewrite, not part of the
 * invariant under test, and its real implementation needs the whole browser speed-authority
 * fixture. Only that one page call is replaced; every trip-store read, encode, transaction
 * and commit below is the real production code.
 */
// A real in-memory key/value backend. The privacy audit fence writes its record and reads
// it back, so a no-op stub reads as unavailable storage and the epilogue never settles.
const kvStore = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (
    kvStore.has(key) ? structuredClone(kvStore.get(key)) : fallback
  )),
  setJson: vi.fn(async (key, value) => { kvStore.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { kvStore.delete(key); }),
}));
vi.mock('@/lib/localSpeedKnowledge', async (importActual) => ({
  ...(await importActual()),
  LocalSpeedKnowledge: class {
    async applyP6ProvenanceDispositionPage() {
      return { state: 'COMPLETE', hasMore: false, nextCursor: null, itemsWorked: 0, bytesWorked: 0 };
    }
  },
}));

const storageDouble = () => {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
  };
};

/**
 * An IndexedDB double that reports who is admitted at every read-write transaction open.
 * Subclassed rather than patched into the shared helper: the sampling belongs to this
 * proof, not to every suite that happens to use the fake.
 */
const samplingIndexedDb = (samples) => {
  const db = new FakeIndexedDb();
  const open = db.open.bind(db);
  db.open = (name, version) => {
    const request = open(name, version);
    let handler = null;
    Object.defineProperty(request, 'onsuccess', {
      configurable: true,
      get: () => handler,
      set: (fn) => {
        handler = (event) => {
          const database = request.result;
          if (database && !database.__aud007Sampled) {
            database.__aud007Sampled = true;
            const transaction = database.transaction.bind(database);
            database.transaction = (names, mode = 'readonly') => {
              if (mode === 'readwrite') {
                samples.push({
                  stores: Array.isArray(names) ? [...names] : [names],
                  admitted: samples.probe(),
                });
              }
              return transaction(names, mode);
            };
          }
          fn?.(event);
        };
      },
    });
    return request;
  };
  return db;
};

const agedTrip = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-09-01T12:00:00.000Z',
  end_time: '2026-09-01T12:20:00.000Z',
  distance: 8,
  duration: 20,
  route_points: [
    { lat: 43.1, lng: -79.1, timestamp: '2026-09-01T12:00:00.000Z' },
    { lat: 43.2, lng: -79.2, timestamp: '2026-09-01T12:10:00.000Z' },
  ],
});

describe('AUD-007 REDESIGN — persistent ciphertext never commits outside a publication', () => {
  let indexedDb;
  let samples;

  beforeEach(() => {
    samples = [];
    samples.probe = () => false;
    indexedDb = samplingIndexedDb(samples);
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name, optionsOrRun, maybeRun) => (
          typeof optionsOrRun === 'function'
            ? optionsOrRun({ name })
            : maybeRun({ name })
        ),
      },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const writesCarryingCiphertext = () => samples.filter((sample) => (
    sample.stores.some((store) => (
      store === 'trips' || store === 'trip_summaries' || store === 'trip_projections'
    ))
  ));

  /**
   * CODEX bypass A — predecessor-record retention rewrite.
   *
   * The post-commit epilogue (privacy-audit append and derived-cache invalidation) does
   * not settle under this file's storage doubles, so the call is given a bounded settle
   * window rather than being awaited to completion. That is a harness limit, not a
   * softened assertion: the proof is the sampled durable transaction, which has already
   * happened by then, and the test fails if no such transaction is sampled at all.
   */
  it('holds admission when legacy retention commits its re-encoded trip and summary', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(agedTrip('legacy-retention'));

    samples.length = 0;
    samples.probe = () => refs.hasInFlightBrowserKeyWrites();
    await Promise.race([
      new Promise((resolve) => { setTimeout(resolve, 2000); }),
      repository.runLegacyBrowserRawGpsRetention({
        tripId: 'legacy-retention',
        retentionDays: 1,
        motionRetentionDays: 1,
        now: Date.parse('2026-09-14T00:00:00.000Z'),
      }).catch(() => null),
    ]);

    // The retention rewrite commits the re-encoded trip and its legacy summary together.
    const rewrite = samples.filter((sample) => (
      sample.stores.includes('trips') && sample.stores.includes('trip_summaries')
    ));
    expect(rewrite.length).toBeGreaterThan(0);
    expect(rewrite.every((sample) => sample.admitted)).toBe(true);
  }, 20000);

  /** CODEX bypass B — summary backfill / migration. */
  it('holds admission when the summary backfill commits its re-encoded rows', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(agedTrip('summary-backfill'));

    // Force the one-time source-of-truth backfill: fewer live summaries than trips.
    indexedDb.getStoreState('drivesense_mobile', 'trip_summaries').records.clear();

    samples.length = 0;
    samples.probe = () => refs.hasInFlightBrowserKeyWrites();
    await repository.localTripRepository.listAllSummaries({ sort: '-start_time' });

    // Pin the backfill itself, not merely "some durable write happened": the rows must
    // have been rewritten, and the transaction that rewrote them must have been admitted.
    // Without this a broken backfill that silently wrote nothing would pass vacuously.
    const backfill = samples.filter((sample) => sample.stores.includes('trip_summaries'));
    expect(backfill.length).toBeGreaterThan(0);
    expect(indexedDb.getStoreState('drivesense_mobile', 'trip_summaries').records.size)
      .toBeGreaterThan(0);
    expect(writesCarryingCiphertext().every((sample) => sample.admitted)).toBe(true);
    expect(backfill.every((sample) => sample.admitted)).toBe(true);
  });
});
