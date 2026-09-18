import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-C-F04 / P4-C-F05 — the monolithic fallback trip archive is never bounded
 * lifecycle work.
 *
 * `drivesense_trips` is one JSON document holding every trip the fallback store
 * ever kept. A lifecycle turn used to parse and rewrite the whole thing:
 * `stepLegacyTripStorageEncryption` re-encrypted it, `stepRetiredTripEventTypeMigration`
 * fell back to a whole-history pass, and the KEK sweep finished by decrypting
 * and re-encrypting the entire archive under the new key. Growing retained
 * history therefore produced a *bigger* turn.
 *
 * These tests run with IndexedDB unavailable - the only configuration where the
 * fallback archive is the live store - and instrument the real storage and
 * crypto seams: bytes retrieved, records parsed, decrypt/encrypt calls and
 * storage writes. They are load-bearing: restoring any whole-archive read or
 * rewrite to a lifecycle turn makes the per-N assertions fail.
 */

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  bytesRetrieved: 0,
  recordsParsed: 0,
  decrypts: 0,
  encrypts: 0,
  writes: [],
  reads: [],
  activeKeyVersion: 1,
  probe: null,
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => {
    fixture.reads.push(key);
    if (!fixture.storage.has(key)) return fallback;
    const value = fixture.storage.get(key);
    fixture.bytesRetrieved += JSON.stringify(value).length;
    if (Array.isArray(value)) fixture.recordsParsed += value.length;
    return structuredClone(value);
  }),
  setJson: vi.fn(async (key, value) => {
    fixture.writes.push(key);
    if (value === null) fixture.storage.delete(key);
    else fixture.storage.set(key, structuredClone(value));
  }),
  removeJson: vi.fn(async (key) => {
    fixture.writes.push(key);
    fixture.storage.delete(key);
  }),
  STORAGE_PRESENCE: { PRESENT: 'present', ABSENT: 'absent', UNKNOWN: 'unknown' },
  probeStoredJson: vi.fn(async (key) => {
    // P4-C-F05: the probe is tri-state. `fixture.probe` lets a test say the
    // enumeration could not answer at all.
    if (fixture.probe) return fixture.probe;
    return fixture.storage.has(key) ? 'present' : 'absent';
  }),
}));

/**
 * The crypto seam is faithful to production: an encrypted document is a real
 * `{ encrypted, version, ciphertext, key_version }` envelope written through
 * ordinary storage, because that envelope is exactly what the explicit fallback
 * rotation inspects with `getJson`/`isEncryptedPayload`.
 */
const ENVELOPE_VERSION = 1;
const envelopeFor = (value, keyVersion) => ({
  encrypted: true,
  version: ENVELOPE_VERSION,
  ciphertext: JSON.stringify(value),
  key_version: keyVersion,
});

vi.mock('@/lib/securePayloadCrypto', () => ({
  ENCRYPTION_KEY_META_KEY: 'drivesense_encryption_key_meta_v1',
  ENCRYPTION_VERSION: 1,
  isEncryptedPayload: vi.fn((value) => (
    value?.encrypted === true && Number(value?.version) === 1 && typeof value?.ciphertext === 'string'
  )),
  getActiveEncryptionKeyVersion: vi.fn(async () => fixture.activeKeyVersion),
  decryptSensitiveValue: vi.fn(async (payload) => {
    fixture.decrypts += 1;
    const value = JSON.parse(payload.ciphertext);
    fixture.bytesRetrieved += payload.ciphertext.length;
    fixture.recordsParsed += Array.isArray(value) ? value.length : 1;
    return value;
  }),
  getEncryptedJson: vi.fn(async (key, fallback) => {
    fixture.reads.push(key);
    const payload = fixture.storage.get(key);
    if (!payload?.ciphertext) return fallback;
    fixture.bytesRetrieved += payload.ciphertext.length;
    fixture.decrypts += 1;
    const value = JSON.parse(payload.ciphertext);
    fixture.recordsParsed += Array.isArray(value) ? value.length : 1;
    return value;
  }),
  setEncryptedJson: vi.fn(async (key, value, options = {}) => {
    fixture.writes.push(key);
    fixture.encrypts += 1;
    fixture.recordsParsed += Array.isArray(value) ? value.length : 1;
    const keyVersion = Number(options.keyVersion) || fixture.activeKeyVersion;
    fixture.storage.set(key, envelopeFor(value, keyVersion));
  }),
  removeEncryptedJson: vi.fn(async (key) => {
    fixture.writes.push(key);
    fixture.storage.delete(key);
  }),
  inspectEncryptedJsonKeyVersion: vi.fn(async (key) => (
    Number(fixture.storage.get(key)?.key_version) || null
  )),
}));

vi.mock('@/lib/systemLog', () => ({
  logError: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

import { readFileSync } from 'node:fs';

import {
  TRIPS_FALLBACK_REFERENCE_KEY,
  TRIPS_KEY,
  fallbackTripDocumentReleasesKey,
  readFallbackTripDocumentReference,
  runMonolithicTripCompatibilityMaintenance,
  stepLegacyTripStorageEncryption,
  stepRetiredTripEventTypeMigration,
  stepTripEncryptionKeyRotationBatch,
} from '@/lib/localTripRepository';
import { MONOLITHIC_DOCUMENT_OWNER } from '@/lib/monolithicCompatibility';

const archive = (count) => Array.from({ length: count }, (_, index) => ({
  id: `trip-${String(index).padStart(5, '0')}`,
  status: 'completed',
  start_time: new Date(1_700_000_000_000 + index).toISOString(),
  route_points: [{ lat: 1, lng: 2 }],
  events: [{ type: 'hard_brake', at: index }],
}));

const storedArchive = () => {
  const payload = fixture.storage.get(TRIPS_KEY);
  return payload?.ciphertext ? JSON.parse(payload.ciphertext) : payload;
};

const storedArchiveKeyVersion = () => Number(fixture.storage.get(TRIPS_KEY)?.key_version) || null;

const seedFallbackArchive = (count, { keyVersion = 1, stamped = true } = {}) => {
  fixture.storage.set(TRIPS_KEY, envelopeFor(archive(count), keyVersion));
  if (stamped) {
    fixture.storage.set(TRIPS_FALLBACK_REFERENCE_KEY, {
      present: true, keyVersion, updatedAt: 1,
    });
  }
};

const meter = () => {
  fixture.bytesRetrieved = 0;
  fixture.recordsParsed = 0;
  fixture.decrypts = 0;
  fixture.encrypts = 0;
  fixture.reads = [];
  fixture.writes = [];
};

const report = () => ({
  bytesRetrieved: fixture.bytesRetrieved,
  recordsParsed: fixture.recordsParsed,
  decrypts: fixture.decrypts,
  encrypts: fixture.encrypts,
  writes: fixture.writes.length,
});

beforeEach(() => {
  fixture.storage.clear();
  fixture.activeKeyVersion = 1;
  fixture.probe = null;
  meter();
  // The configuration this finding is about: no IndexedDB, so the monolithic
  // fallback document is the live trip store.
  vi.stubGlobal('indexedDB', undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P4-C-F04: no lifecycle repository turn parses or rewrites the fallback archive', () => {
  it.each([100, 2_500, 5_000])(
    'legacy-storage encryption reports the archive as ownerless at N=%s',
    async (total) => {
      seedFallbackArchive(total);
      meter();

      const turn = await stepLegacyTripStorageEncryption();

      expect(report()).toMatchObject({
        recordsParsed: 0, decrypts: 0, encrypts: 0,
      });
      expect(fixture.reads).not.toContain(TRIPS_KEY);
      expect(fixture.writes).not.toContain(TRIPS_KEY);
      expect(turn).toMatchObject({
        ownerless: true,
        owner: MONOLITHIC_DOCUMENT_OWNER,
        processed: 0,
        examined: 0,
        hasMore: false,
      });
    }
  );

  it.each([100, 2_500, 5_000])(
    'the retired-event-type migration reports the archive as ownerless at N=%s',
    async (total) => {
      seedFallbackArchive(total);
      meter();

      const turn = await stepRetiredTripEventTypeMigration();

      expect(report()).toMatchObject({ recordsParsed: 0, decrypts: 0, encrypts: 0 });
      expect(turn).toMatchObject({
        ownerless: true,
        owner: MONOLITHIC_DOCUMENT_OWNER,
        changed: 0,
        alreadyRan: false,
        hasMore: false,
      });
    }
  );

  it('costs the same per turn at 100 archived trips as at 5,000', async () => {
    const costAt = async (total) => {
      fixture.storage.clear();
      seedFallbackArchive(total);
      meter();
      await stepLegacyTripStorageEncryption();
      await stepRetiredTripEventTypeMigration();
      return report();
    };

    // Load-bearing: restore the full `TRIPS_KEY` parse/rewrite and the two
    // reports diverge by roughly the archive's own size.
    expect(await costAt(5_000)).toEqual(await costAt(100));
  });

  it('never advances the migration marker it did not actually run', async () => {
    seedFallbackArchive(100);

    await stepRetiredTripEventTypeMigration();

    // The obligation is preserved as debt for the explicit whole-history read
    // paths, not silently marked done by a turn that skipped it.
    expect(fixture.storage.get('drivesense_trip_event_migration_v1')).toBeUndefined();
  });
});

describe('P4-C-F05: no lifecycle KEK turn decrypts or rewrites the fallback archive', () => {
  it.each([100, 2_500, 5_000])(
    'the rotation batch reports the archive as ownerless at N=%s',
    async (total) => {
      seedFallbackArchive(total, { keyVersion: 1 });
      fixture.activeKeyVersion = 2;
      meter();

      const turn = await stepTripEncryptionKeyRotationBatch(2);

      expect(report()).toMatchObject({ recordsParsed: 0, decrypts: 0, encrypts: 0 });
      expect(fixture.reads).not.toContain(TRIPS_KEY);
      expect(fixture.writes).not.toContain(TRIPS_KEY);
      expect(turn).toMatchObject({
        ownerless: true,
        owner: MONOLITHIC_DOCUMENT_OWNER,
        fallbackDocumentPending: true,
        hasMore: false,
      });
      // The archive still holds ciphertext under the retiring key: the turn
      // says so instead of quietly leaving it unreadable.
      expect(storedArchiveKeyVersion()).toBe(1);
    }
  );

  it('per-turn KEK cost does not grow with the archive', async () => {
    const costAt = async (total) => {
      fixture.storage.clear();
      seedFallbackArchive(total, { keyVersion: 1 });
      fixture.activeKeyVersion = 2;
      meter();
      await stepTripEncryptionKeyRotationBatch(2);
      return report();
    };

    // Load-bearing: restoring `rotateFallbackTripsBlob` to the lifecycle tail
    // makes the 5,000-trip report far larger than the 100-trip one.
    expect(await costAt(5_000)).toEqual(await costAt(100));
  });

  it('refuses to release a key the archive still needs, and releases it once it does not', async () => {
    seedFallbackArchive(100, { keyVersion: 1 });

    // The archive is still on version 1, so version 1 may not be destroyed.
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);

    // Rewritten by an explicit whole-history rotation onto version 2.
    fixture.storage.set(TRIPS_FALLBACK_REFERENCE_KEY, {
      present: true, keyVersion: 2, updatedAt: 2,
    });
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(true);

    // And an archive that no longer exists holds nothing at all.
    fixture.storage.set(TRIPS_FALLBACK_REFERENCE_KEY, {
      present: false, keyVersion: null, updatedAt: 3,
    });
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(true);
  });

  it.each([
    ['a probe that cannot enumerate storage', 'unknown'],
  ])('retains the retiring key when the presence answer is %s', async (_label, probe) => {
    // No reference marker at all, and the probe cannot answer.
    fixture.probe = probe;

    const reference = await readFallbackTripDocumentReference();

    expect(reference.present).toBeNull();
    // Load-bearing: the pre-fix `catch => false` made this `true`, which
    // destroyed a key an unstamped archive may still have needed.
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);
  });

  it('releases the key only on a proven absence', async () => {
    fixture.probe = 'absent';
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(true);

    fixture.probe = 'present';
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);
  });

  it('treats an unstamped archive as still holding the old key', async () => {
    // A document written by a build older than the reference record.
    seedFallbackArchive(100, { keyVersion: 1, stamped: false });

    const reference = await readFallbackTripDocumentReference();

    expect(reference).toMatchObject({
      known: false, present: true, owner: MONOLITHIC_DOCUMENT_OWNER,
    });
    // Unknown is never "safe to destroy the key".
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);
    // And the probe never read the document itself.
    expect(fixture.decrypts).toBe(0);
  });
});


describe('P4-C-F04/F05: the fallback archive has a real production owner', () => {
  const appSource = readFileSync('src/App.jsx', 'utf8');
  const lifecycleSource = readFileSync('src/lib/appLifecycleWork.js', 'utf8');

  it('is invoked from the production quiet-period compatibility step', () => {
    // Load-bearing call-graph assertion: `ownerless` is only honest while a
    // production path actually performs the work. Deleting the boot caller -
    // the exact pre-fix state - fails here.
    const quietStep = appSource.slice(
      appSource.indexOf("app.bootstrap.monolithicTripCompatibility"),
    );
    expect(quietStep).toContain("import('@/lib/localTripRepository')");
    expect(quietStep).toContain('runMonolithicTripCompatibilityMaintenance()');
    expect(quietStep).toContain('releaseRetainedKeyVersions');
    expect(appSource).toContain('scheduleAfterQuietPeriod');
  });

  it('is not registered as a coordinator bounded turn', () => {
    // The owner must stay outside lifecycle coordination: no whole-document
    // work may return to a bounded turn.
    expect(lifecycleSource).not.toContain('runMonolithicTripCompatibilityMaintenance');
    expect(lifecycleSource).not.toContain('migrateLegacyTripStorageToEncrypted');
    expect(lifecycleSource).not.toContain('rotateTripEncryptionKey');
  });

  it('encrypts a plaintext fallback archive and clears the reported debt', async () => {
    // A legacy plaintext archive, exactly what the lifecycle turn declines.
    fixture.storage.set(TRIPS_KEY, archive(120));
    fixture.activeKeyVersion = 3;

    // The lifecycle turn reports the debt and touches nothing.
    meter();
    const before = await stepLegacyTripStorageEncryption();
    expect(fixture.reads).not.toContain(TRIPS_KEY);
    expect(before).toMatchObject({ ownerless: true, owner: MONOLITHIC_DOCUMENT_OWNER });

    const outcome = await runMonolithicTripCompatibilityMaintenance();

    expect(outcome).toMatchObject({
      owner: MONOLITHIC_DOCUMENT_OWNER,
      encrypted: true,
      settled: true,
      keyVersion: 3,
      targetKeyVersion: 3,
    });
    // The plaintext array is gone, replaced by an envelope over the same trips.
    expect(Array.isArray(fixture.storage.get(TRIPS_KEY))).toBe(false);
    expect(storedArchive()).toHaveLength(120);
    expect(fixture.storage.get(TRIPS_FALLBACK_REFERENCE_KEY)).toMatchObject({
      present: true, keyVersion: 3,
    });
  });

  it('rewraps an archive left on a superseded key and re-proves the reference', async () => {
    seedFallbackArchive(200, { keyVersion: 1 });
    fixture.activeKeyVersion = 2;

    // The bounded KEK turn hands the obligation off ...
    const turn = await stepTripEncryptionKeyRotationBatch(2);
    expect(turn).toMatchObject({ ownerless: true, fallbackDocumentPending: true });
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);

    // ... and the explicit owner discharges it.
    const outcome = await runMonolithicTripCompatibilityMaintenance();

    expect(outcome).toMatchObject({ rotated: true, settled: true, keyVersion: 2 });
    expect(storedArchiveKeyVersion()).toBe(2);
    expect(storedArchive()).toHaveLength(200);
    // The retained key version is now provably releasable.
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(true);
  });

  it('is restart-safe: an interrupted rewrite leaves the archive readable', async () => {
    seedFallbackArchive(50, { keyVersion: 1 });
    fixture.activeKeyVersion = 2;
    const secure = await import('@/lib/securePayloadCrypto');
    secure.setEncryptedJson.mockRejectedValueOnce(new Error('interrupted'));

    const interrupted = await runMonolithicTripCompatibilityMaintenance();

    // No marker lies: the archive is still on V1 and still says so.
    expect(interrupted.rotated).toBe(false);
    expect(storedArchiveKeyVersion()).toBe(1);
    expect(fixture.storage.get(TRIPS_FALLBACK_REFERENCE_KEY)).toMatchObject({ keyVersion: 1 });
    await expect(fallbackTripDocumentReleasesKey(1)).resolves.toBe(false);

    // The next invocation simply retries and converges.
    const retried = await runMonolithicTripCompatibilityMaintenance();
    expect(retried).toMatchObject({ rotated: true, settled: true, keyVersion: 2 });
    expect(storedArchive()).toHaveLength(50);
  });

  it('reports an absent archive as settled without inventing work', async () => {
    fixture.probe = 'absent';

    const outcome = await runMonolithicTripCompatibilityMaintenance();

    expect(outcome).toMatchObject({ encrypted: false, rotated: false, settled: true });
    expect(fixture.storage.get(TRIPS_FALLBACK_REFERENCE_KEY)).toMatchObject({ present: false });
  });
});
