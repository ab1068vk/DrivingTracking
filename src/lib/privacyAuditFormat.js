import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from '@/lib/nativePlatform';

// Storage mechanics of hashChainLog, never a second head or generation owner.
export const AUDIT_FORMAT_KEY = 'drivesense_privacy_audit_format_v2';
export const AUDIT_CHAIN_V1 = 'drivesense_privacy_audit_chain_v1';
export const AUDIT_ANCHOR_V1 = 'drivesense_privacy_audit_anchor_v1';
export const AUDIT_LOCK = 'drivesense-privacy-audit-owner';
const STATES = new Set(['FRESH_PENDING', 'LEGACY_AUDIT_UNKNOWN', 'CUTOVER_PENDING', 'V2', 'ERASING']);
const anchor = registerPlugin('AuditAnchor');
export const auditBytes = (value) => new TextEncoder().encode(value).byteLength;
export const newAuditId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, '0')).join('');
export const validAuditId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

export function auditError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code });
}

export function validateAuditFence(fence) {
  if (!fence || !STATES.has(fence.state)
    || (fence.state !== 'LEGACY_AUDIT_UNKNOWN' && !validAuditId(fence.ledgerId))
    || Object.keys(fence).some((key) => !['state', 'ledgerId'].includes(key))
    || auditBytes(JSON.stringify(fence)) > 256) throw auditError('AUDIT_FORMAT_INVALID');
  return fence;
}

// Key names only, capped even when the source's value size is unknown. This is
// called before ordinary browser privacy writers, not from a receipt append.
export function probeBrowserAuditProvenance(storage = globalThis.localStorage) {
  try {
    const before = storage.length;
    if (!Number.isSafeInteger(before) || before < 0 || before > 64) return false;
    const seen = new Set();
    for (let index = 0; index < before; index += 1) {
      const key = storage.key(index);
      if (typeof key !== 'string' || seen.has(key)) return false;
      seen.add(key);
      if (key === AUDIT_CHAIN_V1 || key === AUDIT_ANCHOR_V1 || key === AUDIT_FORMAT_KEY) return false;
    }
    return before === storage.length;
  } catch { return false; }
}

export async function readAuditFence(work) {
  if (isNativePlatform()) {
    const result = await anchor.readAuditFormat();
    work?.external(result.itemsWorked, result.bytesWorked);
    work?.bytes(auditBytes('{}') + 2 * auditBytes(JSON.stringify(result)));
    if (result.error) throw auditError(result.error);
    return validateAuditFence(result.fence);
  }
  work?.probe();
  const raw = globalThis.localStorage?.getItem(AUDIT_FORMAT_KEY);
  work?.read(raw == null ? 0 : auditBytes(raw));
  if (raw == null) return null;
  try { return validateAuditFence(JSON.parse(raw)); }
  catch (cause) { throw auditError('AUDIT_FORMAT_INVALID', cause); }
}

export async function writeAuditFence(fence, work) {
  validateAuditFence(fence);
  if (isNativePlatform()) {
    const result = await anchor.writeAuditFormat({ fence });
    work?.external(result.itemsWorked, result.bytesWorked);
    work?.bytes(auditBytes(JSON.stringify({ fence })) + 2 * auditBytes(JSON.stringify(result)));
    if (result.error) throw auditError(result.error);
  } else {
    if (!globalThis.localStorage) throw auditError('AUDIT_STORAGE_UNAVAILABLE');
    const raw = JSON.stringify(fence);
    work?.bytes(auditBytes(raw));
    globalThis.localStorage.setItem(AUDIT_FORMAT_KEY, raw);
  }
}

export async function introduceAuditFence() {
  const existing = await readAuditFence();
  if (existing) return existing;
  // Native absence is never inferred here: its pre-WebView helper owns that
  // proof. A missing native marker is returned as UNKNOWN by the native helper.
  const fresh = !isNativePlatform() && probeBrowserAuditProvenance();
  const fence = fresh ? { state: 'FRESH_PENDING', ledgerId: newAuditId() }
    : { state: 'LEGACY_AUDIT_UNKNOWN' };
  await writeAuditFence(fence);
  return fence;
}

export async function withAuditWebLock(run, { bounded = false } = {}) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) throw auditError('AUDIT_LOCK_UNAVAILABLE');
  return locks.request(AUDIT_LOCK, { mode: 'exclusive', ...(bounded ? { ifAvailable: true } : {}) },
    (lock) => {
      if (!lock) throw auditError('AUDIT_BUSY');
      return run();
    });
}
