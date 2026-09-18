import { API_BASE_URL, apiClient } from "@/api/client";
import { localVehicleRepository } from "@/lib/localVehicleRepository";
import { isNativePlatform } from "@/lib/nativePlatform";

export const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

const repository = () => (shouldUseLocalStore() ? localVehicleRepository : null);

/**
 * The one vehicle cache family (HPR-003).
 *
 * A page key carries the parameters that decide which vehicles come back, so a
 * 50-row surface and a 100-row surface can never answer for each other, and a
 * continuation is its own entry. Id-addressed lookups live in a separate family
 * because reference existence is a different question from collection prefix.
 */
/**
 * Ids as a set: order and repetition are not part of the question.
 *
 * The sorted **array** is the key segment, not a joined string. A delimiter
 * join is lossy whenever the delimiter can occur inside an id, and nothing in
 * vehicle normalization, upsert or backup restore forbids a comma in one — so
 * `['a,b', 'c']` and `['a', 'b,c']` are two different questions that produced
 * one cache identity. React Query hashes keys structurally, so an array segment
 * distinguishes them without forbidding an id the product actually accepts.
 */
const normalizeIdSet = (ids = []) => (
  [...new Set((ids || []).filter(Boolean).map(String))].sort()
);

export const vehicleQueryKeys = {
  all: ['vehicles'],
  page: ({ sort = "-created_date", limit = 50, cursor = null } = {}) => (
    ['vehicles', 'page', sort, Number(limit) || 50, cursor ?? 'start']
  ),
  retired: ['vehicles', 'retired'],
  retiredPage: ({ limit = 10, cursor = null } = {}) => (
    ['vehicles', 'retired', 'page', Number(limit) || 10, cursor ?? 'start']
  ),
  byId: (id) => ['vehicles', 'by-id', String(id ?? '')],
  /**
   * Vehicle **records** for a bounded id set.
   *
   * The id set is normalized to a canonical sorted string, so the same request
   * written in two orders is one cache entry.
   */
  byIds: (ids = []) => ['vehicles', 'by-ids', normalizeIdSet(ids)],
  /**
   * Per-id **lifecycle state** for a bounded id set.
   *
   * This is deliberately a different identity from `byIds`, even for identical
   * ids: the two answer different questions and return different shapes. Under
   * one identity, whichever screen filled the cache first served its payload to
   * the other without that consumer's query ever running — a record array read
   * as reference states loses every retirement, and a state map read as records
   * is not iterable at all. Equal inputs are not a reason to share a cache
   * identity; equal *contracts* are.
   */
  referenceStates: (ids = []) => ['vehicles', 'reference-states', normalizeIdSet(ids)],
  reference: ['vehicles', 'reference'],
  default: ['vehicles', 'default'],
};

export const vehicleService = {
  list: ({ sort = "-created_date", limit = 50 } = {}) => {
    const local = repository();
    return local ? local.list({ sort, limit }) : apiClient.get("/vehicles", { query: { sort, limit } });
  },

  /** The bounded collection plus its own completeness/continuation authority. */
  listPage: ({ sort = "-created_date", limit = 50, cursor = null } = {}) => {
    const local = repository();
    if (local) return local.listPage({ sort, limit, cursor });
    return apiClient.get("/vehicles", { query: { sort, limit, cursor } });
  },

  /** Resolve one vehicle by identity, including a retired profile. */
  getById: (id) => {
    const local = repository();
    if (local) return local.getById(id);
    return apiClient.get(`/vehicles/${encodeURIComponent(id)}`).catch(() => null);
  },

  listRetired: () => {
    const local = repository();
    if (local) return local.listRetired();
    return apiClient.get("/vehicles", { query: { retired: true } });
  },

  listRetiredPage: ({ limit = 10, cursor = null } = {}) => {
    const local = repository();
    if (local) return local.listRetiredPage({ limit, cursor });
    return apiClient.get("/vehicles", { query: { retired: true, limit, cursor } });
  },

  /** Resolve a bounded set of references in one collection read. */
  getByIds: (ids = [], options = {}) => {
    const local = repository();
    if (local) return local.getByIds(ids, options);
    return apiClient.get("/vehicles", { query: { ids: (ids || []).join(',') } });
  },

  /** Per-id lifecycle state for the references a caller actually holds. */
  getReferenceStates: (ids = []) => {
    const local = repository();
    if (local) return local.getReferenceStates(ids);
    return apiClient.get("/vehicles", { query: { ids: (ids || []).join(','), states: true } });
  },

  /** Every record, for callers that must resolve references they cannot enumerate. */
  getAllForReference: () => {
    const local = repository();
    if (local) return local.getAllForReference();
    return apiClient.get("/vehicles", { query: { all: true } });
  },

  /** The durable default, from the complete collection rather than a page. */
  getDefault: () => {
    const local = repository();
    if (local) return local.getDefault();
    return apiClient.get("/vehicles", { query: { default: true } });
  },

  /** Complete active + retired population for a backup or portability artifact. */
  snapshotForBackup: () => {
    const local = repository();
    if (local) return local.snapshotForBackup();
    return apiClient.get("/vehicles", { query: { sort: "-created_date", limit: 1000, includeRetired: true } });
  },

  listAllVehiclesForExport: (options = {}) => {
    const local = repository();
    if (local) return local.listAllVehiclesForExport(options);
    return apiClient.get("/vehicles", { query: { sort: "-created_date", limit: 1000 } });
  },

  create: (vehicle) => {
    const local = repository();
    return local ? local.create(vehicle) : apiClient.post("/vehicles", vehicle);
  },

  update: (id, patch) => {
    const local = repository();
    return local ? local.update(id, patch) : apiClient.patch(`/vehicles/${encodeURIComponent(id)}`, patch);
  },

  delete: (id) => {
    const local = repository();
    return local ? local.delete(id) : apiClient.delete(`/vehicles/${encodeURIComponent(id)}`);
  },

  upsertMany: (vehicles) => {
    const local = repository();
    if (local) return local.upsertMany(vehicles);
    return Promise.all(vehicles.map((vehicle) => (
      vehicle.id
        ? apiClient.patch(`/vehicles/${encodeURIComponent(vehicle.id)}`, vehicle).catch(() => apiClient.post("/vehicles", vehicle))
        : apiClient.post("/vehicles", vehicle)
    )));
  },
};
