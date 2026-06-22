import { describe, expect, it } from 'vitest';
import {
  BUILD_HASH_PLACEHOLDER,
  applyBuildHashToBundle,
  computeBuildHashFromChunks,
} from '../../../scripts/build-integrity-utils.mjs';

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
