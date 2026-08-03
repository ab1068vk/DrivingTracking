package com.drivesense.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.view.View;

import org.json.JSONObject;
import org.junit.Test;

public class WhereIParkedWidgetProviderTest {
    @Test
    public void checkingMovementIsNotConfirmedVehicleMovement() throws Exception {
        JSONObject status = new JSONObject()
            .put("active", true)
            .put("state", "candidate")
            .put("candidate", true);

        assertFalse(WhereIParkedWidgetProvider.isConfirmedVehicleMovement(status));
    }

    @Test
    public void confirmedRecordingIsVehicleMovement() throws Exception {
        JSONObject status = new JSONObject()
            .put("active", true)
            .put("state", "recording")
            .put("candidate", false);

        assertTrue(WhereIParkedWidgetProvider.isConfirmedVehicleMovement(status));
    }

    @Test
    public void inactiveStatusIsNotVehicleMovement() throws Exception {
        JSONObject status = new JSONObject()
            .put("active", false)
            .put("state", "recording");

        assertFalse(WhereIParkedWidgetProvider.isConfirmedVehicleMovement(status));
    }

    @Test
    public void newerRevisionWinsEvenWhenTimestampMatches() throws Exception {
        JSONObject older = new JSONObject()
            .put("status", "saved")
            .put("timestamp", "2026-07-29T12:00:00.000Z")
            .put("state_revision", 100L);
        JSONObject newerPrivate = new JSONObject()
            .put("status", "private")
            .put("timestamp", "2026-07-29T12:00:00.000Z")
            .put("state_revision", 101L);

        assertSame(
            newerPrivate,
            DriveSenseNativeTripStore.newerParkingRecord(older, newerPrivate)
        );
    }

    @Test
    public void compactWidgetKeepsAnActiveReminderVisible() {
        assertTrue(WhereIParkedWidgetProvider.compactReminderVisibility(true) == View.VISIBLE);
        assertTrue(WhereIParkedWidgetProvider.compactReminderVisibility(false) == View.GONE);
    }
}
