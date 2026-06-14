import { appendPrivacyEvent } from '@/lib/hashChainLog';
import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { logSystemFailure } from '@/lib/systemLog';

export const TRANSMISSION_LOG_KEY = 'drivesense_transmission_log_v1';

const MAX_ENTRIES = 500;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
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

export async function loadTransmissionLog() {
  try {
    const log = await getEncryptedJson(TRANSMISSION_LOG_KEY, []);
    if (!Array.isArray(log)) return [];
    const now = Date.now();
    return log
      .filter((entry) => Number(entry?.expiresAt) > now)
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
}

export async function logTransmission(entry = {}) {
  const now = Date.now();
  const record = {
    id: generateId(),
    timestamp: now,
    service: safeText(entry.service, 'unknown'),
    type: safeText(entry.type, 'Outbound request'),
    sentCoords: entry.sentCoords == null ? null : safeText(entry.sentCoords),
    protections: safeArray(entry.protections),
    offsetMeters: entry.offsetMeters == null ? null : safeNumber(entry.offsetMeters, null),
    bytesOut: Math.max(0, Math.round(safeNumber(entry.bytesOut, 0))),
    bytesIn: Math.max(0, Math.round(safeNumber(entry.bytesIn, 0))),
    status: ['safe', 'blocked', 'warning'].includes(entry.status) ? entry.status : 'safe',
    tripId: entry.tripId == null ? null : safeText(entry.tripId),
    zonesSuppressed: safeArray(entry.zonesSuppressed),
    expiresAt: now + EXPIRY_MS,
  };

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
