package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * HPR-016 — abandoned migration/direct ingress must not outlive the process that
 * owned it, and must not block unrelated archive cleanup.
 *
 * THE CORRECTED ROOT CAUSE. Ingress identity IS durable: {@code begin()} writes a
 * {@code migration_ingress} row (operation id, trip id, source hash, temp path,
 * state RECEIVING) and an {@code open_operations} row typed LEGACY_IMPORT or
 * DIRECT_COMMIT. Nothing consumed those rows on restart. Archive recovery
 * reconciled only {@code TRIP_COMMIT}/{@code PENDING}, and
 * {@link DriveSenseArchiveUnlinkDebt#step} returns BLOCKED_NATIVE_OPERATION while
 * ANY {@code open_operations} row exists — so one dead ingress blocked unlink
 * debt indefinitely.
 *
 * Recovery is admitted once by the process-wide storage bootstrap, before the
 * first usable trip repository. Later helper repositories do not repeat it.
 * Durable ABANDONED_INGRESS markers distinguish affirmative prior-process
 * staging from a merely missing owner; resumed append atomically reacquires
 * RECEIVING ownership without changing identity or resetting chunk progress.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseHpr016MigrationIngressRecoveryRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository repository;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_migration_v1"));
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 0x47);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        repository = new DriveSenseTripArchiveRepository(context);
        makeArchiveReachable();
    }

    /**
     * Unlink debt refuses before it looks at operations unless the archive is
     * NATIVE, HEALTHY and sentinel-matched. Without this the BLOCKED_NATIVE_OPERATION
     * assertions below would pass vacuously against BLOCKED_RECOVERY and prove
     * nothing at all.
     */
    private void makeArchiveReachable() throws Exception {
        repository.coordinator().write(db -> {
            db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY' WHERE id=1");
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());
        DriveSenseArchiveHealth.inventory(repository.coordinator());
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    // ------------------------------------------------------------------ RED 1

    @Test public void abandonedLegacyImportIsReclaimedAndStopsBlockingUnlinkDebt() throws Exception {
        File temp = seedAbandonedIngress("dead-legacy", "legacy-trip", "LEGACY_IMPORT");
        assertTrue(temp.isFile());
        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations"));
        assertEquals(1L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        // The defect, before recovery consumes it.
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());

        // Stage one: the dead owner is released, so cleanup is unblocked at once.
        // The spool stays, because P3.5 froze a resume-by-chunk-index contract.
        restartProcess();

        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='dead-legacy' AND state='ABANDONED_INGRESS'"));
        assertEquals("COMPLETE", unlinkDebtState());
        assertEquals(1L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='dead-legacy'"));
        assertTrue("a resumable spool must survive one restart", temp.isFile());

        // Stage two: a whole app lifetime passed with nobody resuming it.
        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='dead-legacy'"));
        assertFalse("the stranded ingress spool must be reclaimed", temp.exists());
        assertEquals("COMPLETE", unlinkDebtState());
    }

    // ------------------------------------------------------------------ RED 2

    @Test public void abandonedDirectCommitIngressIsReclaimedToo() throws Exception {
        File temp = seedAbandonedIngress("dead-direct", "direct-trip", "DIRECT_COMMIT");
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());

        restartProcess();
        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='dead-direct' AND state='ABANDONED_INGRESS'"));
        assertEquals("COMPLETE", unlinkDebtState());

        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='dead-direct'"));
        assertFalse(temp.exists());
        assertEquals("COMPLETE", unlinkDebtState());
    }

    @Test public void bothIngressClassesAreReclaimedInOneStartup() throws Exception {
        File legacy = seedAbandonedIngress("dead-a", "trip-a", "LEGACY_IMPORT");
        File direct = seedAbandonedIngress("dead-b", "trip-b", "DIRECT_COMMIT");

        restartProcess();
        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations"));
        assertFalse(legacy.exists());
        assertFalse(direct.exists());
    }

    @Test public void aResumableIngressStillFinishesAfterOneRestart() throws Exception {
        // The P3.5 contract this reclamation must not break: an ingress is
        // resumable by durable chunk index across a restart. Stage one releases
        // the dead owner without touching the spool, so a caller still holding
        // the operation id can complete normally.
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository);
        JSONObject begun = migration.begin("resumable-trip", null, -1L);
        String operation = begun.getString("operationId");
        migration.append(operation, 0, android.util.Base64.encodeToString(
            "{\"id\":\"resumable-trip\",".getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));

        restartProcess();
        assertEquals("the dead owner is released immediately", "COMPLETE", unlinkDebtState());

        DriveSenseArchiveMigration resumed = new DriveSenseArchiveMigration(repository);
        resumed.append(operation, 1, android.util.Base64.encodeToString(
            "\"status\":\"completed\"}".getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
        assertEquals(2L, scalar("SELECT next_chunk_index FROM migration_ingress WHERE operation_id='" + operation + "'"));

        resumed.abort(operation);
        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='" + operation + "'"));
    }

    // ------------------------------------------------------------------ RED 3

    @Test public void repeatedRecoveryIsANoOp() throws Exception {
        File temp = seedAbandonedIngress("dead-legacy", "legacy-trip", "LEGACY_IMPORT");
        seedUnrelatedBackupOperation();

        restartProcess();
        restartProcess();
        assertFalse(temp.exists());
        long backupsAfterFirst = scalar("SELECT COUNT(*) FROM open_operations WHERE operation_type='BACKUP_V2_RESTORE'");

        // Second startup: the temp is already gone and the rows are already
        // reconciled. Nothing throws, and nothing unrelated is consumed.
        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        assertEquals(backupsAfterFirst,
            scalar("SELECT COUNT(*) FROM open_operations WHERE operation_type='BACKUP_V2_RESTORE'"));
        assertEquals(1L, backupsAfterFirst);
    }

    @Test public void anAlreadyMissingTempIsSuccessNotFailure() throws Exception {
        File temp = seedAbandonedIngress("dead-legacy", "legacy-trip", "LEGACY_IMPORT");
        assertTrue(temp.delete());

        restartProcess();
        restartProcess();

        // A phantom owner whose bytes are already gone must not survive.
        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='dead-legacy'"));
    }

    // ------------------------------------------------------------------ RED 4

    @Test public void ingressReconciliationPrecedesAnyIngress() throws Exception {
        // A live ingress cannot exist when recovery runs, and this is why:
        // the first repository awaits process bootstrap; subsequent repositories
        // share that initialized owner. The behavioral test below pins reuse.
        String recovery = readMainSource("DriveSenseTripArchiveRepository.java");
        int recoverAt = recovery.indexOf("coordinator.initializeTripArchive(");
        assertTrue("repository must await process-owned initialization", recoverAt > 0);
        int constructorAt = recovery.indexOf("DriveSenseTripArchiveRepository(Context context)");
        assertTrue(constructorAt > 0 && constructorAt < recoverAt);
        String bootstrap = readMainSource("DriveSenseStorageCoordinator.java");
        assertTrue(bootstrap.contains("synchronized void initializeTripArchive("));
        assertTrue(bootstrap.contains("if (tripArchiveInitialized) return;"));

        String plugin = readMainSource("DriveSenseArchivePlugin.java");
        assertTrue("plugin startup uses the same process-owned bootstrap",
            plugin.contains("public void load(){try{repository=new DriveSenseTripArchiveRepository(getContext())"));

        String migration = readMainSource("DriveSenseArchiveMigration.java");
        assertTrue("an ingress can only start through an existing repository",
            migration.contains("DriveSenseArchiveMigration(DriveSenseTripArchiveRepository repository)"));

        String manifest = readManifest();
        assertFalse("a second process would break the ordering proof", manifest.contains("android:process"));
    }

    @Test public void anIngressStartedAfterRecoveryIsUntouched() throws Exception {
        // The live-owner case that IS reachable: recovery has already run in this
        // process, and a real ingress is opened afterwards. Nothing may reclaim it.
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository);
        JSONObject begun = migration.begin("live-trip", null, -1L);
        String operation = begun.getString("operationId");
        migration.append(operation, 0, android.util.Base64.encodeToString(
            "{\"id\":\"live-trip\"}".getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));

        assertEquals(1L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='" + operation + "'"));
        String path = stringScalar("SELECT temp_path FROM migration_ingress WHERE operation_id='" + operation + "'");
        assertTrue(new File(path).isFile());

        // Recovery is not re-entered while a live owner holds the operation; the
        // ordinary abort path is how a live ingress is released.
        migration.abort(operation);
        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='" + operation + "'"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='" + operation + "'"));
        assertFalse(new File(path).exists());
    }

    // ------------------------------------------------------------------ RED 5

    @Test public void aTempOutsideTheMigrationDirectoryIsNeverDeleted() throws Exception {
        File outside = new File(context.getNoBackupFilesDir(), "not-ours.legacy.tmp");
        writeBytes(outside, 64);
        seedIngressRow("dead-escape", "escape-trip", "LEGACY_IMPORT", outside.getAbsolutePath());
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());

        restartProcess();
        restartProcess();

        // The operation is still dead and must stop blocking cleanup, but a path
        // the migration spool does not own is not this recovery's to unlink.
        assertTrue("a path outside the spool must not be deleted", outside.isFile());
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='dead-escape'"));
        assertEquals("COMPLETE", unlinkDebtState());
        assertTrue(outside.delete());
    }

    @Test public void aTempWhoseRowsWereAlreadyDeletedIsStillReclaimed() throws Exception {
        // `finish()` deletes the ingress rows and then wipes the spool, so a death
        // between the two leaves bytes nothing references.
        File orphan = new File(migrationDirectory(), "orphan-op.legacy.tmp");
        writeBytes(orphan, 128);
        assertTrue(orphan.isFile());

        restartProcess();

        assertFalse(orphan.exists());
    }

    @Test public void anIngressClassOperationWithNoIngressRowIsReclaimed() throws Exception {
        seedOperationRow("stranded-op", "LEGACY_IMPORT");
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());

        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='stranded-op'"));
        assertEquals("COMPLETE", unlinkDebtState());
    }

    // ------------------------------------------------------------------ RED 6

    @Test public void unrelatedOperationClassesAreNeverConsumed() throws Exception {
        seedAbandonedIngress("dead-legacy", "legacy-trip", "LEGACY_IMPORT");
        seedUnrelatedBackupOperation();
        seedOperationRow("live-commit", "TRIP_COMMIT");

        restartProcess();
        restartProcess();

        // The ingress is gone; a restore owner and a commit owner are not this
        // pass's to reclaim, and clearing `open_operations` wholesale would be a
        // far worse bug than the one being fixed.
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='dead-legacy'"));
        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_type='BACKUP_V2_RESTORE'"));
        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='live-commit'"));
    }

    // ------------------------------------------------------------- boundedness

    @Test public void reclamationIsBoundedByAbandonedOperationsNotByHistory() throws Exception {
        for (int index = 0; index < 12; index += 1) {
            seedAbandonedIngress("dead-" + index, "trip-" + index,
                index % 2 == 0 ? "LEGACY_IMPORT" : "DIRECT_COMMIT");
        }
        seedUnrelatedBackupOperation();

        long before = System.nanoTime();
        restartProcess();
        restartProcess();
        long elapsedMs = (System.nanoTime() - before) / 1_000_000L;

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        assertEquals(1L, scalar("SELECT COUNT(*) FROM open_operations"));
        File[] remaining = migrationDirectory().listFiles();
        assertTrue(remaining == null || remaining.length == 0);
        // Not a benchmark: a guard that this stayed O(K) rather than growing a
        // scan. Twelve reclamations cannot take seconds.
        assertTrue("reclamation must not scan: " + elapsedMs + "ms", elapsedMs < 20_000L);
    }

    @Test public void anEmptyStoreReconcilesNothingAndStaysHealthy() throws Exception {
        restartProcess();

        assertEquals(0L, scalar("SELECT COUNT(*) FROM migration_ingress"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations"));
        assertEquals("COMPLETE", unlinkDebtState());
    }

    // HPR-016 correction: the two independent CODEX REDs, now permanent.

    @Test public void resumedOwnershipSurvivesAnotherInterruptedLifetime() throws Exception {
        String[] parts = directParts("resumed-direct");
        String source = String.join("", parts);
        String sourceHash = hash(source);
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository, false);
        String operation = migration.begin("resumed-direct", sourceHash,
            source.getBytes(StandardCharsets.UTF_8).length).getString("operationId");
        appendText(migration, operation, 0, parts[0]);
        File spool = ingressSpool(operation);

        restartProcess();
        assertEquals("COMPLETE", unlinkDebtState());
        migration = new DriveSenseArchiveMigration(repository, false);
        appendText(migration, operation, 1, parts[1]);
        assertEquals(2L, chunkIndex(operation));

        restartProcess();
        assertEquals(1L, ingressCount(operation));
        assertTrue(spool.isFile());
        assertEquals(2L, chunkIndex(operation));
        assertEquals("resumed-direct", stringScalar("SELECT trip_id FROM migration_ingress WHERE operation_id='" + operation + "'"));
        assertEquals(sourceHash.toUpperCase(java.util.Locale.ROOT),
            stringScalar("SELECT hex(source_hash) FROM migration_ingress WHERE operation_id='" + operation + "'"));

        migration = new DriveSenseArchiveMigration(repository, false);
        appendText(migration, operation, 2, parts[2]);
        assertEquals(3L, chunkIndex(operation));
        long bytes = spool.length();
        assertRejectedChunk(migration, operation, 2, parts[2]);
        assertRejectedChunk(migration, operation, 0, parts[0]);
        assertEquals(3L, chunkIndex(operation));
        assertEquals(bytes, spool.length());
        migration.abort(operation);
        assertEquals("COMPLETE", unlinkDebtState());
    }

    @Test public void currentLiveIngressSurvivesOrdinaryCompletedTripAdmissions() throws Exception {
        DriveSenseArchiveMigration live = new DriveSenseArchiveMigration(repository, false);
        String operation = live.begin("live-direct", null, -1L).getString("operationId");
        String[] parts = directParts("live-direct");
        appendText(live, operation, 0, parts[0]);
        File spool = ingressSpool(operation);
        String incarnation = repository.coordinator().processIncarnation();
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        try {
            for (int index = 0; index < 2; index++) {
                JSONObject completed = new JSONObject(String.join("", directParts("live-admission-" + index)));
                assertTrue(DriveSenseNativeTripStore.addCompletedTrip(context, completed));
                assertEquals(1L, ingressCount(operation));
                assertTrue(spool.isFile());
                assertEquals(1L, chunkIndex(operation));
                assertEquals("RECEIVING", operationState(operation));
                assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());
                assertEquals(incarnation, repository.coordinator().processIncarnation());
            }
            appendText(live, operation, 1, parts[1]);
            assertEquals(2L, chunkIndex(operation));
            live.abort(operation);
            assertEquals("COMPLETE", unlinkDebtState());
        } finally { DriveSenseP35Flags.setNativeAuthorityForTests(null); }
    }

    @Test public void bootstrapRunsOncePerProcessNotPerRepositoryOrAdmission() throws Exception {
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository, false);
        String operation = migration.begin("bootstrap-live", null, -1L).getString("operationId");
        appendText(migration, operation, 0, "{}");
        String first = repository.coordinator().processIncarnation();
        for (int index = 0; index < 4; index++) {
            DriveSenseTripArchiveRepository helper = new DriveSenseTripArchiveRepository(context);
            helper.coordinator().initializeTripArchive(helper.chunkStore());
            assertEquals(first, helper.coordinator().processIncarnation());
            assertEquals("RECEIVING", operationState(operation));
        }
        restartProcess();
        String replacement = repository.coordinator().processIncarnation();
        assertNotEquals(first, replacement);
        assertEquals("ABANDONED_INGRESS", operationState(operation));
        assertEquals(replacement, operationToken(operation));
        for (int index = 0; index < 4; index++) {
            DriveSenseTripArchiveRepository helper = new DriveSenseTripArchiveRepository(context);
            assertEquals(replacement, helper.coordinator().processIncarnation());
            assertEquals(1L, ingressCount(operation));
            assertEquals(replacement, operationToken(operation));
        }
        restartProcess();
        assertEquals(0L, ingressCount(operation));
        assertEquals(0L, operationCount(operation));
    }

    @Test public void missingOwnerAloneIsNotDurableProofForFinalReclamation() throws Exception {
        File spool = seedAbandonedIngress("missing-owner", "missing-owner-trip", "DIRECT_COMMIT");
        repository.coordinator().write(db -> { db.delete("open_operations", "operation_id=?", new String[]{"missing-owner"}); return null; });
        restartProcess();
        assertEquals(1L, ingressCount("missing-owner"));
        assertTrue(spool.isFile());
        assertEquals("ABANDONED_INGRESS", operationState("missing-owner"));
        assertEquals("COMPLETE", unlinkDebtState());
        restartProcess();
        assertFalse(spool.exists());
        assertEquals(0L, ingressCount("missing-owner"));
        assertEquals(0L, operationCount("missing-owner"));
    }

    @Test public void recoveryRetryInSameIncarnationCannotAdvanceReleasedIngress() throws Exception {
        File spool = seedAbandonedIngress("startup-retry", "startup-retry-trip", "LEGACY_IMPORT");
        restartProcess();
        String releasedBy = operationToken("startup-retry");
        // Models retry after another startup step failed, rather than another process.
        DriveSenseArchiveRecovery.recover(repository.coordinator(), repository.chunkStore());
        DriveSenseArchiveRecovery.recover(repository.coordinator(), repository.chunkStore());
        assertEquals(1L, ingressCount("startup-retry"));
        assertTrue(spool.isFile());
        assertEquals(releasedBy, operationToken("startup-retry"));
        assertEquals("COMPLETE", unlinkDebtState());
        restartProcess();
        assertFalse(spool.exists());
    }

    @Test public void resumeReacquiresLiveUnlinkFenceAndAbortClearsIt() throws Exception {
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository, false);
        String operation = migration.begin("resume-fence", null, -1L).getString("operationId");
        appendText(migration, operation, 0, "{\"id\":\"resume-fence\",");
        restartProcess();
        assertEquals("COMPLETE", unlinkDebtState());
        assertEquals("ABANDONED_INGRESS", operationState(operation));
        migration = new DriveSenseArchiveMigration(repository, false);
        appendText(migration, operation, 1, "\"route_points\":[]}");
        assertEquals("RECEIVING", operationState(operation));
        assertEquals(operation, operationToken(operation));
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());
        migration.abort(operation);
        assertEquals(0L, operationCount(operation));
        assertEquals(0L, ingressCount(operation));
        assertEquals("COMPLETE", unlinkDebtState());
    }

    @Test public void repeatedProcessDeathsPreserveMonotonicProgressAndFinish() throws Exception {
        String[] parts = directParts("repeated-death");
        String full = String.join("", parts);
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository, false);
        String operation = migration.begin("repeated-death", hash(full), full.getBytes(StandardCharsets.UTF_8).length).getString("operationId");
        File spool;
        for (int index = 0; index < parts.length; index++) {
            if (index > 0) restartProcess();
            assertEquals(index, chunkIndex(operation));
            migration = new DriveSenseArchiveMigration(repository, false);
            appendText(migration, operation, index, parts[index]);
            assertEquals(index + 1L, chunkIndex(operation));
            assertEquals("RECEIVING", operationState(operation));
        }
        spool = ingressSpool(operation);
        restartProcess(); // process D resumes with all chunks already durable.
        assertEquals(3L, chunkIndex(operation));
        JSONObject result = new DriveSenseArchiveMigration(repository, false).finish(operation);
        assertEquals("repeated-death", result.getString("tripId"));
        assertTrue(repository.getMetadata("repeated-death") != null);
        assertEquals(0L, ingressCount(operation));
        assertEquals(0L, operationCount(operation));
        assertFalse(spool.exists());
        assertEquals("COMPLETE", unlinkDebtState());
        restartProcess();
        assertTrue(repository.getMetadata("repeated-death") != null);
        assertEquals(0L, operationCount(operation));
    }

    @Test public void finishAfterResumedAppendClearsRowsSpoolAndFence() throws Exception {
        String[] parts = directParts("resume-finish");
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository, false);
        String operation = migration.begin("resume-finish", null, -1L).getString("operationId");
        appendText(migration, operation, 0, parts[0]);
        File spool = ingressSpool(operation);
        restartProcess();
        migration = new DriveSenseArchiveMigration(repository, false);
        appendText(migration, operation, 1, parts[1]);
        appendText(migration, operation, 2, parts[2]);
        assertEquals("BLOCKED_NATIVE_OPERATION", unlinkDebtState());
        assertEquals("resume-finish", migration.finish(operation).getString("tripId"));
        assertEquals(0L, ingressCount(operation));
        assertEquals(0L, operationCount(operation));
        assertFalse(spool.exists());
        assertEquals("COMPLETE", unlinkDebtState());
        restartProcess();
        assertEquals(0L, operationCount(operation));
    }

    @Test public void failedUnlinkRetainsExplicitStageAndRetriesWithoutBlockingDebt() throws Exception {
        File spool = seedAbandonedIngress("unlink-retry", "unlink-retry-trip", "DIRECT_COMMIT");
        restartProcess();
        assertTrue(spool.delete()); assertTrue(spool.mkdir());
        File blocker = new File(spool, "unlink-blocker");
        writeBytes(blocker, 1);
        restartProcess();
        assertEquals(1L, ingressCount("unlink-retry"));
        assertEquals("ABANDONED_INGRESS", operationState("unlink-retry"));
        assertTrue(spool.exists());
        assertEquals("COMPLETE", unlinkDebtState());
        assertTrue(blocker.delete()); assertTrue(spool.delete()); writeBytes(spool, 1);
        restartProcess();
        assertFalse(spool.exists());
        assertEquals(0L, ingressCount("unlink-retry"));
        assertEquals(0L, operationCount("unlink-retry"));
        restartProcess();
        assertEquals("COMPLETE", unlinkDebtState());
    }

    private static String[] directParts(String id) {
        return new String[]{"{\"id\":\"" + id + "\",", "\"status\":\"completed\",\"start_time\":\"2026-09-17T00:00:00Z\",\"end_time\":\"2026-09-17T00:01:00Z\",", "\"route_points\":[]}"};
    }

    private static String hash(String value) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)))
            result.append(String.format(java.util.Locale.ROOT, "%02x", b));
        return result.toString();
    }

    private static void appendText(DriveSenseArchiveMigration migration, String operation, int index, String text) throws Exception {
        migration.append(operation, index, android.util.Base64.encodeToString(text.getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
    }

    private static void assertRejectedChunk(DriveSenseArchiveMigration migration, String operation, int index, String text) throws Exception {
        try { appendText(migration, operation, index, text); org.junit.Assert.fail("duplicate/reset chunk must be rejected"); }
        catch (IllegalStateException expected) { assertEquals("Migration chunk sequence mismatch", expected.getMessage()); }
    }

    private File ingressSpool(String operation) throws Exception {
        return new File(stringScalar("SELECT temp_path FROM migration_ingress WHERE operation_id='" + operation + "'"));
    }

    private long ingressCount(String operation) throws Exception { return scalar("SELECT COUNT(*) FROM migration_ingress WHERE operation_id='" + operation + "'"); }
    private long operationCount(String operation) throws Exception { return scalar("SELECT COUNT(*) FROM open_operations WHERE operation_id='" + operation + "'"); }
    private long chunkIndex(String operation) throws Exception { return scalar("SELECT next_chunk_index FROM migration_ingress WHERE operation_id='" + operation + "'"); }
    private String operationState(String operation) throws Exception { return stringScalar("SELECT state FROM open_operations WHERE operation_id='" + operation + "'"); }
    private String operationToken(String operation) throws Exception { return stringScalar("SELECT owner_token FROM open_operations WHERE operation_id='" + operation + "'"); }

    // ------------------------------------------------------------------ helpers

    private void restartProcess() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        repository = new DriveSenseTripArchiveRepository(context);
        makeArchiveReachable();
    }

    private File migrationDirectory() {
        File directory = new File(context.getNoBackupFilesDir(), "roadsage_archive_migration_v1");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("no migration directory");
        return directory;
    }

    private File seedAbandonedIngress(String operation, String tripId, String type) throws Exception {
        File temp = new File(migrationDirectory(), operation + ".legacy.tmp");
        writeBytes(temp, 512);
        seedIngressRow(operation, tripId, type, temp.getAbsolutePath());
        return temp;
    }

    private void seedIngressRow(String operation, String tripId, String type, String path) throws Exception {
        repository.coordinator().write(db -> {
            long now = System.currentTimeMillis();
            db.execSQL("INSERT INTO migration_ingress(operation_id,trip_id,source_hash,expected_bytes,received_bytes,"
                    + "next_chunk_index,temp_path,state,migration_mode,created_at_ms,updated_at_ms) "
                    + "VALUES(?,?,?,?,?,?,?,'RECEIVING',?,?,?)",
                new Object[]{operation, tripId, new byte[32], -1L, 512L, 1, path,
                    "LEGACY_IMPORT".equals(type) ? 1 : 0, now, now});
            db.execSQL("INSERT INTO open_operations(operation_id,operation_type,state,owner_token,created_at_ms,updated_at_ms) "
                    + "VALUES(?,?,'RECEIVING',?,?,?)",
                new Object[]{operation, type, operation, now, now});
            return null;
        });
    }

    private void seedOperationRow(String operation, String type) throws Exception {
        repository.coordinator().write(db -> {
            long now = System.currentTimeMillis();
            db.execSQL("INSERT INTO open_operations(operation_id,operation_type,state,owner_token,created_at_ms,updated_at_ms) "
                + "VALUES(?,?,'PENDING',?,?,?)", new Object[]{operation, type, operation, now, now});
            return null;
        });
    }

    private void seedUnrelatedBackupOperation() throws Exception {
        seedOperationRow("restore-owner", "BACKUP_V2_RESTORE");
    }

    private String unlinkDebtState() throws Exception {
        return DriveSenseArchiveUnlinkDebt.step(repository.coordinator(), repository.chunkStore()).getString("state");
    }

    private long scalar(String sql) throws Exception {
        return repository.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery(sql, null)) {
                cursor.moveToFirst();
                return cursor.getLong(0);
            }
        });
    }

    private String stringScalar(String sql) throws Exception {
        return repository.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery(sql, null)) {
                cursor.moveToFirst();
                return cursor.getString(0);
            }
        });
    }

    private static void writeBytes(File file, int count) throws Exception {
        byte[] payload = new byte[count];
        Arrays.fill(payload, (byte) 0x5A);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(payload);
        }
    }

    private static String readMainSource(String name) throws Exception {
        File file = new File("src/main/java/com/drivesense/app/" + name);
        if (!file.isFile()) file = new File("android/app/src/main/java/com/drivesense/app/" + name);
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static String readManifest() throws Exception {
        File file = new File("src/main/AndroidManifest.xml");
        if (!file.isFile()) file = new File("android/app/src/main/AndroidManifest.xml");
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
