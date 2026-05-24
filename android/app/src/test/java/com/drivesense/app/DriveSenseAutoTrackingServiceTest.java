package com.drivesense.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.TimeZone;

import org.junit.Test;

public class DriveSenseAutoTrackingServiceTest {

    @Test
    public void nightDrivingUsesDeviceLocalTimeAcrossMidnight() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"));
            ZoneId deviceZone = ZoneId.systemDefault();

            long localEvening = LocalDateTime.of(2026, 1, 1, 23, 0)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long beforeLocalEnd = LocalDateTime.of(2026, 1, 2, 4, 59)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();
            long atLocalEnd = LocalDateTime.of(2026, 1, 2, 5, 0)
                .atZone(deviceZone)
                .toInstant()
                .toEpochMilli();

            assertTrue(DriveSenseAutoTrackingService.isNightDrivingEpochMs(localEvening));
            assertTrue(DriveSenseAutoTrackingService.isNightDrivingEpochMs(beforeLocalEnd));
            assertFalse(DriveSenseAutoTrackingService.isNightDrivingEpochMs(atLocalEnd));
        } finally {
            TimeZone.setDefault(original);
        }
    }
}
