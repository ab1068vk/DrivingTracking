import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadLabels(labelsFile) {
  const resolved = path.resolve(labelsFile);
  const raw = await readFile(resolved, 'utf8');
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

  console.log(`Loaded ${labels.length.toLocaleString()} labels from ${resolved}`);
  return { labels, labelsFile: resolved };
}
