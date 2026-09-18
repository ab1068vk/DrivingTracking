import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPLETE_BUILD_ID_ALGORITHM = 'sha256-packaged-inputs-v1';

const normalizePath = (value) => String(value).replaceAll('\\', '/');

export function computeCompleteBuildIdentityFromEntries(entries = [], metadata = {}) {
  const hash = createHash('sha256');
  hash.update(`${COMPLETE_BUILD_ID_ALGORITHM}\n`);
  Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => hash.update(`meta:${key}=${String(value)}\n`));
  [...entries]
    .map((entry) => ({ path: normalizePath(entry.path), content: entry.content }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .forEach((entry) => {
      const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content));
      hash.update(`file:${entry.path}:${content.length}\n`);
      hash.update(content);
      hash.update('\n');
    });
  return `${COMPLETE_BUILD_ID_ALGORITHM}:${hash.digest('hex')}`;
}

const SKIPPED_SEGMENTS = new Set([
  '.git', 'build', 'dist', 'node_modules', '__tests__', 'androidTest', 'test',
]);

const SKIPPED_FILE = /(?:\.test\.|\.spec\.|\.snap$)/;
const GENERATED_ANDROID_ASSETS = new Set([
  'android/app/src/main/assets/public',
  'android/app/src/main/assets/capacitor.config.json',
  'android/app/src/main/assets/capacitor.plugins.json',
]);

async function collectPath(root, relative, entries) {
  if (GENERATED_ANDROID_ASSETS.has(normalizePath(relative))) return;
  const absolute = path.join(root, relative);
  let details;
  try {
    details = await stat(absolute);
  } catch {
    return;
  }
  if (details.isDirectory()) {
    if (SKIPPED_SEGMENTS.has(path.basename(absolute)) || /^(?:androidTest|test)/.test(path.basename(absolute))) return;
    const children = await readdir(absolute);
    for (const child of children.sort()) await collectPath(root, path.join(relative, child), entries);
    return;
  }
  if (!details.isFile() || SKIPPED_FILE.test(path.basename(relative))) return;
  entries.push({ path: normalizePath(relative), content: await readFile(absolute) });
}

export async function computeCompleteBuildIdentity(root, metadata = {}) {
  const inputs = [
    'src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js',
    'capacitor.config.ts', 'capacitor.config.json', 'tailwind.config.js', 'postcss.config.js',
    'android/app/src',
    'android/app/build.gradle', 'android/build.gradle', 'android/settings.gradle',
    'android/gradle.properties', 'android/variables.gradle',
    'android/gradle/wrapper/gradle-wrapper.properties',
    'android/app/proguard-rules.pro', 'android/app/capacitor.build.gradle',
    'android/capacitor.settings.gradle', 'android/gradle/libs.versions.toml',
    'android/capacitor-cordova-android-plugins/src',
    'android/capacitor-cordova-android-plugins/build.gradle',
    'scripts/complete-build-identity.mjs',
  ];
  const entries = [];
  for (const input of inputs) await collectPath(root, input, entries);
  return computeCompleteBuildIdentityFromEntries(entries, metadata);
}

async function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const familyIndex = argv.indexOf('--variant-family');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : process.cwd();
  const variantFamily = familyIndex >= 0 ? argv[familyIndex + 1] : 'standard';
  process.stdout.write(await computeCompleteBuildIdentity(root, {
    variantFamily,
    // Only the final opaque artifact fingerprint is emitted, never these build inputs.
    qualificationGate: process.env.ROAD_SAGE_IDENTITY_QUALIFICATION_GATE || '',
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
