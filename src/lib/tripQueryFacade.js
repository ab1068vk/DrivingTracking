/**
 * The canonical P7 read facade the pages call.
 *
 * It composes the owner reads that already exist and wraps each one in the
 * generic P7 query envelope (Annex A §A1). It is **not** a second store, a
 * cache-of-record, or a new authority: every value it returns came from P3.5
 * canonical storage or from a P6 D1-D4 owner, and it writes nothing.
 *
 * Q1, Q6 and Q7 live in `localTripRepository.js` because they are bounded reads
 * of the canonical store. Q4 and Q5 live in `p6TripDerivedState.js` because they
 * read the D1 owner's own buckets. This module is where a page composes them,
 * and it is the only place a page should reach for trip data after migration.
 */

import {
  P7_COMPLETENESS,
  P7_UNAVAILABLE_CODES,
} from '@/lib/queryContracts/envelope';
import {
  queryTripAdjacent,
  queryTripHistoryPage,
  queryTripTagContext,
} from '@/lib/localTripRepository';
import {
  queryP6AnalyticsAggregate,
  queryP6AnalyticsDayBuckets,
  queryP6GeometryByIds,
  readP6TripDomainReadiness,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, normalizeP6Readiness } from '@/lib/p6Contracts';
import { readAchievementSurfaces } from '@/lib/achievementAggregates';
import { logSystemFailure } from '@/lib/systemLog';

export { queryTripAdjacent, queryTripHistoryPage, queryTripTagContext };
export { queryP6AnalyticsAggregate, queryP6AnalyticsDayBuckets, queryP6GeometryByIds };

/** Q1 */
export const q1TripHistoryPage = queryTripHistoryPage;
/** Q4 */
export const q4TripAggregate = queryP6AnalyticsAggregate;
/** Q5 */
export const q5TripChartBuckets = queryP6AnalyticsDayBuckets;
/** Q6 */
export const q6TripAdjacent = queryTripAdjacent;
/** Q7 */
export const q7TripTagContext = queryTripTagContext;

/**
 * **Q9** — achievement surfaces: **badges, calibration and readiness only**.
 *
 * Bound to `readAchievementSurfaces`, which is the one page-safe reader: both
 * `readAchievementBadges` and `readCalibrationProgressFromAggregates` call
 * `rebuildAchievementAggregates` when stats are null, which is a whole-history
 * rebuild on a page path. Q9 must never reach either.
 *
 * Q9 has **no continuation**. When D1 is not `VERIFIED && complete` it returns
 * `unavailable: OWNER_NOT_READY` with no data — zero badges and a null
 * calibration are never returned as real data, and no domain or version is
 * fabricated.
 *
 * Progression, mastery, missions, records, current form and streaks are **not**
 * served here: Achievements composes those from Q9 plus the existing
 * progression/XP ledger, exact D1 fields, bounded Q1 windows and named Q10
 * reducers. No second progression owner is created.
 *
 * @param {object} settings
 * @param {{now?: number, accounting?: {items: number}|null}} [options]
 * @returns {Promise<object>} the generic P7 query envelope
 */
export async function queryAchievementSurfaces(settings = {}, options = {}) {
  const snapshot = {
    authority: 'browser',
    generation: null,
    revision: null,
    queryId: 'p7.achievements.surfaces',
    takenAt: Date.now(),
  };

  // The verbatim owner object, normalized exactly once: `readP6TripDomainReadiness`
  // returns the raw stored record, not the frozen envelope, so a caller that
  // skipped this would surface a half-shaped readiness.
  let readiness;
  try {
    readiness = normalizeP6Readiness({
      ...(await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all')),
      domain: P6_DOMAIN_KEYS.ANALYTICS,
    });
  } catch {
    readiness = normalizeP6Readiness({ domain: P6_DOMAIN_KEYS.ANALYTICS });
  }

  let surfaces;
  try {
    surfaces = await readAchievementSurfaces(settings, options);
  } catch (error) {
    logSystemFailure('p7_query_achievement_surfaces', error, { authority: 'browser' });
    return {
      data: null,
      completeness: null,
      continuation: null,
      snapshot,
      unavailable: { code: P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, reason: 'surfaces_read_failed' },
    };
  }

  if (surfaces?.needsRepair) {
    // `needsRepair: true` is a state, not a zero. The readiness object comes
    // from the owner's own aggregate gate; Q9 reports the state rather than
    // rendering an empty badge set as a real result.
    return {
      data: null,
      completeness: null,
      continuation: null,
      snapshot,
      unavailable: { code: P7_UNAVAILABLE_CODES.OWNER_NOT_READY, reason: 'achievement_aggregates_need_repair' },
      p6Readiness: readiness,
    };
  }

  return {
    data: {
      badges: surfaces.badges,
      calibration: surfaces.calibration,
    },
    completeness: P7_COMPLETENESS.EXACT,
    continuation: null,
    snapshot,
    p6Readiness: readiness,
  };
}

/** Q9 */
export const q9AchievementSurfaces = queryAchievementSurfaces;

/**
 * **Q8** — the bounded geometry composition, in two steps.
 *
 * Step A, **selection**: Q1 selects a bounded, chronological and filter-correct
 * page of trip **IDs** (sort, status, range, filter, cursor v2).
 * Step B, **hydration**: the read-only P6 D2 by-ID batch returns bounded
 * previews for exactly that fixed page, in a constant number of authority
 * crossings.
 *
 * What this composition preserves exactly: chronology, status, filters, the
 * privacy eligibility `listForSpeedMap` applies today
 * (`status === 'completed' && privacy_mode !== 'summary_only' && !route_data_expired_at`),
 * route expiry, the selected trip and the selected trip's fidelity.
 *
 * Truthful viewport semantics: until the relevant scan reaches its end the
 * result stays `PARTIAL` with a real Q1 continuation. It never claims complete
 * visible-region coverage early, and it never synthesizes a total — a caller
 * showing a count says "at least N — more available".
 *
 * A **D2 refusal is not generic PARTIAL**: the owner's real readiness and its
 * typed refusal are surfaced with no fabricated progress.
 *
 * @param {{sort?: string, status?: string|null, limit?: number,
 *          range?: object|null, filter?: object|null, cursor?: string|null,
 *          maxPoints?: number}} [request]
 * @returns {Promise<object>} the generic P7 query envelope, with `p6Readiness`
 */
export async function queryTripGeometryPage(request = {}) {
  const { maxPoints = 160, ...selection } = request;

  // Step A — Q1 owns selection, so the page is chronological and filter-correct
  // rather than ordered by the D2 manifest's own key.
  const page = await queryTripHistoryPage({
    ...selection,
    // The eligibility filter the legacy map read applies today. Privacy and
    // expiry are evaluated on the selected rows, never reversed by a P7 read.
    status: selection.status ?? 'completed',
  });
  if (page.unavailable) return page;

  const eligible = page.data.filter((row) => (
    row.privacy_mode !== 'summary_only' && !row.route_data_expired_at
  ));

  // Step B — one batch for exactly those ids, constant crossings, never k
  // detail calls and never N x Q2.
  const batch = await queryP6GeometryByIds(eligible.map((row) => row.id), { maxPoints });
  if (batch.unavailable) {
    // The D2 disposition wins: reporting a partially hydrated map as progress
    // would be the fabricated-progress case the contract forbids.
    return {
      ...batch,
      snapshot: page.snapshot,
      continuation: null,
    };
  }

  const geometryById = new Map(batch.data.map((entry) => [String(entry.id), entry]));
  const rows = eligible.map((row) => ({
    ...row,
    geometry: geometryById.get(String(row.id)) ?? {
      id: row.id, coverage: 'unknown', route_points: null, geometry_indexed: false,
    },
  }));

  return {
    data: rows,
    // EXACT only when the fixed page is hydrated **and** no further Q1 page
    // exists. Otherwise the Q1 cursor is the continuation, which is a real,
    // advancing one.
    completeness: page.continuation ? P7_COMPLETENESS.PARTIAL : P7_COMPLETENESS.EXACT,
    continuation: page.continuation,
    snapshot: page.snapshot,
    p6Readiness: batch.p6Readiness,
  };
}

/** Q8 */
export const q8TripGeometryPage = queryTripGeometryPage;
