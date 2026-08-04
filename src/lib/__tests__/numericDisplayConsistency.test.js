import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = [
  path.join(process.cwd(), 'src', 'pages'),
  path.join(process.cwd(), 'src', 'components'),
];

const EXCLUDED_BASENAMES = new Set([
  'AndroidReference.jsx',
  'Settings.jsx',
  'SpeedLimits.jsx',
]);

const HARD_CODED_DISPLAY_PATTERNS = [
  { label: 'hard-coded speed unit', pattern: /\b(?:km\/h|mph)\b/ },
  { label: 'hard-coded 100-distance rate', pattern: /(?:\/\s*100\s*(?:km|mi)|per\s+100\s+(?:km|mi))/i },
  { label: 'hard-coded 10-distance rate', pattern: /(?:\/\s*10\s*(?:km|mi)|per\s+10\s+(?:km|mi))/i },
  { label: 'hard-coded distance heading', pattern: /(?:total|driver|trip)\s+distance\s*\((?:km|mi)\)/i },
  { label: 'interpolated hard-coded distance unit', pattern: /\}\s*(?:km|mi)\b/ },
  { label: 'rounded hard-coded distance unit', pattern: /toFixed\([^)]*\)[^\n]*\b(?:km|mi)\b/ },
  { label: 'hard-coded cost distance unit', pattern: /cost\s+per\s+(?:km|mi)\b/i },
];

function collectJsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectJsxFiles(target);
    }
    return entry.isFile() && entry.name.endsWith('.jsx') ? [target] : [];
  });
}

// Configuration surfaces legitimately spell units out, because they are where
// the user picks the unit rather than where a measurement is displayed. The
// directory rule keeps that exemption intact for sections extracted out of
// Settings.jsx, which would otherwise start failing purely by being moved.
const EXCLUDED_DIRECTORY_SEGMENTS = [
  path.join('src', 'components', 'settings'),
];

function isConfigurationSurface(file) {
  const base = path.basename(file);
  if (EXCLUDED_BASENAMES.has(base) || base.startsWith('SpeedLimit')) return true;
  return EXCLUDED_DIRECTORY_SEGMENTS.some((segment) => file.includes(segment));
}

describe('driver-facing numeric display consistency', () => {
  it('routes distance, speed, and normalized-rate labels through unit-aware formatters', () => {
    const violations = SOURCE_ROOTS
      .flatMap(collectJsxFiles)
      .filter((file) => !isConfigurationSurface(file))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8')
          .replace(/\b(?:L|kWh)\/\s*100\s*km/gi, '');
        return HARD_CODED_DISPLAY_PATTERNS
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => path.relative(process.cwd(), file) + ': ' + label);
      });

    expect(violations).toEqual([]);
  });
});