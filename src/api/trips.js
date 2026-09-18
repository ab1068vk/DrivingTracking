import { localTripRepository } from "@/lib/localTripRepository";
import { nativeTripRepository } from "@/lib/nativeTripRepository";
import { nativeTripArchive, CanonicalArchiveError } from "@/lib/nativeTripArchive";
import { isAndroid } from "@/lib/nativePlatform";
import { normalizeTripTags } from "@/lib/tripMetadata";
import {
  getEffectiveTripTags,
  inferTripTags,
  reconcileWeatherDerivedTags,
} from "@/lib/tripTagIntelligence";
import { buildTripSummary } from "@/lib/tripSummary";
import { measureAsync } from "@/lib/performanceTriage";
import { synchronizeLocalRoadMemory } from "@/lib/roadMemoryCoordinator";
import { logSystemFailure } from "@/lib/systemLog";
import { keepPreviousData } from '@tanstack/react-query';
import { publishP7SourceChange } from '@/lib/p7SourceChange';
import { P35_NATIVE_BACKUP_AUTHORITY_ENABLED } from '@/lib/backupCapabilities';

/**
 * Notify for every milestone system the moment a completed trip is saved,
 * rather than the next time the app is opened.
 *
 * Covers both the Milestones page (achievements and driver progression) and
 * the separate personal detection-calibration progress. A trip recorded in the
 * app never passes through the native import path, so without this hook both
 * systems waited for the next boot or resume.
 *
 * The coordinator is imported lazily because it imports `tripService` from
 * this module; a static import would be a cycle. Failures are logged and never
 * allowed to fail the save.
 */
const notifyMilestonesAfterSave = async (savedTrips = []) => {
  const completed = (Array.isArray(savedTrips) ? savedTrips : [savedTrips])
    .filter((trip) => trip?.status === 'completed');
  if (!completed.length) return;
  try {
    // Fold each newly completed trip into the durable achievement aggregate
    // before reconciliation reads it. This is what replaces the former
    // whole-history summary load on every save; it is idempotent by trip id.
    const { applyCompletedTripToAggregates } = await import("@/lib/achievementAggregates");
    const { localSettings } = await import("@/lib/trackingStore");
    const settings = localSettings.get();
    for (const trip of completed) {
      await applyCompletedTripToAggregates(trip, settings).catch((error) => {
        logSystemFailure('achievement_aggregate_apply', error, { trip_id: trip?.id });
      });
    }
    const { reconcileMilestonesAfterTripSave } = await import("@/lib/milestoneNotificationCoordinator");
    // Attribute progression unlocks to the newest completed trip in this save.
    const latest = completed
      .slice()
      .sort((a, b) => (
        new Date(b.end_time || b.start_time || 0).getTime() -
        new Date(a.end_time || a.start_time || 0).getTime()
      ))[0];
    await reconcileMilestonesAfterTripSave({ tripId: latest?.id ?? null });
  } catch (error) {
    logSystemFailure('milestone_notify_after_trip_save', error, {
      completed_trip_count: completed.length,
    });
  }
};

// Trip records can contain precise GPS traces. Keep them local-only even when a
// backend API URL is configured for non-trip resources.
export const shouldUseLocalStore = () => true;

let authorityCache = null;
let authorityCheckedAt = 0;
const WRITE_METHODS = new Set([
  'create',
  'update',
  'delete',
  'upsertMany',
  'restoreBatch',
  'stepRetentionReconciliation',
]);

/**
 * Ensure the coordinator-owned migration instance is admitted and advancing.
 *
 * P4-C-F02: this used to call `stepLegacyMigration()` directly, which executed
 * a bounded migration unit outside coordinator identity, coalescing, hidden
 * suspension, failure policy and telemetry, and gave the domain no automatic
 * continuation - every further turn needed another read. It is now an
 * admission: the coordinator owns the one logical migration instance, coalesces
 * this trigger onto whatever is already active or queued, drives the remaining
 * `hasMore` turns itself, and answers `ownerless` instead of touching the
 * native plugin when native migration authority is unavailable. Nothing here
 * awaits migration convergence.
 */
const ensureBoundedMigrationAdvancing = () => {
  // Re-read authority next call: a coordinator turn may promote the archive.
  authorityCache = null;
  void import("@/lib/appLifecycleWork")
    .then(({ ensureP4LegacyMigrationAdvancing }) => ensureP4LegacyMigrationAdvancing())
    .catch((error) => {
      logSystemFailure('p35_background_migration', error);
    });
};
// P3.5 native authority is deliberately dark until its local and controlled
// physical-device release gates are signed off.  This is an explicit build
// selection, not an exception fallback: once enabled, Android is native-or-
// fail-closed and can never promote disposable IDB after a plugin failure.
export const P35_NATIVE_AUTHORITY_ENABLED = P35_NATIVE_BACKUP_AUTHORITY_ENABLED;


const selectRepository = async (method = '') => {
  if (!isAndroid()) return localTripRepository;
  if (!P35_NATIVE_AUTHORITY_ENABLED) return localTripRepository;
  const now = Date.now();
  if (!authorityCache || now - authorityCheckedAt > 2_000) {
    // Fail closed: plugin registration/load errors are never interpreted as
    // permission to promote disposable IndexedDB to Android durable authority.
    const health = await nativeTripArchive.health();
    authorityCache = health;
    authorityCheckedAt = now;
  }
  if (authorityCache.recoveryState !== 'HEALTHY' || authorityCache.sentinelMatches !== true) {
    throw new CanonicalArchiveError('RECOVERY_REQUIRED', authorityCache.healthCode || 'Native canonical recovery is required');
  }
  if (authorityCache.authorityState === 'NATIVE') return nativeTripRepository;
  if (!['LEGACY', 'MIGRATING'].includes(authorityCache.authorityState)) {
    throw new CanonicalArchiveError('CANONICAL_UNAVAILABLE', `Unsupported canonical authority state: ${authorityCache.authorityState}`);
  }
  if (WRITE_METHODS.has(method)) {
    // DN3: a user-visible write may not await the whole multi-session
    // migration, fall back to disposable IndexedDB, or cut over early. Ensure
    // the bounded migration instance is admitted/continuing, then fail closed
    // with a typed retryable response. After verified promotion a later retry
    // succeeds normally through the NATIVE branch above.
    const authorityState = authorityCache.authorityState;
    ensureBoundedMigrationAdvancing();
    const refusal = new CanonicalArchiveError(
      'MIGRATION_IN_PROGRESS',
      'Legacy canonical migration is still in progress; retry this write shortly'
    );
    refusal.retryable = true;
    refusal.authorityState = authorityState;
    throw refusal;
  }
  ensureBoundedMigrationAdvancing();
  return localTripRepository;
};

const repository = () => new Proxy({}, {
  get(_target, method) {
    return async (...args) => {
      const selected = await selectRepository(String(method));
      const implementation = selected?.[method];
      if (typeof implementation !== 'function') {
        const backupAuthorityMethod = method === 'restoreBatch' || method === 'stepRetentionReconciliation';
        throw new CanonicalArchiveError(
          backupAuthorityMethod ? 'UNSUPPORTED_BACKUP_AUTHORITY' : 'CANONICAL_UNAVAILABLE',
          `Trip repository method is unavailable for the active canonical authority: ${String(method)}`
        );
      }
      return implementation.apply(selected, args);
    };
  },
});

export const tripService = {
  listSummaries: async ({ sort = "-start_time", limit = 100 } = {}) => {
    return measureAsync('tripService.listSummaries', async () => {
      const trips = await repository().listSummaries({ sort, limit });
      return trips.map(buildTripSummary);
    }, { sort, limit });
  },

  /**
   * **Retired in P7 Stage 9 — at the authority, not here.**
   *
   * Both read every trip in the store, and `list` additionally decrypted each
   * record in full, ran a retention sweep and a rescore pass, sorted the whole
   * array and then sliced `limit` rows off the front, so its `limit` described
   * the output and never the work. Every caller now reads a bounded Q1 page.
   *
   * The service layer keeps **routing** — which authority answers a read is
   * P3.5's contract, and P7 does not touch it. The browser backend refuses by
   * type, the native backend already did, so a reintroduced caller fails
   * loudly with the reason rather than silently reacquiring the old cost.
   */
  listAllSummaries: async ({ sort = "-start_time" } = {}) => {
    return measureAsync('tripService.listAllSummaries', async () => {
      const trips = await repository().listAllSummaries({ sort });
      return trips.map(buildTripSummary);
    }, { sort });
  },

  list: ({ sort = "-start_time", limit = 100 } = {}) => measureAsync('tripService.list', () => {
    return repository().list({ sort, limit });
  }, { sort, limit }),

  listForSpeedMap: ({ sort = "-start_time", offset = 0, limit = 80 } = {}) => (
    measureAsync('tripService.listForSpeedMap', () => (
      repository().listForSpeedMap({ sort, offset, limit })
    ), { sort, offset, limit })
  ),

  listAll: ({ sort = "-start_time" } = {}) => {
    return repository().listAll({ sort });
  },

  listAllForExport: ({ sort = "-start_time", signal, onProgress } = {}) => {
    return repository().listAllForExport({ sort, signal, onProgress });
  },

  getById: (id) => {
    return repository().getById(id);
  },

  create: async (trip) => {
    // P7 Stage 9 (Annex A composition obligation): every create used to run a
    // hidden `listSummaries({limit:50})` purely to infer tags. It is now the
    // bounded **Q7** tag-context read, which returns the tag fields and the
    // route key and nothing else — the same fields the projection carried, so
    // the inference sees what it always saw on the shipping path. No mutation
    // performs a hidden broad or list query any more.
    const history = await p7TripQueries.tagContext({ maxRecent: TAG_CONTEXT_TRIPS })
      .then((result) => (result?.unavailable ? [] : result?.data?.trips ?? []))
      .catch(() => []);
    const intelligence = inferTripTags(trip, history);
    const manualTags = normalizeTripTags(trip);
    const inferredTags = trip.tag_reviewed === true
      ? []
      : getEffectiveTripTags(trip, history).filter((tag) => !manualTags.includes(tag));
    const tags = [...new Set([...manualTags, ...inferredTags])];
    const primary = intelligence.primary;
    const now = new Date().toISOString();
    const tagSources = { ...(trip.tag_sources || {}) };
    manualTags.forEach((tag) => {
      tagSources[tag] = tagSources[tag] || {
        source: trip.tag_reviewed === true ? 'user_confirmed' : 'provided',
        confidence: trip.tag_reviewed === true ? 1 : null,
        reason: trip.tag_reviewed === true ? 'Confirmed by you.' : 'Saved with the trip.',
        applied_at: now,
      };
    });
    intelligence.candidates
      .filter((candidate) => inferredTags.includes(candidate.tag))
      .forEach((candidate) => {
        tagSources[candidate.tag] = {
          source: candidate.source,
          confidence: candidate.confidence,
          reason: candidate.reason,
          applied_at: now,
        };
    });
    const withSuggestion = {
      nickname: trip.nickname ?? "",
      notes: trip.notes ?? "",
      is_favorite: trip.is_favorite === true,
      ...trip,
      tag: trip.tag ?? tags[0] ?? null,
      tags,
      tag_sources: tagSources,
      auto_tag: trip.auto_tag ?? primary?.tag ?? null,
      auto_tag_confidence: trip.auto_tag_confidence ?? primary?.confidence_label ?? 'low',
      auto_tag_reason: trip.auto_tag_reason ?? primary?.reason ?? null,
      auto_tags: trip.auto_tags ?? intelligence.recommended_tags,
      tag_candidates: trip.tag_candidates ?? intelligence.candidates,
      tag_intelligence_version: trip.tag_intelligence_version ?? intelligence.version,
    };
    const saved = await repository().create(withSuggestion);
    if (saved?.status === 'completed') {
      await synchronizeLocalRoadMemory([saved], { rescore: true });
      await notifyMilestonesAfterSave([saved]);
    }
    return saved;
  },

  update: async (id, patch) => {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'weather_context')) {
      return repository().update(id, patch);
    }
    const currentTrip = await repository().getById(id);
    const tagPatch = reconcileWeatherDerivedTags(currentTrip, patch.weather_context);
    return repository().update(id, {
      ...patch,
      ...tagPatch,
    });
  },

  delete: async (id) => {
    const result = await repository().delete(id);
    const removed = result?.deleted === true || result?.recordFound === true || result?.record_found === true || result === true;
    if (removed) {
      const { invalidateAchievementAggregates } = await import("@/lib/achievementAggregates");
      await invalidateAchievementAggregates('trip_deleted');
    }
    return result;
  },
  eraseAll: async () => {
    const result = await repository().eraseAll();
    // Both supported authorities return `verified: true` only after their
    // canonical erase has completed. A refusal/unverified result must leave the
    // aggregate untouched because live history may still exist.
    if (result?.verified === true) {
      // Scheduling-observer notification only. Per-turn token revalidation is
      // the mandatory guarantee (C14), so a failure here must never turn a
      // verified canonical erase into a failed one.
      try {
        const { notifyP4CanonicalAuthorityChanged } = await import('@/lib/appLifecycleWork');
        notifyP4CanonicalAuthorityChanged('trip_generation_erased');
      } catch (cause) {
        logSystemFailure('p4_authority_invalidation_after_trip_erase', cause);
      }
      try {
        const { invalidateAchievementAggregates } = await import("@/lib/achievementAggregates");
        await invalidateAchievementAggregates('trips_erased');
      } catch (cause) {
        // Canonical data is already gone, so do not claim complete success while
        // derived achievement/calibration state may still describe it.
        const error = new Error('Trip history was erased, but derived achievement state could not be invalidated');
        error.name = 'TripErasureIncompleteError';
        error.code = 'TRIP_ERASURE_DERIVED_STATE_INCOMPLETE';
        error.canonicalEraseVerified = true;
        error.eraseResult = result;
        error.cause = cause;
        throw error;
      }
    }
    return result;
  },

  upsertMany: async (trips) => {
    const saved = await repository().upsertMany(trips);
    await synchronizeLocalRoadMemory(saved, { rescore: true });
    await notifyMilestonesAfterSave(saved);
    return saved;
  },

  restoreBatch: async (trips, options = {}) => {
    const outcome = await repository().restoreBatch(trips, options);
    const saved = Array.isArray(outcome?.survivingTrips) ? outcome.survivingTrips : [];
    await synchronizeLocalRoadMemory(saved, { rescore: true });
    await notifyMilestonesAfterSave(saved);
    return outcome;
  },

  stepRetentionReconciliation: async (options = {}) => {
    return repository().stepRetentionReconciliation(options);
  },

  markCompletedForRescore: async (options = {}) => {
    return repository().markCompletedForRescore(options);
  },

  rescoreCompletedTrips: async (options = {}) => {
    return repository().rescoreCompletedTrips(options);
  },

  rescoreById: async (id, options = {}) => {
    return repository().rescoreTripById(id, options);
  },

  getScoreMigrationSummary: async () => {
    return repository().getScoreMigrationSummary();
  },
  queryHistoryPage: (options = {}) => repository().listProjections(options),
  queryAdjacent: (id, direction, status = '') => repository().queryAdjacent(id, direction, status),
  getAggregates: (options = {}) => repository().getAggregates(options),
  getChartBuckets: (options) => repository().getChartBuckets(options),
  getOverview: (id, maxPoints = 900) => repository().getOverview(id, maxPoints),
  getPayloadStream: (id) => repository().getPayloadStream(id),
  analyzeFullFidelity: (trip, options = {}) => repository().analyzeFullFidelity(trip, options),
  splitAtStopsStreamed: (trip, options = {}) => repository().splitAtStopsStreamed(trip, options),
  /**
   * One complete trip including payload-only fields. Reserved for bounded
   * jobs that process a single trip at a time — never for list building.
   *
   * HPR-019 made it the per-trip evidence authority for the Reports Lab exports:
   * they walk the population one bounded chunk at a time and read each trip by
   * id, because the P7 projection those exports used to consume carries neither
   * `route_points` nor `driving_events`.
   */
  getFullById: (id) => repository().getFullById(id),
  /**
   * The same complete trip, prepared identically, without persisting the
   * preparation. HPR-019's Wave 6 correction: an export that claims a source
   * snapshot must not move that source while collecting the evidence for it.
   */
  readFullByIdForExport: (id) => repository().readFullByIdForExport(id),
  /** The current P7 source identity, O(1). The same one Q1 envelopes carry. */
  readQuerySnapshot: () => repository().readQuerySnapshot(),
  sampleMetadata: (maxItems = 20) => repository().sampleMetadata(maxItems),
};

/**
 * Complete the renderer-side half of a native restore cutover. The native
 * result is already durable and verified when this runs; clearing the routing
 * cache and publishing P7 therefore cannot advertise an uncommitted source.
 */
export async function publishVerifiedNativeRestore(result) {
  if (result?.verified !== true || result?.authorityState !== 'NATIVE') {
    throw new CanonicalArchiveError(
      'NATIVE_RESTORE_UNVERIFIED',
      'Native restore source publication requires verified native cutover proof'
    );
  }
  authorityCache = null;
  authorityCheckedAt = 0;
  try {
    const { notifyP4CanonicalAuthorityChanged } = await import('@/lib/appLifecycleWork');
    notifyP4CanonicalAuthorityChanged('native_backup_restore_cutover');
  } catch (cause) {
    logSystemFailure('p4_authority_invalidation_after_native_restore', cause);
  }
  publishP7SourceChange('native_backup_restore_cutover');
  return result;
}

export const tripQueryKeys = {
  summaries: ['trip-summaries'],
  limitedSummaries: (limit = 50) => ['trip-summaries', 'limited', Number(limit) || 50],
  /**
   * HPR-018 — one detail identity, not two.
   *
   * This used to mint the legacy `['trip', <id>]` key. That key is not reached by
   * the `['p7']` semantic invalidation the source-change coordinator publishes, so
   * a mounted Trip Detail, Speed Analysis, Diagnostics, 3D replay or Tracking Trip
   * Detail kept explaining the pre-enrichment record after a durable background
   * road/weather/speed update had already changed it — indefinitely, because global
   * window-focus refetch is off and `staleTime` schedules nothing. The frozen P7
   * detail contract named exactly this retirement: `tripDetailQueryOptions` builds
   * the canonical key. It does so here, so every legacy caller converges on the one
   * canonical Q2 identity without each page having to be rewritten.
   */
  detail: (id) => p7QueryKeys.detail(id),
  map: ['map-trips'],
};

export const TRIP_DETAIL_STALE_TIME = 2 * 60 * 1000;
export const TRIP_DETAIL_GC_TIME = 5 * 60 * 1000;

/** The Q7 tag-context horizon, capped by contract. */
const TAG_CONTEXT_TRIPS = 25;

export const limitedTripSummaryQueryOptions = (limit = 50) => {
  const safeLimit = Math.max(1, Number(limit) || 50);
  return {
    queryKey: tripQueryKeys.limitedSummaries(safeLimit),
    queryFn: () => measureAsync(
      'limitedTripSummaryQueryOptions.queryFn',
      () => tripService.listSummaries({ sort: '-start_time', limit: safeLimit }),
      { limit: safeLimit }
    ),
    staleTime: 2 * 60 * 1000,
    placeholderData: keepPreviousData,
  };
};

/** @deprecated P3.5 forbids full-history page queries. Use a bounded page or aggregate. */
// `tripSummaryQueryOptions()` was deleted in P7 Stage 9. It was an unbounded
// `(100)` alias with no caller left, and the retirement plan's first entry.

/**
 * The detail options the not-yet-individually-migrated callers import.
 *
 * It is the canonical Q2 entry, not an alias of it: same key, same query function,
 * same cache policy as `p7DetailQueryOptions`. A prefetch issued through one and a
 * mounted read issued through the other are the same query.
 */
export const tripDetailQueryOptions = (id) => p7DetailQueryOptions(id);

// ---------------------------------------------------------------------------
// P7 — the canonical query surface pages call, and its key families.
//
// Every method here returns the **generic P7 query envelope**
// `{ data, completeness, continuation, snapshot, unavailable? }`, with a P6
// readiness object present only on Q4, Q5, Q8 and Q9 and verbatim where it
// appears. A failure is a typed outcome, never a silent fall-through to a
// whole-history read: that reversion is exactly what the release law forbids.
//
// The legacy `tripService` methods above are untouched. They are retired per
// caller as each consumer migrates, and the release audit polices the boundary
// by symbol **and caller context**.
// ---------------------------------------------------------------------------

/**
 * The browser authority is the one that actually ships (`VITE_P35_NATIVE_AUTHORITY`
 * is unset in the ordinary configuration; only the opt-in Physical H variants
 * enable it). A P7 path with no native implementation yet reports
 * `AUTHORITY_UNAVAILABLE` rather than quietly answering from the wrong store.
 */
const p7Unavailable = (code, reason) => ({
  data: null,
  completeness: null,
  continuation: null,
  snapshot: null,
  unavailable: { code, reason },
});

const p7NativeAuthoritySelected = () => isAndroid() && P35_NATIVE_AUTHORITY_ENABLED;

/** One scalar owner read for Diagnostics; never a summary/detail scan. */
export async function readDiagnosticsTripPopulation() {
  if (!p7NativeAuthoritySelected()) {
    return (await import('@/lib/localTripRepository')).readDiagnosticsTripPopulation();
  }
  try {
    const health = await nativeTripArchive.diagnosticsHealth();
    if (health?.liveCount == null || !Number.isSafeInteger(Number(health.liveCount)) || Number(health.liveCount) < 0) {
      throw new Error('Native population count unavailable');
    }
    return {
      available: true,
      totalTripCount: Math.max(0, Number(health?.liveCount) || 0),
      completedTripCount: null,
      completedCountState: 'not_status_partitioned',
      snapshot: {
        authority: 'native',
        generation: health?.archiveGeneration ?? null,
        revision: health?.lastCommittedSeq ?? null,
        queryId: 'diagnostics.population',
        takenAt: Date.now(),
      },
    };
  } catch {
    return {
      available: false,
      reason: 'native_health_unavailable',
      snapshot: { authority: 'native', generation: null, revision: null, queryId: 'diagnostics.population', takenAt: Date.now() },
    };
  }
}

/**
 * The facade is loaded on first P7 use rather than at module scope.
 *
 * Importing it eagerly would make **this** module's initialization depend on
 * the repository's P7 exports, so any suite that partially mocks
 * `localTripRepository` would fail at link time even when it never issues a P7
 * query. Loading on demand keeps that cost where it belongs: at the call.
 */
const p7Facade = () => import('@/lib/tripQueryFacade');
const p7Reducers = () => import('@/lib/tripQueryReducers');
const p7NativeFacade = () => import('@/lib/nativeTripQueryFacade');

/**
 * Route a P7 path to the **selected authority's** implementation.
 *
 * Both sides implement the same query architecture and return the same generic
 * envelope; which one answers is P3.5's authority selection, untouched here.
 * A path with no native implementation still reports `AUTHORITY_UNAVAILABLE`
 * rather than quietly answering from the wrong store — but that is now the
 * exception for a genuinely unserved path, not the behaviour of the whole
 * facade.
 */
const p7Routed = (name, runBrowser, runNative = null) => async (...args) => {
  if (p7NativeAuthoritySelected()) {
    if (!runNative) {
      return p7Unavailable('AUTHORITY_UNAVAILABLE', `${name}_native_unsupported`);
    }
    return runNative(...args);
  }
  return runBrowser(...args);
};

export const p7TripQueries = {
  /** Q1 — the canonical bounded history page. */
  historyPage: p7Routed(
    'q1_history_page',
    async (request) => (await p7Facade()).queryTripHistoryPage(request),
    async (request) => (await p7NativeFacade()).queryTripHistoryPage(request),
  ),
  /** Q4 — an exact aggregate from a total or bucket the D1 owner keys. */
  aggregate: p7Routed(
    'q4_aggregate',
    async (request) => (await p7Facade()).queryP6AnalyticsAggregate(request),
    async (request) => (await p7NativeFacade()).queryP6AnalyticsAggregate(request),
  ),
  /** Q5 — a bounded range of day buckets. */
  chartBuckets: p7Routed(
    'q5_chart_buckets',
    async (request) => (await p7Facade()).queryP6AnalyticsDayBuckets(request),
    async (request) => (await p7NativeFacade()).queryP6AnalyticsDayBuckets(request),
  ),
  /** Q6 — the adjacent trip, for prev/next navigation. */
  adjacent: p7Routed(
    'q6_adjacent',
    async (id, direction, options) => (await p7Facade()).queryTripAdjacent(id, direction, options),
    async (id, direction, options) => (await p7NativeFacade()).queryTripAdjacent(id, direction, options),
  ),
  /** Q7 — bounded tag context, replacing the list reads on save and detail open. */
  tagContext: p7Routed(
    'q7_tag_context',
    async (request) => (await p7Facade()).queryTripTagContext(request),
    async (request) => (await p7NativeFacade()).queryTripTagContext(request),
  ),
  /** Q8 — the bounded geometry composition: Q1 id selection + D2 by-id batch. */
  geometryPage: p7Routed(
    'q8_geometry_page',
    async (request) => (await p7Facade()).queryTripGeometryPage(request),
    async (request) => (await p7NativeFacade()).queryTripGeometryPage(request),
  ),
  /**
   * Q8 step B — the read-only D2 by-id batch, for a caller that already holds
   * a bounded id set (the live risk overlay's `RISK_HISTORY_TRIP_LIMIT` rows).
   * It is the same owner and the same batch the Q8 composition uses; there is
   * no second geometry owner and no per-id fan-out.
   */
  geometryByIds: p7Routed(
    'q8_geometry_by_ids',
    async (ids, options) => (await p7Facade()).queryP6GeometryByIds(ids, options),
  ),
  /** Q9 — badges, calibration and readiness only. */
  achievementSurfaces: p7Routed(
    'q9_achievement_surfaces',
    async (settings, options) => (await p7Facade()).queryAchievementSurfaces(settings, options),
    async (settings, options) => (await p7NativeFacade()).queryAchievementSurfaces(settings, options),
  ),
  /** Q10 — one bounded turn of a named, versioned reducer. */
  reducer: p7Routed(
    'q10_reducer',
    async (request) => (await p7Reducers()).queryTripReducer(request),
    async (request) => (await p7NativeFacade()).queryTripReducer(request),
  ),
};

/**
 * Canonical key families (Annex A §A4.2). Every key carries its **source
 * binding** and its normalized parameters, so a snapshot change can never be
 * answered from a key minted under a different snapshot.
 */
export const p7QueryKeys = {
  /** One per page — the only top-level key a migrated page owns. */
  page: (pageId, params = '', srcBinding = '') => ['p7', 'page', String(pageId), String(params), String(srcBinding)],
  history: (queryId, cursor = 'first', srcBinding = '') => ['p7', 'history', String(queryId), String(cursor), String(srcBinding)],
  /** The single canonical Q2 detail entry. No second detail key owns a fetch. */
  detail: (id, detailRevision = '', srcBinding = '') => ['p7', 'detail', String(id), String(detailRevision), String(srcBinding)],
  aggregate: (scope, rangeId = '', srcBinding = '') => ['p7', 'agg', String(scope), String(rangeId), String(srcBinding)],
  buckets: (granularity, rangeId = '', srcBinding = '') => ['p7', 'buckets', String(granularity), String(rangeId), String(srcBinding)],
  reduce: (reducerId, version, queryId = '', srcBinding = '') => ['p7', 'reduce', String(reducerId), Number(version), String(queryId), String(srcBinding)],
  geometry: (queryId, cursor = 'first', srcBinding = '') => ['p7', 'geom', String(queryId), String(cursor), String(srcBinding)],
  achievements: (settingsHash = '', srcBinding = '') => ['p7', 'achv', String(settingsHash), String(srcBinding)],
  analyticsSettings: (settingsHash = '', srcBinding = '') => ['p7', 'analytics-settings', String(settingsHash), String(srcBinding)],
  tagContext: (maxRecent = 25, srcBinding = '') => ['p7', 'tagctx', Number(maxRecent), String(srcBinding)],
};

/**
 * The canonical Q2 detail query options.
 *
 * Existing detail-cache policy carries over unchanged. The legacy
 * `['trip', <id>]` key is retired **per caller**, in the stage that migrates
 * that caller; it is never registered as an alias of this entry and never read
 * by a migrated consumer.
 */
export const p7DetailQueryOptions = (id, { detailRevision = '', srcBinding = '' } = {}) => ({
  queryKey: p7QueryKeys.detail(id || 'none', detailRevision, srcBinding),
  queryFn: () => tripService.getById(id),
  enabled: Boolean(id),
  staleTime: TRIP_DETAIL_STALE_TIME,
  gcTime: TRIP_DETAIL_GC_TIME,
});
