import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DB_NAME,
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  P6_DERIVED_STORAGE_RESERVE_BYTES,
  requireBrowserP6DerivedStorage,
} from '@/lib/p6DerivedStorage';
import { reclaimP6BrowserDerivedStorageTurn } from '@/lib/p6TripDerivedState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});
const within = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), 1000)),
]);

describe('P6 browser derived storage production integration', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('demotes a published preview before reclaim and never reports false readiness', async () => {
    const db = await within(openP6TripDerivedDatabase(), 'open');
    const stores = [
      P6_TRIP_SOURCE_STORE,
      P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.MANIFESTS,
      P6_TRIP_DERIVED_STORES.WORK,
    ];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put({ id: 'canonical-trip', source_revision: 'r1', payload: 'canonical' });
    tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).put({
      key: 'canonical-trip:r1:geometry-v1:-1', tripId: 'canonical-trip',
      contentVersion: 'r1:geometry-v1', ordinal: -1, commitState: 'COMMITTED',
      encodedBytes: 4096, payload: { points: [{ lat: 43.7, lng: -79.3 }] }, updatedAt: 1,
    });
    tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
      key: 'D2_GEOMETRY:canonical-trip', domain: 'D2_GEOMETRY', subject: 'canonical-trip',
      contentVersion: 'r1:geometry-v1', state: 'VERIFIED', complete: true, updatedAt: 1,
    });
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: 'canonical-trip', desiredRevision: 'r1', desiredSeq: 1,
      state: 'COMPLETE', cursor: { published: true }, updatedAt: 1,
    });
    await within(transactionDone(tx), 'seed-transaction');
    db.close();

    vi.stubGlobal('navigator', { storage: { estimate: vi.fn(async () => ({
      quota: P6_DERIVED_STORAGE_RESERVE_BYTES + 100,
      usage: 100,
    })) } });
    await expect(within(reclaimP6BrowserDerivedStorageTurn(), 'initial-reclaim')).resolves.toMatchObject({
      state: 'RECLAIMED', kind: 'PREVIEW_CACHE', reclaimedBytes: 4096,
    });
    await expect(within(requireBrowserP6DerivedStorage(1), 'require-storage')).rejects.toMatchObject({
      code: 'DERIVED_STORAGE_BLOCKED',
      details: expect.objectContaining({ reserveBytes: P6_DERIVED_STORAGE_RESERVE_BYTES }),
    });

    const geometry = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS);
    const manifests = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.MANIFESTS);
    const work = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.WORK);
    const canonical = indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE);
    expect(geometry.records.size).toBe(0);
    expect(manifests.records.get('D2_GEOMETRY:canonical-trip')).toMatchObject({
      state: 'REBUILD_REQUIRED', complete: false, storageOutcome: 'DERIVED_RECLAIMED',
    });
    expect(work.records.get('canonical-trip')).toMatchObject({ state: 'DIRTY', cursor: null });
    expect(canonical.records.get('canonical-trip')).toMatchObject({ payload: 'canonical' });

    // Reopening after the durable transaction cannot resurrect reclaimed content
    // or leave a VERIFIED head pointing to it.
    await expect(within(reclaimP6BrowserDerivedStorageTurn(), 'reopen-reclaim')).resolves.toMatchObject({
      state: 'NO_RECLAIMABLE_DERIVED_DATA', reclaimedBytes: 0,
    });
    expect(manifests.records.get('D2_GEOMETRY:canonical-trip').state).not.toBe('VERIFIED');
  });
});
