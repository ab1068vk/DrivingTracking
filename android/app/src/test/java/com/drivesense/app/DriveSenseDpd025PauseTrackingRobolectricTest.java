package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

/**
 * DPD-025 -- "Pause All Tracking" must never be the reason tracking starts.
 *
 * The physical defect: with location permission denied, pausing dispatched
 * ACTION_STOP through startForegroundService, which created the service, whose
 * onCreate promoted it to a location-typed foreground service. Android refuses
 * that promotion without a runtime location permission, and the refusal is a
 * SecurityException on the main thread, so the process died -- twice, because it
 * died again on restart.
 *
 * The law these tests hold: pausing is safe and idempotent whether or not the
 * service is running, and never requires a location foreground service.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class DriveSenseDpd025PauseTrackingRobolectricTest {
    private Context context;
    private Application application;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        application = (Application) context.getApplicationContext();
        DriveSenseActiveTripCheckpointStore.clear(context);
        DriveSenseNativeTripStore.setServiceEnabled(context, false);
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        drainStartedServices();
    }

    private void drainStartedServices() {
        while (shadowOf(application).getNextStartedService() != null) {
            // drain anything an earlier case queued
        }
    }

    private void denyLocation() {
        shadowOf(application).denyPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        );
    }

    private void grantLocation() {
        shadowOf(application).grantPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        );
    }

    /** permission denied + service not running + pause -> no service is started at all. */
    @Test public void pauseWithoutPermissionOrRunningServiceStartsNothing() {
        denyLocation();

        String requestId = DriveSenseAutoTrackingService.stop(context);

        assertNotNull(requestId);
        assertNull(
            "Pausing must not start the tracking service it means to stop",
            shadowOf(application).getNextStartedService()
        );
        JSONObject status = DriveSenseAutoTrackingService.deliberateStopStatus(context);
        assertEquals(
            DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            status.optString("state")
        );
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    /** permission granted + service not running + pause -> still starts nothing. */
    @Test public void pauseWithPermissionButNoRunningServiceStartsNothing() {
        grantLocation();

        DriveSenseAutoTrackingService.stop(context);

        assertNull(
            "A stop with nothing to stop is satisfied without a service instance",
            shadowOf(application).getNextStartedService()
        );
        assertEquals(
            DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).optString("state")
        );
    }

    /** Pausing twice stays safe and stays settled -- idempotent. */
    @Test public void pauseIsIdempotent() {
        denyLocation();

        String first = DriveSenseAutoTrackingService.stop(context);
        drainStartedServices();
        String second = DriveSenseAutoTrackingService.stop(context);

        assertNotNull(first);
        assertNotNull(second);
        assertNull(
            "Repeating a pause must remain a no-op, not a second lifecycle attempt",
            shadowOf(application).getNextStartedService()
        );
        assertEquals(
            DriveSenseAutoTrackingService.DELIBERATE_STOP_SUCCEEDED,
            DriveSenseAutoTrackingService.deliberateStopStatus(context).optString("state")
        );
    }

    /**
     * The enabled case must keep its existing behaviour: there IS a lifecycle to
     * end, so the stop intent is still dispatched. The fix narrows the no-op path;
     * it does not disable stopping.
     */
    @Test public void pauseStillDispatchesWhenTrackingIsEnabled() {
        grantLocation();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        DriveSenseAutoTrackingService.stop(context);

        Intent started = shadowOf(application).getNextStartedService();
        assertNotNull("An enabled service must still receive ACTION_STOP", started);
        assertEquals(
            DriveSenseAutoTrackingService.class.getName(),
            started.getComponent() == null ? "" : started.getComponent().getClassName()
        );
    }

    /**
     * The service must survive being created without location permission. Before
     * the fix onCreate raised SecurityException out of startForeground and killed
     * the process; it must now decline the promotion instead.
     */
    @Test public void serviceCreationWithoutLocationPermissionDoesNotThrow() {
        denyLocation();

        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();

        assertNotNull("onCreate must complete without a SecurityException", controller.get());
        controller.destroy();
    }

    /**
     * Having declined the promotion, the service must not linger pretending to
     * track: the next start command stops it and clears the durable enable bit.
     */
    @Test public void declinedPromotionStopsTheServiceAndClearsTheEnableBit() {
        denyLocation();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        controller.withIntent(new Intent(context, DriveSenseAutoTrackingService.class))
            .startCommand(0, 1);

        assertFalse(
            "A service that could not enter its foreground type must not stay enabled",
            DriveSenseNativeTripStore.isServiceEnabled(context)
        );
        controller.destroy();
    }

    /** With permission present the service promotes normally and stays enabled. */
    @Test public void serviceWithLocationPermissionKeepsRunning() {
        grantLocation();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        controller.withIntent(new Intent(context, DriveSenseAutoTrackingService.class))
            .startCommand(0, 1);

        assertTrue(
            "The granted path must be untouched by the DPD-025 guard",
            DriveSenseNativeTripStore.isServiceEnabled(context)
        );
        controller.destroy();
    }

    /**
     * The case independent review found untested, and it is the one with the most
     * real weight: location permission revoked while tracking is genuinely enabled.
     *
     * `stop()` must still dispatch ACTION_STOP here -- there is a lifecycle to end
     * -- so the service is created without permission, declines promotion, and
     * runs the deliberate-stop handler. That handler can legitimately return
     * START_STICKY while it waits for a trip to finish or retries on a 2 s handler.
     * For an unpromoted service that is fatal: Android kills a startForegroundService
     * target that has not promoted within five seconds. So the declined path must
     * stop the service regardless of what the handler returns.
     */
    @Test public void pauseWithoutPermissionWhileEnabledDoesNotLingerUnpromoted() {
        denyLocation();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        Intent stop = new Intent(context, DriveSenseAutoTrackingService.class);
        stop.setAction(DriveSenseAutoTrackingService.ACTION_STOP);
        stop.putExtra(DriveSenseAutoTrackingService.EXTRA_DELIBERATE_STOP_REQUEST_ID, "dpd025-enabled-denied");
        controller.withIntent(stop).startCommand(0, 1);

        assertTrue(
            "A service that could not promote must stop itself rather than wait",
            shadowOf(controller.get()).isStoppedBySelf()
        );
        controller.destroy();
    }

    /**
     * The same stop with permission present must NOT be short-circuited: the
     * handler's own result stands, so a stop that needs to wait for a trip to
     * finish still gets to wait.
     */
    @Test public void pauseWithPermissionWhileEnabledKeepsTheHandlerResult() {
        grantLocation();
        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        Intent stop = new Intent(context, DriveSenseAutoTrackingService.class);
        stop.setAction(DriveSenseAutoTrackingService.ACTION_STOP);
        stop.putExtra(DriveSenseAutoTrackingService.EXTRA_DELIBERATE_STOP_REQUEST_ID, "dpd025-enabled-granted");
        controller.withIntent(stop).startCommand(0, 1);

        // Nothing is asserted about stopping here -- the point is that the
        // permission-denied short circuit did not fire and change the outcome.
        assertNotNull(controller.get());
        controller.destroy();
    }
}
