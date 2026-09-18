package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;

import java.io.File;
import java.util.Arrays;

/**
 * The remaining RSAS crash/recovery boundaries.
 *
 * The existing active-spool suite covers segment durability, orphan and
 * corrupt-segment handling, the unsealed tail, and canonical retry. This suite
 * closes the boundaries either side of the ownership hand-off, where a crash
 * can leave sealed bytes owned by neither the producer nor the journal.
 *
 * Every case asserts the same four invariants:
 *
 *   1. sealed captured data is never silently lost;
 *   2. no completed trip is fabricated from an unsealed or partial state;
 *   3. no duplicate canonical trip appears after a retry;
 *   4. retries converge on exactly one outcome.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35ActiveSpoolFaultMatrixRobolectricTest {
    private Context context;
    private ServiceController<DriveSenseAutoTrackingService> controller;
    private DriveSenseAutoTrackingService service;
    private String originalProcessIncarnation;

    @Before public void setUp() {
        ShadowLog.stream = System.err;
        context = ApplicationProvider.getApplicationContext();
        originalProcessIncarnation = DriveSenseActiveTripSpool.processIncarnationForTests();
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-a");
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        DriveSenseActiveTripCheckpointStore.clear(context);
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x5a);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
    }

    @After public void tearDown() {
        if (controller != null) controller.destroy();
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);
        DriveSenseActiveTripSpool.setFaultPointForTests(null);
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        DriveSenseActiveTripSpool.setProcessIncarnationForTests(originalProcessIncarnation);
    }

    @Test public void staleHeartbeatInLiveProcessNeverAuthorizesReclaim() throws Exception {
        DriveSenseActiveTripSpool incumbent = DriveSenseActiveTripSpool.create(
            context, "live-incumbent", 1_777_900_000_000L, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        String token = incumbent.ownerToken();
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, incumbent.sessionId());
            throw new AssertionError("time cannot authorize theft from the live process incarnation");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_LIVE_OWNER, expected.getMessage());
        }
        DriveSenseActiveTripSpool stillOwner = DriveSenseActiveTripSpool.reopen(
            context, incumbent.sessionId(), DriveSenseActiveTripSpool.OWNER_NATIVE, token
        );
        stillOwner.close();
        incumbent.close();
    }

    @Test public void formerProcessReclaimIsDurableAndInvalidatesOldToken() throws Exception {
        long start = 1_777_910_000_000L;
        DriveSenseActiveTripSpool former = DriveSenseActiveTripSpool.create(
            context, "former-process", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            former.append(point(index, start));
        }
        String session = former.sessionId();
        String oldToken = former.ownerToken();
        long durablePoints = former.pointCount();
        former.close();

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-b");
        DriveSenseActiveTripSpool reclaimed = DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
        String newToken = reclaimed.ownerToken();
        assertFalse(oldToken.equals(newToken));
        assertEquals(durablePoints, reclaimed.pointCount());
        reclaimed.close();

        DriveSenseActiveTripSpool reopened = DriveSenseActiveTripSpool.reopen(
            context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, newToken
        );
        reopened.close();
        try {
            DriveSenseActiveTripSpool.reopen(context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, oldToken);
            throw new AssertionError("the former incarnation token must remain invalid after restart");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_NOT_OWNER, expected.getMessage());
        }
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
            throw new AssertionError("the current process cannot duplicate-reclaim its own lease");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_LIVE_OWNER, expected.getMessage());
        }
    }

    @Test public void guardedPhysicalHarnessCanReattachPreservedSpoolAfterProcessRecreation() throws Exception {
        long start = System.currentTimeMillis() - 120_000L;
        String tripId = "physical-h-preserved-spool-" + System.nanoTime();
        assertTrue(service.beginActiveRouteForTests(tripId, start));
        for (int index = 0; index < 300; index++) {
            assertTrue(service.appendActivePointForTests(point(index, start)));
        }
        service.persistActiveRouteCheckpointForTests();
        String sessionId = service.activeRouteStatusForTests().getString("session_id");

        // Model an instrumentation/process restart in which the ordinary service
        // starts before the in-memory Physical H authority override is restored.
        controller = null;
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-harness-recovery");
        DriveSenseP35Flags.setNativeAuthorityForTests(false);
        ServiceController<DriveSenseAutoTrackingService> replacementController =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        DriveSenseAutoTrackingService replacement = replacementController.get();
        assertTrue(replacement.activeRouteStatusForTests() == null);

        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        assertTrue(replacement.recoverActiveRouteForPhysicalHarness());
        assertEquals(sessionId, replacement.activeRouteStatusForTests().getString("session_id"));
        assertEquals(DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT,
            replacement.activeRouteStatusForTests().getLong("point_count"));
        controller = replacementController;
        service = replacement;
    }

    @Test public void interruptedReclaimConvergesWithoutLosingSealedSegments() throws Exception {
        long start = 1_777_920_000_000L;
        DriveSenseActiveTripSpool former = DriveSenseActiveTripSpool.create(
            context, "reclaim-interrupt", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            former.append(point(index, start));
        }
        String session = former.sessionId();
        long sealedBytes = former.sealedPlaintextBytes();
        former.close();

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-b");
        DriveSenseActiveTripSpool.setFaultPointForTests("BEFORE_RECLAIM_MANIFEST");
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
            throw new AssertionError("expected pre-persist reclaim fault");
        } catch (IllegalStateException expected) {
            assertEquals("TEST_FAULT_BEFORE_RECLAIM_MANIFEST", expected.getMessage());
        }
        DriveSenseActiveTripSpool.setFaultPointForTests(null);
        DriveSenseActiveTripSpool recovered = DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
        assertEquals(sealedBytes, recovered.sealedPlaintextBytes());
        recovered.close();

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-c");
        DriveSenseActiveTripSpool.setFaultPointForTests("AFTER_RECLAIM_MANIFEST");
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
            throw new AssertionError("expected post-persist reclaim fault");
        } catch (IllegalStateException expected) {
            assertEquals("TEST_FAULT_AFTER_RECLAIM_MANIFEST", expected.getMessage());
        }
        DriveSenseActiveTripSpool.setFaultPointForTests(null);
        // The new lease was durable before the simulated death, so a restart
        // with a new incarnation can recover it exactly once.
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-d");
        DriveSenseActiveTripSpool finalOwner = DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, session);
        assertEquals(sealedBytes, finalOwner.sealedPlaintextBytes());
        finalOwner.close();
    }

    /**
     * Composition regression: the checkpoint still names T1 after process B
     * has durably reclaimed the manifest as T2.  Process C must classify the
     * manifest by its prior process incarnation before rejecting stale T1.
     */
    @Test public void staleCheckpointTokenSurvivesTwoConsecutiveProcessDeaths() throws Exception {
        long start = 1_777_925_000_000L;
        String tripId = "double-process-death-" + System.nanoTime();
        assertTrue(service.beginActiveRouteForTests(tripId, start));
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT + 8; index++) {
            assertTrue(service.appendActivePointForTests(point(index, start)));
        }
        JSONObject processA = service.activeRouteStatusForTests();
        String session = processA.getString("session_id");
        File activeSession = new File(
            new File(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"), "active_spools"),
            session
        );
        String tokenT1 = DriveSenseActiveTripSpool.readManifestForStatus(context, activeSession)
            .getString("owner_token");

        // Persist A's last durable checkpoint, then model abrupt process loss:
        // no lifecycle callback gets a chance to rewrite it after reclaim.
        service.persistActiveRouteCheckpointForTests();
        JSONObject staleCheckpoint = DriveSenseActiveTripCheckpointStore.load(context, System.currentTimeMillis());
        assertNotNull(staleCheckpoint);
        assertEquals(tokenT1, staleCheckpoint.getString("rsas_owner_token"));
        controller = null;

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-b");
        ServiceController<DriveSenseAutoTrackingService> processBController =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        DriveSenseAutoTrackingService processB = processBController.get();
        JSONObject recoveredB = processB.activeRouteStatusForTests();
        String tokenT2 = DriveSenseActiveTripSpool.readManifestForStatus(context, activeSession)
            .getString("owner_token");
        assertEquals(session, recoveredB.getString("session_id"));
        assertFalse(tokenT1.equals(tokenT2));

        // Seal another complete segment under T2, then simulate immediate
        // process loss without onDestroy/checkpoint persistence.
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            assertTrue(processB.appendActivePointForTests(point(1000 + index, start)));
        }
        long durableBeforeSecondDeath = processB.activeRouteStatusForTests().getLong("point_count");

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-c");
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
        JSONObject recoveredC = service.activeRouteStatusForTests();
        assertEquals(session, recoveredC.getString("session_id"));
        assertFalse(tokenT2.equals(DriveSenseActiveTripSpool.readManifestForStatus(context, activeSession)
            .getString("owner_token")));
        assertEquals(durableBeforeSecondDeath, recoveredC.getLong("point_count"));

        for (int index = 0; index < 20; index++) {
            assertTrue(service.appendActivePointForTests(point(2000 + index, start)));
        }
        long expectedPoints = durableBeforeSecondDeath + 20L;
        assertTrue(service.sealActiveRouteToJournalForTests(
            completion(tripId, start, (int) expectedPoints)
        ));

        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject ingested = repository.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals("COMMITTED_ACKNOWLEDGED",
            ingested.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(expectedPoints, repository.getMetadata(tripId).getLong("point_count"));
        assertEquals(0, repository.ingestCompletedJournal(4, 8L * 1024L * 1024L)
            .getJSONArray("receipts").length());
        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));

        // Do not invoke B's lifecycle teardown: that would persist T2 and stop
        // exercising the stale-checkpoint composition.  Its in-memory object
        // represents a process that no longer exists.
        processBController = null;
    }

    @Test public void nonNativeWrongSessionAndSealedSpoolsCannotBeReclaimed() throws Exception {
        DriveSenseActiveTripSpool web = DriveSenseActiveTripSpool.create(
            context, "renderer-owned", 1_777_930_000_000L, "web_renderer"
        );
        String webSession = web.sessionId();
        web.close();
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-b");
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, webSession);
            throw new AssertionError("renderer ownership is never reclaimable by the native protocol");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_NOT_OWNER, expected.getMessage());
        }
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, "wrong-session");
            throw new AssertionError("an unrelated session must not be opened");
        } catch (Exception expected) {
            assertEquals("ACTIVE_SPOOL_MANIFEST_UNAVAILABLE", expected.getMessage());
        }

        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-a");
        DriveSenseActiveTripSpool sealed = DriveSenseActiveTripSpool.create(
            context, "sealed-reclaim", 1_777_940_000_000L, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        String sealedSession = sealed.sessionId();
        sealed.seal();
        sealed.close();
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("active-fault-process-b");
        try {
            DriveSenseActiveTripSpool.reclaimFormerNativeProcess(context, sealedSession);
            throw new AssertionError("SEALED state cannot become a new ACTIVE writer");
        } catch (IllegalStateException expected) {
            assertEquals("ACTIVE_SPOOL_NOT_RECLAIMABLE", expected.getMessage());
        }
    }

    /**
     * The service process dies mid-trip. Sealed segments survive and the
     * reopened spool reports exactly the sealed point count — never more.
     */
    @Test public void nativeServiceDeathPreservesSealedSegmentsAndResumes() throws Exception {
        long start = 1_778_000_000_000L;
        assertTrue(service.beginActiveRouteForTests("service-death", start));
        int sealedPoints = DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT * 2;
        for (int index = 0; index < sealedPoints + 7; index++) {
            assertTrue(service.appendActivePointForTests(point(index, start)));
        }
        JSONObject status = service.activeRouteStatusForTests();
        String session = status.getString("session_id");

        // Process death: the service is destroyed without a completion.
        controller.destroy();
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();

        // An interrupted trip was never handed to the journal, so its bytes are
        // still in the active spool location. That is exactly the state a
        // restart must be able to read without inventing a completed trip.
        File activeSession = new File(
            new File(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"), "active_spools"),
            session
        );
        assertTrue(activeSession.isDirectory());
        JSONObject manifest = DriveSenseActiveTripSpool.readManifestForStatus(context, activeSession);
        assertNotNull(manifest);
        // The manifest is a hint; the sealed segment files are the truth, which
        // is why recovery rescans them rather than trusting stale counters.
        assertEquals("ACTIVE", manifest.optString("state"));
        DriveSenseActiveTripSpool recovered = DriveSenseActiveTripSpool.reopen(
            context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, manifest.getString("owner_token")
        );
        // Only whole sealed segments are claimed. The open tail is the
        // documented, bounded loss window and is never counted.
        assertEquals(2, recovered.sealedSegmentCount());
        assertEquals(sealedPoints, recovered.pointCount());
        assertTrue(recovered.sealedPlaintextBytes() > 0L);
        recovered.close();
        // Nothing was completed, so no canonical trip may exist.
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        DriveSenseStorageCoordinator.resetForTests();
        assertEquals(0L, new DriveSenseTripArchiveRepository(context)
            .aggregates(new JSONObject()).getLong("liveCount"));
    }

    /**
     * A second producer arriving while the first still owns the session is
     * refused by token, and the incumbent's sealed bytes are untouched.
     */
    @Test public void duplicateProducerHandoffIsRefusedWithoutTouchingSealedBytes() throws Exception {
        long start = 1_778_100_000_000L;
        DriveSenseActiveTripSpool owner = DriveSenseActiveTripSpool.create(
            context, "duplicate-producer", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            owner.append(point(index, start));
        }
        long sealedBytes = owner.sealedPlaintextBytes();
        int sealedSegments = owner.sealedSegmentCount();
        assertTrue(sealedBytes > 0L);

        for (String wrongToken : new String[] { "", "not-the-owner", owner.ownerToken() + "x" }) {
            try {
                DriveSenseActiveTripSpool.reopen(
                    context, owner.sessionId(), DriveSenseActiveTripSpool.OWNER_NATIVE, wrongToken
                );
                throw new AssertionError("a second producer must never take an owned session");
            } catch (IllegalStateException expected) {
                assertEquals(DriveSenseActiveTripSpool.ERROR_NOT_OWNER, expected.getMessage());
            }
        }
        assertEquals(sealedBytes, owner.sealedPlaintextBytes());
        assertEquals(sealedSegments, owner.sealedSegmentCount());
        owner.close();
    }

    /**
     * A crash before the ownership rename. The journal manifest is already
     * durable, so recovery resolves the session from the prepared location and
     * the trip still ingests exactly once.
     */
    @Test public void completionInterruptedBeforeOwnershipRenameStillIngestsOnce() throws Exception {
        long start = 1_778_200_000_000L;
        assertTrue(service.beginActiveRouteForTests("transfer-before", start));
        for (int index = 0; index < 300; index++) assertTrue(service.appendActivePointForTests(point(index, start)));

        DriveSenseActiveTripSpool.setFaultPointForTests("BEFORE_OWNERSHIP_RENAME");
        // The transfer failure is caught and logged inside the journal: the
        // manifest is already committed, so completion still reports success.
        assertTrue(service.sealActiveRouteToJournalForTests(completion("transfer-before", start, 300)));
        DriveSenseActiveTripSpool.setFaultPointForTests(null);

        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject ingested = repository.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(ingested.toString(), "COMMITTED_ACKNOWLEDGED",
            ingested.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));

        // A second ingest must not produce a second canonical trip.
        JSONObject again = repository.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(0, again.getJSONArray("receipts").length());
        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));
    }

    /**
     * A crash after the rename but before the parent directory fsync. The
     * bytes are in the adopted location and recovery finds them there.
     */
    @Test public void completionInterruptedAfterOwnershipRenameIngestsOnce() throws Exception {
        long start = 1_778_300_000_000L;
        assertTrue(service.beginActiveRouteForTests("transfer-after", start));
        for (int index = 0; index < 300; index++) assertTrue(service.appendActivePointForTests(point(index, start)));

        DriveSenseActiveTripSpool.setFaultPointForTests("AFTER_OWNERSHIP_RENAME_BEFORE_FSYNC");
        assertTrue(service.sealActiveRouteToJournalForTests(completion("transfer-after", start, 300)));
        DriveSenseActiveTripSpool.setFaultPointForTests(null);

        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject ingested = repository.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(ingested.toString(), "COMMITTED_ACKNOWLEDGED",
            ingested.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));
    }

    /**
     * Journal adoption interrupted before the manifest is written.
     *
     * Nothing is claimed, so no completed trip may appear — but the sealed
     * spool bytes must survive so a retry can still complete the trip.
     */
    @Test public void journalAdoptionInterruptedBeforeManifestFabricatesNothing() throws Exception {
        long start = 1_778_400_000_000L;
        assertTrue(service.beginActiveRouteForTests("adopt-interrupt", start));
        for (int index = 0; index < 300; index++) assertTrue(service.appendActivePointForTests(point(index, start)));
        JSONObject status = service.activeRouteStatusForTests();
        String session = status.getString("session_id");

        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");
        assertFalse(service.sealActiveRouteToJournalForTests(completion("adopt-interrupt", start, 300)));
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);

        // No trip was claimed.
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        assertEquals(0L, repository.aggregates(new JSONObject()).getLong("liveCount"));

        // The sealed bytes are still there, so a retry completes the trip.
        File prepared = DriveSenseActiveTripSpool.locateJournalSession(
            context, new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"), session
        );
        assertNotNull(prepared);
        assertTrue(prepared.isDirectory());
        assertTrue(service.sealActiveRouteToJournalForTests(completion("adopt-interrupt", start, 300)));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
    }

    /**
     * A canonical commit that lands before the spool directory is reclaimed.
     * The leftover bytes must never be replayed as a second trip.
     */
    @Test public void canonicalCommitBeforeSpoolCleanupNeverDuplicates() throws Exception {
        long start = 1_778_500_000_000L;
        assertTrue(service.beginActiveRouteForTests("cleanup-crash", start));
        for (int index = 0; index < 400; index++) assertTrue(service.appendActivePointForTests(point(index, start)));
        assertTrue(service.sealActiveRouteToJournalForTests(completion("cleanup-crash", start, 400)));

        DriveSenseActiveTripSpool.setFaultPointForTests("BEFORE_SPOOL_RETIRE");
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject ingested = repository.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(ingested.toString(), "COMMITTED_ACKNOWLEDGED",
            ingested.getJSONArray("receipts").getJSONObject(0).getString("status"));
        DriveSenseActiveTripSpool.setFaultPointForTests(null);

        assertEquals(1L, repository.aggregates(new JSONObject()).getLong("liveCount"));

        // Restart and re-ingest: leftover spool bytes are not a second trip.
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository restarted = new DriveSenseTripArchiveRepository(context);
        restarted.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(1L, restarted.aggregates(new JSONObject()).getLong("liveCount"));
    }

    /**
     * Free space collapses during completion. The trip is not fabricated and
     * the sealed bytes are preserved for a retry once space returns.
     */
    @Test public void lowSpaceDuringCompletionPreservesBytesAndRetriesCleanly() throws Exception {
        long start = 1_778_600_000_000L;
        assertTrue(service.beginActiveRouteForTests("low-space-completion", start));
        for (int index = 0; index < 400; index++) assertTrue(service.appendActivePointForTests(point(index, start)));
        assertTrue(service.sealActiveRouteToJournalForTests(completion("low-space-completion", start, 400)));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());

        DriveSenseStorageAdmission.setAvailableBytesForTests(DriveSenseActiveTripSpool.SPACE_RESERVE_BYTES);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository blocked = new DriveSenseTripArchiveRepository(context);
        JSONObject refused = blocked.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        // Either the ingest is refused outright or it reports a retry; what it
        // must never do is acknowledge and drop the journal entry.
        if (refused.getJSONArray("receipts").length() > 0) {
            assertEquals("RETRY_REQUIRED",
                refused.getJSONArray("receipts").getJSONObject(0).getString("status"));
        }
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(0L, blocked.aggregates(new JSONObject()).getLong("liveCount"));

        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository recovered = new DriveSenseTripArchiveRepository(context);
        JSONObject retried = recovered.ingestCompletedJournal(4, 8L * 1024L * 1024L);
        assertEquals(retried.toString(), "COMMITTED_ACKNOWLEDGED",
            retried.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(1L, recovered.aggregates(new JSONObject()).getLong("liveCount"));
    }

    /**
     * The renderer dies while the native service keeps recording.
     *
     * Native owns the spool, so a renderer restart must not be able to take
     * the session, and the recording it interrupted keeps its sealed bytes.
     */
    @Test public void rendererDeathDoesNotDisturbTheNativeOwnedSpool() throws Exception {
        long start = 1_778_700_000_000L;
        assertTrue(service.beginActiveRouteForTests("renderer-death", start));
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT + 5; index++) {
            assertTrue(service.appendActivePointForTests(point(index, start)));
        }
        JSONObject before = service.activeRouteStatusForTests();
        String session = before.getString("session_id");

        // A restarted renderer holds no owner token, so it cannot take over.
        try {
            DriveSenseActiveTripSpool.reopen(context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, "renderer-restart");
            throw new AssertionError("renderer must not be able to seize a native-owned spool");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_NOT_OWNER, expected.getMessage());
        }

        // The service keeps recording, and completion is unaffected.
        for (int index = 0; index < 100; index++) {
            assertTrue(service.appendActivePointForTests(point(1000 + index, start)));
        }
        assertTrue(service.sealActiveRouteToJournalForTests(
            completion("renderer-death", start, DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT + 105)
        ));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
    }

    private JSONObject completion(String tripId, long start, int points) throws Exception {
        JSONObject completion = new JSONObject();
        completion.put("id", tripId);
        completion.put("start_time", start);
        completion.put("end_time", start + points * 1000L);
        completion.put("end_time_ms", start + points * 1000L);
        completion.put("status", "completed");
        return completion;
    }

    private JSONObject point(int index, long start) throws Exception {
        JSONObject point = new JSONObject();
        point.put("lat", 43.65 + index * 0.00001);
        point.put("lng", -79.38 + index * 0.00001);
        point.put("speed_kmh", 40 + (index % 20));
        point.put("timestamp", start + index * 1000L);
        return point;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
