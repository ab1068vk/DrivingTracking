import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { appendAuditEntry } from './auditLog.mjs';
import { PROMOTABLE_CONSTANT_KEYS, readCurrentScoringVersion } from './currentConstants.mjs';
import { scoringConstantsPath } from './paths.mjs';

const formatNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Cannot promote non-finite constant value: ${value}`);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(6))).replace(/\.?0+$/, '');
};

function replaceConstantValue(source, key, value) {
  const replacement = formatNumber(value);
  const registryPattern = new RegExp(`(${key}:\\s*constant\\()([^,\\n]+)(,)`);
  if (registryPattern.test(source)) {
    return source.replace(registryPattern, `$1${replacement}$3`);
  }

  const exportPattern = new RegExp(`(export\\s+const\\s+${key}\\s*=\\s*)([^;\\n]+)(;)`);
  if (exportPattern.test(source)) {
    return source.replace(exportPattern, `$1${replacement}$3`);
  }

  throw new Error(`Could not find declaration for ${key} in scoringConstants.js`);
}

async function runVersionBuild() {
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd.exe' : 'npm';
  const args = isWindows ? ['/d', '/s', '/c', 'npm.cmd run build:version'] : ['run', 'build:version'];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build:version exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

export async function promoteCalibration({ result, loadedCount }) {
  const originalSource = await readFile(scoringConstantsPath, 'utf8');
  const keysToPromote = result.fittedConstantKeys || PROMOTABLE_CONSTANT_KEYS;
  const nextSource = keysToPromote.reduce(
    (source, key) => replaceConstantValue(source, key, result.constants[key]),
    originalSource
  );

  if (nextSource === originalSource) {
    console.log('Constants already match fitted values.');
  } else {
    await writeFile(scoringConstantsPath, nextSource, 'utf8');
  }

  await runVersionBuild();
  const scoringVersion = await readCurrentScoringVersion();
  await appendAuditEntry({
    fittedAt: result.metadata.fittedAt,
    promotedAt: new Date().toISOString(),
    constants: result.constants,
    promotedConstantKeys: keysToPromote,
    validation: result.validation,
    fatigueCalibration: result.fatigueCalibration || null,
    labelCount: {
      loaded: loadedCount,
      eligible: result.validation.eligibleCount,
      rejected: result.validation.rejectedCount,
    },
    scoringVersion,
  });

  console.log(`Constants promoted. New SCORING_VERSION: ${scoringVersion}.`);
  console.log('All trips scored with the previous version are now stale.');
  console.log('Run npm run calibration:validate to confirm golden fixtures pass.');
}
