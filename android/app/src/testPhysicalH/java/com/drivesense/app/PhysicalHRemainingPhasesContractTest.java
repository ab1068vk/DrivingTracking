package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class PhysicalHRemainingPhasesContractTest {
    @Test public void allRemainingScenariosAreExactAndTheSingleEntryIsGuarded() {
        assertEquals(29, PhysicalHRemainingPhases.SCENARIOS.size());
        assertTrue(PhysicalHDriver.isDestructiveCase("remainingPhaseControl"));
        assertFalse(PhysicalHDriver.isDestructiveCase("readOnlyInstallationInventory"));
        for (String scenario : PhysicalHRemainingPhases.SCENARIOS) {
            assertTrue(scenario, scenario.matches("PH(5|6|7|8|9|10|11)_[A-Z0-9_]+"));
        }
    }

    @Test public void emptyGenerationAndErasureAreExplicitNotClearDataShortcuts() throws Exception {
        String source = source("src/physicalH/java/com/drivesense/app/PhysicalHRemainingPhases.java");
        assertTrue(source.contains("rolloverGenerationForIdentityErasure"));
        assertTrue(source.contains("rolloverGeneration(\"physical_h_empty_generation\")"));
        assertTrue(source.contains("PH11_ERASURE_TRIPS"));
        assertTrue(source.contains("PH11_POST_ERASURE_VERIFY"));
        assertFalse(source.contains("pm clear"));
        assertFalse(source.contains("deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME)"));
    }

    @Test public void legacyTargetGuardReadsTheAppUnderTestNotItsOwnInlinedFlavorConstants() throws Exception {
        // PH-10 step 3 refused with PHYSICAL_H_LEGACY_TARGET_REFUSED even though the legacy APK
        // was correctly installed: BuildConfig's booleans are Java compile-time constants, so
        // referencing them inside androidTestPhysicalH inlined the physicalH flavor's
        // PHYSICAL_H_LEGACY_BUILD=false and the guard could never pass. One instrumentation APK
        // serves both flavors, so the flags must come from the app actually under test.
        String source = source("src/androidTestPhysicalH/java/com/drivesense/app/PhysicalHLegacyUpgradeInstrumentation.java");
        assertFalse("the guard must not read its own inlined flavor constants",
            source.contains("BuildConfig.PHYSICAL_H_LEGACY_BUILD")
                || source.contains("BuildConfig.PHYSICAL_H_BUILD")
                || source.contains("BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS"));
        assertTrue(source.contains("context.getClassLoader().loadClass(\"com.drivesense.app.BuildConfig\")"));
        assertTrue(source.contains("getField(\"PHYSICAL_H_LEGACY_BUILD\").getBoolean(null)"));
        assertTrue(source.contains("getField(\"PHYSICAL_H_BUILD\").getBoolean(null)"));
        assertTrue(source.contains("getField(\"PHYSICAL_H_APPROVED_ANDROID_IDS\")"));
        // The independent cross-check on the installed package, and the one-ID allowlist, stay.
        assertTrue(source.contains("endsWith(\"-physical-h-legacy\")"));
        assertTrue(source.contains("PHYSICAL_H_LEGACY_IDENTITY_REFUSED"));
        assertTrue(source.contains("entries.length != 1"));
    }

    @Test public void lowStorageUsesRealObservationAndInflatedEstimateWithoutFiller() throws Exception {
        String source = source("src/physicalH/java/com/drivesense/app/PhysicalHRemainingPhases.java");
        assertTrue(source.contains("DriveSenseStorageAdmission.availableBytes(context)"));
        assertTrue(source.contains("requireAdmissionForPhysicalHarness"));
        assertFalse(source.contains("setAvailableBytesForTests"));
        assertFalse(source.contains("filler"));
    }

    @Test public void keystoreDeletionRequiresExactManifestFingerprintAndBackup() throws Exception {
        String source = source("src/physicalH/java/com/drivesense/app/PhysicalHRemainingPhases.java");
        String envelopeSource = source("src/main/java/com/drivesense/app/DriveSenseEnvelopeCrypto.java");
        assertTrue(source.contains("PHYSICAL_H_VERIFIED_BACKUP_REQUIRED"));
        assertTrue(source.contains("PHYSICAL_H_ALIAS_MANIFEST_MISMATCH"));
        assertTrue(source.contains("ENVELOPE_ALIAS_PREFIX = \"roadsage_archive_kek_v\""));
        assertTrue(envelopeSource.contains("ALIAS_PREFIX = \"roadsage_archive_kek_v\""));
        assertFalse(source.contains("roadsage_native_archive_kek_v"));
        assertTrue(source.contains("store.deleteEntry(alias)"));
        assertFalse(source.contains("aliases()"));
        assertTrue(source.contains("awaitPortableOperation"));
        assertTrue(source.contains("recoverVerifiedBackup(manager, marker)"));
        assertTrue(source.contains("PH7_KEY_LOSS_VERIFY"));
        assertTrue(source.contains("TYPED_MISSING_KEK_RECOVERY_REQUIRED"));
        assertTrue(source.contains("Archive KEK version is unavailable"));
    }

    @Test public void physicalReceiptsStayBoundedAndScalar() {
        JSONObject receipt = new PhysicalHReceipt("remainingPhaseControl", "PASS")
            .put("scenario", "PH9_SCALE_MEASURE")
            .put("canonicalCount", 10_000L)
            .put("speedBucketCount", 10_000L)
            .put("heapAfterBytes", 123456L)
            .put("pssAfterKb", 65432L)
            .put("mutatesState", false).json();
        assertTrue(receipt.toString().getBytes(StandardCharsets.UTF_8).length < PhysicalHReceipt.MAX_RECEIPT_BYTES);
        assertFalse(receipt.toString().contains("route_points"));
    }

    @Test public void instrumentationExposesOneGuardedRemainingPhaseSurface() throws Exception {
        String source = source("src/androidTestPhysicalH/java/com/drivesense/app/physicalh/PhysicalHInstrumentation.java");
        assertTrue(source.contains("void remainingPhaseControl()"));
        assertTrue(source.contains("PhysicalHDriver.execute"));
        assertTrue(source.contains("PH5_PROJECTION_PREPARE"));
        assertTrue(source.contains("indexedDB.deleteDatabase('drivesense_mobile')"));
        assertTrue(source.contains("PHYSICAL_H_IDB_DELETE_COMPLETE"));
        assertTrue(source.contains("window.__physicalHIdbDeleteResult"));
        assertTrue(source.contains("AtomicReference<String> deletionResult"));
        assertTrue(source.contains("PH10_UPGRADE_MIGRATE_PREPARE"));
        assertTrue(source.contains("beginMigrationTrip"));
        assertTrue(source.contains("executeLegacySpeedMigration"));
        assertTrue(source.contains("PHYSICAL_H_UPGRADE_MIGRATED"));
        assertTrue(source.contains("selfTerminateAfterReceipt"));
        assertTrue(source.contains("android.os.Process.killProcess(android.os.Process.myPid())"));
        assertTrue(source.contains("PH11_ERASURE_COMPLETE"));
        assertTrue(source.contains("projectionDeleted"));
    }

    @Test public void legacyUpgradeSeederIsInstrumentationOnlyAndIndependentlyGuarded() throws Exception {
        String source = source("src/androidTestPhysicalH/java/com/drivesense/app/PhysicalHLegacyUpgradeInstrumentation.java");
        // The legacy-build flag is still required, but it must be read off the app under test.
        // Referencing BuildConfig directly inlined this source set's physicalH constant and made
        // the guard unsatisfiable - see legacyTargetGuardReadsTheAppUnderTestNotItsOwnInlinedFlavorConstants.
        assertTrue(source.contains("getField(\"PHYSICAL_H_LEGACY_BUILD\").getBoolean(null)"));
        assertTrue(source.contains("Settings.Secure.ANDROID_ID"));
        assertTrue(source.contains("PHYSICAL_H_APPROVED_ANDROID_IDS"));
        assertTrue(source.contains("seedLegacyUpgradeFixtures"));
        assertTrue(source.contains("open('drivesense_mobile',3"));
        String legacyGuard = source("src/physicalHLegacy/java/com/drivesense/app/PhysicalHDestructiveGuard.java");
        assertTrue(legacyGuard.contains("PHYSICAL_H_LEGACY_DRIVER_UNAVAILABLE"));
    }

    @Test public void numericArgumentsAreParsedFromStringExtrasNotSilentlyDefaulted() throws Exception {
        // `am instrument -e key value` delivers every extra as a String. Bundle.getInt/getLong would
        // return the default instead, silently running a different case than the operator requested.
        for (String path : new String[] {
            "src/physicalH/java/com/drivesense/app/PhysicalHRemainingPhases.java",
            "src/physicalH/java/com/drivesense/app/PhysicalHDriver.java"
        }) {
            String source = source(path);
            assertFalse(path, source.contains("arguments.getInt(\""));
            assertFalse(path, source.contains("arguments.getLong(\""));
            assertFalse(path, source.contains("args.getInt(\""));
            assertFalse(path, source.contains("args.getLong(\""));
        }
        String phases = source("src/physicalH/java/com/drivesense/app/PhysicalHRemainingPhases.java");
        assertTrue(phases.contains("int cells = argInt(arguments, \"cells\", 64);"));
        assertTrue(phases.contains("Long.parseLong(String.valueOf(arguments.get(key)).trim())"));
        assertTrue(phases.contains("PHYSICAL_H_ARGUMENT_NOT_NUMERIC"));
        String driver = source("src/physicalH/java/com/drivesense/app/PhysicalHDriver.java");
        assertTrue(driver.contains("longValue(arguments, \"stopStartPoint\", -1L)"));
        assertTrue(driver.contains("nonNegative(arguments, \"stopPointCount\", 0L)"));
    }

    private static String source(String path) throws Exception {
        return new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8);
    }
}
