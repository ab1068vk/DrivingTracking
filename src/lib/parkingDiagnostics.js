import { getEncryptedJson, removeEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';

const PARKING_DIAGNOSTICS_KEY = 'drivesense_parking_diagnostics_v1';
const MAX_PARKING_DIAGNOSTICS = 100;

const clean = (value, max = 180) => String(value || '').trim().slice(0, max);

export async function recordParkingDiagnostic(type, detail = '', metadata = {}) {
  const current = await getEncryptedJson(PARKING_DIAGNOSTICS_KEY, []);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: clean(type, 80) || 'parking_event',
    detail: clean(detail),
    metadata: Object.fromEntries(
      Object.entries(metadata || {}).slice(0, 12).map(([key, value]) => [
        clean(key, 64),
        typeof value === 'number' || typeof value === 'boolean'
          ? value
          : clean(value, 120),
      ]),
    ),
  };
  const next = [entry, ...(Array.isArray(current) ? current : [])]
    .slice(0, MAX_PARKING_DIAGNOSTICS);
  await setEncryptedJson(PARKING_DIAGNOSTICS_KEY, next);
  return entry;
}

export async function getParkingDiagnostics() {
  const stored = await getEncryptedJson(PARKING_DIAGNOSTICS_KEY, []);
  return Array.isArray(stored) ? stored.slice(0, MAX_PARKING_DIAGNOSTICS) : [];
}

export async function clearParkingDiagnostics() {
  await removeEncryptedJson(PARKING_DIAGNOSTICS_KEY);
}
