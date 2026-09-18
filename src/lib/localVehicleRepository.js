import { getJson, setJson } from '@/lib/mobileStorage';
import { DEFAULT_EV_KWH_PER_100KM } from '@/lib/tripEconomyDefaults';
import {
  normalizeMaintenanceItems,
  normalizePowertrain,
  VEHICLE_MAINTENANCE_SCHEMA_VERSION,
} from '@/lib/vehicleMaintenance';

export const VEHICLES_KEY = 'drivesense_vehicles';
/** One bounded export turn, and the ceiling that keeps a corrupt cursor finite. */
const EXPORT_PAGE_SIZE = 200;
const EXPORT_MAX_TURNS = 5_000;
const LEGACY_VEHICLE_ADMIN_FIELDS = ['plate', 'registration_renewal_date', 'insurance_renewal_date'];

const scrubLegacyVehicleAdminFields = (vehicle = {}) => {
  const next = { ...vehicle };
  let changed = false;
  LEGACY_VEHICLE_ADMIN_FIELDS.forEach((field) => {
    if (field in next) {
      delete next[field];
      changed = true;
    }
  });
  return { vehicle: next, changed };
};

const normalizeScheduleSource = (source = {}) => ({
  title: String(source.title || '').trim(),
  url: String(source.url || '').trim(),
  page: String(source.page || '').trim(),
  reviewed_at: String(source.reviewed_at || '').trim(),
});

const normalizeServiceHistory = (history = []) => (Array.isArray(history) ? history : [])
  .filter((event) => event && typeof event === 'object')
  .slice(0, 250)
  .map((event) => ({
    id: String(event.id || 'service_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    item_ids: Array.isArray(event.item_ids) ? event.item_ids.map(String) : [],
    label: String(event.label || 'Maintenance service').trim(),
    serviced_at: String(event.serviced_at || '').slice(0, 10),
    odometer_km: Math.max(0, Number(event.odometer_km) || 0),
    notes: String(event.notes || '').trim(),
    recorded_at: event.recorded_at || new Date().toISOString(),
    source: String(event.source || 'owner_recorded'),
  }));


const normalizeVehicle = (vehicle, { touch = true } = {}) => {
  const powertrain = normalizePowertrain(vehicle.powertrain || vehicle.fuel_type);
  const profile = {
    ...vehicle,
    market: String(vehicle.market || 'CA').trim().toUpperCase(),
    trim: String(vehicle.trim || '').trim(),
    engine: String(vehicle.engine || '').trim(),
    drivetrain: String(vehicle.drivetrain || '').trim(),
    transmission: String(vehicle.transmission || '').trim(),
    powertrain,
  };
  return {
    id: vehicle.id || `vehicle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(vehicle.name || '').trim(),
    make: String(vehicle.make || '').trim(),
    model: String(vehicle.model || '').trim(),
    trim: profile.trim,
    year: vehicle.year ? Number(vehicle.year) : '',
    market: profile.market,
    engine: profile.engine,
    drivetrain: profile.drivetrain,
    transmission: profile.transmission,
    powertrain,
    fuel_type: powertrain,
    use_profile: String(vehicle.use_profile || 'normal').trim(),
    in_service_date: String(vehicle.in_service_date || '').slice(0, 10),
    maintenance_monitor: String(vehicle.maintenance_monitor || 'none').trim(),
    color: vehicle.color || '#3b82f6',
    odometer_km: Number(vehicle.odometer_km) || 0,
    odometer_trip_distance_anchor_km: Number(vehicle.odometer_trip_distance_anchor_km) || 0,
    auto_odometer_last_sync_at: vehicle.auto_odometer_last_sync_at || null,
    fuel_efficiency_l_per_100km: Number(vehicle.fuel_efficiency_l_per_100km) || 8.5,
    ev_efficiency_kwh_per_100km: Number(vehicle.ev_efficiency_kwh_per_100km) || DEFAULT_EV_KWH_PER_100KM,
    fuel_price_per_liter: Number(vehicle.fuel_price_per_liter) || 1.65,
    maintenance_reserve_per_km: Number(vehicle.maintenance_reserve_per_km) || 0.08,
    schedule_source: normalizeScheduleSource(vehicle.schedule_source),
    maintenance_items: normalizeMaintenanceItems(profile),
    service_history: normalizeServiceHistory(vehicle.service_history),
    maintenance_schema_version: VEHICLE_MAINTENANCE_SCHEMA_VERSION,
    is_default: Boolean(vehicle.is_default),
    // HPR-010. A retired profile keeps its identity so historical trips still
    // resolve to something truthful; `null` is an ordinary active vehicle.
    retired_at: vehicle.retired_at || null,
    created_date: vehicle.created_date || vehicle.created_at || new Date().toISOString(),
    updated_at: touch ? new Date().toISOString() : (vehicle.updated_at || new Date().toISOString()),
  };
};

const sortVehicles = (vehicles, sort) => {
  const field = sort?.replace('-', '') || 'created_date';
  const dir = sort?.startsWith('-') ? -1 : 1;
  return [...vehicles].sort((a, b) => {
    const av = a[field] || '';
    const bv = b[field] || '';
    return av > bv ? dir : av < bv ? -dir : 0;
  });
};

const isRetired = (vehicle) => Boolean(vehicle?.retired_at);

const ensureOneDefault = (vehicles) => {
  if (!vehicles.length) return [];
  const active = vehicles.filter((vehicle) => !isRetired(vehicle));
  if (!active.length) return vehicles.map((vehicle) => ({ ...vehicle, is_default: false }));
  if (active.some((vehicle) => vehicle.is_default)) return vehicles;
  // A retired profile can never hold the default slot; the first active one is
  // promoted exactly as before.
  const promote = active[0];
  return vehicles.map((vehicle) => ({ ...vehicle, is_default: vehicle === promote }));
};

const readVehicles = async () => {
  const stored = await getJson(VEHICLES_KEY, []);
  let changed = false;
  const scrubbed = (Array.isArray(stored) ? stored : []).map((vehicle) => {
    const result = scrubLegacyVehicleAdminFields(vehicle);
    changed = changed || result.changed;
    const normalized = normalizeVehicle(result.vehicle, { touch: false });
    if (JSON.stringify(normalized) !== JSON.stringify(result.vehicle)) changed = true;
    return normalized;
  });
  const vehicles = ensureOneDefault(scrubbed);
  if (changed) await setJson(VEHICLES_KEY, vehicles);
  return vehicles;
};

const writeVehicles = async (vehicles) => {
  const normalized = ensureOneDefault(vehicles.map((vehicle) => scrubLegacyVehicleAdminFields(vehicle).vehicle));
  await setJson(VEHICLES_KEY, normalized);
  import('@/lib/p6TripDerivedState')
    .then(({ invalidateP6AnalyticsForSettings }) => invalidateP6AnalyticsForSettings('VEHICLES_CHANGED'))
    .catch(() => {});
  return normalized;
};

const activeVehicles = (vehicles) => vehicles.filter((vehicle) => !isRetired(vehicle));

/**
 * A revision for the sorted population a cursor was issued against.
 *
 * An offset alone changes meaning the moment the collection does: inserting a
 * sort-leading vehicle shifts every later row, so a continuation issued before
 * that insert silently skips one and repeats another. The revision folds the
 * identity and sort position of the rows the page actually described, so a
 * stale continuation is *detected* rather than quietly honoured. It is derived
 * from the same prepared collection the page already built — no extra read, and
 * no process-local state, so it survives reload exactly as the blob does.
 */
const revisionOf = (sorted, sort) => {
  let hash = 2166136261;
  const fold = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 59;
    hash = Math.imul(hash, 16777619);
  };
  fold(String(sort || ''));
  fold(String(sorted.length));
  const field = String(sort || 'created_date').replace('-', '');
  for (const vehicle of sorted) {
    fold(String(vehicle?.id ?? ''));
    fold(String(vehicle?.[field] ?? ''));
  }
  return (hash >>> 0).toString(36);
};

const encodeCursor = (revision, offset) => `${revision}:${offset}`;

/**
 * The exact offsets this repository can issue: a continuation is written only
 * when a page consumed at least one row and left at least one behind, so the
 * issued domain is the plain decimal integers `1 .. population - 1`.
 *
 * Decoding is therefore a **recognizer**, not a coercion. `Number(x) || 0` read
 * `not-a-number`, `-5`, `12.5` and `Infinity` as "start from the beginning",
 * which let a fabricated cursor replay page zero, and an oversized offset
 * sliced nothing and read as an authoritative end of collection. A cursor the
 * repository did not write is not a position; it is malformed.
 */
/**
 * The complete grammar `encodeCursor` emits: one lowercase base-36 revision
 * token (what `revisionOf` returns), one colon, one issued offset.
 *
 * Recognizing only the offset was half a recognizer. A token this repository
 * cannot have written — an empty revision, an uppercase one, an extra segment,
 * anything outside base-36 — is structurally impossible, not a position in some
 * other population, and calling it `COLLECTION_CHANGED` told the caller its
 * cursor had been overtaken when in truth it was never issued. Structure is
 * decided first; only a well-formed cursor is compared against the revision it
 * claims.
 */
const ISSUED_CURSOR = /^([0-9a-z]+):([1-9][0-9]*)$/;

const decodeCursor = (cursor) => {
  if (cursor == null || cursor === '') return { revision: null, offset: 0 };
  const match = ISSUED_CURSOR.exec(String(cursor));
  if (!match) return { revision: null, offset: 0, malformed: true };
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) return { revision: match[1], offset: 0, malformed: true };
  return { revision: match[1], offset };
};

const restartPage = (reason) => ({
  vehicles: [],
  returned: 0,
  hasMore: false,
  complete: false,
  continuation: null,
  restartRequired: true,
  reason,
});

/** The bounded page of an already prepared, already sorted collection. */
const pageOfSorted = (sorted, { sort = '-created_date', limit = 50, cursor = null } = {}) => {
  const size = Math.max(1, Math.floor(Number(limit) || 50));
  const revision = revisionOf(sorted, sort);
  const requested = decodeCursor(cursor);
  if (cursor != null && cursor !== '') {
    if (requested.malformed) return restartPage('CURSOR_MALFORMED');
    // A genuine population change keeps its own answer: the caller's position
    // was real, the collection moved under it.
    if (requested.revision !== revision) return restartPage('COLLECTION_CHANGED');
    // Same population, so the offset must be one this collection could have
    // issued. `>= length` is not "the end" — the end is only ever reached by
    // paging to a terminal answer, never asserted by an incoming cursor.
    if (requested.offset >= sorted.length) return restartPage('CURSOR_MALFORMED');
  }
  const offset = requested.offset;
  const vehicles = sorted.slice(offset, offset + size);
  const consumed = offset + vehicles.length;
  const hasMore = consumed < sorted.length;
  return {
    vehicles,
    returned: vehicles.length,
    hasMore,
    complete: !hasMore,
    continuation: hasMore ? encodeCursor(revision, consumed) : null,
    revision,
  };
};

export const localVehicleRepository = {
  /**
   * The bounded prefix, unchanged for callers that legitimately want one.
   * Retired profiles are not part of the active collection.
   */
  async list({ sort = '-created_date', limit = 50, includeRetired = false } = {}) {
    const page = await this.listPage({ sort, limit, includeRetired });
    return page.vehicles;
  },

  /**
   * HPR-003. The same bounded read, but it says what it represents.
   *
   * `hasMore` is answered by the collection itself rather than guessed from
   * `rows.length === limit`, so a fleet of exactly `limit` vehicles is reported
   * complete and a fleet of `limit + 1` is not. The continuation is an offset
   * into the same sorted collection; the next turn is the same bounded size.
   */
  async listPage({ sort = '-created_date', limit = 50, cursor = null, includeRetired = false } = {}) {
    // A caller that *resolves a reference* (scoring, economics, derived analytics)
    // asks for retired profiles too, so a historical trip keeps resolving to the
    // vehicle it was actually driven in. A caller that *lists the fleet* does not.
    const all = await readVehicles();
    const sorted = sortVehicles(includeRetired ? all : activeVehicles(all), sort);
    return pageOfSorted(sorted, { sort, limit, cursor });
  },

  /**
   * One prepared, sorted view of the collection plus the revision it belongs to.
   *
   * An operation that must cover the whole fleet takes this once and then walks
   * it, instead of re-reading, re-normalizing and re-sorting the entire blob for
   * every output page.
   */
  async openCollectionSnapshot({ sort = '-created_date', includeRetired = false } = {}) {
    const all = await readVehicles();
    const rows = sortVehicles(includeRetired ? all : activeVehicles(all), sort);
    return { sort, rows, revision: revisionOf(rows, sort), includeRetired };
  },

  /**
   * HPR-010's load-bearing authority: reference existence is resolved by id.
   *
   * Absence from a capped page proves nothing about a vehicle, so nothing in
   * the app may infer deletion that way. This answers for active and retired
   * profiles alike and returns `null` only when the id was never stored.
   */
  async getById(id) {
    if (id == null || id === '') return null;
    const vehicles = await readVehicles();
    const found = vehicles.find((vehicle) => String(vehicle.id) === String(id));
    if (!found) return null;
    return { vehicle: found, retired: isRetired(found) };
  },

  /**
   * Resolve a bounded set of references in ONE collection read.
   *
   * Reference-sensitive work (economics, scoring, derived analytics, labels)
   * asks only about the ids its rows actually mention, and gets a complete
   * answer for each — never a prefix, and never one blob read per id.
   */
  async getByIds(ids = [], { includeRetired = true } = {}) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : [])
      .filter((id) => id != null && id !== '')
      .map(String))];
    if (!wanted.length) return [];
    const vehicles = await readVehicles();
    const byId = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
    return wanted
      .map((id) => byId.get(id))
      .filter((vehicle) => vehicle && (includeRetired || !isRetired(vehicle)));
  },

  /**
   * The lifecycle state of a bounded set of references.
   *
   * Classification (is this reference retired?) is answered per id from the
   * authority, so no surface needs a global retired-id set to judge the rows it
   * happens to hold.
   */
  async getReferenceStates(ids = []) {
    const resolved = await this.getByIds(ids);
    const states = new Map();
    for (const vehicle of resolved) {
      states.set(String(vehicle.id), { vehicle, retired: isRetired(vehicle) });
    }
    for (const id of (Array.isArray(ids) ? ids : []).filter(Boolean).map(String)) {
      if (!states.has(id)) states.set(id, { vehicle: null, retired: false, unknown: true });
    }
    return states;
  },

  /**
   * The durable default, from the complete collection.
   *
   * `page.find(is_default) || page[0]` answered with whatever the display page
   * happened to contain, so a default outside the newest rows was replaced by a
   * visible stranger. A retired profile can never win here.
   */
  async getDefault() {
    const active = activeVehicles(await readVehicles());
    return active.find((vehicle) => vehicle.is_default) || active[0] || null;
  },

  /** Every record, unsorted, for callers that must resolve any reference. */
  async getAllForReference() {
    return readVehicles();
  },

  /** Retired profiles only: bounded by deletions, never by fleet size. */
  async listRetired() {
    const vehicles = await readVehicles();
    return sortVehicles(vehicles.filter(isRetired), '-retired_at');
  },

  /** One bounded page of retired profiles, with its own completeness. */
  async listRetiredPage({ limit = 10, cursor = null } = {}) {
    const vehicles = await readVehicles();
    return pageOfSorted(sortVehicles(vehicles.filter(isRetired), '-retired_at'), {
      sort: '-retired_at',
      limit,
      cursor,
    });
  },

  /**
   * The complete population a backup or portability artifact must carry:
   * every active vehicle and every retired identity, in one snapshot, so a
   * historical `vehicle_id` still resolves after a restore.
   */
  async snapshotForBackup() {
    const snapshot = await this.openCollectionSnapshot({ includeRetired: true });
    return snapshot.rows;
  },

  /**
   * The whole active fleet, read as bounded turns.
   *
   * An export that claims to be complete may not stop at a silent cap; paging
   * to the terminal continuation keeps each turn the same size while the number
   * of turns grows with the fleet.
   */
  async listAllVehiclesForExport({
    sort = '-created_date',
    pageSize = EXPORT_PAGE_SIZE,
    maxTurns = EXPORT_MAX_TURNS,
    snapshot = null,
    includeRetired = false,
  } = {}) {
    // One preparation, then bounded turns over it. The previous shape re-read,
    // re-normalized and re-sorted the whole blob for every page, so a complete
    // export cost ceil(V/pageSize) full preparations.
    const prepared = snapshot || await this.openCollectionSnapshot({ sort, includeRetired });
    const all = [];
    let cursor = null;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const page = pageOfSorted(prepared.rows, { sort: prepared.sort, limit: pageSize, cursor });
      all.push(...page.vehicles);
      if (!page.continuation) return all;
      cursor = page.continuation;
    }
    // A ceiling that returned what it had would be a silent partial export
    // wearing the word "complete". The caller is told instead.
    const error = new Error(
      `Vehicle export is incomplete: stopped after ${maxTurns} turns with ${all.length} of ${prepared.rows.length} vehicles read.`
    );
    error.code = 'VEHICLE_EXPORT_OVERFLOW';
    error.returned = all.length;
    error.total = prepared.rows.length;
    throw error;
  },

  async create(vehicle) {
    const current = await readVehicles();
    const saved = normalizeVehicle({
      ...vehicle,
      is_default: current.length === 0 || vehicle.is_default === true,
    });
    const next = saved.is_default
      ? current.map((item) => ({ ...item, is_default: false }))
      : current;
    await writeVehicles([saved, ...next]);
    return saved;
  },

  async update(id, patch) {
    const current = await readVehicles();
    const existing = current.find((vehicle) => String(vehicle.id) === String(id));
    if (!existing) throw new Error('Vehicle not found');

    const updated = normalizeVehicle({
      ...existing,
      ...patch,
      id: existing.id,
      created_date: existing.created_date,
      updated_at: new Date().toISOString(),
    });
    const next = current.map((vehicle) => {
      if (String(vehicle.id) === String(id)) return updated;
      if (updated.is_default) return { ...vehicle, is_default: false };
      return vehicle;
    });

    await writeVehicles(next);
    return updated;
  },

  /**
   * HPR-010. Deleting a profile retires its identity instead of erasing it.
   *
   * Historical trips keep their `vehicle_id`, and that reference now resolves to
   * an explicitly retired record rather than to nothing — no trip is read,
   * rewritten or scanned, so the foreground cost is one bounded collection write
   * whether the user has ten trips or a million.
   */
  async delete(id) {
    const current = await readVehicles();
    const existing = current.find((vehicle) => String(vehicle.id) === String(id));
    if (!existing) return { success: true, retired: false };
    if (isRetired(existing)) return { success: true, retired: true, vehicle: existing };
    const retired = {
      ...existing,
      is_default: false,
      retired_at: new Date().toISOString(),
    };
    await writeVehicles(current.map((vehicle) => (
      String(vehicle.id) === String(id) ? retired : vehicle
    )));
    return { success: true, retired: true, vehicle: retired };
  },

  async upsertMany(vehicles = []) {
    const current = await readVehicles();
    const incoming = vehicles.filter((vehicle) => vehicle?.name).map(normalizeVehicle);
    const incomingIds = new Set(incoming.map((vehicle) => String(vehicle.id)));
    const merged = [
      ...incoming,
      ...current.filter((vehicle) => !incomingIds.has(String(vehicle.id))),
    ];
    await writeVehicles(merged);
    return incoming;
  },
};
