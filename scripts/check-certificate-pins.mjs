import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve('android/app/src/main/res/xml/network_security_config.xml');
const DEFAULT_RENEWAL_LEAD_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const renewalLeadDays = Number.parseInt(
  process.env.CERT_PIN_RENEWAL_LEAD_DAYS || `${DEFAULT_RENEWAL_LEAD_DAYS}`,
  10,
);

if (!Number.isFinite(renewalLeadDays) || renewalLeadDays < 1) {
  console.error('CERT_PIN_RENEWAL_LEAD_DAYS must be a positive integer.');
  process.exit(1);
}

const today = startOfUtcDay(process.env.CERT_PIN_CHECK_DATE ? new Date(process.env.CERT_PIN_CHECK_DATE) : new Date());

if (Number.isNaN(today.getTime())) {
  console.error('CERT_PIN_CHECK_DATE must be parseable as a date when set.');
  process.exit(1);
}

const xml = readFileSync(CONFIG_PATH, 'utf8');
const pinSets = parsePinSets(xml);

if (pinSets.length === 0) {
  console.error(`No certificate pin sets found in ${CONFIG_PATH}.`);
  process.exit(1);
}

const problems = [];
const summaries = [];

for (const pinSet of pinSets) {
  if (!pinSet.expiration) {
    problems.push(`${pinSet.domain}: pin-set is missing an expiration date.`);
    continue;
  }

  const expiration = parseIsoDate(pinSet.expiration);
  if (!expiration) {
    problems.push(`${pinSet.domain}: invalid pin-set expiration "${pinSet.expiration}".`);
    continue;
  }

  if (pinSet.pins.length < 2) {
    problems.push(`${pinSet.domain}: expected at least two pins so rotation has a backup.`);
  }

  const uniquePins = new Set(pinSet.pins);
  if (uniquePins.size !== pinSet.pins.length) {
    problems.push(`${pinSet.domain}: duplicate certificate pins are configured.`);
  }

  const daysRemaining = Math.ceil((expiration.getTime() - today.getTime()) / MS_PER_DAY);
  const renewBy = addUtcDays(expiration, -renewalLeadDays);
  summaries.push(`${pinSet.domain}: expires ${pinSet.expiration}, renew by ${formatIsoDate(renewBy)} (${daysRemaining} days remaining)`);

  if (daysRemaining < 0) {
    problems.push(`${pinSet.domain}: pin-set expired on ${pinSet.expiration}.`);
  } else if (daysRemaining <= renewalLeadDays) {
    problems.push(
      `${pinSet.domain}: pin-set expires in ${daysRemaining} days on ${pinSet.expiration}; renew at least ${renewalLeadDays} days before expiration.`,
    );
  }
}

if (problems.length > 0) {
  console.error('Certificate pin renewal check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error('');
  console.error('Renew pins using docs/CERTIFICATE_PIN_RENEWAL.md, then update all Android/JS pin mirrors together.');
  process.exit(1);
}

console.log('Certificate pin renewal check passed.');
for (const summary of summaries) console.log(`- ${summary}`);

function parsePinSets(configXml) {
  const domainConfigPattern = /<domain-config\b[\s\S]*?<\/domain-config>/g;
  const pinSets = [];

  for (const [domainConfig] of configXml.matchAll(domainConfigPattern)) {
    const domainMatch = domainConfig.match(/<domain\b[^>]*>([^<]+)<\/domain>/);
    const pinSetMatch = domainConfig.match(/<pin-set\b([^>]*)>([\s\S]*?)<\/pin-set>/);
    if (!domainMatch || !pinSetMatch) continue;
    const expirationMatch = pinSetMatch[1].match(/\bexpiration="([^"]+)"/);

    const pins = [...pinSetMatch[2].matchAll(/<pin\b[^>]*\bdigest="SHA-256"[^>]*>([^<]+)<\/pin>/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);

    pinSets.push({
      domain: domainMatch[1].trim(),
      expiration: expirationMatch ? expirationMatch[1].trim() : '',
      pins,
    });
  }

  return pinSets;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return formatIsoDate(date) === value ? date : null;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}
