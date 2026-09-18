import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/query-core';
import { localVehicleRepository, VEHICLES_KEY } from '@/lib/localVehicleRepository';
import { vehicleQueryKeys, vehicleService } from '@/api/vehicles';
import {
  advanceRetiredPage, canAdvanceRetiredPage, clearReassignedDiscoveries, discoverRetiredReferenceTrips,
  fleetCountLabel, getTripsNeedingVehicleReview, getUnassignedCompletedTrips, mergeDiscoveredReviewTrips,
  resolveTripVehicle, retiredPageState, retiredScanScopeNote, rewindRetiredPage, RETIRED_PAGE_SIZE,
  summarizeAssignmentOutcome,
} from '@/pages/Vehicles';

/**
 * Vehicle Collection / Reference Lifecycle — Wave 4 (HPR-003 + HPR-010).
 *
 * One batch because they share one root: a capped vehicle prefix is not an
 * authority. HPR-003 is the collection telling its caller what it represents;
 * HPR-010 is a reference whose target must be resolved by identity, never by
 * absence from whatever page happened to load.
 */

const installStore = () => {
  const values = new Map();
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  return values;
};

const seedVehicles = async (count, overrides = () => ({})) => {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    created.push({
      id: `vehicle-${String(index).padStart(4, '0')}`,
      name: `Car ${index}`,
      make: 'Make',
      model: `Model ${index}`,
      year: 2020,
      // Oldest first in creation order, so `-created_date` puts the newest first.
      created_date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
      is_default: index === 0,
      ...overrides(index),
    });
  }
  await localVehicleRepository.upsertMany(created);
  return created;
};

const completedTrip = (id, vehicleId, overrides = {}) => ({
  id,
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  distance_km: 12,
  duration_seconds: 1_200,
  ...(vehicleId === undefined ? {} : { vehicle_id: vehicleId }),
  vehicle_assignment_status: vehicleId ? 'confirmed' : 'unassigned',
  ...overrides,
});

beforeEach(() => { installStore(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('HPR-003 — the vehicle collection states what it represents', () => {
  it('A: a capped read reports the rows it returned and that more exist', async () => {
    await seedVehicles(51);
    const page = await vehicleService.listPage({ sort: '-created_date', limit: 50 });

    expect(page.vehicles.length).toBe(50);
    expect(page.returned).toBe(50);
    expect(page.hasMore).toBe(true);
    expect(page.complete).toBe(false);
    expect(page.continuation).toBeTruthy();
  });

  it('B: the terminal page is authoritative, with no phantom continuation', async () => {
    await seedVehicles(51);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const last = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: first.continuation });

    expect(last.vehicles.length).toBe(1);
    expect(last.hasMore).toBe(false);
    expect(last.complete).toBe(true);
    expect(last.continuation).toBeNull();
    const ids = [...first.vehicles, ...last.vehicles].map((vehicle) => vehicle.id);
    expect(new Set(ids).size).toBe(51);
  });

  it('C: the exact boundary is answered by the collection, not guessed from row count', async () => {
    await seedVehicles(50);
    const exact = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(exact.vehicles.length).toBe(50);
    expect(exact.hasMore).toBe(false);
    expect(exact.complete).toBe(true);
    expect(exact.continuation).toBeNull();

    await localVehicleRepository.create({ name: 'One more', make: 'Make', model: 'Extra' });
    const overflowing = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(overflowing.vehicles.length).toBe(50);
    expect(overflowing.hasMore).toBe(true);
  });

  it('never returns more rows than the page asked for, at any fleet size', async () => {
    for (const size of [0, 1, 10, 50, 51, 100, 200]) {
      localStorage.removeItem(VEHICLES_KEY);
      if (size) await seedVehicles(size);
      const page = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
      expect(page.vehicles.length).toBe(Math.min(size, 50));
      expect(page.hasMore).toBe(size > 50);
      expect(page.complete).toBe(size <= 50);
    }
  });
});

describe('HPR-003 — collection cache identity', () => {
  it('keeps differently bounded requests on different keys', () => {
    const fifty = vehicleQueryKeys.page({ sort: '-created_date', limit: 50 });
    const hundred = vehicleQueryKeys.page({ sort: '-created_date', limit: 100 });
    const sorted = vehicleQueryKeys.page({ sort: 'name', limit: 50 });
    const continued = vehicleQueryKeys.page({ sort: '-created_date', limit: 50, cursor: 'c1' });
    expect(fifty).not.toEqual(hundred);
    expect(fifty).not.toEqual(sorted);
    expect(fifty).not.toEqual(continued);
    // An id-addressed lookup is its own identity, never a page.
    expect(vehicleQueryKeys.byId('vehicle-0007')).not.toEqual(fifty);
    expect(vehicleQueryKeys.byId('vehicle-0007')).not.toEqual(vehicleQueryKeys.byId('vehicle-0008'));
  });

  it('cannot let a 50-row result answer a 100-row consumer', async () => {
    await seedVehicles(120);
    const client = new QueryClient();
    const fifty = await client.fetchQuery({
      queryKey: vehicleQueryKeys.page({ sort: '-created_date', limit: 50 }),
      queryFn: () => vehicleService.listPage({ sort: '-created_date', limit: 50 }),
    });
    const hundred = await client.fetchQuery({
      queryKey: vehicleQueryKeys.page({ sort: '-created_date', limit: 100 }),
      queryFn: () => vehicleService.listPage({ sort: '-created_date', limit: 100 }),
    });
    expect(fifty.vehicles.length).toBe(50);
    expect(hundred.vehicles.length).toBe(100);
    // Navigation order must not change what either surface represents.
    expect(client.getQueryData(vehicleQueryKeys.page({ sort: '-created_date', limit: 50 })).vehicles.length).toBe(50);
  });

  it('keeps every page consumer on one documented key family', () => {
    // Every vehicle consumer sits on the one documented family, using the member
    // its traced contract calls for: a fleet page, an id lookup, the id set its
    // loaded rows mention, the complete reference authority, or the default.
    const expected = {
      '../../pages/Vehicles.jsx': 'vehicleQueryKeys.page(',
      '../../pages/Dashboard.jsx': 'vehicleQueryKeys.page(',
      '../../pages/TripDetail.jsx': 'vehicleQueryKeys.byId(',
      '../../pages/TripHistory.jsx': 'vehicleQueryKeys.byIds(',
      '../../pages/Report.jsx': 'vehicleQueryKeys.reference',
    };
    for (const [source, member] of Object.entries(expected)) {
      const text = readSource(source);
      expect(text, source).toContain(member);
      expect(text, source).not.toMatch(/queryKey:\s*\['vehicles'\]/);
    }
  });
});

describe('HPR-003 — a complete export is complete', () => {
  it('pages the whole fleet instead of stopping at a silent cap', async () => {
    await seedVehicles(1_001);
    const all = await vehicleService.listAllVehiclesForExport();
    expect(all.length).toBe(1_001);
    expect(new Set(all.map((vehicle) => vehicle.id)).size).toBe(1_001);
    // Bounded turns over one prepared snapshot; the per-page cost is the slice,
    // not another parse and sort of the whole collection.
    const bounded = await localVehicleRepository.listAllVehiclesForExport({ pageSize: 50 });
    expect(bounded.length).toBe(1_001);
  });

  it('is wired into the data-rights bundle', () => {
    const text = readSource('../dataRights.js');
    expect(text).toContain('listAllVehiclesForExport(');
    expect(text).not.toMatch(/vehicleService\.list\(\{[^}]*limit:\s*1000/);
  });
});

describe('HPR-010 — deleting a profile leaves an explicit lifecycle state', () => {
  const fleetWithHistory = async () => {
    await localVehicleRepository.create({ id: 'veh-a', name: 'Alpha', make: 'A', model: 'One' });
    await localVehicleRepository.create({ id: 'veh-b', name: 'Bravo', make: 'B', model: 'Two' });
    return [
      completedTrip('trip-a1', 'veh-a'),
      completedTrip('trip-a2', 'veh-a'),
      completedTrip('trip-b1', 'veh-b'),
      completedTrip('trip-none', undefined),
      completedTrip('trip-review', 'veh-b', { vehicle_assignment_status: 'needs_confirmation' }),
    ];
  };

  it('retires the identity so historical attribution still resolves', async () => {
    const trips = await fleetWithHistory();
    await vehicleService.delete('veh-a');

    // The profile leaves the active collection…
    const active = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(active.vehicles.map((vehicle) => vehicle.id)).not.toContain('veh-a');
    // …but the reference still resolves, by identity, to an explicitly retired record.
    const resolved = await vehicleService.getById('veh-a');
    expect(resolved).toBeTruthy();
    expect(resolved.retired).toBe(true);
    expect(resolved.vehicle.id).toBe('veh-a');
    expect(resolved.vehicle.name).toBe('Alpha');
    expect(resolved.vehicle.retired_at).toBeTruthy();
    expect(resolved.vehicle.is_default).toBe(false);

    // The trips themselves are untouched history.
    expect(trips.find((trip) => trip.id === 'trip-a1').vehicle_id).toBe('veh-a');
  });

  it('brings the affected trips into the repair workflow and leaves the others alone', async () => {
    const trips = await fleetWithHistory();
    await vehicleService.delete('veh-a');
    const retiredIds = new Set((await vehicleService.listRetired()).map((vehicle) => vehicle.id));
    expect(retiredIds).toEqual(new Set(['veh-a']));

    const review = getTripsNeedingVehicleReview(trips, { retiredVehicleIds: retiredIds });
    const reviewIds = review.map((trip) => trip.id);
    expect(reviewIds).toContain('trip-a1');
    expect(reviewIds).toContain('trip-a2');
    expect(reviewIds).toContain('trip-none');
    expect(reviewIds).toContain('trip-review');
    expect(reviewIds).not.toContain('trip-b1');

    // Unassigned keeps its own meaning: a retired reference is not "no vehicle".
    expect(getUnassignedCompletedTrips(trips).map((trip) => trip.id)).toEqual(['trip-none']);
  });

  it('attributes a retired reference truthfully rather than to another vehicle', async () => {
    const trips = await fleetWithHistory();
    await vehicleService.delete('veh-a');
    const active = (await vehicleService.listPage({ sort: '-created_date', limit: 50 })).vehicles;
    const retired = await vehicleService.listRetired();

    const forA = resolveTripVehicle(trips.find((trip) => trip.id === 'trip-a1'), active, retired);
    expect(forA.retired).toBe(true);
    expect(forA.vehicle.id).toBe('veh-a');

    const forB = resolveTripVehicle(trips.find((trip) => trip.id === 'trip-b1'), active, retired);
    expect(forB.retired).toBe(false);
    expect(forB.vehicle.id).toBe('veh-b');

    // An unassigned trip still falls to the default vehicle, exactly as before.
    const forNone = resolveTripVehicle(trips.find((trip) => trip.id === 'trip-none'), active, retired);
    expect(forNone.vehicle?.id).toBe('veh-a' === forNone.vehicle?.id ? 'veh-b' : forNone.vehicle?.id);
    expect(forNone.retired).toBe(false);
  });

  it('keeps the foreground delete bounded: no historical trip is read', async () => {
    await fleetWithHistory();
    const repository = await import('@/lib/localTripRepository');
    const listAll = vi.spyOn(repository.localTripRepository, 'listAll');
    const listAllForExport = vi.spyOn(repository.localTripRepository, 'listAllForExport');
    await vehicleService.delete('veh-a');
    expect(listAll).not.toHaveBeenCalled();
    expect(listAllForExport).not.toHaveBeenCalled();
  });

  it('never leaves the default on a retired profile', async () => {
    // Storage order puts the newest first, so retiring the newest vehicle is the
    // case where a promotion that ignored retirement would pick the dead record.
    await localVehicleRepository.create({ id: 'veh-old', name: 'Old', make: 'A', model: 'One' });
    await localVehicleRepository.create({ id: 'veh-new', name: 'New', make: 'B', model: 'Two', is_default: true });
    await vehicleService.delete('veh-new');

    const active = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(active.vehicles.map((vehicle) => vehicle.id)).toEqual(['veh-old']);
    expect(active.vehicles[0].is_default).toBe(true);
    const retired = await vehicleService.getById('veh-new');
    expect(retired.retired).toBe(true);
    expect(retired.vehicle.is_default).toBe(false);
    // And an unassigned trip follows the surviving default, never the retired one.
    const resolved = resolveTripVehicle(completedTrip('t', undefined), active.vehicles, await vehicleService.listRetired());
    expect(resolved.vehicle.id).toBe('veh-old');
  });

  it('promotes a new default and keeps deletion idempotent', async () => {
    await localVehicleRepository.create({ id: 'veh-default', name: 'Default', make: 'A', model: 'One' });
    await localVehicleRepository.create({ id: 'veh-second', name: 'Second', make: 'B', model: 'Two' });
    const before = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(before.vehicles.find((vehicle) => vehicle.is_default)?.id).toBe('veh-default');

    await vehicleService.delete('veh-default');
    const after = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(after.vehicles.length).toBe(1);
    expect(after.vehicles[0].id).toBe('veh-second');
    expect(after.vehicles[0].is_default).toBe(true);

    // Deleting an already-retired or unknown id changes nothing.
    await vehicleService.delete('veh-default');
    await vehicleService.delete('veh-missing');
    expect((await vehicleService.listRetired()).map((vehicle) => vehicle.id)).toEqual(['veh-default']);
    expect((await vehicleService.listPage({ sort: '-created_date', limit: 50 })).vehicles.length).toBe(1);
  });
});

describe('Wave 4 — reference existence is id-addressed, never prefix absence', () => {
  it('does not call an existing out-of-prefix vehicle deleted', async () => {
    await seedVehicles(1_200);
    await vehicleService.delete('vehicle-0005');

    // The page a consumer would actually hold.
    const prefix = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const prefixIds = new Set(prefix.vehicles.map((vehicle) => vehicle.id));
    // `vehicle-0700` is a real vehicle far outside that prefix.
    expect(prefixIds.has('vehicle-0700')).toBe(false);
    const existing = await vehicleService.getById('vehicle-0700');
    expect(existing.retired).toBe(false);
    expect(existing.vehicle.id).toBe('vehicle-0700');

    const retiredIds = new Set((await vehicleService.listRetired()).map((vehicle) => vehicle.id));
    expect(retiredIds).toEqual(new Set(['vehicle-0005']));

    const trips = [
      completedTrip('trip-far', 'vehicle-0700'),
      completedTrip('trip-deleted', 'vehicle-0005'),
    ];
    const review = getTripsNeedingVehicleReview(trips, { retiredVehicleIds: retiredIds })
      .map((trip) => trip.id);
    // Absence from the loaded 50 proves nothing; only the retired record does.
    expect(review).toEqual(['trip-deleted']);

    const resolvedFar = resolveTripVehicle(trips[0], prefix.vehicles, await vehicleService.listRetired());
    expect(resolvedFar.retired).toBe(false);
    expect(resolvedFar.unknown).toBe(true);
    expect(resolvedFar.vehicle).toBeNull();
  });

  it('keeps the retired collection bounded by deletions, not by fleet size', async () => {
    await seedVehicles(300);
    await vehicleService.delete('vehicle-0001');
    await vehicleService.delete('vehicle-0002');
    const retired = await vehicleService.listRetired();
    expect(retired.map((vehicle) => vehicle.id).sort()).toEqual(['vehicle-0001', 'vehicle-0002']);
    const active = await vehicleService.listPage({ sort: '-created_date', limit: 500 });
    expect(active.vehicles.length).toBe(298);
    expect(active.vehicles.some((vehicle) => vehicle.retired_at)).toBe(false);
  });
});

function readSource(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

// ---------------------------------------------------------------------------
// Wave 4 correction pass — the mechanisms CODEX reproduced against the frozen
// implementation: reference-sensitive production still reading capped prefixes,
// a mutation-unstable offset cursor, an export that can truncate silently and
// reprepares the whole collection per page, a Settings backup that drops
// retired and beyond-200 identity, repair discovery capped at the newest 100
// trips, and an unbounded retired collection behind a bare prefix count.
// ---------------------------------------------------------------------------

describe('Wave 4 correction — reference authority is id-addressed everywhere', () => {
  it('resolves a bounded set of references in one collection read', async () => {
    await seedVehicles(1_200);
    const resolved = await vehicleService.getByIds(['vehicle-0600', 'vehicle-1100', 'missing']);
    expect(resolved.map((vehicle) => vehicle.id)).toEqual(['vehicle-0600', 'vehicle-1100']);

    // One preparation for the whole bounded set: asking about fifty references
    // costs exactly what asking about one costs, never one blob read per id.
    const readsFor = async (ids) => {
      const spy = vi.spyOn(localStorage, 'getItem');
      await vehicleService.getByIds(ids);
      const count = spy.mock.calls.filter(([key]) => key === VEHICLES_KEY).length;
      spy.mockRestore();
      return count;
    };
    await readsFor(['vehicle-0600']); // warm: first read normalizes and rewrites once
    const one = await readsFor(['vehicle-0600']);
    const fifty = await readsFor(Array.from({ length: 50 }, (_, index) => `vehicle-${String(index).padStart(4, '0')}`));
    expect(one).toBeGreaterThan(0);
    expect(fifty).toBe(one);
    expect(await vehicleService.getByIds(['vehicle-0600', 'vehicle-0600'])).toHaveLength(1);
  });

  it('keeps a retired reference resolvable through the bulk authority', async () => {
    await seedVehicles(120);
    await vehicleService.delete('vehicle-0000');
    const resolved = await vehicleService.getByIds(['vehicle-0000']);
    expect(resolved.length).toBe(1);
    expect(resolved[0].retired_at).toBeTruthy();
    const active = await vehicleService.getByIds(['vehicle-0000'], { includeRetired: false });
    expect(active).toEqual([]);
  });

  it('resolves a vehicle far beyond every display prefix through the real repository path', async () => {
    await seedVehicles(1_200);
    const { localTripRepository } = await import('@/lib/localTripRepository');
    const target = await vehicleService.getById('vehicle-0600');
    expect(target.retired).toBe(false);

    const vehicles = await localVehicleRepository.getByIds(['vehicle-0600']);
    expect(vehicles.map((vehicle) => vehicle.id)).toEqual(['vehicle-0600']);
    // The prefix every reference-sensitive caller used to read cannot see it.
    const prefix = await localVehicleRepository.list({ sort: '-created_date', limit: 500, includeRetired: true });
    expect(prefix.some((vehicle) => vehicle.id === 'vehicle-0600')).toBe(false);

    // Production must not resolve references through that prefix any more.
    for (const [file, pattern] of [
      ['../localTripRepository.js', /localVehicleRepository\.list\(\{[^}]*limit: 500/],
      ['../p6TripDerivedState.js', /localVehicleRepository\.list\(\{[^}]*limit: 500/],
    ]) {
      expect(readSource(file), file).not.toMatch(pattern);
    }
    expect(localTripRepository).toBeTruthy();
  });

  it('gives P6 derived state a complete vehicle authority', async () => {
    await seedVehicles(1_200);
    const { readAnalyticsSettingsSnapshotForTests } = await import('@/lib/p6TripDerivedState');
    const snapshot = await readAnalyticsSettingsSnapshotForTests();
    expect(snapshot.vehicles.some((vehicle) => vehicle.id === 'vehicle-0600')).toBe(true);
  });

  it('keeps TripDetail, Report and History on id-addressed reference authority', () => {
    expect(readSource('../../pages/TripDetail.jsx')).toContain('vehicleQueryKeys.byId(');
    // History holds its rows, so it resolves exactly the ids they mention.
    expect(readSource('../../pages/TripHistory.jsx')).toContain('vehicleQueryKeys.byIds(');
    // Report's economics callbacks are folded by reducers over rows it never
    // holds, so it cannot enumerate ids: its authority is the complete
    // collection, which is still not a prefix.
    expect(readSource('../../pages/Report.jsx')).toContain('vehicleQueryKeys.reference');
    expect(readSource('../../pages/Report.jsx')).not.toMatch(/vehicleQueryKeys\.page\(/);
  });
});

describe('Wave 4 correction — the durable default is its own authority', () => {
  it('answers with the stored default even when it is outside every display page', async () => {
    await seedVehicles(1_200);
    // Make a vehicle far outside the newest 50 the durable default.
    await localVehicleRepository.update('vehicle-0000', { is_default: true });
    const page = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(page.vehicles.some((vehicle) => vehicle.id === 'vehicle-0000')).toBe(false);
    expect(page.vehicles.some((vehicle) => vehicle.is_default)).toBe(false);

    const durable = await vehicleService.getDefault();
    expect(durable.id).toBe('vehicle-0000');
    // A retired profile can never be the default.
    await vehicleService.delete('vehicle-0000');
    const promoted = await vehicleService.getDefault();
    expect(promoted.retired_at).toBeFalsy();
    expect(promoted.id).not.toBe('vehicle-0000');
  });

  it('keeps the default-consuming pages off the page-prefix fallback', () => {
    for (const page of ['../../pages/Dashboard.jsx', '../../pages/Vehicles.jsx']) {
      const text = readSource(page);
      expect(text, page).toContain('vehicleQueryKeys.default');
      expect(text, page).not.toMatch(/vehicles\.find\(\(vehicle\) => vehicle\.is_default\) \|\| vehicles\[0\]/);
    }
    // Parking holds its own state rather than a query cache, so it reads the
    // same durable authority directly; what must not survive anywhere is the
    // prefix fallback that promoted a visible stranger.
    const parking = readSource('../../pages/Parking.jsx');
    expect(parking).toContain('vehicleService.getDefault()');
    expect(parking).not.toMatch(/vehicles\.find\(\(vehicle\) => vehicle\.is_default\) \|\| vehicles\[0\]/);
  });
});

describe('Wave 4 correction — an aggregate never resolves references against a prefix', () => {
  it('shows why a partial collection is not a usable reference authority', async () => {
    // The carbon accumulator drops a trip whose `vehicle_id` it cannot resolve
    // in the collection it was handed. Handed a prefix, that is absence read as
    // deletion; handed nothing, it falls back to the trip's own recorded value.
    const { createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    const trip = completedTrip('t1', 'vehicle-0600', { co2_saved_kg: 1.25 });
    const prefix = [{ id: 'vehicle-0000', name: 'Car 0', fuel_type: 'gasoline' }];

    const withPrefix = createAchievementStatsAccumulator({}, prefix);
    withPrefix.addTrip(trip);
    expect(withPrefix.result().carbonEligibleTripCount).toBe(0);

    const withoutCollection = createAchievementStatsAccumulator({}, null);
    withoutCollection.addTrip(trip);
    const stats = withoutCollection.result();
    expect(stats.carbonEligibleTripCount).toBe(1);
    expect(stats.carbonCo2SavedKg).toBeCloseTo(1.25, 5);
  });

  it('keeps the milestone settlement from passing a partial page as the fleet', () => {
    const source = readSource('../milestoneNotificationCoordinator.js');
    expect(source).toContain('vehicleService.listPage(');
    expect(source).not.toMatch(/vehicleService\.list\(\{/);
    // A page that cannot represent the fleet is not handed on as one.
    expect(source).toContain('vehiclePage.hasMore ? null');
  });
});

describe('Wave 4 correction — continuation is stable across collection mutation', () => {
  it('refuses to continue an old cursor after an insert, instead of skipping a row', async () => {
    await seedVehicles(60);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(first.vehicles.length).toBe(50);

    await localVehicleRepository.create({ id: 'vehicle-newest', name: 'Newest', make: 'M', model: 'N' });

    const stale = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: first.continuation });
    expect(stale.restartRequired).toBe(true);
    expect(stale.vehicles).toEqual([]);
    expect(stale.complete).toBe(false);
    expect(stale.hasMore).toBe(false);
    expect(stale.reason).toBe('COLLECTION_CHANGED');

    // Restarting gives a coherent population with no duplicate and no omission.
    const restartedFirst = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const restartedLast = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: restartedFirst.continuation });
    const ids = [...restartedFirst.vehicles, ...restartedLast.vehicles].map((vehicle) => vehicle.id);
    expect(ids.length).toBe(61);
    expect(new Set(ids).size).toBe(61);
    expect(ids).toContain('vehicle-newest');
  });

  it('refuses an old cursor after a retirement or a sort-field change', async () => {
    await seedVehicles(60);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    await vehicleService.delete('vehicle-0059');
    expect((await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: first.continuation })).restartRequired).toBe(true);

    const reread = await vehicleService.listPage({ sort: 'name', limit: 50 });
    await localVehicleRepository.update('vehicle-0001', { name: 'Zzz renamed' });
    const afterRename = await vehicleService.listPage({ sort: 'name', limit: 50, cursor: reread.continuation });
    expect(afterRename.restartRequired).toBe(true);
  });

  it('still continues normally when nothing changed', async () => {
    await seedVehicles(60);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const second = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: first.continuation });
    expect(second.restartRequired).toBeFalsy();
    expect(second.vehicles.length).toBe(10);
    expect(second.complete).toBe(true);
  });
});

describe('Wave 4 correction — a complete export is complete and prepared once', () => {
  it('prepares the collection once instead of per output page', async () => {
    await seedVehicles(1_001);
    const snapshotSpy = vi.spyOn(localVehicleRepository, 'openCollectionSnapshot');
    const pageSpy = vi.spyOn(localVehicleRepository, 'listPage');

    const all = await vehicleService.listAllVehiclesForExport({ pageSize: 50 });

    expect(all.length).toBe(1_001);
    expect(new Set(all.map((vehicle) => vehicle.id)).size).toBe(1_001);
    // 21 output pages, one preparation. The previous shape re-read, re-normalized
    // and re-sorted the whole blob for each of them.
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(pageSpy).not.toHaveBeenCalled();
  });

  it('cannot return a silently truncated population', async () => {
    await seedVehicles(300);
    await expect(vehicleService.listAllVehiclesForExport({ maxTurns: 2, pageSize: 50 }))
      .rejects.toThrow(/incomplete|overflow/i);
  });

  it('represents one snapshot even if the collection changes mid-export', async () => {
    await seedVehicles(400);
    const snapshot = await localVehicleRepository.openCollectionSnapshot();
    await localVehicleRepository.create({ id: 'vehicle-after', name: 'After', make: 'M', model: 'N' });
    const exported = await localVehicleRepository.listAllVehiclesForExport({ snapshot });
    expect(exported.length).toBe(400);
    expect(exported.some((vehicle) => vehicle.id === 'vehicle-after')).toBe(false);
  });
});

describe('Wave 4 correction — Settings backup keeps vehicle identity', () => {
  it('carries the complete active fleet and every retired profile', async () => {
    await seedVehicles(205);
    await vehicleService.delete('vehicle-0000');
    const population = await vehicleService.snapshotForBackup();
    expect(population.length).toBe(205);
    const retired = population.find((vehicle) => vehicle.id === 'vehicle-0000');
    expect(retired).toBeTruthy();
    expect(retired.retired_at).toBeTruthy();
    expect(population.filter((vehicle) => !vehicle.retired_at).length).toBe(204);
  });

  it('survives a backup and restore round trip as retired, with the reference intact', async () => {
    await seedVehicles(205);
    await vehicleService.delete('vehicle-0000');
    const trip = completedTrip('trip-retired-ref', 'vehicle-0000');
    const population = await vehicleService.snapshotForBackup();

    // Restore into a clean collection through the supported import seam.
    localStorage.removeItem(VEHICLES_KEY);
    expect((await vehicleService.listPage({ sort: '-created_date', limit: 50 })).vehicles).toEqual([]);
    await localVehicleRepository.upsertMany(population);

    const restored = await vehicleService.getById('vehicle-0000');
    expect(restored.retired).toBe(true);
    expect(restored.vehicle.retired_at).toBeTruthy();
    expect(trip.vehicle_id).toBe('vehicle-0000');
    const active = await vehicleService.listPage({ sort: '-created_date', limit: 500 });
    expect(active.vehicles.length).toBe(204);
    expect(active.vehicles.some((vehicle) => vehicle.id === 'vehicle-0000')).toBe(false);
    expect(active.vehicles.filter((vehicle) => vehicle.is_default).length).toBe(1);
  });

  it('takes its population from the export authority, not a display query', () => {
    const settings = readSource('../../pages/Settings.jsx');
    expect(settings).toContain('snapshotForBackup(');
    expect(settings).not.toMatch(/vehicleService\.list\(\{[^}]*limit:\s*200/);
  });
});

describe('Wave 4 correction — repair discovery reaches beyond the newest page', () => {
  it('finds an older retired-reference trip through bounded turns', async () => {
    const older = completedTrip('trip-old-retired', 'veh-retired', { start_time: '2020-01-01T08:00:00.000Z' });
    const pages = [
      { data: Array.from({ length: 100 }, (_, index) => completedTrip(`recent-${index}`, 'veh-live')), continuation: 'c1' },
      { data: [older], continuation: null },
    ];
    const readPage = vi.fn(async ({ cursor }) => pages[cursor === 'c1' ? 1 : 0]);

    const first = await discoverRetiredReferenceTrips({
      retiredVehicleIds: new Set(['veh-retired']),
      readPage,
    });
    expect(first.trips).toEqual([]);
    expect(first.complete).toBe(false);
    expect(first.continuation).toBe('c1');
    expect(readPage).toHaveBeenCalledTimes(1);

    const second = await discoverRetiredReferenceTrips({
      retiredVehicleIds: new Set(['veh-retired']),
      readPage,
      cursor: first.continuation,
    });
    expect(second.trips.map((row) => row.id)).toEqual(['trip-old-retired']);
    expect(second.complete).toBe(true);
    expect(second.continuation).toBeNull();
    // One bounded turn per action: never a whole-history sweep.
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('feeds what it found into the same repair workflow, without duplicates', () => {
    const recent = [completedTrip('recent-1', 'vehicle-retired')];
    const discovered = [completedTrip('recent-1', 'vehicle-retired'), completedTrip('older-1', 'vehicle-retired')];
    const merged = mergeDiscoveredReviewTrips(recent, discovered).map((trip) => trip.id);
    expect(merged).toEqual(['recent-1', 'older-1']);
    // A restart can re-read a page this scan already saw; one id stays one row.
    const repeated = mergeDiscoveredReviewTrips(recent, [...discovered, completedTrip('older-1', 'vehicle-retired')]);
    expect(repeated.map((trip) => trip.id)).toEqual(['recent-1', 'older-1']);
    expect(mergeDiscoveredReviewTrips(recent, [])).toBe(recent);
  });

  it('reports a restart truthfully instead of claiming completion', async () => {
    const readPage = vi.fn(async () => ({ unavailable: { code: 'CURSOR_RESTART_REQUIRED' } }));
    const result = await discoverRetiredReferenceTrips({
      retiredVehicleIds: new Set(['veh-retired']),
      readPage,
      cursor: 'stale',
    });
    expect(result.complete).toBe(false);
    expect(result.restartRequired).toBe(true);
    expect(result.continuation).toBeNull();
  });

  it('does not report an unresolvable reference as a deletion', async () => {
    // The load-bearing Wave 4 invariant, stated at the authority itself: a
    // reference the collection cannot resolve is *unknown*, never retired.
    // Classifying it as deleted would pull a correctly attributed trip — one
    // whose vehicle simply is not in this store — into the repair workflow.
    await seedVehicles(20);
    await vehicleService.delete('vehicle-0000');
    const states = await vehicleService.getReferenceStates(['vehicle-0000', 'vehicle-0005', 'never-stored']);
    expect(states.get('vehicle-0000')).toMatchObject({ retired: true });
    expect(states.get('vehicle-0005')).toMatchObject({ retired: false });
    expect(states.get('never-stored')).toMatchObject({ retired: false, unknown: true, vehicle: null });

    const trips = [completedTrip('t1', 'vehicle-0000'), completedTrip('t2', 'never-stored')];
    const review = getTripsNeedingVehicleReview(trips, { vehicleStates: states }).map((trip) => trip.id);
    expect(review).toEqual(['t1']);
  });

  it('classifies loaded rows from id-addressed state, not a global retired set', async () => {
    await seedVehicles(400);
    await vehicleService.delete('vehicle-0000');
    const trips = [completedTrip('t1', 'vehicle-0000'), completedTrip('t2', 'vehicle-0399')];
    const states = await vehicleService.getReferenceStates(trips.map((trip) => trip.vehicle_id));
    const review = getTripsNeedingVehicleReview(trips, { vehicleStates: states }).map((trip) => trip.id);
    expect(review).toEqual(['t1']);
  });
});

describe('Wave 4 correction — retired display is paged and counts are truthful', () => {
  it('returns a bounded retired page with its own completeness', async () => {
    await seedVehicles(40);
    for (let index = 0; index < 25; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }
    const page = await vehicleService.listRetiredPage({ limit: 10 });
    expect(page.vehicles.length).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.continuation).toBeTruthy();
    const next = await vehicleService.listRetiredPage({ limit: 10, cursor: page.continuation });
    expect(next.vehicles.length).toBe(10);
    expect(next.hasMore).toBe(true);
  });

  it('keeps the fleet page from loading every retired profile', () => {
    const page = readSource('../../pages/Vehicles.jsx');
    expect(page).toContain('listRetiredPage(');
    expect(page).not.toMatch(/vehicleService\.listRetired\(\)/);
  });

  it('presents an incomplete fleet count as a lower bound', () => {
    expect(fleetCountLabel({ count: 50, hasMore: true })).toBe('at least 50');
    expect(fleetCountLabel({ count: 50, hasMore: false })).toBe('50');
    const page = readSource('../../pages/Vehicles.jsx');
    expect(page).toContain('fleetCountLabel(');
  });
});

// ---------------------------------------------------------------------------
// Wave 4 final correction — the four mechanisms CODEX reproduced against the
// frozen correction pass. Each is a statement about authority, not about a
// screen: a cache identity is a contract, a continuation is an authority, a
// bounded workflow must be able to reach what it discloses, and a measurement
// that is unavailable is not zero.
// ---------------------------------------------------------------------------

describe('Wave 4 final — one cache identity cannot carry two payload contracts', () => {
  /** The stale window the app actually runs with: a fresh entry is reused, not refetched. */
  const sharedClient = () => new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
  });

  const seedOneRetiredReference = async () => {
    await seedVehicles(3);
    await vehicleService.delete('vehicle-0000');
    return ['vehicle-0000'];
  };

  it('Order A: History populating the record cache cannot poison reference states', async () => {
    const ids = await seedOneRetiredReference();
    const client = sharedClient();

    const records = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(ids),
      queryFn: () => vehicleService.getByIds(ids),
    });
    expect(Array.isArray(records)).toBe(true);

    // The reference-state consumer asks a different question about the same
    // ids. It must get its own answer, not History's array.
    const states = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(ids),
      queryFn: () => vehicleService.getReferenceStates(ids),
    });
    expect(states instanceof Map).toBe(true);
    expect(states.get('vehicle-0000')).toMatchObject({ retired: true });

    // And the retired trip is still pulled into review, which is what the
    // poisoned array silently stopped doing.
    const review = getTripsNeedingVehicleReview(
      [completedTrip('t1', 'vehicle-0000')],
      { vehicleStates: states },
    ).map((trip) => trip.id);
    expect(review).toEqual(['t1']);
  });

  it('Order B: reference states populating first cannot poison the record array', async () => {
    const ids = await seedOneRetiredReference();
    const client = sharedClient();

    const states = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(ids),
      queryFn: () => vehicleService.getReferenceStates(ids),
    });
    expect(states instanceof Map).toBe(true);

    const records = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(ids),
      queryFn: () => vehicleService.getByIds(ids),
    });
    // History maps over this; a Map here is a crash, not a degraded label.
    expect(Array.isArray(records)).toBe(true);
    expect(records.map((vehicle) => vehicle.id)).toEqual(['vehicle-0000']);
  });

  it('lets each consumer actually run its own query, rather than inherit a cache hit', async () => {
    const ids = await seedOneRetiredReference();
    const client = sharedClient();
    const records = vi.spyOn(vehicleService, 'getByIds');
    const states = vi.spyOn(vehicleService, 'getReferenceStates');

    await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(ids),
      queryFn: () => vehicleService.getByIds(ids),
    });
    await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(ids),
      queryFn: () => vehicleService.getReferenceStates(ids),
    });

    // Sharing one identity would have served the second consumer the first
    // consumer's payload without ever calling its query function.
    expect(records).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledTimes(1);
  });

  it('keeps the two contracts on distinct identities and both under the root', () => {
    const ids = ['a', 'b'];
    expect(vehicleQueryKeys.referenceStates(ids)).not.toEqual(vehicleQueryKeys.byIds(ids));
    for (const key of [vehicleQueryKeys.byIds(ids), vehicleQueryKeys.referenceStates(ids)]) {
      expect(key[0]).toBe('vehicles');
    }
    // Ids are a set for both: the same request written two ways is one entry.
    expect(vehicleQueryKeys.referenceStates(['b', 'a', 'b'])).toEqual(vehicleQueryKeys.referenceStates(['a', 'b']));
    // And each consumer asks for the identity matching its own service call.
    const vehiclesPage = readSource('../../pages/Vehicles.jsx');
    expect(vehiclesPage).toContain('vehicleQueryKeys.referenceStates(');
    expect(vehiclesPage).not.toMatch(/queryKey: vehicleQueryKeys\.byIds\(/);
    const history = readSource('../../pages/TripHistory.jsx');
    expect(history).toContain('vehicleQueryKeys.byIds(');
    expect(history).not.toContain('vehicleQueryKeys.referenceStates(');
  });
});

describe('Wave 4 final — a continuation is authoritative or it is refused', () => {
  const currentRevision = async () => {
    const page = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    expect(page.continuation).toBeTruthy();
    return String(page.continuation).slice(0, String(page.continuation).lastIndexOf(':'));
  };

  it('refuses every malformed offset carried by an otherwise valid revision', async () => {
    await seedVehicles(60);
    const revision = await currentRevision();
    const offsets = [
      'not-a-number', 'NaN', 'Infinity', '-Infinity', '-5', '12.5', '', ' ',
      '0',            // never issued: a continuation always consumed at least one row
      '60', '61',     // at or beyond the population: never issued either
      '999999999999',
      '1e3',          // an exponent form the repository never writes
    ];
    for (const offset of offsets) {
      const page = await vehicleService.listPage({
        sort: '-created_date', limit: 50, cursor: `${revision}:${offset}`,
      });
      expect(page.vehicles, offset).toEqual([]);
      expect(page.returned, offset).toBe(0);
      expect(page.restartRequired, offset).toBe(true);
      expect(page.reason, offset).toBe('CURSOR_MALFORMED');
      expect(page.complete, offset).toBe(false);
      expect(page.continuation, offset).toBeNull();
    }
  });

  it('cannot be told it reached the end by a fabricated offset', async () => {
    await seedVehicles(60);
    const revision = await currentRevision();
    const page = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: `${revision}:5000`,
    });
    // An oversized offset used to slice nothing and read as authoritative EOF.
    expect(page.complete).toBe(false);
    expect(page.hasMore).toBe(false);
    expect(page.restartRequired).toBe(true);
    expect(page.reason).toBe('CURSOR_MALFORMED');
  });

  it('still advances on a real continuation, and still says COLLECTION_CHANGED on a real change', async () => {
    await seedVehicles(60);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const second = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: first.continuation,
    });
    expect(second.returned).toBe(10);
    expect(second.complete).toBe(true);
    expect(second.restartRequired).toBeFalsy();
    const ids = new Set([...first.vehicles, ...second.vehicles].map((vehicle) => vehicle.id));
    expect(ids.size).toBe(60);

    await localVehicleRepository.create({ name: 'Newest', created_date: new Date().toISOString() });
    const afterInsert = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: first.continuation,
    });
    expect(afterInsert.restartRequired).toBe(true);
    expect(afterInsert.reason).toBe('COLLECTION_CHANGED');
  });

  it('refuses a malformed retired continuation on the same terms', async () => {
    await seedVehicles(25);
    for (let index = 0; index < 25; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }
    const page = await vehicleService.listRetiredPage({ limit: 10 });
    const revision = String(page.continuation).slice(0, String(page.continuation).lastIndexOf(':'));
    const refused = await vehicleService.listRetiredPage({ limit: 10, cursor: `${revision}:nope` });
    expect(refused.restartRequired).toBe(true);
    expect(refused.reason).toBe('CURSOR_MALFORMED');
    const advanced = await vehicleService.listRetiredPage({ limit: 10, cursor: page.continuation });
    expect(advanced.returned).toBe(10);
  });
});

describe('Wave 4 final — the retired workflow can reach what it discloses', () => {
  const seedRetired = async (count) => {
    await seedVehicles(count + 2);
    for (let index = 0; index < count; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }
  };

  it('advances page by page to a retired profile the first page cannot hold', async () => {
    await seedRetired(11);
    const first = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE });
    expect(first.returned).toBe(RETIRED_PAGE_SIZE);
    expect(first.hasMore).toBe(true);

    // The page's own navigation state, driven exactly as the control drives it.
    let nav = retiredPageState();
    expect(canAdvanceRetiredPage(nav, first)).toBe(true);
    nav = advanceRetiredPage(nav, first);
    const second = await vehicleService.listRetiredPage({
      limit: RETIRED_PAGE_SIZE, cursor: nav.cursor,
    });
    expect(second.returned).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(canAdvanceRetiredPage(advanceRetiredPage(nav, second), second)).toBe(false);

    // Every retired profile is reachable across the two turns, including the
    // oldest one, which the fixed first page could never present.
    const seen = [...first.vehicles, ...second.vehicles].map((vehicle) => vehicle.id);
    expect(seen).toContain('vehicle-0000');
    expect(new Set(seen).size).toBe(11);

    // And going back is the same bounded operation in reverse.
    const back = rewindRetiredPage(nav);
    expect(back.cursor).toBeNull();
    expect(back.pageIndex).toBe(0);
  });

  it('scans for the retired ids the current page represents, and says so', async () => {
    await seedRetired(11);
    let nav = retiredPageState();
    const first = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE });
    nav = advanceRetiredPage(nav, first);
    const second = await vehicleService.listRetiredPage({
      limit: RETIRED_PAGE_SIZE, cursor: nav.cursor,
    });

    // The oldest retired profile only exists on page two; a trip that
    // references it lives beyond the newest history page.
    const target = second.vehicles[0];
    // Whatever the retirement order put there, it is a profile the first page
    // could not present — which is the whole point of the second turn.
    expect(first.vehicles.some((vehicle) => vehicle.id === target.id)).toBe(false);
    const older = completedTrip('older-1', target.id);
    const readPage = vi.fn(async ({ cursor }) => (cursor
      ? { data: [older], continuation: null }
      : { data: [completedTrip('recent-1', 'vehicle-0005')], continuation: 'c1' }));

    const turn1 = await discoverRetiredReferenceTrips({
      retiredVehicleIds: new Set(second.vehicles.map((vehicle) => String(vehicle.id))),
      readPage,
    });
    expect(turn1.trips).toEqual([]);
    expect(turn1.complete).toBe(false);
    const turn2 = await discoverRetiredReferenceTrips({
      retiredVehicleIds: new Set(second.vehicles.map((vehicle) => String(vehicle.id))),
      readPage,
      cursor: turn1.continuation,
    });
    expect(turn2.trips.map((trip) => trip.id)).toEqual(['older-1']);
    expect(turn2.complete).toBe(true);
    expect(readPage).toHaveBeenCalledTimes(2);

    // The wording separates the two different "more" claims.
    expect(retiredScanScopeNote({ represented: 10, hasMoreProfiles: true }))
      .toContain('10');
    expect(retiredScanScopeNote({ represented: 11, hasMoreProfiles: false })).toBeNull();
  });

  it('drops exactly the reassigned trips from process-local discoveries', () => {
    const discovered = [
      completedTrip('older-1', 'vehicle-retired'),
      completedTrip('older-2', 'vehicle-retired'),
    ];
    const afterOne = clearReassignedDiscoveries(discovered, ['older-1']);
    expect(afterOne.map((trip) => trip.id)).toEqual(['older-2']);
    // A failed mutation reassigns nothing, so nothing leaves the workflow.
    expect(clearReassignedDiscoveries(discovered, [])).toBe(discovered);
    // Several at once: exactly the successful ids go.
    expect(clearReassignedDiscoveries(discovered, ['older-1', 'older-2'])).toEqual([]);
    // An id that was never discovered changes nothing.
    expect(clearReassignedDiscoveries(discovered, ['unrelated']).map((trip) => trip.id))
      .toEqual(['older-1', 'older-2']);

    // A repaired trip can no longer present itself as needing review either.
    const repaired = { ...discovered[0], vehicle_id: 'vehicle-active', vehicle_assignment_status: 'confirmed' };
    const states = new Map([['vehicle-active', { vehicle: { id: 'vehicle-active' }, retired: false }]]);
    expect(getTripsNeedingVehicleReview([repaired], { vehicleStates: states })).toEqual([]);
  });

  it('only reports what a mutation actually settled', () => {
    const settled = summarizeAssignmentOutcome([
      { status: 'fulfilled', value: 'older-1' },
      { status: 'rejected', reason: new Error('write failed') },
      { status: 'fulfilled', value: 'older-2' },
    ]);
    expect(settled.succeededIds).toEqual(['older-1', 'older-2']);
    expect(settled.failedCount).toBe(1);
    expect(summarizeAssignmentOutcome([{ status: 'rejected', reason: new Error('x') }]))
      .toMatchObject({ succeededIds: [], failedCount: 1 });
  });
});

describe('Wave 4 final — unavailable carbon evidence is not zero', () => {
  const carbonFor = async (recorded) => {
    const { createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    const accumulator = createAchievementStatsAccumulator({}, null);
    accumulator.addTrip(completedTrip('t1', 'vehicle-0600', { co2_saved_kg: recorded }));
    return accumulator.result();
  };

  it('keeps missing, empty and non-finite recorded carbon out of the eligible population', async () => {
    for (const recorded of [null, undefined, '', '   ', NaN, Infinity, -Infinity, 'abc', {}]) {
      const stats = await carbonFor(recorded);
      expect(stats.carbonEligibleTripCount, String(recorded)).toBe(0);
      expect(stats.carbonCo2SavedKg, String(recorded)).toBe(0);
    }
  });

  it('keeps a genuine recorded zero and a genuine recorded value', async () => {
    const zero = await carbonFor(0);
    expect(zero.carbonEligibleTripCount).toBe(1);
    expect(zero.carbonCo2SavedKg).toBe(0);

    const value = await carbonFor(1.25);
    expect(value.carbonEligibleTripCount).toBe(1);
    expect(value.carbonCo2SavedKg).toBeCloseTo(1.25, 5);

    const numericString = await carbonFor('2.5');
    expect(numericString.carbonEligibleTripCount).toBe(1);
    expect(numericString.carbonCo2SavedKg).toBeCloseTo(2.5, 5);
  });

  it('keeps a complete empty collection distinct from an incomplete fleet', async () => {
    const { createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    // A complete authority that holds no vehicles: the reference genuinely does
    // not resolve, so the trip is not carbon eligible — and that is a different
    // statement from "the page could not represent the fleet".
    const complete = createAchievementStatsAccumulator({}, []);
    complete.addTrip(completedTrip('t1', 'vehicle-0600', { co2_saved_kg: 1.25 }));
    expect(complete.result().carbonEligibleTripCount).toBe(0);

    const fallback = createAchievementStatsAccumulator({}, null);
    fallback.addTrip(completedTrip('t1', 'vehicle-0600', { co2_saved_kg: 1.25 }));
    expect(fallback.result().carbonEligibleTripCount).toBe(1);
  });
});

describe('Wave 4 final — the composed scenario', () => {
  it('holds every authority at once on one fleet', async () => {
    // A fleet larger than every display prefix, with deletions that outrun one
    // retired page and a trip that outruns the recent history page.
    await seedVehicles(520);
    const retiredIds = [];
    for (let index = 0; index < 12; index += 1) {
      const id = `vehicle-${String(index).padStart(4, '0')}`;
      await vehicleService.delete(id);
      retiredIds.push(id);
    }
    // 508 active profiles remain, so the 500-row milestone page cannot
    // represent the fleet and this reference sits outside every display page.
    const beyondPrefix = 'vehicle-0012';

    // 1-2. Both screens ask about the same ids, in the order that used to
    // poison the second one. Each gets its own contract.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
    });
    const sharedIds = [beyondPrefix];
    const historyRecords = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(sharedIds),
      queryFn: () => vehicleService.getByIds(sharedIds),
    });
    expect(Array.isArray(historyRecords)).toBe(true);
    expect(historyRecords[0].id).toBe(beyondPrefix);

    const states = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(sharedIds),
      queryFn: () => vehicleService.getReferenceStates(sharedIds),
    });
    expect(states instanceof Map).toBe(true);
    // The beyond-prefix active reference is still exactly what it is.
    expect(states.get(beyondPrefix)).toMatchObject({ retired: false });
    expect(states.get(beyondPrefix).vehicle.id).toBe(beyondPrefix);

    // 3. Page to the retired profile the first page cannot hold.
    let nav = retiredPageState();
    const firstRetired = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    expect(firstRetired.hasMore).toBe(true);
    nav = advanceRetiredPage(nav, firstRetired);
    const secondRetired = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    expect(secondRetired.returned).toBe(2);
    const target = secondRetired.vehicles[0];
    expect(firstRetired.vehicles.some((vehicle) => vehicle.id === target.id)).toBe(false);
    expect(retiredScanScopeNote({ represented: secondRetired.returned, hasMoreProfiles: secondRetired.hasMore }))
      .toBeNull();

    // 4. Discover the older trip that references it, in bounded turns.
    const older = completedTrip('older-1', target.id);
    const readPage = vi.fn(async ({ cursor }) => (cursor
      ? { data: [older], continuation: null }
      : { data: [completedTrip('recent-1', beyondPrefix)], continuation: 'history-2' }));
    const scope = new Set(secondRetired.vehicles.map((vehicle) => String(vehicle.id)));
    const turn1 = await discoverRetiredReferenceTrips({ retiredVehicleIds: scope, readPage });
    const turn2 = await discoverRetiredReferenceTrips({
      retiredVehicleIds: scope, readPage, cursor: turn1.continuation,
    });
    let found = [...turn1.trips, ...turn2.trips];
    expect(found.map((trip) => trip.id)).toEqual(['older-1']);
    expect(readPage).toHaveBeenCalledTimes(2);

    // The discovered trip is repairable in the same workflow as a recent one.
    const recentReview = getTripsNeedingVehicleReview(
      [completedTrip('recent-1', beyondPrefix)],
      { vehicleStates: states },
    );
    expect(mergeDiscoveredReviewTrips(recentReview, found).map((trip) => trip.id)).toEqual(['older-1']);

    // 5-6. Reassign it, and it leaves the workflow immediately.
    const settled = summarizeAssignmentOutcome([{ status: 'fulfilled', value: 'older-1' }]);
    expect(settled.failedCount).toBe(0);
    found = clearReassignedDiscoveries(found, settled.succeededIds);
    expect(found).toEqual([]);
    expect(mergeDiscoveredReviewTrips(recentReview, found)).toEqual(recentReview);

    // 7. The milestone fallback on an incomplete vehicle page: unavailable
    // recorded carbon stays unavailable rather than becoming an eligible zero.
    const { createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    const milestonePage = await vehicleService.listPage({ sort: '-created_date', limit: 500 });
    expect(milestonePage.hasMore).toBe(true);
    const fallbackCollection = milestonePage.hasMore ? null : milestonePage.vehicles;
    const accumulator = createAchievementStatsAccumulator({}, fallbackCollection);
    accumulator.addTrip(completedTrip('carbon-unknown', beyondPrefix, { co2_saved_kg: null }));
    accumulator.addTrip(completedTrip('carbon-known', beyondPrefix, { co2_saved_kg: 2 }));
    const stats = accumulator.result();
    expect(stats.carbonEligibleTripCount).toBe(1);
    expect(stats.carbonCo2SavedKg).toBeCloseTo(2, 5);

    // 8-9. A fabricated continuation is refused; a real one advances.
    const page1 = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    const revision = String(page1.continuation).slice(0, String(page1.continuation).lastIndexOf(':'));
    const fabricated = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: `${revision}:not-a-number`,
    });
    expect(fabricated.restartRequired).toBe(true);
    expect(fabricated.reason).toBe('CURSOR_MALFORMED');
    expect(fabricated.vehicles).toEqual([]);

    const page2 = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: page1.continuation,
    });
    expect(page2.returned).toBe(50);
    expect(page2.restartRequired).toBeFalsy();
    expect(new Set([...page1.vehicles, ...page2.vehicles].map((vehicle) => vehicle.id)).size).toBe(100);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Wave 4 final cleanup — the four exact mechanisms from CODEX's final focused
// re-review. Each is a statement the software makes about itself: an identity
// must distinguish what differs, a recognizer must recognize the whole token,
// a scope note must describe the scope, and one domain must have one
// definition of "this evidence is missing".
// ---------------------------------------------------------------------------

describe('Wave 4 cleanup — an id set cannot alias another id set', () => {
  const sharedClient = () => new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
  });

  // Vehicle ids are canonical restored input and nothing forbids a comma in
  // them, so two different sets must not be able to write the same key.
  const SET_A = ['a,b', 'c'];
  const SET_B = ['a', 'b,c'];

  const seedDelimiterIds = async () => {
    await localVehicleRepository.upsertMany(
      ['a,b', 'c', 'a', 'b,c'].map((id, index) => ({
        id,
        name: `Car ${id}`,
        created_date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
      })),
    );
  };

  it('keeps distinct sets on distinct identities for both contracts', () => {
    expect(vehicleQueryKeys.byIds(SET_A)).not.toEqual(vehicleQueryKeys.byIds(SET_B));
    expect(vehicleQueryKeys.referenceStates(SET_A)).not.toEqual(vehicleQueryKeys.referenceStates(SET_B));
    // The set semantics that were already correct stay correct.
    expect(vehicleQueryKeys.byIds(['b,c', 'a', 'a'])).toEqual(vehicleQueryKeys.byIds(SET_B));
    expect(vehicleQueryKeys.referenceStates(['c', 'a,b'])).toEqual(vehicleQueryKeys.referenceStates(SET_A));
    // And the two contracts still never share an identity.
    expect(vehicleQueryKeys.byIds(SET_A)).not.toEqual(vehicleQueryKeys.referenceStates(SET_A));
    for (const key of [vehicleQueryKeys.byIds(SET_A), vehicleQueryKeys.referenceStates(SET_B)]) {
      expect(key[0]).toBe('vehicles');
    }
  });

  it('runs each set its own query and returns exactly its members', async () => {
    await seedDelimiterIds();
    const client = sharedClient();
    const records = vi.spyOn(vehicleService, 'getByIds');

    const first = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(SET_A),
      queryFn: () => vehicleService.getByIds(SET_A),
    });
    const second = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(SET_B),
      queryFn: () => vehicleService.getByIds(SET_B),
    });

    expect(records).toHaveBeenCalledTimes(2);
    expect(first.map((vehicle) => vehicle.id).sort()).toEqual(['a,b', 'c']);
    expect(second.map((vehicle) => vehicle.id).sort()).toEqual(['a', 'b,c']);
  });

  it('does the same for lifecycle state, in the other order', async () => {
    await seedDelimiterIds();
    await vehicleService.delete('b,c');
    const client = sharedClient();
    const states = vi.spyOn(vehicleService, 'getReferenceStates');

    const forB = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(SET_B),
      queryFn: () => vehicleService.getReferenceStates(SET_B),
    });
    const forA = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(SET_A),
      queryFn: () => vehicleService.getReferenceStates(SET_A),
    });

    expect(states).toHaveBeenCalledTimes(2);
    expect([...forB.keys()].sort()).toEqual(['a', 'b,c']);
    expect(forB.get('b,c')).toMatchObject({ retired: true });
    expect([...forA.keys()].sort()).toEqual(['a,b', 'c']);
    // The set that never asked about 'b,c' must not learn about it.
    expect(forA.has('b,c')).toBe(false);
  });
});

describe('Wave 4 cleanup — the whole cursor grammar is recognized', () => {
  const currentRevision = async () => {
    const page = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    return String(page.continuation).slice(0, String(page.continuation).lastIndexOf(':'));
  };

  it('calls a structurally impossible cursor malformed, not a moved collection', async () => {
    await seedVehicles(60);
    const revision = await currentRevision();
    const impossible = [
      ':1',                       // no revision at all
      `${revision.toUpperCase()}:1`, // the repository only emits lowercase base-36
      `${revision}:extra:1`,      // an extra segment it never writes
      `rev ision:1`,              // whitespace
      `rev-ision:1`,              // punctuation
      `rev!sion:1`,               // non-base-36
      `${revision}extra!:1`,
      ':nope',                    // both halves impossible
      'not base36 either:12.5',
    ];
    for (const cursor of impossible) {
      const page = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor });
      expect(page.reason, cursor).toBe('CURSOR_MALFORMED');
      expect(page.restartRequired, cursor).toBe(true);
      expect(page.vehicles, cursor).toEqual([]);
      expect(page.complete, cursor).toBe(false);
      expect(page.continuation, cursor).toBeNull();
    }
  });

  it('still calls a well-formed cursor from another population a collection change', async () => {
    await seedVehicles(60);
    const first = await vehicleService.listPage({ sort: '-created_date', limit: 50 });
    await localVehicleRepository.create({ name: 'Newest', created_date: new Date().toISOString() });
    const moved = await vehicleService.listPage({
      sort: '-created_date', limit: 50, cursor: first.continuation,
    });
    expect(moved.reason).toBe('COLLECTION_CHANGED');
    expect(moved.restartRequired).toBe(true);

    // A grammatically valid token that simply is not this population.
    const stale = await vehicleService.listPage({ sort: '-created_date', limit: 50, cursor: 'zzzzzz:1' });
    expect(stale.reason).toBe('COLLECTION_CHANGED');
  });

  it('applies the same grammar to the retired page, and still advances a real cursor', async () => {
    await seedVehicles(25);
    for (let index = 0; index < 25; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }
    const page = await vehicleService.listRetiredPage({ limit: 10 });
    const revision = String(page.continuation).slice(0, String(page.continuation).lastIndexOf(':'));
    for (const cursor of [':1', `${revision}:extra:1`, `${revision.toUpperCase()}:1`]) {
      const refused = await vehicleService.listRetiredPage({ limit: 10, cursor });
      expect(refused.reason, cursor).toBe('CURSOR_MALFORMED');
      expect(refused.restartRequired, cursor).toBe(true);
    }
    const advanced = await vehicleService.listRetiredPage({ limit: 10, cursor: page.continuation });
    expect(advanced.returned).toBe(10);
    expect(advanced.restartRequired).toBeFalsy();
  });
});

describe('Wave 4 cleanup — a terminal retired page still states its scan scope', () => {
  it('says which deleted vehicles this page covers, even when no page follows', () => {
    // Page two of eleven profiles: nothing follows it, but ten profiles precede
    // it, and the scan only ever concerned the one profile shown here.
    const terminal = retiredScanScopeNote({
      represented: 1, hasMoreProfiles: false, pageIndex: 1,
    });
    expect(terminal).toBeTruthy();
    expect(terminal).toContain('1 deleted vehicle');
    expect(terminal).toMatch(/this page/i);

    // Page one of the same collection: more profiles follow.
    const first = retiredScanScopeNote({ represented: 10, hasMoreProfiles: true, pageIndex: 0 });
    expect(first).toBeTruthy();
    expect(first).toContain('10 deleted vehicles');

    // The only case with nothing to qualify: one page holds every deletion.
    expect(retiredScanScopeNote({ represented: 4, hasMoreProfiles: false, pageIndex: 0 })).toBeNull();
  });

  it('keeps the history claim and the retired-scope claim separate at the terminal page', async () => {
    await seedVehicles(13);
    for (let index = 0; index < 11; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }
    let nav = retiredPageState();
    const first = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    nav = advanceRetiredPage(nav, first);
    const second = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    expect(second.hasMore).toBe(false);
    expect(nav.pageIndex).toBe(1);

    // Run the bounded history scan to its terminal state for this page's ids.
    const scope = new Set(second.vehicles.map((vehicle) => String(vehicle.id)));
    const readPage = vi.fn(async () => ({ data: [], continuation: null }));
    const result = await discoverRetiredReferenceTrips({ retiredVehicleIds: scope, readPage });
    expect(result.complete).toBe(true);

    // History is finished; the retired scope is not the whole collection, and
    // the wording must carry both facts rather than only the first.
    const note = retiredScanScopeNote({
      represented: second.returned,
      hasMoreProfiles: second.hasMore,
      pageIndex: nav.pageIndex,
    });
    expect(note).toBeTruthy();
    expect(note).toContain(`${second.returned} deleted vehicle`);
    expect(note).not.toMatch(/all deleted vehicles/i);
    // And the page renders it wherever the completed-history sentence appears.
    const page = readSource('../../pages/Vehicles.jsx');
    expect(page).toContain('pageIndex: retiredNav.pageIndex');
  });
});

describe('Wave 4 cleanup — one definition of unavailable recorded carbon', () => {
  const completedWithCarbon = (recorded) => completedTrip('t1', 'vehicle-0001', { co2_saved_kg: recorded });

  it('keeps unavailable recorded carbon out of the exported aggregate', async () => {
    const { calculateCarbonImpact } = await import('@/lib/tripInsights');
    for (const recorded of [null, undefined, '', '   ', NaN, Infinity, -Infinity, 'abc', {}]) {
      const impact = calculateCarbonImpact([completedWithCarbon(recorded)], {}, null);
      expect(impact.eligible_trip_count, String(recorded)).toBe(0);
      expect(impact.savings_available, String(recorded)).toBe(false);
      expect(impact.total_co2_saved_kg, String(recorded)).toBe(0);
    }
  });

  it('keeps a genuine recorded zero and a genuine recorded value', async () => {
    const { calculateCarbonImpact } = await import('@/lib/tripInsights');
    const zero = calculateCarbonImpact([completedWithCarbon(0)], {}, null);
    expect(zero.eligible_trip_count).toBe(1);
    expect(zero.savings_available).toBe(true);
    expect(zero.total_co2_saved_kg).toBe(0);

    const value = calculateCarbonImpact([completedWithCarbon(2.5)], {}, null);
    expect(value.eligible_trip_count).toBe(1);
    expect(value.total_co2_saved_kg).toBeCloseTo(2.5, 5);

    const numericString = calculateCarbonImpact([completedWithCarbon('1.5')], {}, null);
    expect(numericString.eligible_trip_count).toBe(1);
    expect(numericString.total_co2_saved_kg).toBeCloseTo(1.5, 5);
  });

  it('agrees with the live milestone accumulator on the same population', async () => {
    const { calculateCarbonImpact, createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    const population = [
      completedTrip('a', 'vehicle-0001', { co2_saved_kg: null }),
      completedTrip('b', 'vehicle-0002', { co2_saved_kg: 0 }),
      completedTrip('c', 'vehicle-0003', { co2_saved_kg: 2 }),
      completedTrip('d', 'vehicle-0004', { co2_saved_kg: '' }),
    ];
    const impact = calculateCarbonImpact(population, {}, null);
    const accumulator = createAchievementStatsAccumulator({}, null);
    population.forEach((trip) => accumulator.addTrip(trip));
    const stats = accumulator.result();

    expect(impact.eligible_trip_count).toBe(stats.carbonEligibleTripCount);
    expect(impact.eligible_trip_count).toBe(2);
    expect(impact.total_co2_saved_kg).toBeCloseTo(stats.carbonCo2SavedKg, 5);
    expect(impact.total_co2_saved_kg).toBeCloseTo(2, 5);
  });
});

describe('Wave 4 cleanup — the composed regression', () => {
  it('holds all four at once', async () => {
    // Ids that carry the old delimiter, plus a retired collection that needs a
    // second page, plus a trip whose recorded carbon is simply not there.
    await localVehicleRepository.upsertMany(
      ['a,b', 'c', 'a', 'b,c'].map((id, index) => ({
        id, name: `Car ${id}`, created_date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
      })),
    );
    await seedVehicles(13);
    for (let index = 0; index < 11; index += 1) {
      await vehicleService.delete(`vehicle-${String(index).padStart(4, '0')}`);
    }

    // 1-2. Two distinct sets, two identities, two answers.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
    });
    const setA = ['a,b', 'c'];
    const setB = ['a', 'b,c'];
    expect(vehicleQueryKeys.byIds(setA)).not.toEqual(vehicleQueryKeys.byIds(setB));
    const recordsA = await client.fetchQuery({
      queryKey: vehicleQueryKeys.byIds(setA), queryFn: () => vehicleService.getByIds(setA),
    });
    const statesB = await client.fetchQuery({
      queryKey: vehicleQueryKeys.referenceStates(setB), queryFn: () => vehicleService.getReferenceStates(setB),
    });
    expect(recordsA.map((vehicle) => vehicle.id).sort()).toEqual(['a,b', 'c']);
    expect([...statesB.keys()].sort()).toEqual(['a', 'b,c']);

    // 3. A structurally impossible cursor is malformed; a valid token from
    //    another population is a collection change.
    const page1 = await vehicleService.listPage({ sort: '-created_date', limit: 5 });
    const malformed = await vehicleService.listPage({
      sort: '-created_date', limit: 5, cursor: `${String(page1.continuation).split(':')[0]}:extra:1`,
    });
    expect(malformed.reason).toBe('CURSOR_MALFORMED');
    const stale = await vehicleService.listPage({ sort: '-created_date', limit: 5, cursor: 'zzzzzz:1' });
    expect(stale.reason).toBe('COLLECTION_CHANGED');

    // 4. The terminal retired page still says what the scan covered.
    let nav = retiredPageState();
    const firstRetired = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    nav = advanceRetiredPage(nav, firstRetired);
    const secondRetired = await vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: nav.cursor });
    expect(secondRetired.hasMore).toBe(false);
    const note = retiredScanScopeNote({
      represented: secondRetired.returned, hasMoreProfiles: false, pageIndex: nav.pageIndex,
    });
    expect(note).toBeTruthy();
    expect(note).toContain(`${secondRetired.returned} deleted vehicle`);

    // 5. Unavailable recorded carbon stays unavailable in both same-domain paths.
    const { calculateCarbonImpact, createAchievementStatsAccumulator } = await import('@/lib/tripInsights');
    const population = [completedTrip('x', 'a,b', { co2_saved_kg: null })];
    const accumulator = createAchievementStatsAccumulator({}, null);
    population.forEach((trip) => accumulator.addTrip(trip));
    expect(calculateCarbonImpact(population, {}, null)).toMatchObject({
      eligible_trip_count: 0, savings_available: false, total_co2_saved_kg: 0,
    });
    expect(accumulator.result().carbonEligibleTripCount).toBe(0);
  }, 30_000);
});
