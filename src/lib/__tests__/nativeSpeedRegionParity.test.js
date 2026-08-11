/**
 * The background service resolves its own speed limits, so when nothing is saved
 * for a road it has to estimate one the same way the webview does — otherwise a
 * background drive assumes 100 km/h where a foreground drive assumes 50.
 *
 * SpeedRegionDefaults.java is hand-written rather than generated, because the
 * generator emits scalar constants and this is a table. These tests read both
 * sources and fail if they drift, which is the guarantee generation would have
 * given.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REGION_SPEED_DEFAULTS } from '@/lib/speedLimitSource';
import { speedLimitSourceProfile } from '@/lib/speedLimitConfidence';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
// Normalize the line endings: git checks Java out with CRLF where core.autocrlf
// is on, and a pattern anchored on \n would then find nothing and pass vacuously.
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const javaSource = readRepoFile('android/app/src/main/java/com/drivesense/app/SpeedRegionDefaults.java');
const tripEngineSource = readRepoFile('src/lib/tripEngine.js');
const speedLimitSource = readRepoFile('src/lib/speedLimitSource.js');

/** Concatenated contents of the string literals that make up a Java constant. */
function javaStringConstant(name) {
  const declaration = javaSource.match(
    new RegExp(`private static final String ${name}\\s*=([\\s\\S]*?);\\n`)
  );
  expect(declaration, `${name} not found in SpeedRegionDefaults.java`).toBeTruthy();
  return (declaration[1].match(/"([^"]*)"/g) || []).map((chunk) => chunk.slice(1, -1)).join('');
}

/** `COUNTRY|REGION|context:kmh,...` rows, with the contexts sorted so order cannot fail a run. */
function normalizeRow(country, region, limits) {
  const body = Object.entries(limits)
    .map(([context, kmh]) => `${context}:${kmh === null ? 'null' : kmh}`)
    .sort()
    .join(',');
  return `${country}|${region}|${body}`;
}

function sortRowContexts(row) {
  const [country, region, body] = row.split('|');
  return `${country}|${region}|${body.split(',').sort().join(',')}`;
}

describe('native speed region defaults parity', () => {
  it('mirrors REGION_SPEED_DEFAULTS row for row', () => {
    const nativeRows = javaStringConstant('TABLE').split(';').map(sortRowContexts).sort();
    const expectedRows = Object.entries(REGION_SPEED_DEFAULTS)
      .flatMap(([country, regions]) => Object.entries(regions)
        .map(([region, limits]) => normalizeRow(country, region, limits)))
      .sort();

    expect(nativeRows).toEqual(expectedRows);
  });

  it('carries a region whose only entry is "no limit"', () => {
    // Germany's motorways are the one row with a null, and it is what proves the
    // encoding distinguishes "publishes no limit" from "we have no row".
    expect(REGION_SPEED_DEFAULTS.DE._country.motorway).toBeNull();
    expect(javaStringConstant('TABLE')).toContain('motorway:null');
  });

  it('uses the same confidences as the JS source profiles', () => {
    const javaConstant = (name) => {
      const match = javaSource.match(new RegExp(`${name} = ([0-9.]+)d;`));
      expect(match, `${name} not found`).toBeTruthy();
      return Number(match[1]);
    };

    expect(javaConstant('REGION_DEFAULT_CONFIDENCE'))
      .toBe(speedLimitSourceProfile('region_default_estimate').confidence);
    expect(javaConstant('GPS_INFERRED_CONFIDENCE'))
      .toBe(speedLimitSourceProfile('inferred').confidence);
  });

  it('maps a p85 speed to the same zone as zoneFromP85', () => {
    const jsPairs = [...tripEngineSource.matchAll(
      /if \(p85Speed < (\d+)\) return \{ inferredZone: '[^']*', inferredZoneKmh: (\d+) \}/g
    )].map((match) => [match[1], match[2]]);
    const javaPairs = [...javaSource.matchAll(
      /if \(p85Kmh < (\d+)d\) return (\d+)d;/g
    )].map((match) => [match[1], match[2]]);

    expect(jsPairs.length).toBeGreaterThan(0);
    expect(javaPairs).toEqual(jsPairs);
  });

  it('maps an inferred zone to the same road context as roadContextFromGpsBehaviour', () => {
    const jsPairs = [...speedLimitSource.matchAll(
      /if \(inferredZoneKmh <= (\d+)\) return '(\w+)';/g
    )].map((match) => [match[1], match[2]]);
    const javaPairs = [...javaSource.matchAll(
      /if \(inferredZoneKmh <= (\d+)d\) return "(\w+)";/g
    )].map((match) => [match[1], match[2]]);

    expect(jsPairs.length).toBeGreaterThan(0);
    expect(javaPairs).toEqual(jsPairs);
  });

  it('clamps the global table with the same compliance fallbacks', () => {
    const jsPairs = [...speedLimitSource.matchAll(
      /if \(roadContext === '(\w+)'\) return (\d+);/g
    )].map((match) => [match[1], match[2]]);
    const javaPairs = [...javaSource.matchAll(
      /if \("(\w+)"\.equals\(roadContext\)\) return (\d+)d;/g
    )].map((match) => [match[1], match[2]]);

    expect(jsPairs.length).toBeGreaterThan(0);
    expect(javaPairs).toEqual(jsPairs);
  });
});
