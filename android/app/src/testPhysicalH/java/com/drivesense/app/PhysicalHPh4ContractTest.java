package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.os.Bundle;
import android.provider.Settings;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public final class PhysicalHPh4ContractTest {
    @Test public void everyNewPh4EntryIsDestructiveAndGuarded() {
        for (String name : new String[] {
            "activityAndRendererLifecycle",
            "killActiveProcessAfterNextSeal",
            "doubleProcessDeathRecovery",
            "ph4CanonicalFaultBoundary"
        }) assertTrue(name, PhysicalHDriver.isDestructiveCase(name));

        Context context = ApplicationProvider.getApplicationContext();
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ANDROID_ID, null);
        Bundle arguments = new Bundle();
        arguments.putString("phase", "PREPARE");
        JSONObject receipt = PhysicalHDriver.execute(context, "ph4CanonicalFaultBoundary", arguments);
        assertEquals("SAFE_REFUSAL", receipt.optString("status"));
        assertTrue(receipt.optString("guardCode"),
            "PHYSICAL_H_ANDROID_ID_UNAVAILABLE".equals(receipt.optString("guardCode"))
                || "PHYSICAL_H_ANDROID_ID_ALLOWLIST_EMPTY".equals(receipt.optString("guardCode")));
    }

    @Test public void retainedPh3BaselineOfOneIsAcceptedExactly() throws Exception {
        JSONObject health = healthy(1L, 0L);
        PhysicalHPh4Contract.requireHealthyBaseline(health, 1L);
        Bundle arguments = new Bundle();
        assertEquals(1L, PhysicalHPh4Contract.expectedBaseline(arguments));
    }

    @Test public void wrongBaselineOrStrandedPendingFailsClosed() throws Exception {
        assertFails("PHYSICAL_H_BASELINE_LIVE_COUNT_MISMATCH",
            () -> PhysicalHPh4Contract.requireHealthyBaseline(healthy(2L, 0L), 1L));
        assertFails("PHYSICAL_H_BASELINE_PENDING_NOT_ZERO",
            () -> PhysicalHPh4Contract.requireHealthyBaseline(healthy(1L, 1L), 1L));
    }

    @Test public void exactSingleCanonicalCompletionIsRequired() throws Exception {
        JSONObject marker = marker("case", "ARMED", "ph4-trip", 1L, 300L);
        JSONObject metadata = new JSONObject().put("id", "ph4-trip").put("point_count", 300L);
        PhysicalHPh4Contract.requireExactCompletion(healthy(2L, 0L), metadata, marker);

        assertFails("PHYSICAL_H_BASELINE_LIVE_COUNT_MISMATCH",
            () -> PhysicalHPh4Contract.requireExactCompletion(healthy(3L, 0L), metadata, marker));
        assertFails("PHYSICAL_H_BASELINE_PENDING_NOT_ZERO",
            () -> PhysicalHPh4Contract.requireExactCompletion(healthy(2L, 1L), metadata, marker));
        assertFails("PHYSICAL_H_COMPLETED_POINT_COUNT_MISMATCH",
            () -> PhysicalHPh4Contract.requireExactCompletion(
                healthy(2L, 0L), new JSONObject().put("id", "ph4-trip").put("point_count", 299L), marker
            ));
    }

    @Test public void wrongLifecycleAndDeathSequencingFailsClosed() throws Exception {
        JSONObject marker = marker("doubleProcessDeathRecovery", "PROCESS_A_ARMED", "ph4-trip", 1L, 300L);
        PhysicalHPh4Contract.requireMarker(marker, "doubleProcessDeathRecovery", "PROCESS_A_ARMED");
        assertFails("PHYSICAL_H_CASE_SEQUENCE_INVALID",
            () -> PhysicalHPh4Contract.requireMarker(marker, "doubleProcessDeathRecovery", "PROCESS_B_ARMED"));
        assertFails("PHYSICAL_H_CASE_MARKER_WRONG_CASE",
            () -> PhysicalHPh4Contract.requireMarker(marker, "killActiveProcessAfterNextSeal", "PROCESS_A_ARMED"));

        JSONObject active = new JSONObject()
            .put("id", "ph4-trip").put("point_count", 300L).put("state", "ACTIVE");
        PhysicalHPh4Contract.requireRecoveredActive(marker, active);
        assertFails("PHYSICAL_H_RECOVERED_POINT_COUNT_MISMATCH",
            () -> PhysicalHPh4Contract.requireRecoveredActive(
                marker, new JSONObject().put("id", "ph4-trip").put("point_count", 301L).put("state", "ACTIVE")
            ));
    }

    @Test public void faultMatrixIsExactAndUnknownBoundaryIsRefused() {
        assertEquals(13, PhysicalHPh4Contract.CANONICAL_FAULT_BOUNDARIES.size());
        assertTrue(PhysicalHPh4Contract.CANONICAL_FAULT_BOUNDARIES.contains("PARTIAL_TEMP"));
        assertTrue(PhysicalHPh4Contract.CANONICAL_FAULT_BOUNDARIES.contains("DURING_ACK"));
        Bundle arguments = new Bundle();
        arguments.putString("boundary", "synthetic-unreviewed-boundary");
        assertFails("PHYSICAL_H_FAULT_BOUNDARY_NOT_REVIEWED",
            () -> PhysicalHPh4Contract.requireFaultBoundary(arguments));
    }

    @Test public void recoveryReceiptShapeRemainsBoundedAndScalarOnly() {
        JSONObject receipt = new PhysicalHReceipt("doubleProcessDeathRecovery", "PASS")
            .put("phase", "COMPLETE")
            .put("tripId", "physical-h-double-process-death")
            .put("baselineLiveCount", 1L)
            .put("expectedFinalLiveCount", 2L)
            .put("canonicalCount", 2L)
            .put("pendingCount", 0L)
            .put("duplicateCompletion", false)
            .put("strandedPending", false)
            .json();
        assertTrue(receipt.toString().getBytes(StandardCharsets.UTF_8).length <= PhysicalHReceipt.MAX_RECEIPT_BYTES);
        assertFalse(receipt.toString().contains("route_points"));
    }

    @Test public void instrumentationExposesExplicitPrepareKillRecoverSurface() throws Exception {
        String source = new String(java.nio.file.Files.readAllBytes(
            new java.io.File("src/androidTestPhysicalH/java/com/drivesense/app/physicalh/PhysicalHInstrumentation.java").toPath()
        ), StandardCharsets.UTF_8);
        assertTrue(source.contains("awaitExternalDeath"));
        assertTrue(source.contains("selfTerminateAfterReceipt"));
        assertTrue(source.contains("Process.killProcess"));
        assertTrue(source.contains("PHYSICAL_H_EXTERNAL_DEATH_NOT_OBSERVED_WITHIN_120_SECONDS"));
        assertTrue(source.contains("void ph4CanonicalFaultBoundary()"));
        assertTrue(source.contains("WebViewRenderProcess"));
        assertTrue(source.contains("scenario.recreate()"));
    }

    @Test public void everyReviewedFaultBoundaryHasARealCanonicalHook() throws Exception {
        String chunkStore = readSource("src/main/java/com/drivesense/app/DriveSenseTripChunkStore.java");
        String repository = readSource("src/main/java/com/drivesense/app/DriveSenseTripArchiveRepository.java");
        String driver = readSource("src/physicalH/java/com/drivesense/app/PhysicalHDriver.java");
        assertTrue(driver.contains("runSuffix"));
        for (String boundary : PhysicalHPh4Contract.CANONICAL_FAULT_BOUNDARIES) {
            assertTrue("missing canonical fault hook for " + boundary,
                chunkStore.contains("\"" + boundary + "\"")
                    || repository.contains("\"" + boundary + "\""));
        }
    }

    private static String readSource(String path) throws Exception {
        return new String(java.nio.file.Files.readAllBytes(new java.io.File(path).toPath()), StandardCharsets.UTF_8);
    }

    private static JSONObject healthy(long live, long pending) throws Exception {
        return new JSONObject()
            .put("recoveryState", "HEALTHY")
            .put("sentinelPresent", true)
            .put("sentinelMatches", true)
            .put("liveCount", live)
            .put("pendingCount", pending);
    }

    private static JSONObject marker(String caseId, String state, String tripId,
                                     long baseline, long points) throws Exception {
        return new JSONObject()
            .put("caseId", caseId)
            .put("state", state)
            .put("tripId", tripId)
            .put("baselineLiveCount", baseline)
            .put("expectedPointCount", points);
    }

    private static void assertFails(String expected, Throwing action) {
        try {
            action.run();
            fail("expected " + expected);
        } catch (Exception error) {
            assertEquals(expected, error.getMessage());
        }
    }

    private interface Throwing { void run() throws Exception; }
}
