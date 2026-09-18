import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPendingBrowserFinalization, isRecoverableActiveTrip } from '@/components/dashboard/dashboardHelpers';
import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import { localTripRepository } from '@/lib/localTripRepository';
import { activeTripStore } from '@/lib/trackingStore';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

const installedTripIds = new Set();

const point = (index) => ({
  index,
  lat: 43.65 + index / 10_000,
  lng: -79.38 - index / 10_000,
  speed_kmh: 45 + index,
  timestamp: new Date(Date.UTC(2026, 8, 15, 12, 0, index)).toISOString(),
});

const installStores = () => {
  const values = new Map();
  const faults = { set: false, remove: false };
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      if (faults.set === true || faults.set === key) throw new Error('injected active-store set failure');
      values.set(key, value);
    }),
    removeItem: vi.fn((key) => {
      if (faults.remove) throw new Error('injected active-store clear failure');
      values.delete(key);
    }),
  });
  return { values, faults };
};

const createCanonicalTrip = async ({ tripId, pointCount = 6 }) => {
  installedTripIds.add(tripId);
  activeTripStore.set({
    id: tripId,
    status: 'active',
    trip_state: 'ConfirmedTrip',
    start_time: '2026-09-15T12:00:00.000Z',
    route_points: [],
  });
  for (let index = 0; index < pointCount; index += 1) activeTripStore.addPoint(point(index));
  await activeTripStore.flush();
  const active = activeTripStore.get();
  const endTime = '2026-09-15T12:30:00.000Z';
  const canonical = await localTripRepository.create({
    ...active,
    status: 'completed',
    trip_state: 'SavedTrip',
    end_time: endTime,
  });
  await activeTripStore.flush();
  return { active, canonical, endTime, sessionId: active.rsas_session_id };
};

describe('HPR-015 canonical browser lifecycle recovery', () => {
  afterEach(async () => {
    activeTripStore.clear();
    await activeTripStore.flush();
    for (const tripId of installedTripIds) {
      await localTripRepository.delete(tripId).catch(() => {});
    }
    installedTripIds.clear();
    await browserActiveTripSpool.eraseAllForDataRights();
    browserActiveTripSpool.resetMemory();
    vi.unstubAllGlobals();
  });

  it('recovers SEALED work only for same-session finalization, never six-point to two-point replacement', async () => {
    installStores();
    const indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    const tripId = `hpr015-sealed-${Date.now()}`;
    installedTripIds.add(tripId);
    activeTripStore.set({
      id: tripId,
      status: 'active',
      trip_state: 'ConfirmedTrip',
      start_time: '2026-09-15T12:00:00.000Z',
      route_points: [],
    });
    for (let index = 0; index < 6; index += 1) activeTripStore.addPoint(point(index));
    await activeTripStore.flush();
    const active = activeTripStore.get();
    const sessionId = active.rsas_session_id;
    const endTime = '2026-09-15T12:30:00.000Z';
    await browserActiveTripSpool.seal();
    indexedDb.failNextRequest({
      storeName: 'manifests', operation: 'put',
      error: new Error('injected SEALED to CANONICAL failure'),
    });
    await expect(localTripRepository.create({
      ...active, status: 'completed', trip_state: 'SavedTrip', end_time: endTime,
    })).rejects.toThrow('injected SEALED to CANONICAL failure');
    expect(browserActiveTripSpool.status()).toMatchObject({ sessionId, tripId, state: 'SEALED', pointCount: 6 });

    browserActiveTripSpool.resetMemory();
    const readPoints = vi.spyOn(browserActiveTripSpool, 'readPoints');
    const readPointsPage = vi.spyOn(browserActiveTripSpool, 'readPointsPage');
    const listAll = vi.spyOn(localTripRepository, 'listAll');
    const recovered = await activeTripStore.hydrate();
    expect(recovered).toMatchObject({ id: tripId, rsas_session_id: sessionId, rsas_lifecycle_state: 'SEALED' });
    expect(isPendingBrowserFinalization(recovered)).toBe(true);
    expect(activeTripStore.getPendingBrowserFinalization()).toBe(recovered);
    expect(readPoints).not.toHaveBeenCalled();
    expect(readPointsPage).not.toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
    readPoints.mockRestore();
    readPointsPage.mockRestore();
    listAll.mockRestore();
    // Primary cause-level RED must occur before any producer action. Soft lets
    // frozen production also demonstrate the destructive consequence below.
    expect.soft(isRecoverableActiveTrip(recovered)).toBe(false);
    const resumed = isRecoverableActiveTrip(recovered);
    if (resumed) {
      activeTripStore.set(recovered);
      activeTripStore.addPoint(point(99));
    }
    const pending = resumed ? activeTripStore.get() : activeTripStore.getPendingBrowserFinalization();
    const saved = await localTripRepository.create({
      ...pending, status: 'completed', trip_state: 'SavedTrip',
      end_time: resumed ? '2026-09-15T13:45:00.000Z' : endTime,
    });
    expect({ sessionId: saved.rsas_session_id, rawCount: saved.route_points_raw_count, endTime: saved.end_time })
      .toEqual({ sessionId, rawCount: 6, endTime });
    const route = [];
    for await (const routePoint of await localTripRepository.getPayloadStream(tripId)) route.push(routePoint);
    expect(route.map((routePoint) => routePoint.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(browserActiveTripSpool.status()).toMatchObject({ tripId, sessionId, state: 'CANONICAL', pointCount: 6 });
    expect(activeTripStore.getPendingBrowserFinalization()).toBeNull();
  });

  it('refuses every SEALED recording ingress and preserves the session through repeated startup and seal', async () => {
    installStores();
    const tripId = `hpr015-sealed-ingress-${Date.now()}`;
    activeTripStore.set({ id: tripId, status: 'active', trip_state: 'ConfirmedTrip', route_points: [] });
    for (let index = 0; index < 6; index += 1) activeTripStore.addPoint(point(index));
    await activeTripStore.flush();
    await browserActiveTripSpool.seal();
    const sessionId = browserActiveTripSpool.status().sessionId;
    for (let restart = 0; restart < 3; restart += 1) {
      browserActiveTripSpool.resetMemory();
      const recovered = await activeTripStore.hydrate();
      expect(isRecoverableActiveTrip(recovered)).toBe(false);
      expect(isPendingBrowserFinalization(recovered)).toBe(true);
      // No supplied lifecycle marker: discriminate the recovered authoritative
      // SEALED owner guard independently of the metadata guard.
      expect(() => browserActiveTripSpool.begin({ id: tripId, rsas_session_id: sessionId }))
        .toThrow(expect.objectContaining({ code: 'ACTIVE_SPOOL_FINALIZATION_REQUIRED' }));
      expect(() => activeTripStore.set(recovered))
        .toThrow(expect.objectContaining({ code: 'ACTIVE_SPOOL_FINALIZATION_REQUIRED' }));
      expect(() => activeTripStore.addPoint(point(100)))
        .toThrow(expect.objectContaining({ code: 'ACTIVE_SPOOL_FINALIZATION_REQUIRED' }));
      expect(() => browserActiveTripSpool.append(point(101), { id: tripId }))
        .toThrow(expect.objectContaining({ code: 'ACTIVE_SPOOL_FINALIZATION_REQUIRED' }));
      await expect(browserActiveTripSpool.seal()).resolves.toMatchObject({ sessionId, tripId, pointCount: 6 });
      expect(browserActiveTripSpool.status()).toMatchObject({ sessionId, tripId, state: 'SEALED', pointCount: 6 });
      expect(activeTripStore.getPendingBrowserFinalization()).toMatchObject({ id: tripId, rsas_session_id: sessionId });
    }
    const pending = activeTripStore.getPendingBrowserFinalization();
    browserActiveTripSpool.resetMemory();
    expect(() => browserActiveTripSpool.begin(pending))
      .toThrow(expect.objectContaining({ code: 'ACTIVE_SPOOL_FINALIZATION_REQUIRED' }));
  });

  it('keeps the recording/finalization recovery matrix explicit and prevents startup cleanup of SEALED work', () => {
    const active = { id: 'matrix-T', rsas_session_id: 'matrix-A', status: 'active', trip_state: 'ConfirmedTrip' };
    for (const state of ['ACTIVE', 'SEALED', 'CANONICAL', 'UNAVAILABLE']) {
      const trip = { ...active, rsas_lifecycle_state: state };
      expect(isRecoverableActiveTrip(trip)).toBe(state === 'ACTIVE');
      expect(isPendingBrowserFinalization(trip)).toBe(state === 'SEALED');
    }
    // Existing page render suite is server/static rendering (effects do not run).
    // Pin its real startup branch as well as the production-store tests above.
    const dashboard = readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8');
    const sealedBranch = dashboard.split('else if (isPendingBrowserFinalization(recovered)) {')[1]?.split('else if (recovered)')[0];
    expect(sealedBranch).toContain('sealed_same_session_finalization_required');
    expect(sealedBranch).not.toMatch(/activeTripStore\.clear|startGPS\(|startTimer\(/);
  });

  it('does not recover or replace a durable canonical trip while its stale active record remains', async () => {
    const { values } = installStores();

    const tripId = `hpr015-stable-${Date.now()}`;
    installedTripIds.add(tripId);
    activeTripStore.set({
      id: tripId,
      status: 'active',
      trip_state: 'ConfirmedTrip',
      start_time: '2026-09-15T12:00:00.000Z',
      route_points: [],
    });
    for (let index = 0; index < 6; index += 1) activeTripStore.addPoint(point(index));
    await activeTripStore.flush();

    const activeBeforeCompletion = activeTripStore.get();
    const staleActiveRecord = values.get('drivesense_active_trip');
    const originalSessionId = activeBeforeCompletion.rsas_session_id;
    const originalEndTime = '2026-09-15T12:30:00.000Z';
    const originalCanonical = await localTripRepository.create({
      ...activeBeforeCompletion,
      status: 'completed',
      trip_state: 'SavedTrip',
      end_time: originalEndTime,
    });
    await activeTripStore.flush();

    expect(originalCanonical).toMatchObject({
      id: tripId,
      rsas_session_id: originalSessionId,
      route_points_raw_count: 6,
      end_time: originalEndTime,
    });
    expect(values.has('drivesense_active_trip')).toBe(true);
    // Also pin the harder durability interval: CANONICAL committed, but the
    // active-record terminal write did not survive. Recovery must read the spool.
    values.set('drivesense_active_trip', staleActiveRecord);

    // Renderer death loses only memory. The pre-clear active record and the durable
    // CANONICAL spool both survive, exactly as they do while post-drive review awaits.
    browserActiveTripSpool.resetMemory();
    const recovered = await activeTripStore.hydrate();
    const wasRecoverable = isRecoverableActiveTrip(recovered);
    let resumed = false;
    let replacementSessionId = null;

    // Exercise the real consumer/producer/finalizer chain when frozen production
    // incorrectly classifies the stale active record as recoverable.
    if (wasRecoverable) {
      resumed = true;
      activeTripStore.set(recovered);
      activeTripStore.addPoint(point(99));
      replacementSessionId = activeTripStore.get().rsas_session_id;
      await localTripRepository.create({
        ...activeTripStore.get(),
        status: 'completed',
        trip_state: 'SavedTrip',
        end_time: '2026-09-15T13:45:00.000Z',
      });
      await activeTripStore.flush();
    }

    const storedAfterRestart = await localTripRepository.getFullById(tripId);
    const originalRoute = [];
    for await (const routePoint of browserActiveTripSpool.readPoints(originalSessionId)) {
      originalRoute.push(routePoint);
    }

    expect({
      recoveryLifecycle: recovered?.rsas_lifecycle_state,
      wasRecoverable,
      resumed,
      storedSessionId: storedAfterRestart.rsas_session_id,
      replacementSessionId,
      storedRawCount: storedAfterRestart.route_points_raw_count,
      storedEndTime: storedAfterRestart.end_time,
      originalRouteCount: originalRoute.length,
    }).toEqual({
      recoveryLifecycle: 'CANONICAL',
      wasRecoverable: false,
      resumed: false,
      storedSessionId: originalSessionId,
      replacementSessionId: null,
      storedRawCount: 6,
      storedEndTime: originalEndTime,
      originalRouteCount: 6,
    });
  });

  it('keeps duplicate completion idempotent and refuses begin or append on the canonical lifecycle', async () => {
    installStores();
    const tripId = `hpr015-idempotent-${Date.now()}`;
    const { canonical, endTime, sessionId } = await createCanonicalTrip({ tripId, pointCount: 4 });

    expect(() => browserActiveTripSpool.begin({ id: tripId })).toThrow(expect.objectContaining({
      code: 'ACTIVE_SPOOL_TERMINAL',
    }));
    expect(() => browserActiveTripSpool.append(point(10), { id: tripId })).toThrow(expect.objectContaining({
      code: 'ACTIVE_SPOOL_TERMINAL',
    }));

    const duplicate = await activeTripStore.completeBrowserCanonical({
      id: tripId,
      status: 'completed',
      end_time: '2099-01-01T00:00:00.000Z',
    });
    const savedAgain = await localTripRepository.create({
      ...duplicate,
      status: 'completed',
      end_time: '2099-01-01T00:00:00.000Z',
    });

    expect(duplicate).toMatchObject({
      rsas_session_id: sessionId,
      route_points_raw_count: 4,
      end_time: endTime,
    });
    expect(savedAgain).toMatchObject({
      rsas_session_id: sessionId,
      route_points_raw_count: 4,
      end_time: endTime,
    });
    expect(savedAgain.created_at).toBe(canonical.created_at);
    browserActiveTripSpool.resetMemory();
    expect(() => browserActiveTripSpool.begin(duplicate)).toThrow(expect.objectContaining({
      code: 'ACTIVE_SPOOL_TERMINAL',
    }));
  });

  it('coalesces concurrent finalization on one durable session identity', async () => {
    installStores();
    const tripId = `hpr015-concurrent-${Date.now()}`;
    browserActiveTripSpool.begin({ id: tripId });
    browserActiveTripSpool.append(point(0), { id: tripId });

    const firstEndTime = '2026-09-15T12:30:00.000Z';
    const [first, duplicate] = await Promise.all([
      browserActiveTripSpool.complete({ id: tripId, status: 'completed', end_time: firstEndTime }),
      browserActiveTripSpool.complete({ id: tripId, status: 'completed', end_time: '2099-01-01T00:00:00.000Z' }),
    ]);

    expect(first).toMatchObject({
      rsas_lifecycle_state: 'CANONICAL',
      route_points_raw_count: 1,
      end_time: firstEndTime,
    });
    expect(duplicate).toEqual(first);
  });

  it('rejects a second session that attempts to replace an existing canonical stable trip id', async () => {
    installStores();
    const tripId = `hpr015-final-boundary-${Date.now()}`;
    const { endTime, sessionId } = await createCanonicalTrip({ tripId, pointCount: 5 });

    browserActiveTripSpool.resetMemory();
    const replacementSessionId = browserActiveTripSpool.begin({ id: tripId });
    browserActiveTripSpool.append(point(90), { id: tripId });
    const replacement = await browserActiveTripSpool.complete({
      id: tripId,
      status: 'completed',
      trip_state: 'SavedTrip',
      end_time: '2026-09-15T13:45:00.000Z',
    });

    expect(replacementSessionId).not.toBe(sessionId);
    await expect(localTripRepository.create(replacement)).rejects.toMatchObject({
      code: 'CANONICAL_TRIP_ALREADY_FINALIZED',
    });
    await expect(localTripRepository.getFullById(tripId)).resolves.toMatchObject({
      rsas_session_id: sessionId,
      route_points_raw_count: 5,
      end_time: endTime,
    });
  });

  it('still recovers a genuine pre-canonical active session', async () => {
    installStores();
    const tripId = `hpr015-active-${Date.now()}`;
    activeTripStore.set({
      id: tripId,
      status: 'active',
      trip_state: 'ConfirmedTrip',
      start_time: '2026-09-15T12:00:00.000Z',
      route_points: [],
    });
    await activeTripStore.flush();
    const sessionId = activeTripStore.get().rsas_session_id;

    browserActiveTripSpool.resetMemory();
    const recovered = await activeTripStore.hydrate();

    expect(recovered).toMatchObject({
      id: tripId,
      rsas_session_id: sessionId,
      rsas_lifecycle_state: 'ACTIVE',
    });
    expect(isRecoverableActiveTrip(recovered)).toBe(true);
    activeTripStore.addPoint(point(1));
    expect(activeTripStore.get().rsas_session_id).toBe(sessionId);
    await expect(activeTripStore.completeBrowserCanonical({ status: 'completed' })).resolves.toMatchObject({
      rsas_session_id: sessionId,
      rsas_lifecycle_state: 'CANONICAL',
      route_points_raw_count: 1,
    });
  });

  it('keeps repeated startups terminal when active-store clear fails', async () => {
    const { faults } = installStores();
    const tripId = `hpr015-clear-failure-${Date.now()}`;
    const { sessionId } = await createCanonicalTrip({ tripId, pointCount: 3 });

    faults.remove = true;
    activeTripStore.clear();
    await activeTripStore.flush();
    faults.remove = false;

    for (let restart = 0; restart < 3; restart += 1) {
      browserActiveTripSpool.resetMemory();
      const recovered = await activeTripStore.hydrate();
      expect(recovered).toMatchObject({
        id: tripId,
        rsas_session_id: sessionId,
        rsas_lifecycle_state: 'CANONICAL',
      });
      expect(isRecoverableActiveTrip(recovered)).toBe(false);
    }
    await expect(localTripRepository.getFullById(tripId)).resolves.toMatchObject({
      rsas_session_id: sessionId,
      route_points_raw_count: 3,
    });
  });

  it('does not publish the canonical trip when the durable terminal active record cannot commit', async () => {
    const { faults } = installStores();
    const tripId = `hpr015-terminal-write-${Date.now()}`;
    installedTripIds.add(tripId);
    activeTripStore.set({
      id: tripId,
      status: 'active',
      trip_state: 'ConfirmedTrip',
      start_time: '2026-09-15T12:00:00.000Z',
      route_points: [],
    });
    activeTripStore.addPoint(point(0));
    await activeTripStore.flush();
    const active = activeTripStore.get();

    faults.set = 'drivesense_active_trip';
    await expect(localTripRepository.create({
      ...active,
      status: 'completed',
      trip_state: 'SavedTrip',
      end_time: '2026-09-15T12:30:00.000Z',
    })).rejects.toThrow('injected active-store set failure');
    await expect(localTripRepository.getFullById(tripId)).rejects.toThrow();

    faults.set = false;
    browserActiveTripSpool.resetMemory();
    const recovered = await activeTripStore.hydrate();
    expect(recovered.rsas_lifecycle_state).toBe('CANONICAL');
    expect(isRecoverableActiveTrip(recovered)).toBe(false);
  });

  it('keeps a failed canonical manifest transition retryable from durable sealed state', async () => {
    const indexedDb = new FakeIndexedDb();
    const { values } = installStores();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const tripId = `hpr015-manifest-retry-${Date.now()}`;
    const sessionId = browserActiveTripSpool.begin({ id: tripId });
    browserActiveTripSpool.append(point(0), { id: tripId });
    await browserActiveTripSpool.seal();

    indexedDb.failNextRequest({
      storeName: 'manifests',
      operation: 'put',
      error: new Error('injected canonical manifest failure'),
    });
    await expect(browserActiveTripSpool.complete({
      id: tripId,
      status: 'completed',
      end_time: '2026-09-15T12:30:00.000Z',
    })).rejects.toThrow('injected canonical manifest failure');
    expect(browserActiveTripSpool.status()).toMatchObject({
      tripId,
      state: 'SEALED',
    });

    browserActiveTripSpool.resetMemory();
    const recovered = await browserActiveTripSpool.hydrate(sessionId);
    expect(recovered.rsas_lifecycle_state).toBe('SEALED');

    const retried = await browserActiveTripSpool.complete({
      id: tripId,
      status: 'completed',
      end_time: '2026-09-15T12:30:00.000Z',
    });
    expect(retried).toMatchObject({
      id: tripId,
      rsas_lifecycle_state: 'CANONICAL',
      route_points_raw_count: 1,
    });
    expect(browserActiveTripSpool.status().state).toBe('CANONICAL');
  });

  it('decides terminal recovery from bounded metadata without route or history hydration', async () => {
    installStores();
    const tripId = `hpr015-bounded-${Date.now()}`;
    await createCanonicalTrip({ tripId, pointCount: 10 });
    browserActiveTripSpool.resetMemory();
    const readPoints = vi.spyOn(browserActiveTripSpool, 'readPoints');
    const readPointsPage = vi.spyOn(browserActiveTripSpool, 'readPointsPage');
    const listAll = vi.spyOn(localTripRepository, 'listAll');

    const recovered = await activeTripStore.hydrate();

    expect(recovered.rsas_lifecycle_state).toBe('CANONICAL');
    expect(isRecoverableActiveTrip(recovered)).toBe(false);
    expect(readPoints).not.toHaveBeenCalled();
    expect(readPointsPage).not.toHaveBeenCalled();
    expect(listAll).not.toHaveBeenCalled();
  });
});
