import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_HASH_PLACEHOLDER,
  applyBuildHashToBundle,
  computeBuildHashFromChunks,
} from '../../../scripts/build-integrity-utils.mjs';

const generated = { BUILD_HASH: '', BUILD_HASH_ALGORITHM: 'sha256' };

vi.mock('@/lib/buildIntegrity.generated', () => ({
  get BUILD_HASH() { return generated.BUILD_HASH; },
  get BUILD_HASH_ALGORITHM() { return generated.BUILD_HASH_ALGORITHM; },
}));

describe('build integrity hashing', () => {
  it('matches a built output after the embedded build hash is normalized', () => {
    const bundle = {
      'assets/app.js': {
        type: 'chunk',
        code: `const buildHash="${BUILD_HASH_PLACEHOLDER}"; console.log(buildHash);`,
      },
      'assets/vendor.js': {
        type: 'chunk',
        code: 'export const answer = 42;',
      },
    };

    const expectedHash = computeBuildHashFromChunks(bundle);
    applyBuildHashToBundle(bundle, expectedHash);

    expect(bundle['assets/app.js'].code).toContain(expectedHash);
    expect(computeBuildHashFromChunks(bundle)).toBe(expectedHash);
  });
});

// The runtime reader in src/lib/buildIntegrity.js is what Diagnostics shows the
// user, and it must never present a placeholder or truncated value as a real
// build identity.
describe('getBuildIntegrityInfo', () => {
  const validHash = 'a'.repeat(64);
  const loadInfo = async () => {
    vi.resetModules();
    const { getBuildIntegrityInfo } = await import('@/lib/buildIntegrity');
    return getBuildIntegrityInfo();
  };

  beforeEach(() => {
    generated.BUILD_HASH = validHash;
    generated.BUILD_HASH_ALGORITHM = 'sha256';
  });

  it('reports a real 64-character hash as available', async () => {
    await expect(loadInfo()).resolves.toMatchObject({
      buildHash: validHash,
      algorithm: 'sha256',
      available: true,
    });
  });

  it('treats the unreplaced build placeholder as unavailable', async () => {
    generated.BUILD_HASH = BUILD_HASH_PLACEHOLDER;

    await expect(loadInfo()).resolves.toMatchObject({ buildHash: null, available: false });
  });

  it('rejects a hash of the wrong length rather than showing a partial value', async () => {
    for (const value of ['', 'abc', 'a'.repeat(63), 'a'.repeat(65)]) {
      generated.BUILD_HASH = value;
      await expect(loadInfo()).resolves.toMatchObject({ buildHash: null, available: false });
    }
  });

  it('rejects a non-string hash', async () => {
    for (const value of [null, undefined, 12345, {}]) {
      generated.BUILD_HASH = value;
      await expect(loadInfo()).resolves.toMatchObject({ buildHash: null, available: false });
    }
  });

  it('always states the self-attestation limitation, even when a hash exists', async () => {
    const info = await loadInfo();

    expect(info.limitation).toContain('does not detect a fully compromised app bundle');
  });

  it('passes the algorithm through unchanged', async () => {
    generated.BUILD_HASH_ALGORITHM = 'sha512';

    await expect(loadInfo()).resolves.toMatchObject({ algorithm: 'sha512' });
  });
});
