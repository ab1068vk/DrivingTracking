import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scoringConstantsPath } from './paths.mjs';

export const PROMOTABLE_CONSTANT_KEYS = Object.freeze([
  'PENALTY_SCALE_FACTOR',
  'FATIGUE_SAFETY_PENALTY_SCALE',
  'FATIGUE_SAFETY_MAX_PENALTY',
]);

export async function loadCurrentConstants() {
  const url = `${pathToFileURL(scoringConstantsPath).href}?calibration=${Date.now()}`;
  const module = await import(url);
  return Object.fromEntries(PROMOTABLE_CONSTANT_KEYS.map((key) => [
    key,
    Number(module.SCORING_CONSTANTS?.[key]?.value),
  ]));
}

export async function readCurrentScoringVersion() {
  const source = await readFile(new URL('../../src/lib/scoringVersion.generated.js', import.meta.url), 'utf8');
  return source.match(/SCORING_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
}
