#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { scoringConstantsPath } from './calibration/paths.mjs';
import { formatPromotionBlockerFailure } from './scoring-constant-docs/formatFailures.mjs';
import { auditPromotionBlockerDocs } from './scoring-constant-docs/promotionBlockerDocs.mjs';

const source = await readFile(scoringConstantsPath, 'utf8');
const failures = auditPromotionBlockerDocs(source);

if (failures.length > 0) {
  failures
    .map(formatPromotionBlockerFailure)
    .forEach((message) => console.error(message));
  process.exit(1);
}

console.log('Promotion blocker JSDoc check passed.');
