import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1]);
const apkRoot = resolve(options.get('--apk-root') || 'android/app/build/outputs/apk');
const expectedPackage = options.get('--expected-package') || 'com.drivesense.app.p35h';
const reportPath = resolve(options.get('--report') || 'android/app/build/reports/physical-h/upgrade-artifacts.json');

const walk = (directory) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
};

const apks = walk(apkRoot).filter((path) => path.toLowerCase().endsWith('.apk'));
const currentApk = apks.find((path) => /app-physicalH-debug\.apk$/i.test(path));
const legacyApk = apks.find((path) => /app-physicalHLegacy-debug\.apk$/i.test(path));
const instrumentationApk = apks.find((path) => /app-physicalH-debug-androidTest\.apk$/i.test(path));
if (!currentApk || !legacyApk || !instrumentationApk) {
  throw new Error(`Physical H app, legacy, and instrumentation APKs not found below ${apkRoot}`);
}

const localProperties = readFileSync(resolve('android/local.properties'), 'utf8');
const sdkMatch = localProperties.match(/^sdk\.dir=(.+)$/m);
if (!sdkMatch) throw new Error('android/local.properties does not define sdk.dir');
const sdk = sdkMatch[1].replace(/\\:/g, ':').replace(/\\\\/g, '\\');
const buildToolsRoot = join(sdk, 'build-tools');
const versions = readdirSync(buildToolsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
if (versions.length === 0) throw new Error('Android build-tools are unavailable');
const tool = (name) => {
  for (const version of versions) {
    for (const suffix of process.platform === 'win32' ? ['.bat', '.exe', ''] : ['']) {
      const candidate = join(buildToolsRoot, version, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`${name} not found in Android build-tools`);
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.bat'),
  });
  if (result.status !== 0) throw new Error(`${basename(command)} failed: ${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
};

const aapt = tool('aapt');
const apksigner = tool('apksigner');
const inspect = (path) => {
  const badging = run(aapt, ['dump', 'badging', path]);
  const packageMatch = badging.match(/^package: name='([^']+)' versionCode='(\d*)'/m);
  if (!packageMatch) throw new Error(`Could not read package/version from ${path}`);
  const signer = run(apksigner, ['verify', '--print-certs', path]);
  const digestMatch = signer.match(/(?:Signer #1|V\d+ Signer): certificate SHA-256 digest:\s*([0-9a-f]+)/i);
  if (!digestMatch) throw new Error(`Could not read signer certificate digest from ${path}`);
  return {
    path: resolve(path),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    applicationId: packageMatch[1],
    versionCode: packageMatch[2] === '' ? null : Number(packageMatch[2]),
    signingCertificateSha256: digestMatch[1].toLowerCase(),
  };
};

const current = inspect(currentApk);
const legacy = inspect(legacyApk);
const instrumentation = inspect(instrumentationApk);
if (current.applicationId !== expectedPackage || legacy.applicationId !== expectedPackage) {
  throw new Error(`Physical H package mismatch: current=${current.applicationId}, legacy=${legacy.applicationId}`);
}
if (instrumentation.applicationId !== `${expectedPackage}.test`) {
  throw new Error(`Physical H instrumentation package mismatch: ${instrumentation.applicationId}`);
}
if (current.signingCertificateSha256 !== legacy.signingCertificateSha256) {
  throw new Error('Physical H legacy/current signing certificates differ');
}
if (instrumentation.signingCertificateSha256 !== current.signingCertificateSha256) {
  throw new Error('Physical H instrumentation/app signing certificates differ');
}
if (current.versionCode <= legacy.versionCode) {
  throw new Error(`Physical H upgrade ordering invalid: legacy=${legacy.versionCode}, current=${current.versionCode}`);
}

const report = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  expectedPackage,
  upgradeOrdered: true,
  signingCertificateMatches: true,
  signingCertificateSha256: current.signingCertificateSha256,
  current,
  legacy,
  instrumentation,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Physical H upgrade artifacts verified: ${reportPath}`);
