import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultLabelsPath = path.join(repoRoot, 'calibration-labels.json');
export const defaultTripsPath = path.join(repoRoot, 'trips.json');
export const scoringConstantsPath = path.join(repoRoot, 'src', 'lib', 'scoringConstants.js');
export const scoringVersionPath = path.join(repoRoot, 'src', 'lib', 'scoringVersion.generated.js');
export const auditLogPath = path.join(repoRoot, 'scripts', 'calibration-audit-log.jsonl');
export const goldenFixtureDir = path.join(repoRoot, 'src', 'lib', '__tests__', 'goldenFixtures');
