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

import com.google.android.gms.location.DetectedActivity;

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
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * UA (unnumbered) — a stale activity command must not revive a deliberate disable.
 *
 * THE SETTLED MECHANISM, exactly. An activity broadcast arrives while the service
 * is enabled; {@code handleActivityBroadcast} checks the enabled state and queues
 * {@code ACTION_ACTIVITY} through {@code startForegroundService}; a deliberate
 * stop then enters PENDING, reaches SUCCEEDED and makes {@code serviceEnabled ==
 * false} durable; and only afterwards is the queued activity delivered. The
 * generic "every non-stop action enables" branch in {@code onStartCommand} then
 * set the durable enable bit back to true and rearmed the watchdog, activity
 * updates and armed location capture.
 *
 * The confirmed consequence is durable service-enabled truth revival. This suite
 * does not claim a new trip is necessarily created.
 *
 * THE RULE. An activity or notification command is not an explicit enable intent.
 * Only an explicit start, or the recovery/null restart HPR-006 owns, may move
 * durable enabled truth from false to true; every other command must find the
 * service still enabled AT DELIVERY, not merely at dispatch. That is causal
 * authority — it reads the same durable truth the stop published — so nothing
 * here depends on sleeps, debounce, age thresholds or Handler ordering.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseUaStaleActivityEnableRobolectricTest {
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
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
    }

    @After public void tearDown() {
        if (controller != null) controller.destroy();
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    // ------------------------------------------------------------------- RED 1

    @Test public void activityAcceptedBeforeAStopCannotReviveTrackingAfterIt() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        // 1-3. A real broadcast passes the receiver's enabled gate and is
        //      dispatched as ACTION_ACTIVITY. Capturing it here is exactly the
        //      window the defect lives in.
        DriveSenseAutoTrackingService.handleActivityBroadcast(
            context, new DetectedActivity(DetectedActivity.IN_VEHICLE, 95));
        Intent queuedActivity = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_ACTIVITY);
        assertNotNull("the receiver must have accepted and dispatched the activity", queuedActivity);

        // 4-6. A real deliberate stop runs to SUCCEEDED and disables durably.
        deliverSettingsStop(71);
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));

        // 7. Only now is the previously accepted activity delivered.
        service.onStartCommand(queuedActivity, 0, 72);

        assertFalse("a stale activity must not revive durable enabled truth",
            DriveSenseNativeTripStore.isServiceEnabled(context));
        assertEquals("the stop result must stand",
            DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
        assertFalse("no trip may be resurrected by a stale activity",
            DriveSenseActiveTripCheckpointStore.getStatus(context, System.currentTimeMillis())
                .getBoolean("present"));
    }

    @Test public void aStaleActivityDoesNotRearmTheWatchdogOrRestartCapture() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseAutoTrackingService.handleActivityBroadcast(
            context, new DetectedActivity(DetectedActivity.IN_VEHICLE, 92));
        Intent queuedActivity = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_ACTIVITY);
        assertNotNull(queuedActivity);
        deliverSettingsStop(73);

        int returned = service.onStartCommand(queuedActivity, 0, 74);

        // START_NOT_STICKY matters as much as the refusal: a sticky restart would
        // redeliver a null intent, which IS a recovery start and would re-enable
        // through the front door.
        assertEquals(android.app.Service.START_NOT_STICKY, returned);
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    // ------------------------------------------------------------------- RED 2

    @Test public void anOrdinaryActivityStillWorksWhileTrackingIsEnabled() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        DriveSenseAutoTrackingService.handleActivityBroadcast(
            context, new DetectedActivity(DetectedActivity.IN_VEHICLE, 96));
        Intent queuedActivity = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_ACTIVITY);
        assertNotNull(queuedActivity);

        // No disable intervenes. The command keeps its authority and the service
        // stays enabled; the guard must not have broken ordinary operation.
        int returned = service.onStartCommand(queuedActivity, 0, 75);

        assertEquals(android.app.Service.START_STICKY, returned);
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    @Test public void theReceiverStillRefusesToDispatchWhileDisabled() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, false);
        shadowOf((Application) context).getNextStartedService();

        DriveSenseAutoTrackingService.handleActivityBroadcast(
            context, new DetectedActivity(DetectedActivity.IN_VEHICLE, 90));

        // The dispatch gate is not the fix and was not removed; it is simply not
        // sufficient on its own.
        assertEquals(null, nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_ACTIVITY));
    }

    // ------------------------------------------------------------------- RED 3

    @Test public void anExplicitStartAfterAStopStillEnablesTracking() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        deliverSettingsStop(76);
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));

        // The guard must not make the service impossible to restart. A current,
        // explicit user intent is a different command class entirely.
        DriveSenseAutoTrackingService.start(context);
        Intent start = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_START);
        assertNotNull("an explicit start must reach the service", start);
        service.onStartCommand(start, 0, 77);

        assertTrue("an explicit start may re-enable", DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    @Test public void anExplicitManualTripStartAfterAStopStillEnablesTracking() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        deliverSettingsStop(78);

        DriveSenseAutoTrackingService.startManualTrip(context, System.currentTimeMillis(), "ua-manual-trip");
        Intent start = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_START_MANUAL_TRIP);
        assertNotNull(start);
        service.onStartCommand(start, 0, 79);

        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    // ------------------------------------------------------------------- RED 4

    @Test public void aNullRecoveryRestartIsStillTreatedAsARecoveryStart() throws Exception {
        // HPR-006 owns the null/START_STICKY restart, and UA must not reclassify
        // it. With no pending stop and tracking previously on, a null intent is a
        // recovery start and remains able to arm.
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        int returned = service.onStartCommand(null, 0, 80);

        assertEquals(android.app.Service.START_STICKY, returned);
        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    @Test public void aPendingStopStillWinsARecoveryRestart() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        deliverSettingsStop(81);
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));

        // HPR-006: a null restart consults the pending-stop owner before anything
        // else. UA inserted nothing ahead of that.
        service.onStartCommand(null, 0, 82);

        assertEquals(DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).getString("state"));
    }

    // ------------------------------------------------------------------- RED 5

    @Test public void manyQueuedActivitiesAfterOneDisableAllStayStale() throws Exception {
        DriveSenseNativeTripStore.setServiceEnabled(context, true);
        Intent[] queued = new Intent[6];
        for (int index = 0; index < queued.length; index += 1) {
            DriveSenseAutoTrackingService.handleActivityBroadcast(
                context, new DetectedActivity(DetectedActivity.IN_VEHICLE, 80 + index));
            queued[index] = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_ACTIVITY);
            assertNotNull(queued[index]);
        }

        deliverSettingsStop(83);

        for (int index = 0; index < queued.length; index += 1) {
            service.onStartCommand(queued[index], 0, 84 + index);
            assertFalse("queued activity " + index + " revived tracking",
                DriveSenseNativeTripStore.isServiceEnabled(context));
        }

        // Each decision reads one durable boolean: O(1) per command, with no
        // queue scan and no retained command history.
        String source = readMainSource("DriveSenseAutoTrackingService.java");
        assertFalse("no command backlog may be retained", source.contains("activityCommandHistory"));
    }

    // -------------------------------------------------------- design guarantees

    @Test public void theGuardIsCausalRatherThanTimingBased() throws Exception {
        String source = readMainSource("DriveSenseAutoTrackingService.java");
        int guardAt = source.indexOf("boolean mayEnableTracking = startAction || action == null;");
        assertTrue("the enable classification must exist", guardAt > 0);

        // The generic "every non-stop action enables" branch must be gone.
        assertFalse("the unconditional enable must not return",
            source.contains("\n        DriveSenseNativeTripStore.setServiceEnabled(this, true);\n        if (ACTION_START_MANUAL_TRIP.equals(action))"));

        String guard = source.substring(guardAt, Math.min(source.length(), guardAt + 1400));
        assertTrue(guard.contains("DriveSenseNativeTripStore.isServiceEnabled(this)"));
        assertTrue(guard.contains("START_NOT_STICKY"));
        // Nothing here may rest on elapsed time or delivery order.
        assertFalse(guard.contains("SystemClock.sleep"));
        assertFalse(guard.contains("elapsedRealtime"));
        assertFalse(guard.contains("postDelayed"));
    }

    @Test public void onCreateAloneDoesNotReviveDurableEnabledTruth() throws Exception {
        // The lifecycle worry the settled mechanism raises: a stale activity can
        // recreate the process. `onCreate` must not arm or enable before
        // `onStartCommand` gets to refuse.
        String source = readMainSource("DriveSenseAutoTrackingService.java");
        int createAt = source.indexOf("public void onCreate() {");
        int createEnd = source.indexOf("\n    @Override\n    public int onStartCommand");
        assertTrue(createAt > 0 && createEnd > createAt);
        String onCreate = source.substring(createAt, createEnd);

        assertFalse(onCreate.contains("setServiceEnabled"));
        assertFalse(onCreate.contains("armPeriodicCheck"));
        assertFalse(onCreate.contains("startArmedLocationUpdates"));
        assertFalse(onCreate.contains("requestActivityUpdates"));

        // And behaviourally: recreating the service while durably disabled leaves
        // it disabled.
        DriveSenseNativeTripStore.setServiceEnabled(context, false);
        ServiceController<DriveSenseAutoTrackingService> recreated =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        try {
            assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        } finally {
            recreated.destroy();
        }
    }

    // ------------------------------------------------------------------ helpers

    private void deliverSettingsStop(int startId) throws Exception {
        DriveSenseAutoTrackingService.stop(context);
        Intent stopCommand = nextStartedServiceWithAction(DriveSenseAutoTrackingService.ACTION_STOP);
        assertNotNull("the deliberate stop must be dispatched", stopCommand);
        service.onStartCommand(stopCommand, 0, startId);
    }

    /** Drains the started-service queue until the named action appears. */
    private Intent nextStartedServiceWithAction(String action) {
        for (int guard = 0; guard < 32; guard += 1) {
            Intent next = shadowOf((Application) context).getNextStartedService();
            if (next == null) return null;
            if (action.equals(next.getAction())) return next;
        }
        return null;
    }

    private static String readMainSource(String name) throws Exception {
        File file = new File("src/main/java/com/drivesense/app/" + name);
        if (!file.isFile()) file = new File("android/app/src/main/java/com/drivesense/app/" + name);
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
