import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
const settingsState = { units: 'metric' };
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({ ...settingsState }) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));
vi.mock('@/lib/appLifecycleWork', () => ({ admitP6ReviewedWork: vi.fn() }));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  invalidateP6AnalyticsForSettings,
  listP6BrowserCanonicalSubjectKeyPage,
  queueP6ExplicitTripSubjects,
  readP6TripDomainReadiness,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import {
  P6_DOMAIN_KEYS, P6_READINESS_STATES, P6_SOURCE_READ_RESERVE_BYTES, P6_TURN_BUDGET,
} from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

/**
 * DPD-015B and DPD-020 — the settings rediscovery turn, at a realistic size.
 *
 * The 500-trip A54 threw, at turn 161 of `p6TripDerivedUpdates:0:2`:
 *
 *   AppWorkBudgetExceededError: Application work turn exceeded bytes budget
 *   (7739924 > 4194304)
 *
 * `AppWorkBudgetExceededError` is a **contract violation**, so the coordinator
 * skipped retry-with-backoff, set `failureCeilingReached`, installed no wake and
 * destroyed the job instance. One external lifecycle trigger bought one burst,
 * and the burst re-dirtied 32 compatibility-parked subjects on its way out.
 *
 * No existing suite could have caught it. `appWorkAutonomousContinuation`
 * drives the real coordinator but its fake job consumes 16 bytes a turn, and
 * nothing fed the rediscovery path realistically sized rows. So this file is
 * built around a fixture whose page of source rows genuinely exceeds
 * `P6_TURN_BUDGET.bytes`, and it asserts the INVARIANT — "no turn reports more
 * bounded work than it declared" — rather than the one physical number 7739924,
 * which would be brittle against any fixture change.
 */

const POINTS_PER_TRIP = 1100;
const SUBJECT_COUNT = 34;

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = POINTS_PER_TRIP, ...extra } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: 9, score_overall: 88, duration_seconds: 900,
  route_points: route(seed, points),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
  ...extra,
});

const encoder = new TextEncoder();
const encodedBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;

describe('P6 settings rediscovery stays inside its declared turn budget', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    storage.clear();
    settingsState.units = 'metric';
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const record = (name, key) => store(name)?.records.get(key) || null;
  const workRow = (tripId) => record(P6_TRIP_DERIVED_STORES.WORK, tripId);
  const appliedReceipt = (tripId) => record(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED, `D1:browser:${tripId}`);
  const countWorkState = (state) => [...(store(P6_TRIP_DERIVED_STORES.WORK)?.records.values() || [])]
    .filter((row) => row.state === state).length;

  const subjectIds = Array.from({ length: SUBJECT_COUNT }, (_, index) => `rs-seed-${String(index).padStart(4, '0')}`);

  /** Legacy inline `route_points`, so every subject parks exactly as the device's did. */
  const seedLegacyHistory = async () => {
    for (const [index, id] of subjectIds.entries()) {
      await localTripRepository.create(trip(id, { seed: index + 1 }));
    }
  };

  /**
   * Turn the lifecycle crank the way the coordinator does, recording what each
   * turn reported so boundedness and progress are both observable afterwards.
   */
  const runLifecycleTurns = async (maxTurns = 2000) => {
    const turns = [];
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate();
      turns.push(result);
      if (result.hasMore !== true) return { turns, exhausted: false };
    }
    return { turns, exhausted: true };
  };

  /** What the OLD implementation charged: every source row on the page, whole. */
  const counterfactualPageBytes = async () => {
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    return page.ids.reduce((sum, id) => sum + encodedBytes(record(P6_TRIP_SOURCE_STORE, id)), 0);
  };

  it('is measured on a fixture the old implementation would have overrun', async () => {
    await seedLegacyHistory();
    const pageBytes = await counterfactualPageBytes();
    // Guards the guard: if this fixture ever shrinks below the budget the rest
    // of this file would pass vacuously, exactly as the 16-bytes-a-turn fake did.
    // Measured at the time of writing: 6,681,880 bytes for one 32-row page,
    // against a 4,194,304 budget — the same failure class as the device's
    // 7,739,924, reproduced in process.
    expect(pageBytes).toBeGreaterThan(P6_TURN_BUDGET.bytes);
  });

  it('never reports more bounded work than the P6 turn budget declares', async () => {
    await seedLegacyHistory();
    await runLifecycleTurns();

    settingsState.units = 'imperial';
    await invalidateP6AnalyticsForSettings('TEST_SETTINGS_CHANGED');

    const { turns, exhausted } = await runLifecycleTurns();

    expect(exhausted).toBe(false);
    // Measured at the time of writing: 37 turns, peak 162,651 bytes (3.9% of
    // the budget) and 65 items. More history buys more turns, not bigger ones.
    for (const [index, result] of turns.entries()) {
      expect(Number(result.bytesWorked) || 0, `turn ${index} (${result.state}) bytes`)
        .toBeLessThanOrEqual(P6_TURN_BUDGET.bytes);
      expect(Number(result.itemsWorked) || 0, `turn ${index} (${result.state}) items`)
        .toBeLessThanOrEqual(P6_TURN_BUDGET.items);
    }
  });

  it('takes several bounded turns and makes forward progress on every one of them', async () => {
    await seedLegacyHistory();
    await runLifecycleTurns();

    settingsState.units = 'imperial';
    await invalidateP6AnalyticsForSettings('TEST_SETTINGS_CHANGED');

    const { turns } = await runLifecycleTurns();
    const rediscovery = turns.filter((result) => String(result.state).startsWith('SETTINGS_REDISCOVERY'));

    // More history means MORE bounded turns, not larger ones.
    expect(rediscovery.length).toBeGreaterThan(1);
    // ...but the walk must ADVANCE a page each time rather than re-running one.
    // A stuck walk is the device's exact failure, and it would show up here as a
    // rediscovery turn count that scales with subjects instead of with pages.
    const pages = Math.ceil(SUBJECT_COUNT / 32) + 1;
    expect(rediscovery.length).toBeLessThanOrEqual(pages + 1);
    // One turn per subject, not five. At parent this is ~5x larger.
    expect(turns.length).toBeLessThan(SUBJECT_COUNT * 2);
    // A continuing turn that did nothing is the hot-loop signature: `hasMore`
    // with no work, forever. Every turn that asks to continue must have moved.
    for (const [index, result] of turns.entries()) {
      if (result.hasMore !== true) continue;
      expect(Number(result.itemsWorked) || 0, `turn ${index} (${result.state}) made no progress`)
        .toBeGreaterThan(0);
    }
  });

  it('leaves compatibility-parked subjects parked instead of re-dirtying them', async () => {
    await seedLegacyHistory();
    await runLifecycleTurns();

    const parkedBefore = countWorkState('EXPLICIT_SOURCE_REQUIRED');
    expect(parkedBefore).toBe(SUBJECT_COUNT);

    settingsState.units = 'imperial';
    await invalidateP6AnalyticsForSettings('TEST_SETTINGS_CHANGED');
    const { turns } = await runLifecycleTurns();

    // DPD-020: the parked population is exactly what it was. Rediscovery may
    // refresh D1 for these subjects; it may not convert their D2/D3/D4 debt
    // back into general dirty debt, and it may not lose it either.
    expect(countWorkState('EXPLICIT_SOURCE_REQUIRED')).toBe(parkedBefore);
    expect(countWorkState('DIRTY')).toBe(0);
    // The end state alone does not distinguish this from the old behaviour —
    // the old path also re-parked, just via five turns per subject (park plus
    // four retirement phases over rows that were already gone). These two
    // assertions are what actually fail without the fix: the refresh path is
    // taken, and the re-park path is not.
    const states = turns.map((result) => result.state);
    expect(states.filter((state) => state === 'ANALYTICS_SETTINGS_REFRESHED').length)
      .toBe(SUBJECT_COUNT);
    expect(states).not.toContain('EXPLICIT_LEGACY_SOURCE_REQUIRED');
    expect(states).not.toContain('RETIRE_SUPERSEDED');
    for (const id of [subjectIds[0], subjectIds.at(-1)]) {
      expect(workRow(id).state, id).toBe('EXPLICIT_SOURCE_REQUIRED');
      expect(workRow(id).analyticsOnlyTerminalState, id).toBeUndefined();
      for (const domain of [P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION,
        P6_DOMAIN_KEYS.ROAD_LEARNING]) {
        const readiness = await readP6TripDomainReadiness(domain, id);
        expect(readiness.state, `${domain}:${id}`).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
        expect(readiness.reason, `${domain}:${id}`).toBe('EXPLICIT_LEGACY_SOURCE_REQUIRED');
      }
    }
  });

  it('republishes every D1 contribution under the new settings version', async () => {
    await seedLegacyHistory();
    await runLifecycleTurns();
    const before = subjectIds.map((id) => appliedReceipt(id)?.settingsVersion);
    expect(new Set(before).size).toBe(1);
    expect(before[0]).toBeTruthy();

    settingsState.units = 'imperial';
    await invalidateP6AnalyticsForSettings('TEST_SETTINGS_CHANGED');
    await runLifecycleTurns();

    const after = subjectIds.map((id) => appliedReceipt(id)?.settingsVersion);
    // Skipping parked subjects would be cheaper and would leave these at the
    // old version under a head claiming the new one — a truth defect traded for
    // a convergence one. Every receipt moves.
    expect(new Set(after).size).toBe(1);
    expect(after[0]).toBeTruthy();
    expect(after[0]).not.toBe(before[0]);
  });

  it('converges: D1 returns to VERIFIED and a further pass finds nothing to do', async () => {
    await seedLegacyHistory();
    await runLifecycleTurns();

    settingsState.units = 'imperial';
    await invalidateP6AnalyticsForSettings('TEST_SETTINGS_CHANGED');
    await runLifecycleTurns();

    const analytics = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
    expect(analytics.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(analytics.complete).toBe(true);
    // D2 must NOT be promoted alongside it: the parked hole is still there.
    const geometry = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all');
    expect(geometry.state).not.toBe(P6_READINESS_STATES.VERIFIED);

    const settled = await runLifecycleTurns();
    expect(settled.turns.at(-1).hasMore).toBe(false);
    expect(settled.turns.filter((result) => String(result.state).startsWith('SETTINGS_REDISCOVERY')))
      .toHaveLength(0);
  });
});

describe('queueP6ExplicitTripSubjects bounded-work contract', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    storage.clear();
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);

  /**
   * Drop the work rows so every subject needs a real source read. This is the
   * defensive branch — the canonical writer normally mints a work row in the
   * same transaction as the source row — and it is the only branch where the
   * turn spends unbounded payload bytes, so it is the one worth pinning.
   */
  const dropWorkRows = () => { store(P6_TRIP_DERIVED_STORES.WORK)?.records.clear(); };

  const seed = async (count, { points = POINTS_PER_TRIP } = {}) => {
    for (let index = 0; index < count; index += 1) {
      await localTripRepository.create(
        trip(`rs-q-${String(index).padStart(4, '0')}`, { seed: index + 1, points }),
      );
    }
  };

  it('walks identities through a key cursor that never yields a record', async () => {
    // Coverage for the half of DPD-015B that is about *not reading*. The double
    // originally gained `openKeyCursor` on `FakeIndex` only, while both
    // production callers invoke it on an object store — so every test quietly
    // took the `openCursor` fallback and materialised full records, and a
    // regression removing the key-cursor branch would have been invisible.
    await seed(3);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const objectStore = db.transaction(P6_TRIP_SOURCE_STORE, 'readonly')
      .objectStore(P6_TRIP_SOURCE_STORE);
    expect(typeof objectStore.openKeyCursor).toBe('function');
    const first = await new Promise((resolve, reject) => {
      const request = objectStore.openKeyCursor(null);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(first).toBeTruthy();
    expect(first.primaryKey).toBe('rs-q-0000');
    // A key cursor has no record. This is the property the walk depends on.
    expect(first.value).toBeUndefined();
    expect('value' in first).toBe(false);
    db.close();

    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    expect(page.ids).toEqual(['rs-q-0000', 'rs-q-0001', 'rs-q-0002']);
    expect(page.nextCursor).toBeNull();
  });

  it('reuses the work row content token rather than re-reading the payload', async () => {
    await seed(8);
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: P6_TURN_BUDGET.bytes,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.examined).toBe(8);
    expect(outcome.deferred).toBe(false);
    expect(outcome.oversizedUnitBytes).toBe(0);
    // Work rows, not trip payloads. One whole trip here is already six figures.
    expect(outcome.bytesWorked).toBeLessThan(P6_SOURCE_READ_RESERVE_BYTES);
  });

  it('stops before a payload read it cannot afford, and says where to resume', async () => {
    await seed(34);
    dropWorkRows();
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: P6_TURN_BUDGET.bytes,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.deferred).toBe(true);
    expect(outcome.bytesWorked).toBeLessThanOrEqual(P6_TURN_BUDGET.bytes);
    // Forward progress is not optional: a deferral that queued nothing would be
    // the zero-progress continuation loop this whole change exists to avoid.
    expect(outcome.queued).toBeGreaterThan(0);
    expect(outcome.lastKey).toBe(page.ids[outcome.examined - 1]);

    // The next turn resumes after that key and keeps going, so the walk is not
    // stuck on the same subjects.
    const next = await listP6BrowserCanonicalSubjectKeyPage({ afterKey: outcome.lastKey, maxItems: 32 });
    expect(next.ids[0]).toBe(page.ids[outcome.examined]);
  });

  it('cannot accumulate an overrun out of several rows that each fit the reserve', async () => {
    // The first version of this fix used only a pre-read byte reserve, and an
    // independent review reproduced the hole: with a 4 MiB budget and a 1 MiB
    // reserve, two 1.5 MB rows leave 1.19 MB "available", so a third 1.5 MB row
    // is read and the turn reports 4,503,859 bytes — the same contract
    // violation this whole change exists to remove. Each row fits the reserve;
    // the accumulation does not. The bound is one unknown-size read per turn.
    await seed(3, { points: 7900 });
    dropWorkRows();
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    const rowBytes = [];
    for (const id of page.ids) {
      rowBytes.push(encodedBytes(store(P6_TRIP_SOURCE_STORE).records.get(id)));
    }
    // Guards the guard: each row must individually clear the reserve, or this
    // test is not exercising the accumulation case at all.
    for (const bytes of rowBytes) {
      expect(bytes).toBeGreaterThan(P6_SOURCE_READ_RESERVE_BYTES);
    }
    expect(rowBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(P6_TURN_BUDGET.bytes);

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: P6_TURN_BUDGET.bytes,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.bytesWorked).toBeLessThanOrEqual(P6_TURN_BUDGET.bytes);
    expect(outcome.payloadReads).toBe(1);
    expect(outcome.queued).toBe(1);
    expect(outcome.deferred).toBe(true);
    expect(outcome.lastKey).toBe(page.ids[0]);
  });

  it('runs one indivisible oversized unit rather than looping on it, and discloses the cost', async () => {
    await seed(2);
    dropWorkRows();
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    // A budget smaller than a single trip row: the pathological case where no
    // amount of deferring can ever make the unit fit.
    const tinyBudget = 1024;

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: tinyBudget,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.queued).toBe(1);
    expect(outcome.deferred).toBe(true);
    expect(outcome.lastKey).toBe(page.ids[0]);
    // Reported as a fully consumed turn — never as a cheap one — with the true
    // figure carried alongside rather than hidden.
    expect(outcome.bytesWorked).toBe(tinyBudget);
    expect(outcome.oversizedUnitBytes).toBeGreaterThan(tinyBudget);
  });

  it('refuses to un-park a subject for domains only an explicit pass can rebuild', async () => {
    await seed(3);
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    for (const id of page.ids) {
      store(P6_TRIP_DERIVED_STORES.WORK).records.set(id, {
        ...store(P6_TRIP_DERIVED_STORES.WORK).records.get(id),
        state: 'EXPLICIT_SOURCE_REQUIRED',
      });
    }

    // The rail: a wider invalidation routed through the lifecycle path. Only an
    // explicit pass may re-mint the point-derived domains, so PRESERVE leaves
    // these rows exactly as it found them rather than widening their debt.
    const outcome = await queueP6ExplicitTripSubjects(
      page.ids,
      [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY],
      { maxBytes: P6_TURN_BUDGET.bytes, parkedPolicy: 'PRESERVE' },
    );

    expect(outcome.queued).toBe(0);
    expect(outcome.parkedLeftAlone).toBe(3);
    expect(outcome.parkedRequeued).toBe(0);
    for (const id of page.ids) {
      expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get(id).state, id)
        .toBe('EXPLICIT_SOURCE_REQUIRED');
    }
  });

  it('re-queues a parked subject for D1 alone and carries its park forward', async () => {
    await seed(3);
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    for (const id of page.ids) {
      store(P6_TRIP_DERIVED_STORES.WORK).records.set(id, {
        ...store(P6_TRIP_DERIVED_STORES.WORK).records.get(id),
        state: 'EXPLICIT_SOURCE_REQUIRED',
      });
    }

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: P6_TURN_BUDGET.bytes,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.queued).toBe(3);
    expect(outcome.parkedRequeued).toBe(3);
    expect(outcome.parkedLeftAlone).toBe(0);
    for (const id of page.ids) {
      const row = store(P6_TRIP_DERIVED_STORES.WORK).records.get(id);
      // Dirty for D1 only, and carrying the state it must return to — so the
      // park is neither re-derived across four retirement turns nor lost.
      expect(row.dirtyDomains, id).toEqual([P6_DOMAIN_KEYS.ANALYTICS]);
      expect(row.reevaluateCapacityBlocked, id).toBe(false);
      expect(row.analyticsOnlyTerminalState, id).toBe('EXPLICIT_SOURCE_REQUIRED');
    }
  });

  it('leaves an in-flight row alone rather than narrowing its domains', async () => {
    await seed(2);
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    // A freshly created trip is already DIRTY across every domain — the
    // canonical writer mints it that way — so the contrast is set up
    // explicitly: one row mid-build, one row settled.
    const [building, settled] = page.ids;
    store(P6_TRIP_DERIVED_STORES.WORK).records.set(building, {
      ...store(P6_TRIP_DERIVED_STORES.WORK).records.get(building),
      state: 'BUILDING',
      cursor: { outputOrdinal: 3 },
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
    });
    store(P6_TRIP_DERIVED_STORES.WORK).records.set(settled, {
      ...store(P6_TRIP_DERIVED_STORES.WORK).records.get(settled),
      state: 'COMPLETE',
      cursor: null,
    });

    const outcome = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
      maxBytes: P6_TURN_BUDGET.bytes,
      parkedPolicy: 'PRESERVE',
    });

    expect(outcome.alreadyInFlight).toBe(1);
    expect(outcome.queued).toBe(1);

    const untouched = store(P6_TRIP_DERIVED_STORES.WORK).records.get(building);
    expect(untouched.state).toBe('BUILDING');
    expect(untouched.cursor).toEqual({ outputOrdinal: 3 });
    expect(untouched.dirtyDomains).toEqual(Object.values(P6_DOMAIN_KEYS));

    // The settled row is the one rediscovery is for, and it carries the state
    // it must return to rather than losing it.
    const requeued = store(P6_TRIP_DERIVED_STORES.WORK).records.get(settled);
    expect(requeued.state).toBe('DIRTY');
    expect(requeued.dirtyDomains).toEqual([P6_DOMAIN_KEYS.ANALYTICS]);
    expect(requeued.analyticsOnlyTerminalState).toBe('COMPLETE');
  });

  it('still re-mints parked subjects for the explicit repair', async () => {
    await seed(3);
    const page = await listP6BrowserCanonicalSubjectKeyPage({ maxItems: 32 });
    for (const id of page.ids) {
      store(P6_TRIP_DERIVED_STORES.WORK).records.set(id, {
        ...store(P6_TRIP_DERIVED_STORES.WORK).records.get(id),
        state: 'EXPLICIT_SOURCE_REQUIRED',
      });
    }

    const outcome = await queueP6ExplicitTripSubjects(
      page.ids,
      [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY],
    );

    // REMINT is the default, and re-minting parked subjects is exactly what the
    // explicit repair exists to do.
    expect(outcome.queued).toBe(3);
    for (const id of page.ids) {
      const row = store(P6_TRIP_DERIVED_STORES.WORK).records.get(id);
      expect(row.state, id).toBe('DIRTY');
      expect(row.dirtyDomains, id).toEqual([P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY]);
      expect(row.analyticsOnlyTerminalState, id).toBeUndefined();
    }
  });
});
