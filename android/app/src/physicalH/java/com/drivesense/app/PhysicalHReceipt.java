package com.drivesense.app;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** Bounded, scalar-only, privacy-safe evidence receipt. */
public final class PhysicalHReceipt {
    public static final int MAX_RECEIPT_BYTES = 16 * 1024;
    public static final int MAX_STRING_BYTES = 1024;

    private static final Set<String> SAFE_FIELDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "caseId", "status", "code", "reason", "packageId", "versionName", "versionCode",
        "sdkInt", "buildType", "legacyBuild", "androidId", "androidIdAvailable",
        "testAuthorityEnabled", "archiveGeneration",
        "authorityState", "recoveryState", "sentinelPresent", "sentinelMatches", "liveCount",
        "lastCommittedSeq", "pendingCount", "speedGeneration", "speedBucketCount",
        "speedRecoveryState", "activeSpoolState", "sealedSegmentCount", "sealedSegmentBytes",
        "recentPointCount", "overviewPointCount", "currentBufferBytes", "maximumBufferedBytes",
        "maximumBufferedPoints", "maxWriterBufferBytes", "maximum_resident_route_points",
        "queryCount", "queryRows", "payloadReadCount", "bridgeRequestByteMaximum",
        "bridgeResponseByteMaximum", "aggregateLiveCount", "aggregateDistance",
        "keyReferenceCount", "keyVersion", "operationState", "operationProgressItems",
        "operationProgressBytes", "processIncarnation", "pointCount", "generatedBytes", "stopWindowPointCount",
        "generatedDistanceMetres", "rollingHash", "nextMarker", "canonicalCount",
        "expectedPointCount", "expectedHash", "restartExpected", "mutatesState",
        "receiptBytes", "guardCode", "artifactSchemaVersion", "caseAliasCount",
        "caseAliasManifestHash", "maximumGeneratorResidentPoints",
        "baselineLiveCount", "expectedFinalLiveCount", "tripId", "phase", "boundary",
        "submittedPointCount", "recoveredPointCount", "boundedOpenTailPointLoss", "maximumOpenTailPoints",
        "lifecycleBackgrounded", "activityRecreated", "rendererTerminated", "projectionRecovered",
        "nativeAuthorityPreserved", "canonicalOwnershipPreserved", "duplicateCompletion",
        "strandedPending", "faultTriggered", "reconciledExistingCompletion", "externalAction", "finalPointCount",
        "scenario", "filesystemType", "totalBytes", "availableBytes", "fileCount", "fileBytes",
        "fileInventoryLimitExceeded", "fileInventoryLimit", "sqliteFullIntegrity",
        "sqliteSynchronous", "sqliteJournalMode", "sqliteIntegrity", "projectionOldVersion",
        "requiredBytes", "safetyFloorBytes", "admissionRefused", "keystoreSecurityLevel",
        "hardwareBacked", "wrapIvUnique", "aadRefused", "keyMaterialExportable",
        "missingKeyRefused", "recoveryRequired", "emptyAuthorityReported",
        "rotationComplete", "rewrappedCount", "payloadBytesRewritten", "oldAliasPresent",
        "sourceHash", "targetHash", "sourceAuthorityPreserved", "heapBeforeBytes",
        "heapAfterBytes", "pssBeforeKb", "pssAfterKb", "elapsedMs", "removedTripCount",
        "removedBucketCount", "generationChanged", "verified", "providerPublished",
        "leaseRefused", "payloadChunkCount", "overviewBytes"
    )));

    private final JSONObject value = new JSONObject();

    public PhysicalHReceipt(String caseId, String status) {
        put("caseId", caseId);
        put("status", status);
        put("artifactSchemaVersion", 1);
    }

    public PhysicalHReceipt put(String key, Object item) {
        if (!SAFE_FIELDS.contains(key)) throw new IllegalArgumentException("PHYSICAL_H_RECEIPT_FIELD_NOT_ALLOWED:" + key);
        if (item instanceof JSONObject || item instanceof org.json.JSONArray || item instanceof byte[]) {
            throw new IllegalArgumentException("PHYSICAL_H_RECEIPT_SCALAR_REQUIRED:" + key);
        }
        Object safe = item == null ? JSONObject.NULL : item;
        if (safe instanceof String && ((String) safe).getBytes(StandardCharsets.UTF_8).length > MAX_STRING_BYTES) {
            throw new IllegalArgumentException("PHYSICAL_H_RECEIPT_STRING_TOO_LARGE:" + key);
        }
        try {
            value.put(key, safe);
            enforceBound();
            return this;
        } catch (RuntimeException error) {
            value.remove(key);
            throw error;
        } catch (Exception error) {
            value.remove(key);
            throw new IllegalArgumentException(error);
        }
    }

    public JSONObject json() {
        try {
            JSONObject copy = new JSONObject(value.toString());
            copy.put("receiptBytes", value.toString().getBytes(StandardCharsets.UTF_8).length);
            if (copy.toString().getBytes(StandardCharsets.UTF_8).length > MAX_RECEIPT_BYTES) {
                throw new IllegalStateException("PHYSICAL_H_RECEIPT_TOO_LARGE");
            }
            return copy;
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private void enforceBound() {
        if (value.toString().getBytes(StandardCharsets.UTF_8).length > MAX_RECEIPT_BYTES) {
            throw new IllegalArgumentException("PHYSICAL_H_RECEIPT_TOO_LARGE");
        }
    }
}
