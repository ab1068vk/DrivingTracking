import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { nativeTripRepository } from '@/lib/nativeTripRepository';
import {
  P7_AUTHORITIES,
  P7_COMPLETENESS,
  P7_PUBLIC_PAGE_LIMIT,
  P7_UNAVAILABLE_CODES,
  assertP7PublicLimit,
} from '@/lib/queryContracts/envelope';
import {
  decodeTripCursorV2,
  encodeTripCursorV2,
  normalizeCursorBind,
} from '@/lib/tripQueryCursor';
import { P6_DOMAIN_KEYS, normalizeP6Readiness } from '@/lib/p6Contracts';
import { readP6TripDomainReadiness } from '@/lib/p6TripDerivedState';

/**
 * The **native authority's** P7 query facade.
 *
 * P7 freezes one query architecture and two authorities that must answer it
 * equivalently. The browser side is `tripQueryFacade.js`; this is its native
 * counterpart, built on the archive primitives that already exist
 * (`queryHistoryPage`, `aggregates`, `chartBuckets`, `adjacent`, `tagContext`,
 * `overview`).
 *
 * Three rules govern everything below.
 *
 * **1. The same envelope.** Every path returns the generic P7 envelope, with
 * the same three mechanical laws: `PARTIAL` implies a continuation,
 * `unavailable` implies no data, and `p6Readiness` appears only on Q4/Q5/Q8/Q9.
 *
 * **2. Explicit §C2 normalization.** The archive stores distance in
 * **kilometres** and duration in **seconds**; the common internal units are
 * **metres** and **milliseconds**. Every conversion here is written out, so no
 * reader has to infer which side a number came from.
 *
 * **3. A typed refusal beats a wrong answer.** `trip_aggregate_totals` is an
 * **all-live** owner — it counts every committed record, with no status gate
 * (§C1a.0 consequence 2). It therefore cannot express a completed-only
 * lifetime total, and Q4 refuses that shape with `FILTER_UNSUPPORTED` rather
 * than scanning `trip_current` behind a bounded-looking call. The page
 * composition then uses the frozen Q10 reducer, which is what Annex C already
 * tells it to do.
 */

/** Native archive distance is kilometres (§C2). */
const kmToMeters = (km) => (Number.isFinite(Number(km)) ? Number(km) * 1000 : 0);

/** Native archive duration is seconds (§C2). */
const secondsToMs = (seconds) => (Number.isFinite(Number(seconds)) ? Number(seconds) * 1000 : 0);

const DAY_MS = 86400000;

/**
 * The widest day window Q4 answers from the bucket owner in one read.
 *
 * `chartBuckets` bounds itself at 1000 buckets and refuses a range wider than
 * twice its cap, so this is the archive's own limit restated on this side —
 * not a second policy. Past it Q4 refuses rather than reads more.
 */
const NATIVE_MAX_AGGREGATE_DAYS = 1000;

const envelope = ({ data, completeness, continuation = null, snapshot, p6Readiness = null }) => ({
  data,
  completeness,
  continuation,
  snapshot,
  ...(p6Readiness ? { p6Readiness } : {}),
});

const unavailable = (code, reason, snapshot = null) => ({
  data: null,
  completeness: null,
  continuation: null,
  snapshot,
  unavailable: { code, reason },
});

/**
 * The native snapshot every envelope binds to.
 *
 * `archive_generation` is the native generation counter and `last_committed_seq`
 * advances on every commit, so together they are the native equivalent of the
 * browser's generation + query revision: a cursor minted under one cannot be
 * answered under another.
 */
export const readNativeSnapshot = async () => {
  const health = await nativeTripArchive.health().catch(() => null);
  return {
    authority: 'native',
    generation: health?.archiveGeneration ?? health?.generation ?? 0,
    revision: health?.lastCommittedSeq ?? health?.throughSeq ?? 0,
    queryId: '',
    takenAt: Date.now(),
  };
};

/** A bridge failure is a typed outcome, never a silent fall-through. */
const nativeFailure = (error, snapshot) => {
  const message = String(error?.message ?? error ?? '');
  // P7-IMPL-F05 (atomicity). The archive refused to publish a page whose rows
  // and source identity would have come from two committed states. That is a
  // stale-row-set restart, not a storage fault, and it carries the frozen code
  // for exactly that: "the row set changed".
  if (/SNAPSHOT_MOVED_DURING_PAGE/.test(message)) {
    return unavailable(
      P7_UNAVAILABLE_CODES.CURSOR_RESTART_REQUIRED, 'native_snapshot_moved_during_page', snapshot
    );
  }
  if (/low.?space|ENOSPC|disk/i.test(message)) {
    return unavailable(P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, 'native_low_space', snapshot);
  }
  if (/recover|RECOVERY_REQUIRED|quarantin/i.test(message)) {
    return unavailable(P7_UNAVAILABLE_CODES.RECOVERY_REQUIRED, 'native_recovery_required', snapshot);
  }
  return unavailable(P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, message || 'native_unavailable', snapshot);
};

/**
 * **Q1** — the bounded native history page.
 *
 * Selection, ordering and the vehicle filter all happen in SQL over the
 * existing `trip_current_vehicle_status_idx`; the page never sorts a history
 * in memory. The bridge's own byte cap can return a **short page**, and a
 * short page with a cursor is `PARTIAL` — the caller keeps paging rather than
 * being told it has everything.
 */
export async function queryTripHistoryPage(request = {}) {
  const {
    sort = '-start_time', status = null, limit = 100,
    range = null, filter = null, cursor = null,
  } = request;

  const snapshot = await readNativeSnapshot();

  let pageLimit;
  try {
    pageLimit = assertP7PublicLimit(limit);
  } catch (error) {
    return unavailable(error.code, 'limit_out_of_range', snapshot);
  }

  // The only filter the native index can express exactly is the vehicle one.
  // Anything else is refused before a row is read, never silently ignored.
  const vehicleId = filter?.vehicleId ?? filter?.vehicle_id ?? null;
  const unsupported = Object.keys(filter ?? {})
    .filter((key) => !['vehicleId', 'vehicle_id'].includes(key))
    .filter((key) => {
      const value = filter[key];
      return value !== undefined && value !== null && value !== ''
        && !(Array.isArray(value) && value.length === 0);
    });
  if (unsupported.length) {
    return unavailable(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED, unsupported.join(','), snapshot);
  }

  // P7-IMPL-F05. The continuation is bound exactly as the browser's is: to the
  // normalized query (sort, status, range, filter identity), to the authority,
  // and to the source generation and committed sequence. The archive's own
  // token rides inside as the opaque position. Without this envelope a native
  // cursor carried only what SQLite put in it, so a continuation minted for one
  // date window could be replayed under another and quietly skip rows.
  const bind = await normalizeCursorBind({ sort, status, range, filter });
  let position;
  try {
    position = await decodeTripCursorV2(cursor, {
      authority: P7_AUTHORITIES.NATIVE,
      bind,
      src: { generation: snapshot.generation, rev: snapshot.revision },
    });
  } catch (error) {
    return unavailable(error.code, 'cursor_rejected', snapshot);
  }

  try {
    const result = await nativeTripRepository.readP7ProjectionPage({
      sort, limit: pageLimit, status: status ?? '', cursor: position?.opaque ?? null,
      ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
      // The range is bound into the native SQL and into the native cursor, so
      // the page that comes back is already the window — nothing is discarded
      // here, and an older window costs the same page as a newer one.
      ...(Number.isFinite(range?.fromMs) ? { fromMs: Number(range.fromMs) } : {}),
      ...(Number.isFinite(range?.toMs) ? { toMs: Number(range.toMs) } : {}),
    });

    const rows = result.rows ?? [];
    const last = rows[rows.length - 1];
    const pageSrc = {
      generation: result.generation ?? snapshot.generation,
      rev: result.revision ?? snapshot.revision,
    };
    // The page reports the generation and committed sequence it was actually
    // read under. If they have moved since the snapshot this turn decoded
    // against, a continuation would be resuming across two source states —
    // which is the one thing a keyset cursor cannot survive. Restart instead.
    if (position && (String(pageSrc.generation) !== String(snapshot.generation)
      || Number(pageSrc.rev) !== Number(snapshot.revision))) {
      return unavailable(
        P7_UNAVAILABLE_CODES.CURSOR_RESTART_REQUIRED, 'snapshot_moved_during_page', snapshot
      );
    }
    // P7-IMPL-F05 (envelope identity). The successful envelope publishes the
    // identity Java **verified for these rows**, not the preflight health read
    // taken before the call.
    //
    // On a first page there is no incoming continuation to refuse against, so
    // an archive that advanced between the health read and the Java call
    // produced one envelope carrying two source identities: `snapshot` said S
    // while the continuation minted beside it was bound to S+1. Annex A §A1.2a
    // rule 4 makes `snapshot.generation`/`snapshot.revision` the binding for
    // every continuation, so those two can never disagree.
    const verifiedSnapshot = {
      ...snapshot,
      generation: pageSrc.generation,
      revision: pageSrc.rev,
    };
    const continuation = result.nextCursor && last
      ? await encodeTripCursorV2({
        key: { sort: String(last.start_time ?? ''), id: String(last.id ?? '') },
        bind,
        src: pageSrc,
        opaque: String(result.nextCursor),
        scan: {
          budgetSpent: (position?.scan?.budgetSpent ?? 0) + rows.length,
          matched: (position?.scan?.matched ?? 0) + rows.length,
        },
      // The generation and committed sequence the page was **actually** read
      // under, not the ones a separate health probe saw a moment earlier. If
      // the archive moves between turns the next decode rejects this token
      // rather than resuming across two source states.
      }, P7_AUTHORITIES.NATIVE)
      : null;

    return envelope({
      data: rows,
      // EXACT describes **this page**, exactly as the browser authority
      // reports it: a full page is exact and may still carry a cursor. A short
      // page that still has a cursor is the byte cap, and is PARTIAL.
      completeness: (continuation && rows.length < pageLimit)
        ? P7_COMPLETENESS.PARTIAL
        : P7_COMPLETENESS.EXACT,
      continuation,
      snapshot: verifiedSnapshot,
    });
  } catch (error) {
    return nativeFailure(error, snapshot);
  }
}

/**
 * **Q4** — an exact aggregate, or a typed refusal.
 *
 * `trip_aggregate_buckets` is keyed `(day, vehicle, status)`, so it answers a
 * **day-bounded, status-filtered** question exactly. `trip_aggregate_totals`
 * is not status-gated, so it cannot answer a completed-only lifetime question
 * at all — and saying so is the correct outcome, not a fallback scan.
 */
export async function queryP6AnalyticsAggregate(request = {}) {
  const { scope = 'global', vehicleId = null, fromMs = null, toMs = null, status = 'completed' } = request;
  const snapshot = await readNativeSnapshot();

  const bounded = Number.isFinite(fromMs) && Number.isFinite(toMs);
  if (!bounded) {
    // A lifetime completed-only total. `N-TOT` counts every committed record,
    // so it would answer a different question; the composition's Q10 reducer
    // is the frozen source for this one.
    return unavailable(
      P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED,
      'native_totals_are_all_live_not_completed_only',
      snapshot,
    );
  }

  // P7-IMPL-F05. The bucket owner, as the annex names it — **not** the archive
  // `aggregates` call.
  //
  // `getTripAggregates` answers a filtered window with
  // `SUM(...) FROM trip_current WHERE start_time_ms BETWEEN ? AND ?`, which is
  // row work proportional to the drives in the window. `trip_aggregate_buckets`
  // holds the same sums already rolled up per `(day, vehicle, status)`, so the
  // same answer costs one row per day. Q4 reads the rollup and sums the day
  // buckets, and the day count is fixed by the *requested window*, never by how
  // much history is retained behind it.
  // The bucket key is `(start_time_ms / 86400000) * 86400000` — a whole UTC
  // day. A window that starts or ends mid-day cannot be expressed by those
  // buckets **exactly**, and half a day of drives is not something to round
  // off silently. Q4 says so and the composition uses its Q10 reducer.
  if (Number(fromMs) % DAY_MS !== 0 || Number(toMs) % DAY_MS !== 0) {
    return unavailable(
      P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED,
      'native_aggregate_window_not_utc_day_aligned',
      snapshot,
    );
  }
  const dayCount = (Number(toMs) - Number(fromMs)) / DAY_MS;
  if (!(dayCount >= 1) || dayCount > NATIVE_MAX_AGGREGATE_DAYS) {
    // Q4 owns no continuation (Annex A §A1 table). A window wider than the
    // bucket owner can answer in one bounded read is refused with a typed
    // reason, and the composition falls to its frozen Q10 reducer — it is
    // never answered by widening the read instead.
    return unavailable(
      P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED,
      'native_aggregate_window_exceeds_bucket_bound',
      snapshot,
    );
  }

  try {
    const result = await nativeTripArchive.chartBuckets({
      fromMs,
      // `chartBuckets` filters `day_start_ms <= toMs` inclusively, so the last
      // day this half-open window covers is the one starting `toMs - 1 day`.
      toMs: Number(toMs) - DAY_MS,
      granularity: 'day', status: status ?? 'completed',
      maxBuckets: dayCount,
      ...(scope === 'vehicle' && vehicleId ? { vehicleId: String(vehicleId) } : {}),
    });

    const items = Array.isArray(result?.items) ? result.items : [];
    let completedCount = 0;
    let distanceKm = 0;
    let durationSeconds = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    for (const item of items) {
      completedCount += Number(item?.tripCount ?? 0) || 0;
      distanceKm += Number(item?.totalDistance ?? 0) || 0;
      durationSeconds += Number(item?.totalDuration ?? 0) || 0;
      scoreSum += Number(item?.scoreSum ?? 0) || 0;
      scoreCount += Number(item?.scoreCount ?? 0) || 0;
    }

    return envelope({
      data: {
        totals: {
          completedCount,
          // §C2, written out: the archive column is kilometres.
          totalKm: distanceKm,
          totalMeters: kmToMeters(distanceKm),
          // §C2: the archive column is seconds.
          totalDurationMs: secondsToMs(durationSeconds),
          avgScore: scoreCount > 0 ? scoreSum / scoreCount : null,
          scoredCount: scoreCount,
        },
      },
      completeness: P7_COMPLETENESS.EXACT,
      snapshot,
    });
  } catch (error) {
    return nativeFailure(error, snapshot);
  }
}

/** **Q5** — a bounded range of native day buckets, normalized per §C2. */
export async function queryP6AnalyticsDayBuckets(request = {}) {
  const {
    fromMs = null, toMs = null, status = 'completed', vehicleId = null,
    granularity = 'day', limit = P7_PUBLIC_PAGE_LIMIT.max,
  } = request;
  const snapshot = await readNativeSnapshot();

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return unavailable(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED, 'bucket_range_required', snapshot);
  }

  let bucketLimit;
  try {
    bucketLimit = assertP7PublicLimit(limit);
  } catch (error) {
    return unavailable(error.code, 'limit_out_of_range', snapshot);
  }

  try {
    const result = await nativeTripArchive.chartBuckets({
      // P7-IMPL-F05. The archive method reads `maxBuckets`; `limit` was never
      // looked at, so the requested cap was silently replaced by the archive's
      // own default of 366 and the PARTIAL/continuation decision below was made
      // against a truncation that had not happened.
      fromMs, toMs, granularity, status: status ?? 'completed', maxBuckets: bucketLimit,
      ...(vehicleId ? { vehicleId: String(vehicleId) } : {}),
    });

    const items = Array.isArray(result?.items) ? result.items : [];
    const buckets = items.map((item) => {
      const distanceKm = Number(item?.totalDistance ?? 0) || 0;
      const durationSeconds = Number(item?.totalDuration ?? 0) || 0;
      const scoreCount = Number(item?.scoreCount ?? 0) || 0;
      return {
        startMs: Number(item?.startMs ?? 0) || 0,
        completedCount: Number(item?.tripCount ?? 0) || 0,
        totalKm: distanceKm,
        totalMeters: kmToMeters(distanceKm),
        totalDurationMs: secondsToMs(durationSeconds),
        avgScore: scoreCount > 0 ? (Number(item?.scoreSum ?? 0) || 0) / scoreCount : null,
        scoredCount: scoreCount,
      };
    });

    // The bucket limit truncating the requested range is PARTIAL, and the
    // continuation is the next bucket range — never a fabricated cursor.
    const truncated = buckets.length >= bucketLimit;
    const nextFrom = truncated ? buckets[buckets.length - 1].startMs + 86400000 : null;
    return envelope({
      data: { buckets, granularity: result?.granularity ?? granularity },
      completeness: truncated ? P7_COMPLETENESS.PARTIAL : P7_COMPLETENESS.EXACT,
      continuation: truncated ? { fromMs: nextFrom, toMs } : null,
      snapshot,
    });
  } catch (error) {
    return nativeFailure(error, snapshot);
  }
}

/** **Q6** — the adjacent trip, one bounded archive lookup. */
export async function queryTripAdjacent(id, direction = 'previous', options = {}) {
  const snapshot = await readNativeSnapshot();
  try {
    const item = await nativeTripRepository.queryAdjacent(id, direction, options.status ?? '');
    return envelope({
      data: item ?? null,
      // A proven end of history is EXACT with no row, not an unavailable.
      completeness: P7_COMPLETENESS.EXACT,
      snapshot,
    });
  } catch (error) {
    return nativeFailure(error, snapshot);
  }
}

/** **Q7** — bounded tag context, capped by contract. */
export async function queryTripTagContext(request = {}) {
  const maxRecent = request.maxRecent ?? 25;
  const snapshot = await readNativeSnapshot();
  try {
    const result = await nativeTripRepository.getTagContext(maxRecent);
    // P7-IMPL-F05. `getTripTagContext` returns `{aggregates, recent}`. Reading
    // `items`/`trips` matched nothing the plugin emits, so Q7 answered EXACT
    // with an empty tag context on every call.
    const items = Array.isArray(result?.recent) ? result.recent : [];
    // P7-IMPL-F05 (envelope identity). Annex A §A1.1 puts the generic envelope,
    // including its source identity, on **every** Q1-Q10 result, so Q7 makes a
    // source-state claim even though it owns no continuation. That claim has to
    // be about the rows it returned: the archive captures the identity in the
    // same statement that selects them, and it is published here rather than
    // the preflight health read taken before the call.
    const verifiedSnapshot = {
      ...snapshot,
      generation: result?.archiveGeneration ?? snapshot.generation,
      revision: result?.canonicalSeq ?? snapshot.revision,
    };
    return envelope({
      data: {
        cappedAt: maxRecent,
        trips: items.map((row) => ({
          id: row.id,
          start_time: row.start_time ?? null,
          tag: row.tag ?? null,
          tags: row.tags ?? null,
          tag_sources: row.tag_sources ?? null,
          route_key: row.route_key ?? null,
        })),
      },
      // The result is complete for an explicitly capped contract.
      completeness: P7_COMPLETENESS.EXACT,
      snapshot: verifiedSnapshot,
    });
  } catch (error) {
    return nativeFailure(error, snapshot);
  }
}

/**
 * **Q8** — the bounded geometry composition.
 *
 * Step A is the Q1 page; step B reads the overview track for exactly those
 * ids. The archive's `getTripOverviewTrack` is stride-sampled and capped, so
 * the crossing count is fixed by the page size and no full payload is opened.
 */
export async function queryTripGeometryPage(request = {}) {
  const { maxPoints = 160, ...selection } = request;
  const page = await queryTripHistoryPage({
    ...selection,
    status: selection.status ?? 'completed',
  });
  if (page.unavailable) return page;

  const eligible = page.data.filter((row) => (
    row.privacy_mode !== 'summary_only' && !row.route_data_expired_at
  ));

  try {
    const geometry = await Promise.all(eligible.map(async (row) => {
      const overview = await nativeTripArchive.overview(row.id, maxPoints);
      const points = Array.isArray(overview?.points) ? overview.points : [];
      return points.length > 1
        ? {
          id: row.id,
          coverage: 'covered',
          route_points: points.slice(0, maxPoints),
          geometry_indexed: true,
          preview_point_cap: maxPoints,
        }
        : { id: row.id, coverage: 'unknown', route_points: null, geometry_indexed: false };
    }));

    const byId = new Map(geometry.map((entry) => [String(entry.id), entry]));
    return envelope({
      data: eligible.map((row) => ({
        ...row,
        geometry: byId.get(String(row.id)) ?? {
          id: row.id, coverage: 'unknown', route_points: null, geometry_indexed: false,
        },
      })),
      completeness: page.continuation ? P7_COMPLETENESS.PARTIAL : P7_COMPLETENESS.EXACT,
      continuation: page.continuation,
      snapshot: page.snapshot,
    });
  } catch (error) {
    return nativeFailure(error, page.snapshot);
  }
}

/** **Q9** — achievement/readiness surfaces, bound to the native authority. */
export async function queryAchievementSurfaces(settings = {}, options = {}) {
  const snapshot = await readNativeSnapshot();

  /**
   * P7-IMPL-F05. The **P6 owner's** readiness, normalized exactly once.
   *
   * This used to be a three-field object assembled here from the archive's
   * recovery state — a second readiness authority with a different shape,
   * different states and a different meaning of `complete`, on the path Annex A
   * says carries `normalizeP6Readiness` output unmodified. P6 owns analytics
   * readiness on both authorities; the archive's health is a separate fact and
   * is reported as its own unavailable reason, not as readiness.
   */
  let readiness;
  try {
    readiness = normalizeP6Readiness({
      ...(await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all')),
      domain: P6_DOMAIN_KEYS.ANALYTICS,
    });
  } catch {
    readiness = normalizeP6Readiness({ domain: P6_DOMAIN_KEYS.ANALYTICS });
  }

  try {
    const health = await nativeTripArchive.health();
    const ready = health?.recoveryState === 'HEALTHY' && health?.sentinelMatches !== false;
    if (!ready) {
      return {
        ...unavailable(P7_UNAVAILABLE_CODES.OWNER_NOT_READY, 'native_archive_not_healthy', snapshot),
        p6Readiness: readiness,
      };
    }
    const { readAchievementSurfaces } = await import('@/lib/achievementAggregates');
    return envelope({
      data: await readAchievementSurfaces(settings, options),
      completeness: P7_COMPLETENESS.EXACT,
      snapshot,
      p6Readiness: readiness,
    });
  } catch (error) {
    return { ...nativeFailure(error, snapshot), p6Readiness: readiness };
  }
}

/**
 * **Q10** — one bounded turn of a named reducer over native Q1 pages.
 *
 * The reducer registry, its populations and its fold are authority-agnostic;
 * only the row source differs. Running the *same* implementations over the
 * native page is what makes V13 parity meaningful rather than a second
 * implementation that happens to agree.
 */
export async function queryTripReducer(request = {}) {
  const { runReducerOverPages } = await import('@/lib/tripQueryReducers');
  // `runReducerOverPages` takes the snapshot from the page it reads; a third
  // argument here was never consumed, and reading the archive's health for it
  // cost a bridge call on every reducer turn for nothing.
  return runReducerOverPages(request, queryTripHistoryPage);
}
