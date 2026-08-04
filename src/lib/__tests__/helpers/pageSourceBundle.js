import fs from 'node:fs';
import path from 'node:path';

/**
 * Static-text contracts (banned wording, privacy scans, performance-pattern
 * assertions) read page sources as raw text. Several of those assertions are
 * negative — `not.toContain` — so when a section is extracted out of a page
 * into its own component file, the assertion keeps passing while scanning
 * nothing. That is silent coverage loss, not a green build.
 *
 * Bundling the page together with its extraction directory keeps those
 * contracts scanning the same body of text before and after a refactor.
 *
 * A directory that does not exist yet contributes nothing, so wiring this in
 * ahead of an extraction is a no-op.
 */

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', '..', '..');

const normalize = (text) => text.replace(/\r\n/g, '\n');

const resolveFromRoot = (relativePath) => (
  path.isAbsolute(relativePath) ? relativePath : path.join(repoRoot, relativePath)
);

/**
 * Every file under `directory`, recursively, sorted for deterministic output.
 * Test directories are skipped so a test's own text can never satisfy a
 * production-source assertion.
 * @param {string} directory
 * @returns {string[]}
 */
function collectFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : collectFiles(target);
      }
      return entry.isFile() ? [target] : [];
    })
    .sort();
}

/**
 * @param {string} pageRelPath Repo-relative path, e.g. 'src/pages/Settings.jsx'.
 * @param {string[]} extraDirs Repo-relative directories whose files are appended.
 * @returns {string} Page source plus every extracted file, newline-joined.
 */
export function readPageSource(pageRelPath, extraDirs = []) {
  const pageSource = normalize(fs.readFileSync(resolveFromRoot(pageRelPath), 'utf8'));
  const extracted = extraDirs
    .flatMap((dir) => collectFiles(resolveFromRoot(dir)))
    .map((file) => normalize(fs.readFileSync(file, 'utf8')));

  return [pageSource, ...extracted].join('\n');
}

/** Directories each page's extracted pieces will land in. */
export const SETTINGS_EXTRACTION_DIRS = ['src/components/settings'];
export const DASHBOARD_EXTRACTION_DIRS = ['src/components/dashboard'];
export const SPEED_LIMITS_EXTRACTION_DIRS = ['src/components/speedLimits'];

export const readSettingsSource = () => readPageSource('src/pages/Settings.jsx', SETTINGS_EXTRACTION_DIRS);
export const readDashboardSource = () => readPageSource('src/pages/Dashboard.jsx', DASHBOARD_EXTRACTION_DIRS);
export const readSpeedLimitsSource = () => readPageSource('src/pages/SpeedLimits.jsx', SPEED_LIMITS_EXTRACTION_DIRS);
