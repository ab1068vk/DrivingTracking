import { createHash } from 'node:crypto';

export const BUILD_HASH_PLACEHOLDER = '__ROAD_SAGE_BUILD_HASH_PLACEHOLDER__';
export const BUILD_HASH_PATTERN = /[a-f0-9]{64}/g;
export const BUILD_HASH_ALGORITHM = 'sha256-bundle-normalized-v1';

const normalizeCode = (code = '') => String(code)
  .replaceAll(BUILD_HASH_PLACEHOLDER, BUILD_HASH_PLACEHOLDER)
  .replace(BUILD_HASH_PATTERN, (match) => (
    match.length === 64 ? BUILD_HASH_PLACEHOLDER : match
  ));

export function computeBuildHashFromChunks(bundle = {}) {
  const chunks = Object.entries(bundle)
    .filter(([, item]) => item?.type === 'chunk' && typeof item.code === 'string')
    .map(([fileName, item]) => [fileName, normalizeCode(item.code)])
    .sort(([left], [right]) => left.localeCompare(right));
  const hashInput = chunks
    .map(([fileName, code]) => `// ${fileName}\n${code}`)
    .join('\n');
  return createHash('sha256').update(hashInput).digest('hex');
}

export function applyBuildHashToBundle(bundle = {}, hash) {
  for (const item of Object.values(bundle)) {
    if (item?.type === 'chunk' && typeof item.code === 'string') {
      item.code = item.code.replaceAll(BUILD_HASH_PLACEHOLDER, hash);
    }
  }
}

export function buildIntegrityVitePlugin() {
  return {
    name: 'road-sage-build-integrity',
    generateBundle(_options, bundle) {
      const hash = computeBuildHashFromChunks(bundle);
      applyBuildHashToBundle(bundle, hash);
      this.emitFile({
        type: 'asset',
        fileName: 'build-integrity.json',
        source: `${JSON.stringify({
          app: 'Road Sage',
          algorithm: BUILD_HASH_ALGORITHM,
          buildHash: hash,
          generatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
      });
    },
  };
}
