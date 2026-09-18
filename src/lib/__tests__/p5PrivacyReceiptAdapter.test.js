import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';
import { createP5RawGpsRetentionAdapter } from '@/lib/p5RawGpsRetentionAdapter';
import * as audit from '@/lib/hashChainLog';
import { nativeTripArchive } from '@/lib/nativeTripArchive';

const bridge = vi.hoisted(() => ({ getP5PrivacyReceipts: vi.fn(), acknowledgeP5PrivacyReceipt: vi.fn(), stepP5NativeRawGpsRetention: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge, Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }));
vi.mock('@/lib/appLifecycleWork', () => ({ notifyPrivacyAuditConversionComplete: vi.fn() }));
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
let runtime; let debt; let failAck; let nativeObserved;
const entry = (operationId) => ({ operationId, eventType: 'RAW_GPS_AUTO_PURGED', reason: 'raw_gps_retention_policy', tripCount: 1, pointCount: 30, motionSampleCount: 0, createdAtMs: 100 });
// Native owner independently executes/validates these SQLite boundary totals in
// DriveSenseP5CoreRobolectricTest; this layer exercises the real bridge wrapper,
// adapter and persistent ledger, not a stubbed ledger append/disposition.
const rowBytes = (row) => row ? 2 * (row.operationId.length + row.eventType.length + row.reason.length + 'PENDING'.length + 4 * 8) : 0;
function setupBridge() {
  bridge.stepP5NativeRawGpsRetention.mockResolvedValue({ state: 'COMPLETE', itemsWorked: 1, bytesWorked: 2, hasMore: false });
  bridge.getP5PrivacyReceipts.mockImplementation(async (payload) => {
    const row = debt[0]; const result = { state: 'READY', receipts: row ? [row] : [], itemCount: row ? 1 : 0, privacyReceiptPending: !!row,
      itemsWorked: 1, bytesWorked: rowBytes(row) };
    nativeObserved.itemsWorked += 1; nativeObserved.bytesWorked += result.bytesWorked + bytes(payload) + 2 * bytes(result); return result;
  });
  bridge.acknowledgeP5PrivacyReceipt.mockImplementation(async (payload) => {
    const index = debt.findIndex((row) => row.operationId === payload.operationId); const row = debt[index];
    if (!failAck && index >= 0) debt.splice(index, 1);
    const result = failAck ? { state: 'PRIVACY_RECEIPT_FAILED', acknowledged: false, itemsWorked: 1, bytesWorked: rowBytes(row) }
      : { state: 'READY', acknowledged: index >= 0, hasMore: debt.length > 0, itemsWorked: 2,
        bytesWorked: rowBytes(row) + payload.operationId.length + (debt[0] ? 2 * (debt[0].operationId.length + 7) : 0) };
    nativeObserved.itemsWorked += result.itemsWorked; nativeObserved.bytesWorked += result.bytesWorked + bytes(payload) + 2 * bytes(result); return result;
  });
}
const adapter = (appendReceipt = audit.appendPrivacyEventBounded, readPolicy = async () => ({ retentionDays: 30, motionRetentionDays: 0 })) =>
  createP5RawGpsRetentionAdapter({ archive: nativeTripArchive, readPolicy, appendReceipt });
describe('F05 V7/V24/V25 J1 receipt integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); runtime = createAuditTestRuntime(); debt = [entry('receipt-00000')]; failAck = false; nativeObserved = { itemsWorked: 0, bytesWorked: 0 };
    vi.stubGlobal('localStorage', runtime.storage); vi.stubGlobal('indexedDB', runtime.idb);
    vi.stubGlobal('IDBKeyRange', runtime.idb.keyRange); vi.stubGlobal('navigator', { locks: runtime.locks });
    setupBridge(); await audit.initializePrivacyAudit();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('native no-candidate proof and receipt work never share one turn; actual bridge plus ledger counters are combined', async () => {
    const delivered = []; const run = adapter(async (...args) => { const result = await audit.appendPrivacyEventBounded(...args); delivered.push(result); return result; });
    expect(await run()).toMatchObject({ state: 'RECEIPTS_NEXT', itemsWorked: 1, bytesWorked: 2, hasMore: true });
    expect(bridge.getP5PrivacyReceipts).not.toHaveBeenCalled();
    const receipt = await run(); expect(receipt).toMatchObject({ state: 'COMPLETE', privacyReceiptPending: false });
    expect(receipt.itemsWorked).toBe(nativeObserved.itemsWorked + delivered[0].itemsWorked);
    expect(receipt.bytesWorked).toBe(nativeObserved.bytesWorked + delivered[0].bytesWorked);
    expect(nativeObserved.itemsWorked).toBeLessThanOrEqual(6); expect(nativeObserved.bytesWorked).toBeLessThanOrEqual(65536);
    expect(receipt.itemsWorked).toBeLessThanOrEqual(15); expect(receipt.bytesWorked).toBeLessThanOrEqual(320 * 1024);
    expect(debt).toHaveLength(0); expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    expect((await run()).itemsWorked).toBe(1); // empty final probe is real work
  });
  it('append committed / ACK failed / reopen / retry produces exactly one event and then drains multiple receipts one per turn', async () => {
    debt.push(entry('receipt-00001')); const run = adapter(); await run(); failAck = true;
    expect(await run()).toMatchObject({ state: 'PRIVACY_RECEIPT_FAILED', privacyReceiptPending: true });
    expect(debt).toHaveLength(2); expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    await audit.initializePrivacyAudit(); failAck = false;
    expect(await run()).toMatchObject({ state: 'RECEIPTS_PENDING', hasMore: true });
    expect(debt).toHaveLength(1); expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 1 });
    expect(await run()).toMatchObject({ state: 'COMPLETE', hasMore: false });
    expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 2 });
  });
  it('conversion debt permits authoritative native work but never calls v1 or ACK before v2 ready', async () => {
    runtime.values.set(audit.AUDIT_FORMAT_KEY, JSON.stringify({ state: 'LEGACY_AUDIT_UNKNOWN' }));
    const get = vi.spyOn(runtime.storage, 'getItem'); const run = adapter();
    expect((await run()).state).toBe('RECEIPTS_NEXT');
    expect(await run()).toMatchObject({ state: 'CONVERSION_REQUIRED', privacyReceiptPending: true });
    expect(bridge.acknowledgeP5PrivacyReceipt).not.toHaveBeenCalled(); expect(debt).toHaveLength(1);
    expect(get.mock.calls.every(([key]) => key !== audit.PRIVACY_AUDIT_CHAIN_KEY)).toBe(true);
  });
  it('job COMPLETE is not policy drained; policy/generation/admission changes reset disposable phase', async () => {
    let days = 30; const run = adapter(undefined, async () => ({ retentionDays: days }));
    bridge.stepP5NativeRawGpsRetention.mockResolvedValueOnce({ state: 'COMPLETE', jobId: 'one', itemsWorked: 1, bytesWorked: 2 });
    expect(await run({ instanceId: 'a', archiveGeneration: 'g' })).toMatchObject({ hasMore: true });
    bridge.stepP5NativeRawGpsRetention.mockResolvedValueOnce({ state: 'OBSOLETE_COMPLETE', jobId: 'old', itemsWorked: 1, bytesWorked: 2, hasMore: false });
    expect(await run({ instanceId: 'a', archiveGeneration: 'g' })).toMatchObject({ hasMore: true });
    expect((await run({ instanceId: 'a', archiveGeneration: 'g' })).state).toBe('RECEIPTS_NEXT');
    days = 7; expect((await run({ instanceId: 'a', archiveGeneration: 'g' })).state).toBe('RECEIPTS_NEXT');
    expect((await run({ instanceId: 'b', archiveGeneration: 'g' })).state).toBe('RECEIPTS_NEXT');
    expect((await run({ instanceId: 'b', archiveGeneration: 'new' })).state).toBe('RECEIPTS_NEXT');
    expect(bridge.getP5PrivacyReceipts).not.toHaveBeenCalled();
  });
  it('aborted storage and ERASING keep native debt; completed erasure accepts only the owed aggregate into a new incarnation', async () => {
    const run = adapter(); await run(); runtime.idb.failNextRequest({ storeName: 'entries', operation: 'add', error: Error('quota') });
    expect((await run()).state).not.toBe('COMPLETE'); expect(debt).toHaveLength(1);
    expect(await audit.verifyChain()).toMatchObject({ length: 0, valid: true });
    const token = await audit.beginPrivacyAuditErasure(); expect((await run()).state).toBe('AUDIT_ERASING');
    expect(debt).toHaveLength(1); await audit.finishPrivacyAuditErasure(token); await audit.initializePrivacyAudit();
    expect((await run()).state).toBe('COMPLETE'); expect(await audit.verifyChain()).toMatchObject({ length: 1, valid: true });
  });
});
