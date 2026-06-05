#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { loadGitHubEvent } from './ci/calibrationGate/githubEvent.mjs';
import { writeGitHubOutput, warn } from './ci/calibrationGate/githubOutput.mjs';
import {
  changedFilesBetween,
  changedFilesFromPullRequestMerge,
} from './ci/calibrationGate/gitChanges.mjs';
import { auditLogPath } from './ci/calibrationGate/paths.mjs';
import { shouldValidateCalibration } from './ci/calibrationGate/rules.mjs';

function withFallback(primary, fallback) {
  try {
    return primary();
  } catch {
    return fallback();
  }
}

function pullRequestChangedFiles(event) {
  return withFallback(
    () => changedFilesBetween(event.pull_request?.base?.sha, event.pull_request?.head?.sha),
    () => changedFilesFromPullRequestMerge(),
  );
}

function changedFilesForEvent(eventName, event) {
  if (eventName !== 'pull_request') return [];
  return pullRequestChangedFiles(event);
}

const event = await loadGitHubEvent();
const changedFiles = changedFilesForEvent(process.env.GITHUB_EVENT_NAME, event);
const shouldValidate = shouldValidateCalibration({ changedFiles });
const auditExists = existsSync(auditLogPath);

await writeGitHubOutput('should_validate', String(shouldValidate && auditExists));
await writeGitHubOutput('audit_exists', String(auditExists));

if (shouldValidate && !auditExists) {
  warn('scripts/calibration-audit-log.jsonl does not exist; skipping calibration validation until the first promotion is recorded.');
}

console.log(`Calibration validation gate: ${shouldValidate && auditExists ? 'run' : 'skip'}`);
