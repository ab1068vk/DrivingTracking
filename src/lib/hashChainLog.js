import { isNativePlatform } from '@/lib/nativePlatform';
import { registerPlugin } from '@capacitor/core';
import { createAuditV2, AuditWork } from '@/lib/hashChainLogV2';
import {
  AUDIT_FORMAT_KEY, auditBytes, auditError, introduceAuditFence,
  readAuditFence, withAuditWebLock,
} from '@/lib/privacyAuditFormat';

export const PRIVACY_AUDIT_CHAIN_KEY = 'drivesense_privacy_audit_chain_v1';
export const PRIVACY_AUDIT_ANCHOR_KEY = 'drivesense_privacy_audit_anchor_v1';
export const LAST_CHECKPOINT_EXPORT_KEY = 'drivesense_last_checkpoint_export_at';
export const GENESIS_HASH = '0'.repeat(64);

const AUDIT_SCHEMA = 'drivesense_privacy_audit_v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const memoryStorage = new Map();
const DETAIL_ALLOWLIST = new Set([
  'affected_trip_count',
  'event_count',
  'failure_count',
  'hidden_event_count',
  'hidden_point_count',
  'native_tracking_stopped',
  'point_count',
  'privacy_gap_count',
  'privacy_zone_count',
  'purge_raw_gps',
  'purged_event_count',
  'purged_point_count',
  'purged_motion_sample_count',
  'purged_trip_count',
  'reason',
  'segment_count',
  'service',
  'snapped_coverage',
  'status',
  'trip_count',
  'zone_count',
]);
const SENSITIVE_KEY = /(^|[_-])(lat|lng|longitude|latitude|coordinate|coordinates|radius|radius_m|route_points|driving_events|address|email|phone|token|password|secret)($|[_-])/i;
const AuditAnchor = registerPlugin('AuditAnchor');

const hasLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const removeUndefined = (value) => {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((acc, [key, item]) => {
    if (item !== undefined) acc[key] = removeUndefined(item);
    return acc;
  }, {});
};

const canonicalStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

async function readRaw(key) {
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key });
    return value;
  }
  if (hasLocalStorage()) return localStorage.getItem(key);
  return memoryStorage.has(key) ? memoryStorage.get(key) : null;
}

async function writeRaw(key, value) {
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key, value });
    return;
  }
  if (hasLocalStorage()) {
    localStorage.setItem(key, value);
    return;
  }
  memoryStorage.set(key, value);
}

const parseStoredJson = async (key, fallback) => {
  const raw = await readRaw(key);
  if (!raw) return { ok: true, missing: true, value: fallback };
  try {
    return { ok: true, missing: false, value: JSON.parse(raw) };
  } catch {
    return { ok: false, missing: false, value: fallback };
  }
};

async function sha256hex(input, work) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === 'undefined') {
    throw new Error('SHA-256 is unavailable in this runtime.');
  }
  const encoded = new TextEncoder().encode(input);
  work?.bytes(encoded.byteLength);
  const digest = await subtle.digest('SHA-256', encoded);
  work?.bytes(digest.byteLength);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const safeString = (value, fallback = '') => {
  if (value == null) return fallback;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 160) || fallback;
};

const safeNumber = (value, fallback = undefined) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const sanitizeDetails = (details = {}) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  return Object.entries(details).reduce((acc, [key, value]) => {
    if (!DETAIL_ALLOWLIST.has(key) || SENSITIVE_KEY.test(key)) return acc;
    if (typeof value === 'boolean') acc[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) acc[key] = value;
    else if (typeof value === 'string') acc[key] = safeString(value);
    return acc;
  }, {});
};

function normalizePrivacyEvent(event = {}, seq, prevHash) {
  const details = sanitizeDetails({ ...event.details, ...event });
  return removeUndefined({
    schema: AUDIT_SCHEMA,
    seq,
    timestamp: safeNumber(event.timestamp, Date.now()),
    op: safeString(event.op || event.operation || event.type, 'PRIVACY_EVENT'),
    operation_id: safeString(event.operationId ?? event.operation_id, undefined),
    zone_id: safeString(event.zoneId ?? event.zone_id, undefined),
    zone_label: safeString(event.zoneLabel ?? event.zone_label, undefined),
    hidden_count: safeNumber(event.hiddenCount ?? event.hidden_count, 0) || 0,
    trip_id: safeString(event.tripId ?? event.trip_id, undefined),
    details: Object.keys(details).length ? details : undefined,
    prevHash,
  });
}

async function readAuditState() {
  const chainResult = await parseStoredJson(PRIVACY_AUDIT_CHAIN_KEY, []);
  const anchorResult = await parseStoredJson(PRIVACY_AUDIT_ANCHOR_KEY, null);
  return {
    chainResult,
    anchorResult,
    chain: Array.isArray(chainResult.value) ? chainResult.value : [],
    anchor: anchorResult.value && typeof anchorResult.value === 'object' ? anchorResult.value : null,
  };
}

async function verifyAuditState({ chainResult, anchorResult, chain, anchor }) {
  if (!chainResult.ok) return { valid: false, brokenAt: 0, reason: 'Audit log JSON could not be parsed.' };
  if (!Array.isArray(chainResult.value)) return { valid: false, brokenAt: 0, reason: 'Audit log is not an array.' };
  if (!anchorResult.ok) return { valid: false, brokenAt: chain.length, reason: 'Audit log anchor JSON could not be parsed.' };
  if (!anchor && chain.length > 0) return { valid: false, brokenAt: chain.length, reason: 'Audit log tip anchor is missing.' };

  let expected = GENESIS_HASH;
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index] || {};
    const {
      hash,
      tipSignature: _tipSignature,
      signingPublicKey: _signingPublicKey,
      ...body
    } = entry;
    if (body.seq !== index + 1) {
      return { valid: false, brokenAt: index, reason: `Sequence mismatch at seq ${body.seq ?? index + 1}` };
    }
    if (body.prevHash !== expected) {
      return { valid: false, brokenAt: index, reason: `prevHash mismatch at seq ${body.seq}` };
    }
    if (!HASH_PATTERN.test(String(hash || ''))) {
      return { valid: false, brokenAt: index, reason: `Missing content hash at seq ${body.seq}` };
    }
    const recomputed = await sha256hex(canonicalStringify(removeUndefined(body)));
    if (recomputed !== hash) {
      return { valid: false, brokenAt: index, reason: `Content hash mismatch at seq ${body.seq}` };
    }
    expected = hash;
  }

  const expectedAnchor = anchor || { length: 0, tip: GENESIS_HASH };
  if (expectedAnchor.length !== chain.length) {
    return { valid: false, brokenAt: chain.length, reason: 'Audit log length does not match the stored tip anchor.' };
  }
  if (expectedAnchor.tip !== expected) {
    return { valid: false, brokenAt: chain.length, reason: 'Audit log tip hash does not match the stored tip anchor.' };
  }

  return { valid: true, length: chain.length, tip: expected };
}

export async function loadPrivacyAuditChain() {
  return runPrivacyOwner(async () => (await readSelectedAudit(false)).chain);
}

// Consumers that need both entries and verification should use one secure
// storage snapshot instead of loading the chain twice.
export async function loadVerifiedPrivacyAuditChain() {
  try { return await runPrivacyOwner(() => readSelectedAudit(true)); }
  catch (error) { return { chain: [], result: { valid: false, reason: error.message } }; }
}

let privacyAppendQueue = Promise.resolve();
let privacyOwnerPending = 0;

// One logical owner and queue across formats. A lifecycle attempt cannot join
// a queue containing an explicit history-sized read/conversion.
function runPrivacyOwner(run, { bounded = false } = {}) {
  if (bounded && privacyOwnerPending > 0) return Promise.reject(auditError('AUDIT_BUSY'));
  privacyOwnerPending += 1;
  const operation = privacyAppendQueue.then(() => withAuditWebLock(run, { bounded }))
    .finally(() => { privacyOwnerPending -= 1; });
  privacyAppendQueue = operation.catch(() => undefined);
  return operation;
}

async function signAuditEntry(entry, work) {
  if (!isNativePlatform()) return;
  try {
    const payload = { tipHash: entry.hash };
    work?.bytes(auditBytes(JSON.stringify(payload)) + auditBytes(entry.hash));
    const signed = await AuditAnchor.signTipHash(payload);
    work?.bytes(2 * auditBytes(JSON.stringify(signed)));
    entry.tipSignature = signed.signature || null;
    entry.signingPublicKey = signed.publicKey || null;
  } catch (error) {
    if (error?.code === 'AUDIT_WORK_LIMIT') throw error;
    work?.bytes(2 * auditBytes(JSON.stringify({ message: String(error?.message || error) })));
    entry.tipSignature = null; entry.signingPublicKey = null;
  }
}

const auditV2 = createAuditV2({
  canonical: canonicalStringify, normalize: normalizePrivacyEvent,
  operationId: (event) => safeString(event.operationId ?? event.operation_id, undefined),
  hash: sha256hex, sign: signAuditEntry, verifyLegacy: verifyAuditState, readLegacy: readAuditState,
});

async function readSelectedAudit(verified) {
  const fence = await introduceAuditFence();
  const selected = await auditV2.selector(fence);
  if (selected.format === 2) return auditV2.read(fence, verified);
  if (selected.state === 'FRESH_PENDING') {
    await auditV2.initialize(fence);
    return auditV2.read(await readAuditFence(), verified);
  }
  const state = await readAuditState(); // Explicit v1 authority only.
  return { chain: state.chain, result: verified ? await verifyAuditState(state) : null };
}

export function initializePrivacyAudit() {
  return runPrivacyOwner(async () => auditV2.initialize(await introduceAuditFence()));
}

export async function getPrivacyAuditReadiness() {
  const work = new AuditWork();
  try {
    return await runPrivacyOwner(async () => {
      const fence = await readAuditFence(work);
      const result = await auditV2.selector(fence, work);
      return { state: result.state, ...work.result() };
    }, { bounded: true });
  } catch (error) { return { state: typeof error.code === 'string' ? error.code : 'AUDIT_STORAGE_UNAVAILABLE', ...work.result() }; }
}

// A committed receipt only, never an old event body. ACK runs under this same
// owner lock so full erasure cannot interleave between commit and native ACK.
export async function appendPrivacyEventBounded(event, { afterCommit } = {}) {
  const work = new AuditWork(true);
  try {
    return await runPrivacyOwner(async () => {
      const { entry: _entry, ...receipt } = await auditV2.append(event, work);
      const acknowledgement = afterCommit ? await afterCommit(receipt) : undefined;
      return { state: 'READY', ...receipt, ...work.result(), acknowledgement };
    }, { bounded: true });
  } catch (error) {
    return { state: typeof error.code === 'string' ? error.code : 'AUDIT_STORAGE_UNAVAILABLE', ...work.result(), error: error.message };
  }
}

export async function runPrivacyAuditCompatibilityUpgrade(options = {}) {
  const result = await runPrivacyOwner(async () => auditV2.convert(await introduceAuditFence(), options));
  if (result.state === 'READY') {
    // Existing reviewed wake vocabulary; this owner never schedules its own turn.
    const { notifyPrivacyAuditConversionComplete } = await import('@/lib/appLifecycleWork');
    notifyPrivacyAuditConversionComplete();
  }
  return result;
}

export const beginPrivacyAuditErasure = () => runPrivacyOwner(async () => auditV2.beginErase(await readAuditFence()));
export const finishPrivacyAuditErasure = (token) => runPrivacyOwner(() => auditV2.finishErase(token));
export { AUDIT_FORMAT_KEY };

async function appendPrivacyEventSerialized(event = {}, withDisposition = false) {
  const fence = await introduceAuditFence();
  const selected = await auditV2.selector(fence);
  if (selected.format === 2 || selected.state === 'FRESH_PENDING') {
    await auditV2.initialize(fence);
    const receipt = await auditV2.append(event, new AuditWork(true));
    const entry = receipt.entry || await auditV2.getEntry(receipt.ledgerId, receipt.seq);
    return withDisposition ? { entry, appended: receipt.appended } : entry;
  }
  // Explicit compatibility v1 functionality remains available before cutover.
  // Lifecycle retention exclusively uses appendPrivacyEventBounded instead.
  const state = await readAuditState();
  const current = await verifyAuditState(state);
  if (!current.valid) {
    throw new Error(`Audit log verification failed before append: ${current.reason}`);
  }

  const operationId = safeString(event.operationId ?? event.operation_id, undefined);
  if (operationId) {
    const existing = state.chain.find((entry) => entry?.operation_id === operationId);
    if (existing) return withDisposition ? { entry: existing, appended: false } : existing;
  }

  const prevHash = state.chain.length > 0 ? state.chain[state.chain.length - 1].hash : GENESIS_HASH;
  const body = normalizePrivacyEvent(event, state.chain.length + 1, prevHash);
  const entry = {
    ...body,
    hash: await sha256hex(canonicalStringify(body)),
  };
  if (isNativePlatform()) {
    try {
      const signed = await AuditAnchor.signTipHash({ tipHash: entry.hash });
      entry.tipSignature = signed.signature || null;
      entry.signingPublicKey = signed.publicKey || null;
    } catch {
      entry.tipSignature = null;
      entry.signingPublicKey = null;
    }
  }
  const chain = [...state.chain, entry];
  await writeRaw(PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain));
  await writeRaw(PRIVACY_AUDIT_ANCHOR_KEY, JSON.stringify({
    schema: AUDIT_SCHEMA,
    length: chain.length,
    tip: entry.hash,
    updated_at: Date.now(),
  }));
  return withDisposition ? { entry, appended: true } : entry;
}

export function appendPrivacyEvent(event = {}) {
  return runPrivacyOwner(() => appendPrivacyEventSerialized(event));
}

// Same serialized ledger owner and verification; only expose whether replay
// found a committed operation so secondary retention notices are not doubled.
export function appendPrivacyEventWithDisposition(event = {}) {
  return runPrivacyOwner(() => appendPrivacyEventSerialized(event, true));
}

export async function verifyChain() {
  return (await loadVerifiedPrivacyAuditChain()).result;
}

export async function exportAuditCheckpoint() {
  const { chain, result } = await loadVerifiedPrivacyAuditChain();
  if (!result.valid) throw auditError(`AUDIT_INTEGRITY_FAILED: ${result.reason}`);
  if (!chain.length) throw new Error('Audit chain is empty');
  const tip = chain.at(-1);
  const exportedAt = Date.now();
  const checkpoint = {
    schema: 'ds_audit_checkpoint_v1',
    seq: tip.seq,
    tip_hash: tip.hash,
    signature: tip.tipSignature || null,
    signing_pubkey: tip.signingPublicKey || null,
    chain_length: chain.length,
    exported_at: exportedAt,
  };
  await writeRaw(LAST_CHECKPOINT_EXPORT_KEY, String(exportedAt));
  return checkpoint;
}

export async function getLastCheckpointExportedAt() {
  const timestamp = Number(await readRaw(LAST_CHECKPOINT_EXPORT_KEY));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

const base64Bytes = (value) => {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const derEcdsaToRaw = (signature) => {
  const bytes = base64Bytes(signature);
  if (bytes[0] !== 0x30) throw new Error('Invalid ECDSA signature encoding');
  let offset = bytes[1] & 0x80 ? 2 + (bytes[1] & 0x7f) : 2;
  if (bytes[offset++] !== 0x02) throw new Error('Invalid ECDSA r value');
  const rLength = bytes[offset++];
  const r = bytes.slice(offset, offset + rLength);
  offset += rLength;
  if (bytes[offset++] !== 0x02) throw new Error('Invalid ECDSA s value');
  const sLength = bytes[offset++];
  const s = bytes.slice(offset, offset + sLength);
  const raw = new Uint8Array(64);
  raw.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  raw.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return raw;
};

async function verifyCheckpointSignature(hash, signature, publicKey) {
  if (isNativePlatform()) {
    const result = await AuditAnchor.verifyTipHash({
      tipHash: hash,
      signature,
      publicKey,
    });
    return result?.valid === true;
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === 'undefined') return false;
  const key = await subtle.importKey(
    'spki',
    base64Bytes(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derEcdsaToRaw(signature),
    new TextEncoder().encode(hash)
  );
}

export async function verifyCheckpoint(checkpoint = {}) {
  const hasSignature = Boolean(checkpoint.signature);
  const hasPublicKey = Boolean(checkpoint.signing_pubkey);
  let signatureStatus = 'unsigned';

  if (checkpoint.schema !== 'ds_audit_checkpoint_v1') {
    return {
      valid: false,
      signatureStatus: hasSignature || hasPublicKey ? 'invalid' : 'unsigned',
      reason: 'Unsupported audit checkpoint schema',
    };
  }
  if (hasSignature !== hasPublicKey) {
    return {
      valid: false,
      signatureStatus: 'invalid',
      reason: 'Checkpoint signature metadata is incomplete',
    };
  }
  if (hasSignature && hasPublicKey) {
    try {
      if (!await verifyCheckpointSignature(
        checkpoint.tip_hash,
        checkpoint.signature,
        checkpoint.signing_pubkey
      )) {
        return { valid: false, signatureStatus: 'invalid', reason: 'Checkpoint signature is invalid' };
      }
      signatureStatus = 'verified';
    } catch {
      return {
        valid: false,
        signatureStatus: 'invalid',
        reason: 'Checkpoint signature could not be verified',
      };
    }
  }
  const { chain, result: currentVerification } = await loadVerifiedPrivacyAuditChain();
  if (!currentVerification.valid) {
    return {
      valid: false,
      signatureStatus,
      reason: `Current audit chain is invalid: ${currentVerification.reason}`,
    };
  }
  if (chain.length < checkpoint.seq) {
    return {
      valid: false,
      signatureStatus,
      reason: `Chain is shorter (${chain.length}) than checkpoint seq (${checkpoint.seq})`,
    };
  }
  const entry = chain.find((item) => item.seq === checkpoint.seq);
  if (!entry) {
    return {
      valid: false,
      signatureStatus,
      reason: `No audit entry exists at seq ${checkpoint.seq}`,
    };
  }
  if (entry.hash !== checkpoint.tip_hash) {
    return {
      valid: false,
      signatureStatus,
      reason: `Hash at seq ${checkpoint.seq} does not match the checkpoint`,
    };
  }
  return { valid: true, signatureStatus, verifiedAt: Date.now() };
}
