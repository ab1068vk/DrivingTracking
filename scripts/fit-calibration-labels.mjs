#!/usr/bin/env node
import { fitCalibrationDataset, CalibrationQualityError, MIN_CALIBRATION_LABEL_COUNT } from '../src/lib/calibrationFitting.js';
import { parseArgs } from './calibration/args.mjs';
import { loadCurrentConstants } from './calibration/currentConstants.mjs';
import { attachFatigueCalibration } from './calibration/fatigueFit.mjs';
import { loadLabels } from './calibration/labels.mjs';
import { promoteCalibration } from './calibration/promotion.mjs';
import { printFitReport } from './calibration/report.mjs';
import { validateCalibration } from './calibration/validation.mjs';

async function fit(options) {
  const { labels, labelsFile } = await loadLabels(options.labelsFile);
  const baseResult = fitCalibrationDataset(labels, {
    verbose: true,
    targetCount: options.targetCount || MIN_CALIBRATION_LABEL_COUNT,
    enforcePromotionGuards: options.promote === true || options.validate === true,
  });
  const currentConstants = await loadCurrentConstants();
  const result = attachFatigueCalibration(baseResult, labels, currentConstants);
  printFitReport({ result, loadedCount: labels.length, labelsFile, currentConstants });
  return { result, labels };
}

try {
  const options = parseArgs();
  const { result, labels } = await fit(options);

  if (options.validate) {
    await validateCalibration(result);
  } else if (options.promote) {
    await promoteCalibration({ result, loadedCount: labels.length });
  }
} catch (error) {
  console.error(error?.message || error);
  process.exit(error instanceof CalibrationQualityError ? 2 : 1);
}
