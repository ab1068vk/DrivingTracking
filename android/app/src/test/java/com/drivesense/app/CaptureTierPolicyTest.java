package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.os.PowerManager;

import org.junit.Test;

public class CaptureTierPolicyTest {

    private static CaptureTierPolicy.Decision decide(int battery, boolean charging, int thermal) {
        return CaptureTierPolicy.decide(battery, charging, thermal, true);
    }

    @Test
    public void ordinaryDrivingStaysBitIdenticalToTodaysBehaviour() {
        CaptureTierPolicy.Decision decision = decide(80, false, PowerManager.THERMAL_STATUS_NONE);

        assertEquals(CaptureTierPolicy.TIER_NORMAL, decision.tier);
        assertEquals(CaptureTierPolicy.NORMAL_LOCATION_INTERVAL_MS, decision.locationIntervalMs);
        assertEquals(CaptureTierPolicy.NORMAL_MIN_UPDATE_INTERVAL_MS, decision.minUpdateIntervalMs);
        assertEquals(CaptureTierPolicy.NORMAL_MOTION_INTERVAL_MS, decision.motionSampleMinIntervalMs);
        assertFalse(decision.isThrottled());
    }

    /**
     * The invariant the whole design rests on: no input combination may produce a
     * shorter interval than NORMAL. Without this, adaptive sampling could silently
     * make the default path different from today.
     */
    @Test
    public void noInputCombinationEverSamplesFasterThanNormal() {
        int[] thermalStates = {
            PowerManager.THERMAL_STATUS_NONE,
            PowerManager.THERMAL_STATUS_LIGHT,
            PowerManager.THERMAL_STATUS_MODERATE,
            PowerManager.THERMAL_STATUS_SEVERE,
            PowerManager.THERMAL_STATUS_CRITICAL,
            PowerManager.THERMAL_STATUS_EMERGENCY,
            PowerManager.THERMAL_STATUS_SHUTDOWN,
        };
        for (int battery = -1; battery <= 100; battery++) {
            for (boolean charging : new boolean[] { true, false }) {
                for (int thermal : thermalStates) {
                    for (boolean adaptive : new boolean[] { true, false }) {
                        CaptureTierPolicy.Decision decision =
                            CaptureTierPolicy.decide(battery, charging, thermal, adaptive);
                        String context = "battery=" + battery + " charging=" + charging + " thermal=" + thermal;
                        assertTrue(
                            "location interval regressed below NORMAL for " + context,
                            decision.locationIntervalMs >= CaptureTierPolicy.NORMAL_LOCATION_INTERVAL_MS
                        );
                        assertTrue(
                            "min update interval regressed below NORMAL for " + context,
                            decision.minUpdateIntervalMs >= CaptureTierPolicy.NORMAL_MIN_UPDATE_INTERVAL_MS
                        );
                        assertTrue(
                            "motion interval regressed below NORMAL for " + context,
                            decision.motionSampleMinIntervalMs == 0L
                                || decision.motionSampleMinIntervalMs >= CaptureTierPolicy.NORMAL_MOTION_INTERVAL_MS
                        );
                    }
                }
            }
        }
    }

    @Test
    public void theKillSwitchPinsEveryInputToNormal() {
        int[] thermalStates = {
            PowerManager.THERMAL_STATUS_NONE,
            PowerManager.THERMAL_STATUS_MODERATE,
            PowerManager.THERMAL_STATUS_SEVERE,
        };
        for (int battery = 0; battery <= 100; battery += 5) {
            for (int thermal : thermalStates) {
                CaptureTierPolicy.Decision decision =
                    CaptureTierPolicy.decide(battery, false, thermal, false);
                assertEquals(CaptureTierPolicy.TIER_NORMAL, decision.tier);
                assertFalse(decision.isThrottled());
            }
        }
    }

    @Test
    public void heatThinsMotionSamplingButNeverGps() {
        CaptureTierPolicy.Decision decision = decide(90, true, PowerManager.THERMAL_STATUS_MODERATE);

        assertEquals(CaptureTierPolicy.TIER_THERMAL_GUARD, decision.tier);
        // Heat is dominated by CPU and radio; dropping GPS is what breaks the product.
        assertEquals(CaptureTierPolicy.NORMAL_LOCATION_INTERVAL_MS, decision.locationIntervalMs);
        assertEquals(CaptureTierPolicy.NORMAL_MIN_UPDATE_INTERVAL_MS, decision.minUpdateIntervalMs);
        assertTrue(decision.motionSampleMinIntervalMs > CaptureTierPolicy.NORMAL_MOTION_INTERVAL_MS);
        assertFalse(decision.motionSuspended());
    }

    @Test
    public void lowBatteryOnlyGuardsWhenNotCharging() {
        assertEquals(
            CaptureTierPolicy.TIER_BATTERY_GUARD,
            decide(12, false, PowerManager.THERMAL_STATUS_NONE).tier
        );
        assertEquals(
            CaptureTierPolicy.TIER_NORMAL,
            decide(12, true, PowerManager.THERMAL_STATUS_NONE).tier
        );
    }

    @Test
    public void neverDegradesAboveTheBatteryGuardThreshold() {
        assertEquals(
            CaptureTierPolicy.TIER_NORMAL,
            decide(CaptureTierPolicy.BATTERY_GUARD_PERCENT + 1, false, PowerManager.THERMAL_STATUS_NONE).tier
        );
        assertEquals(
            CaptureTierPolicy.TIER_BATTERY_GUARD,
            decide(CaptureTierPolicy.BATTERY_GUARD_PERCENT, false, PowerManager.THERMAL_STATUS_NONE).tier
        );
    }

    @Test
    public void neverDegradesBelowModerateHeat() {
        assertEquals(
            CaptureTierPolicy.TIER_NORMAL,
            decide(90, false, PowerManager.THERMAL_STATUS_LIGHT).tier
        );
    }

    @Test
    public void criticalStateSuspendsMotionAndCoarsensGps() {
        CaptureTierPolicy.Decision flat = decide(3, false, PowerManager.THERMAL_STATUS_NONE);
        CaptureTierPolicy.Decision hot = decide(90, true, PowerManager.THERMAL_STATUS_SEVERE);

        for (CaptureTierPolicy.Decision decision : new CaptureTierPolicy.Decision[] { flat, hot }) {
            assertEquals(CaptureTierPolicy.TIER_CRITICAL, decision.tier);
            assertTrue(decision.motionSuspended());
            assertTrue(decision.locationIntervalMs > CaptureTierPolicy.NORMAL_LOCATION_INTERVAL_MS);
            // The trip must still record: coarse GPS beats a lost drive.
            assertTrue(decision.locationIntervalMs < 60_000L);
        }
    }

    @Test
    public void criticalOutranksBatteryGuard() {
        assertEquals(
            CaptureTierPolicy.TIER_CRITICAL,
            decide(CaptureTierPolicy.CRITICAL_BATTERY_PERCENT, false, PowerManager.THERMAL_STATUS_NONE).tier
        );
    }

    @Test
    public void tiersDegradeMonotonicallyAsPressureRises() {
        long normal = decide(90, false, PowerManager.THERMAL_STATUS_NONE).locationIntervalMs;
        long thermal = decide(90, false, PowerManager.THERMAL_STATUS_MODERATE).locationIntervalMs;
        long battery = decide(12, false, PowerManager.THERMAL_STATUS_NONE).locationIntervalMs;
        long critical = decide(3, false, PowerManager.THERMAL_STATUS_NONE).locationIntervalMs;

        assertTrue(thermal >= normal);
        assertTrue(battery > normal);
        assertTrue(critical > battery);
    }

    @Test
    public void unknownBatteryLevelIsNotTreatedAsEmpty() {
        // A -1 reading means "unavailable", not "flat". Guarding on it would
        // degrade every trip on a device that fails to report battery level.
        assertEquals(
            CaptureTierPolicy.TIER_NORMAL,
            decide(-1, false, PowerManager.THERMAL_STATUS_NONE).tier
        );
    }

    @Test
    public void everyDecisionCarriesAReportableReason() {
        CaptureTierPolicy.Decision[] decisions = {
            decide(90, false, PowerManager.THERMAL_STATUS_NONE),
            decide(90, false, PowerManager.THERMAL_STATUS_MODERATE),
            decide(12, false, PowerManager.THERMAL_STATUS_NONE),
            decide(3, false, PowerManager.THERMAL_STATUS_NONE),
            CaptureTierPolicy.decide(3, false, PowerManager.THERMAL_STATUS_SEVERE, false),
        };
        for (CaptureTierPolicy.Decision decision : decisions) {
            assertTrue(decision.reason != null && !decision.reason.isEmpty());
            assertTrue(decision.label != null && !decision.label.isEmpty());
            assertTrue(decision.tier != null && !decision.tier.isEmpty());
        }
    }
}
