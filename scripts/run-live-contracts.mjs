import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  './node_modules/vitest/vitest.mjs',
  'run',
  'src/lib/__tests__/liveExternalContracts.test.js',
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LIVE_EXTERNAL_CONTRACTS: 'true',
  },
});

process.exit(result.status ?? 1);
