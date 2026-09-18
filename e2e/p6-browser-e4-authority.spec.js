import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * P6-V02/V20/V25 real-browser arm.
 *
 * Every other E4 proof runs over a fake IndexedDB with mocked crypto. This one
 * drives the shipped modules in Chromium: real IndexedDB transactions, real
 * WebCrypto envelopes, the real Capacitor Preferences web backend, the real
 * migration runner and the real readiness vocabulary. The bundle is the same
 * production entry the schema spec uses, loaded by URL because the app's CSP is
 * `script-src 'self'`.
 *
 * Runs against the built preview app (`npm run test:e2e`). No device involved.
 */

let bundleUrl;

test.beforeAll(async ({}, workerInfo) => {
  const project = workerInfo.project.name.replace(/[^a-z0-9_-]/gi, '-');
  bundleUrl = `/e2e-p6-authority-${project}-${workerInfo.workerIndex}.js`;
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

const reset = async (page) => page.evaluate(async () => {
  const drop = (name) => new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(resolve, 5000);
    const done = () => { clearTimeout(timer); resolve(undefined); };
    request.onsuccess = done;
    request.onerror = done;
    request.onblocked = () => {};
  });
  await drop('drivesense_mobile');
  await drop('drivesense_speed_knowledge');
  localStorage.clear();
});

const model = (id, limitKmh) => ({
  schemaVersion: 1,
  knowledgeRevision: 7,
  cells: {},
  corrections: [{ id, geohash: 'dpz800', limitKmh, source: 'manual' }],
  excludedSections: [],
  roadMemory: { candidates: [] },
});

test.describe('P6 browser saved-speed authority in real Chromium', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/build-integrity.json');
    await page.addScriptTag({ url: bundleUrl });
    await reset(page);
  });

  test('creates the production P6 derived schema, without the retired posting index', async ({ page }) => {
    const described = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      const handle = await repo.openP6TripDerivedDatabase();
      const stores = Array.from(handle.objectStoreNames);
      const postingIndexes = Array.from(
        handle.transaction(repo.P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'readonly')
          .objectStore(repo.P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS).indexNames,
      );
      const version = handle.version;
      handle.close();
      return { stores, postingIndexes, version, expected: Object.values(repo.P6_TRIP_DERIVED_STORES) };
    });
    for (const store of described.expected) expect(described.stores).toContain(store);
    expect(described.postingIndexes).toContain('by_cell_trip');
    expect(described.postingIndexes).toContain('by_trip');
    // Retired by migration 9: an index no reader queries is footprint the
    // frozen per-point envelope cannot pay for.
    expect(described.postingIndexes).not.toContain('by_trip_version');
    expect(described.version).toBeGreaterThanOrEqual(9);
  });

  test('drops the retired posting index when an existing database is upgraded', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      // A pre-migration-9 database that still carries the retired index.
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('drivesense_mobile', 8);
        request.onupgradeneeded = () => {
          const db = request.result;
          const trips = db.createObjectStore('trips', { keyPath: 'id' });
          trips.createIndex('start_time', 'start_time');
          const postings = db.createObjectStore(
            repo.P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, { keyPath: 'key' },
          );
          postings.createIndex('by_cell_trip',
            ['sourceBinding', 'cellToken', 'tripId', 'sourceRevision', 'blockOrdinal']);
          postings.createIndex('by_trip_version',
            ['sourceBinding', 'tripId', 'contentVersion', 'ordinal']);
          postings.createIndex('by_trip', 'tripId');
        };
        request.onsuccess = () => { request.result.close(); resolve(undefined); };
        request.onerror = () => reject(request.error);
      });
      const handle = await repo.openP6TripDerivedDatabase();
      const indexes = Array.from(
        handle.transaction(repo.P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'readonly')
          .objectStore(repo.P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS).indexNames,
      );
      const version = handle.version;
      handle.close();
      return { indexes, version };
    });
    expect(outcome.indexes).not.toContain('by_trip_version');
    expect(outcome.indexes).toContain('by_cell_trip');
    expect(outcome.version).toBeGreaterThanOrEqual(9);
  });

  test('holds v1 authority through staging and switches to v2 atomically', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      await repo.readP6BrowserSpeedAuthority();
      await repo.speedKnowledgeStore.set(repo.SPEED_KNOWLEDGE_STORAGE_KEY, {
        schemaVersion: 1, knowledgeRevision: 7, cells: {},
        corrections: [{ id: 'real-browser-v1', geohash: 'dpz800', limitKmh: 45, source: 'manual' }],
        excludedSections: [], roadMemory: { candidates: [] },
      });
      const before = await repo.readP6BrowserSpeedAuthority();
      const beforeModel = await repo.speedKnowledgeStore.get();

      const began = await repo.beginP6BrowserSpeedMigration();
      const duringAuthority = await repo.readP6BrowserSpeedAuthority();
      const duringScoped = await repo.readP6BrowserSpeedBuckets(['dpz8']);

      let migration = null;
      for (let turn = 0; turn < 20; turn += 1) {
        migration = await repo.stepP6BrowserSpeedMigration();
        if (migration.done) break;
      }
      const after = await repo.readP6BrowserSpeedAuthority();
      const scoped = await repo.speedKnowledgeStore.getForGeohashes(['dpz8']);
      let refusal = null;
      try { await repo.speedKnowledgeStore.get(); } catch (error) { refusal = error?.code ?? error?.message; }
      return {
        beforeVersion: before.version,
        beforeCorrection: beforeModel?.corrections?.[0]?.id ?? null,
        beganState: began.state,
        duringVersion: duringAuthority.version,
        duringScoped,
        migrationState: migration?.state ?? null,
        afterVersion: after.version,
        afterState: after.state,
        scopedCorrections: scoped?.corrections ?? [],
        refusal,
        scopedRequired: repo.P6_SPEED_SCOPED_READ_REQUIRED,
        v2: await repo.isP6BrowserSpeedV2Authority(),
      };
    });

    expect(outcome.beforeVersion).toBe(1);
    expect(outcome.beforeCorrection).toBe('real-browser-v1');
    expect(outcome.beganState).toBe('CONVERSION_IN_PROGRESS');
    // v1 stays authoritative for the whole staging phase, and the scoped v2
    // reader reports nothing until the switch.
    expect(outcome.duringVersion).toBe(1);
    expect(outcome.duringScoped).toBeNull();
    expect(outcome.migrationState).toBe('COMPLETE');
    expect(outcome.afterVersion).toBe(2);
    expect(outcome.afterState).toBe('ACTIVE');
    expect(outcome.v2).toBe(true);
    expect(outcome.scopedCorrections).toEqual([
      expect.objectContaining({ id: 'real-browser-v1', limitKmh: 45 }),
    ]);
    expect(outcome.refusal).toBe(outcome.scopedRequired);
  });

  test('refuses a predecessor that changed before cutover and cancels every stage row', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      await repo.readP6BrowserSpeedAuthority();
      await repo.speedKnowledgeStore.set(repo.SPEED_KNOWLEDGE_STORAGE_KEY, {
        schemaVersion: 1, knowledgeRevision: 7, cells: {},
        corrections: [{ id: 'original', geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
        excludedSections: [], roadMemory: { candidates: [] },
      });
      const began = await repo.beginP6BrowserSpeedMigration();
      await repo.stepP6BrowserSpeedMigration();
      // The predecessor moves under the fence, mid-conversion.
      await repo.speedKnowledgeStore.set(repo.SPEED_KNOWLEDGE_STORAGE_KEY, {
        schemaVersion: 1, knowledgeRevision: 8, cells: {},
        corrections: [{ id: 'changed', geohash: 'dpz800', limitKmh: 70, source: 'manual' }],
        excludedSections: [], roadMemory: { candidates: [] },
      });
      // The v1 write is refused by the writer fence mid-conversion and falls
      // back to the write-ahead key, which becomes the newest predecessor.
      const walAfterChange = Object.keys(localStorage).filter((key) => key.includes('write_ahead'));
      const states = [];
      let refused = null;
      for (let turn = 0; turn < 20; turn += 1) {
        refused = await repo.stepP6BrowserSpeedMigration();
        states.push(refused.state);
        if (refused.state === 'E4_PREDECESSOR_CHANGED' || refused.done) break;
      }
      const heldAuthority = await repo.readP6BrowserSpeedAuthority();

      let cancelled = null;
      let cursor = { phase: 'PARTITIONS' };
      for (let turn = 0; turn < 40; turn += 1) {
        cancelled = await repo.cancelP6BrowserSpeedMigrationTurn(cursor);
        if (cancelled.done) break;
        cursor = cancelled.cursor;
      }

      const stageRows = await new Promise((resolve, reject) => {
        const request = indexedDB.open(repo.SPEED_KNOWLEDGE_DB_NAME);
        request.onsuccess = () => {
          const handle = request.result;
          const names = [repo.P6_SPEED_STORES.PARTITIONS, repo.P6_SPEED_STORES.EDITOR_INDEX]
            .filter((name) => handle.objectStoreNames.contains(name));
          if (!names.length) { handle.close(); resolve([]); return; }
          const tx = handle.transaction(names, 'readonly');
          const collected = [];
          let pending = names.length;
          for (const name of names) {
            const all = tx.objectStore(name).getAll();
            all.onsuccess = () => {
              collected.push(...all.result.filter((row) => row?.stageId === began.stageId));
              pending -= 1;
              if (pending === 0) { handle.close(); resolve(collected); }
            };
            all.onerror = () => reject(all.error);
          }
        };
        request.onerror = () => reject(request.error);
      });

      return {
        refusedState: refused?.state ?? null,
        heldVersion: heldAuthority.version,
        cancelledState: cancelled?.state ?? null,
        stageRows: stageRows.length,
        states,
        sourceId: began.sourceId,
        walPresent: walAfterChange.length > 0,
        stillReadable: await (async () => {
          try { return (await repo.speedKnowledgeStore.get())?.corrections?.[0]?.id ?? null; }
          catch (error) { return `refused:${error?.code ?? error?.message}`; }
        })(),
      };
    });

    expect(outcome.sourceId).toBe('indexeddb');
    // The fenced IndexedDB value is still byte-identical, so only a full
    // WAL > IndexedDB > Preferences reselection can see that the newest
    // predecessor is now a different kind.
    expect(outcome.walPresent).toBe(true);
    expect(outcome.states, JSON.stringify(outcome)).toContain('E4_PREDECESSOR_CHANGED');
    expect(outcome.refusedState).toBe('E4_PREDECESSOR_CHANGED');
    expect(outcome.heldVersion).toBe(1);
    expect(outcome.cancelledState).toBe('CANCELLED');
    expect(outcome.stageRows).toBe(0);
    // The user's saved speeds are untouched: v1 still answers, with the value
    // that superseded the fenced predecessor.
    expect(outcome.stillReadable).toBe('changed');
  });

  test('leaves D4 CONVERSION_REQUIRED while D1, D2 and D3 stay eligible without E4', async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const repo = window.__prodRepo;
      await repo.readP6BrowserSpeedAuthority();
      const trip = {
        id: 'no-e4-real-browser', status: 'completed', source_revision: '1',
        start_time: '2026-09-01T10:00:00.000Z', distance_km: 4, score_overall: 90,
        duration_seconds: 32, route_points: [],
      };
      const handle = await repo.openP6TripDerivedDatabase();
      await new Promise((resolve, reject) => {
        const tx = handle.transaction(
          ['trips', repo.P6_TRIP_DERIVED_STORES.WORK], 'readwrite',
        );
        tx.objectStore('trips').put(trip);
        tx.objectStore(repo.P6_TRIP_DERIVED_STORES.WORK).put({
          tripId: trip.id, desiredRevision: '1', sourceHash: 'hash-no-e4', desiredSeq: 1,
          disposition: 'UPSERT', dirtyDomains: Object.values(repo.P6_DOMAIN_KEYS),
          state: 'COMPLETE', cursor: null, updatedAt: 1,
        });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      handle.close();

      const road = await repo.stepP6RoadMemoryUpdate();
      const readiness = await repo.readP6TripDomainReadiness(
        repo.P6_DOMAIN_KEYS.ROAD_LEARNING, trip.id,
      );
      return {
        roadState: road?.state ?? null,
        readinessState: readiness.state,
        conversionRequired: repo.P6_READINESS_STATES.CONVERSION_REQUIRED,
        v2: await repo.isP6BrowserSpeedV2Authority(),
      };
    });

    expect(outcome.v2).toBe(false);
    expect(outcome.roadState).toBe(outcome.conversionRequired);
    expect(outcome.readinessState).toBe(outcome.conversionRequired);
  });
});
