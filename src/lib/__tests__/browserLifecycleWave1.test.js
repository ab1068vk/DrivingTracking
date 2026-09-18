import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { browserActiveTripSpool as spool } from '@/lib/browserActiveTripSpool';
import { activeTripStore as store } from '@/lib/trackingStore';
import { localTripRepository as repository } from '@/lib/localTripRepository';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { decryptSensitiveValue } from '@/lib/securePayloadCrypto';

const ids = new Set();
const point = (index) => ({ index, lat: 43 + index / 100000, lng: -79,
  timestamp: new Date(Date.UTC(2026, 8, 16, 0, 0, index)).toISOString(), speed_kmh: 40 });
const start = (id) => ({ ...(id ? { id } : {}), status: 'active', trip_state: 'ConfirmedTrip',
  start_time: '2026-09-16T00:00:00.000Z', route_points: [] });
const install = () => {
  const values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) });
  const db = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', db);
  vi.stubGlobal('IDBKeyRange', db.keyRange);
  return db;
};
const save = async (trip) => {
  ids.add(trip.id);
  return repository.create({ ...trip, status: 'completed', trip_state: 'SavedTrip',
    end_time: '2026-09-16T00:30:00.000Z' });
};
const replay = async (session) => {
  const points = [];
  for await (const value of spool.readPoints(session)) points.push(value);
  return points;
};
const durableManifest = async (db, sessionId) => {
  const outer = [...db.getStoreState('roadsage_active_spool_v1', 'manifests').records.values()]
    .find((record) => record.sessionId === sessionId);
  const bytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const raw = await decryptSensitiveValue(outer.wrappedDek, `browser:active_spool_dek:${sessionId}`);
  const key = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes(outer.manifestNonce), tagLength: 128,
    additionalData: new TextEncoder().encode(`roadsage.browser.rsas.manifest.v1|${sessionId}|${outer.tripId}`),
  }, key, bytes(outer.manifestCiphertext))));
};

describe('browser lifecycle wave UD/UB/UC', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    store.clear();
    await store.flush();
    for (const id of ids) await repository.delete(id).catch(() => {});
    ids.clear();
    await spool.eraseAllForDataRights();
    vi.unstubAllGlobals();
  });

  it('UD initial point receives a single caller/store/spool identity', async () => {
    install();
    const caller = store.set({ ...start(), route_points: [point(0)] });
    expect(caller.id).toBeTruthy();
    expect(store.get().id).toBe(caller.id);
    expect(spool.status()).toMatchObject({ tripId: caller.id, sessionId: caller.rsas_session_id, pointCount: 1 });
    const saved = await save(caller);
    expect(saved.route_points_raw_count).toBe(1);
    expect((await replay(caller.rsas_session_id)).map((p) => p.index)).toEqual([0]);
  });

  it('UD empty start accepts first GPS point and restart keeps identity', async () => {
    install();
    store.set(start());
    store.addPoint(point(0));
    const active = store.get();
    await store.flush({ commitBuffer: true });
    spool.resetMemory();
    const recovered = await store.hydrate();
    expect(recovered.id).toBeTruthy();
    expect(recovered).toMatchObject({ id: active.id, rsas_session_id: active.rsas_session_id });
    store.set(recovered);
    store.addPoint(point(1));
    const saved = await save(store.get());
    expect(saved.route_points_raw_count).toBe(2);
    expect((await replay(active.rsas_session_id)).map((p) => p.index)).toEqual([0, 1]);
  });

  it('UB independently discovers old SEALED owner after a new active trip and finalizes without stealing it', async () => {
    const db = install();
    store.set(start('wave-old'));
    for (let i = 0; i < 6; i++) store.addPoint(point(i));
    await store.flush();
    const old = store.get();
    await spool.seal();
    db.failNextRequest({ storeName: 'manifests', operation: 'put', error: new Error('canonical fault') });
    await expect(save(old)).rejects.toThrow('canonical fault');
    spool.resetMemory();
    await store.hydrate();
    expect(store.getPendingBrowserFinalization()?.id).toBe(old.id);
    store.set(start('wave-new'));
    expect(store.getPendingBrowserFinalization()?.id).toBe(old.id);
    store.addPoint(point(100));
    await store.flush();
    const newer = store.get();
    spool.resetMemory();
    const reads = vi.spyOn(db, 'consumeRequestFailure');
    const routeRead = vi.spyOn(spool, 'readPoints');
    await store.hydrate();
    const pending = store.getPendingBrowserFinalization();
    expect.soft(pending).toMatchObject({ id: old.id, rsas_session_id: old.rsas_session_id, rsas_lifecycle_state: 'SEALED' });
    expect(routeRead).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([name, operation]) => name === 'manifests' && ['getAll', 'openCursor'].includes(operation))).toEqual([]);
    if (!pending) return;
    const saved = await save(pending);
    expect(saved).toMatchObject({ id: old.id, rsas_session_id: old.rsas_session_id, route_points_raw_count: 6,
      end_time: '2026-09-16T00:30:00.000Z' });
    expect(store.get()).toMatchObject({ id: newer.id, rsas_session_id: newer.rsas_session_id, rsas_lifecycle_state: 'ACTIVE' });
    expect(spool.status()).toMatchObject({ tripId: newer.id, sessionId: newer.rsas_session_id, state: 'ACTIVE' });
    expect((await replay(old.rsas_session_id)).map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(store.getPendingBrowserFinalization()).toBeNull();
  });

  it('UC permitted lost tail does not publish phantom counts or preview evidence', async () => {
    const db = install();
    store.set(start('wave-tail'));
    for (let i = 0; i < 3; i++) store.addPoint(point(i));
    await store.flush({ commitBuffer: false }); // lose permitted unsealed tail
    expect(await durableManifest(db, store.get().rsas_session_id)).toMatchObject({
      state: 'ACTIVE', sealedSegmentCount: 0, pointCount: 0, recentPoints: [], overview: [],
      rollingStats: { pointCount: 0 },
    });
    spool.resetMemory();
    const recovered = await store.hydrate();
    expect.soft(recovered.route_point_count).toBe(0);
    expect.soft(recovered.route_points).toEqual([]);
    store.set(recovered);
    store.addPoint(point(3));
    store.addPoint(point(4));
    const saved = await save(store.get());
    const points = await replay(saved.rsas_session_id);
    expect((await durableManifest(db, saved.rsas_session_id)).canonicalMetadata).toMatchObject({
      rsas_session_id: saved.rsas_session_id, route_points_raw_count: 2,
    });
    expect({ count: saved.route_points_raw_count, rolling: saved.point_count, replay: points.length }).toEqual({ count: 2, rolling: 2, replay: 2 });
    expect(points.map((p) => p.index)).toEqual([3, 4]);
  });

  it('UC durable prefix boundary is not re-appended after ACTIVE recovery', async () => {
    install();
    store.set(start('wave-prefix'));
    await store.flush();
    for (let i = 0; i < 259; i++) store.addPoint(point(i));
    store.set(store.get());
    await store.flush({ commitBuffer: false });
    spool.resetMemory();
    const recovered = await store.hydrate();
    expect.soft(recovered.active_route_point_count).toBe(256);
    store.set(recovered);
    expect.soft(spool.status().pointCount).toBe(256);
    store.addPoint(point(259));
    const saved = await save(store.get());
    const points = await replay(saved.rsas_session_id);
    expect(saved.route_points_raw_count).toBe(257);
    expect(points.map((p) => p.index)).toEqual([...Array.from({ length: 256 }, (_, i) => i), 259]);
    expect(new Set(points.map((p) => p.timestamp)).size).toBe(points.length);
  });

  it('discovery and duplicate admission are bounded metadata decisions', () => {
    const source = readFileSync(new URL('../browserActiveTripSpool.js', import.meta.url), 'utf8');
    const discovery = source.split('async pendingFinalization(')[1]?.split('async completePendingFinalization(')[0] || '';
    expect(discovery).toContain("index('by_state').get('SEALED')");
    expect(discovery).not.toMatch(/openCursor|getAll|readPoints|scanManifest|SEGMENTS/);
    const append = source.split('append(point,')[1].split('  view(')[0];
    expect(append).not.toMatch(/readPoints|readPointsPage|\.filter\(|new Set|\.find\(|getAll/);
    const dashboard = readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8');
    expect(dashboard).toContain('tripData.id = admittedTrip.id');
    expect(dashboard.indexOf('tripData.id = admittedTrip.id')).toBeLessThan(dashboard.indexOf('activeTripRef.current = tripData'));
  });

  it('UB state index retains multiple pending owners with no active slot, one bounded retry at a time', async () => {
    install();
    const sessions = new Map();
    for (const id of ['wave-pending-1', 'wave-pending-2']) {
      store.set(start(id));
      for (let i = 0; i < 6; i++) store.addPoint(point(i));
      await store.flush();
      sessions.set(id, store.get().rsas_session_id);
      await spool.seal();
    }
    store.clear();
    await store.flush();
    for (let i = 0; i < 2; i++) {
      spool.resetMemory();
      expect(await store.hydrate()).toBeNull();
      const pending = store.getPendingBrowserFinalization();
      expect(sessions.get(pending.id)).toBe(pending.rsas_session_id);
      const [saved, duplicate] = await Promise.all([save(pending), save(pending)]);
      expect(duplicate.rsas_session_id).toBe(saved.rsas_session_id);
      expect(saved.route_points_raw_count).toBe(6);
      expect((await replay(saved.rsas_session_id)).length).toBe(6);
      sessions.delete(saved.id);
      expect(store.get()).toBeNull();
    }
    expect(sessions.size).toBe(0);
    expect(store.getPendingBrowserFinalization()).toBeNull();
  });

  it('pending retry refuses mismatched trip identity and keeps SEALED immutable', async () => {
    install();
    store.set(start('wave-owner'));
    store.addPoint(point(0));
    await spool.seal();
    const old = store.get();
    store.set(start('wave-independent'));
    await store.flush();
    await expect(spool.completePendingFinalization({ ...old, id: 'wrong-id' })).rejects.toThrow('ACTIVE_PRODUCER_NOT_OWNER');
    expect((await spool.pendingFinalization()).rsas_session_id).toBe(old.rsas_session_id);
    expect(spool.status().tripId).toBe('wave-independent');
  });

  it('UC initial manifest captures no later buffered evidence even when publication is delayed', async () => {
    install();
    store.set(start('wave-initial-crash'));
    store.addPoint(point(0));
    await store.flush({ commitBuffer: false });
    const active = store.get();
    spool.resetMemory();
    const recovered = await store.hydrate();
    expect(recovered).toMatchObject({ id: active.id, rsas_session_id: active.rsas_session_id,
      route_point_count: 0, active_route_point_count: 0, route_points: [] });
    expect(recovered.rolling_stats.point_count).toBe(0);
    store.set(recovered);
    store.addPoint(point(1));
    const saved = await save(store.get());
    expect(saved.route_points_raw_count).toBe(1);
  });

  it('a new active owner admitted during old completion cannot be overwritten by its terminal slot write', async () => {
    install();
    store.set(start('wave-finishing'));
    for (let i = 0; i < 6; i++) store.addPoint(point(i));
    const old = store.get();
    const seal = spool.seal.bind(spool);
    vi.spyOn(spool, 'seal').mockImplementation(async () => {
      const result = await seal();
      store.set(start('wave-overlap'));
      store.addPoint(point(100));
      return result;
    });
    const saved = await save(old);
    expect(saved).toMatchObject({ id: old.id, rsas_session_id: old.rsas_session_id, route_points_raw_count: 6 });
    expect(store.get()).toMatchObject({ id: 'wave-overlap', rsas_lifecycle_state: 'ACTIVE' });
    await store.flush({ commitBuffer: true });
    spool.resetMemory();
    expect(await store.hydrate()).toMatchObject({ id: 'wave-overlap', rsas_lifecycle_state: 'ACTIVE', route_point_count: 1 });
    expect((await replay(old.rsas_session_id)).length).toBe(6);
  });
});
