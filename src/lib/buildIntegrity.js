import { BUILD_HASH, BUILD_HASH_ALGORITHM } from '@/lib/buildIntegrity.generated';

const PLACEHOLDER = '__ROAD_SAGE_BUILD_HASH_PLACEHOLDER__';

export function getBuildIntegrityInfo() {
  const available = typeof BUILD_HASH === 'string' &&
    BUILD_HASH.length === 64 &&
    BUILD_HASH !== PLACEHOLDER;
  return {
    buildHash: available ? BUILD_HASH : null,
    algorithm: BUILD_HASH_ALGORITHM,
    available,
    limitation: 'This identifies the bundled JavaScript artifact. It does not detect a fully compromised app bundle from inside that same bundle.',
  };
}
