import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  '.git',
  '.gradle',
  '.gradle-home',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

function walk(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), output);
      continue;
    }
    if (/\.mdx?$/i.test(entry.name)) output.push(path.join(dir, entry.name));
  }
  return output;
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npmScripts = new Set(Object.keys(packageJson.scripts || {}));
const failures = [];

for (const file of walk(ROOT)) {
  const source = fs.readFileSync(file, 'utf8');

  for (const match of source.matchAll(/\[[^\]]*]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
    const target = match[1].split('#')[0].replace(/^<|>$/g, '');
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      failures.push(`${relative(file)}: missing Markdown target ${match[1]}`);
    }
  }

  for (const match of source.matchAll(/npm(?:\.cmd)? run ([a-zA-Z0-9:_-]+)/g)) {
    if (!npmScripts.has(match[1])) {
      failures.push(`${relative(file)}: unknown npm script ${match[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Documentation checks failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Documentation links and npm commands are current.');
