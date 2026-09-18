import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_URL = '/e2e-browser-rsas.js';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.join(ROOT, 'e2e/fixtures/browser-rsas-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    define: {
      'import.meta.env': JSON.stringify({
        MODE: 'test',
        DEV: false,
        PROD: true,
        VITE_P35_NATIVE_AUTHORITY: 'false',
      }),
    },
    alias: { '@': path.join(ROOT, 'src') },
    logLevel: 'silent',
  });
  const target = path.join(ROOT, 'dist', BUNDLE_URL.slice(1));
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, result.outputFiles[0].text, 'utf8');
  await rename(staging, target);
});

test('real Chromium streams a 52+ MiB browser trip into segmented canonical storage', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.addScriptTag({ url: BUNDLE_URL });

  const result = await page.evaluate(async () => {
    const { activeTripStore, browserActiveTripSpool, localTripRepository } = globalThis.__browserRsas;
    await browserActiveTripSpool.eraseAllForDataRights();
    const padding = 'x'.repeat(56 * 1024);
    const count = 970;
    const id = `chromium-rsas-${Date.now()}`;
    activeTripStore.set({ id, status: 'active', start_time: '2026-08-21T12:00:00.000Z', route_points: [] });
    let maxBuffer = 0;
    let maxRecent = 0;
    let maxOverview = 0;
    const quarters = [0, 0, 0, 0];
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      activeTripStore.addPoint({
        index,
        lat: 43 + index / 1_000_000,
        lng: -79 - index / 1_000_000,
        speed_kmh: 42,
        timestamp: new Date(Date.UTC(2026, 7, 21, 12, 0, index)).toISOString(),
        producer_fixture_padding: padding,
      });
      quarters[Math.min(3, Math.floor(index * 4 / count))] += performance.now() - started;
      const status = browserActiveTripSpool.status();
      maxBuffer = Math.max(maxBuffer, status.bufferBytes);
      maxRecent = Math.max(maxRecent, status.recentPoints);
      maxOverview = Math.max(maxOverview, status.overviewPoints);
    }
    const completed = await activeTripStore.completeBrowserCanonical({
      status: 'completed',
      end_time: '2026-08-22T12:00:00.000Z',
    });
    const metadata = await localTripRepository.create(completed);
    activeTripStore.clear();
    await activeTripStore.flush();
    const stream = await localTripRepository.getPayloadStream(id);
    let replayed = 0;
    let bytes = 0;
    for await (const point of stream) {
      if (point.index !== replayed || point.producer_fixture_padding.length !== padding.length) {
        throw new Error('Browser canonical replay diverged');
      }
      bytes += new TextEncoder().encode(JSON.stringify(point)).byteLength + 1;
      replayed += 1;
    }
    const activePreference = localStorage.getItem('drivesense_active_trip') || '';
    return {
      replayed,
      bytes,
      maxBuffer,
      maxRecent,
      maxOverview,
      canonicalRouteLength: metadata.route_points.length,
      rawCount: metadata.route_points_raw_count,
      activePreferenceBytes: new TextEncoder().encode(activePreference).byteLength,
      quarterRatio: quarters[0] > 0 ? quarters[3] / quarters[0] : 0,
    };
  });

  expect(result.replayed).toBe(970);
  expect(result.bytes).toBeGreaterThan(52 * 1024 * 1024);
  expect(result.maxBuffer).toBeLessThanOrEqual(64 * 1024);
  expect(result.maxRecent).toBeLessThanOrEqual(300);
  expect(result.maxOverview).toBeLessThanOrEqual(1_500);
  expect(result.canonicalRouteLength).toBe(0);
  expect(result.rawCount).toBe(970);
  expect(result.activePreferenceBytes).toBe(0);
  expect(result.quarterRatio).toBeLessThan(8);
});
