import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { scoringConstantsPath } from './paths.mjs';

export const GENERAL_PROMOTABLE_CONSTANT_KEYS = Object.freeze([
  'PENALTY_SCALE_FACTOR',
]);

export const FATIGUE_PROMOTABLE_CONSTANT_KEYS = Object.freeze([
  'FATIGUE_SAFETY_PENALTY_SCALE',
  'FATIGUE_SAFETY_MAX_PENALTY',
]);

export const ROUTE_RISK_PROMOTABLE_CONSTANT_KEYS = Object.freeze([
  'ROUTE_RISK_EVENT_WEIGHT',
  'ROUTE_RISK_HARSH_WEIGHT',
  'PREDICTIVE_EVENT_DENSITY_MAX_PER_KM',
  'PREDICTIVE_DANGER_ZONE_SATURATION_COUNT',
]);

export const PROMOTABLE_CONSTANT_KEYS = Object.freeze([
  ...GENERAL_PROMOTABLE_CONSTANT_KEYS,
  ...FATIGUE_PROMOTABLE_CONSTANT_KEYS,
]);

export const KNOWN_CALIBRATION_CONSTANT_KEYS = Object.freeze([
  ...PROMOTABLE_CONSTANT_KEYS,
  ...ROUTE_RISK_PROMOTABLE_CONSTANT_KEYS,
]);

export async function loadCurrentConstants() {
  const url = `${pathToFileURL(scoringConstantsPath).href}?calibration=${Date.now()}`;
  const module = await import(url);
  return Object.fromEntries(KNOWN_CALIBRATION_CONSTANT_KEYS.map((key) => [
    key,
    Number(module.SCORING_CONSTANTS?.[key]?.value),
  ]));
}

export async function readCurrentScoringVersion() {
  const source = await readFile(new URL('../../src/lib/scoringVersion.generated.js', import.meta.url), 'utf8');
  return source.match(/SCORING_VERSION\s*=\s*'([^']+)'/)?.[1] ?? null;
}
