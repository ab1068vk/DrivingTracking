import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * P7-IMPL-F06 — the growth law through the **production** browser read.
 *
 * The sibling campaign (`p7-scale-campaign.spec.js`) measures real Chromium
 * IndexedDB at five tiers, and Codex accepted that storage-engine result. Its
 * objection was that the campaign built a production-*shaped* database and then
 * ran its own copy of the keyset trace: it proves the browser behaves, not that
 * the shipping read does. A mis-shaped range or a stray whole-store read inside
 * `queryTripHistoryPage` would pass it untouched.
 *
 * So this spec seeds through the **production repository** and reads through
 * **production Q1**, with every count taken outside the implementation:
 *
 *   - `IDBObjectStore`/`IDBIndex` prototype counters for source rows visited,
 *     whole-store `getAll` calls, cursor opens, keyed gets and transactions;
 *   - `crypto.subtle.decrypt` counted at the Web Crypto boundary, which is
 *     where a projection decrypt and a full-trip decrypt both have to go;
 *   - the serialized byte size of what Q1 actually returned.
 *
 * Two tiers, a small one and a large one, are enough to falsify the law: the
 * claim is not that a page is fast, it is that **fixed request work does not
 * grow with unrelated retained history**. Mechanically repeating five tiers of
 * a curve that is either flat or not adds no information.
 *
 * Runs against the built preview app. No device is involved.
 */

const PROD_DB = 'drivesense_mobile';

/** A small and a large retained history. The gap is what makes it falsifiable. */
const SMALL = 128;
const LARGE = 5000;

/** The page every tier is measured at. */
const PAGE = 25;

let bundleUrl;

test.beforeAll(async ({}, workerInfo) => {
  const project = workerInfo.project.name.replace(/[^a-z0-9_-]/gi, '-');
  bundleUrl = `/e2e-p7-production-path-${project}-${workerInfo.workerIndex}.js`;
  const result = await build({
    entryPoints: [path.join(ROOT, 'e2e/fixtures/production-repository-entry.js')],
    bundle: true,
    format: 'iife',
    globalName: '__prodRepo',
    platform: 'browser',
    write: false,
    define: { 'import.meta.env': JSON.stringify({ MODE: 'test', DEV: false, PROD: true }) },
    alias: { '@': path.join(ROOT, 'src') },
    logLevel: 'silent',
  });
  const target = path.join(ROOT, 'dist', bundleUrl.slice(1));
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, result.outputFiles[0].text, 'utf8');
  await rename(staging, target);
});

/**
 * Seed `count` drives through the production write path, then read one page
 * through production Q1 with independent counters running.
 *
 * The seed is deliberately *not* measured: the law is about the cost of a read,
 * and writing a history obviously costs one write per drive.
 */
const runProductionTier = async (page, { db, count, pageSize }) => page.evaluate(
  async ({ db, count, pageSize }) => {
    const repo = window.__prodRepo;

    // ---- cold storage ----------------------------------------------------
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(db);
      const timer = setTimeout(resolve, 8000);
      const done = () => { clearTimeout(timer); resolve(undefined); };
      request.onsuccess = done; request.onerror = done;
    });

    // ---- seed through the production repository ---------------------------
    const BASE = Date.UTC(2026, 0, 1);
    const DAY = 86400000;
    const trips = [];
    for (let index = 0; index < count; index += 1) {
      trips.push({
        // Ids run opposite to chronology, so an answer ordered by key rather
        // than by the requested sort is visibly wrong.
        id: `trip-${String(count - index).padStart(6, '0')}`,
        start_time: new Date(BASE + index * DAY).toISOString(),
        end_time: new Date(BASE + index * DAY + 900000).toISOString(),
        status: index % 23 === 0 ? 'draft' : 'completed',
        distance_km: 5 + (index % 17),
        duration_seconds: 900,
        score_overall: 60 + (index % 40),
        score_confidence: 0.9,
        harsh_brakes_count: index % 4,
        rapid_accel_count: index % 3,
        sharp_turns_count: index % 5,
        speeding_events_count: index % 6,
        route_points: [
          { lat: 43.6 + index * 1e-5, lng: -79.4, timestamp: BASE + index * DAY },
          { lat: 43.61 + index * 1e-5, lng: -79.41, timestamp: BASE + index * DAY + 60000 },
        ],
      });
      // `upsertMany` admits at most 32 logical writes per call — a production
      // rule, so the seed respects it rather than routing around it.
      if (trips.length >= 32 || index === count - 1) {
        await repo.localTripRepository.upsertMany(trips.splice(0, trips.length));
      }
    }

    // ---- independent observation, installed AFTER the seed ----------------
    const counts = {
      sourceRowsVisited: 0,
      wholeStoreGetAlls: 0,
      cursorOpens: 0,
      keyedGets: 0,
      transactions: 0,
      subtleDecrypts: 0,
    };
    const originals = {
      getAll: IDBObjectStore.prototype.getAll,
      indexGetAll: IDBIndex.prototype.getAll,
      getAllKeys: IDBObjectStore.prototype.getAllKeys,
      openCursor: IDBIndex.prototype.openCursor,
      storeOpenCursor: IDBObjectStore.prototype.openCursor,
      get: IDBObjectStore.prototype.get,
      transaction: IDBDatabase.prototype.transaction,
      decrypt: crypto.subtle.decrypt,
    };

    const mine = (store) => {
      try {
        const name = store?.transaction?.db?.name ?? store?.objectStore?.transaction?.db?.name;
        return name === db;
      } catch { return false; }
    };
    // A cursor delivery is one source row the storage layer actually handed
    // over. Real IndexedDB reuses one `IDBCursor` across `continue()`, so this
    // is counted at `success`, which fires once per row produced.
    const watchCursor = (request) => {
      request.addEventListener('success', () => {
        if (request.result) counts.sourceRowsVisited += 1;
      });
      return request;
    };

    IDBObjectStore.prototype.getAll = function patched(...args) {
      if (mine(this)) counts.wholeStoreGetAlls += 1;
      return originals.getAll.apply(this, args);
    };
    IDBIndex.prototype.getAll = function patched(...args) {
      if (mine(this)) counts.wholeStoreGetAlls += 1;
      return originals.indexGetAll.apply(this, args);
    };
    IDBObjectStore.prototype.getAllKeys = function patched(...args) {
      if (mine(this)) counts.wholeStoreGetAlls += 1;
      return originals.getAllKeys.apply(this, args);
    };
    IDBIndex.prototype.openCursor = function patched(...args) {
      if (!mine(this)) return originals.openCursor.apply(this, args);
      counts.cursorOpens += 1;
      return watchCursor(originals.openCursor.apply(this, args));
    };
    IDBObjectStore.prototype.openCursor = function patched(...args) {
      if (!mine(this)) return originals.storeOpenCursor.apply(this, args);
      counts.cursorOpens += 1;
      return watchCursor(originals.storeOpenCursor.apply(this, args));
    };
    IDBObjectStore.prototype.get = function patched(...args) {
      if (mine(this)) counts.keyedGets += 1;
      return originals.get.apply(this, args);
    };
    IDBDatabase.prototype.transaction = function patched(...args) {
      if (this?.name === db) counts.transactions += 1;
      return originals.transaction.apply(this, args);
    };
    // Every projection decrypt and every full-trip decrypt goes through here.
    crypto.subtle.decrypt = function patched(...args) {
      counts.subtleDecrypts += 1;
      return originals.decrypt.apply(crypto.subtle, args);
    };

    const restore = () => {
      IDBObjectStore.prototype.getAll = originals.getAll;
      IDBIndex.prototype.getAll = originals.indexGetAll;
      IDBObjectStore.prototype.getAllKeys = originals.getAllKeys;
      IDBIndex.prototype.openCursor = originals.openCursor;
      IDBObjectStore.prototype.openCursor = originals.storeOpenCursor;
      IDBObjectStore.prototype.get = originals.get;
      IDBDatabase.prototype.transaction = originals.transaction;
      crypto.subtle.decrypt = originals.decrypt;
    };

    try {
      repo.__resetProjectionCountersForTests();
      const started = performance.now();
      // ---- the production read, exactly as the app issues it --------------
      const result = await repo.queryTripHistoryPage({
        sort: '-start_time', status: 'completed', limit: pageSize,
      });
      const elapsedMs = performance.now() - started;
      const repositoryCounters = repo.__projectionCountersForTests();

      return {
        counts: { ...counts },
        repositoryCounters,
        elapsedMs,
        unavailable: result.unavailable ?? null,
        completeness: result.completeness,
        hasContinuation: result.continuation != null,
        rows: (result.data ?? []).map((row) => ({ id: row.id, start_time: row.start_time, status: row.status })),
        // What actually crossed back to the caller.
        payloadBytes: new TextEncoder().encode(JSON.stringify(result.data ?? [])).length,
        routePointsInPayload: (result.data ?? []).reduce(
          (sum, row) => sum + (Array.isArray(row.route_points) ? row.route_points.length : 0), 0
        ),
      };
    } finally {
      restore();
    }
  },
  { db, count, pageSize },
);

const bootstrap = async (page) => {
  // The production origin and CSP, without booting the app — the app would
  // otherwise open the production database while the tier is being seeded.
  await page.goto('/build-integrity.json');
  await page.addScriptTag({ url: bundleUrl });
};

test.describe('P7-IMPL-F06 — production Q1 over real Chromium IndexedDB', () => {
  test.setTimeout(600_000);

  test('fixed page work does not grow with retained history', async ({ page }) => {
    await bootstrap(page);

    const small = await runProductionTier(page, { db: PROD_DB, count: SMALL, pageSize: PAGE });
    const large = await runProductionTier(page, { db: PROD_DB, count: LARGE, pageSize: PAGE });

    for (const [label, tier, count] of [['small', small, SMALL], ['large', large, LARGE]]) {
      expect(tier.unavailable, label).toBeNull();
      expect(tier.rows.length, label).toBe(PAGE);
      expect(tier.rows.every((row) => row.status === 'completed'), label).toBe(true);
      // Newest first, against ids that run the other way.
      const times = tier.rows.map((row) => Date.parse(row.start_time));
      expect(times, label).toEqual([...times].sort((a, b) => b - a));
      expect(tier.hasContinuation, label).toBe(true);
      console.log(`[P7-F06] tier=${count} sourceRows=${tier.counts.sourceRowsVisited} `
        + `getAlls=${tier.counts.wholeStoreGetAlls} cursorOpens=${tier.counts.cursorOpens} `
        + `keyedGets=${tier.counts.keyedGets} transactions=${tier.counts.transactions} `
        + `subtleDecrypts=${tier.counts.subtleDecrypts} bytes=${tier.payloadBytes} `
        + `fullTripDecrypts=${tier.repositoryCounters.fullTripDecrypts} `
        + `ms=${tier.elapsedMs.toFixed(1)}`);
    }

    // ---- the law, stated as equalities ------------------------------------
    //
    // Forty times the retained history. Every one of these is the *same*
    // number, not a similar one: a page that visited more rows, opened more
    // cursors, decrypted more records or returned more bytes because more
    // history exists behind it is the failure this phase removes.
    expect(large.counts.sourceRowsVisited).toBe(small.counts.sourceRowsVisited);
    expect(large.counts.cursorOpens).toBe(small.counts.cursorOpens);
    expect(large.counts.keyedGets).toBe(small.counts.keyedGets);
    expect(large.counts.transactions).toBe(small.counts.transactions);
    expect(large.counts.subtleDecrypts).toBe(small.counts.subtleDecrypts);

    // Payload bytes are the one measurement that cannot be an equality, and the
    // reason is the fixture rather than the code: the two tiers return a
    // different 25 drives, and `5 + (index % 17)` is one digit for some and two
    // for others. The claim is that the payload is **a page**, so it is bounded
    // per row and does not scale with the history — measured at well under one
    // percent across a 40x larger store.
    expect(Math.abs(large.payloadBytes - small.payloadBytes) / small.payloadBytes)
      .toBeLessThan(0.01);
    expect(large.payloadBytes / PAGE).toBeLessThan(64 * 1024);

    // And the absolute bounds, not merely the flatness.
    expect(small.counts.wholeStoreGetAlls).toBe(0);
    expect(large.counts.wholeStoreGetAlls).toBe(0);
    expect(large.counts.sourceRowsVisited).toBeLessThanOrEqual(PAGE + 1);
    expect(large.repositoryCounters.fullTripDecrypts).toBe(0);
    expect(large.repositoryCounters.projectionDecrypts).toBeLessThanOrEqual(PAGE);
    // Route geometry is not in the projection, so no page carries route points.
    expect(large.routePointsInPayload).toBe(0);
  });

  test('production Q1 pages to EOF without duplicate or skip at scale', async ({ page }) => {
    await bootstrap(page);
    // A smaller history here: the property under test is the continuation's
    // correctness over many turns, and paging 5,000 drives 25 at a time would
    // spend ten minutes re-proving the bound the first test already measured.
    const seen = await page.evaluate(async ({ db, count, pageSize }) => {
      const repo = window.__prodRepo;
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(db);
        const timer = setTimeout(resolve, 8000);
        const done = () => { clearTimeout(timer); resolve(undefined); };
        request.onsuccess = done; request.onerror = done;
      });
      const BASE = Date.UTC(2026, 0, 1);
      const DAY = 86400000;
      const batch = [];
      for (let index = 0; index < count; index += 1) {
        batch.push({
          id: `trip-${String(count - index).padStart(6, '0')}`,
          start_time: new Date(BASE + index * DAY).toISOString(),
          end_time: new Date(BASE + index * DAY + 900000).toISOString(),
          status: 'completed',
          distance_km: 8,
          duration_seconds: 900,
          score_overall: 70,
        });
      }
      for (let start = 0; start < batch.length; start += 32) {
        await repo.localTripRepository.upsertMany(batch.slice(start, start + 32));
      }

      const ids = [];
      let cursor = null;
      let turns = 0;
      for (; turns < 200; turns += 1) {
        const result = await repo.queryTripHistoryPage({
          sort: '-start_time', status: 'completed', limit: pageSize, cursor,
        });
        if (result.unavailable) return { error: result.unavailable, ids, turns };
        ids.push(...result.data.map((row) => String(row.id)));
        cursor = result.continuation;
        if (!cursor) break;
      }
      return { error: null, ids, turns: turns + 1 };
    }, { db: PROD_DB, count: SMALL, pageSize: PAGE });

    expect(seen.error).toBeNull();
    expect(seen.ids).toHaveLength(SMALL);
    expect(new Set(seen.ids).size).toBe(SMALL);
    expect(seen.turns).toBe(Math.ceil(SMALL / PAGE));
  });
});
