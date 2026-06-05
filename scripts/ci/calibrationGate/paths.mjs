import path from 'node:path';
import { repoRoot } from '../../calibration/paths.mjs';

export const auditLogPath = path.join(repoRoot, 'scripts', 'calibration-audit-log.jsonl');

export const calibrationSensitivePaths = Object.freeze([
  'src/lib/scoringConstants.js',
  'src/lib/calibrationFitting.js',
]);
