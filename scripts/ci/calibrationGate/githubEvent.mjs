import { readFile } from 'node:fs/promises';

export async function loadGitHubEvent(eventPath = process.env.GITHUB_EVENT_PATH) {
  if (!eventPath) return {};

  const source = await readFile(eventPath, 'utf8');
  return JSON.parse(source);
}
