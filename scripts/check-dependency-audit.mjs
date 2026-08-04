import { execFileSync } from 'node:child_process';

/**
 * Fails on any npm advisory at or above moderate severity, except advisories
 * that are explicitly reviewed here and shown to be unreachable in this app.
 *
 * An entry is a deliberate, temporary exception - not a dismissal. Re-review it
 * whenever the dependency changes, and delete it as soon as a fixed version is
 * reachable without a breaking migration. Any advisory not listed here still
 * fails the build, so a NEW react-router advisory is not silently covered by
 * the existing entries.
 */
const REVIEWED_EXCEPTIONS = [
  {
    ghsa: 'GHSA-wrjc-x8rr-h8h6',
    package: 'react-router',
    title: 'Open redirect via backslash in <Link> and useNavigate',
    reviewedOn: '2026-08-03',
    reason: [
      'Not reachable: no navigation target in this app comes from untrusted input.',
      'Every <Link to> / navigate() target is an internal literal or a template',
      'over an app-generated id. The only external entry point is a deep link,',
      'and src/lib/appNavigation.js resolves those through a fixed allowlist with',
      'encodeURIComponent on the single dynamic segment (trip id).',
      'Fixed in react-router 7.18+, a breaking major upgrade from 6.x.',
    ].join(' '),
  },
  {
    ghsa: 'GHSA-337j-9hxr-rhxg',
    package: 'react-router',
    title: 'Arbitrary Constructor Injection via deserializeErrors() in SSR hydration',
    reviewedOn: '2026-08-03',
    reason: [
      'Not reachable: this is a client-only SPA inside a Capacitor shell.',
      'There is no server renderer and no hydration path, so deserializeErrors()',
      'never runs. Fixed in react-router 7.18+, a breaking major upgrade from 6.x.',
    ].join(' '),
  },
  {
    ghsa: 'GHSA-jjmj-jmhj-qwj2',
    package: 'react-router-dom',
    title: 'Open redirect leading to XSS',
    reviewedOn: '2026-08-03',
    reason: [
      'Same root cause and same reasoning as GHSA-wrjc-x8rr-h8h6:',
      'react-router-dom is flagged only because it depends on react-router.',
    ].join(' '),
  },
];

const BLOCKING_SEVERITIES = new Set(['moderate', 'high', 'critical']);
const allowedGhsaIds = new Set(REVIEWED_EXCEPTIONS.map((entry) => entry.ghsa));

function readAudit() {
  try {
    // npm audit exits non-zero whenever findings exist, so a thrown error still
    // carries the report on stdout. Only an unparseable body is a real failure.
    return JSON.parse(execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }));
  } catch (error) {
    const body = error?.stdout;
    if (!body) {
      console.error('Could not run npm audit.');
      console.error(error?.message || error);
      process.exit(1);
    }
    try {
      return JSON.parse(body);
    } catch {
      console.error('npm audit did not return parseable JSON.');
      process.exit(1);
    }
  }
  return {};
}

const audit = readAudit();
const blocking = [];
const covered = new Set();

for (const [name, vulnerability] of Object.entries(audit.vulnerabilities || {})) {
  if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;

  for (const via of vulnerability.via || []) {
    // A string `via` is an indirect flag through another package; the advisory
    // it points at is reported on that package's own entry.
    if (typeof via === 'string') continue;
    if (typeof via.url === 'string' && allowedGhsaIds.has(via.url.split('/').pop())) {
      covered.add(via.url.split('/').pop());
      continue;
    }
    blocking.push({
      package: name,
      severity: vulnerability.severity,
      title: via.title,
      url: via.url,
    });
  }
}

const staleExceptions = REVIEWED_EXCEPTIONS.filter((entry) => !covered.has(entry.ghsa));

if (blocking.length > 0) {
  console.error('Unreviewed dependency advisories at or above moderate severity:');
  for (const finding of blocking) {
    console.error(`- [${finding.severity}] ${finding.package}: ${finding.title}`);
    console.error(`  ${finding.url}`);
  }
  console.error('');
  console.error('Run "npm audit fix" first. If no fix exists without a breaking upgrade,');
  console.error('review the advisory and add it to REVIEWED_EXCEPTIONS in this file with');
  console.error('the reason it is not reachable in this app.');
  process.exit(1);
}

if (staleExceptions.length > 0) {
  console.error('These reviewed exceptions no longer match any advisory and must be removed:');
  for (const entry of staleExceptions) {
    console.error(`- ${entry.ghsa} (${entry.package}): ${entry.title}`);
  }
  console.error('');
  console.error('A resolved advisory means the exception is obsolete. Delete it so a future');
  console.error('advisory cannot inherit an unrelated justification.');
  process.exit(1);
}

console.log(
  `Dependency audit check passed. ${REVIEWED_EXCEPTIONS.length} reviewed exception${
    REVIEWED_EXCEPTIONS.length === 1 ? '' : 's'
  } still applied:`
);
for (const entry of REVIEWED_EXCEPTIONS) {
  console.log(`- ${entry.package} ${entry.ghsa} (reviewed ${entry.reviewedOn}): ${entry.title}`);
}
