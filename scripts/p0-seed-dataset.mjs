#!/usr/bin/env node
/**
 * Deterministic P0 fixture generator.
 *
 * Produces the trip-dataset and diagnostic-store fixtures the device matrix
 * needs, each with a content hash. The same fixture must be restored and
 * hash-verified before every arm, or an A/B comparison is measuring two
 * different datasets.
 *
 * Deterministic by construction: a seeded PRNG, no `Math.random()`, and no
 * implicit `Date.now()` — the fixture epoch is an explicit input (`--epoch`)
 * that is recorded in the manifest, so re-running with the same arguments
 * yields the same bytes and the same hash.
 *
 * Three properties this file is careful about, each a real failure we hit:
 *
 * 1. **Retention validity.** Diagnostic entries are dated *backwards from the
 *    fixture epoch*, inside each store's own retention window. A fixed calendar
 *    epoch produced a "saturated" store whose every entry was already older than
 *    the 90-day cutoff, so the first prune emptied it and the saturated cell
 *    measured an empty store.
 * 2. **Restorability.** The trip dataset is emitted as a real Road Sage backup
 *    envelope (`version: BACKUP_VERSION`), not an ad-hoc object, so the campaign
 *    restores it through the app's supported import path. `--verify` re-hashes a
 *    fixture before a run.
 * 3. **Bounded memory.** The largest prescribed cell is 3,000 trips x 12,000
 *    route points. Building that array and then `JSON.stringify`-ing it holds
 *    the whole dataset plus its serialization at once. Trips are streamed to
 *    disk one at a time and hashed incrementally instead.
 *
 * Usage:
 *   node scripts/p0-seed-dataset.mjs --trips 3000 --shape large --epoch 2026-08-15T08:00:00Z --out fixtures/
 *   node scripts/p0-seed-dataset.mjs --stores saturated --epoch 2026-08-15T08:00:00Z --out fixtures/
 *   node scripts/p0-seed-dataset.mjs --verify fixtures/manifest.json
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

/**
 * Only run the CLI when invoked directly. The pure builders below are imported
 * by tests, and a module that runs `process.exit` on import cannot be tested.
 */
const isMain = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

/** Must match `dataBackup.js`. A mismatch makes the fixture unimportable. */
const BACKUP_VERSION = 10;

/** Retention windows, mirrored from the owning modules. */
export const RETENTION_MS = {
  roadsage_performance_history_v1: 90 * 24 * 60 * 60 * 1000,   // performanceTriage.js
  drivesense_system_logs_v1: 3 * 24 * 60 * 60 * 1000,          // systemLog.js
  roadsage_app_experience_events_v1: 90 * 24 * 60 * 60 * 1000, // appExperienceDiagnostics.js
};

/** Route-point counts taken from the real exercised export. */
const SHAPES = {
  p50: { points: 180, distanceKm: 2.1, durationMinutes: 7 },
  p95: { points: 3659, distanceKm: 67.6, durationMinutes: 62 },
  large: { points: 12000, distanceKm: 210, durationMinutes: 190 },
};

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Spread `count` entries backwards from the epoch, filling the safe fraction of
 * the retention window.
 *
 * The newest entry sits at the epoch and the oldest at `safetyFraction` of the
 * window, so every entry survives the first prune with margin — a fixture whose
 * entries expire on contact measures an empty store, not a saturated one.
 */
export function retentionSafeTimestamps(count, epochMs, retentionMs, safetyFraction = 0.5) {
  if (count <= 0) return [];
  const span = retentionMs * safetyFraction;
  const step = count > 1 ? span / (count - 1) : 0;
  const stamps = new Array(count);
  for (let index = 0; index < count; index += 1) {
    // index 0 is the oldest, count-1 the newest (at the epoch).
    stamps[index] = new Date(epochMs - span + index * step).toISOString();
  }
  return stamps;
}

const buildTrip = (index, shape, random, epochMs) => {
  // Trips march backwards from the epoch so the newest is "now".
  const startMs = epochMs - (index + 1) * 6 * 60 * 60 * 1000;
  const endMs = startMs + shape.durationMinutes * 60 * 1000;
  const routePoints = [];
  let lat = 51.5 + random() * 0.05;
  let lng = -0.12 + random() * 0.05;
  for (let point = 0; point < shape.points; point += 1) {
    lat += (random() - 0.5) * 0.0008;
    lng += (random() - 0.5) * 0.0008;
    routePoints.push({
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      speed_kmh: Math.round(random() * 110),
      timestamp: new Date(startMs + point * 2000).toISOString(),
    });
  }
  return {
    id: `p0_fixture_trip_${String(index).padStart(6, '0')}`,
    status: 'completed',
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(endMs).toISOString(),
    created_at: new Date(startMs).toISOString(),
    updated_at: new Date(endMs).toISOString(),
    distance_km: shape.distanceKm,
    duration_seconds: shape.durationMinutes * 60,
    route_points: routePoints,
    route_points_raw_count: routePoints.length,
    route_points_map_count: routePoints.length,
    driving_events: [],
    schema_version: 27,
  };
};

export const buildDiagnosticStores = (saturated, epochMs) => {
  const counts = saturated
    ? { perf: 2500, logs: 2500, experience: 4000 }
    : { perf: 0, logs: 0, experience: 0 };

  const perfStamps = retentionSafeTimestamps(
    counts.perf, epochMs, RETENTION_MS.roadsage_performance_history_v1
  );
  const logStamps = retentionSafeTimestamps(
    counts.logs, epochMs, RETENTION_MS.drivesense_system_logs_v1
  );
  const experienceStamps = retentionSafeTimestamps(
    counts.experience, epochMs, RETENTION_MS.roadsage_app_experience_events_v1
  );

  const perf = perfStamps.map((at, index) => ({
    id: `fixture_perf_${index}`,
    sessionId: 'p0_fixture_session',
    name: 'fixture.measure',
    durationMs: (index % 500) + 1,
    at,
    pathname: '/',
    outcome: 'success',
    context: {
      trip_count: 0, completed_trip_count: 0, total_distance_km: 0,
      route_point_count: 0, data_size_bytes: 0,
    },
  }));

  const logs = logStamps.map((timestamp, index) => ({
    id: `fixture_log_${index}`,
    timestamp,
    severity: 'info',
    category: 'app',
    source: 'web',
    operation: 'fixture_event',
    title: 'Fixture event',
    message: '',
    page: '/',
    details: { index, filler: 'x'.repeat(64) },
  }));

  const experience = experienceStamps.map((timestamp, index) => ({
    timestamp,
    severity: 'info',
    category: 'app',
    source: 'web',
    operation: 'fixture_event',
    page: '/',
    details: { index, filler: 'x'.repeat(64) },
  }));

  return {
    roadsage_performance_history_v1: perf,
    drivesense_system_logs_v1: logs,
    roadsage_app_experience_events_v1: experience,
  };
};

/**
 * Stream a restorable backup envelope to disk, hashing as it goes.
 *
 * Trips are generated, serialized and released one at a time, so peak memory is
 * one trip rather than the whole dataset plus its JSON.
 */
async function writeTripBackupStreaming({ path, tripCount, shape, shapeName, random, epochMs }) {
  const hash = createHash('sha256');
  const stream = createWriteStream(path);
  let bytes = 0;

  const push = async (text) => {
    hash.update(text);
    bytes += Buffer.byteLength(text);
    if (!stream.write(text)) await once(stream, 'drain');
  };

  // The envelope the app's importer accepts, field order fixed for determinism.
  await push('{\n');
  await push('  "app": "Road Sage",\n');
  await push(`  "version": ${BACKUP_VERSION},\n`);
  await push(`  "export_id": "p0_fixture_${tripCount}_${shapeName}",\n`);
  await push(`  "exported_at": ${JSON.stringify(new Date(epochMs).toISOString())},\n`);
  await push('  "fixture": {\n');
  await push('    "fixture_kind": "p0_trip_dataset",\n');
  await push(`    "trip_count": ${tripCount},\n`);
  await push(`    "shape": ${JSON.stringify(shapeName)},\n`);
  await push(`    "route_points_per_trip": ${shape.points},\n`);
  await push(`    "total_route_points": ${tripCount * shape.points}\n`);
  await push('  },\n');
  await push('  "settings": {},\n');
  await push('  "ui": { "saved_trip_filters": [] },\n');
  await push('  "calibration": { "labels": [], "survey_markers": [] },\n');
  await push('  "speed_knowledge": [],\n');
  await push('  "vehicles": [],\n');
  await push('  "trips": [\n');

  for (let index = 0; index < tripCount; index += 1) {
    const trip = buildTrip(index, shape, random, epochMs);
    await push(`    ${JSON.stringify(trip)}${index === tripCount - 1 ? '' : ','}\n`);
  }

  await push('  ]\n}\n');
  stream.end();
  await once(stream, 'finish');
  return { hash: hash.digest('hex'), bytes };
}

const hashFile = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', reject);
});

async function main() {
  // ---------------------------------------------------------------------------
  // Verify mode: re-hash every fixture named in a manifest before a measured run.
  // ---------------------------------------------------------------------------

  if (args.includes('--verify')) {
    const manifestPath = argValue('--verify', 'p0-fixtures/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dir = manifestPath.replace(/[^\/\\]+$/, '');
    let failures = 0;
    for (const [name, expected] of Object.entries(manifest.fixtures || {})) {
      const actual = await hashFile(join(dir, name));
      const ok = actual === expected;
      if (!ok) failures += 1;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  expected=${expected}  actual=${actual}`);
    }
    if (failures) {
      console.error(`\n${failures} fixture(s) do not match the manifest. Do not run the arm on this data.`);
      process.exit(1);
    }
    console.log('\nAll fixtures match the manifest.');
    process.exit(0);
  }

  const outDir = argValue('--out', 'p0-fixtures');
  mkdirSync(outDir, { recursive: true });

  // Explicit and recorded: the same `--epoch` reproduces the same bytes, and the
  // entries stay inside their retention windows relative to it.
  const epochArg = argValue('--epoch', null);
  if (!epochArg) {
    console.error(
      'Refusing to generate without --epoch.\n'
      + 'Fixture dates are relative to the intended run epoch; defaulting to the wall clock would make\n'
      + 'the fixture irreproducible and could place entries outside their retention windows.\n'
      + 'Example: --epoch 2026-08-15T08:00:00Z'
    );
    process.exit(1);
  }
  const epochMs = Date.parse(epochArg);
  if (!Number.isFinite(epochMs)) {
    console.error(`Unparseable --epoch: ${epochArg}`);
    process.exit(1);
  }

  const write = (name, payload) => {
    const text = JSON.stringify(payload, null, 2);
    const hash = createHash('sha256').update(text).digest('hex');
    writeFileSync(join(outDir, name), text);
    console.log(`${name}  sha256=${hash}  bytes=${text.length}`);
    return hash;
  };

  // Merge into any existing manifest: a campaign generates the store fixture and
  // the trip fixture in separate invocations, and overwriting would drop the
  // first one's hash — leaving a fixture that `--verify` never checks.
  const manifestPath = join(outDir, 'manifest.json');
  let manifest = {
    generated_for: 'p0',
    epoch: new Date(epochMs).toISOString(),
    backup_version: BACKUP_VERSION,
    fixtures: {},
  };
  try {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (existing?.epoch && existing.epoch !== manifest.epoch) {
      console.error(
        `Refusing to merge: ${manifestPath} was generated for epoch ${existing.epoch}, not ${manifest.epoch}.\n`
        + 'Fixtures from two different epochs are not a matched set. Use a fresh --out directory.'
      );
      process.exit(1);
    }
    manifest = { ...manifest, ...existing, fixtures: { ...(existing.fixtures || {}) } };
  } catch {
    // No manifest yet, or an unreadable one: start fresh.
  }

  if (args.includes('--stores')) {
    const saturated = argValue('--stores', 'empty') === 'saturated';
    const name = `diagnostic-stores-${saturated ? 'saturated' : 'empty'}.json`;
    manifest.fixtures[name] = write(name, buildDiagnosticStores(saturated, epochMs));
  } else {
    const tripCount = Number(argValue('--trips', 100));
    if (!Number.isInteger(tripCount) || tripCount < 1) {
      console.error(`--trips must be a positive integer, got: ${argValue('--trips', 100)}`);
      process.exit(1);
    }
    const shapeName = argValue('--shape', 'p50');
    const shape = SHAPES[shapeName];
    if (!shape) {
      console.error(`Unknown shape ${shapeName}. Use p50, p95 or large.`);
      process.exit(1);
    }

    // Seeded from the arguments, so the same request always yields the same bytes.
    const random = mulberry32(tripCount * 7919 + shapeName.length * 104729);
    const name = `trips-${tripCount}-${shapeName}.backup.json`;
    const { hash, bytes } = await writeTripBackupStreaming({
      path: join(outDir, name),
      tripCount,
      shape,
      shapeName,
      random,
      epochMs,
    });
    manifest.fixtures[name] = hash;
    console.log(`${name}  sha256=${hash}  bytes=${bytes}`);
  }

  write('manifest.json', manifest);
  console.log('\nBefore each measured arm: node scripts/p0-seed-dataset.mjs --verify '
    + join(outDir, 'manifest.json'));
}

if (isMain) {
  await main();
}
