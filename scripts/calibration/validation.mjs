import { readLastAuditEntry } from './auditLog.mjs';
import { PROMOTABLE_CONSTANT_KEYS, loadCurrentConstants } from './currentConstants.mjs';
import { validateGoldenFixtures } from './goldenFixtures.mjs';

const fmtPct = (value) => Number.isFinite(value) ? `${value.toFixed(1)}%` : 'n/a';

function constantDeviation(current, fitted) {
  if (!Number.isFinite(current) || !Number.isFinite(fitted) || fitted === 0) return null;
  return ((current - fitted) / fitted) * 100;
}

function printConstantValidation(result, currentConstants) {
  console.log('');
  console.log('CURRENT CONSTANT DEVIATION FROM FIT');
  for (const key of PROMOTABLE_CONSTANT_KEYS) {
    const current = Number(currentConstants[key]);
    const fitted = Number(result.constants[key]);
    const deviation = constantDeviation(current, fitted);
    console.log(`${key}: current ${current} | fitted ${fitted} | deviation ${fmtPct(deviation)}`);
  }
}

function printGoldenResults(golden) {
  const passed = golden.failures.length === 0;
  console.log('');
  console.log(`Golden fixtures: ${passed ? 'PASS' : 'FAIL'} (${golden.checks.length} checks, ${golden.failures.length} failures)`);
  golden.failures.slice(0, 20).forEach((failure) => {
    console.log(`  FAIL ${failure.file} ${failure.key}: expected ${failure.expected}, actual ${failure.actual}, delta ${failure.delta.toFixed(3)}`);
    if (failure.output) console.log(failure.output);
  });
}

function auditMaeFailure(result, lastAudit) {
  const currentMae = Number(result.validation.crossValidationMAE);
  const lastMae = Number(lastAudit?.validation?.crossValidationMAE);
  if (!Number.isFinite(currentMae) || !Number.isFinite(lastMae)) return null;
  const delta = currentMae - lastMae;
  return {
    currentMae,
    lastMae,
    delta,
    failed: delta > 2,
  };
}

export async function validateCalibration(result) {
  const currentConstants = await loadCurrentConstants();
  const lastAudit = await readLastAuditEntry();
  const golden = await validateGoldenFixtures(2);
  const mae = auditMaeFailure(result, lastAudit);

  printConstantValidation(result, currentConstants);
  printGoldenResults(golden);
  if (mae) {
    console.log(`Cross-validation MAE vs last promotion: ${mae.currentMae} now / ${mae.lastMae} last (${mae.delta >= 0 ? '+' : ''}${mae.delta.toFixed(3)}) ${mae.failed ? 'FAIL' : 'PASS'}`);
  } else {
    console.log('Cross-validation MAE vs last promotion: SKIP (no audit baseline)');
  }

  if (golden.failures.length > 0 || mae?.failed) {
    process.exitCode = 1;
  }
}
