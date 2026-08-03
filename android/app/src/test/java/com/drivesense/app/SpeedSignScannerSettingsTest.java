package com.drivesense.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SpeedSignScannerSettingsTest {
    @Test
    public void scannerAndMountedModeDefaultOff() {
        assertFalse(SpeedSignScannerSettings.readBooleanFromJson(
            "{}",
            "speed_sign_scanner_enabled",
            false
        ));
        assertFalse(SpeedSignScannerSettings.readBooleanFromJson(
            null,
            "speed_sign_mounted_mode_enabled",
            false
        ));
    }

    @Test
    public void mountedModeRequiresAnExplicitStoredChoice() {
        String settings = "{" +
            "\"speed_sign_scanner_enabled\":true," +
            "\"speed_sign_mounted_mode_enabled\":true" +
            "}";
        assertTrue(SpeedSignScannerSettings.readBooleanFromJson(
            settings,
            "speed_sign_scanner_enabled",
            false
        ));
        assertTrue(SpeedSignScannerSettings.readBooleanFromJson(
            settings,
            "speed_sign_mounted_mode_enabled",
            false
        ));
    }

    @Test
    public void malformedSettingsFailClosed() {
        assertFalse(SpeedSignScannerSettings.readBooleanFromJson(
            "{not-json",
            "speed_sign_mounted_mode_enabled",
            false
        ));
    }

    @Test
    public void nativeNotificationSessionStopsWhenNativeTripEnds() {
        assertTrue(SpeedSignScannerSettings.isTripSessionActive(true, true, "native-trip"));
        assertFalse(SpeedSignScannerSettings.isTripSessionActive(false, true, "native-trip"));
        assertTrue(SpeedSignScannerSettings.isTripSessionActive(false, false, "in-app-trip"));
        assertFalse(SpeedSignScannerSettings.isTripSessionActive(false, false, ""));
    }

    @Test
    public void armedScannerStartsOnlyForConfirmedAutomaticRecording() {
        assertTrue(SpeedSignScannerSettings.shouldStartArmedScanner(
            true,
            false,
            false,
            "recording"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartArmedScanner(
            true,
            true,
            false,
            "recording"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartArmedScanner(
            true,
            false,
            true,
            "recording"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartArmedScanner(
            false,
            false,
            false,
            "recording"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartArmedScanner(
            true,
            false,
            false,
            "candidate"
        ));
    }

    @Test
    public void preparedManualScannerKeepsPollingUntilTheNativeTripIsReady() {
        assertTrue(SpeedSignScannerSettings.shouldKeepWaitingForPreparedTrip(true, false));
        assertTrue(SpeedSignScannerSettings.shouldKeepWaitingForPreparedTrip(false, true));
        assertFalse(SpeedSignScannerSettings.shouldKeepWaitingForPreparedTrip(false, false));
    }

    @Test
    public void preparedManualScannerRequiresTheExactConfirmedManualTrip() {
        assertTrue(SpeedSignScannerSettings.shouldStartPreparedManualScanner(
            true,
            false,
            true,
            "recording",
            "manual-trip-1",
            "manual-trip-1"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartPreparedManualScanner(
            true,
            false,
            false,
            "recording",
            "manual-trip-1",
            "manual-trip-1"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartPreparedManualScanner(
            true,
            true,
            true,
            "recording",
            "manual-trip-1",
            "manual-trip-1"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartPreparedManualScanner(
            true,
            false,
            true,
            "recording",
            "another-trip",
            "manual-trip-1"
        ));
        assertFalse(SpeedSignScannerSettings.shouldStartPreparedManualScanner(
            true,
            false,
            true,
            "recording",
            "manual-trip-1",
            ""
        ));
    }
}
