package com.drivesense.app;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

public class ParkingPhotoExpirySchedulerTest {
    @Test
    public void choosesTheEarliestValidPhotoDeadline() throws Exception {
        JSONObject deadlines = new JSONObject()
            .put("11111111-1111-1111-1111-111111111111", 5_000L)
            .put("22222222-2222-2222-2222-222222222222", 2_000L)
            .put("33333333-3333-3333-3333-333333333333", 0L);

        assertEquals(2_000L, ParkingPhotoExpiryScheduler.earliestDeadline(deadlines));
    }

    @Test
    public void noPhotoDeadlineDoesNotScheduleAnAlarm() {
        assertEquals(Long.MAX_VALUE, ParkingPhotoExpiryScheduler.earliestDeadline(new JSONObject()));
    }
}
