package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class AppExperienceWatchdogTest {
    @Test
    public void reportsOnlyForegroundStallsPastThreshold() {
        assertFalse(AppExperienceWatchdog.shouldReportStall(false, 20_000L, false));
        assertFalse(AppExperienceWatchdog.shouldReportStall(true, 4_999L, false));
        assertFalse(AppExperienceWatchdog.shouldReportStall(true, 8_000L, true));
        assertTrue(AppExperienceWatchdog.shouldReportStall(true, 5_000L, false));
    }

    @Test
    public void mapsAndroidExitReasonsWithoutDescriptionsOrTraces() {
        assertEquals("low_memory", AppExperienceWatchdog.exitReasonLabel(3));
        assertEquals("crash", AppExperienceWatchdog.exitReasonLabel(4));
        assertEquals("native_crash", AppExperienceWatchdog.exitReasonLabel(5));
        assertEquals("anr", AppExperienceWatchdog.exitReasonLabel(6));
        assertEquals("excessive_resource_usage", AppExperienceWatchdog.exitReasonLabel(9));
        assertEquals("user_requested", AppExperienceWatchdog.exitReasonLabel(10));
        assertEquals("unknown", AppExperienceWatchdog.exitReasonLabel(999));
    }

    @Test
    public void checkpointSanitizesOperationAndAnonymizesTripPath() throws Exception {
        JSONObject checkpoint = AppExperienceWatchdog.checkpointPayload(
            "trip load <secret>",
            "start",
            "/trips/private-trip-id/speed?token=secret",
            1_785_665_600_000L
        );

        assertEquals("trip_load__secret_", checkpoint.getString("operation"));
        assertEquals("start", checkpoint.getString("phase"));
        assertEquals("/trips/:id/speed", checkpoint.getString("pathname"));
        assertFalse(checkpoint.toString().contains("private-trip-id"));
        assertFalse(checkpoint.toString().contains("token"));
    }
}
