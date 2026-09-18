import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-B-F01-3 regressions.
 *
 * Progression durability used to be one monolithic localStorage document, so a
 * "page" of unlock candidates was obtained by parsing every record ever
 * written, and one append re-scanned, re-sorted and re-serialized all of them.
 * These tests instrument the real storage seam - not a caller-maintained
 * counter - and assert on what the persistence layer actually read, parsed and
 * wrote.
 */

import {
  LEDGER_KEY,
  loadDriverProgressionLedger,
  PROGRESSION_STATE_KEY,
  PROGRESSION_HISTORY_PAGE,
  PROGRESSION_MISSION_HORIZON,
  PROGRESSION_SEASON_HORIZON,
  PROGRESSION_WEEKLY_PLAN_HORIZON,
  pruneProgressionLedger,
  readProgressionTransactionPage,
  readProgressionXpSummary,
} from '@/lib/driverProgressionLedger';
import {
  appendXpTransactions,
  clearProgressionXpStore,
  isProgressionXpStoreReady,
  PROGRESSION_XP_INDEX_KEY,
  PROGRESSION_XP_HEAD_PREFIX,
  PROGRESSION_XP_MIGRATION_KEY,
  PROGRESSION_XP_SEGMENT_PREFIX,
  PROGRESSION_XP_SEGMENT_SIZE,
  ProgressionPersistenceError,
  progressionStorageAvailable,
  readProgressionStoreCounters,
  readXpIndex,
  readXpPage,
  resetProgressionStoreCounters,
} from '@/lib/driverProgressionStore';
import {
  beginProgressionMigrationSession,
  findLegacyTransactionsStart,
  PROGRESSION_MIGRATION_PAGE,
  progressionMigrationNeeded,
  readLegacySourceCounters,
  resetLegacySourceCounters,
  runProgressionLedgerMigration,
  stepProgressionMigrationSession,
} from '@/lib/driverProgressionMigration';
import { storageKeyExists } from '@/lib/driverProgressionStore';

/**
 * A localStorage double that records every read by key and value size, supports
 * key enumeration (which is what lets the store probe for the legacy document
 * without retrieving it), and can be made to fail a chosen write.
 */
const createStorage = () => {
  const values = new Map();
  const reads = [];
  const writes = [];
  /** `(key, attemptIndex) => boolean` - true rejects that `setItem`. */
  let failWrite = null;
  return {
    getItem: (key) => {
      const value = values.has(key) ? values.get(key) : null;
      reads.push({ key, bytes: value == null ? 0 : value.length });
      return value;
    },
    setItem: (key, value) => {
      if (failWrite && failWrite(key, writes.length)) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      writes.push({ key, bytes: String(value).length });
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
    clear: () => { values.clear(); reads.length = 0; writes.length = 0; },
    get length() { return values.size; },
    key: (position) => [...values.keys()][position] ?? null,
    _values: values,
    _reads: reads,
    _writes: writes,
    _failWritesWhen: (predicate) => { failWrite = predicate; },
  };
};
let storage;

const transaction = (index, overrides = {}) => ({
  id: `xp:mission:w${index}`,
  sourceId: `mission:w${index}`,
  type: 'mission',
  title: `Weekly mission ${index}`,
  detail: 'Advanced weekly mission',
  amount: 100,
  tripId: null,
  earnedAt: new Date(Date.UTC(2026, 0, 1) + index * 3600000).toISOString(),
  ...overrides,
});

/** `count` transactions, newest first, exactly as the legacy writer stored them. */
const legacyTransactions = (count) => Array.from({ length: count }, (_, index) => transaction(count - 1 - index));

const seedLegacyLedger = (count, extra = {}) => {
  storage.setItem(LEDGER_KEY, JSON.stringify({
    version: 2,
    mastery: { 'braking:gold': '2026-01-01T00:00:00.000Z' },
    missions: {},
    seasons: {},
    weeklyPlans: {},
    xpTransactions: legacyTransactions(count),
    celebrations: [],
    ...extra,
  }));
};

/** Fill the store directly, newest last, as successive domain appends would. */
const seedStore = (count, batch = 50) => {
  for (let start = 0; start < count; start += batch) {
    const size = Math.min(batch, count - start);
    // One batch is newest-first internally and newer than everything before it.
    appendXpTransactions(Array.from({ length: size }, (_, offset) => transaction(start + size - 1 - offset)));
  }
};

const segmentKeys = () => [...storage._values.keys()].filter((key) => key.startsWith(PROGRESSION_XP_SEGMENT_PREFIX));

describe('P4-B-F01-3: page-addressable progression XP store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage = createStorage();
    vi.stubGlobal('localStorage', storage);
    resetProgressionStoreCounters();
    resetLegacySourceCounters();
  });

  // ── bounded reads ──────────────────────────────────────────────────────────

  it('keeps newest-first order across segment boundaries', () => {
    seedStore(1000);
    const index = readXpIndex();

    expect(index.count).toBe(1000);
    expect(index.xpTotal).toBe(100000);
    expect(segmentKeys().length).toBeLessThanOrEqual(Math.ceil(1000 / 50) + 1);

    const all = [];
    let cursor = null;
    for (;;) {
      const page = readXpPage({ cursor, limit: PROGRESSION_XP_SEGMENT_SIZE });
      all.push(...page.entries);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(1000);
    expect(all.map((entry) => entry.id)).toEqual(legacyTransactions(1000).map((entry) => entry.id));
  });

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
    ['N=50000', 50000],
  ])('reads one page from a fixed number of durable records (%s)', (_label, count) => {
    seedStore(count, 500);
    resetProgressionStoreCounters();

    const readsBefore = storage._reads.length;
    const page = readXpPage({ limit: PROGRESSION_HISTORY_PAGE });
    const counters = readProgressionStoreCounters();

    expect(page.entries).toHaveLength(Math.min(count, PROGRESSION_HISTORY_PAGE));
    // One header plus at most `ceil(limit / segmentSize) + 1` segment records,
    // whatever the total. This is the number the old whole-document parse made
    // grow with N.
    const maxRecords = 1 + Math.ceil(PROGRESSION_HISTORY_PAGE / PROGRESSION_XP_SEGMENT_SIZE) + 1;
    expect(counters.recordsRead).toBeLessThanOrEqual(maxRecords);
    expect(counters.entriesParsed).toBeLessThanOrEqual(maxRecords * PROGRESSION_XP_SEGMENT_SIZE);
    // No record read is the whole ledger: every value read is a bounded segment.
    for (const read of storage._reads.slice(readsBefore)) {
      expect(read.bytes).toBeLessThanOrEqual(PROGRESSION_XP_SEGMENT_SIZE * 400);
    }
  });

  it('buys more bounded turns with more history, never a larger turn', () => {
    const measure = (count) => {
      storage.clear();
      seedStore(count, 500);
      resetProgressionStoreCounters();
      let turns = 0;
      let cursor = null;
      let maxRecordsPerTurn = 0;
      for (;;) {
        const before = readProgressionStoreCounters().recordsRead;
        const page = readXpPage({ cursor, limit: PROGRESSION_HISTORY_PAGE });
        maxRecordsPerTurn = Math.max(maxRecordsPerTurn, readProgressionStoreCounters().recordsRead - before);
        turns += 1;
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      return { turns, maxRecordsPerTurn };
    };

    const small = measure(100);
    const large = measure(10000);

    // The extra history bought turns; the per-turn record ceiling did not move.
    const ceiling = 1 + Math.ceil(PROGRESSION_HISTORY_PAGE / PROGRESSION_XP_SEGMENT_SIZE) + 1;
    expect(large.turns).toBeGreaterThan(small.turns);
    expect(large.maxRecordsPerTurn).toBeLessThanOrEqual(ceiling);
    expect(small.maxRecordsPerTurn).toBeLessThanOrEqual(ceiling);
  });

  it('reads lifetime XP without touching a single transaction record', () => {
    seedStore(5000, 500);
    resetProgressionStoreCounters();
    const readsBefore = storage._reads.length;

    const summary = readProgressionXpSummary({ xp: null });
    const counters = readProgressionStoreCounters();

    expect(summary).toEqual({ total: 500000, count: 5000 });
    // Only the O(1) header was read.
    expect(counters.recordsRead).toBe(1);
    expect(counters.entriesParsed).toBe(0);
    expect(storage._reads.slice(readsBefore).every((read) => read.key === PROGRESSION_XP_INDEX_KEY)).toBe(true);
  });

  // ── bounded writes ─────────────────────────────────────────────────────────

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('appends one transaction with fixed durable work (%s)', (_label, count) => {
    seedStore(count, 500);
    resetProgressionStoreCounters();
    const writesBefore = storage._writes.length;

    const result = appendXpTransactions([transaction(count, { id: 'xp:mission:new', sourceId: 'mission:new' })]);
    const counters = readProgressionStoreCounters();

    expect(result.appended).toBe(1);
    // header + head segment read; head segment (or a new one) + header written.
    expect(counters.recordsRead).toBeLessThanOrEqual(2);
    expect(counters.recordsWritten).toBeLessThanOrEqual(3);
    expect(counters.entriesParsed).toBeLessThanOrEqual(PROGRESSION_XP_SEGMENT_SIZE);
    // Nothing rewrote history: no write is larger than one segment record.
    for (const write of storage._writes.slice(writesBefore)) {
      expect(write.bytes).toBeLessThanOrEqual(PROGRESSION_XP_SEGMENT_SIZE * 400);
    }
    expect(readXpIndex().count).toBe(count + 1);
  });

  it('does not re-append a transaction the head segment already holds', () => {
    seedStore(10);
    const before = readXpIndex();
    const result = appendXpTransactions([transaction(9)]);

    expect(result.appended).toBe(0);
    expect(readXpIndex().count).toBe(before.count);
    expect(readXpIndex().xpTotal).toBe(before.xpTotal);
  });

  // ── cursor behaviour under mutation ────────────────────────────────────────

  it('cannot let a newly appended unlock push an older one out of reach', () => {
    seedStore(400, 400);
    const first = readXpPage({ limit: PROGRESSION_XP_SEGMENT_SIZE });
    expect(first.entries).toHaveLength(PROGRESSION_XP_SEGMENT_SIZE);

    // A concurrent unlock lands while the run is paged mid-way.
    appendXpTransactions([transaction(1000, { id: 'xp:mission:fresh', sourceId: 'mission:fresh' })]);

    const seen = new Set(first.entries.map((entry) => entry.id));
    let cursor = first.nextCursor;
    for (;;) {
      const page = readXpPage({ cursor, limit: PROGRESSION_XP_SEGMENT_SIZE });
      for (const entry of page.entries) seen.add(entry.id);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    // Every original transaction is still reachable; the insertion re-presents
    // entries (which the delivered-id set filters) but skips none.
    for (const entry of legacyTransactions(400)) expect(seen.has(entry.id)).toBe(true);
  });

  // ── legacy conversion ──────────────────────────────────────────────────────

  it('locates the transaction array without a false hit inside a string value', () => {
    const raw = JSON.stringify({
      version: 2,
      mastery: { 'a:b': 'x' },
      missions: { 'w1': '"xpTransactions":[{"id":"fake"}]' },
      xpTransactions: [{ id: 'xp:real' }],
    });
    const start = findLegacyTransactionsStart(raw);

    expect(start).toBeGreaterThan(0);
    expect(raw.slice(start, start + 12)).toBe('[{"id":"xp:r');
  });

  it.each([
    ['empty legacy', 0],
    ['a small legacy ledger', 7],
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('converts a legacy ledger with no data loss (%s)', (_label, count) => {
    seedLegacyLedger(count);
    expect(progressionMigrationNeeded()).toBe(true);

    const session = beginProgressionMigrationSession();
    let chunks = 0;
    let maxConverted = 0;
    if (session) {
      for (;;) {
        const outcome = stepProgressionMigrationSession(session);
        chunks += 1;
        maxConverted = Math.max(maxConverted, outcome.converted);
        if (!outcome.hasMore) break;
      }
    }

    expect(maxConverted).toBeLessThanOrEqual(PROGRESSION_MIGRATION_PAGE);
    expect(chunks).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(count / PROGRESSION_MIGRATION_PAGE)));
    expect(isProgressionXpStoreReady()).toBe(true);
    expect(progressionMigrationNeeded()).toBe(false);

    // Totals match the legacy semantics exactly.
    const index = readXpIndex();
    expect(index.count).toBe(count);
    expect(index.xpTotal).toBe(count * 100);

    // Every unlock survives, in the legacy order.
    const all = [];
    let cursor = null;
    for (;;) {
      const page = readProgressionTransactionPage({ cursor, limit: PROGRESSION_HISTORY_PAGE });
      all.push(...page.entries);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(all.map((entry) => entry.id)).toEqual(legacyTransactions(count).map((entry) => entry.id));

    // The ready state reads a bounded document under its own key, never the
    // legacy monolith.
    const document = JSON.parse(storage._values.get(PROGRESSION_STATE_KEY));
    expect(document.xpTransactions).toBeUndefined();
    expect(document.version).toBe(3);
    expect(document.xp).toEqual({ total: count * 100, count });
    expect(document.mastery['braking:gold']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('acquires the legacy source exactly once per session whatever N is', () => {
    seedLegacyLedger(10000);
    resetLegacySourceCounters();

    runProgressionLedgerMigration();

    const counters = readLegacySourceCounters();
    // The old implementation performed one full `getItem` per 200-entry page:
    // fifty complete legacy-string reads for this fixture.
    expect(counters.rawReads).toBe(1);
    expect(storage._reads.filter((read) => read.key === LEDGER_KEY)).toHaveLength(1);
    expect(readXpIndex().count).toBe(10000);
  });

  it('parses only one bounded chunk of legacy elements per conversion step', () => {
    seedLegacyLedger(10000);
    const session = beginProgressionMigrationSession();
    resetLegacySourceCounters();
    resetProgressionStoreCounters();

    stepProgressionMigrationSession(session);

    // Element parses are counted at the real scanner, and no legacy retrieval
    // happens inside a chunk at all.
    expect(readLegacySourceCounters().elementsParsed).toBeLessThanOrEqual(PROGRESSION_MIGRATION_PAGE);
    expect(readLegacySourceCounters().rawReads).toBe(0);
    expect(readProgressionStoreCounters().recordsWritten).toBeLessThanOrEqual(3);
  });

  it('resumes a conversion interrupted midway without double counting', () => {
    seedLegacyLedger(2500);
    const first = beginProgressionMigrationSession();
    stepProgressionMigrationSession(first);
    stepProgressionMigrationSession(first);
    // Nothing is published yet, so readers still see the legacy ledger.
    expect(isProgressionXpStoreReady()).toBe(false);
    expect(readProgressionXpSummary(JSON.parse(storage._values.get(LEDGER_KEY))))
      .toEqual({ total: 250000, count: 2500 });

    // Renderer restart: the in-memory session is gone, the durable checkpoint is not.
    resetLegacySourceCounters();
    const result = runProgressionLedgerMigration();

    expect(result.migrated).toBe(true);
    // One further legacy acquisition for the new session; not one per chunk.
    expect(readLegacySourceCounters().rawReads).toBe(1);
    expect(readXpIndex().count).toBe(2500);
    expect(readXpIndex().xpTotal).toBe(250000);
    const ids = new Set();
    let cursor = null;
    for (;;) {
      const page = readXpPage({ cursor, limit: PROGRESSION_XP_SEGMENT_SIZE });
      for (const entry of page.entries) {
        expect(ids.has(entry.id)).toBe(false);
        ids.add(entry.id);
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(ids.size).toBe(2500);
  });

  it('restarts a conversion whose source document changed under it', () => {
    seedLegacyLedger(2500);
    const session = beginProgressionMigrationSession();
    stepProgressionMigrationSession(session);

    // A different source: the checkpoint must not be applied to it.
    seedLegacyLedger(400);
    runProgressionLedgerMigration();

    expect(readXpIndex().count).toBe(400);
    expect(readXpIndex().xpTotal).toBe(40000);
  });

  it('converts a legacy ledger holding duplicate transaction ids exactly once', () => {
    const rows = legacyTransactions(10);
    storage.setItem(LEDGER_KEY, JSON.stringify({
      version: 2,
      mastery: {},
      missions: {},
      seasons: {},
      weeklyPlans: {},
      celebrations: [],
      xpTransactions: [rows[0], rows[0], ...rows.slice(1)],
    }));

    runProgressionLedgerMigration();

    expect(readXpIndex().count).toBe(10);
    expect(readXpIndex().xpTotal).toBe(1000);
  });

  it('keeps an old undelivered unlock deep in history reachable after conversion', () => {
    seedLegacyLedger(2500);
    runProgressionLedgerMigration();

    const oldest = [];
    let cursor = null;
    for (;;) {
      const page = readProgressionTransactionPage({ cursor, limit: PROGRESSION_HISTORY_PAGE });
      oldest.length = 0;
      oldest.push(...page.entries);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(oldest.at(-1).id).toBe('xp:mission:w0');
  });

  it('publishes an empty store when there is nothing legacy to convert', () => {
    expect(progressionMigrationNeeded()).toBe(false);
    const result = runProgressionLedgerMigration();

    expect(result.migrated).toBe(true);
    expect(isProgressionXpStoreReady()).toBe(true);
    expect(readXpIndex().count).toBe(0);
  });

  // --- F01-3-B: failure-atomic publication ----------------------------------

  it.each([
    ['the first staged segment', 1],
    ['a middle staged segment', 7],
    ['the final staged segment', 13],
  ])('never advances authority past a failed write at %s', (_label, failAt) => {
    seedLegacyLedger(2500);
    let segmentWrites = 0;
    storage._failWritesWhen((key) => {
      if (!key.startsWith(PROGRESSION_XP_SEGMENT_PREFIX)) return false;
      segmentWrites += 1;
      return segmentWrites === failAt;
    });

    expect(() => runProgressionLedgerMigration()).toThrow(ProgressionPersistenceError);

    // No authority was published, so the legacy array is still the ledger.
    expect(isProgressionXpStoreReady()).toBe(false);
    expect(readXpIndex()).toBeNull();
    expect(progressionMigrationNeeded()).toBe(true);
    const legacy = JSON.parse(storage._values.get(LEDGER_KEY));
    expect(legacy.xpTransactions).toHaveLength(2500);
    expect(readProgressionXpSummary(legacy)).toEqual({ total: 250000, count: 2500 });

    // Retry converges with nothing lost or double counted.
    storage._failWritesWhen(null);
    runProgressionLedgerMigration();
    expect(readXpIndex().count).toBe(2500);
    expect(readXpIndex().xpTotal).toBe(250000);
  });

  it('does not publish authority when the bounded progression document fails', () => {
    seedLegacyLedger(600);
    storage._failWritesWhen((key) => key === PROGRESSION_STATE_KEY);

    expect(() => runProgressionLedgerMigration()).toThrow(ProgressionPersistenceError);

    expect(readXpIndex()).toBeNull();
    expect(JSON.parse(storage._values.get(LEDGER_KEY)).xpTransactions).toHaveLength(600);

    storage._failWritesWhen(null);
    runProgressionLedgerMigration();
    expect(readXpIndex().count).toBe(600);
    expect(JSON.parse(storage._values.get(PROGRESSION_STATE_KEY)).xp).toEqual({ total: 60000, count: 600 });
  });

  it('keeps the legacy document when the ready header publication fails', () => {
    seedLegacyLedger(600);
    storage._failWritesWhen((key) => key === PROGRESSION_XP_INDEX_KEY);

    expect(() => runProgressionLedgerMigration()).toThrow(ProgressionPersistenceError);

    // No ready header, so the legacy array is untouched and still authoritative.
    expect(isProgressionXpStoreReady()).toBe(false);
    expect(JSON.parse(storage._values.get(LEDGER_KEY)).xpTransactions).toHaveLength(600);
    expect(progressionMigrationNeeded()).toBe(true);

    storage._failWritesWhen(null);
    runProgressionLedgerMigration();
    expect(readXpIndex().count).toBe(600);
  });

  it('does not lose the conversion checkpoint when its write fails', () => {
    seedLegacyLedger(2500);
    let checkpointWrites = 0;
    storage._failWritesWhen((key) => {
      if (key !== PROGRESSION_XP_MIGRATION_KEY) return false;
      checkpointWrites += 1;
      return checkpointWrites === 3;
    });

    expect(() => runProgressionLedgerMigration()).toThrow(ProgressionPersistenceError);
    expect(readXpIndex()).toBeNull();
    expect(JSON.parse(storage._values.get(LEDGER_KEY)).xpTransactions).toHaveLength(2500);

    storage._failWritesWhen(null);
    runProgressionLedgerMigration();
    expect(readXpIndex().count).toBe(2500);
  });

  it('is safe when post-cutover legacy cleanup never happens', () => {
    seedLegacyLedger(600);
    // Removal is a no-op: the legacy value survives the cutover.
    const realRemove = storage.removeItem;
    storage.removeItem = (key) => (key === LEDGER_KEY ? undefined : realRemove(key));

    runProgressionLedgerMigration();

    expect(isProgressionXpStoreReady()).toBe(true);
    expect(storage._values.has(LEDGER_KEY)).toBe(true);
    // The ready state ignores the stranded monolith entirely.
    const mark = storage._reads.length;
    const ledger = loadDriverProgressionLedger();
    expect(ledger.xpTransactions).toBeUndefined();
    expect(readProgressionXpSummary(ledger)).toEqual({ total: 60000, count: 600 });
    expect(storage._reads.slice(mark).some((read) => read.key === LEDGER_KEY)).toBe(false);
    storage.removeItem = realRemove;
  });

  it('does not advance the append authority when a segment write fails', () => {
    seedStore(600, 200);
    const before = readXpIndex();
    storage._failWritesWhen((key) => key.startsWith(PROGRESSION_XP_SEGMENT_PREFIX));

    // A batch that overflows the buffer has to seal it first.
    const batch = Array.from({ length: PROGRESSION_XP_SEGMENT_SIZE }, (_, offset) => transaction(1000 + offset));
    expect(() => appendXpTransactions(batch)).toThrow(ProgressionPersistenceError);

    expect(readXpIndex()).toEqual(before);
    storage._failWritesWhen(null);
    expect(appendXpTransactions(batch).appended).toBe(PROGRESSION_XP_SEGMENT_SIZE);
    expect(readXpIndex().count).toBe(600 + PROGRESSION_XP_SEGMENT_SIZE);
  });

  it('does not advance the append authority when the header publication fails', () => {
    seedStore(600, 200);
    const before = readXpIndex();
    storage._failWritesWhen((key) => key === PROGRESSION_XP_INDEX_KEY);

    expect(() => appendXpTransactions([transaction(9999)])).toThrow(ProgressionPersistenceError);

    // Previous header still authoritative; the new buffer generation is an
    // unreferenced orphan, not visible history.
    expect(readXpIndex()).toEqual(before);
    const page = readXpPage({ limit: PROGRESSION_XP_SEGMENT_SIZE });
    expect(page.entries.some((entry) => entry.id === 'xp:mission:w9999')).toBe(false);

    storage._failWritesWhen(null);
    expect(appendXpTransactions([transaction(9999)]).appended).toBe(1);
    expect(readXpIndex().count).toBe(601);
    expect(readXpPage({ limit: 5 }).entries[0].id).toBe('xp:mission:w9999');
  });

  // --- B1: the authoritative head record is never overwritten ---------------

  /** One batch, newest-first, all newer than everything already stored. */
  const batchOf = (start, size) => Array.from(
    { length: size },
    (_, offset) => transaction(start + size - 1 - offset)
  );

  const durableIds = () => {
    const ids = [];
    let cursor = null;
    for (;;) {
      const page = readXpPage({ cursor, limit: PROGRESSION_XP_SEGMENT_SIZE });
      ids.push(...page.entries.map((entry) => entry.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    return ids;
  };

  it('never overwrites the published head record when the header publication fails', () => {
    // The exact shape: two appends that leave a sealed segment plus a populated
    // buffer, then a third that must seal before it can publish.
    appendXpTransactions(batchOf(0, 150));
    appendXpTransactions(batchOf(150, 100));

    const headerBefore = storage._values.get(PROGRESSION_XP_INDEX_KEY);
    const indexBefore = readXpIndex();
    const headKeyBefore = `${PROGRESSION_XP_HEAD_PREFIX}${indexBefore.headGen}`;
    const headRecordBefore = storage._values.get(headKeyBefore);
    const idsBefore = durableIds();
    expect(idsBefore).toHaveLength(250);
    expect(indexBefore.count).toBe(250);

    // Allow every prerequisite segment/new-head write; fail only the publication.
    storage._failWritesWhen((key) => key === PROGRESSION_XP_INDEX_KEY);
    expect(() => appendXpTransactions(batchOf(250, 150))).toThrow(ProgressionPersistenceError);
    storage._failWritesWhen(null);

    // A fresh durable read sees exactly the previous state.
    expect(storage._values.get(PROGRESSION_XP_INDEX_KEY)).toBe(headerBefore);
    expect(storage._values.get(headKeyBefore)).toBe(headRecordBefore);
    const idsAfter = durableIds();
    expect(idsAfter).toEqual(idsBefore);
    expect(idsAfter).toHaveLength(250);
    for (const id of idsBefore) expect(idsAfter).toContain(id);
    for (const entry of batchOf(250, 150)) expect(idsAfter).not.toContain(entry.id);
    const indexAfter = readXpIndex();
    expect(indexAfter.count).toBe(250);
    expect(indexAfter.xpTotal).toBe(25000);
    expect(indexAfter.headGen).toBe(indexBefore.headGen);

    // Retry converges: every entry visible exactly once.
    expect(appendXpTransactions(batchOf(250, 150)).appended).toBe(150);
    const idsFinal = durableIds();
    expect(idsFinal).toHaveLength(400);
    expect(new Set(idsFinal).size).toBe(400);
    expect(readXpIndex().count).toBe(400);
    expect(readXpIndex().xpTotal).toBe(40000);
    expect(idsFinal[0]).toBe('xp:mission:w399');
    expect(idsFinal.at(-1)).toBe('xp:mission:w0');
  });

  it('gives every prospective head version a key the published header cannot reference', () => {
    appendXpTransactions(batchOf(0, 150));
    const first = readXpIndex();
    appendXpTransactions(batchOf(150, 100));
    const second = readXpIndex();
    appendXpTransactions(batchOf(250, 150));
    const third = readXpIndex();

    // Monotonic and never reused, including across the two sealing appends -
    // resetting to zero here is what let a failed publication replace the record
    // the previous header still pointed at.
    expect(second.headGen).toBeGreaterThan(first.headGen);
    expect(third.headGen).toBeGreaterThan(second.headGen);
    expect(readXpIndex().count).toBe(400);
  });

  it('keeps a notification cursor pointing at the same entries across a seal', () => {
    appendXpTransactions(batchOf(0, 150));
    const page = readXpPage({ limit: 40 });
    expect(page.entries).toHaveLength(40);
    const cursor = page.nextCursor;
    const expectedTail = durableIds().slice(40);

    // This append seals the buffer verbatim at its own index.
    appendXpTransactions(batchOf(150, 100));

    const resumed = [];
    let next = cursor;
    for (;;) {
      const continued = readXpPage({ cursor: next, limit: PROGRESSION_XP_SEGMENT_SIZE });
      resumed.push(...continued.entries.map((entry) => entry.id));
      if (!continued.hasMore) break;
      next = continued.nextCursor;
    }
    expect(resumed).toEqual(expectedTail);
  });

  // --- A2: an unprobeable environment must assume conversion debt -----------

  it('reports an unprobeable storage key as unknown rather than absent', () => {
    // Enumeration unsupported: the legacy document cannot be proved absent.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('legacy value must not be retrieved'); },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(storageKeyExists(LEDGER_KEY)).toBeNull();
    expect(progressionMigrationNeeded()).toBe(true);
    expect(readLegacySourceCounters().rawReads).toBe(0);

    // No storage subsystem at all is a different, knowable case: nothing durable
    // exists, so there is no debt and the UI is not stranded.
    vi.stubGlobal('localStorage', undefined);
    expect(storageKeyExists(LEDGER_KEY)).toBeNull();
    expect(progressionStorageAvailable()).toBe(false);
    expect(progressionMigrationNeeded()).toBe(false);
    expect(readLegacySourceCounters().rawReads).toBe(0);
  });

  it('assumes debt when key enumeration itself throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('legacy value must not be retrieved'); },
      setItem: () => {},
      removeItem: () => {},
      get length() { throw new Error('enumeration unavailable'); },
      key: () => null,
    });
    expect(storageKeyExists(LEDGER_KEY)).toBeNull();
    expect(progressionMigrationNeeded()).toBe(true);
    expect(readLegacySourceCounters().rawReads).toBe(0);
  });

  it('makes a published append visible exactly once across a restart boundary', () => {
    seedStore(300, 100);
    appendXpTransactions([transaction(5000, { id: 'xp:mission:once', sourceId: 'mission:once' })]);

    // "Restart": nothing in-memory survives; only the durable records do.
    const seen = [];
    let cursor = null;
    for (;;) {
      const page = readXpPage({ cursor, limit: PROGRESSION_XP_SEGMENT_SIZE });
      seen.push(...page.entries.map((entry) => entry.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen.filter((id) => id === 'xp:mission:once')).toHaveLength(1);
    expect(seen).toHaveLength(301);
    expect(readXpIndex().count).toBe(301);
  });

  // --- the other calendar-growing fields ------------------------------------

  it('retains the calendar dedupe maps on a fixed horizon, newest periods first', () => {
    // Ten years of weekly plans, weekly missions and monthly season challenges.
    const weeklyPlans = {};
    const missions = {};
    const seasons = {};
    for (let week = 0; week < 520; week += 1) {
      const key = new Date(Date.UTC(2020, 0, 6) + week * 7 * 86400000).toISOString().slice(0, 10);
      weeklyPlans[key] = { weekKey: key, activeMissionIds: [] };
      missions[`${key}:balanced`] = `${key}T00:00:00.000Z`;
    }
    for (let month = 0; month < 120; month += 1) {
      const key = `${2020 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`;
      seasons[`season:${key}:form`] = `${key}-01T00:00:00.000Z`;
    }

    const pruned = pruneProgressionLedger({ weeklyPlans, missions, seasons });

    expect(Object.keys(pruned.weeklyPlans)).toHaveLength(PROGRESSION_WEEKLY_PLAN_HORIZON);
    expect(Object.keys(pruned.missions)).toHaveLength(PROGRESSION_MISSION_HORIZON);
    expect(Object.keys(pruned.seasons)).toHaveLength(PROGRESSION_SEASON_HORIZON);
    // The retained keys are the newest periods, which are the only ones
    // `buildDriverProgression` and `buildSeason` ever read.
    const newestWeek = Object.keys(weeklyPlans).sort().at(-1);
    expect(pruned.weeklyPlans[newestWeek]).toBeDefined();
    expect(pruned.missions[`${newestWeek}:balanced`]).toBeDefined();
    expect(pruned.seasons[Object.keys(seasons).sort().at(-1)]).toBeDefined();
    // The whole retained document is a bounded parse whatever the install age.
    expect(JSON.stringify(pruned).length).toBeLessThan(40000);
  });

  it('erases every record it owns', () => {
    seedStore(600);
    expect(segmentKeys().length).toBeGreaterThan(1);

    clearProgressionXpStore();

    expect(segmentKeys()).toEqual([]);
    expect(storage._values.has(PROGRESSION_XP_INDEX_KEY)).toBe(false);
  });
});
