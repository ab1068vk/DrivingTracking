import { describe, expect, it } from 'vitest';
import { shouldValidateCalibration } from './rules.mjs';

describe('calibration validation gate rules', () => {
  it('runs on pushes to main', () => {
    expect(shouldValidateCalibration({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
      },
    })).toBe(true);
  });

  it('skips pushes away from main', () => {
    expect(shouldValidateCalibration({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/feature',
      },
    })).toBe(false);
  });

  it('runs for pull requests touching calibration-sensitive files', () => {
    expect(shouldValidateCalibration({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
      },
      changedFiles: ['src/lib/calibrationFitting.js'],
    })).toBe(true);
  });

  it('skips pull requests without calibration-sensitive changes', () => {
    expect(shouldValidateCalibration({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
      },
      changedFiles: ['src/App.jsx'],
    })).toBe(false);
  });
});
