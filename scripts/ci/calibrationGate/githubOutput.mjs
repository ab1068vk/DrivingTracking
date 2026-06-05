import { appendFile } from 'node:fs/promises';

export async function writeGitHubOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  const line = `${name}=${value}\n`;
  if (!outputPath) {
    process.stdout.write(line);
    return;
  }

  await appendFile(outputPath, line, 'utf8');
}

export function warn(message) {
  console.warn(`::warning::${message}`);
}
