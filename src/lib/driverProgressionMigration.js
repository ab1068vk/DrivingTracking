// @ts-check
/**
 * The one-time conversion of the legacy monolithic progression document into
 * the segmented XP store.
 *
 * P4-B-F01-3-A. The legacy value is one indivisible localStorage string:
 * `getItem` on it is O(legacy N) bytes and no amount of scanning makes that
 * retrieval bounded. This module therefore stops pretending conversion can be a
 * bounded lifecycle turn and classifies it honestly as **explicit,
 * non-lifecycle, full-history migration debt**:
 *
 *  - lifecycle work (bootstrap, resume, milestone reconciliation) detects the
 *    debt through `progressionMigrationNeeded`, which reads only the small
 *    store header and, at most, enumerates storage *keys*. It never retrieves
 *    the legacy value and never converts;
 *  - conversion runs in an explicit *session*. A session acquires the legacy
 *    string exactly once and then converts bounded chunks from that
 *    process-local source, so a 10,000-entry ledger costs one legacy read, not
 *    one per page;
 *  - a session can yield between chunks (`runProgressionLedgerMigrationAsync`)
 *    so an explicit UI caller never blocks first paint;
 *  - a process that dies mid-session resumes from the durable checkpoint in a
 *    new session, which reacquires the source once. That is migration debt, not
 *    lifecycle work.
 *
 * Cutover is publish-last and never mutates the legacy value: the bounded
 * progression document is staged under its own key, the segmented header is
 * published, and only then does removing the legacy document become harmless
 * cleanup debt.
 */

import {
  appendOlderXpSegment,
  clearMigrationState,
  clearProgressionXpStore,
  emptyXpIndex,
  isProgressionXpStoreReady,
  PROGRESSION_XP_SEGMENT_SIZE,
  publishXpIndex,
  progressionStorageAvailable,
  readMigrationState,
  storageKeyExists,
  writeMigrationState,
  writeRecord,
} from '@/lib/driverProgressionStore';
import {
  LEDGER_KEY,
  normalizeLedger,
  PROGRESSION_LEDGER_VERSION,
  PROGRESSION_STATE_KEY,
  pruneProgressionLedger,
} from '@/lib/driverProgressionLedger';

/** Legacy transactions one bounded conversion chunk parses and converts. */
export const PROGRESSION_MIGRATION_PAGE = PROGRESSION_XP_SEGMENT_SIZE;

/**
 * Legacy-source instrumentation.
 *
 * `rawReads`/`rawBytes` are the seam the F01-3-A tests assert on: a lifecycle
 * bootstrap/resume must leave both at zero, and one explicit session must add
 * exactly one read whatever N is.
 */
const legacyCounters = { rawReads: 0, rawBytes: 0, elementsParsed: 0 };
export const readLegacySourceCounters = () => ({ ...legacyCounters });
export const resetLegacySourceCounters = () => {
  legacyCounters.rawReads = 0;
  legacyCounters.rawBytes = 0;
  legacyCounters.elementsParsed = 0;
};

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

const skipWhitespace = (raw, start) => {
  let index = start;
  while (index < raw.length && WHITESPACE.has(raw[index])) index += 1;
  return index;
};

/** Index just past the closing quote of the string starting at `start`. */
const skipString = (raw, start) => {
  let index = start + 1;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '\\') { index += 2; continue; }
    if (character === '"') return index + 1;
    index += 1;
  }
  return raw.length;
};

/** Index just past the JSON value starting at `start`. */
const skipValue = (raw, start) => {
  const first = raw[start];
  if (first === '"') return skipString(raw, start);
  if (first === '{' || first === '[') {
    let depth = 0;
    let index = start;
    while (index < raw.length) {
      const character = raw[index];
      if (character === '"') { index = skipString(raw, index); continue; }
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return raw.length;
  }
  let index = start;
  while (index < raw.length && !',}]'.includes(raw[index]) && !WHITESPACE.has(raw[index])) index += 1;
  return index;
};

/**
 * Where the top-level `xpTransactions` array starts, without parsing it.
 *
 * Matching the key at depth one rather than with `indexOf` means a title
 * containing the literal text cannot produce a false hit. This runs once per
 * session, not once per chunk.
 */
export function findLegacyTransactionsStart(raw) {
  if (typeof raw !== 'string') return -1;
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== '{') return -1;
  index += 1;
  while (index < raw.length) {
    index = skipWhitespace(raw, index);
    if (raw[index] === ',') { index += 1; continue; }
    if (raw[index] === '}') return -1;
    if (raw[index] !== '"') return -1;
    const keyStart = index;
    index = skipString(raw, index);
    const key = raw.slice(keyStart + 1, index - 1);
    index = skipWhitespace(raw, index);
    if (raw[index] !== ':') return -1;
    index = skipWhitespace(raw, index + 1);
    if (key === 'xpTransactions') return raw[index] === '[' ? index : -1;
    index = skipValue(raw, index);
  }
  return -1;
}

/**
 * Take up to `limit` elements of the array beginning at `offset`.
 *
 * @returns {{entries: Array, offset: number, done: boolean}}
 */
export function readLegacyTransactionChunk(raw, offset, limit) {
  const entries = [];
  let index = offset;
  while (entries.length < limit) {
    index = skipWhitespace(raw, index);
    if (index >= raw.length) return { entries, offset: index, done: true };
    if (raw[index] === ',') { index += 1; continue; }
    if (raw[index] === ']') return { entries, offset: index + 1, done: true };
    const valueEnd = skipValue(raw, index);
    try {
      const parsed = JSON.parse(raw.slice(index, valueEnd));
      legacyCounters.elementsParsed += 1;
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // A single unreadable element is skipped rather than aborting the whole
      // conversion; every other unlock still survives.
    }
    index = valueEnd;
  }
  return { entries, offset: index, done: false };
}

/**
 * Acquire the legacy document. **The only O(legacy N) read in this module**, and
 * it happens at most once per explicit migration session.
 */
const acquireLegacySource = () => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    legacyCounters.rawReads += 1;
    legacyCounters.rawBytes += raw ? raw.length : 0;
    return raw;
  } catch {
    return null;
  }
};

/**
 * Whether conversion debt is outstanding, using bounded metadata only.
 *
 * Lifecycle callers use this; it never retrieves the legacy value. When the
 * environment cannot enumerate storage keys the answer is the safe one - assume
 * debt, defer progression, and let an explicit session settle it.
 */
export function progressionMigrationNeeded() {
  // No storage subsystem at all (SSR, a non-browser host): nothing durable can
  // exist, so there is nothing to convert. Claiming debt here would strand the
  // UI in a preparing state that could never complete.
  if (!progressionStorageAvailable()) return false;
  if (isProgressionXpStoreReady()) return false;
  // `true` - the legacy document exists. `false` - it is definitely absent.
  // `null` - it could not be probed, and an *unprovable* absence must be
  // treated as debt rather than silently skipping the conversion.
  return storageKeyExists(LEDGER_KEY) !== false;
}

/**
 * Complete the conversion.
 *
 * Publication order (P4-B-F01-3-B): every staged segment is already written and
 * verified; the bounded progression document is written to its own key; the
 * segmented header is published last and is the authority switch. Removing the
 * legacy document happens only afterwards and only best-effort, so a crash
 * between publication and cleanup leaves a readable, ignored legacy value
 * rather than a data-loss window. A failure before publication throws with the
 * legacy document still authoritative and the checkpoint intact.
 */
const finishMigration = (raw, arrayStart, endOffset, staged) => {
  let parsed = null;
  try {
    parsed = JSON.parse(`${raw.slice(0, arrayStart)}[]${raw.slice(endOffset)}`);
  } catch {
    parsed = null;
  }
  const document = pruneProgressionLedger(normalizeLedger(parsed || {}));
  delete document.xpTransactions;
  document.version = PROGRESSION_LEDGER_VERSION;
  document.xp = { total: staged.xpTotal, count: staged.count };
  // 1. bounded state the ready readers need, under its own key.
  writeRecord(PROGRESSION_STATE_KEY, document);
  // 2. the single authority publication.
  const published = publishXpIndex(staged);
  // 3. post-cutover debt only. Failure here cannot lose anything.
  clearMigrationState();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LEDGER_KEY);
  } catch {
    // The legacy value is no longer read in the ready state; leaving it is debt.
  }
  return published;
};

/**
 * Open an explicit migration session. Acquires the legacy source **once** and
 * resumes from the durable checkpoint when one matches that source.
 *
 * @returns {{raw: string, arrayStart: number, checkpoint: object}|null}
 *   `null` when there is nothing to convert (the store is already published).
 */
export function beginProgressionMigrationSession() {
  if (isProgressionXpStoreReady()) return null;
  const raw = acquireLegacySource();
  if (!raw) {
    // Nothing legacy exists: publish an empty store so every later read is
    // segment-backed instead of re-probing for a legacy document.
    publishXpIndex(emptyXpIndex());
    return null;
  }
  const arrayStart = findLegacyTransactionsStart(raw);
  if (arrayStart < 0) {
    // A document with no XP array (already-v3 shape): keep its bounded state.
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const document = pruneProgressionLedger(normalizeLedger(parsed || {}));
    delete document.xpTransactions;
    document.version = PROGRESSION_LEDGER_VERSION;
    document.xp = { total: 0, count: 0 };
    writeRecord(PROGRESSION_STATE_KEY, document);
    publishXpIndex(emptyXpIndex());
    clearMigrationState();
    return null;
  }
  let checkpoint = readMigrationState();
  if (!checkpoint || checkpoint.sourceLength !== raw.length || !checkpoint.index) {
    // First session, or a checkpoint taken against a different source document.
    // Discard any partially staged target rather than mixing two sources.
    clearProgressionXpStore();
    checkpoint = {
      charOffset: arrayStart + 1,
      converted: 0,
      sourceLength: raw.length,
      seenIds: [],
      index: { ...emptyXpIndex() },
    };
    writeMigrationState(checkpoint);
  }
  return { raw, arrayStart, checkpoint };
}

/**
 * Convert one bounded chunk from an already-acquired session source. No
 * `getItem` of the legacy value happens here.
 *
 * @returns {{converted: number, hasMore: boolean, migrated: boolean}}
 */
export function stepProgressionMigrationSession(session, { maxEntries = PROGRESSION_MIGRATION_PAGE } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || PROGRESSION_MIGRATION_PAGE));
  const { raw, arrayStart } = session;
  const checkpoint = session.checkpoint;
  const chunk = readLegacyTransactionChunk(raw, checkpoint.charOffset, limit);
  // Bounded dedupe window: legacy writers already refused to record an unlock
  // twice, and a duplicate can only be adjacent because the legacy array was
  // kept sorted by `earnedAt`.
  const seen = new Set(checkpoint.seenIds);
  const fresh = [];
  for (const entry of chunk.entries) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    fresh.push(entry);
  }
  const staged = appendOlderXpSegment(fresh, checkpoint.index);

  if (chunk.done) {
    finishMigration(raw, arrayStart, chunk.offset, staged);
    return { converted: fresh.length, hasMore: false, migrated: true };
  }
  session.checkpoint = {
    charOffset: chunk.offset,
    converted: checkpoint.converted + fresh.length,
    sourceLength: checkpoint.sourceLength,
    seenIds: [...seen].slice(-PROGRESSION_MIGRATION_PAGE),
    index: staged,
  };
  writeMigrationState(session.checkpoint);
  return { converted: fresh.length, hasMore: true, migrated: false };
}

/**
 * Run one explicit migration session to completion, synchronously.
 *
 * Explicit, non-lifecycle callers only. It performs exactly one legacy-source
 * read regardless of N.
 */
export function runProgressionLedgerMigration({ maxChunks = 1000000 } = {}) {
  const session = beginProgressionMigrationSession();
  if (!session) return { converted: 0, migrated: true, sessions: session === null ? 1 : 0 };
  let converted = 0;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const outcome = stepProgressionMigrationSession(session);
    converted += outcome.converted;
    if (!outcome.hasMore) return { converted, migrated: outcome.migrated, sessions: 1 };
  }
  return { converted, migrated: false, sessions: 1 };
}

/**
 * Run one explicit migration session, yielding between chunks.
 *
 * This is what user-visible explicit callers use: the legacy source is acquired
 * once, and the conversion never occupies the main thread for more than one
 * bounded chunk at a time, so a page can render before it finishes.
 */
export async function runProgressionLedgerMigrationAsync({
  maxChunks = 1000000,
  yieldControl = () => new Promise((resolve) => { setTimeout(resolve, 0); }),
} = {}) {
  const session = beginProgressionMigrationSession();
  if (!session) return { converted: 0, migrated: true, sessions: 1 };
  let converted = 0;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const outcome = stepProgressionMigrationSession(session);
    converted += outcome.converted;
    if (!outcome.hasMore) return { converted, migrated: outcome.migrated, sessions: 1 };
    await yieldControl();
  }
  return { converted, migrated: false, sessions: 1 };
}
