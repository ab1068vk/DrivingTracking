/**
 * P7 Stage 1 — the ten canonical query paths (plan § Canonical Query
 * Architecture), including the corrected Q8 selection/batch contract and the
 * restricted Q9 scope.
 *
 * Declaration only. Names are the approved facade names; none exists in current
 * source before Stage 2.
 */

const q = (id, facade, serves, backedBy, bound) => Object.freeze({ id, facade, serves, backedBy, bound });

export const P7_QUERY_PATH_CONTRACTS = Object.freeze({
  Q1: q('Q1', 'queryTripHistoryPage({sort, status, filter, cursor, limit})',
    'all list surfaces',
    'listProjections -> listBoundedProjections -> selectSourceWindow',
    'k rows, k decrypts, keyset cursor v2'),
  Q2: q('Q2', 'queryTripDetail(id, {revision})',
    'detail / replay / 3D / speed-analysis',
    'getById / getFullById',
    '1 record'),
  Q3: q('Q3', 'queryTripOverviewTrack(id, {maxPoints})',
    'map preview for a selected trip',
    'getOverview (stride-sampled, cap 2000)',
    '<= maxPoints points'),
  Q4: q('Q4', 'queryTripAggregate({from, to, vehicleId, status})',
    'totals on Dashboard / Report / Vehicles / Achievements / TrackingOverview',
    'browser: D1 buckets (browser:global:2, browser:vehicle:<id>:2, day-bucket range sum); native: unfiltered trip_aggregate_totals, and for filtered/ranged requests ONLY output-bounded trip_aggregate_buckets sums or another output-bounded existing-owner read',
    'O(1) global / O(A) ranged. Otherwise unavailable FILTER_UNSUPPORTED with no data and no continuation — Q4 owns no continuation and is never generic PARTIAL'),
  Q5: q('Q5', 'queryTripChartBuckets({granularity, from, to, vehicleId})',
    'trends / charts',
    'browser: D1 browser:utc-day:*; native: chartBuckets()',
    'O(A), output-limited'),
  Q6: q('Q6', 'queryTripAdjacent(id, direction, status)',
    'prev/next navigation on detail',
    'native: adjacent() LIMIT 1; browser: one selectSourceWindow call, limit:1',
    '1 row'),
  Q7: q('Q7', 'queryTripTagContext({maxRecent})',
    'tag inference on save and on detail open',
    'native: getTagContext(); browser: one Q1 page',
    '<= maxRecent'),
  Q8: q('Q8', 'queryTripGeometryPage({sort, status, filter, cursor, maxTrips})',
    'speed map / map workspace / risk overlay / speed console',
    'a bounded COMPOSITION, not a wrapper — see P7_Q8_COMPOSITION',
    'Q1 page k + one D2 batch for those k ids; <=2 chunks decrypted per trip, preview <=160 points'),
  Q9: q('Q9', 'queryAchievementSurfaces(settings)',
    'badges, calibration and readiness ONLY',
    'readAchievementSurfaces only (P6-first via readAchievementStats -> readP6AchievementStats). Never readAchievementBadges / readCalibrationProgressFromAggregates — both trigger a whole-history rebuild',
    'O(1) global bucket + <=168 hourly buckets + bounded boundary contributions'),
  Q10: q('Q10', 'queryTripReducer({reducer, version, from, to, filter, continuation})',
    'residual exact metrics no rollup keys',
    'a registry of named, versioned, deterministic reducers; accepts NO arbitrary executable predicate or field list',
    'one declared bounded scan turn per invocation; PARTIAL + continuation until terminal EOF, EXACT only at terminal EOF'),
});

/**
 * The corrected Q8 composition (P7-PLAN-F08).
 *
 * The defect being corrected: P6 D2 pages are derived by the manifest own key
 * (`D2:<tripId>`), not by canonical trip recency and not by page
 * status/filter/viewport. Wrapping `queryP6GeometryPreviewPage` directly exposes
 * no requested IDs, chronology, status, filter or viewport binding.
 */
export const P7_Q8_COMPOSITION = Object.freeze({
  stepA: Object.freeze({
    what: 'SELECTION — Q1 selects a bounded, chronological and filter-correct page of trip IDs (sort, status, range, filter, cursor v2)',
    bound: 'one Q1 page, k rows',
  }),
  stepB: Object.freeze({
    what: 'HYDRATION — a read-only P6 D2 by-ID batch facade, conceptually geometryByIds(ids, {maxPoints}), returns bounded previews for exactly that fixed Q1 page',
    bound: 'one batch for those k ids, executed in a CONSTANT number of authority crossings per composition',
    readFacadeOnly: true,
    createsNewD2Writer: false,
    createsNewD2Store: false,
    createsNewGeometryAuthority: false,
    createsNewSpatialIndex: false,
    existingPreviewSemantics: '<=2 chunks decrypted per trip, <=160 points per trip — unchanged',
  }),
  loadMore: 'advance the Q1 chronological cursor, then D2-batch-hydrate that bounded page',
  viewport: 'client viewport culling applies ONLY to already loaded bounded pages; no new spatial index',
  selectedTrip: 'Q3 getOverview (stride-sampled, capped) or Q2 where higher fidelity is genuinely required',
  truthfulViewport: 'until the relevant scan reaches its end the UI stays PARTIAL / more available; it may never claim complete visible-region coverage early, and the synthesized totalAvailable is replaced by "at least N — more available"',
  preservedExactly: Object.freeze([
    'chronology', 'status', 'filters',
    "privacy eligibility (status==='completed' && privacy_mode!=='summary_only' && !route_data_expired_at)",
    'route expiry', 'the selected trip', "the selected trip's fidelity",
  ]),
  legacySuccessor: 'NONE — routine listForSpeedMap is retired on both authorities and no batched successor for it is built (OQ-4)',
});

/**
 * Q9 scope (P7-PLAN-F05). Achievement progression is COMPOSED, not re-owned:
 * Q9 + existing progression/XP facts + exact P6 D1 fields + bounded recent
 * windows + named Q10 reducers. No second progression owner is created.
 */
export const P7_Q9_SCOPE = Object.freeze({
  serves: Object.freeze(['badges', 'calibration', 'readiness']),
  doesNotServe: Object.freeze(['progression', 'mastery', 'missions', 'records', 'current form', 'streaks']),
  boundTo: 'readAchievementSurfaces (achievementAggregates.js:549)',
  forbiddenCallees: Object.freeze(['readAchievementBadges', 'readCalibrationProgressFromAggregates']),
  forbiddenReason: 'both call rebuildAchievementAggregates — a whole-history rebuild — when stats are null',
});

/** Browser/native parity divergences the facade must normalize or declare. */
export const P7_PARITY_DIVERGENCES = Object.freeze([
  Object.freeze({
    id: 1, what: 'page-size ceiling',
    browser: 'MAX_PROJECTION_PAGE = 500', native: 'MAX_PAGE_ITEMS = 200',
    resolution: 'the frozen public P7 limit is an integer in [1,200] on both authorities, validated and never clamped',
  }),
  Object.freeze({
    id: 2, what: 'byte budget',
    browser: 'none — never short-returns for bytes', native: 'maxBytes 256 KB; a native page can return fewer than limit with hasMore',
    resolution: 'a byte budget may return a shorter truthful page with a continuation on either authority',
  }),
  Object.freeze({
    id: 3, what: 'error type',
    browser: 'ProjectionQueryError', native: 'CanonicalArchiveError codes',
    resolution: 'both map onto the enumerated Annex A §A1.3 codes; the untyped native listForSpeedMap offset rejection is retired with the method, not typed',
  }),
  Object.freeze({
    id: 4, what: 'cursor availability',
    browser: 'listSummaries returns rows only', native: 'same — only listProjections is pageable',
    resolution: 'Q1 is the single pageable public path on both authorities',
  }),
  Object.freeze({
    id: 5, what: 'getById payload',
    browser: 'full route trace', native: 'overview-only, route_overview_only: true',
    resolution: 'declared explicitly; a consumer needing full fidelity states so, and the native disposition is typed rather than silent',
  }),
]);

/** The shipping authority. P7 must be complete and proven here first (M08, V14). */
export const P7_SHIPPING_AUTHORITY = Object.freeze({
  ordinaryShippingConfiguration: 'browser — VITE_P35_NATIVE_AUTHORITY is unset',
  nativeEnabledBy: 'the opt-in Physical H build variants only (android/app/build.gradle)',
  nativeClaimsStillMandatory: true,
});
