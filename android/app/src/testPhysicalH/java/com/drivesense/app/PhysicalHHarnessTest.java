package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ContentResolver;
import android.content.Context;
import android.content.ContextWrapper;
import android.os.Bundle;
import android.provider.Settings;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Set;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class PhysicalHHarnessTest {
    private static final String APPROVED_A54_ANDROID_ID_SHA256 =
        "a23a57c10a42359feff795eef0ac6e7f7fe74bd7a1cc0acec7d6726cb1c5c0ef";

    @After public void reset() {
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(false);
        DriveSenseStorageCoordinator.resetForTests();
    }

    @Test public void packageIsolationAndReleaseAuthorityRemainFrozen() throws Exception {
        assertEquals("com.drivesense.app.p35h", BuildConfig.APPLICATION_ID);
        assertTrue(BuildConfig.PHYSICAL_H_BUILD);
        assertFalse(BuildConfig.PHYSICAL_H_LEGACY_BUILD);
        Field released = DriveSenseP35Flags.class.getDeclaredField("NATIVE_AUTHORITY_RELEASED");
        released.setAccessible(true);
        assertFalse(released.getBoolean(null));
        assertFalse(DriveSenseP35Flags.testAuthorityEnabled());
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        assertTrue(DriveSenseP35Flags.testAuthorityEnabled());
        String gradle = new String(Files.readAllBytes(new File("build.gradle").toPath()), java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(gradle.contains("applicationId \"com.drivesense.app\""));
        assertTrue(gradle.contains("applicationIdSuffix \".p35h\""));
        assertTrue(gradle.contains("if (physicalHVariantsEnabled)"));
        assertTrue(gradle.contains("environment \"VITE_P35_NATIVE_AUTHORITY\", \"true\""));
        // PH-9 step 4b found the installed Physical H bundle compiled with the
        // authority flag OFF: Gradle does not treat Exec.environment as an
        // input, so a dist from a non-Physical-H build stayed up-to-date and
        // shipped. The flag must be a declared input of drivesenseBuildWeb.
        assertTrue(gradle.contains("inputs.property(\"physicalHVariants\", physicalHVariantsEnabled)"));
    }

    @Test public void boundedFileInventoryReportsOverflowInsteadOfSuppressingIntegrity() throws Exception {
        // PH-9 found that PH5_FILESYSTEM_INSPECT's bounded walk threw
        // PHYSICAL_H_FILESYSTEM_INVENTORY_LIMIT past 4,096 files, and because it
        // ran before the SQLite PRAGMAs the typed refusal also suppressed the
        // integrity reading at 20,000 trips. The walk must stay bounded but
        // report overflow as a marker.
        java.lang.reflect.Method inventory = PhysicalHRemainingPhases.class
            .getDeclaredMethod("boundedFileInventory", File.class, int.class);
        inventory.setAccessible(true);
        File root = Files.createTempDirectory("ph-inventory").toFile();
        for (int index = 0; index < 40; index++) {
            Files.write(new File(root, "f" + index).toPath(), new byte[] { 1, 2, 3 });
        }
        long[] under = (long[]) inventory.invoke(null, root, 4_096);
        assertEquals(3, under.length);
        assertEquals(40L, under[0]);
        assertEquals(120L, under[1]);
        assertEquals(0L, under[2]);
        long[] over = (long[]) inventory.invoke(null, root, 8);
        assertEquals(1L, over[2]);
        assertTrue("the walk must stop at the bound, never enumerate everything", over[0] <= 9L);
    }

    @Test public void portableOperationWaitIsAnExplicitBoundedArgumentNotAHardcoded120Seconds() throws Exception {
        // PH-10 step 2 refused a healthy 1.5 GB export with
        // PHYSICAL_H_PORTABLE_OPERATION_TIMEOUT because awaitPortableOperation hardcoded
        // 120,000 ms. The wait must be operator-supplied and capped, and it must still
        // fail closed on a value outside the reviewed range.
        java.lang.reflect.Method wait = PhysicalHRemainingPhases.class
            .getDeclaredMethod("portableWaitMs", Bundle.class);
        wait.setAccessible(true);

        assertEquals(120_000L, wait.invoke(null, new Object[] { null }));
        Bundle absent = new Bundle();
        assertEquals(120_000L, wait.invoke(null, absent));

        Bundle raised = new Bundle();
        raised.putString("operationTimeoutSeconds", "2700");
        assertEquals(2_700_000L, wait.invoke(null, raised));

        for (String rejected : new String[] { "119", "5401", "0", "-1" }) {
            Bundle invalid = new Bundle();
            invalid.putString("operationTimeoutSeconds", rejected);
            try {
                wait.invoke(null, invalid);
                fail("portableWaitMs must refuse " + rejected);
            } catch (java.lang.reflect.InvocationTargetException expected) {
                assertTrue(expected.getCause() instanceof IllegalArgumentException);
                assertEquals("PHYSICAL_H_PORTABLE_WAIT_RANGE_INVALID", expected.getCause().getMessage());
            }
        }

        Bundle malformed = new Bundle();
        malformed.putString("operationTimeoutSeconds", "soon");
        try {
            wait.invoke(null, malformed);
            fail("portableWaitMs must refuse a non-numeric bound");
        } catch (java.lang.reflect.InvocationTargetException expected) {
            assertTrue(expected.getCause() instanceof IllegalArgumentException);
            assertTrue(expected.getCause().getMessage().startsWith("PHYSICAL_H_ARGUMENT_NOT_NUMERIC"));
        }
    }

    @Test public void robolectricUsesDeterministicShortTempRoot() throws Exception {
        File actual = new File(System.getProperty("java.io.tmpdir")).getCanonicalFile();
        File filesystemRoot = new File("..").getCanonicalFile().toPath().getRoot().toFile();
        File expected = new File(filesystemRoot, "tmp/rs-robolectric").getCanonicalFile();
        assertEquals(expected, actual);
        assertEquals("rs-robolectric", actual.getName());
        assertTrue(actual.isDirectory());
    }

    @Test public void longTripIngestBudgetStaysInsideTheProductionWorkByteRange() {
        // DriveSenseTripArchiveRepository.ingestCompletedJournalLocked refuses maxWorkBytes
        // outside [1024, 32 MiB]. PH-9 streams routes far past 32 MiB, so the harness must
        // clamp instead of asking for the generated route size.
        assertEquals(32L * 1024L * 1024L, PhysicalHDriver.INGEST_WORK_BYTE_MAXIMUM);
        assertEquals(1024L, PhysicalHDriver.ingestWorkBytes(0L));
        assertEquals(3072L, PhysicalHDriver.ingestWorkBytes(2048L));
        assertEquals(PhysicalHDriver.INGEST_WORK_BYTE_MAXIMUM,
            PhysicalHDriver.ingestWorkBytes(PhysicalHDriver.INGEST_WORK_BYTE_MAXIMUM));
        for (long generated : Arrays.asList(0L, 1L, 2_170_107L, 54_251_000L, 1_200_000_000L, Long.MAX_VALUE - 2048L)) {
            long budget = PhysicalHDriver.ingestWorkBytes(generated);
            assertTrue("underflow for " + generated, budget >= 1024L);
            assertTrue("over cap for " + generated, budget <= PhysicalHDriver.INGEST_WORK_BYTE_MAXIMUM);
        }
    }

    @Test public void destructiveGuardRefusesEmptyAllowlist() {
        assertEquals("PHYSICAL_H_ANDROID_ID_ALLOWLIST_EMPTY",
            PhysicalHDestructiveGuard.evaluate("com.drivesense.app.p35h", "synthetic-android-id-1", "").code);
    }

    @Test public void destructiveGuardRefusesWrongPackage() {
        assertEquals("PHYSICAL_H_WRONG_PACKAGE",
            PhysicalHDestructiveGuard.evaluate(
                "com.example.not-physical-h",
                soleEmbeddedApprovedAndroidId(),
                BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS
            ).code);
    }

    @Test public void destructiveGuardRefusesUnavailableAndroidId() {
        assertEquals("PHYSICAL_H_ANDROID_ID_UNAVAILABLE",
            PhysicalHDestructiveGuard.evaluate(
                "com.drivesense.app.p35h", null, BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS).code);
        assertEquals("PHYSICAL_H_ANDROID_ID_UNAVAILABLE",
            PhysicalHDestructiveGuard.evaluate(
                "com.drivesense.app.p35h", "", BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS).code);

        Context base = ApplicationProvider.getApplicationContext();
        Context unreadable = new ContextWrapper(base) {
            @Override public ContentResolver getContentResolver() {
                throw new SecurityException("synthetic unreadable ANDROID_ID");
            }
        };
        assertEquals("", PhysicalHDestructiveGuard.readAndroidId(unreadable));
    }

    @Test public void destructiveGuardRefusesWrongAndroidId() {
        assertEquals("PHYSICAL_H_ANDROID_ID_NOT_APPROVED",
            PhysicalHDestructiveGuard.evaluate(
                "com.drivesense.app.p35h",
                "synthetic-different-android-id",
                BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS
            ).code);
    }

    @Test public void currentBuildEmbedsExactlyOneApprovedA54AndroidId() throws Exception {
        Set<String> embedded = PhysicalHDestructiveGuard.parseAllowlist(BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS);
        assertEquals(1, embedded.size());
        String approvedAndroidId = embedded.iterator().next();
        assertEquals(APPROVED_A54_ANDROID_ID_SHA256, sha256(approvedAndroidId));

        PhysicalHDestructiveGuard.Decision accepted =
            PhysicalHDestructiveGuard.evaluate(
                "com.drivesense.app.p35h",
                approvedAndroidId,
                BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS
            );
        assertTrue(accepted.allowed);
        assertEquals(approvedAndroidId, accepted.approvedAndroidId);
    }

    @Test public void destructiveGuardRefusesProductionPackage() {
        assertEquals("PHYSICAL_H_WRONG_PACKAGE",
            PhysicalHDestructiveGuard.evaluate(
                "com.drivesense.app",
                soleEmbeddedApprovedAndroidId(),
                BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS
            ).code);
    }

    @Test public void everyMutatingEntryUsesTheCommonGuard() {
        assertFalse(PhysicalHDriver.isDestructiveCase("readOnlyInstallationInventory"));
        for (String entry : PhysicalHDriver.ENTRY_POINTS) {
            if (!"readOnlyInstallationInventory".equals(entry)) assertTrue(entry, PhysicalHDriver.isDestructiveCase(entry));
        }
        Context context = ApplicationProvider.getApplicationContext();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ANDROID_ID, null);
        JSONObject refused = PhysicalHDriver.execute(context, "seedPhysicalHFixtures", new Bundle());
        assertEquals("SAFE_REFUSAL", refused.optString("status"));
        assertEquals("PHYSICAL_H_ANDROID_ID_UNAVAILABLE", refused.optString("guardCode"));
    }

    @Test public void allInstrumentationMethodsArePresentInDedicatedSource() throws Exception {
        File source = new File("src/androidTestPhysicalH/java/com/drivesense/app/physicalh/PhysicalHInstrumentation.java");
        assertTrue(source.isFile());
        String content = new String(Files.readAllBytes(source.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        for (String entry : PhysicalHDriver.ENTRY_POINTS) assertTrue(entry, content.contains("void " + entry + "()"));
        assertEquals(11, PhysicalHDriver.ENTRY_POINTS.length);
    }

    @Test public void readOnlyInventoryReportsExactAndroidIdWithoutMutation() {
        Context context = ApplicationProvider.getApplicationContext();
        File database = context.getDatabasePath(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        File preferences = new File(context.getApplicationInfo().dataDir, "shared_prefs");
        File archive = new File(context.getApplicationInfo().dataDir, "no_backup/roadsage_trip_archive_v1");
        assertFalse(database.exists());
        assertFalse(archive.exists());
        int preferencesBefore = preferences.isDirectory() && preferences.list() != null ? preferences.list().length : 0;
        String expectedAndroidId = "synthetic-inventory-android-id";
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ANDROID_ID, expectedAndroidId);
        JSONObject receipt = PhysicalHDriver.execute(context, "readOnlyInstallationInventory", new Bundle());
        assertEquals("READY", receipt.optString("status"));
        assertEquals(expectedAndroidId, receipt.optString("androidId"));
        assertTrue(receipt.optBoolean("androidIdAvailable"));
        assertFalse(receipt.optBoolean("mutatesState"));
        assertFalse(database.exists());
        assertFalse(archive.exists());
        int preferencesAfter = preferences.isDirectory() && preferences.list() != null ? preferences.list().length : 0;
        assertEquals(preferencesBefore, preferencesAfter);
        assertFalse(DriveSenseP35Flags.nativeAuthorityEnabled());
        assertFalse(DriveSenseAutoTrackingService.isRunning());
    }

    @Test public void readOnlyInventoryRepresentsUnavailableAndroidIdSafely() {
        Context context = ApplicationProvider.getApplicationContext();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ANDROID_ID, null);
        JSONObject receipt = PhysicalHDriver.execute(context, "readOnlyInstallationInventory", new Bundle());
        assertEquals("READY", receipt.optString("status"));
        assertEquals("", receipt.optString("androidId"));
        assertFalse(receipt.optBoolean("androidIdAvailable"));
        assertFalse(receipt.optBoolean("mutatesState"));
        assertFalse(DriveSenseP35Flags.nativeAuthorityEnabled());
        assertFalse(DriveSenseAutoTrackingService.isRunning());
    }

    @Test public void deterministicGeneratorIsIncrementalAndConstantResident() throws Exception {
        PhysicalHIncrementalRouteGenerator first = new PhysicalHIncrementalRouteGenerator(42L, 1_800_000_000_000L, 32);
        PhysicalHIncrementalRouteGenerator second = new PhysicalHIncrementalRouteGenerator(42L, 1_800_000_000_000L, 32);
        for (int index = 0; index < 10_000; index++) {
            first.appendNext(point -> true);
            second.appendNext(point -> true);
        }
        assertEquals(first.pointCount(), second.pointCount());
        assertEquals(first.generatedBytes(), second.generatedBytes());
        assertEquals(first.rollingHashHex(), second.rollingHashHex());
        assertEquals(1, PhysicalHIncrementalRouteGenerator.MAXIMUM_GENERATOR_RESIDENT_POINTS);
        for (Field field : PhysicalHIncrementalRouteGenerator.class.getDeclaredFields()) {
            Class<?> type = field.getType();
            assertFalse("generator retained a route collection: " + field, java.util.Collection.class.isAssignableFrom(type));
            if (type.isArray()) assertEquals("only the fixed rolling hash may be retained", "rollingHash", field.getName());
        }
    }

    @Test public void deterministicGeneratorCanEmitOneFiveMinuteParkedWindow() throws Exception {
        PhysicalHIncrementalRouteGenerator generator = new PhysicalHIncrementalRouteGenerator(
            42L, 1_800_000_000_000L, 0, 2L, 301L);
        JSONObject[] sampled = new JSONObject[3];
        for (int index = 0; index < 304; index++) {
            final int current = index;
            generator.appendNext(point -> {
                if (current == 2) sampled[0] = new JSONObject(point.toString());
                if (current == 302) sampled[1] = new JSONObject(point.toString());
                if (current == 303) sampled[2] = new JSONObject(point.toString());
                return true;
            });
        }
        assertEquals(sampled[0].getDouble("lat"), sampled[1].getDouble("lat"), 0d);
        assertEquals(sampled[0].getDouble("lng"), sampled[1].getDouble("lng"), 0d);
        assertEquals(0d, sampled[0].getDouble("speed_kmh"), 0d);
        assertTrue(sampled[2].getDouble("speed_kmh") > 0d);
    }

    @Test public void receiptsAreBoundedScalarOnlyAndRejectSensitiveFields() {
        JSONObject receipt = new PhysicalHReceipt("case", "READY")
            .put("pointCount", 12)
            .put("rollingHash", "ab".repeat(32))
            .json();
        assertTrue(receipt.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= PhysicalHReceipt.MAX_RECEIPT_BYTES);
        String lower = receipt.toString().toLowerCase(java.util.Locale.ROOT);
        for (String forbidden : Arrays.asList("latitude", "longitude", "route_points", "plaintext", "wrapped_dek", "passphrase", "privatekey")) {
            assertFalse(forbidden, lower.contains(forbidden));
        }
        try {
            new PhysicalHReceipt("case", "READY").put("latitude", 43d);
            fail("coordinate field accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("FIELD_NOT_ALLOWED"));
        }
        try {
            new PhysicalHReceipt("case", "READY").put("reason", "x".repeat(PhysicalHReceipt.MAX_STRING_BYTES + 1));
            fail("oversized receipt string accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("STRING_TOO_LARGE"));
        }
    }

    private static String soleEmbeddedApprovedAndroidId() {
        Set<String> embedded = PhysicalHDestructiveGuard.parseAllowlist(BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS);
        assertEquals(1, embedded.size());
        return embedded.iterator().next();
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte item : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return hex.toString();
    }
}
