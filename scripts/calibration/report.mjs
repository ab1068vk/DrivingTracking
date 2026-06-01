import { PROMOTABLE_CONSTANT_KEYS } from './currentConstants.mjs';

const line = '-----------------------------------------------------';
const buckets = ['careful', 'normal', 'rushed', 'incident'];

const pct = (count, total) => `${Math.round((total > 0 ? count / total : 0) * 100)}%`;
const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits).replace(/\.?0+$/, '') : 'n/a';
const pad = (value, width) => String(value).padStart(width, ' ');

function distributionText(distribution = {}) {
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  return buckets.map((bucket) => `${bucket} ${pct(distribution[bucket] || 0, total)}`).join(' | ');
}

function matrixText(matrix = {}) {
  const rows = [`${pad('', 12)}${buckets.map((bucket) => pad(bucket, 9)).join('')}`];
  for (const actual of buckets) {
    const values = buckets.map((predicted) => pad(matrix[actual]?.[predicted] || 0, 9)).join('');
    rows.push(`${pad(actual, 12)}${values}`);
  }
  return rows.join('\n');
}

function qualityText(result) {
  const mae = result.validation.crossValidationMAE;
  const r2 = result.validation.crossValidationR2;
  const maeLabel = mae <= 12 ? 'PASS - threshold: 12.0' : 'FAIL - threshold: 12.0';
  const r2Label = r2 == null ? 'n/a' : r2 >= 0.7 ? 'GOOD' : r2 >= 0.4 ? 'OK' : 'WEAK';
  return [
    `Cross-validation MAE:  ${fmt(mae, 1)} points  [${maeLabel}]`,
    `Cross-validation R2:   ${fmt(r2, 2)}        [${r2Label}]`,
  ].join('\n');
}

function constantsText(result, currentConstants = {}) {
  return PROMOTABLE_CONSTANT_KEYS.map((key) => {
    const value = result.constants[key];
    const current = currentConstants[key];
    const interval = result.confidenceIntervals[key] || {};
    return `${key}: ${fmt(value, key.includes('SCALE') ? 3 : 2).padStart(10)}  (currently ${fmt(current, 3)})  [CI: ${fmt(interval.low95, 3)} - ${fmt(interval.high95, 3)}]`;
  }).join('\n');
}

function fatigueText(result) {
  const fatigue = result.fatigueCalibration;
  if (!fatigue) return '';
  if (fatigue.status !== 'refitted') return fatigue.note || '';

  return [
    `Fatigue labels: ${fatigue.eligibleCount.toLocaleString()} eligible`,
    `Fatigue correlation: ${fmt(fatigue.validation.fatigueCorrelation, 3)}`,
    `Alert vs very tired mean Safety gap: ${fmt(fatigue.validation.alertVsTiredMeanScoreDiff, 2)} points`,
  ].join('\n');
}

function routeRiskText(result) {
  const routeRisk = result.routeRiskCalibration;
  if (!routeRisk) return '';
  if (routeRisk.status !== 'refitted') return routeRisk.note || '';

  return [
    `Route risk trips: ${routeRisk.eligibleTripCount.toLocaleString()} eligible`,
    `Route groups: ${routeRisk.routeGroupCount.toLocaleString()} repeated groups`,
    `ROUTE_RISK_EVENT_WEIGHT: ${fmt(routeRisk.constants.ROUTE_RISK_EVENT_WEIGHT, 2)}`,
    `ROUTE_RISK_HARSH_WEIGHT: ${fmt(routeRisk.constants.ROUTE_RISK_HARSH_WEIGHT, 2)}`,
    `EVENT_DENSITY_MAX_EVENTS_PER_KM: ${fmt(routeRisk.constants.PREDICTIVE_EVENT_DENSITY_MAX_PER_KM, 2)}`,
    `DANGER_ZONE_SATURATION_COUNT: ${fmt(routeRisk.constants.PREDICTIVE_DANGER_ZONE_SATURATION_COUNT, 0)}`,
    `Repeated-route consistency: ${fmt(routeRisk.validation.repeatedRouteConsistency, 3)}`,
    `Harsh vs normal route ratio: ${fmt(routeRisk.validation.harshVsNormalRouteRatio, 2)}`,
    `Saturation effectiveness: ${fmt(routeRisk.validation.saturationEffectiveness, 3)}`,
  ].join('\n');
}

function warningsText(result, currentConstants = {}) {
  const warnings = [];
  const fitted = Number(result.constants.PENALTY_SCALE_FACTOR);
  const current = Number(currentConstants.PENALTY_SCALE_FACTOR);
  if (Number.isFinite(fitted) && Number.isFinite(current) && current > 0 && Math.abs(fitted - current) / current > 0.05) {
    warnings.push('WARNING: PENALTY_SCALE_FACTOR change exceeds 5%: all trips will be flagged stale.');
  }
  warnings.push('WARNING: Run with --promote to write these constants and bump SCORING_VERSION.');
  return warnings.join('\n');
}

export function printFitReport({ result, loadedCount, labelsFile, currentConstants }) {
  const rejected = result.validation.rejectedCount || 0;
  const eligible = result.validation.eligibleCount || 0;
  console.log('');
  console.log(line);
  console.log('ROAD SAGE CALIBRATION FIT REPORT');
  console.log(line);
  console.log(`Labels: ${eligible.toLocaleString()} eligible / ${loadedCount.toLocaleString()} loaded (${rejected.toLocaleString()} rejected)`);
  console.log(`Source: ${labelsFile}`);
  console.log(`Label distribution: ${distributionText(result.validation.labelDistribution)}`);
  console.log('');
  console.log(qualityText(result));
  console.log('');
  console.log('CONFUSION MATRIX (actual -> predicted)');
  console.log(matrixText(result.validation.confusionMatrix));
  console.log('');
  console.log('SUGGESTED CONSTANTS vs. CURRENT');
  console.log(constantsText(result, currentConstants));
  const fatigue = fatigueText(result);
  if (fatigue) {
    console.log('');
    console.log('FATIGUE-SPECIFIC CALIBRATION');
    console.log(fatigue);
  }
  const routeRisk = routeRiskText(result);
  if (routeRisk) {
    console.log('');
    console.log('ROUTE-RISK INTERNAL CONSISTENCY CALIBRATION');
    console.log(routeRisk);
  }
  console.log('');
  console.log(warningsText(result, currentConstants));
  console.log(line);
}
