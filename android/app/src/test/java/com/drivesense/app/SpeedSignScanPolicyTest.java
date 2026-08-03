package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.os.PowerManager;

import org.junit.Test;

public class SpeedSignScanPolicyTest {
    @Test
    public void pausesBelowDrivingSpeed() {
        SpeedSignScanPolicy.Decision decision = SpeedSignScanPolicy.decide(
            80, false, PowerManager.THERMAL_STATUS_NONE, 8d, false, -1L
        );
        assertFalse(decision.analyze);
    }

    @Test
    public void scansUnknownRoadsMostFrequently() {
        SpeedSignScanPolicy.Decision unknown = SpeedSignScanPolicy.decide(
            80, false, PowerManager.THERMAL_STATUS_NONE, 55d, false, -1L
        );
        SpeedSignScanPolicy.Decision confirmed = SpeedSignScanPolicy.decide(
            80, false, PowerManager.THERMAL_STATUS_NONE, 55d, true, -1L
        );
        assertTrue(unknown.analyze);
        assertTrue(unknown.analysisIntervalMs < confirmed.analysisIntervalMs);
        assertEquals("Confirmed-road change watch", confirmed.label);
    }

    @Test
    public void protectsBatteryAndHeat() {
        assertEquals(2_500L, SpeedSignScanPolicy.decide(
            25, false, PowerManager.THERMAL_STATUS_NONE, 50d, false, -1L
        ).analysisIntervalMs);
        assertEquals(4_000L, SpeedSignScanPolicy.decide(
            80, true, PowerManager.THERMAL_STATUS_MODERATE, 50d, false, -1L
        ).analysisIntervalMs);
    }
}
