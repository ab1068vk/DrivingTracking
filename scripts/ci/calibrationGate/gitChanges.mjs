import { execFileSync } from 'node:child_process';

function cleanFileList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function changedFilesBetween(baseSha, headSha) {
  if (!baseSha || !headSha) return [];

  return changedFilesFromGit(['diff', '--name-only', baseSha, headSha]);
}

export function changedFilesFromPullRequestMerge() {
  return changedFilesFromGit(['diff', '--name-only', 'HEAD^1', 'HEAD']);
}

function changedFilesFromGit(args) {
  const output = execFileSync('git', args, {
    encoding: 'utf8',
  });

  return cleanFileList(output);
}
