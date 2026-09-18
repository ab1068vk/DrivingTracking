import {
  auditBytes, auditError, newAuditId, validAuditId, readAuditFence, writeAuditFence,
} from '@/lib/privacyAuditFormat';

// Private persistence implementation of hashChainLog. Only that owner instantiates
// it; crypto/event semantics are supplied by that owner, not reimplemented here.
export const AUDIT_V2_DB = 'drivesense_privacy_audit_v2';
const STORES = ['entries', 'operationIds', 'meta'];
const GENESIS = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const HEAD_DOMAIN = 'drivesense_privacy_audit_head_v2';
const encoder = new TextEncoder();

export class AuditWork {
  constructor(bounded = false) { this.itemsWorked = 0; this.bytesWorked = 0; this.bounded = bounded; }
  check(items, bytes) {
    if (this.bounded && (items > 9 || bytes > 256 * 1024)) throw auditError('AUDIT_WORK_LIMIT');
  }
  probe() { this.itemsWorked += 1; this.check(this.itemsWorked, this.bytesWorked); }
  bytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw auditError('AUDIT_ACCOUNTING_INVALID');
    this.bytesWorked += bytes; this.check(this.itemsWorked, this.bytesWorked);
  }
  read(bytes) { this.bytes(bytes * 2); } // persistent encoding + decoded output
  external(items, bytes) {
    if (!Number.isSafeInteger(items) || items < 0) throw auditError('AUDIT_ACCOUNTING_INVALID');
    this.itemsWorked += items; this.bytes(bytes);
  }
  result() { return { itemsWorked: this.itemsWorked, bytesWorked: this.bytesWorked }; }
}

// Structured-cloned CryptoKey material is fixed 32 bytes. Provider/VM overhead
// is excluded by the frozen byte law, not silently treated as history payload.
const recordBytes = (value) => value === undefined ? 0
  : auditBytes(JSON.stringify(value)) + (value?.key ? 32 : 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyId = (ledgerId) => `key:${ledgerId}`;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(auditError('AUDIT_STORAGE_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUDIT_V2_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('entries', { keyPath: ['ledgerId', 'seq'] });
      db.createObjectStore('operationIds', { keyPath: ['ledgerId', 'operation_id'] });
      db.createObjectStore('meta', { keyPath: 'id' });
    };
    request.onerror = () => reject(auditError('AUDIT_STORAGE_UNAVAILABLE', request.error));
    request.onblocked = () => reject(auditError('AUDIT_STORAGE_BUSY'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (STORES.some((name) => !db.objectStoreNames.contains(name))) {
        db.close(); reject(auditError('AUDIT_STORAGE_LOST')); return;
      }
      resolve(db);
    };
  });
}

// build and all of its callbacks are synchronous IDB request handlers. There is
// deliberately no crypto/plugin await inside this transaction's active lifetime.
function transaction(db, mode, work, build) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(STORES, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch (error) {
      if (error instanceof TypeError) tx = db.transaction(STORES, mode);
      else { reject(error); return; }
    }
    let value; let cause;
    const fail = (error) => { cause ??= error; try { tx.abort(); } catch { reject(cause); } };
    const request = (store, method, args, callback) => {
      // A synchronous request failure already aborted this transaction. Do not
      // encode/charge or attempt later writes against its inactive stores.
      if (cause) return;
      try {
        if (method === 'get' || method === 'getAll') work.probe();
        else if (method === 'add' || method === 'put') work.bytes(recordBytes(args[0]));
        const req = tx.objectStore(store)[method](...args);
        req.onerror = () => { cause ??= req.error; };
        req.onsuccess = () => {
          try {
            if (method === 'get' || method === 'getAll') work.read(recordBytes(req.result));
            callback?.(req.result);
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
    tx.onabort = () => reject(cause || tx.error || auditError('AUDIT_TRANSACTION_ABORTED'));
    tx.onerror = () => { cause ??= tx.error; };
    tx.oncomplete = () => resolve(value);
    try { build(request, (result) => { value = result; }, fail); } catch (error) { fail(error); }
  });
}

const headData = ({ formatVersion, ledgerId, entryCount, tipHash }) => ({
  domain: HEAD_DOMAIN, formatVersion, ledgerId, entryCount, tipHash,
});
const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (value) => Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));

export function createAuditV2({ canonical, normalize, operationId, hash, sign, verifyLegacy, readLegacy }) {
  async function mac(head, key, work, verify = false) {
    const input = encoder.encode(canonical(headData(head)));
    work.bytes(input.byteLength);
    if (verify) {
      work.bytes(32);
      return crypto.subtle.verify('HMAC', key, unhex(head.headMac), input);
    }
    const result = await crypto.subtle.sign('HMAC', key, input);
    work.bytes(result.byteLength);
    return hex(result);
  }

  async function authenticate(snapshot, work) {
    const { control, head, key } = snapshot;
    if (!control || !head || !key) throw auditError('AUDIT_STORAGE_LOST');
    if (control.state !== 'READY' || !validAuditId(control.ledgerId)
      || head.ledgerId !== control.ledgerId || key.ledgerId !== control.ledgerId
      || key.id !== keyId(control.ledgerId) || head.formatVersion !== 2
      || !Number.isSafeInteger(head.entryCount) || head.entryCount < 0
      || !HASH.test(head.tipHash) || (head.entryCount === 0) !== (head.tipHash === GENESIS)
      || !HASH.test(head.headMac) || !key.key || key.key.extractable !== false
      || key.key.algorithm?.name !== 'HMAC' || key.key.algorithm?.hash?.name !== 'SHA-256'
      || recordBytes(control) > 2048 || recordBytes(head) > 2048
      || !await mac(head, key.key, work, true)) throw auditError('AUDIT_INTEGRITY_FAILED');
    return snapshot;
  }

  function capture(db, ledgerId, id, work, { includeKey = true } = {}) {
    return transaction(db, 'readonly', work, (request, done) => {
      const snapshot = {}; let pending = includeKey ? 4 : 3;
      const receive = (field) => (value) => { snapshot[field] = value; if (--pending === 0) done(snapshot); };
      request('meta', 'get', ['control'], receive('control'));
      request('meta', 'get', ['head'], receive('head'));
      if (includeKey) request('meta', 'get', [keyId(ledgerId)], receive('key'));
      // Empty ID is a point probe too, not a historical scan.
      request('operationIds', 'get', [[ledgerId, id || '']], receive('operation'));
    });
  }

  async function withDb(run) { const db = await openDatabase(); try { return await run(db); } finally { db.close(); } }

  async function selector(fence, work = new AuditWork()) {
    if (!fence) return { format: 1, state: 'CONVERSION_REQUIRED' };
    if (fence.state === 'ERASING') throw auditError('AUDIT_ERASING');
    if (fence.state === 'LEGACY_AUDIT_UNKNOWN') return { format: 1, state: 'CONVERSION_REQUIRED' };
    return withDb(async (db) => {
      const snapshot = await capture(db, fence.ledgerId, '', work);
      if (snapshot.control?.state === 'READY') {
        await authenticate(snapshot, work);
        if (snapshot.head.ledgerId !== fence.ledgerId) throw auditError('AUDIT_INTEGRITY_FAILED');
        return { format: 2, state: fence.state === 'V2' ? 'READY' : 'FENCE_PENDING', snapshot };
      }
      if (fence.state === 'V2') throw auditError('AUDIT_STORAGE_LOST');
      return { format: 1, state: fence.state === 'FRESH_PENDING' ? 'FRESH_PENDING' : 'CONVERSION_REQUIRED' };
    });
  }

  async function publishHead(db, ledgerId, count, tip, work) {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const head = { id: 'head', formatVersion: 2, ledgerId, entryCount: count, tipHash: tip };
    head.headMac = await mac(head, key, work);
    await transaction(db, 'readwrite', work, (request) => {
      request('meta', 'put', [{ id: keyId(ledgerId), ledgerId, key }]);
      request('meta', 'put', [head]);
      request('meta', 'put', [{ id: 'control', state: 'READY', ledgerId }]);
    });
  }

  async function initialize(fence) {
    const work = new AuditWork();
    const selected = await selector(fence, work);
    if (selected.state === 'FENCE_PENDING') {
      await writeAuditFence({ state: 'V2', ledgerId: fence.ledgerId }, work);
      return { state: 'READY', ...work.result() };
    }
    if (selected.state !== 'FRESH_PENDING') return { state: selected.state, ...work.result() };
    await withDb(async (db) => {
      // A FRESH_PENDING identity is only a proven empty source. Never clear an
      // existing namespace or replace a READY control record during startup.
      await transaction(db, 'readwrite', work, (request) => {
        request('meta', 'get', ['control'], (control) => {
          if (control && (control.state !== 'FRESH_PENDING' || control.ledgerId !== fence.ledgerId)) {
            throw auditError('AUDIT_INTEGRITY_FAILED');
          }
          request('meta', 'put', [{ id: 'control', ...fence }]);
        });
      });
      await publishHead(db, fence.ledgerId, 0, GENESIS, work);
    });
    await writeAuditFence({ state: 'V2', ledgerId: fence.ledgerId }, work);
    return { state: 'READY', ...work.result() };
  }

  async function append(event, work) {
    const fence = await readAuditFence(work);
    if (!fence || fence.state === 'LEGACY_AUDIT_UNKNOWN' || fence.state === 'CUTOVER_PENDING') {
      throw auditError('CONVERSION_REQUIRED');
    }
    if (fence.state !== 'V2') throw auditError(fence.state === 'ERASING' ? 'AUDIT_ERASING' : 'AUDIT_INITIALIZING');
    const id = operationId(event);
    return withDb(async (db) => {
      const prepared = await capture(db, fence.ledgerId, id, work);
      await authenticate(prepared, work);
      if (prepared.head.ledgerId !== fence.ledgerId) throw auditError('AUDIT_INTEGRITY_FAILED');
      const existing = prepared.operation;
      if (existing && (!id || existing.ledgerId !== fence.ledgerId || existing.operation_id !== id
        || !Number.isSafeInteger(existing.seq) || existing.seq < 1 || existing.seq > prepared.head.entryCount
        || !HASH.test(existing.hash) || recordBytes(existing) > 1024)) throw auditError('AUDIT_INTEGRITY_FAILED');
      let entry; let nextHead;
      if (!existing) {
        if (prepared.head.entryCount === Number.MAX_SAFE_INTEGER) throw auditError('AUDIT_SEQUENCE_OVERFLOW');
        const body = normalize(event, prepared.head.entryCount + 1, prepared.head.tipHash);
        const encoded = canonical(body);
        if (auditBytes(encoded) > 32 * 1024) throw auditError('AUDIT_EVENT_TOO_LARGE');
        entry = { ...body, hash: await hash(encoded, work) };
        await sign(entry, work);
        if (recordBytes(entry) > 32 * 1024) throw auditError('AUDIT_EVENT_TOO_LARGE');
        nextHead = { ...prepared.head, entryCount: entry.seq, tipHash: entry.hash };
        nextHead.headMac = await mac(nextHead, prepared.key.key, work);
      }
      return transaction(db, 'readwrite', work, (request, done, fail) => {
        const current = {}; let pending = 3;
        const receive = (field) => (value) => {
          current[field] = value;
          if (--pending !== 0) return;
          if (!same(current.control, prepared.control) || !same(current.head, prepared.head)
            || !same(current.operation, existing)) { fail(auditError('AUDIT_CONFLICT')); return; }
          if (existing) { done({ seq: existing.seq, hash: existing.hash, ledgerId: fence.ledgerId, appended: false }); return; }
          request('entries', 'add', [{ ledgerId: fence.ledgerId, seq: entry.seq, event: entry }]);
          if (id) request('operationIds', 'add', [{ ledgerId: fence.ledgerId, operation_id: id, seq: entry.seq, hash: entry.hash }]);
          request('meta', 'put', [nextHead]);
          done({ seq: entry.seq, hash: entry.hash, ledgerId: fence.ledgerId, appended: true, entry });
        };
        request('meta', 'get', ['control'], receive('control'));
        request('meta', 'get', ['head'], receive('head'));
        request('operationIds', 'get', [[fence.ledgerId, id || '']], receive('operation'));
      });
    });
  }

  async function read(fence, verified = true) {
    return withDb(async (db) => {
      const work = new AuditWork();
      const snapshot = await transaction(db, 'readonly', work, (request, done) => {
        const result = {}; let pending = 4;
        const receive = (field) => (value) => { result[field] = value; if (--pending === 0) done(result); };
        request('meta', 'get', ['control'], receive('control'));
        request('meta', 'get', ['head'], receive('head'));
        request('meta', 'get', [keyId(fence.ledgerId)], receive('key'));
        request('entries', 'getAll', [IDBKeyRange.bound([fence.ledgerId, 0], [fence.ledgerId, []])], receive('rows'));
      });
      await authenticate(snapshot, work);
      if (snapshot.head.ledgerId !== fence.ledgerId) throw auditError('AUDIT_INTEGRITY_FAILED');
      if (verified && snapshot.rows.some((row) => row.ledgerId !== fence.ledgerId || row.seq !== row.event?.seq)) {
        throw auditError('AUDIT_INTEGRITY_FAILED');
      }
      const chain = snapshot.rows.map((row) => row.event);
      const anchor = { length: snapshot.head.entryCount, tip: snapshot.head.tipHash };
      const state = { chain, anchor, chainResult: { ok: true, value: chain }, anchorResult: { ok: true } };
      return { chain, result: verified ? await verifyLegacy(state) : null };
    });
  }

  async function getEntry(ledgerId, seq) {
    return withDb((db) => transaction(db, 'readonly', new AuditWork(), (request, done) => {
      request('entries', 'get', [[ledgerId, seq]], (row) => done(row?.event));
    }));
  }

  async function convert(fence, { signal, onProgress } = {}) {
    const selected = await selector(fence);
    if (selected.format === 2 || selected.state === 'FRESH_PENDING') return initialize(fence);
    const ledgerId = newAuditId();
    await writeAuditFence({ state: 'CUTOVER_PENDING', ledgerId });
    const cancelled = () => { if (signal?.aborted) throw auditError('AUDIT_CONVERSION_CANCELLED'); };
    cancelled(); onProgress?.({ phase: 'reading', completed: 0 });
    const legacy = await readLegacy();
    const proof = await verifyLegacy(legacy);
    if (!proof.valid) throw auditError(`AUDIT_LEGACY_INVALID: ${proof.reason}`);
    const work = new AuditWork();
    await withDb(async (db) => {
      // Explicit cleanup only. Before READY there is no authoritative v2 state.
      await transaction(db, 'readwrite', work, (request) => {
        STORES.forEach((store) => request(store, 'clear', []));
        request('meta', 'put', [{ id: 'control', state: 'CUTOVER_PENDING', ledgerId }]);
      });
      const firstIds = new Map();
      for (let start = 0; start < legacy.chain.length; start += 64) {
        cancelled();
        await transaction(db, 'readwrite', work, (request) => {
          for (const event of legacy.chain.slice(start, start + 64)) {
            request('entries', 'add', [{ ledgerId, seq: event.seq, event }]);
            const id = operationId({ operationId: event.operation_id });
            if (id && id === event.operation_id && !firstIds.has(id)) {
              const mapping = { ledgerId, operation_id: id, seq: event.seq, hash: event.hash };
              firstIds.set(id, mapping); request('operationIds', 'add', [mapping]);
            }
          }
        });
        onProgress?.({ phase: 'staging', completed: Math.min(start + 64, legacy.chain.length), total: legacy.chain.length });
      }
      cancelled();
      const copied = await transaction(db, 'readonly', work, (request, done) => {
        const result = {}; let pending = 2;
        const receive = (field) => (value) => { result[field] = value; if (--pending === 0) done(result); };
        request('entries', 'getAll', [], receive('rows'));
        request('operationIds', 'getAll', [], receive('ids'));
      });
      if (!same(copied.rows.map((row) => row.event), legacy.chain)
        || copied.rows.some((row) => row.ledgerId !== ledgerId || row.seq !== row.event.seq)
        || copied.ids.length !== firstIds.size || copied.ids.some((row) => !same(row, firstIds.get(row.operation_id)))) {
        throw auditError('AUDIT_CONVERSION_READBACK_FAILED');
      }
      const readback = await verifyLegacy({ ...legacy, chain: copied.rows.map((row) => row.event) });
      if (!readback.valid || readback.tip !== proof.tip || readback.length !== proof.length) throw auditError('AUDIT_CONVERSION_READBACK_FAILED');
      onProgress?.({ phase: 'verified', completed: proof.length, total: proof.length }); cancelled();
      await publishHead(db, ledgerId, proof.length, proof.tip, work);
      onProgress?.({ phase: 'ready', completed: proof.length, total: proof.length });
    });
    // READY already selected v2, even if this fence write fails or the process dies.
    await writeAuditFence({ state: 'V2', ledgerId });
    return { state: 'READY', ledgerId, ...work.result() };
  }

  async function beginErase(fence) {
    const erasing = { state: 'ERASING', ledgerId: fence?.state === 'ERASING' ? fence.ledgerId : newAuditId() };
    await writeAuditFence(erasing);
    await withDb((db) => transaction(db, 'readwrite', new AuditWork(), (request) => {
      STORES.forEach((store) => request(store, 'clear', []));
      request('meta', 'put', [{ id: 'control', ...erasing }]);
    }));
    return erasing;
  }

  async function finishErase(erasing) {
    const current = await readAuditFence();
    if (!same(current, erasing) || current?.state !== 'ERASING') throw auditError('AUDIT_ERASURE_CHANGED');
    await withDb((db) => transaction(db, 'readwrite', new AuditWork(), (request) => {
      STORES.forEach((store) => request(store, 'clear', []));
    }));
    await writeAuditFence({ state: 'FRESH_PENDING', ledgerId: newAuditId() });
  }
  return { selector, initialize, append, read, getEntry, convert, beginErase, finishErase };
}
