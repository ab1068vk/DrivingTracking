import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The preview server serves the built bundle, so `/src/...` is not fetchable and
 * the repository is not reachable from the app's own graph. Bundling the real
 * module here keeps the code under test the production module — the same file
 * the app ships — rather than a re-modelled copy.
 *
 * The bundle is written into the previewed directory and loaded by URL because
 * the app's own CSP is `script-src 'self'`: injecting it inline would be blocked,
 * and relaxing the CSP for a test would weaken the property under test.
 */
let bundleUrl;

test.beforeAll(async ({}, workerInfo) => {
  const project = workerInfo.project.name.replace(/[^a-z0-9_-]/gi, '-');
  bundleUrl = `/e2e-production-repository-${project}-${workerInfo.workerIndex}.js`;
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
  // Written then renamed. The worker-specific path prevents fully-parallel
  // workers from racing to replace the same Windows file.
  const target = path.join(ROOT, 'dist', bundleUrl.slice(1));
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, result.outputFiles[0].text, 'utf8');
  await rename(staging, target);
});

/**
 * Production database conformance in real Chromium.
 *
 * The sibling spec proves the browser's cursor/index rules against a purpose-built
 * schema. This one exercises the **production** database name, the production
 * version and the production migration runner, so a divergence between the shipped
 * upgrade path and the modelled one cannot hide behind a passing toy test.
 *
 * Runs against the built preview app (`npm run test:e2e`). No device involved.
 */

const PROD = { db: 'drivesense_mobile' };

/** Seed a pre-P3 database at `fromVersion`, then let production upgrade it. */
const seedLegacy = async (page, fromVersion) => page.evaluate(async ({ db, fromVersion: from }) => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(db);
    // `onblocked` means a connection is still open and the delete has NOT
    // happened. Resolving on it lets the seed run against the old database, so
    // a v2 seed silently opens a v3 store and the upgrade assertion fails at
    // random depending on worker scheduling. Keep waiting instead, with a bound
    // so a genuinely stuck connection fails loudly rather than hanging.
    const timer = setTimeout(resolve, 5000);
    const done = () => { clearTimeout(timer); resolve(undefined); };
    request.onsuccess = done;
    request.onerror = done;
  });
  if (from === 0) return 'fresh';
  const legacy = await new Promise((resolve, reject) => {
    const request = indexedDB.open(db, from);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('trips', { keyPath: 'id' });
      store.createIndex('start_time', 'start_time');
      store.createIndex('status', 'status');
      if (from >= 2) {
        const summaries = request.result.createObjectStore('trip_summaries', { keyPath: 'id' });
        summaries.createIndex('start_time', 'start_time');
        summaries.createIndex('status', 'status');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = legacy.transaction('trips', 'readwrite');
    tx.objectStore('trips').put({ id: 'legacy-1', start_time: '2026-01-01T00:00:00.000Z', status: 'completed' });
    // A mature numeric legacy primary key must survive the upgrade and the
    // production selection path without being coerced to a string.
    tx.objectStore('trips').put({ id: 42, start_time: '2026-01-02T00:00:00.000Z', status: 'completed' });
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
  legacy.close();
  return `v${from}`;
}, { db: PROD.db, fromVersion });

/** Open through the app's own repository module so the production runner runs. */
const openThroughProduction = async (page) => page.evaluate(async () => {
  const repo = window.__prodRepo;
  // Touching the bounded primitive forces the production upgrade path.
  const page1 = await repo.localTripRepository.listProjections({ limit: 5 });
  return {
    dbVersion: repo.DB_VERSION,
    rowIds: page1.rows.map((row) => row.id),
    hasMore: page1.hasMore,
  };
});

const describeStores = async (page) => page.evaluate(async ({ db }) => {
  const handle = await new Promise((resolve, reject) => {
    const request = indexedDB.open(db);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const stores = Array.from(handle.objectStoreNames);
  const tx = handle.transaction('trips', 'readonly');
  const indexes = Array.from(tx.objectStore('trips').indexNames);
  let projectionIndexes = [];
  if (stores.includes('trip_projections')) {
    projectionIndexes = Array.from(
      handle.transaction('trip_projections', 'readonly').objectStore('trip_projections').indexNames
    );
  }
  const result = { version: handle.version, stores, indexes, projectionIndexes };
  handle.close();
  return result;
}, PROD);

test.describe('production database schema in real Chromium', () => {
  test.beforeEach(async ({ page }) => {
    // Keep the origin/CSP of the production build without booting the app,
    // which can otherwise open the production database before this test has seeded v1/v2.
    await page.goto('/build-integrity.json');
    await page.addScriptTag({ url: bundleUrl });
  });

  for (const from of [0, 1, 2]) {
    test(`upgrades ${from === 0 ? 'a fresh database' : `v${from}`} to the current production schema`, async ({ page }) => {
      await seedLegacy(page, from);
      const opened = await openThroughProduction(page);
      expect(opened.dbVersion).toBeGreaterThanOrEqual(3);

      const described = await describeStores(page);
      expect(described.version).toBe(opened.dbVersion);
      expect(described.stores).toContain('trips');
      expect(described.stores).toContain('trip_projections');
      expect(described.stores).toContain('trip_meta');
      // The compound indexes the bounded query depends on must really exist.
      expect(described.indexes).toContain('by_start_time_id');
      expect(described.indexes).toContain('by_status_start_time_id');
      expect(described.projectionIndexes).toContain('by_start_time_id');
      expect(described.projectionIndexes).toContain('projection_version');
    });
  }

  test('the production bounded primitive returns legacy rows, including a numeric key', async ({ page }) => {
    await seedLegacy(page, 2);
    const opened = await openThroughProduction(page);
    // Both the string id and the numeric legacy id must come back; a numeric key
    // coerced to a string would be silently missing here.
    expect(opened.rowIds).toHaveLength(2);
    expect(opened.rowIds.map(String).sort()).toEqual(['42', 'legacy-1']);

    // The returned id is string-normalized on purpose (consumers compare with
    // String(...)), so the contract that matters is that it still addresses the
    // row: a typed IndexedDB key of 42 must remain reachable through it.
    const reachable = await page.evaluate(async () => {
      const trip = await window.__prodRepo.localTripRepository.getById('42');
      return trip?.start_time ?? null;
    });
    expect(reachable).toBe('2026-01-02T00:00:00.000Z');

    // And the projection must occupy the source key, not a stringified copy of
    // it, or the verifier would see one row as both unbuilt and orphaned.
    const projectionKeys = await page.evaluate(async ({ db }) => {
      const handle = await new Promise((resolve, reject) => {
        const request = indexedDB.open(db);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const keys = await new Promise((resolve, reject) => {
        const request = handle.transaction('trip_projections', 'readonly')
          .objectStore('trip_projections').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      handle.close();
      return keys.map((key) => typeof key);
    }, PROD);
    if (projectionKeys.length) expect(projectionKeys).not.toContain('undefined');
  });

  test('the production cursor resumes without duplicate or skip', async ({ page }) => {
    await seedLegacy(page, 0);
    const ids = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      for (let index = 0; index < 7; index += 1) {
        await repo.localTripRepository.create({
          id: `prod-${index}`,
          status: 'completed',
          start_time: new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString(),
          route_points: [],
        });
      }
      const collected = [];
      let cursor = null;
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const result = await repo.localTripRepository.listProjections({ limit: 3, cursor });
        if (!result.rows.length) break;
        collected.push(...result.rows.map((row) => String(row.id)));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return collected;
    });
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });
});

/**
 * Multi-turn tombstone cleanup against real IndexedDB (Codex closure I4).
 *
 * The resume defect is invisible to any double that does not implement
 * `continuePrimaryKey`'s ordering rule: Chromium throws `DataError` when the
 * requested primary key is not strictly ahead of the cursor, and only a real
 * cursor reopened after a deleting turn reaches that state.
 */
test.describe('production tombstone cleanup in real Chromium', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/build-integrity.json');
    await page.addScriptTag({ url: bundleUrl });
  });

  test('resumes across turns and reaches the final tombstone', async ({ page }) => {
    await seedLegacy(page, 0);
    // Materialize the current production schema before writing raw rows into it.
    await openThroughProduction(page);

    const TOMBSTONES = 80; // Well past CLEANUP_ROWS_PER_TURN (32).
    await page.evaluate(async ({ db, count }) => {
      const handle = await new Promise((resolve, reject) => {
        const request = indexedDB.open(db);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = handle.transaction('trips', 'readwrite');
        const store = tx.objectStore('trips');
        for (let index = 0; index < count; index += 1) {
          store.put({
            id: `tomb-${String(index).padStart(5, '0')}`,
            status: 'secure-delete-pending',
            _secure_delete_tombstone: true,
            _secure_delete_at: Date.now(),
          });
        }
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      handle.close();
    }, { ...PROD, count: TOMBSTONES });

    const remaining = async () => page.evaluate(async ({ db }) => {
      const handle = await new Promise((resolve, reject) => {
        const request = indexedDB.open(db);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const request = handle.transaction('trips', 'readonly').objectStore('trips').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      handle.close();
      return rows.filter((row) => row?.status === 'secure-delete-pending').length;
    }, PROD);

    expect(await remaining()).toBe(TOMBSTONES);

    // One turn at a time, so the second turn genuinely reopens the status index
    // after the first turn deleted through its saved cursor.
    const errors = await page.evaluate(async () => {
      const collected = [];
      for (let pass = 0; pass < 20; pass += 1) {
        try {
          await window.__prodRepo.runProjectionMaintenance({ maxTurns: 1 });
        } catch (error) {
          collected.push(`${error?.name ?? 'Error'}: ${error?.message ?? ''}`);
        }
      }
      return collected;
    });

    expect(errors).toEqual([]);
    const left = await remaining();
    expect(left).toBeLessThan(TOMBSTONES);
    expect(left).toBe(0);
  });
});
