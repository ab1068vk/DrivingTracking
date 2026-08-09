/**
 * Replay real trips from a backup export at several PENALTY_SCALE_FACTOR values.
 *
 *   npm run replay:penalty-scale -- --backup ./my-backup.json
 *   npm run replay:penalty-scale -- --backup ./my-backup.json --factors 4,5,6,40
 *
 * Follows the same launcher pattern as run-live-contracts.mjs: the work happens
 * in a vitest harness so it runs through the project's Vite aliases, and the
 * harness stays skipped in the normal suite unless REPLAY_BACKUP_PATH is set.
 *
 * The backup must be unencrypted JSON. Nothing is written and nothing leaves
 * the machine; the file is only read.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const readFlag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
};

const backup = readFlag('--backup');
const factors = readFlag('--factors') || '3,5,8,12,40';

if (!backup) {
  console.error('Usage: npm run replay:penalty-scale -- --backup <path-to-backup.json> [--factors 3,5,8,40]');
  process.exit(2);
}

const backupPath = path.resolve(backup);
if (!fs.existsSync(backupPath)) {
  console.error(`Backup not found: ${backupPath}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [
  './node_modules/vitest/vitest.mjs',
  'run',
  'src/lib/__tests__/penaltyScaleReplay.harness.test.js',
  '--pool=forks',
  '--maxWorkers=1',
  '--silent=false',
  '--reporter=verbose',
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    REPLAY_BACKUP_PATH: backupPath,
    REPLAY_FACTORS: factors,
  },
});

process.exit(result.status ?? 1);
