package com.drivesense.app;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** Pure fail-closed PH-4 sequencing and retained-baseline contract. */
final class PhysicalHPh4Contract {
    static final long DEFAULT_RETAINED_BASELINE = 1L;
    static final int DEFAULT_ACTIVE_POINTS = 300;

    static final Set<String> CANONICAL_FAULT_BOUNDARIES = Collections.unmodifiableSet(
        new LinkedHashSet<>(Arrays.asList(
            "BEFORE_PENDING",
            "AFTER_PENDING",
            "PARTIAL_TEMP",
            "AFTER_FILE_FSYNC",
            "DURING_RENAME",
            "AFTER_RENAME_BEFORE_DIRECTORY_FSYNC",
            "AFTER_DIRECTORY_FSYNC",
            "AFTER_AUTHENTICATED_READBACK",
            "DURING_COMMITTED_TRANSACTION",
            "AFTER_COMMITTED_BEFORE_SENTINEL",
            "AFTER_SENTINEL_BEFORE_VERIFY",
            "AFTER_VERIFY_BEFORE_ACK",
            "DURING_ACK"
        ))
    );

    private PhysicalHPh4Contract() {}

    static long expectedBaseline(android.os.Bundle arguments) {
        long value = DEFAULT_RETAINED_BASELINE;
        if (arguments != null && arguments.containsKey("expectedBaselineLiveCount")) {
            value = Long.parseLong(String.valueOf(arguments.get("expectedBaselineLiveCount")));
        }
        if (value < 0L) throw new IllegalArgumentException("PHYSICAL_H_BASELINE_COUNT_INVALID");
        return value;
    }

    static String phase(android.os.Bundle arguments, String fallback) {
        String value = arguments == null ? fallback : arguments.getString("phase", fallback);
        value = value == null ? fallback : value.trim().toUpperCase(java.util.Locale.ROOT);
        if (value.isEmpty()) throw new IllegalArgumentException("PHYSICAL_H_PHASE_REQUIRED");
        return value;
    }

    static void requireHealthyBaseline(JSONObject health, long expectedLiveCount) {
        if (health == null
            || !"HEALTHY".equals(health.optString("recoveryState"))
            || !health.optBoolean("sentinelPresent")
            || !health.optBoolean("sentinelMatches")) {
            throw new IllegalStateException("PHYSICAL_H_BASELINE_UNHEALTHY");
        }
        if (health.optLong("liveCount", -1L) != expectedLiveCount) {
            throw new IllegalStateException("PHYSICAL_H_BASELINE_LIVE_COUNT_MISMATCH");
        }
        if (health.optLong("pendingCount", -1L) != 0L) {
            throw new IllegalStateException("PHYSICAL_H_BASELINE_PENDING_NOT_ZERO");
        }
    }

    static void requireMarker(JSONObject marker, String caseId, String expectedState) {
        if (marker == null) throw new IllegalStateException("PHYSICAL_H_CASE_MARKER_MISSING");
        if (!caseId.equals(marker.optString("caseId"))) {
            throw new IllegalStateException("PHYSICAL_H_CASE_MARKER_WRONG_CASE");
        }
        if (!expectedState.equals(marker.optString("state"))) {
            throw new IllegalStateException("PHYSICAL_H_CASE_SEQUENCE_INVALID");
        }
    }

    static void requireRecoveredActive(JSONObject marker, JSONObject active) {
        if (active == null) throw new IllegalStateException("PHYSICAL_H_RECOVERED_SPOOL_MISSING");
        if (!marker.optString("tripId").equals(active.optString("id"))) {
            throw new IllegalStateException("PHYSICAL_H_RECOVERED_TRIP_ID_MISMATCH");
        }
        long submittedPoints = marker.optLong("expectedPointCount", -1L);
        long recoveredPoints = active.optLong("point_count", -2L);
        if (recoveredPoints <= 0L
            || recoveredPoints > submittedPoints
            || submittedPoints - recoveredPoints > DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT) {
            throw new IllegalStateException("PHYSICAL_H_RECOVERED_POINT_COUNT_MISMATCH");
        }
        if (!"ACTIVE".equals(active.optString("state"))) {
            throw new IllegalStateException("PHYSICAL_H_RECOVERED_SPOOL_NOT_ACTIVE");
        }
    }

    static void requireExactCompletion(JSONObject health, JSONObject metadata, JSONObject marker) {
        long baseline = marker.optLong("baselineLiveCount", -1L);
        requireHealthyBaseline(health, baseline + 1L);
        if (metadata == null) throw new IllegalStateException("PHYSICAL_H_COMPLETED_METADATA_MISSING");
        if (!marker.optString("tripId").equals(metadata.optString("id"))) {
            throw new IllegalStateException("PHYSICAL_H_COMPLETED_TRIP_ID_MISMATCH");
        }
        if (marker.optLong("expectedPointCount", -1L) != metadata.optLong("point_count", -2L)) {
            throw new IllegalStateException("PHYSICAL_H_COMPLETED_POINT_COUNT_MISMATCH");
        }
    }

    static String requireFaultBoundary(android.os.Bundle arguments) {
        String boundary = arguments == null ? "" : arguments.getString("boundary", "");
        boundary = boundary == null ? "" : boundary.trim().toUpperCase(java.util.Locale.ROOT);
        if (!CANONICAL_FAULT_BOUNDARIES.contains(boundary)) {
            throw new IllegalArgumentException("PHYSICAL_H_FAULT_BOUNDARY_NOT_REVIEWED");
        }
        return boundary;
    }
}
