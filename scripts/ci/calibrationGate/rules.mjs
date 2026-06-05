import { calibrationSensitivePaths } from './paths.mjs';

function isMainPush(env) {
  return env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main';
}

function touchesCalibrationSensitivePath(changedFiles) {
  return changedFiles.some((filePath) => calibrationSensitivePaths.includes(filePath));
}

export function shouldValidateCalibration({ env = process.env, changedFiles = [] } = {}) {
  if (isMainPush(env)) return true;
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return false;

  return touchesCalibrationSensitivePath(changedFiles);
}
