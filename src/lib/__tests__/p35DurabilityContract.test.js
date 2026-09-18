import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('P3.5 frozen durability and scaling contract', () => {
  it('defines the native authority schema and independent integrity state', () => {
    const source = read('android/app/src/main/java/com/drivesense/app/DriveSenseArchiveOpenHelper.java');
    for (const table of [
      'archive_meta', 'trip_revisions', 'trip_current', 'trip_chunks', 'archive_events',
      'integrity_checkpoint_jobs', 'migration_quarantine', 'migration_shortfall',
      'key_reference_counts', 'rotation_state', 'open_operations', 'export_leases',
      'trip_aggregate_totals', 'trip_aggregate_buckets', 'speed_state', 'speed_buckets',
      'speed_current', 'speed_journal',
    ]) expect(source).toContain(`CREATE TABLE ${table}`);
    expect(source).toContain('setWriteAheadLoggingEnabled(true)');
    expect(source).toContain('PRAGMA synchronous=FULL');
    expect(source).toContain('PRAGMA secure_delete=ON');
  });

  it('fails Android authority closed and never promotes IDB on native failure', () => {
    const source = read('src/api/trips.js');
    expect(source).toContain("throw new CanonicalArchiveError('CANONICAL_UNAVAILABLE'");
    expect(source).toContain("authorityCache.authorityState === 'NATIVE'");
    expect(source).toContain('const health = await nativeTripArchive.health()');
  });

  it('enforces bounded list and chunk bridge contracts', () => {
    const source = read('android/app/src/main/java/com/drivesense/app/DriveSenseArchivePlugin.java');
    expect(source).toContain('MAX_CONTROL_REQUEST_BYTES=64*1024');
    expect(source).toContain('MAX_RESPONSE_BYTES=512*1024');
    expect(source).toContain('queryHistoryPage');
    expect(source).toContain('openTripPayload');
    expect(source).toContain('readTripPayloadChunk');
    expect(source).toContain('getTripOverviewTrack');
    expect(source).not.toContain('result.trips');
  });

  it('retains intake and admits retryable archive recovery once per process before repository use', () => {
    const coordinator = read('android/app/src/main/java/com/drivesense/app/DriveSenseStorageCoordinator.java');
    const repository = read('android/app/src/main/java/com/drivesense/app/DriveSenseTripArchiveRepository.java');
    expect(repository.indexOf('verifyCommitted(')).toBeLessThan(repository.indexOf('acknowledgeOne('));
    expect(repository).toContain('COMMITTED_ACK_DEFERRED');

    expect(coordinator).toContain('private static volatile DriveSenseStorageCoordinator instance;');
    expect(coordinator).toContain('synchronized void initializeTripArchive(');
    const initialization = coordinator.slice(
      coordinator.indexOf('synchronized void initializeTripArchive('),
      coordinator.indexOf('<T> T read(')
    );
    const guardAt = initialization.indexOf('if (tripArchiveInitialized) return;');
    const recoveryAt = initialization.indexOf('DriveSenseArchiveRecovery.recover(this, chunks);');
    const completeAt = initialization.indexOf('tripArchiveInitialized = true;');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(recoveryAt).toBeGreaterThan(guardAt);
    expect(completeAt).toBeGreaterThan(recoveryAt);
    expect(initialization.match(/DriveSenseArchiveRecovery\.recover/g)).toHaveLength(1);

    const constructor = repository.slice(
      repository.indexOf('DriveSenseTripArchiveRepository(Context context)'),
      repository.indexOf('DriveSenseStorageCoordinator coordinator()')
    );
    const archiveInitializationAt = constructor.indexOf('coordinator.initializeTripArchive(chunks);');
    const checkpointRecoveryAt = constructor.indexOf(
      'DriveSenseArchiveIntegrity.recoverInterruptedCheckpoints(coordinator);'
    );
    expect(archiveInitializationAt).toBeGreaterThanOrEqual(0);
    expect(checkpointRecoveryAt).toBeGreaterThan(archiveInitializationAt);
    expect(repository).not.toContain('DriveSenseArchiveRecovery.recover');
  });

  it('uses one streamed logical speed batch regardless of descriptor-page count', () => {
    const native = read('android/app/src/main/java/com/drivesense/app/DriveSenseSpeedArchiveRepository.java');
    const web = read('src/lib/nativeSpeedKnowledgeStore.js');
    expect(native).toContain('beginPlan');
    expect(native).toContain('addDescriptors');
    expect(native).toContain('sealPlan');
    expect(native).toContain('BUCKET_BATCH');
    expect(web).toContain('beginSpeedBucketBatchPlan(ids.length)');
    expect(web).toContain('addSpeedBucketDescriptors(planned.batchId, [descriptor])');
    expect(web).toContain('for (const descriptor of descriptors)');
    expect(web.match(/finishSpeedBucketBatch/g)).toHaveLength(1);
  });

  it('uses envelope rewrap and never rewrites route payloads during KEK rotation', () => {
    const source = read('android/app/src/main/java/com/drivesense/app/DriveSenseEnvelopeKeyRotation.java');
    expect(source).toContain('unwrapDek');
    expect(source).toContain('wrapDek');
    expect(source).toMatch(/payloadBytesRewritten",\s*0/);
    expect(source).not.toContain('readPayloadChunk');
  });

  it('writes portable framed backups with snapshot leases and restart-from-zero semantics', () => {
    const source = read('android/app/src/main/java/com/drivesense/app/DriveSenseStreamBackupManager.java');
    expect(source).toContain('road-sage-stream-backup');
    expect(source).toContain('throughSeq');
    expect(source).toContain('createLease');
    expect(source).toContain('RESTART_FROM_ZERO');
    expect(source).toContain('Argon2Mode.ARGON2_ID');
    expect(source).toContain('memoryKiB');
    expect(source).toContain('rollingCiphertextHash');
    expect(source).toContain('previous=frameChain.get()');
    expect(source).not.toContain('getAllTrips');
  });

  it('keeps normal page query options bounded', () => {
    const api = read('src/api/trips.js');
    // P3.5 bounded this option to 100 rows; **P7 Stage 9 deleted it outright**,
    // which is strictly stronger than bounding it. The guarantee this test
    // exists to hold — that no page reaches an unbounded whole-history query
    // option — is unchanged, and the per-page assertions below still enforce
    // it. What is asserted here is the stronger state: the symbol is gone.
    expect(api).not.toContain('tripSummaryQueryOptions = ');
    expect(api).toContain('limitedTripSummaryQueryOptions');
    for (const file of [
      'src/pages/Dashboard.jsx', 'src/pages/Insights.jsx', 'src/pages/Report.jsx',
      'src/pages/Achievements.jsx', 'src/pages/DrivingCoach.jsx', 'src/pages/MapScreen.jsx',
      'src/pages/TrackingOverview.jsx', 'src/pages/TrackingTripHistory.jsx',
      'src/pages/TrackingTripDetail.jsx', 'src/pages/TripDetail.jsx',
    ]) expect(read(file)).not.toContain('tripSummaryQueryOptions()');
  });
});
