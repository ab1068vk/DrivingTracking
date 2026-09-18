// @ts-check
/**
 * Page-addressable, failure-atomic durable storage for the progression XP
 * ledger.
 *
 * P4-B-F01-3. Progression durability used to be one monolithic localStorage
 * document, so obtaining any "page" of unlock history required parsing every
 * record ever written and every append re-sorted and re-serialized all of them.
 * The XP ledger now lives in fixed-size records:
 *
 *   drivesense_progression_xp_index_v1      the authority header, O(1) to parse
 *   drivesense_progression_xp_seg_v1_<i>    sealed, immutable, write-once,
 *                                           <= PROGRESSION_XP_SEGMENT_SIZE
 *   drivesense_progression_xp_head_v1_<g>   the mutable newest buffer, one
 *                                           generation per publication
 *
 * `head` is the index of the mutable buffer; the sealed range is
 * `[oldest, head - 1]`, and higher indices are newer.
 *
 * **Failure atomicity (P4-B-F01-3-B).** localStorage has no multi-key
 * transaction, so this store is written publish-last:
 *
 *  - a sealed segment is written once, under a key nothing references yet;
 *  - the buffer is never rewritten in place - a new content generation goes to
 *    a *new* key;
 *  - the header is the single authority publication, and it is written last;
 *  - every write is verified: `writeRecord` throws
 *    `ProgressionPersistenceError` rather than reporting a silent `false`, so
 *    no count, total, cursor or authority can advance past a durable write that
 *    did not happen;
 *  - a header record exists **only** in the ready state. A staged (migrating)
 *    target has no header at all, so it can never be mistaken for authority.
 *
 * A failed intermediate write therefore leaves the previously published header
 * authoritative and leaves at most an unreferenced orphan record, which later
 * writes clean up best-effort.
 *
 * localStorage is deliberately kept as the medium. It is already this domain's
 * durable store on every path (browser, Android WebView, native-disabled) and
 * it is synchronous, which is what lets `buildDriverProgression`,
 * `syncDriverProgressionLedger` and `processDriverProgressionAfterTrip` stay
 * synchronous for their React and lifecycle callers.
 */

export const PROGRESSION_XP_STORE_VERSION = 1;
/** Transactions per durable record. The frozen read/write page unit. */
export const PROGRESSION_XP_SEGMENT_SIZE = 200;
export const PROGRESSION_XP_INDEX_KEY = 'drivesense_progression_xp_index_v1';
export const PROGRESSION_XP_SEGMENT_PREFIX = 'drivesense_progression_xp_seg_v1_';
export const PROGRESSION_XP_HEAD_PREFIX = 'drivesense_progression_xp_head_v1_';
export const PROGRESSION_XP_MIGRATION_KEY = 'drivesense_progression_xp_migration_v1';

/** A durable progression write did not happen. Never swallowed by this module. */
export class ProgressionPersistenceError extends Error {
  constructor(key, cause) {
    super(`Progression record could not be written: ${key}`);
    this.name = 'ProgressionPersistenceError';
    this.key = key;
    this.cause = cause;
  }
}

/**
 * Storage seam instrumentation.
 *
 * The scale and failure tests assert on what the *persistence layer* actually
 * did rather than on a counter the caller maintains, so the boundedness and
 * atomicity proofs cannot drift away from the real reads and writes.
 */
const counters = { recordsRead: 0, recordsWritten: 0, entriesParsed: 0 };
export const readProgressionStoreCounters = () => ({ ...counters });
export const resetProgressionStoreCounters = () => {
  counters.recordsRead = 0;
  counters.recordsWritten = 0;
  counters.entriesParsed = 0;
};

const storage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const readRecord = (key) => {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    counters.recordsRead += 1;
    return raw == null ? null : raw;
  } catch {
    return null;
  }
};

const readJsonRecord = (key) => {
  const raw = readRecord(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Write one record, or fail loudly.
 *
 * P4-B-F01-3-B: the previous helper returned `false` on a failed `setItem` and
 * every caller ignored it, so a header could publish a count that referenced a
 * segment which was never stored. A durable write that did not happen must be
 * observable by the domain, so this throws and the caller decides.
 */
export const writeRecord = (key, value) => {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    counters.recordsWritten += 1;
    return true;
  } catch (error) {
    throw new ProgressionPersistenceError(key, error);
  }
};

/** Best-effort removal. Only ever used on unreferenced/orphan records. */
const removeRecord = (key) => {
  const store = storage();
  if (!store || typeof store.removeItem !== 'function') return;
  try { store.removeItem(key); } catch { /* orphan cleanup is debt, not authority */ }
};

const sealedKey = (index) => `${PROGRESSION_XP_SEGMENT_PREFIX}${index}`;
const headKey = (generation) => `${PROGRESSION_XP_HEAD_PREFIX}${generation}`;

const finiteInt = (value, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
);

const amountOf = (entry) => (
  typeof entry?.amount === 'number' && Number.isFinite(entry.amount) ? entry.amount : 0
);

const totalAmount = (entries) => entries.reduce((sum, entry) => sum + amountOf(entry), 0);

export const emptyXpIndex = () => ({
  version: PROGRESSION_XP_STORE_VERSION,
  segmentSize: PROGRESSION_XP_SEGMENT_SIZE,
  /** Index of the mutable buffer. Sealed segments occupy `[oldest, head - 1]`. */
  head: 0,
  oldest: 0,
  /**
   * Content generation of the buffer record currently referenced. Strictly
   * monotonic: a prospective buffer is always written to `headGen + 1`, a key
   * the published header cannot reference, so publication stays the sole
   * visibility switch even when the head has to be sealed first.
   */
  headGen: 0,
  count: 0,
  xpTotal: 0,
  state: 'ready',
});

/**
 * The published authority header, or `null`.
 *
 * A header record is written only by `publishXpIndex`, and only for a target
 * whose records are already durable, so its presence *is* the ready state.
 * `count` and `xpTotal` are the progression summary the lifecycle needs, so
 * nothing reduces the transaction history to learn lifetime XP or level.
 */
export function readXpIndex() {
  const stored = readJsonRecord(PROGRESSION_XP_INDEX_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  if (finiteInt(stored.version, -1) !== PROGRESSION_XP_STORE_VERSION) return null;
  if (stored.state !== 'ready') return null;
  return {
    version: PROGRESSION_XP_STORE_VERSION,
    segmentSize: Math.max(1, finiteInt(stored.segmentSize, PROGRESSION_XP_SEGMENT_SIZE)),
    head: finiteInt(stored.head, 0),
    oldest: finiteInt(stored.oldest, 0),
    headGen: Math.max(0, finiteInt(stored.headGen, 0)),
    count: Math.max(0, finiteInt(stored.count, 0)),
    xpTotal: typeof stored.xpTotal === 'number' && Number.isFinite(stored.xpTotal) ? stored.xpTotal : 0,
    state: 'ready',
  };
}

/** True once the segmented store, not the legacy document, is authoritative. */
export const isProgressionXpStoreReady = () => readXpIndex() !== null;

const readEntries = (key) => {
  const value = readJsonRecord(key);
  if (!Array.isArray(value)) return [];
  counters.entriesParsed += value.length;
  return value;
};

/** The records of one logical index: the buffer at `head`, sealed below it. */
const readSlice = (index, segment) => (
  segment === index.head ? readEntries(headKey(index.headGen)) : readEntries(sealedKey(segment))
);

// --- cursors ----------------------------------------------------------------

/**
 * A `<segment>:<index>` cursor rather than a global offset.
 *
 * Sealed segments are immutable, so a cursor into one is stable. A cursor into
 * the buffer shifts by however many entries were prepended since, which
 * re-presents already-seen entries (the durable delivered-id set makes that a
 * no-op) and can never skip an older undelivered one. Sealing preserves the
 * buffer's contents verbatim at the same index, so a cursor keeps its meaning
 * across a seal too.
 */
export const formatXpCursor = (cursor) => (
  cursor && typeof cursor === 'object' ? `${cursor.segment}:${cursor.index}` : ''
);

export function parseXpCursor(value) {
  if (value && typeof value === 'object' && typeof value.segment === 'number') {
    return { segment: finiteInt(value.segment, 0), index: Math.max(0, finiteInt(value.index, 0)) };
  }
  if (typeof value !== 'string' || !value) return null;
  const [segment, index] = value.split(':');
  const parsedSegment = Number(segment);
  const parsedIndex = Number(index);
  if (!Number.isFinite(parsedSegment) || !Number.isFinite(parsedIndex)) return null;
  return { segment: Math.trunc(parsedSegment), index: Math.max(0, Math.trunc(parsedIndex)) };
}

/**
 * One bounded newest-first page of durable XP transactions.
 *
 * Records touched: the header plus at most `ceil(limit / segmentSize) + 1`
 * slices - independent of how many transactions are retained.
 *
 * @param {{cursor?: string|null, limit?: number}} [page]
 * @returns {{entries: Array, nextCursor: string|null, hasMore: boolean, recordsRead: number}}
 */
export function readXpPage({ cursor = null, limit = PROGRESSION_XP_SEGMENT_SIZE } = {}) {
  const before = counters.recordsRead;
  const index = readXpIndex();
  if (!index) {
    return { entries: [], nextCursor: null, hasMore: false, recordsRead: counters.recordsRead - before };
  }
  const size = Math.max(0, Math.floor(Number(limit) || 0));
  let position = parseXpCursor(cursor) || { segment: index.head, index: 0 };
  if (position.segment > index.head) position = { segment: index.head, index: 0 };
  const entries = [];
  while (entries.length < size && position.segment >= index.oldest) {
    const slice = readSlice(index, position.segment);
    let offset = position.index;
    while (offset < slice.length && entries.length < size) {
      entries.push(slice[offset]);
      offset += 1;
    }
    position = offset >= slice.length
      ? { segment: position.segment - 1, index: 0 }
      : { segment: position.segment, index: offset };
  }
  const exhausted = position.segment < index.oldest;
  return {
    entries,
    nextCursor: exhausted ? null : formatXpCursor(position),
    hasMore: !exhausted,
    recordsRead: counters.recordsRead - before,
  };
}

/**
 * Append one batch of newest transactions, publish-last.
 *
 * Order: every new record is written under a key nothing references, each write
 * verified, and only then is the header published. A failure at any point
 * throws with the previous header still authoritative.
 *
 * @param {Array} batch newest-first, newest overall
 * @returns {{appended: number, index: object}}
 */
export function appendXpTransactions(batch = []) {
  const entries = (Array.isArray(batch) ? batch : []).filter((entry) => entry && typeof entry === 'object');
  const index = readXpIndex() || { ...emptyXpIndex() };
  if (!entries.length) return { appended: 0, index };
  const buffer = readSlice(index, index.head);
  // Dedupe against the buffer only: that is the bounded window a fresh unlock
  // can collide with, and the domain only appends unlocks its maps did not
  // already record.
  const known = new Set(buffer.map((entry) => entry?.id));
  const fresh = [];
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    fresh.push(entry);
  }
  if (!fresh.length) return { appended: 0, index };

  const next = { ...index };
  const previousHeadKey = headKey(index.headGen);
  if (buffer.length + fresh.length <= next.segmentSize) {
    next.headGen += 1;
    writeRecord(headKey(next.headGen), [...fresh, ...buffer]);
  } else {
    // Seal the current buffer *verbatim* at its own index, so any cursor into
    // it keeps pointing at the same entries, then place the batch above it.
    if (buffer.length) {
      writeRecord(sealedKey(next.head), buffer);
      next.head += 1;
    }
    const remainder = fresh.length % next.segmentSize;
    const sealedPart = fresh.slice(remainder);
    for (let start = sealedPart.length - next.segmentSize; start >= 0; start -= next.segmentSize) {
      writeRecord(sealedKey(next.head), sealedPart.slice(start, start + next.segmentSize));
      next.head += 1;
    }
    // The generation is monotonic and never reset. Resetting it to zero here
    // used to overwrite `..._head_v1_0` while the *currently published* header
    // still referenced that key, so a failed header publication left the old
    // authority pointing at replaced content (P4-B-F01-3-B).
    next.headGen += 1;
    writeRecord(headKey(next.headGen), fresh.slice(0, remainder));
  }
  next.count += fresh.length;
  next.xpTotal += totalAmount(fresh);
  const published = publishXpIndex(next);
  if (previousHeadKey !== headKey(published.headGen)) removeRecord(previousHeadKey);
  return { appended: fresh.length, index: published };
}

/**
 * Stage one older sealed segment. Only the legacy conversion uses this: it
 * walks the legacy array newest-first and therefore produces successively older
 * chunks. Nothing is published here - the returned index is in-memory staging
 * that only `publishXpIndex` can turn into authority.
 */
export function appendOlderXpSegment(entries, index) {
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  const staged = { ...(index || emptyXpIndex()) };
  if (!rows.length) return staged;
  const target = staged.oldest - 1;
  writeRecord(sealedKey(target), rows);
  staged.oldest = target;
  staged.count += rows.length;
  staged.xpTotal += totalAmount(rows);
  return staged;
}

/**
 * The single authority publication. Writing this record is what makes a target
 * ready; nothing else may claim readiness.
 */
export function publishXpIndex(index) {
  const next = {
    ...emptyXpIndex(),
    ...(index || {}),
    version: PROGRESSION_XP_STORE_VERSION,
    state: 'ready',
  };
  writeRecord(PROGRESSION_XP_INDEX_KEY, next);
  return next;
}

/** Drop every record this store owns (data-rights erasure, tests). */
export function clearProgressionXpStore() {
  const ranges = [];
  const index = readXpIndex();
  if (index) ranges.push({ oldest: index.oldest, head: index.head, headGen: index.headGen });
  const staged = readMigrationState()?.index;
  if (staged) ranges.push({ oldest: finiteInt(staged.oldest, 0), head: finiteInt(staged.head, 0), headGen: finiteInt(staged.headGen, 0) });
  for (const range of ranges) {
    for (let segment = range.oldest; segment <= range.head; segment += 1) removeRecord(sealedKey(segment));
    // Generations are monotonic, so they are retired by enumeration (bounded by
    // how many storage keys exist, never by retained history). The fallback
    // covers the current generation and the one an abandoned publication may
    // have staged above it.
    removeRecord(headKey(range.headGen));
    removeRecord(headKey(range.headGen + 1));
  }
  for (const key of enumerateKeysWithPrefix(PROGRESSION_XP_HEAD_PREFIX)) removeRecord(key);
  removeRecord(PROGRESSION_XP_INDEX_KEY);
  removeRecord(PROGRESSION_XP_MIGRATION_KEY);
}

// --- conversion checkpoint --------------------------------------------------

export function readMigrationState() {
  const stored = readJsonRecord(PROGRESSION_XP_MIGRATION_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  return {
    charOffset: Math.max(0, finiteInt(stored.charOffset, 0)),
    converted: Math.max(0, finiteInt(stored.converted, 0)),
    sourceLength: Math.max(0, finiteInt(stored.sourceLength, 0)),
    seenIds: Array.isArray(stored.seenIds) ? stored.seenIds.filter((id) => typeof id === 'string') : [],
    index: stored.index && typeof stored.index === 'object' && !Array.isArray(stored.index) ? stored.index : null,
  };
}

export const writeMigrationState = (state) => writeRecord(PROGRESSION_XP_MIGRATION_KEY, state);
export const clearMigrationState = () => removeRecord(PROGRESSION_XP_MIGRATION_KEY);

/**
 * Whether the legacy progression document exists, without retrieving its value.
 *
 * P4-B-F01-3-A: lifecycle work must be able to detect conversion debt without
 * ever performing the O(legacy N) `getItem` on the monolithic document. Key
 * enumeration is proportional to how many storage keys the app has, not to the
 * size of any value.
 *
 * @returns {boolean|null} `null` when the environment cannot be probed.
 */
export function storageKeyExists(key) {
  const store = storage();
  // P4-B-F01-3-A2: an unavailable accessor is *unknown*, not "definitely
  // absent". Returning `false` here let a caller conclude there was no legacy
  // document when it simply could not look, which is the wrong direction for a
  // fail-safe: the caller must assume conversion debt instead.
  if (!store) return null;
  try {
    if (typeof store.length === 'number' && typeof store.key === 'function') {
      for (let position = 0; position < store.length; position += 1) {
        if (store.key(position) === key) return true;
      }
      return false;
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether a storage subsystem exists at all. Distinct from "unprobeable". */
export const progressionStorageAvailable = () => storage() !== null;

/** Keys under `prefix`, when enumeration is supported. Bounded by key count. */
export function enumerateKeysWithPrefix(prefix) {
  const store = storage();
  if (!store) return [];
  try {
    if (typeof store.length !== 'number' || typeof store.key !== 'function') return [];
    const keys = [];
    for (let position = 0; position < store.length; position += 1) {
      const key = store.key(position);
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
