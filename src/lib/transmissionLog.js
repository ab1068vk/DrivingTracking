import { appendPrivacyEvent } from '@/lib/hashChainLog';
import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { logSystemFailure } from '@/lib/systemLog';

export const TRANSMISSION_LOG_KEY = 'drivesense_transmission_log_v1';

const MAX_ENTRIES = 500;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const COORDINATE_DISCLOSURE_VALUES = Object.freeze([
  'none',
  'blocked',
  'raw',
  'rounded',
  'bounding_box',
  'masked',
  'committed',
]);
let logWriteQueue = Promise.resolve();

const safeText = (value, fallback = '') => (
  value == null ? fallback : String(value).replace(/\s+/g, ' ').trim().slice(0, 180)
);

const safeArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => safeText(item)).filter(Boolean).slice(0, 20)
    : []
);

const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const generateId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const PROTECTED_DISCLOSURES = new Set(['rounded', 'bounding_box', 'masked', 'committed']);

function verificationWarningsFor(record) {
  const warnings = [];
  if (record.coordinateDisclosure === 'raw') {
    warnings.push('Raw coordinates left the app; consent or guards do not make this a protected send.');
    if (!record.protections.some((item) => /explicit consent/i.test(item))) {
      warnings.push('Raw coordinate send has no explicit-consent metadata.');
    }
  }
  if (record.coordinateDisclosure === 'blocked' && (record.sentCoords || record.bytesOut > 0)) {
    warnings.push('Blocked transmission includes send metadata that should be empty.');
  }
  if (PROTECTED_DISCLOSURES.has(record.coordinateDisclosure)) {
    if (!record.privacyTransformVerified) {
      warnings.push('Protection is caller-reported but not verified by named pre-send evidence.');
    }
    if (record.privacyTransformVerified && !record.privacyVerificationEvidence.length) {
      warnings.push('Verified protection is missing evidence details.');
    }
  }
  return warnings;
}

function statusForRecord(record) {
  if (record.coordinateDisclosure === 'blocked') return 'blocked';
  if (record.coordinateDisclosure === 'raw') return 'warning';
  if ((record.privacyVerificationWarnings || []).length) return 'warning';
  return ['safe', 'blocked', 'warning'].includes(record.status) ? record.status : 'safe';
}

export async function loadTransmissionLog() {
  try {
    const log = await getEncryptedJson(TRANSMISSION_LOG_KEY, []);
    if (!Array.isArray(log)) return [];
    const now = Date.now();
    return log
      .filter((entry) => Number(entry?.expiresAt) > now)
      .map(migrateTransmissionEntry)
      .slice(-MAX_ENTRIES);
  } catch (error) {
    logSystemFailure('transmission_log_load', error);
    return [];
  }
}

export async function clearTransmissionLog() {
  logWriteQueue = logWriteQueue
    .catch(() => {})
    .then(() => setEncryptedJson(TRANSMISSION_LOG_KEY, []));
  await logWriteQueue;
  await appendPrivacyEvent({ op: 'TRANSMISSION_LOG_CLEARED' });
}

export async function logTransmission(entry = {}) {
  if (!COORDINATE_DISCLOSURE_VALUES.includes(entry.coordinateDisclosure)) {
    throw new Error(
      `logTransmission: invalid coordinateDisclosure "${entry.coordinateDisclosure}". ` +
      `Expected one of: ${COORDINATE_DISCLOSURE_VALUES.join(', ')}`
    );
  }
  const now = Date.now();
  const privacyTransformSource = entry.privacyTransformSource == null
    ? null
    : safeText(entry.privacyTransformSource);
  const privacyVerificationEvidence = safeArray(entry.privacyVerificationEvidence);
  const privacyTransformVerified = entry.privacyTransformVerified === true &&
    Boolean(privacyTransformSource) &&
    (
      !PROTECTED_DISCLOSURES.has(entry.coordinateDisclosure) ||
      privacyVerificationEvidence.length > 0
    );
  const record = {
    id: generateId(),
    timestamp: now,
    service: safeText(entry.service, 'unknown'),
    type: safeText(entry.type, 'Outbound request'),
    coordinateDisclosure: entry.coordinateDisclosure,
    privacyTransformVerified,
    privacyTransformSource,
    privacyVerificationEvidence,
    sentCoords: entry.sentCoords == null ? null : safeText(entry.sentCoords),
    protections: safeArray(entry.protections),
    offsetMeters: entry.offsetMeters == null ? null : safeNumber(entry.offsetMeters, null),
    bytesOut: Math.max(0, Math.round(safeNumber(entry.bytesOut, 0))),
    bytesIn: Math.max(0, Math.round(safeNumber(entry.bytesIn, 0))),
    status: ['safe', 'blocked', 'warning'].includes(entry.status) ? entry.status : 'safe',
    tripId: entry.tripId == null ? null : safeText(entry.tripId),
    zonesSuppressed: safeArray(entry.zonesSuppressed),
    expiresAt: now + EXPIRY_MS,
    schemaVersion: 2,
  };
  record.privacyVerificationWarnings = [
    ...safeArray(entry.privacyVerificationWarnings),
    ...verificationWarningsFor(record),
  ];
  record.status = statusForRecord(record);

  try {
    logWriteQueue = logWriteQueue
      .catch(() => {})
      .then(async () => {
        const existing = await loadTransmissionLog();
        await setEncryptedJson(TRANSMISSION_LOG_KEY, [...existing, record].slice(-MAX_ENTRIES));
      });
    await logWriteQueue;
  } catch (error) {
    logSystemFailure('transmission_log_write', error, {
      service: record.service,
      status: record.status,
    });
  }

  try {
    await appendPrivacyEvent({
      op: 'TRANSMISSION',
      tripId: record.tripId,
      zoneLabel: record.zonesSuppressed.join(', ') || undefined,
      details: {
        service: record.service,
        status: record.status,
      },
    });
  } catch (error) {
    logSystemFailure('transmission_audit_append', error, {
      service: record.service,
      status: record.status,
    });
  }

  return record;
}

export { loadTransmissionLog as loadLog };

export function migrateTransmissionEntry(entry = {}) {
  if (entry.schemaVersion === 2 && COORDINATE_DISCLOSURE_VALUES.includes(entry.coordinateDisclosure)) {
    return {
      ...entry,
      protections: safeArray(entry.protections),
      privacyVerificationEvidence: safeArray(entry.privacyVerificationEvidence),
      privacyVerificationWarnings: safeArray(entry.privacyVerificationWarnings),
    };
  }
  const protections = safeArray(entry.protections);
  const joined = protections.join(' ');
  let coordinateDisclosure = 'raw';
  if (entry.status === 'blocked') coordinateDisclosure = 'blocked';
  else if (!entry.sentCoords) coordinateDisclosure = 'none';
  else if (/bbox|bounding/i.test(joined)) coordinateDisclosure = 'bounding_box';
  else if (/round|guard|offset|buffer/i.test(joined)) coordinateDisclosure = 'rounded';
  else if (/commit/i.test(joined)) coordinateDisclosure = 'committed';
  else if (/mask|scrub/i.test(joined)) coordinateDisclosure = 'masked';
  return {
    ...entry,
    protections,
    coordinateDisclosure,
    privacyTransformVerified: false,
    privacyTransformSource: 'migrated_from_v1',
    privacyVerificationEvidence: [],
    privacyVerificationWarnings: ['Legacy transmission claim was migrated without pre-send verification evidence.'],
    schemaVersion: 2,
  };
}
