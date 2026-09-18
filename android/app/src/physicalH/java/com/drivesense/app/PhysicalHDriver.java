package com.drivesense.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Guarded dispatcher for the Physical H instrumentation APK. */
public final class PhysicalHDriver {
    public static final String[] ENTRY_POINTS = {
        "readOnlyInstallationInventory",
        "enableTestAuthorityAndHealth",
        "measureBaselineZeroAndOne",
        "seedPhysicalHFixtures",
        "activityAndRendererLifecycle",
        "killActiveProcessAfterNextSeal",
        "doubleProcessDeathRecovery",
        "ph4CanonicalFaultBoundary",
        "remainingPhaseControl",
        "recoverAndVerifyAfterReboot",
        "streamSyntheticLongTrip"
    };

    /** ingestCompletedJournal refuses a budget outside [1 KiB, 32 MiB]. */
    static final long INGEST_WORK_BYTE_MAXIMUM = 32L * 1024L * 1024L;

    private static final Map<String, Boolean> CASES;
    private static long queryCount;
    private static long queryRows;
    private static long payloadReadCount;
    private static long bridgeRequestByteMaximum;
    private static long bridgeResponseByteMaximum;

    static {
        Map<String, Boolean> cases = new LinkedHashMap<>();
        cases.put("readOnlyInstallationInventory", false);
        for (String entry : ENTRY_POINTS) if (!cases.containsKey(entry)) cases.put(entry, true);
        CASES = Collections.unmodifiableMap(cases);
    }

    private PhysicalHDriver() {}

    public static boolean isDestructiveCase(String name) {
        Boolean destructive = CASES.get(name);
        if (destructive == null) throw new IllegalArgumentException("PHYSICAL_H_UNKNOWN_CASE");
        return destructive;
    }

    public static JSONObject execute(Context rawContext, String name, Bundle arguments) {
        Context context = rawContext.getApplicationContext();
        if (!CASES.containsKey(name)) return receipt(name, "NOT_READY", "PHYSICAL_H_UNKNOWN_CASE").json();
        try {
            if (isDestructiveCase(name)) PhysicalHDestructiveGuard.require(context);
            JSONObject result;
            switch (name) {
                case "readOnlyInstallationInventory": result = readOnlyInstallationInventory(context); break;
                case "enableTestAuthorityAndHealth": result = enableTestAuthorityAndHealth(context); break;
                case "measureBaselineZeroAndOne": result = measureBaselineZeroAndOne(context); break;
                case "seedPhysicalHFixtures": result = seedPhysicalHFixtures(context, arguments); break;
                case "activityAndRendererLifecycle": result = activityAndRendererLifecycle(context, arguments); break;
                case "killActiveProcessAfterNextSeal": result = armActiveKill(context, arguments); break;
                case "doubleProcessDeathRecovery": result = doubleProcessDeathRecovery(context, arguments); break;
                case "ph4CanonicalFaultBoundary": result = ph4CanonicalFaultBoundary(context, arguments); break;
                case "remainingPhaseControl": result = PhysicalHRemainingPhases.execute(context, arguments); break;
                case "recoverAndVerifyAfterReboot": result = recoverAndVerifyAfterReboot(context); break;
                case "streamSyntheticLongTrip": result = streamSyntheticLongTrip(context, arguments); break;
                default: result = receipt(name, "NOT_READY", "PHYSICAL_H_UNKNOWN_CASE").json();
            }
            observeResponse(result);
            return result;
        } catch (PhysicalHDestructiveGuard.GuardRefusal refusal) {
            return receipt(name, "SAFE_REFUSAL", refusal.code).put("guardCode", refusal.code).json();
        } catch (Exception error) {
            String code = error.getMessage() == null ? error.getClass().getSimpleName() : boundedCode(error.getMessage());
            return receipt(name, "NOT_READY", code).json();
        }
    }

    private static JSONObject readOnlyInstallationInventory(Context context) throws Exception {
        // Deliberately limited to package/build facts and this app identity's
        // Settings.Secure.ANDROID_ID. It does not request an
        // archive coordinator, files directory, Preferences, IDB, key, service,
        // or authority override.
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        String androidId = PhysicalHDestructiveGuard.readAndroidId(context);
        return receipt("readOnlyInstallationInventory", "READY", "READ_ONLY_INVENTORY")
            .put("packageId", context.getPackageName())
            .put("versionName", info.versionName == null ? "" : info.versionName)
            .put("versionCode", Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("buildType", BuildConfig.BUILD_TYPE)
            .put("legacyBuild", BuildConfig.PHYSICAL_H_LEGACY_BUILD)
            .put("androidId", androidId)
            .put("androidIdAvailable", !androidId.isEmpty())
            .put("testAuthorityEnabled", false)
            .put("mutatesState", false)
            .json();
    }

    private static JSONObject enableTestAuthorityAndHealth(Context context) throws Exception {
        requireCurrentHarness();
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(true);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        return statusReceipt("enableTestAuthorityAndHealth", "READY", repository, health, null)
            .put("testAuthorityEnabled", true)
            .put("mutatesState", true)
            .json();
    }

    private static JSONObject measureBaselineZeroAndOne(Context context) throws Exception {
        requireCurrentHarness();
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        JSONObject request = new JSONObject().put("maxItems", 1).put("maxBytes", 16 * 1024);
        observeRequest(request);
        JSONObject page = repository.queryHistoryPage(request);
        queryCount++;
        queryRows += page.optInt("itemCount", 0);
        JSONObject aggregates = repository.aggregates(new JSONObject());
        return statusReceipt("measureBaselineZeroAndOne", "MEASURED", repository, health, null)
            .put("queryCount", queryCount)
            .put("queryRows", queryRows)
            .put("bridgeRequestByteMaximum", bridgeRequestByteMaximum)
            .put("bridgeResponseByteMaximum", bridgeResponseByteMaximum)
            .put("aggregateLiveCount", aggregates.optLong("liveCount", 0L))
            .put("aggregateDistance", aggregates.optDouble("totalDistance", 0d))
            .put("mutatesState", false)
            .json();
    }

    private static JSONObject seedPhysicalHFixtures(Context context, Bundle arguments) throws Exception {
        long points = positive(arguments, "points", 1_000L);
        return produce(context, "seedPhysicalHFixtures", points, 0L, 0d,
            integer(arguments, "paddingBytes", 64), true, "", -1L, 0L);
    }

    private static JSONObject streamSyntheticLongTrip(Context context, Bundle arguments) throws Exception {
        return produce(
            context,
            "streamSyntheticLongTrip",
            nonNegative(arguments, "targetPoints", 0L),
            nonNegative(arguments, "targetBytes", 52L * 1024L * 1024L),
            nonNegativeDouble(arguments, "targetDistanceKm", 0d) * 1000d,
            integer(arguments, "paddingBytes", 960),
            booleanValue(arguments, "complete", true),
            arguments == null ? "" : arguments.getString("tripSuffix", ""),
            longValue(arguments, "stopStartPoint", -1L),
            nonNegative(arguments, "stopPointCount", 0L)
        );
    }

    private static JSONObject produce(Context context, String caseName, long targetPoints, long targetBytes,
                                      double targetDistanceMetres, int paddingBytes, boolean complete,
                                      String requestedSuffix, long stopStartPoint,
                                      long stopPointCount) throws Exception {
        requireCurrentHarness();
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseAutoTrackingService service = startHarnessService(context);
        long seed = 0x504859534943414cL;
        long startMs = 1_800_000_000_000L;
        String suffix = requestedSuffix == null || requestedSuffix.trim().isEmpty()
            ? "" : "-" + boundedCode(requestedSuffix.trim().toLowerCase(java.util.Locale.ROOT));
        String tripId = "physical-h-" + caseName.toLowerCase(java.util.Locale.ROOT) + suffix + "-" + startMs;
        if (!service.beginActiveRouteForTests(tripId, startMs)) throw new IllegalStateException("PHYSICAL_H_ACTIVE_BEGIN_REFUSED");
        PhysicalHIncrementalRouteGenerator generator = new PhysicalHIncrementalRouteGenerator(
            seed, startMs, paddingBytes, stopStartPoint, stopPointCount);
        while (!generator.reached(targetPoints, targetBytes, targetDistanceMetres)) generator.appendNext(service::appendActivePointForTests);
        // An incomplete sample is an interruption fixture: cross-process recovery reads the
        // active-trip checkpoint, and the synthetic producer appends points directly instead of
        // going through the location callback that would have written one. Persist it here, the
        // same way the PH-4 active-case fixture does, or the route cannot be recovered.
        if (!complete) service.persistActiveRouteCheckpointForTests();
        JSONObject active = service.activeRouteStatusForTests();
        if (active == null) throw new IllegalStateException("PHYSICAL_H_ACTIVE_STATUS_MISSING");
        if (!complete) requireRecoverableCheckpoint(context, tripId);

        JSONObject committed = null;
        if (complete) {
            JSONObject metadata = new JSONObject()
                .put("id", tripId)
                .put("start_time", startMs)
                .put("end_time", startMs + generator.pointCount() * 1000L)
                .put("status", "completed")
                .put("distance_km", generator.generatedDistanceMetres() / 1000d)
                .put("duration_seconds", generator.pointCount());
            if (!service.sealActiveRouteToJournalForTests(metadata)) throw new IllegalStateException("PHYSICAL_H_SEAL_TO_JOURNAL_REFUSED");
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            JSONObject result = repository.ingestCompletedJournal(1, ingestWorkBytes(generator.generatedBytes()));
            JSONArray receipts = result.optJSONArray("receipts");
            if (receipts == null || receipts.length() != 1) throw new IllegalStateException("PHYSICAL_H_CANONICAL_RECEIPT_MISSING");
            committed = receipts.getJSONObject(0);
            if (!"COMMITTED_ACKNOWLEDGED".equals(committed.optString("status"))) {
                throw new IllegalStateException("PHYSICAL_H_CANONICAL_NOT_ACKNOWLEDGED");
            }
        }
        PhysicalHReceipt receipt = receipt(caseName, complete ? "STREAMED_AND_COMMITTED" : "STREAMED_ACTIVE", "REAL_PRODUCER_PATH")
            .put("tripId", tripId)
            .put("pointCount", generator.pointCount())
            .put("generatedBytes", generator.generatedBytes())
            .put("generatedDistanceMetres", generator.generatedDistanceMetres())
            .put("stopWindowPointCount", stopPointCount)
            .put("rollingHash", generator.rollingHashHex())
            .put("activeSpoolState", active.optString("state"))
            .put("sealedSegmentCount", active.optLong("sealed_segment_count"))
            .put("sealedSegmentBytes", active.optLong("sealed_plaintext_bytes"))
            .put("recentPointCount", active.optLong("recent_point_count"))
            .put("overviewPointCount", active.optLong("overview_point_count"))
            .put("currentBufferBytes", active.optLong("open_segment_bytes"))
            .put("maximumBufferedBytes", active.optLong("maximumBufferedBytes"))
            .put("maximumBufferedPoints", active.optLong("maximumBufferedPoints"))
            .put("maximum_resident_route_points", active.optLong("maximum_resident_route_points"))
            .put("maximumGeneratorResidentPoints", PhysicalHIncrementalRouteGenerator.MAXIMUM_GENERATOR_RESIDENT_POINTS)
            .put("processIncarnation", active.optString("process_incarnation"))
            .put("mutatesState", true);
        if (committed != null) receipt.put("maxWriterBufferBytes", committed.optLong("maxCanonicalStreamBufferBytes", 0L));
        return receipt.json();
    }

    /**
     * Fail closed if the interruption fixture is not actually recoverable: cross-process recovery
     * reads this checkpoint, so a missing or mismatched one would silently turn a recovery case
     * into an unrecoverable orphaned spool.
     */
    private static void requireRecoverableCheckpoint(Context context, String tripId) {
        JSONObject checkpoint = DriveSenseActiveTripCheckpointStore.load(context, System.currentTimeMillis());
        if (checkpoint == null) throw new IllegalStateException("PHYSICAL_H_INTERRUPTION_CHECKPOINT_MISSING");
        if (!tripId.equals(checkpoint.optString("trip_id", "").trim())) {
            throw new IllegalStateException("PHYSICAL_H_INTERRUPTION_CHECKPOINT_TRIP_MISMATCH");
        }
    }

    /**
     * maxWorkBytes is a batch budget, not a per-item limit: ingestCompletedJournal only ends a
     * batch once a receipt already exists, so a single journal entry of any size is still
     * admitted at the cap. Asking for the generated route size instead would exceed the
     * contract as soon as a sample passes 32 MiB.
     */
    static long ingestWorkBytes(long generatedBytes) {
        return Math.max(1024L, Math.min(INGEST_WORK_BYTE_MAXIMUM, generatedBytes + 1024L));
    }

    private static JSONObject activityAndRendererLifecycle(Context context, Bundle arguments) throws Exception {
        String phase = PhysicalHPh4Contract.phase(arguments, "PREPARE");
        if ("RECEIPT_REPLAY".equals(phase)) {
            JSONObject marker = PhysicalHCaseStore.read(context);
            PhysicalHPh4Contract.requireMarker(marker, "activityAndRendererLifecycle", "LIFECYCLE_COMPLETED");
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
            JSONObject metadata = repository.getMetadata(marker.optString("tripId"));
            PhysicalHPh4Contract.requireExactCompletion(health, metadata, marker);
            return completionReceipt("activityAndRendererLifecycle", marker, health, metadata)
                .put("lifecycleBackgrounded", true)
                .put("activityRecreated", true)
                .put("rendererTerminated", true)
                .put("projectionRecovered", true)
                .put("nativeAuthorityPreserved", true)
                .put("canonicalOwnershipPreserved", true)
                .json();
        }
        if ("PREPARE".equals(phase)) {
            if (arguments != null && Boolean.parseBoolean(String.valueOf(arguments.get("restartFailedCase")))) {
                invalidateLostLifecycleFixture(context);
            }
            return prepareActiveCase(context, "activityAndRendererLifecycle", "LIFECYCLE_ARMED", arguments, 1_800_001_000_000L);
        }
        if (!"COMPLETE".equals(phase)) throw new IllegalArgumentException("PHYSICAL_H_LIFECYCLE_PHASE_INVALID");
        if (arguments == null
            || !arguments.getBoolean("lifecycleBackgrounded")
            || !arguments.getBoolean("activityRecreated")
            || !arguments.getBoolean("rendererTerminated")
            || !arguments.getBoolean("projectionRecovered")) {
            throw new IllegalStateException("PHYSICAL_H_LIFECYCLE_EVIDENCE_INCOMPLETE");
        }
        return recoverCompleteAndVerify(context, "activityAndRendererLifecycle", "LIFECYCLE_ARMED", "LIFECYCLE_COMPLETED")
            .put("lifecycleBackgrounded", true)
            .put("activityRecreated", true)
            .put("rendererTerminated", true)
            .put("projectionRecovered", true)
            .put("nativeAuthorityPreserved", true)
            .put("canonicalOwnershipPreserved", true)
            .json();
    }

    private static JSONObject armActiveKill(Context context, Bundle arguments) throws Exception {
        String phase = PhysicalHPh4Contract.phase(arguments, "PREPARE");
        if ("PREPARE".equals(phase)) {
            return prepareActiveCase(context, "killActiveProcessAfterNextSeal", "PROCESS_A_ARMED", arguments, 1_800_002_000_000L);
        }
        if (!"RECOVER_COMPLETE".equals(phase)) throw new IllegalArgumentException("PHYSICAL_H_PROCESS_DEATH_PHASE_INVALID");
        return recoverCompleteAndVerify(context, "killActiveProcessAfterNextSeal", "PROCESS_A_ARMED", "PROCESS_RECOVERY_COMPLETED").json();
    }

    private static JSONObject doubleProcessDeathRecovery(Context context, Bundle arguments) throws Exception {
        String phase = PhysicalHPh4Contract.phase(arguments, "A");
        if ("A".equals(phase)) {
            return prepareActiveCase(context, "doubleProcessDeathRecovery", "PROCESS_A_ARMED", arguments, 1_800_003_000_000L);
        }
        JSONObject marker = PhysicalHCaseStore.read(context);
        if ("B".equals(phase)) {
            PhysicalHPh4Contract.requireMarker(marker, "doubleProcessDeathRecovery", "PROCESS_A_ARMED");
            DriveSenseP35Flags.setNativeAuthorityForTests(true);
            DriveSenseAutoTrackingService service = startHarnessService(context);
            JSONObject active = service.activeRouteStatusForTests();
            PhysicalHPh4Contract.requireRecoveredActive(marker, active);
            reconcileRecoveredOpenTail(context, marker, active);
            marker.put("state", "PROCESS_B_ARMED");
            marker.put("processIncarnationB", active.optString("process_incarnation"));
            PhysicalHCaseStore.write(context, marker);
            return receipt("doubleProcessDeathRecovery", "ARMED_FOR_EXTERNAL_ACTION", "KILL_PROCESS_B_THEN_RUN_PHASE_C")
                .put("phase", "B")
                .put("tripId", marker.optString("tripId"))
                .put("pointCount", active.optLong("point_count"))
                .put("processIncarnation", active.optString("process_incarnation"))
                .put("externalAction", "KILL_APP_PROCESS_NOT_FORCE_STOP")
                .put("restartExpected", true)
                .put("mutatesState", true)
                .json();
        }
        if (!"C".equals(phase)) throw new IllegalArgumentException("PHYSICAL_H_DOUBLE_DEATH_PHASE_INVALID");
        return recoverCompleteAndVerify(context, "doubleProcessDeathRecovery", "PROCESS_B_ARMED", "DOUBLE_DEATH_COMPLETED").json();
    }

    private static JSONObject ph4CanonicalFaultBoundary(Context context, Bundle arguments) throws Exception {
        String phase = PhysicalHPh4Contract.phase(arguments, "PREPARE");
        String boundary = PhysicalHPh4Contract.requireFaultBoundary(arguments);
        if ("PREPARE".equals(phase)) return prepareFaultBoundary(context, arguments, boundary);
        if (!"RECOVER_VERIFY".equals(phase)) throw new IllegalArgumentException("PHYSICAL_H_FAULT_PHASE_INVALID");
        JSONObject marker = PhysicalHCaseStore.read(context);
        PhysicalHPh4Contract.requireMarker(marker, "ph4CanonicalFaultBoundary", "FAULT_TRIGGERED");
        if (!boundary.equals(marker.optString("boundary"))) throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);
        DriveSenseTripChunkStore.setFaultPointForTests(null);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject result = repository.ingestCompletedJournal(1, 32L * 1024L * 1024L);
        JSONArray receipts = result == null ? null : result.optJSONArray("receipts");
        boolean acknowledged = receipts != null && receipts.length() == 1
            && "COMMITTED_ACKNOWLEDGED".equals(receipts.optJSONObject(0).optString("status"));
        long recoveryDeadline = android.os.SystemClock.elapsedRealtime() + 15_000L;
        JSONObject health;
        JSONObject metadata;
        do {
            health = DriveSenseArchiveHealth.inventory(repository.coordinator());
            metadata = repository.getMetadata(marker.optString("tripId"));
            if (metadata != null) break;
            if (acknowledged || android.os.SystemClock.elapsedRealtime() >= recoveryDeadline) break;
            android.os.SystemClock.sleep(100L);
        } while (true);
        if (!acknowledged && metadata == null) {
            throw new IllegalStateException("PHYSICAL_H_CANONICAL_RECEIPT_MISSING");
        }
        PhysicalHPh4Contract.requireExactCompletion(health, metadata, marker);
        requireNoPendingFaultIntake(context, marker.optString("tripId"));
        marker.put("state", "FAULT_COMPLETED");
        if (!acknowledged) marker.put("reconciliationCode", "FAULT_FIXTURE_RECOVERED_BY_STARTUP_JOURNAL_WORKER");
        PhysicalHCaseStore.write(context, marker);
        return completionReceipt("ph4CanonicalFaultBoundary", marker, health, metadata)
            .put("boundary", boundary)
            .put("faultTriggered", true)
            .put("reconciledExistingCompletion", !acknowledged)
            .json();
    }

    private static JSONObject prepareActiveCase(Context context, String caseId, String armedState,
                                                Bundle arguments, long startMs) throws Exception {
        requireCurrentHarness();
        long baseline = PhysicalHPh4Contract.expectedBaseline(arguments);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        PhysicalHPh4Contract.requireHealthyBaseline(health, baseline);
        JSONObject priorMarker = PhysicalHCaseStore.read(context);
        if (priorMarker != null && !isClosedMarker(priorMarker.optString("state"))) {
            throw new IllegalStateException("PHYSICAL_H_PRIOR_CASE_NOT_CLOSED");
        }
        String suffix = arguments == null ? "" : arguments.getString("tripSuffix", "");
        String tripId = "physical-h-" + caseId.toLowerCase(java.util.Locale.ROOT)
            + (suffix == null || suffix.trim().isEmpty() ? "" : "-" + boundedCode(suffix))
            + "-" + startMs;
        if (repository.getMetadata(tripId) != null) throw new IllegalStateException("PHYSICAL_H_DUPLICATE_TRIP_ID");
        DriveSenseAutoTrackingService service = startHarnessService(context);
        if (!service.beginActiveRouteForTests(tripId, startMs)) throw new IllegalStateException("PHYSICAL_H_ACTIVE_BEGIN_REFUSED");
        long requestedPoints = positive(arguments, "points", PhysicalHPh4Contract.DEFAULT_ACTIVE_POINTS);
        if (requestedPoints < 2L || requestedPoints > 100_000L) {
            throw new IllegalArgumentException("PHYSICAL_H_ACTIVE_POINTS_OUT_OF_RANGE");
        }
        int points = (int) requestedPoints;
        PhysicalHIncrementalRouteGenerator generator = new PhysicalHIncrementalRouteGenerator(
            0x5048345048415345L ^ startMs, startMs, integer(arguments, "paddingBytes", 64)
        );
        while (generator.pointCount() < points) generator.appendNext(service::appendActivePointForTests);
        service.persistActiveRouteCheckpointForTests();
        JSONObject active = service.activeRouteStatusForTests();
        if (active == null || active.optLong("point_count") != points) {
            throw new IllegalStateException("PHYSICAL_H_ACTIVE_SETUP_INCOMPLETE");
        }
        JSONObject marker = new JSONObject()
            .put("version", 2)
            .put("caseId", caseId)
            .put("state", armedState)
            .put("tripId", tripId)
            .put("startMs", startMs)
            .put("baselineLiveCount", baseline)
            .put("expectedPointCount", generator.pointCount())
            .put("expectedHash", generator.rollingHashHex())
            .put("expectedDistanceMetres", generator.generatedDistanceMetres())
            .put("processIncarnationA", active.optString("process_incarnation"));
        PhysicalHCaseStore.write(context, marker);
        return receipt(caseId, "ARMED_FOR_EXTERNAL_ACTION", armedState)
            .put("phase", "PREPARE")
            .put("tripId", tripId)
            .put("baselineLiveCount", baseline)
            .put("expectedFinalLiveCount", baseline + 1L)
            .put("expectedPointCount", generator.pointCount())
            .put("expectedHash", generator.rollingHashHex())
            .put("sealedSegmentCount", active.optLong("sealed_segment_count"))
            .put("sealedSegmentBytes", active.optLong("sealed_plaintext_bytes"))
            .put("processIncarnation", active.optString("process_incarnation"))
            .put("externalAction", "HOST_OR_INSTRUMENTATION_LIFECYCLE_STEP_REQUIRED")
            .put("restartExpected", true)
            .put("mutatesState", true)
            .json();
    }

    private static PhysicalHReceipt recoverCompleteAndVerify(Context context, String caseId,
                                                              String expectedState, String finalState) throws Exception {
        requireCurrentHarness();
        JSONObject marker = PhysicalHCaseStore.read(context);
        PhysicalHPh4Contract.requireMarker(marker, caseId, expectedState);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject before = DriveSenseArchiveHealth.inventory(repository.coordinator());
        PhysicalHPh4Contract.requireHealthyBaseline(before, marker.optLong("baselineLiveCount", -1L));
        if (repository.getMetadata(marker.optString("tripId")) != null) {
            throw new IllegalStateException("PHYSICAL_H_DUPLICATE_COMPLETION");
        }
        DriveSenseAutoTrackingService service = startHarnessService(context);
        JSONObject active = service.activeRouteStatusForTests();
        PhysicalHPh4Contract.requireRecoveredActive(marker, active);
        reconcileRecoveredOpenTail(context, marker, active);
        JSONObject completion = completionMetadata(marker);
        if (!service.sealActiveRouteToJournalForTests(completion)) {
            throw new IllegalStateException("PHYSICAL_H_SEAL_TO_JOURNAL_REFUSED");
        }
        JSONObject ingest = repository.ingestCompletedJournal(1, 32L * 1024L * 1024L);
        requireOneAcknowledgedReceipt(ingest);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        JSONObject metadata = repository.getMetadata(marker.optString("tripId"));
        PhysicalHPh4Contract.requireExactCompletion(health, metadata, marker);
        marker.put("state", finalState);
        PhysicalHCaseStore.write(context, marker);
        return completionReceipt(caseId, marker, health, metadata);
    }

    private static JSONObject prepareFaultBoundary(Context context, Bundle arguments, String boundary) throws Exception {
        int index = new java.util.ArrayList<>(PhysicalHPh4Contract.CANONICAL_FAULT_BOUNDARIES).indexOf(boundary);
        boolean resumePrepared = arguments != null
            && Boolean.parseBoolean(String.valueOf(arguments.get("resumePrepared")));
        JSONObject marker;
        if (resumePrepared) {
            marker = PhysicalHCaseStore.read(context);
            PhysicalHPh4Contract.requireMarker(marker, "ph4CanonicalFaultBoundary", "FAULT_ACTIVE_PREPARED");
            String preparedBoundary = marker.optString("boundary", "");
            if (!preparedBoundary.isEmpty() && !boundary.equals(preparedBoundary)) {
                throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
            }
            if (preparedBoundary.isEmpty()
                && !marker.optString("tripId").contains(boundary.toLowerCase(java.util.Locale.ROOT))) {
                throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
            }
            JSONArray pending = DriveSenseCompletedTripJournal.pendingTripIds(context, 50);
            boolean found = false;
            for (int i = 0; i < pending.length(); i++) {
                if (marker.optString("tripId").equals(pending.optString(i))) found = true;
            }
            if (!found) throw new IllegalStateException("PHYSICAL_H_FAULT_INTAKE_MISSING");
        } else {
            if (arguments != null
                && Boolean.parseBoolean(String.valueOf(arguments.get("restartFailedCase")))) {
                JSONObject recovered = reconcileCompletedFaultFixture(context, boundary);
                if (recovered != null) return recovered;
                invalidateLostFaultFixture(context, boundary);
            }
            Bundle preparedArguments = arguments == null ? new Bundle() : new Bundle(arguments);
            String runSuffix = arguments == null ? "" : arguments.getString("runSuffix", "");
            String uniqueSuffix = boundary.toLowerCase(java.util.Locale.ROOT)
                + (runSuffix == null || runSuffix.trim().isEmpty()
                    ? "" : "-" + boundedCode(runSuffix.trim().toLowerCase(java.util.Locale.ROOT)));
            preparedArguments.putString("tripSuffix", uniqueSuffix);
            prepareActiveCase(
                context, "ph4CanonicalFaultBoundary", "FAULT_ACTIVE_PREPARED", preparedArguments,
                1_800_004_000_000L + index * 1_000_000L
            );
            marker = PhysicalHCaseStore.read(context);
            PhysicalHPh4Contract.requireMarker(marker, "ph4CanonicalFaultBoundary", "FAULT_ACTIVE_PREPARED");
            marker.put("boundary", boundary);
            PhysicalHCaseStore.write(context, marker);
            DriveSenseAutoTrackingService service = DriveSenseAutoTrackingService.physicalHarnessInstanceForTests();
            if (service == null) throw new IllegalStateException("PHYSICAL_H_SERVICE_NOT_RUNNING");
            if (!service.sealActiveRouteToJournalForTests(completionMetadata(marker))) {
                throw new IllegalStateException("PHYSICAL_H_SEAL_TO_JOURNAL_REFUSED");
            }
        }
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);
        DriveSenseTripChunkStore.setFaultPointForTests(null);
        if (isChunkBoundary(boundary)) DriveSenseTripChunkStore.setFaultPointForTests(boundary);
        else DriveSenseTripArchiveRepository.setFaultPointForTests(boundary);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject result = repository.ingestCompletedJournal(1, 32L * 1024L * 1024L);
        JSONArray receipts = result.optJSONArray("receipts");
        if (receipts == null || receipts.length() != 1
            || !"RETRY_REQUIRED".equals(receipts.optJSONObject(0).optString("status"))) {
            throw new IllegalStateException("PHYSICAL_H_FAULT_NOT_TRIGGERED");
        }
        String errorCode = receipts.optJSONObject(0).optString("errorCode");
        if (!errorCode.contains("TEST_FAULT_" + boundary)) {
            throw new IllegalStateException("PHYSICAL_H_WRONG_FAULT_TRIGGERED");
        }
        marker.put("state", "FAULT_TRIGGERED");
        marker.put("boundary", boundary);
        PhysicalHCaseStore.write(context, marker);
        return receipt("ph4CanonicalFaultBoundary", "ARMED_FOR_EXTERNAL_ACTION", "FAULT_BOUNDARY_REACHED")
            .put("phase", "PREPARE")
            .put("boundary", boundary)
            .put("tripId", marker.optString("tripId"))
            .put("baselineLiveCount", marker.optLong("baselineLiveCount"))
            .put("expectedFinalLiveCount", marker.optLong("baselineLiveCount") + 1L)
            .put("expectedPointCount", marker.optLong("expectedPointCount"))
            .put("expectedHash", marker.optString("expectedHash"))
            .put("faultTriggered", true)
            .put("externalAction", "KILL_APP_PROCESS_NOT_FORCE_STOP")
            .put("restartExpected", true)
            .put("mutatesState", true)
            .json();
    }

    private static PhysicalHReceipt completionReceipt(String caseId, JSONObject marker,
                                                       JSONObject health, JSONObject metadata) {
        return receipt(caseId, "PASS", "EXACT_SINGLE_CANONICAL_COMPLETION")
            .put("phase", "COMPLETE")
            .put("tripId", marker.optString("tripId"))
            .put("submittedPointCount", marker.optLong("submittedPointCount", marker.optLong("expectedPointCount")))
            .put("recoveredPointCount", marker.optLong("expectedPointCount"))
            .put("boundedOpenTailPointLoss", marker.optLong("boundedOpenTailPointLoss", 0L))
            .put("maximumOpenTailPoints", DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT)
            .put("baselineLiveCount", marker.optLong("baselineLiveCount"))
            .put("expectedFinalLiveCount", marker.optLong("baselineLiveCount") + 1L)
            .put("canonicalCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("finalPointCount", metadata == null ? -1L : metadata.optLong("point_count", -1L))
            .put("recoveryState", health.optString("recoveryState"))
            .put("sentinelPresent", health.optBoolean("sentinelPresent"))
            .put("sentinelMatches", health.optBoolean("sentinelMatches"))
            .put("duplicateCompletion", false)
            .put("strandedPending", false)
            .put("restartExpected", false)
            .put("mutatesState", true);
    }

    private static void reconcileRecoveredOpenTail(Context context, JSONObject marker,
                                                    JSONObject active) throws Exception {
        long submittedPointCount = marker.optLong("submittedPointCount",
            marker.optLong("expectedPointCount", -1L));
        long recoveredPointCount = active.optLong("point_count", -1L);
        marker.put("submittedPointCount", submittedPointCount);
        marker.put("expectedPointCount", recoveredPointCount);
        marker.put("expectedDistanceMetres", active.optDouble("distance_km", 0d) * 1000d);
        marker.put("boundedOpenTailPointLoss", Math.max(0L, submittedPointCount - recoveredPointCount));
        PhysicalHCaseStore.write(context, marker);
    }

    private static JSONObject completionMetadata(JSONObject marker) throws Exception {
        long points = marker.optLong("expectedPointCount");
        long startMs = marker.optLong("startMs");
        return new JSONObject()
            .put("id", marker.optString("tripId"))
            .put("start_time", startMs)
            .put("end_time", startMs + points * 1000L)
            .put("status", "completed")
            .put("point_count", points)
            .put("distance_km", marker.optDouble("expectedDistanceMetres") / 1000d)
            .put("duration_seconds", points);
    }

    private static void requireOneAcknowledgedReceipt(JSONObject result) {
        JSONArray receipts = result == null ? null : result.optJSONArray("receipts");
        if (receipts == null || receipts.length() != 1) {
            throw new IllegalStateException("PHYSICAL_H_CANONICAL_RECEIPT_MISSING");
        }
        if (!"COMMITTED_ACKNOWLEDGED".equals(receipts.optJSONObject(0).optString("status"))) {
            throw new IllegalStateException("PHYSICAL_H_CANONICAL_NOT_ACKNOWLEDGED");
        }
    }

    private static boolean isChunkBoundary(String boundary) {
        return "PARTIAL_TEMP".equals(boundary)
            || "AFTER_FILE_FSYNC".equals(boundary)
            || "DURING_RENAME".equals(boundary)
            || "AFTER_RENAME_BEFORE_DIRECTORY_FSYNC".equals(boundary)
            || "AFTER_DIRECTORY_FSYNC".equals(boundary)
            || "AFTER_AUTHENTICATED_READBACK".equals(boundary);
    }

    private static boolean isClosedMarker(String state) {
        return state != null && (state.endsWith("COMPLETED")
            || "FAULT_COMPLETED".equals(state)
            || "FAULT_INVALIDATED".equals(state)
            || "LIFECYCLE_INVALIDATED".equals(state));
    }

    private static JSONObject reconcileCompletedFaultFixture(Context context, String boundary) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null
            || !"ph4CanonicalFaultBoundary".equals(marker.optString("caseId"))
            || !"FAULT_ACTIVE_PREPARED".equals(marker.optString("state"))) {
            return null;
        }
        String preparedBoundary = marker.optString("boundary", "");
        if (!preparedBoundary.isEmpty() && !boundary.equals(preparedBoundary)) {
            throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
        }
        if (preparedBoundary.isEmpty()
            && !marker.optString("tripId").contains(boundary.toLowerCase(java.util.Locale.ROOT))) {
            throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
        }
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject metadata = repository.getMetadata(marker.optString("tripId"));
        if (metadata == null) return null;
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        PhysicalHPh4Contract.requireExactCompletion(health, metadata, marker);
        requireNoPendingFaultIntake(context, marker.optString("tripId"));
        marker.put("state", "FAULT_COMPLETED");
        marker.put("reconciliationCode", "FAULT_FIXTURE_RECOVERED_BY_NORMAL_JOURNAL_INTAKE");
        PhysicalHCaseStore.write(context, marker);
        return completionReceipt("ph4CanonicalFaultBoundary", marker, health, metadata)
            .put("boundary", boundary)
            .put("faultTriggered", true)
            .put("reconciledExistingCompletion", true)
            .json();
    }

    private static void requireNoPendingFaultIntake(Context context, String tripId) throws Exception {
        JSONArray pending = DriveSenseCompletedTripJournal.pendingTripIds(context, 50);
        for (int i = 0; i < pending.length(); i++) {
            if (tripId.equals(pending.optString(i))) {
                throw new IllegalStateException("PHYSICAL_H_RECOVERED_FAULT_INTAKE_NOT_ACKNOWLEDGED");
            }
        }
    }

    private static void invalidateLostFaultFixture(Context context, String boundary) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        PhysicalHPh4Contract.requireMarker(marker, "ph4CanonicalFaultBoundary", "FAULT_ACTIVE_PREPARED");
        if (!marker.optString("tripId").contains(boundary.toLowerCase(java.util.Locale.ROOT))) {
            throw new IllegalStateException("PHYSICAL_H_FAULT_BOUNDARY_MISMATCH");
        }
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        PhysicalHPh4Contract.requireHealthyBaseline(health, marker.optLong("baselineLiveCount", -1L));
        if (repository.getMetadata(marker.optString("tripId")) != null) {
            throw new IllegalStateException("PHYSICAL_H_INVALIDATION_CANONICAL_TRIP_PRESENT");
        }
        JSONArray pending = DriveSenseCompletedTripJournal.pendingTripIds(context, 50);
        for (int i = 0; i < pending.length(); i++) {
            if (marker.optString("tripId").equals(pending.optString(i))) {
                throw new IllegalStateException("PHYSICAL_H_INVALIDATION_INTAKE_PRESENT");
            }
        }
        java.io.File activeRoot = new java.io.File(
            new java.io.File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"), "active_spools");
        java.io.File[] activeEntries = activeRoot.listFiles();
        if (activeEntries != null && activeEntries.length != 0) {
            throw new IllegalStateException("PHYSICAL_H_INVALIDATION_ACTIVE_SPOOL_PRESENT");
        }
        DriveSenseActiveTripCheckpointStore.clear(context);
        marker.put("state", "FAULT_INVALIDATED");
        marker.put("invalidationCode", "FAULT_RECEIPT_HARNESS_FAILED_AFTER_INTAKE_RETIREMENT");
        PhysicalHCaseStore.write(context, marker);
    }

    private static void invalidateLostLifecycleFixture(Context context) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        PhysicalHPh4Contract.requireMarker(marker, "activityAndRendererLifecycle", "LIFECYCLE_ARMED");
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        if (repository.getMetadata(marker.optString("tripId")) != null) {
            throw new IllegalStateException("PHYSICAL_H_INVALIDATION_CANONICAL_TRIP_PRESENT");
        }
        if (DriveSenseActiveTripCheckpointStore.getStatus(context, System.currentTimeMillis())
            .optBoolean("present", false)) {
            throw new IllegalStateException("PHYSICAL_H_INVALIDATION_CHECKPOINT_PRESENT");
        }
        java.io.File activeRoot = new java.io.File(
            new java.io.File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"), "active_spools");
        java.io.File[] activeEntries = activeRoot.listFiles();
        if (activeEntries != null && activeEntries.length != 0) {
            throw new IllegalStateException("PHYSICAL_H_INVALIDATION_ACTIVE_SPOOL_PRESENT");
        }
        marker.put("state", "LIFECYCLE_INVALIDATED");
        marker.put("invalidationCode", "NONCANONICAL_FIXTURE_RETIRED_BY_STALE_POLICY_BEFORE_GUARDED_RESUME");
        PhysicalHCaseStore.write(context, marker);
    }

    private static JSONObject recoverAndVerifyAfterReboot(Context context) throws Exception {
        requireCurrentHarness();
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        JSONObject marker = PhysicalHCaseStore.read(context);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        DriveSenseAutoTrackingService service = startHarnessService(context);
        JSONObject active = service.activeRouteStatusForTests();
        PhysicalHReceipt receipt = statusReceipt("recoverAndVerifyAfterReboot", "RECOVERED_FOR_VERIFICATION", repository, health, active)
            .put("restartExpected", false)
            .put("mutatesState", true);
        if (marker != null) {
            receipt.put("expectedPointCount", marker.optLong("expectedPointCount"));
            receipt.put("expectedHash", marker.optString("expectedHash"));
        }
        return receipt.json();
    }

    private static JSONObject armExternal(Context context, String caseName, String reason) throws Exception {
        PhysicalHCaseStore.write(context, new JSONObject()
            .put("version", 1).put("caseId", caseName).put("state", "ARMED_FOR_EXTERNAL_ACTION"));
        return receipt(caseName, "ARMED_FOR_EXTERNAL_ACTION", reason)
            .put("restartExpected", true)
            .put("mutatesState", true)
            .json();
    }

    private static DriveSenseAutoTrackingService startHarnessService(Context context) throws Exception {
        DriveSenseAutoTrackingService.setPhysicalHarnessProducerModeForTests(true);
        Intent intent = new Intent(context, DriveSenseAutoTrackingService.class).setAction(DriveSenseAutoTrackingService.ACTION_START);
        ContextCompat.startForegroundService(context, intent);
        long deadline = System.nanoTime() + 10_000_000_000L;
        DriveSenseAutoTrackingService service;
        while ((service = DriveSenseAutoTrackingService.physicalHarnessInstanceForTests()) == null && System.nanoTime() < deadline) {
            Thread.sleep(25L);
        }
        if (service == null) throw new IllegalStateException("PHYSICAL_H_SERVICE_START_TIMEOUT");
        // PREPARE callers may legitimately have no checkpoint yet. Recovery callers
        // retain their existing fail-closed active-status assertion immediately after
        // this bounded, guard-only recovery attempt.
        service.recoverActiveRouteForPhysicalHarness();
        return service;
    }

    private static PhysicalHReceipt statusReceipt(String caseId, String status,
                                                   DriveSenseTripArchiveRepository repository,
                                                   JSONObject health, JSONObject active) throws Exception {
        JSONObject aggregates = repository.aggregates(new JSONObject());
        int keyVersion = DriveSenseEnvelopeCrypto.activeKekVersion(repository.coordinator());
        DriveSenseEncryptedDomainRegistry.ReferenceProof proof = repository.coordinator().read(
            db -> DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(repository.coordinator().context(), db, keyVersion, false)
        );
        PhysicalHReceipt receipt = receipt(caseId, status, "BOUNDED_STATUS")
            .put("archiveGeneration", health.optString("archiveGeneration"))
            .put("authorityState", health.optString("authorityState"))
            .put("recoveryState", health.optString("recoveryState"))
            .put("sentinelPresent", health.optBoolean("sentinelPresent"))
            .put("sentinelMatches", health.optBoolean("sentinelMatches"))
            .put("liveCount", health.optLong("liveCount"))
            .put("lastCommittedSeq", health.optLong("lastCommittedSeq"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("speedGeneration", health.optJSONObject("speed") == null ? "" : health.optJSONObject("speed").optString("speedGeneration"))
            .put("speedBucketCount", health.optJSONObject("speed") == null ? 0L : health.optJSONObject("speed").optLong("speedBucketCount"))
            .put("speedRecoveryState", health.optJSONObject("speed") == null ? "" : health.optJSONObject("speed").optString("speedRecoveryState"))
            .put("aggregateLiveCount", aggregates.optLong("liveCount"))
            .put("aggregateDistance", aggregates.optDouble("totalDistance"))
            .put("keyVersion", keyVersion)
            .put("keyReferenceCount", proof.references())
            .put("payloadReadCount", payloadReadCount)
            .put("queryCount", queryCount)
            .put("queryRows", queryRows)
            .put("bridgeRequestByteMaximum", bridgeRequestByteMaximum)
            .put("bridgeResponseByteMaximum", bridgeResponseByteMaximum);
        if (active != null) {
            receipt.put("activeSpoolState", active.optString("state"))
                .put("sealedSegmentCount", active.optLong("sealed_segment_count"))
                .put("sealedSegmentBytes", active.optLong("sealed_plaintext_bytes"))
                .put("recentPointCount", active.optLong("recent_point_count"))
                .put("overviewPointCount", active.optLong("overview_point_count"))
                .put("currentBufferBytes", active.optLong("open_segment_bytes"))
                .put("maximumBufferedBytes", active.optLong("maximumBufferedBytes"))
                .put("maximumBufferedPoints", active.optLong("maximumBufferedPoints"))
                .put("maximum_resident_route_points", active.optLong("maximum_resident_route_points"))
                .put("processIncarnation", active.optString("process_incarnation"));
        }
        return receipt;
    }

    private static PhysicalHReceipt receipt(String caseId, String status, String code) {
        return new PhysicalHReceipt(caseId, status).put("code", boundedCode(code));
    }

    private static void requireCurrentHarness() {
        if (!BuildConfig.PHYSICAL_H_BUILD || BuildConfig.PHYSICAL_H_LEGACY_BUILD) {
            throw new IllegalStateException("PHYSICAL_H_CURRENT_BUILD_REQUIRED");
        }
    }

    private static void observeRequest(JSONObject request) {
        bridgeRequestByteMaximum = Math.max(bridgeRequestByteMaximum, request.toString().getBytes(StandardCharsets.UTF_8).length);
    }

    private static void observeResponse(JSONObject response) {
        bridgeResponseByteMaximum = Math.max(bridgeResponseByteMaximum, response.toString().getBytes(StandardCharsets.UTF_8).length);
    }

    private static long positive(Bundle args, String key, long fallback) {
        long value = nonNegative(args, key, fallback);
        if (value <= 0) throw new IllegalArgumentException("PHYSICAL_H_POSITIVE_ARGUMENT_REQUIRED:" + key);
        return value;
    }

    /** Instrumentation extras arrive as Strings, so Bundle.getLong would silently return the default. */
    private static long longValue(Bundle args, String key, long fallback) {
        if (args == null || !args.containsKey(key)) return fallback;
        return Long.parseLong(String.valueOf(args.get(key)));
    }

    private static long nonNegative(Bundle args, String key, long fallback) {
        if (args == null || !args.containsKey(key)) return fallback;
        long value = Long.parseLong(String.valueOf(args.get(key)));
        if (value < 0) throw new IllegalArgumentException("PHYSICAL_H_NEGATIVE_ARGUMENT:" + key);
        return value;
    }

    private static double nonNegativeDouble(Bundle args, String key, double fallback) {
        if (args == null || !args.containsKey(key)) return fallback;
        double value = Double.parseDouble(String.valueOf(args.get(key)));
        if (!Double.isFinite(value) || value < 0d) throw new IllegalArgumentException("PHYSICAL_H_INVALID_ARGUMENT:" + key);
        return value;
    }

    private static int integer(Bundle args, String key, int fallback) {
        if (args == null || !args.containsKey(key)) return fallback;
        return Integer.parseInt(String.valueOf(args.get(key)));
    }

    private static boolean booleanValue(Bundle args, String key, boolean fallback) {
        if (args == null || !args.containsKey(key)) return fallback;
        return Boolean.parseBoolean(String.valueOf(args.get(key)));
    }

    private static String boundedCode(String value) {
        String clean = value == null ? "PHYSICAL_H_UNSPECIFIED" : value.replaceAll("[^A-Za-z0-9_.:-]", "_");
        return clean.substring(0, Math.min(clean.length(), 160));
    }
}
