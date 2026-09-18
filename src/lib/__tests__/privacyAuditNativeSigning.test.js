import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';

const anchor = vi.hoisted(() => ({ readAuditFormat: vi.fn(), writeAuditFormat: vi.fn(), signTipHash: vi.fn(), verifyTipHash: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => anchor }));
vi.mock('@/lib/nativePlatform', () => ({ isNativePlatform: () => true }));
import * as audit from '@/lib/hashChainLog';
let fence;
beforeEach(() => {
  const runtime = createAuditTestRuntime();
  vi.stubGlobal('indexedDB', runtime.idb); vi.stubGlobal('IDBKeyRange', runtime.idb.keyRange); vi.stubGlobal('navigator', { locks: runtime.locks });
  fence = { state: 'FRESH_PENDING', ledgerId: '1'.repeat(32) }; vi.clearAllMocks();
  anchor.readAuditFormat.mockImplementation(async () => ({ fence, itemsWorked: 1, bytesWorked: JSON.stringify(fence).length * 2 }));
  anchor.writeAuditFormat.mockImplementation(async (value) => { fence = value.fence; return { itemsWorked: 0, bytesWorked: JSON.stringify(fence).length }; });
  anchor.signTipHash.mockResolvedValue({ signature: 'existing-native-signature', publicKey: 'existing-native-public-key' });
  anchor.verifyTipHash.mockResolvedValue({ valid: true });
});
afterEach(() => vi.unstubAllGlobals());
it('V7 retains optional native signing and fixed fence/plugin boundary work without reusing the audit HMAC key', async () => {
  await audit.initializePrivacyAudit();
  const result = await audit.appendPrivacyEventBounded({ op: 'RAW_GPS_AUTO_PURGED', operationId: 'native-receipt' });
  expect(result).toMatchObject({ state: 'READY', itemsWorked: 8, appended: true });
  expect(anchor.signTipHash).toHaveBeenCalledExactlyOnceWith({ tipHash: result.hash });
  const chain = await audit.loadPrivacyAuditChain(); expect(chain[0]).toMatchObject({ tipSignature: 'existing-native-signature', signingPublicKey: 'existing-native-public-key' });
  const duplicate = await audit.appendPrivacyEventBounded({ operationId: 'native-receipt' });
  expect(duplicate.appended).toBe(false); expect(anchor.signTipHash).toHaveBeenCalledTimes(1);
  anchor.signTipHash.mockRejectedValueOnce(Error('optional signing unavailable'));
  expect((await audit.appendPrivacyEventBounded({ operationId: 'unsigned' })).state).toBe('READY');
  expect((await audit.loadPrivacyAuditChain())[1]).toMatchObject({ tipSignature: null, signingPublicKey: null });
  expect(await audit.verifyChain()).toMatchObject({ valid: true, length: 2 });
});
