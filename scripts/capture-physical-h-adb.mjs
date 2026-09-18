#!/usr/bin/env node

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const EXPECTED_SERIAL = 'RZCW81B3L3B';
const EXPECTED_ROOT = resolve(
  'agent-investigation/road-sage-data-loss-incident/physical-h/raw/RZCW81B3L3B',
);

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

const separator = process.argv.indexOf('--');
if (separator !== 3 || process.argv.length <= separator + 1) {
  fail('usage: node scripts/capture-physical-h-adb.mjs <raw-output.txt> -- -s RZCW81B3L3B <adb arguments>');
}

const outputPath = resolve(process.argv[2]);
const adbArguments = process.argv.slice(separator + 1);
if (outputPath !== EXPECTED_ROOT && !outputPath.startsWith(`${EXPECTED_ROOT}\\`)) {
  fail(`raw output must stay under ${EXPECTED_ROOT}`);
}
if (adbArguments[0] !== '-s' || adbArguments[1] !== EXPECTED_SERIAL) {
  fail(`every ADB command must begin with -s ${EXPECTED_SERIAL}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
const startedUtc = new Date().toISOString();
const result = spawnSync('adb', adbArguments, { encoding: 'utf8', windowsHide: true });
const endedUtc = new Date().toISOString();
const exitCode = Number.isInteger(result.status) ? result.status : 255;
const stdout = result.stdout ?? '';
const stderr = result.stderr ?? String(result.error ?? '');
const quote = (value) => (/^[A-Za-z0-9_./:#=-]+$/.test(value) ? value : JSON.stringify(value));
const record = [
  `COMMAND: adb ${adbArguments.map(quote).join(' ')}`,
  `startUtc: ${startedUtc}`,
  `endUtc: ${endedUtc}`,
  `exitCode: ${exitCode}`,
  'stdout:',
  stdout.replace(/\r\n/g, '\n').replace(/\n$/, ''),
  'stderr:',
  stderr.replace(/\r\n/g, '\n').replace(/\n$/, ''),
  '',
].join('\n');

appendFileSync(outputPath, record, { encoding: 'utf8', flag: 'a' });
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = exitCode;
