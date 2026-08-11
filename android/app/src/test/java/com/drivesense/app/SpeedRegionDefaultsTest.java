package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The table itself is checked against the JavaScript one by
 * src/lib/__tests__/nativeSpeedRegionParity.test.js. These cover the lookup
 * rules around it, which that test cannot see.
 */
public class SpeedRegionDefaultsTest {

    private static final double DELTA = 0.0001d;

    @Test
    public void unsetAndGlobalRegionsBothResolveToGlobal() {
        assertEquals("GLOBAL", SpeedRegionDefaults.regionFromSetting(null)[0]);
        assertEquals("GLOBAL", SpeedRegionDefaults.regionFromSetting("")[0]);
        assertEquals("GLOBAL", SpeedRegionDefaults.regionFromSetting("global")[0]);
        assertNull(SpeedRegionDefaults.regionFromSetting("global")[1]);
    }

    @Test
    public void provinceIsSplitOffAndUppercased() {
        String[] region = SpeedRegionDefaults.regionFromSetting("ca-on");
        assertEquals("CA", region[0]);
        assertEquals("ON", region[1]);
    }

    @Test
    public void provinceOverridesTheCountryRow() {
        assertEquals(80d, SpeedRegionDefaults.estimateKmh("CA", "BC", "rural"), DELTA);
        assertEquals(100d, SpeedRegionDefaults.estimateKmh("CA", "AB", "rural"), DELTA);
    }

    @Test
    public void unknownProvinceFallsBackToTheCountryRow() {
        assertEquals(80d, SpeedRegionDefaults.estimateKmh("CA", "ZZ", "rural"), DELTA);
    }

    @Test
    public void unknownCountryFallsBackToTheGlobalTable() {
        assertEquals(50d, SpeedRegionDefaults.estimateKmh("ZZ", null, "urban"), DELTA);
    }

    @Test
    public void aRegionWithNoPublishedLimitResolvesToNothing() {
        // German motorways. NaN here rather than a number is what stops the
        // service inventing a limit for a road that legally has none.
        assertTrue(Double.isNaN(SpeedRegionDefaults.estimateKmh("DE", null, "highway")));
    }

    @Test
    public void highwayFallsBackToAMotorwayEntry() {
        assertEquals(112d, SpeedRegionDefaults.estimateKmh("GB", null, "highway"), DELTA);
    }

    @Test
    public void unknownRoadContextResolvesToNothing() {
        assertTrue(Double.isNaN(SpeedRegionDefaults.estimateKmh("CA", "ON", "towpath")));
        assertTrue(Double.isNaN(SpeedRegionDefaults.estimateKmh("CA", "ON", null)));
    }

    @Test
    public void slowRecentDrivingResolvesToAnUrbanLimit() {
        // The bug this exists for: 100 km/h was assumed on a residential street.
        assertEquals(50d, SpeedRegionDefaults.fallbackLimitKmh("global", 42d, 100d), DELTA);
        assertEquals(56d, SpeedRegionDefaults.fallbackLimitKmh("US-NY", 42d, 100d), DELTA);
    }

    @Test
    public void motorwaySpeedsResolveToAMotorwayLimit() {
        assertEquals(100d, SpeedRegionDefaults.fallbackLimitKmh("global", 115d, 100d), DELTA);
        assertEquals(110d, SpeedRegionDefaults.fallbackLimitKmh("AU-VIC", 115d, 100d), DELTA);
    }

    @Test
    public void onlyTheGlobalTableIsClampedByTheSpeedingThreshold() {
        // A driver who named their region asked for that region's numbers.
        assertEquals(80d, SpeedRegionDefaults.fallbackLimitKmh("global", 115d, 80d), DELTA);
        assertEquals(110d, SpeedRegionDefaults.fallbackLimitKmh("AU-VIC", 115d, 80d), DELTA);
    }

    @Test
    public void noRecentSpeedsMeansNoEstimate() {
        assertTrue(Double.isNaN(SpeedRegionDefaults.fallbackLimitKmh("global", Double.NaN, 100d)));
        assertTrue(Double.isNaN(SpeedRegionDefaults.fallbackLimitKmh("global", 0d, 100d)));
    }

    @Test
    public void percentileInterpolatesBetweenSamples() {
        assertEquals(0d, SpeedRegionDefaults.percentileFromSorted(new double[0], 85d), DELTA);
        assertEquals(7d, SpeedRegionDefaults.percentileFromSorted(new double[] { 7d }, 85d), DELTA);
        assertEquals(9.5d, SpeedRegionDefaults.percentileFromSorted(new double[] { 0d, 10d }, 95d), DELTA);
    }

    @Test
    public void estimateConfidencesStayBelowTheAlertFloor() {
        assertTrue(SpeedRegionDefaults.REGION_DEFAULT_CONFIDENCE < DetectionConstants.SPEED_ALERT_MIN_CONFIDENCE);
        assertTrue(SpeedRegionDefaults.GPS_INFERRED_CONFIDENCE < DetectionConstants.SPEED_ALERT_MIN_CONFIDENCE);
    }
}
