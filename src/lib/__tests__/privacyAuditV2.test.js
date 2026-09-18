import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';
import { AUDIT_FORMAT_KEY, AUDIT_LOCK, probeBrowserAuditProvenance } from '@/lib/privacyAuditFormat';
import { AUDIT_V2_DB } from '@/lib/hashChainLogV2';
import * as audit from '@/lib/hashChainLog';

vi.mock('@/lib/appLifecycleWork', () => ({ notifyPrivacyAuditConversionComplete: vi.fn() }));
let runtime;
const receipt = (id = 'receipt-1') => ({ op: 'RAW_GPS_AUTO_PURGED', operationId: id, timestamp: 100,
  details: { purged_trip_count: 1, purged_point_count: 30, reason: 'raw_gps_retention_policy' } });
const rows = (name) => runtime.idb.getStoreState(AUDIT_V2_DB, name).records;
const initialize = async () => { expect(await audit.initializePrivacyAudit()).toMatchObject({ state: 'READY' }); };

describe('F05 V7/V24/V25/V26 same hashChainLog v2 owner', () => {
  beforeEach(() => {
    runtime = createAuditTestRuntime();
    vi.stubGlobal('localStorage', runtime.storage);
    vi.stubGlobal('indexedDB', runtime.idb);
    vi.stubGlobal('IDBKeyRange', runtime.idb.keyRange);
    vi.stubGlobal('navigator', { locks: runtime.locks });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('fresh direct initialization persists a non-extractable HMAC key and reopens without v1', async () => {
    await initialize();
    expect(runtime.values.has(audit.PRIVACY_AUDIT_CHAIN_KEY)).toBe(false);
    const head = rows('meta').get('head');
    const key = rows('meta').get(`key:${head.ledgerId}`).key;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    expect(await audit.appendPrivacyEventBounded(receipt())).toMatchObject({ state: 'READY', seq: 1, appended: true });
    expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    expect(await audit.initializePrivacyAudit()).toMatchObject({ state: 'READY' });
    expect((await audit.appendPrivacyEventBounded(receipt())).appended).toBe(false);
  });

  it('never reads a historical entry body for append or duplicate, and observes failed transactions', async () => {
    await initialize();
    const seen = [];
    const consume = runtime.idb.consumeRequestFailure.bind(runtime.idb);
    vi.spyOn(runtime.idb, 'consumeRequestFailure').mockImplementation((store, op) => { seen.push([store, op]); return consume(store, op); });
    const first = await audit.appendPrivacyEventBounded(receipt());
    expect(first.state).toBe('READY'); expect(first.itemsWorked).toBe(8);
    const second = await audit.appendPrivacyEventBounded(receipt());
    expect(second).toMatchObject({ state: 'READY', appended: false, seq: 1, itemsWorked: 8 });
    expect(seen.filter(([store, op]) => store === 'entries' && ['get', 'getAll'].includes(op))).toEqual([]);
    for (const storeName of ['entries', 'operationIds', 'meta']) {
      runtime.idb.failNextRequest({ storeName, operation: storeName === 'meta' ? 'put' : 'add', error: new Error('injected transaction fault') });
      const failed = await audit.appendPrivacyEventBounded(receipt(`failed-${storeName}`));
      expect(failed.state).not.toBe('READY'); expect(failed.itemsWorked).toBe(8);
      expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    }
  });

  it('committed append plus failed ACK reopens and dedupes; no ACK before commit', async () => {
    await initialize();
    const failedAck = vi.fn(async () => { throw new Error('reply lost'); });
    expect((await audit.appendPrivacyEventBounded(receipt(), { afterCommit: failedAck })).state).not.toBe('READY');
    expect(failedAck).toHaveBeenCalledTimes(1);
    expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    const ack = vi.fn(async () => ({ acknowledged: true }));
    const retried = await audit.appendPrivacyEventBounded(receipt(), { afterCommit: ack });
    expect(retried).toMatchObject({ state: 'READY', appended: false, seq: 1 });
    runtime.idb.failNextRequest({ storeName: 'meta', operation: 'put', error: new Error('abort') });
    await audit.appendPrivacyEventBounded(receipt('abort'), { afterCommit: ack });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('a correct suffix does not normalize corrupted history; all verified checkpoint surfaces fail', async () => {
    await initialize(); await audit.appendPrivacyEventBounded(receipt());
    const checkpoint = await audit.exportAuditCheckpoint();
    const stored = [...rows('entries').values()][0]; stored.event.details.purged_point_count = 999;
    expect((await audit.appendPrivacyEventBounded(receipt('second'))).state).toBe('READY');
    expect(await audit.verifyChain()).toMatchObject({ valid: false, brokenAt: 0 });
    expect((await audit.verifyCheckpoint(checkpoint)).valid).toBe(false);
    await expect(audit.exportAuditCheckpoint()).rejects.toThrow('AUDIT_INTEGRITY_FAILED');
  });

  it('detects missing history, extra tail entries and unauthenticated head modification', async () => {
    await initialize(); await audit.appendPrivacyEventBounded(receipt());
    const saved = structuredClone([...rows('entries')]);
    rows('entries').clear(); expect((await audit.verifyChain()).valid).toBe(false);
    for (const [key, value] of saved) rows('entries').set(key, value);
    rows('entries').set('extra', { ...saved[0][1], seq: 2 });
    expect((await audit.verifyChain()).valid).toBe(false); rows('entries').delete('extra');
    rows('meta').get('head').entryCount = 200;
    expect((await audit.appendPrivacyEventBounded(receipt('head-tamper'))).state).toBe('AUDIT_INTEGRITY_FAILED');
  });

  it('erasure removes head/key/index/entries and stale incarnation cannot return; missing ready store fails closed', async () => {
    await initialize(); await audit.appendPrivacyEventBounded(receipt());
    const token = await audit.beginPrivacyAuditErasure();
    expect(rows('entries').size).toBe(0); expect(rows('operationIds').size).toBe(0);
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('AUDIT_ERASING');
    await audit.finishPrivacyAuditErasure(token); await initialize();
    expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 0 });
    expect((await audit.appendPrivacyEventBounded(receipt())).appended).toBe(true);
    runtime.idb.databases.delete(AUDIT_V2_DB);
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('AUDIT_STORAGE_LOST');
    expect(JSON.parse(runtime.values.get(AUDIT_FORMAT_KEY)).state).toBe('V2');
  });

  it('busy owner and missing locks do not wait or pretend success', async () => {
    await initialize();
    let release; let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const holding = navigator.locks.request(AUDIT_LOCK, {}, async () => { started(); await new Promise((resolve) => { release = resolve; }); });
    await entered;
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('AUDIT_BUSY');
    release(); await holding;
    vi.stubGlobal('navigator', {});
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('AUDIT_LOCK_UNAVAILABLE');
  });

  it('unknown-size legacy readiness never acquires values and key probing is capped', async () => {
    runtime.values.set(audit.PRIVACY_AUDIT_CHAIN_KEY, 'unknown whole value');
    const get = vi.spyOn(runtime.storage, 'getItem');
    expect(await audit.initializePrivacyAudit()).toMatchObject({ state: 'CONVERSION_REQUIRED' });
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('CONVERSION_REQUIRED');
    expect(get.mock.calls.some(([key]) => key === audit.PRIVACY_AUDIT_CHAIN_KEY)).toBe(false);
    const large = { length: 65, key: vi.fn() };
    expect(probeBrowserAuditProvenance(large)).toBe(false); expect(large.key).not.toHaveBeenCalled();
  });

  it('V26 denied/unstable key-name provenance never guesses fresh and denied IDB never falls back to v1', async () => {
    expect(probeBrowserAuditProvenance({ length: 1, key: () => null })).toBe(false);
    let reads = 0;
    expect(probeBrowserAuditProvenance({ get length() { return reads++ ? 2 : 1; }, key: () => 'unrelated' })).toBe(false);
    expect(probeBrowserAuditProvenance({ get length() { throw Error('denied'); } })).toBe(false);
    await initialize(); const old = runtime.idb.open.bind(runtime.idb);
    vi.spyOn(runtime.idb, 'open').mockImplementation(() => { throw Error('storage denied'); });
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('AUDIT_STORAGE_UNAVAILABLE');
    expect(runtime.values.has(audit.PRIVACY_AUDIT_CHAIN_KEY)).toBe(false);
    runtime.idb.open.mockImplementation(old);
  });

  it('V7/V25 prepared state changes cause one measured conflict attempt, not internal retry', async () => {
    await initialize(); const original = crypto.subtle.digest.bind(crypto.subtle);
    const hash = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      const result = await original(...args); rows('meta').get('control').intervening = true; return result;
    });
    const result = await audit.appendPrivacyEventBounded(receipt());
    expect(result).toMatchObject({ state: 'AUDIT_CONFLICT', itemsWorked: 8 });
    expect(result.bytesWorked).toBeGreaterThan(0); expect(hash).toHaveBeenCalledTimes(1);
    expect(rows('entries').size).toBe(0); expect(rows('operationIds').size).toBe(0);
    delete rows('meta').get('control').intervening;
    expect((await audit.appendPrivacyEventBounded(receipt())).state).toBe('READY');
  });

  it.each([0, 100, 1000])('explicitly preserves every v1 logical event and first operation ID at L=%s', async (length) => {
    runtime.values.set(AUDIT_FORMAT_KEY, JSON.stringify({ state: 'LEGACY_AUDIT_UNKNOWN' }));
    for (let i = 0; i < length; i += 1) await audit.appendPrivacyEvent(receipt(`legacy-${i}`));
    const before = await audit.loadPrivacyAuditChain();
    expect(await audit.runPrivacyAuditCompatibilityUpgrade()).toMatchObject({ state: 'READY' });
    expect(await audit.loadPrivacyAuditChain()).toEqual(before);
    expect(await audit.verifyChain()).toMatchObject({ valid: true, length });
    if (length) expect((await audit.appendPrivacyEventBounded(receipt('legacy-0'))).appended).toBe(false);
  }, 60000);

  it('corrupt v1 refuses cutover and interrupted staging remains explicit legacy authority', async () => {
    runtime.values.set(AUDIT_FORMAT_KEY, JSON.stringify({ state: 'LEGACY_AUDIT_UNKNOWN' }));
    await audit.appendPrivacyEvent(receipt());
    const original = runtime.values.get(audit.PRIVACY_AUDIT_CHAIN_KEY);
    const modified = JSON.parse(original); modified[0].op = 'CORRUPT';
    runtime.values.set(audit.PRIVACY_AUDIT_CHAIN_KEY, JSON.stringify(modified));
    await expect(audit.runPrivacyAuditCompatibilityUpgrade()).rejects.toThrow('AUDIT_LEGACY_INVALID');
    expect(JSON.parse(runtime.values.get(AUDIT_FORMAT_KEY)).state).toBe('CUTOVER_PENDING');
    runtime.values.set(audit.PRIVACY_AUDIT_CHAIN_KEY, original);
    const stop = new AbortController();
    await expect(audit.runPrivacyAuditCompatibilityUpgrade({ signal: stop.signal, onProgress: ({ phase }) => { if (phase === 'staging') stop.abort(); } })).rejects.toThrow('CANCELLED');
    expect(await audit.loadPrivacyAuditChain()).toEqual(JSON.parse(original));
    expect(await audit.runPrivacyAuditCompatibilityUpgrade()).toMatchObject({ state: 'READY' });
  });
});
