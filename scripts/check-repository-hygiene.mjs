import { execFileSync } from 'node:child_process';

const forbiddenTrackedFiles = [
  'android/local.properties',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const trackedFiles = new Set(
  git(['ls-files'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/')),
);

const violations = forbiddenTrackedFiles.filter((file) => trackedFiles.has(file));

if (violations.length > 0) {
  console.error('Machine-local files must not be committed:');
  for (const file of violations) {
    console.error(`- ${file}`);
  }
  console.error('');
  console.error('Run: git rm --cached <file>');
  process.exit(1);
}

console.log('Repository hygiene check passed.');
