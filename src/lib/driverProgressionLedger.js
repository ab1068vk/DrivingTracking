// @ts-check
/**
 * The bounded progression ledger document, and the paged reads over the XP
 * store that replaced its unbounded `xpTransactions` array.
 *
 * P4-B-F01-3. What is left in the single localStorage document after the XP
 * history moved into `driverProgressionStore` is bounded by construction:
 *
 *  - `mastery` is keyed by the fixed mastery-tier catalog and never grows with
 *    history or with the calendar;
 *  - `missions`, `seasons` and `weeklyPlans` are calendar-keyed dedupe maps.
 *    Every read of them is scoped to the current week (`weeklyPlans`, the
 *    active mission ids) or the current month (`buildSeason`), so they are
 *    retained on a fixed horizon that comfortably covers both instead of
 *    growing for the lifetime of the install;
 *  - `celebrations` was already capped at twenty-five entries;
 *  - `xp` is the incrementally maintained `{ total, count }` summary, so
 *    lifetime XP and level never require reducing the transaction history.
 *
 * The document therefore stays one bounded parse, which is what makes
 * `loadDriverProgressionLedger` safe inside a lifecycle turn.
 */

import {
  appendXpTransactions,
  isProgressionXpStoreReady,
  readXpIndex,
  readXpPage,
  writeRecord,
} from '@/lib/driverProgressionStore';

/** The pre-v3 monolithic document. Never read or written once the store is ready. */
export const LEDGER_KEY = 'drivesense_driver_progression_ledger_v1';
/**
 * The bounded progression document the ready state uses.
 *
 * P4-B-F01-3-B: the conversion must not have to strip the legacy document
 * before publishing the segmented authority, because a crash between those two
 * writes would destroy XP history. Writing the bounded state to its own key
 * instead means cutover never mutates the legacy value: the legacy document
 * simply stops being read once the header is published, and removing it becomes
 * post-cutover cleanup debt whose failure is harmless.
 */
export const PROGRESSION_STATE_KEY = 'drivesense_progression_state_v1';
/** Ledger schema version. v3 is the first without an embedded XP history. */
export const PROGRESSION_LEDGER_VERSION = 3;

/**
 * Calendar retention horizons for the dedupe maps.
 *
 * `buildDriverProgression` reads `weeklyPlans[currentWeekKey]` and
 * `missions[<current week mission id>]`; `buildSeason` scans `missions` for the
 * current month and reads `seasons[<current month challenge id>]`. Nothing
 * reads an older period, and the unlock itself is recorded permanently as an XP
 * transaction, so trimming these costs no user-visible history.
 */
export const PROGRESSION_WEEKLY_PLAN_HORIZON = 16;
export const PROGRESSION_MISSION_HORIZON = 160;
export const PROGRESSION_SEASON_HORIZON = 48;
/** Entries the Milestones history tab asks for per page. */
export const PROGRESSION_HISTORY_PAGE = 200;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const emptyLedger = () => ({
  version: PROGRESSION_LEDGER_VERSION,
  mastery: {},
  missions: {},
  seasons: {},
  weeklyPlans: {},
  celebrations: [],
  xp: { total: 0, count: 0 },
});

const finiteNumber = (value, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/** Keep the newest `limit` keys of a calendar-keyed map. Keys sort by period. */
const trimByKey = (map, limit) => {
  const keys = Object.keys(map || {});
  if (keys.length <= limit) return map || {};
  const kept = keys.sort().slice(keys.length - limit);
  const next = {};
  for (const key of kept) next[key] = map[key];
  return next;
};

/** Apply every retention horizon. Called on each write, so the blob stays bounded. */
export function pruneProgressionLedger(ledger) {
  return {
    ...ledger,
    weeklyPlans: trimByKey(ledger.weeklyPlans, PROGRESSION_WEEKLY_PLAN_HORIZON),
    missions: trimByKey(ledger.missions, PROGRESSION_MISSION_HORIZON),
    seasons: trimByKey(ledger.seasons, PROGRESSION_SEASON_HORIZON),
  };
}

/**
 * Normalize a stored or caller-supplied ledger.
 *
 * A pre-v3 document still carrying `xpTransactions` is returned with that array
 * intact: until the conversion has published the segmented store, the legacy
 * array is still the authority for XP totals and history, and dropping it here
 * would lose unlocks. Exactly one of the two is authoritative at any moment.
 */
export function normalizeLedger(value) {
  if (!isPlainObject(value)) return emptyLedger();
  const legacyTransactions = Array.isArray(value.xpTransactions) ? value.xpTransactions : null;
  const normalized = {
    ...emptyLedger(),
    ...value,
    mastery: isPlainObject(value.mastery) ? value.mastery : {},
    missions: isPlainObject(value.missions) ? value.missions : {},
    seasons: isPlainObject(value.seasons) ? value.seasons : {},
    weeklyPlans: isPlainObject(value.weeklyPlans) ? value.weeklyPlans : {},
    celebrations: Array.isArray(value.celebrations) ? value.celebrations : [],
    xp: isPlainObject(value.xp)
      ? { total: finiteNumber(value.xp.total), count: Math.max(0, finiteNumber(value.xp.count)) }
      : { total: 0, count: 0 },
  };
  if (legacyTransactions) normalized.xpTransactions = legacyTransactions;
  else delete normalized.xpTransactions;
  return normalized;
}

const readDocument = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value && typeof value === 'object') return normalizeLedger(value);
  } catch {
    // A corrupt optional document should never prevent the page from loading.
  }
  return null;
};

/**
 * The bounded progression document currently in force.
 *
 * P4-B-F01-3-B: once the segmented header is published, this reads only
 * `PROGRESSION_STATE_KEY` and never touches the legacy monolith, even if that
 * value is still physically present because post-cutover cleanup has not run or
 * failed. Before publication the legacy document is the authority and is read
 * as before.
 */
export function loadDriverProgressionLedger() {
  if (typeof localStorage === 'undefined') return emptyLedger();
  if (isProgressionXpStoreReady()) {
    const current = readDocument(PROGRESSION_STATE_KEY);
    if (current) {
      delete current.xpTransactions;
      return current;
    }
    return emptyLedger();
  }
  return readDocument(LEDGER_KEY) || emptyLedger();
}

/**
 * Persist the bounded progression document to whichever key is authoritative.
 * Throws `ProgressionPersistenceError` when the write does not happen, so no
 * caller can treat a lost document as saved.
 */
export function writeDriverProgressionLedger(ledger) {
  if (typeof localStorage === 'undefined') return;
  writeRecord(isProgressionXpStoreReady() ? PROGRESSION_STATE_KEY : LEDGER_KEY, ledger);
}

// --- authority-aware reads --------------------------------------------------

/** The legacy array, only while it is still the authority. */
const legacyTransactionsOf = (ledger) => {
  const legacy = Array.isArray(ledger?.xpTransactions) ? ledger.xpTransactions : null;
  // Only ask the store whether it has taken over when there is a legacy array
  // that the answer could change; otherwise the summary read costs one record.
  return legacy && !isProgressionXpStoreReady() ? legacy : null;
};

/**
 * Lifetime XP without reducing the transaction history.
 *
 * Order of authority: a converted store's header, then the ledger's own
 * incrementally maintained summary (which is what keeps the totals right when
 * no storage is available at all, e.g. under tests or a private-mode browser),
 * then the legacy array while it is still the authority.
 */
export function readProgressionXpSummary(ledger) {
  const legacy = legacyTransactionsOf(ledger);
  if (legacy) {
    return {
      total: legacy.reduce((sum, transaction) => sum + finiteNumber(Number(transaction?.amount)), 0),
      count: legacy.length,
    };
  }
  const summary = isPlainObject(ledger?.xp) ? ledger.xp : null;
  if (summary && (finiteNumber(summary.count) > 0 || finiteNumber(summary.total) !== 0)) {
    return { total: finiteNumber(summary.total), count: Math.max(0, finiteNumber(summary.count)) };
  }
  const index = readXpIndex();
  return index ? { total: index.xpTotal, count: index.count } : { total: 0, count: 0 };
}

/**
 * One bounded newest-first page of persisted XP transactions.
 *
 * @param {{cursor?: string|null, limit?: number}} [page]
 * @param {object} [ledger]
 * @returns {{entries: Array, nextCursor: string|null, hasMore: boolean}}
 */
export function readProgressionTransactionPage({ cursor = null, limit = PROGRESSION_HISTORY_PAGE } = {}, ledger = null) {
  const size = Math.max(0, Math.floor(Number(limit) || 0));
  const legacy = legacyTransactionsOf(ledger);
  if (legacy) {
    const start = Math.max(0, Math.floor(Number(cursor) || 0));
    const end = start + size;
    return {
      entries: legacy.slice(start, end),
      nextCursor: end < legacy.length ? String(end) : null,
      hasMore: end < legacy.length,
    };
  }
  if (size === 0) {
    const index = readXpIndex();
    return { entries: [], nextCursor: cursor ? String(cursor) : null, hasMore: Boolean(index && index.count > 0) };
  }
  const page = readXpPage({ cursor, limit: size });
  return { entries: page.entries, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

/**
 * Record a batch of newly unlocked transactions and return the ledger with its
 * summary advanced. Durable append is bounded; when no storage is available the
 * summary alone keeps the in-memory ledger correct.
 */
export function recordProgressionTransactions(ledger, batch) {
  const entries = Array.isArray(batch) ? batch : [];
  const next = { ...ledger };
  if (Array.isArray(next.xpTransactions) && !isProgressionXpStoreReady()) {
    // Legacy authority: keep writing the embedded array until the conversion
    // publishes the segmented store, so an interrupted upgrade loses nothing.
    next.xpTransactions = [...entries, ...next.xpTransactions];
    next.xp = {
      total: finiteNumber(next.xp?.total) + entries.reduce((sum, entry) => sum + finiteNumber(Number(entry?.amount)), 0),
      count: Math.max(0, finiteNumber(next.xp?.count)) + entries.length,
    };
    return next;
  }
  if (entries.length) appendXpTransactions(entries);
  next.xp = {
    total: finiteNumber(next.xp?.total) + entries.reduce((sum, entry) => sum + finiteNumber(Number(entry?.amount)), 0),
    count: Math.max(0, finiteNumber(next.xp?.count)) + entries.length,
  };
  return next;
}
