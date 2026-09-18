package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class PhysicalHLegacyBuildTest {
    @Test public void legacyFixtureUsesIsolatedUpgradeIdentity() {
        assertEquals("com.drivesense.app.p35h", BuildConfig.APPLICATION_ID);
        assertTrue(BuildConfig.PHYSICAL_H_BUILD);
        assertTrue(BuildConfig.PHYSICAL_H_LEGACY_BUILD);
        assertEquals(1, BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS.split("[,;\\r\\n]+").length);
        try {
            PhysicalHDestructiveGuard.requireUnavailable(null);
            fail("legacy destructive driver became available");
        } catch (SecurityException expected) {
            assertEquals("PHYSICAL_H_LEGACY_DRIVER_UNAVAILABLE", expected.getMessage());
        }
    }
}
