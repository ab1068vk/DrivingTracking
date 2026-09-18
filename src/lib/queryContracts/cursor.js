/**
 * P7 Stage 1 — browser cursor v2 and the snapshot/revision law (Annex A §A2).
 *
 * Declaration only. The v1 cursor (`tripProjectionQuery.js`) binds sort/status
 * and position, stringifies the id, and carries no source revision, so it cannot
 * deliver the no-duplicate/no-skip law. v2 replaces it in Stage 2.
 *
 * Cursors are ephemeral: there is **no** cursor data migration, and a v1 cursor
 * is refused, never upgraded.
 */

import { P7_UNAVAILABLE_CODES } from './envelope.js';

export const P7_CURSOR_VERSION = 2;

/** Encoded form: base64url(canonicalJson({...})). Field set is closed. */
export const P7_CURSOR_SHAPE = Object.freeze({
  v: 'integer literal 2',
  auth: "'browser'",
  key: Object.freeze({
    t: "'number' | 'string' — the exact IndexedDB key type of the keyset position",
    sort: 'start_time key, original type preserved',
    id: 'id key, original type preserved',
  }),
  bind: Object.freeze({
    sort: "'-start_time' | 'start_time'",
    status: 'normalized status token | "any"',
    range: '{ fromMs: int|null, toMs: int|null }',
    filterId: 'sha-256 hex of the normalized filter object',
  }),
  src: Object.freeze({
    generation: 'canonical generation id',
    rev: 'browser query revision, int',
  }),
  scan: Object.freeze({
    budgetSpent: 'int — bounded-filter bookkeeping only',
    matched: 'int — bounded-filter bookkeeping only',
  }),
  mac: 'integrity tag over every field above',
});

/**
 * A2.2 key-type preservation — the defect being fixed. No component of the
 * keyset position may be stringified; a decoded value whose type disagrees with
 * `key.t` is CURSOR_MALFORMED.
 */
export const P7_CURSOR_KEY_TYPES = Object.freeze(['number', 'string']);

/**
 * A2.4 — the browser query revision.
 *
 * It is P7 **query metadata**, not canonical authority: it never gates a
 * canonical read or write, never appears in a backup, never participates in
 * recovery, and never substitutes for a P3.5 generation.
 */
export const P7_BROWSER_QUERY_REVISION = Object.freeze({
  store: 'trip_meta',
  keyPath: 'key',
  metaKey: 'p7_query_revision',
  atomicHost: 'the existing [TRIP_PROJECTION_STORE, TRIP_META_STORE] readwrite transaction',
  monotonic: true,
  lossy: false,
});

/**
 * Row-set-relevant mutation classes. Each advances the revision atomically with
 * the mutation's projection write, or (the equally legal conservative
 * alternative, chosen here in Stage 1 rather than improvised in Stage 2) sets a
 * restart-invalidating epoch that invalidates every outstanding cursor.
 *
 * Conservative over-invalidation is legal; a missed invalidation is not.
 */
export const P7_REVISION_ADVANCING_EVENTS = Object.freeze([
  'create',
  'ordering_key_edit',
  'status_edit',
  'supported_filter_membership_edit',
  'vehicle_change',
  'score_or_analytics_change_affecting_filter_membership',
  'delete',
  'import',
  'restore',
  'erasure',
  'generation_rollover',
]);

/**
 * Stage 1 assignment of each event to its advance mechanism (A2.4 clause 4).
 * `atomic` = advanced inside the mutation's own projection-write transaction.
 * `epoch`  = conservative restart-invalidating epoch for every outstanding cursor.
 */
export const P7_REVISION_ADVANCE_MECHANISM = Object.freeze({
  create: 'atomic',
  ordering_key_edit: 'atomic',
  status_edit: 'atomic',
  supported_filter_membership_edit: 'atomic',
  vehicle_change: 'atomic',
  score_or_analytics_change_affecting_filter_membership: 'atomic',
  // Deletion is NOT one transaction in current source: `deleteTrip` commits the
  // fallback/native suppression obligations and the P6 tombstone first, then
  // runs a separate `secureDelete` per store, precisely so a trip is never
  // invisible while a store that could hand it back has no obligation covering
  // it. There is no single projection-write transaction to share, so deletion
  // takes the conservative epoch — which invalidates every outstanding cursor
  // and is strictly stronger than advancing one revision.
  delete: 'epoch',
  // Bulk/authority-level events do not share a single projection-write
  // transaction, so they take the conservative epoch.
  import: 'epoch',
  restore: 'epoch',
  erasure: 'epoch',
  generation_rollover: 'epoch',
});

const C = P7_UNAVAILABLE_CODES;

/**
 * A2.5 rejection matrix, in order. A cursor is validated **before any row is
 * read**; a rejected cursor returns an `unavailable` envelope with zero rows.
 */
export const P7_CURSOR_REJECTION_MATRIX = Object.freeze([
  Object.freeze({ when: 'v !== 2 (legacy v1 presented)', code: C.CURSOR_VERSION_UNSUPPORTED }),
  Object.freeze({ when: 'integrity/mac failure, undecodable, or wrong key type', code: C.CURSOR_MALFORMED }),
  Object.freeze({ when: 'auth !== current authority', code: C.CURSOR_AUTHORITY_MISMATCH }),
  Object.freeze({ when: 'bind.sort / bind.status / bind.range / bind.filterId !== request', code: C.CURSOR_QUERY_MISMATCH }),
  Object.freeze({ when: 'src.generation !== current generation', code: C.CURSOR_RESTART_REQUIRED }),
  Object.freeze({ when: 'src.rev !== current browser query revision', code: C.CURSOR_RESTART_REQUIRED }),
]);

/**
 * A2.6 restart UI law. Rows from incompatible snapshots are never combined, and
 * a restart is a visible, truthful state — never a silent renumbering.
 */
export const P7_CURSOR_RESTART_UI_LAW = Object.freeze({
  discardContinuation: true,
  discardAccumulatedRows: true,
  restartFromFirstPage: true,
  mergeAcrossSnapshots: false,
  silentRenumbering: false,
});

/**
 * A2.7 — OQ-2 is closed inside this contract. No browser vehicle / tag /
 * favourite / score / text index is baseline P7 work, and the implementation may
 * not opportunistically add the rejected index: that needs a new, explicit,
 * post-review schema decision. A Stage 2 measurement is not such a decision.
 */
export const P7_BROWSER_INDEX_POLICY = Object.freeze({
  indexServedFilters: Object.freeze(['status', 'start_time_range']),
  existingIndexes: Object.freeze(['by_start_time_id', 'by_status_start_time_id']),
  rejectedBaselineIndex: "['vehicle_id','status','start_time','id']",
  rejectedReason: 'vehicle_id is not an outer indexable field; it is not an index-only change',
  otherFiltersServedBy: 'named budgeted bounded scan -> truthful PARTIAL + continuation -> EXACT only at the applicable end of the index range',
  mayAddWithoutNewReviewDecision: false,
});

/** Per-page storage-boundary bounds asserted for every Q1 page (plan M03). */
export const P7_HISTORY_PAGE_BOUNDS = Object.freeze({
  sourceRowsVisited: 'k + 1',
  projectionPointReads: 'k',
  projectionDecrypts: 'k',
  fullTripDecrypts: 0,
  historySorts: 0,
  wholeStoreGetAlls: 0,
  bytes: 'k * maxProjectionBytes + c (ENVELOPE_MAX_BYTES = 24576)',
  hasMoreProof: 'read exactly one row past the page — never a count',
});
