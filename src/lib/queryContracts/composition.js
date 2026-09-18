/**
 * P7 Stage 1 — one page composition, canonical key families and the mutation ->
 * invalidation/reset matrix (Annex A §A4).
 *
 * Declaration only. Stage 2+ builds keys and invalidations from these constants;
 * no later stage may invent a key family or an invalidation rule.
 */

/**
 * §A4.1 — the frozen interpretation of "one query per page".
 *
 * A page has exactly one canonical top-level page-data composition request /
 * hook / query key. That composition may internally perform a finite, declared
 * graph of distinct bounded owner reads.
 */
export const P7_PAGE_COMPOSITION_LAW = Object.freeze({
  topLevelCompositionsPerPagePerEvent: 1,
  internalGraph: 'finite and declared in the consumer ledger',
  legalExamples: Object.freeze(['Q1 rows + Q4 totals', 'Q4 + Q5 + Q10', 'Q1 + Q8', 'Q2 + Q3 for one selected trip']),
  forbidden: Object.freeze([
    'duplicate history fetches (today 50+200 and 20+20 pairs)',
    'overlapping acquisition of the same retained trip data under two keys',
    'ad-hoc independent trip-reading hooks outside the declared composition',
    'any hidden broad read reached from the composition',
  ]),
});

/**
 * §A4.2 — canonical key families. Every key carries its source binding
 * (`srcB` = authority + generation + revision) and its normalized parameters, so
 * a snapshot change can never be answered from a key minted under a different
 * snapshot.
 */
export const P7_KEY_FAMILIES = Object.freeze({
  page: Object.freeze({ shape: "['p7','page',<pageId>,<normalizedParamsHash>,<srcBinding>]", note: 'one per page — the top-level key' }),
  history: Object.freeze({ shape: "['p7','history',<normalizedQueryId>,<cursorOrFirst>,<srcBinding>]", q: 'Q1' }),
  detail: Object.freeze({ shape: "['p7','detail',<id>,<detailRevision>,<srcBinding>]", q: 'Q2', note: 'the single canonical Q2 entry; no second detail key owns a fetch' }),
  aggregate: Object.freeze({ shape: "['p7','agg',<scope>,<normalizedRangeId>,<srcBinding>]", q: 'Q4' }),
  buckets: Object.freeze({ shape: "['p7','buckets',<granularity>,<normalizedRangeId>,<srcBinding>]", q: 'Q5' }),
  reduce: Object.freeze({ shape: "['p7','reduce',<reducerId>,<version>,<normalizedQueryId>,<srcBinding>]", q: 'Q10', note: 'holds the ephemeral continuation' }),
  geometry: Object.freeze({ shape: "['p7','geom',<normalizedQueryId>,<cursorOrFirst>,<srcBinding>]", q: 'Q8' }),
  achievements: Object.freeze({ shape: "['p7','achv',<settingsHash>,<srcBinding>]", q: 'Q9 + progression composition' }),
  analyticsSettings: Object.freeze({ shape: "['p7','analytics-settings',<settingsHash>,<srcBinding>]" }),
  tagContext: Object.freeze({ shape: "['p7','tagctx',<maxRecent>,<srcBinding>]", q: 'Q7' }),
});

/** The invalidation family names used by the matrix and by the consumer ledger. */
export const P7_INVALIDATION_FAMILIES = Object.freeze([
  'page', 'history', 'detail', 'aggregate', 'buckets', 'reduce', 'geometry', 'achievements', 'analyticsSettings',
]);

/**
 * §A4.2a — the canonical Q2 detail key and the disposition of the legacy
 * `['trip', <id>]` key. Frozen now, not left to an implementer.
 */
export const P7_DETAIL_KEY_CONTRACT = Object.freeze({
  canonicalKey: "['p7','detail',<id>,<detailRevision>,<srcBinding>]",
  ownsTheOnlyQueryFn: true,
  legacyKey: "['trip', <id>]",
  legacyRetirement: 'per caller, in the migration stage that lands that caller; tripDetailQueryOptions is rewritten to build the canonical key',
  aliasAllowed: false,
  readableByMigratedConsumer: false,
  deletedIn: 'Stage 9',
  staleTimeMs: 120_000,
  gcTimeMs: 300_000,
  openingADetailInvalidates: 'nothing',
});

const V = 'invalidate';
const VR = 'invalidate+reset';       // additionally resets incompatible cursors/continuations
const R = 'reset';                   // cursors/continuations only
const NONE = 'none';
const COND = (rule) => rule;

/**
 * §A4.3 — mutation -> invalidation / reset matrix.
 *
 * Columns are the key families of §A4.2. `invalidate+reset` means outstanding
 * cursors/continuations then answer CURSOR_RESTART_REQUIRED /
 * ACCUMULATOR_SNAPSHOT_MISMATCH.
 *
 * Opening a trip detail invalidates nothing. An edit or delete invalidates every
 * semantically affected family, because it can change the detail record, row
 * ordering and filter membership, aggregate totals, chart buckets,
 * achievements/progression, geometry availability, and any in-flight Q10
 * accumulation.
 */
export const P7_MUTATION_INVALIDATION_MATRIX = Object.freeze({
  open_detail: Object.freeze({
    page: NONE, history: NONE, detail: NONE, aggregate: NONE, buckets: NONE,
    reduce: NONE, geometry: NONE, achievements: NONE, analyticsSettings: NONE,
  }),
  create_trip: Object.freeze({
    page: V, history: VR, detail: NONE, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  tag_or_favourite_edit: Object.freeze({
    page: V, history: COND('invalidate+reset if filterable'), detail: V, aggregate: NONE, buckets: NONE,
    reduce: COND('reset if in bind'), geometry: NONE, achievements: NONE, analyticsSettings: NONE,
  }),
  ordering_key_edit: Object.freeze({
    page: V, history: VR, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  status_change: Object.freeze({
    page: V, history: VR, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  vehicle_change: Object.freeze({
    page: V, history: VR, detail: V, aggregate: COND('invalidate both vehicles + global'), buckets: V,
    reduce: R, geometry: NONE, achievements: V, analyticsSettings: NONE,
  }),
  score_or_analytics_edit: Object.freeze({
    page: V, history: V, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: NONE, achievements: V, analyticsSettings: NONE,
  }),
  delete: Object.freeze({
    page: V, history: VR, detail: COND('invalidate (remove)'), aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  import: Object.freeze({
    page: V, history: VR, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  restore: Object.freeze({
    page: V, history: VR, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: NONE,
  }),
  erasure_or_generation_rollover: Object.freeze({
    page: V, history: VR, detail: V, aggregate: V, buckets: V,
    reduce: R, geometry: V, achievements: V, analyticsSettings: V,
  }),
  analytics_settings_change: Object.freeze({
    page: V, history: NONE, detail: NONE,
    aggregate: COND('invalidate only if the setting changes the metric'),
    buckets: COND('invalidate only if the setting changes the metric'),
    reduce: R, geometry: NONE, achievements: V, analyticsSettings: V,
  }),
});

/**
 * §A4.4 — obligations absorbed from the former SHOULD list. These are mandatory
 * under M04/M11/M12; they created no new M ID.
 */
export const P7_ABSORBED_MANDATORY_OBLIGATIONS = Object.freeze([
  Object.freeze({
    former: 'S01',
    obligation: 'remove or narrow all four bare qc.invalidateQueries() calls in Settings.jsx (:1729, :1881, :2654, :3067) to the families they actually affect; a bare cache reset is not a legal P7 invalidation',
    absorbedInto: Object.freeze(['P7-M11', 'P7-M12']),
  }),
  Object.freeze({
    former: 'S03',
    obligation: 'remove the hidden save-time list read (api/trips.js:185, listSummaries({limit:50}) on every create) and serve tag context from bounded Q7; no mutation may perform a hidden broad or list query',
    absorbedInto: Object.freeze(['P7-M04', 'P7-M11']),
  }),
]);

/** The one remaining optional requirement. There is no P7-S02 and no P7-S03. */
export const P7_SHOULD_INVENTORY = Object.freeze([
  Object.freeze({
    id: 'P7-S01',
    requirement: 'replace the per-page ad-hoc window constants (MAP_OVERVIEW_ROUTE_LIMIT, OVERVIEW_ROUTE_LIMIT, RISK_HISTORY_TRIP_LIMIT, PICKER_LIMIT, TRIP_HISTORY_PAGE_SIZE, SUMMARY_LIMIT, ...) with one declared, documented page-budget table; where a window size is user-visible it is product semantics',
  }),
]);
