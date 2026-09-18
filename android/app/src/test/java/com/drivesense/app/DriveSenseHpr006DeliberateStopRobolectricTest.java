package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.Intent;

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

import java.io.File;
import java.lang.reflect.Method;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseHpr006DeliberateStopRobolectricTest {
    private Context context;
    private ServiceController<DriveSenseAutoTrackingService> controller;
    private DriveSenseAutoTrackingService service;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        DriveSenseActiveTripCheckpointStore.clear(context);
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 0x36);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("hpr006-process-initial");
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
    }

    @After public void tearDown() {
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        if (controller != null) controller.destroy();
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        DriveSenseActiveTripSpool.setProcessIncarnationForTests(null);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void settingsStopFinalizesActiveTripBeforeDisablingRecovery() throws Exception {
        String tripId = "hpr-006-active-stop";
        beginSaveableActiveTrip(tripId);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        assertTrue(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));

        // This is the production seam called by the ActivityRecognition plugin.
        DriveSenseAutoTrackingService.stop(context);

        // A deliberate action must be delivered through onStartCommand. Merely
        // attaching ACTION_STOP to stopService() never executes the owner.
        Intent stopCommand = shadowOf((Application) context).getNextStartedService();
        boolean commandDispatched = stopCommand != null;
        if (commandDispatched) {
            assertEquals(DriveSenseAutoTrackingService.ACTION_STOP, stopCommand.getAction());
            service.onStartCommand(stopCommand, 0, 41);
        }
        controller.destroy();
        controller = null;

        boolean serviceEnabled = DriveSenseNativeTripStore.isServiceEnabled(context);
        boolean checkpointPresent = DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present");
        org.json.JSONArray pending = DriveSenseCompletedTripJournal.pendingTripIds(context, 10);
        boolean journalOwnsTrip = pending.length() == 1 && tripId.equals(pending.optString(0));
        assertTrue(
            "configuration stop end state: commandDispatched=" + commandDispatched +
                " serviceEnabled=" + serviceEnabled +
                " checkpointPresent=" + checkpointPresent +
                " journalOwnsTrip=" + journalOwnsTrip,
            commandDispatched && !serviceEnabled && !checkpointPresent && journalOwnsTrip
        );
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void stoppingWithoutActiveTripCreatesNoSyntheticCompletion() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        deliverSettingsStop(51);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertFalse(DriveSenseAutoTrackingService.deliberateStopStatus(context)
            .getBoolean("hadActiveTrip"));
    }

    @Test public void repeatedStopAndStopAfterExplicitEndRemainSingleCompletion() throws Exception {
        String tripId = "hpr-006-explicit-end";
        beginSaveableActiveTrip(tripId);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        Intent end = new Intent(context, DriveSenseAutoTrackingService.class)
            .setAction(DriveSenseAutoTrackingService.ACTION_END_TRIP)
            .putExtra(DriveSenseAutoTrackingService.EXTRA_KEEP_ARMED, false);
        service.onStartCommand(end, 0, 61);
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());

        deliverSettingsStop(62);
        deliverSettingsStop(63);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(tripId, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).getString(0));
    }

    @Test public void stopAfterExplicitDiscardDoesNotRecreateTheTrip() throws Exception {
        beginSaveableActiveTrip("hpr-006-explicit-discard");
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        Intent discard = new Intent(context, DriveSenseAutoTrackingService.class)
            .setAction(DriveSenseAutoTrackingService.ACTION_DISCARD_MANUAL_TRIP)
            .putExtra(DriveSenseAutoTrackingService.EXTRA_KEEP_ARMED, false);
        service.onStartCommand(discard, 0, 66);
        deliverSettingsStop(67);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
    }

    @Test public void journalFailureKeepsRecoveryOwnerAndRestartResumesDurableStop() throws Exception {
        String tripId = "hpr-006-retry";
        beginSaveableActiveTrip(tripId);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String firstRequest = deliverSettingsStop(71);

        assertTrue("failed completion disabled its only recovery owner",
            DriveSenseNativeTripStore.isServiceEnabled(context));
        assertTrue(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
        assertEquals(tripId,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("targetTripId"));
        assertEquals(
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getLong("intentGeneration"),
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getLong("currentIntentGeneration")
        );

        // Simulate service/process loss while the durable completion is pending. The
        // request identity and active checkpoint, not a process-local callback, must
        // let the replacement owner converge the stop.
        controller.destroy();
        controller = null;
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("hpr006-process-replacement");
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
        service.onStartCommand(null, 0, 72);

        assertEquals("replacement owner changed the durable deliberate-stop identity",
            firstRequest,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("requestId"));
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(tripId, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).getString(0));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void staleStopCannotFinalizeANewerManualTripOnNullRestart() throws Exception {
        String tripA = "hpr-006-stale-stop-trip-a";
        String tripB = "hpr-006-stale-stop-trip-b";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String staleRequest = deliverSettingsStop(73);
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));

        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        setLongField(service, "nextCompletedTripSaveRetryMs", 0L);
        long startMs = System.currentTimeMillis() - 5 * 60_000L;
        service.onStartCommand(
            new Intent(context, DriveSenseAutoTrackingService.class)
                .setAction(DriveSenseAutoTrackingService.ACTION_START_MANUAL_TRIP)
                .putExtra(DriveSenseAutoTrackingService.EXTRA_START_TIME_MS, startMs)
                .putExtra(DriveSenseAutoTrackingService.EXTRA_TRIP_ID, tripB),
            0,
            74
        );
        for (int index = 0; index < 24; index++) {
            assertTrue(service.appendActivePointForTests(routePoint(startMs, index)));
        }
        service.persistActiveRouteCheckpointForTests();
        assertEquals(tripB, service.activeRouteStatusForTests().getString("id"));

        service.onStartCommand(null, 0, 75);
        service.onStartCommand(null, 0, 76);

        assertTrue("stale request disabled a newer user-owned trip",
            DriveSenseNativeTripStore.isServiceEnabled(context));
        assertNotNull("stale request finalized the newer trip", service.activeRouteStatusForTests());
        assertEquals(tripB, service.activeRouteStatusForTests().getString("id"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(tripA, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).getString(0));
        assertEquals(staleRequest,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("requestId"));
        assertEquals("SUPERSEDED",
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void explicitStartSupersedesTerminalPendingStopInsteadOfDisabling() throws Exception {
        String tripA = "hpr-006-terminal-pending-trip-a";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String staleRequest = deliverSettingsStop(76);
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        assertTrue(invokeRetryPendingCompletion(service));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));

        assertTrue(DriveSenseAutoTrackingService.start(context));
        Intent explicitStart = shadowOf((Application) context).getNextStartedService();
        assertNotNull(explicitStart);
        assertEquals(DriveSenseAutoTrackingService.ACTION_START, explicitStart.getAction());
        service.onStartCommand(explicitStart, 0, 77);

        assertTrue("new enable intent was silently inverted by an old stop",
            DriveSenseNativeTripStore.isServiceEnabled(context));
        assertEquals(staleRequest,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("requestId"));
        assertEquals("SUPERSEDED",
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void recoveryCannotAttachBoundStopToDifferentActiveIdentity() throws Exception {
        String tripA = "hpr-006-bound-owner-a";
        String tripB = "hpr-006-bound-owner-b";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        deliverSettingsStop(771);
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        assertTrue(invokeRetryPendingCompletion(service));

        // This direct producer seam deliberately does not advance intent generation. It
        // isolates the trip/session binding guard from the independent start-generation guard.
        beginSaveableActiveTrip(tripB);
        service.persistActiveRouteCheckpointForTests();
        service.onStartCommand(null, 0, 772);

        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertNotNull(service.activeRouteStatusForTests());
        assertEquals(tripB, service.activeRouteStatusForTests().getString("id"));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUPERSEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void freshSettingsStopRearmsTerminalPendingRequestForNewBackgroundTrip() throws Exception {
        String tripA = "hpr-006-fresh-stop-old-trip-a";
        String tripB = "hpr-006-fresh-stop-current-trip-b";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String firstRequest = deliverSettingsStop(773);
        JSONObject boundToA = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        long intentGeneration = boundToA.getLong("intentGeneration");
        String sessionA = boundToA.getString("targetSessionId");
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            boundToA.getString("state"));
        assertTrue(boundToA.getBoolean("targetBound"));
        assertEquals(tripA, boundToA.getString("targetTripId"));
        assertFalse(sessionA.isEmpty());
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));

        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        assertTrue(invokeRetryPendingCompletion(service));
        JSONObject terminalA = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(firstRequest, terminalA.getString("requestId"));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            terminalA.getString("state"));
        assertTrue(terminalA.getBoolean("targetBound"));
        assertEquals(tripA, terminalA.getString("targetTripId"));
        assertEquals(sessionA, terminalA.getString("targetSessionId"));
        assertTrue(terminalA.getBoolean("targetTerminal"));
        assertEquals(intentGeneration, terminalA.getLong("currentIntentGeneration"));
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));

        // This is the background-auto-equivalent direct producer seam. It must not
        // advance the explicit user-intent generation.
        beginSaveableActiveTrip(tripB, 300, 60L * 60_000L);
        service.persistActiveRouteCheckpointForTests();
        assertEquals(intentGeneration,
            DriveSenseAutoTrackingService.deliberateStopStatus(context)
                .getLong("currentIntentGeneration"));
        JSONObject currentOwner = DriveSenseNativeTripStore.getActiveTripStatus(context);
        assertNotNull(currentOwner);
        assertEquals(tripB, currentOwner.getString("id"));
        assertFalse(sessionA.equals(currentOwner.getString("session_id")));

        String currentRequest = DriveSenseAutoTrackingService.stop(context);
        Intent stopCommand = shadowOf((Application) context).getNextStartedService();
        assertNotNull(stopCommand);
        assertEquals(DriveSenseAutoTrackingService.ACTION_STOP, stopCommand.getAction());
        assertEquals(currentRequest, stopCommand.getStringExtra(
            DriveSenseAutoTrackingService.EXTRA_DELIBERATE_STOP_REQUEST_ID));

        // A fresh Settings stop must durably shed A's recovery identity before its
        // command is dispatched/handled. The normal handler will bind it to B.
        JSONObject rearmed = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            rearmed.getString("state"));
        assertFalse(rearmed.getBoolean("targetBound"));
        assertEquals("", rearmed.getString("targetTripId"));
        assertEquals("", rearmed.getString("targetSessionId"));
        assertFalse(rearmed.getBoolean("targetTerminal"));
        assertEquals(intentGeneration, rearmed.getLong("intentGeneration"));

        // The re-arm is durable: a replacement process can restore B and handle
        // the already-enqueued explicit command without recovering A's binding.
        controller.destroy();
        controller = null;
        DriveSenseActiveTripSpool.setProcessIncarnationForTests("hpr006-fresh-stop-replacement");
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
        JSONObject restoredB = service.activeRouteStatusForTests();
        assertNotNull(restoredB);
        assertEquals(tripB, restoredB.getString("id"));
        assertTrue(restoredB.toString(), restoredB.getLong("point_count") >= 256L);
        assertTrue(restoredB.toString(), restoredB.getDouble("distance_km") >= 1d);
        assertTrue(restoredB.toString(), restoredB.getLong("duration_seconds") >= 60L);
        service.onStartCommand(stopCommand, 0, 774);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertEquals(null, service.activeRouteStatusForTests());
        DriveSenseTripArchiveRepository archive = new DriveSenseTripArchiveRepository(context);
        assertCompletionOwnedExactlyOnce(archive, tripA);
        assertCompletionOwnedExactlyOnce(archive, tripB);
        JSONObject succeeded = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(currentRequest, succeeded.getString("requestId"));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            succeeded.getString("state"));
    }

    @Test public void repeatedFreshStopKeepsBindingWhileSameTripStillOwnsRecovery() throws Exception {
        String tripA = "hpr-006-repeated-stop-same-trip-a";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String firstRequest = deliverSettingsStop(775);
        JSONObject firstPending = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            firstPending.getString("state"));
        assertTrue(firstPending.getBoolean("targetBound"));
        assertFalse(firstPending.getBoolean("targetTerminal"));
        assertEquals(tripA, firstPending.getString("targetTripId"));
        String sessionA = firstPending.getString("targetSessionId");
        assertFalse(sessionA.isEmpty());

        String repeatedRequest = DriveSenseAutoTrackingService.stop(context);
        Intent repeatedCommand = shadowOf((Application) context).getNextStartedService();
        assertNotNull(repeatedCommand);
        assertEquals(firstRequest, repeatedRequest);
        JSONObject repeatedPending = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            repeatedPending.getString("state"));
        assertTrue(repeatedPending.getBoolean("targetBound"));
        assertFalse(repeatedPending.getBoolean("targetTerminal"));
        assertEquals(tripA, repeatedPending.getString("targetTripId"));
        assertEquals(sessionA, repeatedPending.getString("targetSessionId"));

        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        service.onStartCommand(repeatedCommand, 0, 776);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertEquals(1, countPendingTrip(tripA));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    @Test public void freshStopDoesNotCoalesceSameTripIdFromDifferentP35Session() throws Exception {
        String tripA = "hpr-006-same-trip-different-session";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String requestId = deliverSettingsStop(777);
        JSONObject firstPending = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        String firstSession = firstPending.getString("targetSessionId");
        assertFalse(firstSession.isEmpty());

        // Current-owner status is encrypted durable state. Equal trip ids do not
        // make a different P3.5 spool/session the same lifecycle operation.
        JSONObject replacementOwner = new JSONObject();
        replacementOwner.put("active", true);
        replacementOwner.put("id", tripA);
        replacementOwner.put("session_id", firstSession + "-replacement");
        DriveSenseNativeTripStore.setActiveTripStatus(context, replacementOwner);

        assertEquals(requestId, DriveSenseAutoTrackingService.stop(context));
        Intent stopCommand = shadowOf((Application) context).getNextStartedService();
        assertNotNull(stopCommand);
        assertEquals(requestId, stopCommand.getStringExtra(
            DriveSenseAutoTrackingService.EXTRA_DELIBERATE_STOP_REQUEST_ID));
        JSONObject rearmed = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_PENDING,
            rearmed.getString("state"));
        assertFalse(rearmed.getBoolean("targetBound"));
        assertEquals("", rearmed.getString("targetTripId"));
        assertEquals("", rearmed.getString("targetSessionId"));
        assertFalse(rearmed.getBoolean("targetTerminal"));
    }

    @Test public void terminalPendingStopWithoutNewerIntentMayFinishOriginalDisable() throws Exception {
        String tripA = "hpr-006-terminal-current-intent";
        beginSaveableActiveTrip(tripA);
        service.persistActiveRouteCheckpointForTests();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");

        String requestId = deliverSettingsStop(78);
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        assertTrue(invokeRetryPendingCompletion(service));
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));

        service.onStartCommand(null, 0, 79);

        assertFalse(
            "terminal retry state=" + DriveSenseAutoTrackingService.deliberateStopStatus(context)
                + " route=" + service.activeRouteStatusForTests()
                + " journal=" + DriveSenseCompletedTripJournal.pendingTripIds(context, 10),
            DriveSenseNativeTripStore.isServiceEnabled(context)
        );
        assertEquals(requestId,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("requestId"));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(tripA, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).getString(0));
    }

    @Test public void olderExplicitStartCommandCannotOvertakeNewerGeneration() throws Exception {
        long startMs = System.currentTimeMillis() - 5 * 60_000L;
        assertTrue(DriveSenseAutoTrackingService.startManualTrip(
            context, startMs, "hpr-006-older-explicit-start"));
        assertTrue(DriveSenseAutoTrackingService.startManualTrip(
            context, startMs + 1_000L, "hpr-006-newer-explicit-start"));
        Intent older = shadowOf((Application) context).getNextStartedService();
        Intent newer = shadowOf((Application) context).getNextStartedService();
        assertNotNull(older);
        assertNotNull(newer);

        // Android may deliver already-enqueued service commands after a later user action.
        // The durable generation, not arrival order, decides which intent may own a trip.
        service.onStartCommand(older, 0, 791);
        service.onStartCommand(newer, 0, 792);

        assertNotNull(service.activeRouteStatusForTests());
        assertEquals("hpr-006-newer-explicit-start",
            service.activeRouteStatusForTests().getString("id"));
        assertEquals(
            newer.getLongExtra(DriveSenseAutoTrackingService.EXTRA_TRACKING_INTENT_GENERATION, -1L),
            DriveSenseAutoTrackingService.deliberateStopStatus(context)
                .getLong("currentIntentGeneration")
        );
    }

    @Test public void ordinaryAuthorityUsesTheSameDurableConfigurationStop() throws Exception {
        String tripId = "hpr-006-ordinary-authority";
        long startMs = System.currentTimeMillis() - 5 * 60_000L;
        DriveSenseP35Flags.setNativeAuthorityForTests(false);

        // Enter through the production manual-service command. Only point injection is
        // reflective because Robolectric does not supply a real Android GPS stream.
        Intent start = new Intent(context, DriveSenseAutoTrackingService.class)
            .setAction(DriveSenseAutoTrackingService.ACTION_START_MANUAL_TRIP)
            .putExtra(DriveSenseAutoTrackingService.EXTRA_START_TIME_MS, startMs)
            .putExtra(DriveSenseAutoTrackingService.EXTRA_TRIP_ID, tripId);
        service.onStartCommand(start, 0, 81);
        Method append = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "appendActivePoint", JSONObject.class);
        append.setAccessible(true);
        for (int index = 0; index < 24; index++) {
            assertTrue((Boolean) append.invoke(service, routePoint(startMs, index)));
        }
        Method checkpoint = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "persistActiveTripCheckpoint", long.class, boolean.class);
        checkpoint.setAccessible(true);
        checkpoint.invoke(service, System.currentTimeMillis(), true);

        deliverSettingsStop(82);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseActiveTripCheckpointStore.getStatus(
            context, System.currentTimeMillis()).getBoolean("present"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(tripId, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).getString(0));
    }

    private String deliverSettingsStop(int startId) {
        String requestId = DriveSenseAutoTrackingService.stop(context);
        Intent stopCommand = shadowOf((Application) context).getNextStartedService();
        assertNotNull(stopCommand);
        assertEquals(DriveSenseAutoTrackingService.ACTION_STOP, stopCommand.getAction());
        assertEquals(requestId, stopCommand.getStringExtra(
            DriveSenseAutoTrackingService.EXTRA_DELIBERATE_STOP_REQUEST_ID));
        service.onStartCommand(stopCommand, 0, startId);
        return requestId;
    }

    private void beginSaveableActiveTrip(String tripId) throws Exception {
        beginSaveableActiveTrip(tripId, 24, 5L * 60_000L);
    }

    private void beginSaveableActiveTrip(
        String tripId,
        int pointCount,
        long ageMs
    ) throws Exception {
        long startMs = System.currentTimeMillis() - ageMs;
        assertTrue(service.beginActiveRouteForTests(tripId, startMs));
        for (int index = 0; index < pointCount; index++) {
            assertTrue(service.appendActivePointForTests(routePoint(startMs, index)));
        }
    }

    private static JSONObject routePoint(long startMs, int index) throws Exception {
        JSONObject point = new JSONObject();
        point.put("lat", 43.65d + index * 0.001d);
        point.put("lng", -79.38d);
        point.put("speed_kmh", 45d);
        point.put("timestamp", new java.util.Date(startMs + index * 10_000L).toInstant().toString());
        return point;
    }

    private static void setLongField(Object target, String name, long value) throws Exception {
        java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.setLong(target, value);
    }

    private static boolean invokeRetryPendingCompletion(DriveSenseAutoTrackingService target) throws Exception {
        Method retry = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "retryPendingCompletedTripSave", boolean.class);
        retry.setAccessible(true);
        return (Boolean) retry.invoke(target, true);
    }

    private int countPendingTrip(String tripId) throws Exception {
        org.json.JSONArray pending = DriveSenseCompletedTripJournal.pendingTripIds(context, 10);
        int count = 0;
        for (int index = 0; index < pending.length(); index++) {
            if (tripId.equals(pending.optString(index))) count += 1;
        }
        return count;
    }

    private void assertCompletionOwnedExactlyOnce(
        DriveSenseTripArchiveRepository archive,
        String tripId
    ) throws Exception {
        int journalOwners = countPendingTrip(tripId);
        int canonicalOwners = archive.getMetadata(tripId) == null ? 0 : 1;
        assertEquals("completion ownership for " + tripId,
            1, journalOwners + canonicalOwners);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
