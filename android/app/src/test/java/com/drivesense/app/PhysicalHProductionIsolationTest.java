package com.drivesense.app;

import static org.junit.Assert.fail;

import org.junit.Test;

public final class PhysicalHProductionIsolationTest {
    @Test public void physicalHReachabilityMatchesTheSelectedVariant() throws Exception {
        if ("com.drivesense.app".equals(BuildConfig.APPLICATION_ID)) {
            for (java.lang.reflect.Field field : BuildConfig.class.getDeclaredFields()) {
                if (field.getName().startsWith("PHYSICAL_H")) {
                    fail("Production BuildConfig exposes Physical H field: " + field.getName());
                }
            }

            try {
                Class.forName("com.drivesense.app.PhysicalHDestructiveGuard");
                fail("Production source set exposes the Physical H destructive guard");
            } catch (ClassNotFoundException expected) {
                // Physical H guard code must remain variant-only.
            }
            try {
                Class.forName("com.drivesense.app.PhysicalHRemainingPhases");
                fail("Production source set exposes the remaining-phase Physical H controls");
            } catch (ClassNotFoundException expected) {
                // Every PH-5..PH-11 dispatcher remains variant-only.
            }
            return;
        }

        if (BuildConfig.APPLICATION_ID.endsWith(".p35h")) {
            BuildConfig.class.getDeclaredField("PHYSICAL_H_APPROVED_ANDROID_IDS");
            Class.forName("com.drivesense.app.PhysicalHDestructiveGuard");
            boolean legacy = BuildConfig.class.getDeclaredField("PHYSICAL_H_LEGACY_BUILD")
                .getBoolean(null);
            if (!legacy) {
                Class.forName("com.drivesense.app.PhysicalHRemainingPhases");
            } else {
                try {
                    Class.forName("com.drivesense.app.PhysicalHRemainingPhases");
                    fail("Legacy upgrade artifact exposes current Physical H controls");
                } catch (ClassNotFoundException expected) {
                    // Legacy destructive surface remains unavailable.
                }
            }
            return;
        }

        fail("Unexpected application ID for Physical H isolation test: " + BuildConfig.APPLICATION_ID);
    }
}
