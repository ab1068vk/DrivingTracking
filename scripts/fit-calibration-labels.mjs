#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fitCalibrationDataset, MIN_CALIBRATION_LABEL_COUNT } from '../src/lib/calibrationFitting.js';

const usage = () => {
  console.error('Usage: npm run calibration:fit -- <labels.json> [--target=2000]');
  process.exit(1);
};

const args = process.argv.slice(2);
const filePath = args.find((arg) => !arg.startsWith('--'));
if (!filePath) usage();

const targetArg = args.find((arg) => arg.startsWith('--target='));
const targetCount = targetArg ? Number(targetArg.split('=')[1]) : MIN_CALIBRATION_LABEL_COUNT;

const raw = await readFile(filePath, 'utf8');
const parsed = JSON.parse(raw);
const labels = Array.isArray(parsed)
  ? parsed
  : Array.isArray(parsed.labels)
    ? parsed.labels
    : Array.isArray(parsed.calibration_labels)
      ? parsed.calibration_labels
      : null;

if (!labels) {
  throw new Error('Label file must be an array or contain a labels/calibration_labels array.');
}

const result = fitCalibrationDataset(labels, { targetCount });

console.log(JSON.stringify({
  dataset_provenance: {
    source_file: basename(filePath),
    generated_at: new Date().toISOString(),
    label_schema: 'post_trip_survey_v1',
  },
  ...result,
}, null, 2));
