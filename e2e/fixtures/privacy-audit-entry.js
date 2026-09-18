import * as audit from '../../src/lib/hashChainLog';
import { createP5RawGpsRetentionAdapter } from '../../src/lib/p5RawGpsRetentionAdapter';
import { eraseAllLocalDataAndBuildReceipt, buildDataPortabilityExport } from '../../src/lib/dataRights';

const bytes = (value) => new TextEncoder().encode(value).length;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hex = (value) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
// Test data generator, not an alternative append owner. Feed an independently
// formed legacy chain into the real explicit converter, including unknown fields.
async function seedLegacy(length) {
  const chain = []; let tip = '0'.repeat(64);
  for (let seq = 1; seq <= length; seq += 1) {
    const body = { schema: 'drivesense_privacy_audit_v1', seq, timestamp: seq,
      op: 'LEGACY', operation_id: seq <= 2 ? 'legacy-duplicate' : `legacy-${seq}`,
      future_extension: { preserved: seq }, prevHash: tip };
    tip = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(body))));
    chain.push({ ...body, hash: tip, tipSignature: 'historical-signature', signingPublicKey: 'historical-public-key' });
  }
  localStorage.setItem(audit.AUDIT_FORMAT_KEY, JSON.stringify({ state: 'LEGACY_AUDIT_UNKNOWN' }));
  localStorage.setItem(audit.PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(chain));
  localStorage.setItem(audit.PRIVACY_AUDIT_ANCHOR_KEY, JSON.stringify({ length, tip }));
  return chain;
}

// Independent observations of actual browser API boundaries, not AuditWork or
// result-derived totals. Storage structured-clone key bytes use the frozen law.
function observe() {
  let enabled = true;
  const totals = { itemsWorked: 0, bytesWorked: 0, writes: 0, historicalReads: 0, legacy: 0 };
  const restore = [];
  const wrap = (object, key, replacement) => { const old = object[key]; object[key] = replacement(old); restore.push(() => { object[key] = old; }); };
  const size = (value) => value === undefined ? 0 : bytes(JSON.stringify(value)) + (value?.key ? 32 : 0);
  for (const method of ['get', 'getAll']) wrap(IDBObjectStore.prototype, method, (old) => function (...args) {
    if (!enabled || this.transaction.db.name !== 'drivesense_privacy_audit_v2') return old.apply(this, args);
    totals.itemsWorked += 1;
    if (this.name === 'entries') totals.historicalReads += 1;
    const req = old.apply(this, args);
    req.addEventListener('success', () => { totals.bytesWorked += 2 * size(req.result); }); return req;
  });
  for (const method of ['put', 'add']) wrap(IDBObjectStore.prototype, method, (old) => function (...args) {
    if (!enabled || this.transaction.db.name !== 'drivesense_privacy_audit_v2') return old.apply(this, args);
    totals.writes += 1; totals.bytesWorked += size(args[0]); return old.apply(this, args);
  });
  wrap(Storage.prototype, 'getItem', (old) => function (key) {
    if (!enabled) return old.call(this, key);
    if (key === audit.PRIVACY_AUDIT_CHAIN_KEY || key === audit.PRIVACY_AUDIT_ANCHOR_KEY) totals.legacy += 1;
    const value = old.call(this, key);
    if (key === audit.AUDIT_FORMAT_KEY) { totals.itemsWorked += 1; totals.bytesWorked += value ? 2 * bytes(value) : 0; }
    return value;
  });
  for (const method of ['digest', 'sign', 'verify']) wrap(SubtleCrypto.prototype, method, (old) => async function (...args) {
    if (!enabled) return old.apply(this, args);
    const input = args[args.length - 1]; totals.bytesWorked += input.byteLength;
    if (method === 'verify') totals.bytesWorked += args[2].byteLength;
    const result = await old.apply(this, args);
    if (method !== 'verify') totals.bytesWorked += result.byteLength;
    return result;
  });
  return { totals, pause: () => { enabled = false; }, resume: () => { enabled = true; }, stop: () => restore.reverse().forEach((run) => run()) };
}
async function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('drivesense_privacy_audit_v2', 1);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function mutate(run) {
  const opened = await db();
  try { await new Promise((resolve, reject) => {
    const tx = opened.transaction(['meta', 'entries', 'operationIds'], 'readwrite');
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); run(tx);
  }); } finally { opened.close(); }
}
globalThis.__privacyAudit = { audit, seedLegacy, observe, db, mutate, createP5RawGpsRetentionAdapter,
  eraseAllLocalDataAndBuildReceipt, buildDataPortabilityExport };
