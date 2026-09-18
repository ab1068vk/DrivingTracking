import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ getHealth: vi.fn(), ingestCompletedJournal: vi.fn(), stepP5JournalManifestReconcile: vi.fn(), stepP5NativeRawGpsRetention: vi.fn(), getP5PrivacyReceipts: vi.fn(), acknowledgeP5PrivacyReceipt: vi.fn(), readAuditFormat: vi.fn() }));
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';
vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge }));
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => true, isNativePlatform: () => true }));

describe('P5 F02 production cutover ingest', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
  it('V3/V15 defers dirty ingest, admits J2, then wakes ingest only after VERIFIED', async () => {
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    const lifecycle = await import('@/lib/lifecycleAuthority');
    lifecycle.__resetLifecycleAuthorityForTests({ documentVisible: true, nativeActive: true, epoch: 1 });
    const work = await import('@/lib/appLifecycleWork');
    const coordinator = work.getP4WorkCoordinator();
    coordinator.autoStart = false;
    bridge.getHealth.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'f02' });
    bridge.ingestCompletedJournal.mockResolvedValueOnce({ state: 'BLOCKED_JOURNAL_REPAIR', itemCount: 0, workBytes: 0, hasMore: false })
      .mockResolvedValueOnce({ itemCount: 0, workBytes: 0, hasMore: false });
    bridge.stepP5JournalManifestReconcile.mockResolvedValue({ state: 'COMPLETE', summaryState: 'VERIFIED', itemsWorked: 1, bytesWorked: 100, hasMore: false });
    work.admitP4BootstrapWork(work.P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST);
    const deferred = await coordinator.runNextTurn();
    expect(deferred).toMatchObject({ outcome: 'deferred' });
    expect(coordinator.getJobSnapshot(work.P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST).consecutiveFailures).toBe(0);
    expect(coordinator.getJobSnapshot(work.P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST).wake).toEqual({ type: 'journal_state', key: 'repairable' });
    expect(coordinator.getJobSnapshot(work.P5_LIFECYCLE_JOB_KEYS.JOURNAL_MANIFEST_RECONCILE)).toBeTruthy();
    await coordinator.runNextTurn();
    expect(bridge.stepP5JournalManifestReconcile).toHaveBeenCalledTimes(1);
    await coordinator.runNextTurn();
    expect(bridge.ingestCompletedJournal).toHaveBeenCalledTimes(2);
    expect(coordinator.getJobSnapshot(work.P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST).consecutiveFailures).toBe(0);
  });
  it('F05 approved production J1 permits native publication and defers intact receipt debt without v1 work', async () => {
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    const lifecycle = await import('@/lib/lifecycleAuthority');
    lifecycle.__resetLifecycleAuthorityForTests({ documentVisible: true, nativeActive: true, epoch: 2 });
    const work = await import('@/lib/appLifecycleWork');
    const coordinator = work.getP4WorkCoordinator();coordinator.autoStart = false;
    vi.stubGlobal('navigator', { locks: createAuditTestRuntime().locks });
    bridge.readAuditFormat.mockResolvedValue({ fence: { state: 'LEGACY_AUDIT_UNKNOWN' }, itemsWorked: 1, bytesWorked: 64 });
    bridge.stepP5NativeRawGpsRetention.mockResolvedValue({ state: 'COMPLETE', itemsWorked: 1, bytesWorked: 32, hasMore: false });
    bridge.getP5PrivacyReceipts.mockResolvedValue({ state: 'READY', itemsWorked: 1, bytesWorked: 100, receipts: [{ operationId: 'pending', createdAtMs: 100, tripCount: 1, pointCount: 30, motionSampleCount: 0, reason: 'raw_gps_retention_policy' }] });
    bridge.getHealth.mockResolvedValue({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'f05' });
    work.admitP5ReviewedWork(work.P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION);
    expect(await coordinator.runNextTurn()).toMatchObject({ outcome: 'hasMore' });
    expect(bridge.stepP5NativeRawGpsRetention).toHaveBeenCalledTimes(1);
    expect(bridge.getP5PrivacyReceipts).not.toHaveBeenCalled();
    expect(await coordinator.runNextTurn()).toMatchObject({ outcome: 'deferred' });
    expect(bridge.getP5PrivacyReceipts).toHaveBeenCalledTimes(1);
    expect(bridge.acknowledgeP5PrivacyReceipt).not.toHaveBeenCalled();
    expect(coordinator.getJobSnapshot(work.P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION).wake).toEqual({ type: 'compatibility_conversion', key: 'privacy_audit_v1' });
    expect(work.getP5PrivacyReceiptStatus()).toMatchObject({ state: 'CONVERSION_REQUIRED', privacyReceiptPending: true });
    expect(coordinator.backgroundComplete(2)).toBe(true); // finite epoch, not external debt erasure
    expect(await coordinator.runNextTurn()).toBeNull();
    work.notifyPrivacyAuditConversionComplete();
    expect(coordinator.getJobSnapshot(work.P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION).active.state).toBe('queued');
  });
});
