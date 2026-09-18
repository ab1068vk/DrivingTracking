import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  archive: {},
  activity: { getNativeCompletedTrips: vi.fn() },
  admissions: [],
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => mocks.archive }));
vi.mock('@/lib/driveSenseNativePlugin', () => ({ default: mocks.activity }));
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => true, isNativePlatform: () => true }));
vi.mock('@/lib/permissions', () => ({ requestActivityRecognitionPermission: vi.fn() }));
vi.mock('@/lib/tripEngine', () => ({ haversineDistance: vi.fn() }));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(), recordSystemEvent: vi.fn(), recordSystemLog: vi.fn(),
}));
vi.mock('@/lib/appLifecycleWork', () => ({
  P5_LIFECYCLE_JOB_KEYS: {
    JOURNAL_MANIFEST_RECONCILE: 'p5JournalManifestReconcile',
    ARCHIVE_INTEGRITY_CHECKPOINT: 'p5ArchiveIntegrityCheckpoint',
    ARCHIVE_RESIDUE_GC: 'p5ArchiveResidueGc',
  },
  admitP5ReviewedWork: (jobKey, options = {}) => {
    mocks.admissions.push({ jobKey, ...options });
    return { status: 'queued' };
  },
}));

const { nativeTripArchive } = await import('@/lib/nativeTripArchive');
const { getNativeCompletedTrips } = await import('@/lib/activityRecognition');

describe('P5 production typed wake producers', () => {
  beforeEach(() => {
    mocks.admissions.length = 0;
    for (const key of Object.keys(mocks.archive)) delete mocks.archive[key];
    mocks.activity.getNativeCompletedTrips.mockReset();
  });

  it('J3 health observation produces canonical_health:healthy only for due healthy authority', async () => {
    mocks.archive.getHealth = vi.fn().mockResolvedValue({
      integrityDue: true, authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true,
    });
    await nativeTripArchive.health();
    expect(mocks.admissions).toEqual([{
      jobKey: 'p5ArchiveIntegrityCheckpoint',
      wake: { type: 'canonical_health', key: 'healthy' },
    }]);
  });

  it('J4 distinguishes proven export close from other terminal native operations', async () => {
    mocks.archive.getStreamBackupStatus = vi.fn()
      .mockResolvedValueOnce({ done: true, leaseClosed: true })
      .mockResolvedValueOnce({ done: true });
    await nativeTripArchive.streamBackupStatus('closed');
    await nativeTripArchive.streamBackupStatus('terminal-without-close-proof');
    expect(mocks.admissions).toEqual([
      { jobKey: 'p5ArchiveResidueGc', wake: { type: 'export_lease', key: 'closed' } },
      { jobKey: 'p5ArchiveResidueGc', wake: { type: 'native_operation', key: 'idle' } },
    ]);
  });

  it('an immediate backup cancel request emits no false export_lease:closed wake', async () => {
    mocks.archive.cancelStreamBackup = vi.fn().mockResolvedValue({ done: false, phase: 'CANCEL_REQUESTED' });
    await nativeTripArchive.cancelStreamBackup('still-active');
    expect(mocks.admissions).toEqual([]);
  });

  it('J2 observes a repairable O(1) status and emits journal_state:repairable', async () => {
    mocks.activity.getNativeCompletedTrips.mockResolvedValue({
      trips: [], canonicalPayloadApiRetired: true,
      queueStatus: { summaryState: 'DIRTY', queueReadable: false, unreadableCount: 0 },
    });
    expect(await getNativeCompletedTrips()).toEqual([]);
    expect(mocks.admissions).toEqual([{
      jobKey: 'p5JournalManifestReconcile',
      wake: { type: 'journal_state', key: 'repairable' },
    }]);
  });

  it('BOOTSTRAP_REQUIRED remains explicit and is never mis-admitted as J2', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class { constructor(type) { this.type = type; } });
    mocks.activity.getNativeCompletedTrips.mockResolvedValue({
      trips: [], queueStatus: { summaryState: 'BOOTSTRAP_REQUIRED', queueReadable: false },
    });
    await getNativeCompletedTrips();
    expect(mocks.admissions).toEqual([]);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'roadsage:p5-journal-bootstrap-required',
    }));
    vi.unstubAllGlobals();
  });
});
