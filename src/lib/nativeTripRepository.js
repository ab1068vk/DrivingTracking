import {
  iterateNativeTripJsonArray,
  nativeTripArchive,
  readNativeTripPayload,
  streamJsonToCanonicalCommit,
} from '@/lib/nativeTripArchive';
import {
  analyzeNativeTripFullFidelity,
  splitNativeTripAtStopsStreamed,
} from '@/lib/tripFullFidelity';
import { runCanonicalGenerationRollover } from '@/lib/nativeProjectionBarrier';

const forbidden = (name) => {
  const error = new Error(`${name} is an unbounded query and is not available on native canonical storage`);
  error.name = 'UnboundedTripQueryError';
  error.code = 'UNBOUNDED_QUERY_FORBIDDEN';
  throw error;
};

// Canonical summary rows carry the archive's own column names (`distance` in km,
// `duration` in seconds). The app trip model uses `distance_km`/`duration_seconds`
// everywhere, and getTripMetadata already returns those because the detail path
// copies the encrypted display metadata wholesale; the bounded page path copies
// only a small allowlist, so a summary arrives without them. Fill them in here —
// this adapter is the boundary that owes the app its own model. Only absent
// fields are filled, so a native row that already supplies them still wins.
const withAppTripModel = (item) => {
  if (!item || typeof item !== 'object') return item;
  const distanceKm = Number(item.distance);
  const durationSeconds = Number(item.duration);
  return {
    ...item,
    ...(item.distance_km === undefined && Number.isFinite(distanceKm) ? { distance_km: distanceKm } : {}),
    ...(item.duration_seconds === undefined && Number.isFinite(durationSeconds) ? { duration_seconds: durationSeconds } : {}),
  };
};

const summaries = (items = []) => items.map(withAppTripModel);

const page = async ({
  sort = '-start_time', limit = 100, status = '', cursor = null, vehicleId = '',
  fromMs = null, toMs = null,
} = {}) => (
  nativeTripArchive.queryHistoryPage({
    sort,
    maxItems: limit,
    maxBytes: 256 * 1024,
    status,
    // P7 Q1 row selection over the already-existing
    // `trip_current_vehicle_status_idx`. Omitted entirely when absent, so an
    // unfiltered page keeps its current plan and its current cursor identity.
    ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
    // P7-IMPL-F05. The date range goes into the native SQL and into the native
    // cursor identity. Narrowing the page after it arrived left the range out
    // of the cursor, and made an older window pay for every newer row.
    ...(Number.isFinite(fromMs) ? { fromMs: Number(fromMs) } : {}),
    ...(Number.isFinite(toMs) ? { toMs: Number(toMs) } : {}),
    ...(cursor ? { cursor } : {}),
  })
);

export const nativeTripRepository = {
  async listProjections(options = {}) {
    const result = await page(options);
    return { rows: summaries(result.items || []), nextCursor: result.nextCursor || null, hasMore: Boolean(result.nextCursor) };
  },
  /**
   * The same bounded page, plus the snapshot it was **actually** read under.
   *
   * P7-IMPL-F05. The P7 facade binds its continuation to the archive's
   * generation and committed sequence, and reading those from a separate health
   * probe can disagree with the page that was just returned. `queryHistoryPage`
   * reports both in the same response, so this hands them back together.
   *
   * A separate method on purpose: `listProjections` is a P3.5 output whose
   * shape that closed phase pins, and widening it is not P7's to do.
   */
  async readP7ProjectionPage(options = {}) {
    const result = await page(options);
    return {
      rows: summaries(result.items || []),
      nextCursor: result.nextCursor || null,
      hasMore: Boolean(result.nextCursor),
      generation: result.archiveGeneration ?? null,
      revision: result.canonicalSeq ?? null,
    };
  },
  async listSummaries({ sort = '-start_time', limit = 100 } = {}) {
    return summaries((await page({ sort, limit })).items || []);
  },
  listAllSummaries: () => forbidden('listAllSummaries'),
  async list({ sort = '-start_time', limit = 100 } = {}) {
    return summaries((await page({ sort, limit })).items || []);
  },
  async listForSpeedMap({ sort = '-start_time', offset = 0, limit = 80 } = {}) {
    if (offset !== 0) throw new Error('Native speed-map paging requires a cursor, not an offset');
    const result = await page({ sort, limit, status: 'completed' });
    const trips = await Promise.all(summaries(result.items || []).map(async (trip) => {
      const overview = await nativeTripArchive.overview(trip.id, 900);
      return { ...trip, route_points: overview.points || [], route_overview_only: true };
    }));
    return { trips, totalAvailable: null, nextCursor: result.nextCursor || null };
  },
  listAllForExport: () => forbidden('listAllForExport'),
  listAll: () => forbidden('listAll'),
  async getById(id) {
    const [metadata, overview] = await Promise.all([
      nativeTripArchive.metadata(id),
      nativeTripArchive.overview(id, 900),
    ]);
    if (!metadata) throw new Error('Trip not found');
    return { ...metadata, route_points: overview.points || [], route_overview_only: true };
  },
  getFullById: (id) => readNativeTripPayload(id),
  /**
   * HPR-019 (Wave 6 correction). The native payload read never wrote anything,
   * so the export-safe read is the same read; the name is what an export asks
   * for, and the browser authority is where the distinction had to be made.
   */
  readFullByIdForExport: (id) => readNativeTripPayload(id),
  /**
   * The native source identity: archive generation plus last committed sequence.
   * It advances on commits, never on reads, which is exactly the property the
   * export coherence check needs.
   */
  readQuerySnapshot: async () => {
    const { readNativeSnapshot } = await import('@/lib/nativeTripQueryFacade');
    return readNativeSnapshot();
  },
  async *getPayloadStream(id) {
    yield* iterateNativeTripJsonArray(id, 'route_points');
  },
  analyzeFullFidelity: (trip, options = {}) => analyzeNativeTripFullFidelity(trip, options),
  splitAtStopsStreamed: (trip, options = {}) => splitNativeTripAtStopsStreamed(trip, options),
  async create(trip) {
    await streamJsonToCanonicalCommit(trip);
    const metadata = await this.getById(trip.id);
    return { ...trip, ...metadata, route_points: trip.route_points || metadata.route_points };
  },
  async update(id, patch) {
    const current = await readNativeTripPayload(id);
    const next = { ...current, ...patch, id, updated_at: new Date().toISOString() };
    await streamJsonToCanonicalCommit(next);
    return readNativeTripPayload(id);
  },
  async delete(id) {
    const result=await nativeTripArchive.tombstone(id);
    const { admitP5ReviewedWork, P5_LIFECYCLE_JOB_KEYS } = await import('@/lib/appLifecycleWork');
    admitP5ReviewedWork(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC, {
      wake: { type: 'native_operation', key: 'idle' },
    });
    return result;
  },
  // P4-B-F02: the canonical generation rollover and the disposable projection
  // commit path are mutually excluded, and the outgoing generation's projection
  // rows/checkpoint are dropped before the barrier is released. Canonical
  // erasure ownership is unchanged — this only wraps it.
  eraseAll: () => runCanonicalGenerationRollover(
    () => nativeTripArchive.eraseGeneration('user_delete_all_trips'),
    { reason: 'user_delete_all_trips' }
  ),
  async upsertMany(trips = []) {
    const saved = [];
    for (const trip of trips) saved.push(await this.create(trip));
    return saved;
  },
  queryAdjacent: (id, direction, status = '') => nativeTripArchive.adjacent(id, direction, status),
  getAggregates: (request = {}) => nativeTripArchive.aggregates(request),
  getChartBuckets: (request) => nativeTripArchive.chartBuckets(request),
  getTagContext: (maxRecent = 50) => nativeTripArchive.tagContext(maxRecent),
  getOverview: (id, maxPoints = 900) => nativeTripArchive.overview(id, maxPoints),
  sampleMetadata: (maxItems = 20) => nativeTripArchive.sampleMetadata(maxItems),
  markCompletedForRescore: () => forbidden('markCompletedForRescore'),
  rescoreCompletedTrips: () => forbidden('rescoreCompletedTrips'),
  async rescoreTripById(id) { return readNativeTripPayload(id); },
  async getScoreMigrationSummary() { return nativeTripArchive.aggregates({ status: 'completed' }); },
};
