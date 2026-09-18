package com.drivesense.app;

import android.app.ActivityManager;
import android.content.Context;
import android.database.Cursor;
import android.os.Bundle;
import android.os.Debug;
import android.os.StatFs;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import android.security.keystore.KeyInfo;

/**
 * Guarded, argument-selected controls needed to finish A54-applicable PH-5..PH-11 work.
 * Every call reaches this class only through PhysicalHDriver's common destructive guard.
 */
final class PhysicalHRemainingPhases {
    static final Set<String> SCENARIOS = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(
        "PH5_FILESYSTEM_INSPECT",
        "PH5_PROJECTION_PREPARE",
        "PH5_PROJECTION_VERIFY",
        "PH6_ADMISSION_REFUSAL",
        "PH7_KEYSTORE_QUALIFY",
        "PH7_ROTATION_PREPARE",
        "PH7_ROTATION_BATCH",
        "PH7_KEY_LOSS_PREPARE",
        "PH7_KEY_LOSS_DELETE",
        "PH7_KEY_LOSS_VERIFY",
        "PH7_KEY_LOSS_RESTORE",
        "PH8_PRDE_MEASURE",
        "PH8_PRDE_REFUSAL",
        "PH9_ROLLOVER_EMPTY_GENERATION",
        "PH9_HISTORY_SEED",
        "PH9_SPEED_SEED",
        "PH9_DETAIL_STREAM_VERIFY",
        "PH9_SCALE_MEASURE",
        "PH10_MIGRATION_FIXTURE",
        "PH10_UPGRADE_MIGRATE_PREPARE",
        "PH10_UPGRADE_MIGRATE_VERIFY",
        "PH10_BACKUP_START",
        "PH10_BACKUP_STATUS",
        "PH10_BACKUP_PUBLISH",
        "PH10_BACKUP_RESTORE",
        "PH11_ERASURE_PREPARE",
        "PH11_ERASURE_TRIPS",
        "PH11_ERASURE_COMPLETE",
        "PH11_POST_ERASURE_VERIFY"
    )));

    private static final String BACKUP_SECRET = "physical-h-portable-fixture-v2";
    private static final long PORTABLE_WAIT_DEFAULT_SECONDS = 120L;
    private static final long PORTABLE_WAIT_MAX_SECONDS = 5_400L;
    // Must exactly match DriveSenseEnvelopeCrypto's production archive KEK namespace.
    // Physical H hashes this known case-scoped name; it never enumerates unrelated aliases.
    private static final String ENVELOPE_ALIAS_PREFIX = "roadsage_archive_kek_v";
    private static final String SPEED_CONTEXT =
        "indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1";

    private PhysicalHRemainingPhases() {}

    static JSONObject execute(Context context, Bundle arguments) throws Exception {
        requireCurrentHarness();
        String scenario = arguments == null ? "" : arguments.getString("scenario", "");
        scenario = scenario == null ? "" : scenario.trim().toUpperCase(Locale.ROOT);
        if (!SCENARIOS.contains(scenario)) {
            throw new IllegalArgumentException("PHYSICAL_H_REMAINING_SCENARIO_NOT_REVIEWED");
        }
        switch (scenario) {
            case "PH5_FILESYSTEM_INSPECT": return filesystemInspect(context, scenario);
            case "PH5_PROJECTION_PREPARE": return projectionPrepare(context, scenario, arguments);
            case "PH5_PROJECTION_VERIFY": return projectionVerify(context, scenario);
            case "PH6_ADMISSION_REFUSAL": return admissionRefusal(context, scenario, arguments);
            case "PH7_KEYSTORE_QUALIFY": return keystoreQualify(context, scenario);
            case "PH7_ROTATION_PREPARE": return rotationPrepare(context, scenario);
            case "PH7_ROTATION_BATCH": return rotationBatch(context, scenario, arguments);
            case "PH7_KEY_LOSS_PREPARE": return keyLossPrepare(context, scenario, arguments);
            case "PH7_KEY_LOSS_DELETE": return keyLossDelete(context, scenario, arguments);
            case "PH7_KEY_LOSS_VERIFY": return keyLossVerify(context, scenario);
            case "PH7_KEY_LOSS_RESTORE": return keyLossRestore(context, scenario, arguments);
            case "PH8_PRDE_MEASURE": return prdeMeasure(context, scenario, arguments);
            case "PH8_PRDE_REFUSAL": return prdeRefusal(context, scenario);
            case "PH9_ROLLOVER_EMPTY_GENERATION": return rolloverEmpty(context, scenario, arguments);
            case "PH9_HISTORY_SEED": return seedHistory(context, scenario, arguments);
            case "PH9_SPEED_SEED": return seedSpeed(context, scenario, arguments);
            case "PH9_DETAIL_STREAM_VERIFY": return detailStreamVerify(context, scenario, arguments);
            case "PH9_SCALE_MEASURE": return scaleMeasure(context, scenario);
            case "PH10_MIGRATION_FIXTURE": return migrationFixture(context, scenario, arguments);
            case "PH10_UPGRADE_MIGRATE_PREPARE": return upgradeMigratePrepare(context, scenario);
            case "PH10_UPGRADE_MIGRATE_VERIFY": return upgradeMigrateVerify(context, scenario);
            case "PH10_BACKUP_START": return backupStart(context, scenario, true, arguments);
            case "PH10_BACKUP_STATUS": return backupStatus(context, scenario);
            case "PH10_BACKUP_PUBLISH": return backupPublish(context, scenario);
            case "PH10_BACKUP_RESTORE": return backupRestore(context, scenario, arguments);
            case "PH11_ERASURE_PREPARE": return erasurePrepare(context, scenario);
            case "PH11_ERASURE_TRIPS": return erasureTrips(context, scenario);
            case "PH11_ERASURE_COMPLETE": return erasureComplete(context, scenario);
            case "PH11_POST_ERASURE_VERIFY": return postErasureVerify(context, scenario, arguments);
            default: throw new IllegalArgumentException("PHYSICAL_H_REMAINING_SCENARIO_NOT_REVIEWED");
        }
    }

    private static JSONObject filesystemInspect(Context context, String scenario) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        File data = context.getNoBackupFilesDir();
        StatFs stat = new StatFs(data.getAbsolutePath());
        // The SQLite reading comes FIRST. When the bounded walk ran first, its
        // typed 4,096-file refusal also suppressed the integrity reading at
        // scale, which is exactly what PH-9 hit at 20,000 trips.
        JSONObject sqlite = trips.coordinator().read(db -> {
            JSONObject value = new JSONObject();
            try (Cursor sync = db.rawQuery("PRAGMA synchronous", null);
                 Cursor journal = db.rawQuery("PRAGMA journal_mode", null);
                 Cursor quick = db.rawQuery("PRAGMA quick_check", null);
                 Cursor integrity = db.rawQuery("PRAGMA integrity_check", null)) {
                value.put("synchronous", sync.moveToFirst() ? sync.getInt(0) : -1);
                value.put("journal", journal.moveToFirst() ? journal.getString(0) : "");
                value.put("integrity", quick.moveToFirst() ? quick.getString(0) : "");
                value.put("fullIntegrity", integrity.moveToFirst() ? integrity.getString(0) : "");
            }
            return value;
        });
        long[] counts = boundedFileInventory(data, 4_096);
        return base(scenario, "PASS", "REAL_FILESYSTEM_INVENTORY")
            .put("filesystemType", stat.getClass().getSimpleName())
            .put("totalBytes", stat.getTotalBytes())
            .put("availableBytes", stat.getAvailableBytes())
            .put("fileCount", counts[0])
            .put("fileBytes", counts[1])
            .put("fileInventoryLimitExceeded", counts[2] == 1L)
            .put("fileInventoryLimit", 4_096)
            .put("sqliteSynchronous", sqlite.optInt("synchronous"))
            .put("sqliteJournalMode", sqlite.optString("journal"))
            .put("sqliteIntegrity", sqlite.optString("integrity"))
            .put("sqliteFullIntegrity", sqlite.optString("fullIntegrity"))
            .put("archiveGeneration", health.optString("archiveGeneration"))
            .put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("sentinelMatches", health.optBoolean("sentinelMatches"))
            .put("mutatesState", false).json();
    }

    private static JSONObject projectionPrepare(Context context, String scenario, Bundle arguments) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        long expected = expectedLive(arguments, health.optLong("liveCount", -1L));
        requireHealthy(health, expected, 0L);
        JSONObject marker = new JSONObject()
            .put("version", 3).put("caseId", "remainingPhaseControl")
            .put("state", "PH5_PROJECTION_ARMED")
            .put("baselineLiveCount", expected)
            .put("archiveGeneration", health.optString("archiveGeneration"));
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "ARMED_FOR_EXTERNAL_ACTION", "DELETE_ONLY_TEST_PROJECTION")
            .put("baselineLiveCount", expected)
            .put("archiveGeneration", health.optString("archiveGeneration"))
            .put("externalAction", "INSTRUMENTATION_DELETE_IDB_AND_RECREATE_RENDERER")
            .put("restartExpected", true).put("mutatesState", true).json();
    }

    private static JSONObject projectionVerify(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        requireMarker(marker, "PH5_PROJECTION_ARMED");
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        requireHealthy(health, marker.optLong("baselineLiveCount", -1L), 0L);
        JSONObject mismatch = trips.reportIndexedDbOpen("drivesense_mobile", 0L, 1L);
        if (!mismatch.optBoolean("generationMismatch") || !mismatch.optBoolean("canonicalDataSafe")) {
            throw new IllegalStateException("PHYSICAL_H_PROJECTION_MISMATCH_NOT_DETECTED");
        }
        marker.put("state", "PH5_PROJECTION_COMPLETED");
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "PROJECTION_REBUILD_FROM_NATIVE_REQUIRED")
            .put("projectionOldVersion", 0L).put("projectionRecovered", true)
            .put("nativeAuthorityPreserved", true)
            .put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("mutatesState", true).json();
    }

    private static JSONObject admissionRefusal(Context context, String scenario, Bundle arguments) throws Exception {
        long available = DriveSenseStorageAdmission.availableBytes(context);
        long reserve = 256L * 1024L * 1024L;
        long required = arguments != null && arguments.containsKey("requiredBytes")
            ? Long.parseLong(String.valueOf(arguments.get("requiredBytes")))
            : Math.max(1L, available - reserve + 1L);
        if (required < 1L) throw new IllegalArgumentException("PHYSICAL_H_REQUIRED_BYTES_INVALID");
        boolean refused = false;
        try {
            DriveSenseTripArchiveRepository.requireAdmissionForPhysicalHarness(context, required);
        } catch (IllegalStateException expected) {
            refused = expected.getMessage() != null && expected.getMessage().contains("LOW_SPACE_BLOCKED");
            if (!refused) throw expected;
        }
        if (!refused) throw new IllegalStateException("PHYSICAL_H_LOW_SPACE_REFUSAL_NOT_REACHED");
        JSONObject health = DriveSenseArchiveHealth.inventory(trips(context).coordinator());
        return base(scenario, "PASS", "REAL_STATFS_INFLATED_ESTIMATE_REFUSED")
            .put("availableBytes", available).put("requiredBytes", required)
            .put("safetyFloorBytes", Math.max(2L * 1024L * 1024L * 1024L, available / 10L))
            .put("admissionRefused", true).put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("mutatesState", false).json();
    }

    private static JSONObject keystoreQualify(Context context, String scenario) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        int version = DriveSenseEnvelopeCrypto.activeKekVersion(trips.coordinator());
        byte[] dek = DriveSenseEnvelopeCrypto.newDek();
        byte[] aad = DriveSenseEnvelopeCrypto.encode("physical-h", "keystore-qualification");
        DriveSenseEnvelopeCrypto.WrappedDek first = DriveSenseEnvelopeCrypto.wrapDek(dek, version, aad);
        DriveSenseEnvelopeCrypto.WrappedDek second = DriveSenseEnvelopeCrypto.wrapDek(dek, version, aad);
        byte[] unwrapped = DriveSenseEnvelopeCrypto.unwrapDek(first.ciphertext, first.nonce, version, aad);
        boolean exact = MessageDigest.isEqual(dek, unwrapped);
        boolean aadRefused = false;
        try {
            DriveSenseEnvelopeCrypto.unwrapDek(first.ciphertext, first.nonce, version,
                DriveSenseEnvelopeCrypto.encode("physical-h", "wrong-aad"));
        } catch (Exception expected) { aadRefused = true; }
        Arrays.fill(dek, (byte) 0); Arrays.fill(unwrapped, (byte) 0);
        if (!exact || !aadRefused || Arrays.equals(first.nonce, second.nonce)) {
            throw new IllegalStateException("PHYSICAL_H_KEYSTORE_ENVELOPE_INVARIANT_FAILED");
        }
        String alias = ENVELOPE_ALIAS_PREFIX + version;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(alias)) throw new IllegalStateException("PHYSICAL_H_EXPECTED_KEK_ALIAS_MISSING");
        SecretKey key = (SecretKey) store.getKey(alias, null);
        KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore")
            .getKeySpec(key, KeyInfo.class);
        String security = android.os.Build.VERSION.SDK_INT >= 31
            ? Integer.toString(info.getSecurityLevel()) : (info.isInsideSecureHardware() ? "HARDWARE" : "SOFTWARE");
        if (key.getEncoded() != null) throw new IllegalStateException("PHYSICAL_H_KEY_MATERIAL_EXPORTABLE");
        return base(scenario, "PASS", "ANDROID_KEYSTORE_CHARACTERIZED")
            .put("keyVersion", version).put("caseAliasCount", 1)
            .put("caseAliasManifestHash", sha256Hex(alias))
            .put("keystoreSecurityLevel", security)
            .put("hardwareBacked", info.isInsideSecureHardware())
            .put("wrapIvUnique", true).put("aadRefused", true)
            .put("keyMaterialExportable", key.getEncoded() != null)
            .put("mutatesState", true).json();
    }

    private static JSONObject rotationPrepare(Context context, String scenario) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        int current = DriveSenseEnvelopeCrypto.activeKekVersion(trips.coordinator());
        if (current != 1) throw new IllegalStateException("PHYSICAL_H_ROTATION_BASELINE_KEY_VERSION_MISMATCH");
        String oldAlias = ENVELOPE_ALIAS_PREFIX + current;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(oldAlias)) throw new IllegalStateException("PHYSICAL_H_ROTATION_OLD_ALIAS_MISSING");
        JSONObject marker = new JSONObject().put("version", 3).put("caseId", "remainingPhaseControl")
            .put("state", "PH7_ROTATION_ARMED").put("oldAliasHash", sha256Hex(oldAlias))
            .put("newAliasHash", sha256Hex(ENVELOPE_ALIAS_PREFIX + 2)).put("targetKeyVersion", 2);
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "EXACT_ROTATION_ALIAS_MANIFEST_SEALED")
            .put("keyVersion", current).put("caseAliasCount", 2)
            .put("caseAliasManifestHash", sha256Hex(oldAlias + "\n" + ENVELOPE_ALIAS_PREFIX + 2))
            .put("oldAliasPresent", true).put("mutatesState", true).json();
    }

    private static JSONObject rotationBatch(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !("PH7_ROTATION_ARMED".equals(marker.optString("state"))
            || "PH7_ROTATION_IN_PROGRESS".equals(marker.optString("state")))) {
            throw new IllegalStateException("PHYSICAL_H_ROTATION_ALIAS_MANIFEST_REQUIRED");
        }
        DriveSenseTripArchiveRepository trips = trips(context);
        int target = argInt(arguments, "targetKeyVersion", 2);
        int maxItems = argInt(arguments, "maxItems", 25);
        if (target != 2) throw new IllegalArgumentException("PHYSICAL_H_ROTATION_TARGET_NOT_REVIEWED");
        if (!sha256Hex(ENVELOPE_ALIAS_PREFIX + 1).equals(marker.optString("oldAliasHash"))
            || !sha256Hex(ENVELOPE_ALIAS_PREFIX + target).equals(marker.optString("newAliasHash"))) {
            throw new SecurityException("PHYSICAL_H_ALIAS_MANIFEST_MISMATCH");
        }
        JSONObject result = new DriveSenseEnvelopeKeyRotation(trips.coordinator()).rotateBatch(target, maxItems);
        marker.put("state", result.optBoolean("complete") ? "PH7_ROTATION_COMPLETE" : "PH7_ROTATION_IN_PROGRESS");
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", result.optBoolean("complete") ? "ROTATION_COMPLETE" : "ROTATION_BATCH_COMMITTED")
            .put("keyVersion", target).put("rotationComplete", result.optBoolean("complete"))
            .put("rewrappedCount", result.optLong("rewrapped"))
            .put("keyReferenceCount", result.optLong("remaining"))
            .put("payloadBytesRewritten", result.optLong("payloadBytesRewritten"))
            .put("mutatesState", true).json();
    }

    private static JSONObject keyLossPrepare(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject backup = backupStart(context, "PH7_KEY_LOSS_BACKUP", true, arguments);
        JSONObject marker = PhysicalHCaseStore.read(context);
        marker.put("state", "PH7_KEY_LOSS_BACKUP_RUNNING");
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "PORTABLE_BACKUP_VERIFIED_BEFORE_KEY_LOSS")
            .put("operationState", backup.optString("operationState"))
            .put("verified", marker.optBoolean("backupVerified"))
            .put("nextMarker", "DELETE_EXACT_MANIFEST_ALIAS")
            .put("mutatesState", true).json();
    }

    private static JSONObject keyLossDelete(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !marker.optBoolean("backupVerified")) {
            throw new IllegalStateException("PHYSICAL_H_VERIFIED_BACKUP_REQUIRED");
        }
        int version = argInt(arguments, "keyVersion", 2);
        String alias = ENVELOPE_ALIAS_PREFIX + version;
        if (!sha256Hex(alias).equals(marker.optString("approvedAliasHash"))) {
            throw new SecurityException("PHYSICAL_H_ALIAS_MANIFEST_MISMATCH");
        }
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(alias)) throw new IllegalStateException("PHYSICAL_H_CASE_ALIAS_MISSING");
        store.deleteEntry(alias);
        store.load(null);
        if (store.containsAlias(alias)) throw new IllegalStateException("PHYSICAL_H_CASE_ALIAS_DELETE_FAILED");
        marker.put("state", "PH7_KEY_LOST"); PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "EXACT_MANIFEST_ALIAS_DELETED")
            .put("keyVersion", version).put("caseAliasManifestHash", sha256Hex(alias))
            .put("oldAliasPresent", false).put("restartExpected", true)
            .put("mutatesState", true).json();
    }

    private static JSONObject keyLossRestore(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context); requireMarker(marker, "PH7_KEY_LOST");
        DriveSenseTripArchiveRepository trips = trips(context);
        trips.rolloverGenerationForIdentityErasure("physical_h_ph7_key_loss_restore");
        new DriveSenseSpeedArchiveRepository(context).rolloverGeneration("physical_h_ph7_key_loss_restore");
        DriveSenseActiveTripSpool.eraseAllForDataRights(context);
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips, new DriveSenseSpeedArchiveRepository(context));
        recoverVerifiedBackup(manager, marker);
        JSONObject started = manager.beginRestore(marker.getString("backupOperationId"), BACKUP_SECRET);
        marker.put("state", "PH7_KEY_LOSS_RESTORE_RUNNING");
        marker.put("restoreOperationId", started.getString("operationId"));
        JSONObject restored = awaitPortableOperation(manager, started.getString("operationId"),
            portableWaitMs(arguments));
        if (!restored.optBoolean("verified")) throw new IllegalStateException("PHYSICAL_H_KEY_LOSS_RESTORE_NOT_VERIFIED");
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        long speedCount = new DriveSenseSpeedArchiveRepository(context).state().optLong("bucketCount");
        if (health.optLong("liveCount", -1L) != marker.optLong("backupLiveCount", -2L)
            || speedCount != marker.optLong("backupSpeedBucketCount", -2L)) {
            throw new IllegalStateException("PHYSICAL_H_RESTORE_DOMAIN_COUNT_MISMATCH");
        }
        marker.put("restoreVerified", true).put("state", "PH7_KEY_LOSS_RESTORED");
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "FRESH_GENERATION_RESTORE_VERIFIED")
            .put("operationState", restored.optString("phase"))
            .put("verified", true).put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("nextMarker", "NEXT_PHASE")
            .put("mutatesState", true).json();
    }

    private static JSONObject keyLossVerify(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context); requireMarker(marker, "PH7_KEY_LOST");
        String alias = ENVELOPE_ALIAS_PREFIX + 2;
        if (!sha256Hex(alias).equals(marker.optString("approvedAliasHash"))) {
            throw new SecurityException("PHYSICAL_H_ALIAS_MANIFEST_MISMATCH");
        }
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) throw new IllegalStateException("PHYSICAL_H_CASE_ALIAS_UNEXPECTEDLY_PRESENT");
        DriveSenseTripArchiveRepository trips = trips(context);
        boolean typedMissingKey = false;
        try {
            trips.queryHistoryPage(new JSONObject().put("maxItems", 1).put("maxBytes", 64 * 1024));
        } catch (IllegalStateException expected) {
            typedMissingKey = "Archive KEK version is unavailable".equals(expected.getMessage());
            if (!typedMissingKey) throw expected;
        }
        if (!typedMissingKey) throw new IllegalStateException("PHYSICAL_H_MISSING_KEY_READ_NOT_REFUSED");
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        return base(scenario, "PASS", "TYPED_MISSING_KEK_RECOVERY_REQUIRED")
            .put("keyVersion", 2).put("caseAliasManifestHash", sha256Hex(alias))
            .put("missingKeyRefused", true).put("recoveryRequired", true)
            .put("emptyAuthorityReported", false).put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("sentinelMatches", health.optBoolean("sentinelMatches"))
            .put("mutatesState", false).json();
    }

    private static JSONObject prdeMeasure(Context context, String scenario, Bundle arguments) throws Exception {
        int cells = argInt(arguments, "cells", 64);
        if (cells < 1 || cells > 2_048) throw new IllegalArgumentException("PHYSICAL_H_PRDE_CELL_COUNT_OUT_OF_RANGE");
        JSONObject model = speedModel(cells);
        long heapBefore = heapUsed(); long pssBefore = Debug.getPss(); long startedAt = System.nanoTime();
        byte[] ciphertext = Base64.decode(DriveSensePayloadCrypto.encrypt(model.toString(), SPEED_CONTEXT, 3), Base64.NO_WRAP);
        String hash = hex(MessageDigest.getInstance("SHA-256").digest(ciphertext));
        DriveSenseLegacySpeedMigration migration = new DriveSenseLegacySpeedMigration(
            context, new DriveSenseSpeedArchiveRepository(context));
        JSONObject descriptor = new JSONObject().put("sourceId", "physical-h-prde-" + cells)
            .put("sourceContext", SPEED_CONTEXT).put("sourceCiphertextHash", hash)
            .put("sourceRevision", cells).put("keyVersion", 3)
            .put("expectedCiphertextBytes", ciphertext.length);
        JSONObject begin = migration.begin(descriptor);
        if (DriveSenseLegacySpeedMigration.BLOCKED_RESOURCE.equals(begin.optString("state"))) {
            return base(scenario, "SAFE_REFUSAL", DriveSenseLegacySpeedMigration.BLOCKED_RESOURCE)
                .put("sourceHash", hash).put("sourceAuthorityPreserved", true)
                .put("availableBytes", DriveSenseStorageAdmission.availableBytes(context))
                .put("mutatesState", false).json();
        }
        String operation = begin.getString("operationId");
        int chunkIndex = 0;
        for (int offset = 0; offset < ciphertext.length; offset += DriveSenseLegacySpeedMigration.BRIDGE_CHUNK_BYTES) {
            byte[] part = Arrays.copyOfRange(ciphertext, offset,
                Math.min(ciphertext.length, offset + DriveSenseLegacySpeedMigration.BRIDGE_CHUNK_BYTES));
            try { migration.append(operation, chunkIndex++, Base64.encodeToString(part, Base64.NO_WRAP)); }
            finally { Arrays.fill(part, (byte) 0); }
        }
        JSONObject result = migration.execute(operation);
        long elapsed = (System.nanoTime() - startedAt) / 1_000_000L;
        long heapAfter = heapUsed(); long pssAfter = Debug.getPss();
        Arrays.fill(ciphertext, (byte) 0);
        if (!"VERIFIED".equals(result.optString("state")) || !result.optBoolean("plaintextReleasedBeforeCommit")) {
            throw new IllegalStateException("PHYSICAL_H_PRDE_VERIFICATION_FAILED");
        }
        return base(scenario, "PASS", "PRDE1_VERIFIED")
            .put("pointCount", cells).put("sourceHash", hash)
            .put("heapBeforeBytes", heapBefore).put("heapAfterBytes", heapAfter)
            .put("pssBeforeKb", pssBefore).put("pssAfterKb", pssAfter)
            .put("elapsedMs", elapsed).put("sourceAuthorityPreserved", true)
            .put("mutatesState", true).json();
    }

    private static JSONObject prdeRefusal(Context context, String scenario) throws Exception {
        DriveSenseLegacySpeedMigration migration = new DriveSenseLegacySpeedMigration(
            context, new DriveSenseSpeedArchiveRepository(context));
        JSONObject descriptor = new JSONObject().put("sourceId", "physical-h-prde-over-admission")
            .put("sourceContext", SPEED_CONTEXT).put("sourceCiphertextHash", "0".repeat(64))
            .put("sourceRevision", 1).put("keyVersion", 3)
            .put("expectedCiphertextBytes", Integer.MAX_VALUE - 8L);
        JSONObject refused = migration.begin(descriptor);
        if (!DriveSenseLegacySpeedMigration.BLOCKED_RESOURCE.equals(refused.optString("state"))
            || !refused.optBoolean("legacyAuthorityPreserved")) {
            throw new IllegalStateException("PHYSICAL_H_PRDE_OVER_ADMISSION_NOT_REFUSED");
        }
        return base(scenario, "PASS", DriveSenseLegacySpeedMigration.BLOCKED_RESOURCE)
            .put("requiredBytes", refused.optLong("requiredDiskBytes"))
            .put("availableBytes", DriveSenseStorageAdmission.availableBytes(context))
            .put("sourceAuthorityPreserved", true).put("admissionRefused", true)
            .put("mutatesState", false).json();
    }

    private static JSONObject rolloverEmpty(Context context, String scenario, Bundle arguments) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject before = DriveSenseArchiveHealth.inventory(trips.coordinator());
        long expected = expectedLive(arguments, before.optLong("liveCount", -1L));
        requireHealthy(before, expected, 0L);
        JSONObject tripResult = trips.rolloverGenerationForIdentityErasure("physical_h_empty_generation");
        JSONObject speedResult = new DriveSenseSpeedArchiveRepository(context)
            .rolloverGeneration("physical_h_empty_generation");
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        DriveSenseActiveTripSpool.eraseAllForDataRights(context);
        JSONObject after = DriveSenseArchiveHealth.inventory(trips.coordinator());
        requireHealthy(after, 0L, 0L);
        return base(scenario, "PASS", "VERIFIED_SYNTHETIC_GENERATION_ROLLOVER")
            .put("removedTripCount", tripResult.optLong("removedTripCount"))
            .put("removedBucketCount", speedResult.optLong("removedBucketCount"))
            .put("generationChanged", !before.optString("archiveGeneration").equals(after.optString("archiveGeneration")))
            .put("archiveGeneration", after.optString("archiveGeneration"))
            .put("liveCount", 0L).put("pendingCount", 0L).put("mutatesState", true).json();
    }

    private static JSONObject seedHistory(Context context, String scenario, Bundle arguments) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        long current = trips.aggregates(new JSONObject()).optLong("liveCount");
        long target = argLong(arguments, "targetCount", 100L);
        int limit = argInt(arguments, "maxPerInvocation", 250);
        if (target < current || target > 20_000L || limit < 1 || limit > 500) {
            throw new IllegalArgumentException("PHYSICAL_H_HISTORY_SEED_RANGE_INVALID");
        }
        File spool = new File(context.getCacheDir(), "physical-h-history-minimal.json");
        long stop = Math.min(target, current + limit);
        for (long index = current; index < stop; index++) {
            String id = String.format(Locale.ROOT, "physical-h-scale-%05d", index);
            byte[] bytes = ("{\"id\":\"" + id + "\",\"start_time\":" + (1_810_000_000_000L + index * 1000L)
                + ",\"end_time\":" + (1_810_000_000_500L + index * 1000L)
                + ",\"status\":\"completed\",\"point_count\":0,\"route_points\":[]}")
                .getBytes(StandardCharsets.UTF_8);
            writeSync(spool, bytes); trips.commitSpool(spool, id, "physical_h_scale_seed");
        }
        if (spool.exists() && !spool.delete()) throw new IllegalStateException("PHYSICAL_H_SEED_TEMP_DELETE_FAILED");
        long finalCount = trips.aggregates(new JSONObject()).optLong("liveCount");
        return base(scenario, finalCount == target ? "PASS" : "PROGRESS", "BOUNDED_NATIVE_HISTORY_SEED")
            .put("baselineLiveCount", current).put("expectedFinalLiveCount", target)
            .put("canonicalCount", finalCount).put("operationProgressItems", finalCount - current)
            .put("nextMarker", finalCount == target ? "MEASURE" : "REPEAT_SEED")
            .put("mutatesState", true).json();
    }

    private static JSONObject seedSpeed(Context context, String scenario, Bundle arguments) throws Exception {
        DriveSenseSpeedArchiveRepository speed = new DriveSenseSpeedArchiveRepository(context);
        long current = speed.state().optLong("bucketCount");
        long target = argLong(arguments, "targetCount", 100L);
        int limit = argInt(arguments, "maxPerInvocation", 100);
        if (target < current || target > 10_000L || limit < 1 || limit > 250) {
            throw new IllegalArgumentException("PHYSICAL_H_SPEED_SEED_RANGE_INVALID");
        }
        File spool = new File(context.getCacheDir(), "physical-h-speed-minimal.json");
        long stop = Math.min(target, current + limit);
        for (long index = current; index < stop; index++) {
            String bucket = prefix4(index);
            byte[] bytes = new JSONObject().put("bucketId", bucket).put("schemaVersion", 1)
                .put("cells", new JSONObject().put(bucket + "00", new JSONObject().put("speedLimitKmh", 50)))
                .toString().getBytes(StandardCharsets.UTF_8);
            writeSync(spool, bytes);
            speed.restoreSpool(spool, bucket, 1, MessageDigest.getInstance("SHA-256").digest(bytes));
        }
        if (spool.exists() && !spool.delete()) throw new IllegalStateException("PHYSICAL_H_SEED_TEMP_DELETE_FAILED");
        long finalCount = speed.state().optLong("bucketCount");
        return base(scenario, finalCount == target ? "PASS" : "PROGRESS", "BOUNDED_NATIVE_SPEED_SEED")
            .put("speedBucketCount", finalCount).put("expectedFinalLiveCount", target)
            .put("operationProgressItems", finalCount - current)
            .put("nextMarker", finalCount == target ? "MEASURE" : "REPEAT_SEED")
            .put("mutatesState", true).json();
    }

    private static JSONObject scaleMeasure(Context context, String scenario) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        long started = System.nanoTime();
        JSONObject aggregates = trips.aggregates(new JSONObject());
        JSONObject page = trips.queryHistoryPage(new JSONObject().put("maxItems", 50).put("maxBytes", 256 * 1024));
        long elapsed = (System.nanoTime() - started) / 1_000_000L;
        JSONObject speed = new DriveSenseSpeedArchiveRepository(context).state();
        return base(scenario, "PASS", "BOUNDED_SCALE_MEASUREMENT")
            .put("canonicalCount", aggregates.optLong("liveCount"))
            .put("queryRows", page.optLong("itemCount"))
            .put("speedBucketCount", speed.optLong("bucketCount"))
            .put("elapsedMs", elapsed).put("heapAfterBytes", heapUsed())
            .put("pssAfterKb", Debug.getPss()).put("mutatesState", false).json();
    }

    private static JSONObject detailStreamVerify(Context context, String scenario, Bundle arguments) throws Exception {
        String tripId = arguments == null ? "" : arguments.getString("tripId", "");
        if (tripId == null || tripId.isEmpty()) throw new IllegalArgumentException("PHYSICAL_H_TRIP_ID_REQUIRED");
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject metadata = trips.getMetadata(tripId);
        if (metadata == null) throw new IllegalStateException("PHYSICAL_H_DETAIL_TRIP_MISSING");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long bytes = 0L; int chunks = 0;
        try (DriveSenseTripArchiveRepository.PayloadDescriptor descriptor = trips.descriptor(tripId, null)) {
            if (descriptor == null) throw new IllegalStateException("PHYSICAL_H_DETAIL_DESCRIPTOR_MISSING");
            for (int index = 0; index < descriptor.chunkCount; index++) {
                byte[] part = trips.readPayloadChunk(descriptor, index);
                try { digest.update(part); bytes += part.length; chunks++; }
                finally { Arrays.fill(part, (byte) 0); }
            }
            if (bytes != descriptor.plaintextBytes || !MessageDigest.isEqual(digest.digest(), descriptor.payloadHash)) {
                throw new IllegalStateException("PHYSICAL_H_DETAIL_STREAM_HASH_MISMATCH");
            }
        }
        byte[] overview = trips.overview(tripId, 900);
        int overviewBytes = overview == null ? 0 : overview.length;
        if (overview != null) Arrays.fill(overview, (byte) 0);
        return base(scenario, "PASS", "EXACT_CANONICAL_STREAM_AND_BOUNDED_OVERVIEW")
            .put("tripId", tripId).put("operationProgressBytes", bytes)
            .put("payloadChunkCount", chunks).put("overviewBytes", overviewBytes)
            .put("finalPointCount", metadata.optLong("point_count"))
            .put("mutatesState", false).json();
    }

    private static JSONObject migrationFixture(Context context, String scenario, Bundle arguments) throws Exception {
        String suffix = arguments == null ? "normal" : arguments.getString("fixture", "normal");
        String id = "physical-h-migration-" + safeToken(suffix);
        byte[] source = ("{\"id\":\"" + id + "\",\"start_time\":1815000000000,\"end_time\":1815000060000,"
            + "\"status\":\"completed\",\"route_points\":[]}").getBytes(StandardCharsets.UTF_8);
        String hash = hex(MessageDigest.getInstance("SHA-256").digest(source));
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(trips(context));
        JSONObject begun = migration.begin(id, hash, source.length);
        String operation = begun.getString("operationId");
        migration.append(operation, 0, Base64.encodeToString(source, Base64.NO_WRAP));
        JSONObject committed = migration.finish(operation);
        JSONObject completed = migration.complete(1, 1, 0, hash);
        if (!completed.optBoolean("verified")) throw new IllegalStateException("PHYSICAL_H_MIGRATION_NOT_VERIFIED");
        return base(scenario, "PASS", "BOUNDED_MIGRATION_FIXTURE_VERIFIED")
            .put("tripId", id).put("sourceHash", hash)
            .put("targetHash", committed.optString("payloadHash"))
            .put("sourceAuthorityPreserved", true).put("verified", true)
            .put("mutatesState", true).json();
    }

    private static JSONObject upgradeMigratePrepare(Context context, String scenario) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        requireHealthy(health, 0L, 0L);
        PhysicalHCaseStore.write(context, new JSONObject().put("version", 3)
            .put("caseId", "remainingPhaseControl").put("state", "PH10_UPGRADE_MIGRATION_ARMED"));
        return base(scenario, "ARMED_FOR_EXTERNAL_ACTION", "MIGRATE_LEGACY_IDB_THROUGH_NATIVE_PLUGIN")
            .put("externalAction", "INSTRUMENTATION_STREAM_LEGACY_IDB")
            .put("mutatesState", true).json();
    }

    private static JSONObject upgradeMigrateVerify(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context); requireMarker(marker, "PH10_UPGRADE_MIGRATION_ARMED");
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        requireHealthy(health, 1L, 0L);
        if (trips.getMetadata("physical-h-legacy-upgrade-trip") == null) {
            throw new IllegalStateException("PHYSICAL_H_UPGRADE_TRIP_MISSING");
        }
        long speedCount = new DriveSenseSpeedArchiveRepository(context).state().optLong("bucketCount");
        if (speedCount < 1L) throw new IllegalStateException("PHYSICAL_H_UPGRADE_SPEED_MISSING");
        marker.put("state", "PH10_UPGRADE_MIGRATION_COMPLETE"); PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "LEGACY_TO_CURRENT_UPGRADE_VERIFIED")
            .put("liveCount", 1L).put("pendingCount", 0L).put("speedBucketCount", speedCount)
            .put("sourceAuthorityPreserved", true).put("verified", true)
            .put("mutatesState", true).json();
    }

    private static JSONObject backupStart(Context context, String scenario, boolean awaitVerification) throws Exception {
        return backupStart(context, scenario, awaitVerification, null);
    }

    private static JSONObject backupStart(Context context, String scenario, boolean awaitVerification,
                                          Bundle arguments) throws Exception {
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        JSONObject speedState = new DriveSenseSpeedArchiveRepository(context).state();
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips, new DriveSenseSpeedArchiveRepository(context));
        JSONObject started = manager.begin("physical-h-portable-v2", BACKUP_SECRET);
        JSONObject marker = new JSONObject().put("version", 3).put("caseId", "remainingPhaseControl")
            .put("state", "PH10_BACKUP_RUNNING").put("backupOperationId", started.getString("operationId"))
            .put("approvedAliasHash", sha256Hex(ENVELOPE_ALIAS_PREFIX + 2))
            .put("backupLiveCount", health.optLong("liveCount"))
            .put("backupSpeedBucketCount", speedState.optLong("bucketCount"));
        if (awaitVerification) {
            JSONObject completed = awaitPortableOperation(manager, started.getString("operationId"),
                portableWaitMs(arguments));
            if (!completed.optBoolean("verified")) throw new IllegalStateException("PHYSICAL_H_BACKUP_NOT_VERIFIED");
            String nativePath = completed.getString("nativePath");
            marker.put("backupVerified", true).put("backupNativePath", nativePath)
                .put("backupSha256", sha256File(new File(nativePath)));
            started = completed;
        }
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, awaitVerification ? "PASS" : "STARTED",
            awaitVerification ? "PORTABLE_BACKUP_V2_VERIFIED" : "PORTABLE_BACKUP_V2_STARTED")
            .put("operationState", started.optString("phase"))
            .put("verified", started.optBoolean("verified"))
            .put("nextMarker", awaitVerification ? "NEXT_PHASE" : "POLL_BACKUP_STATUS")
            .put("mutatesState", true).json();
    }

    private static JSONObject backupStatus(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !marker.has("backupOperationId")) throw new IllegalStateException("PHYSICAL_H_BACKUP_MARKER_MISSING");
        if (marker.optBoolean("restoreVerified")) {
            return base(scenario, "PASS", "PORTABLE_OPERATION_VERIFIED")
                .put("operationState", "COMPLETE").put("verified", true)
                .put("nextMarker", "NEXT_PHASE").put("mutatesState", false).json();
        }
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips(context), new DriveSenseSpeedArchiveRepository(context));
        if (marker.optBoolean("backupVerified")) recoverVerifiedBackup(manager, marker);
        String operationId = marker.optString("restoreOperationId", marker.getString("backupOperationId"));
        JSONObject status = manager.status(operationId);
        boolean complete = status.optBoolean("done") && status.optBoolean("verified");
        if (complete && !marker.has("restoreOperationId")) marker.put("backupVerified", true);
        if (complete && marker.has("restoreOperationId")) {
            JSONObject health = DriveSenseArchiveHealth.inventory(trips(context).coordinator());
            long speedCount = new DriveSenseSpeedArchiveRepository(context).state().optLong("bucketCount");
            if (health.optLong("liveCount", -1L) != marker.optLong("backupLiveCount", -2L)
                || speedCount != marker.optLong("backupSpeedBucketCount", -2L)) {
                throw new IllegalStateException("PHYSICAL_H_RESTORE_DOMAIN_COUNT_MISMATCH");
            }
            marker.put("restoreVerified", true);
        }
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, complete ? "PASS" : "PROGRESS", complete ? "PORTABLE_OPERATION_VERIFIED" : "PORTABLE_OPERATION_RUNNING")
            .put("operationState", status.optString("phase"))
            .put("operationProgressItems", status.optLong("completedItems"))
            .put("operationProgressBytes", status.optLong("completedBytes"))
            .put("verified", complete).put("nextMarker", complete ? "NEXT_PHASE" : "POLL_AGAIN")
            .put("mutatesState", true).json();
    }

    private static JSONObject backupPublish(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !marker.optBoolean("backupVerified")) throw new IllegalStateException("PHYSICAL_H_VERIFIED_BACKUP_REQUIRED");
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips(context), new DriveSenseSpeedArchiveRepository(context));
        recoverVerifiedBackup(manager, marker);
        JSONObject published = manager.publish(marker.getString("backupOperationId"));
        if (!published.optBoolean("published")) throw new IllegalStateException("PHYSICAL_H_PROVIDER_PUBLISH_FAILED");
        return base(scenario, "PASS", "REAL_ANDROID_PROVIDER_PUBLISH_VERIFIED")
            .put("providerPublished", true).put("mutatesState", true).json();
    }

    private static JSONObject backupRestore(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !marker.optBoolean("backupVerified")) throw new IllegalStateException("PHYSICAL_H_VERIFIED_BACKUP_REQUIRED");
        DriveSenseTripArchiveRepository trips = trips(context);
        trips.rolloverGenerationForIdentityErasure("physical_h_ph10_restore_fresh_generation");
        new DriveSenseSpeedArchiveRepository(context).rolloverGeneration("physical_h_ph10_restore_fresh_generation");
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        DriveSenseActiveTripSpool.eraseAllForDataRights(context);
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips, new DriveSenseSpeedArchiveRepository(context));
        recoverVerifiedBackup(manager, marker);
        JSONObject started = manager.beginRestore(marker.getString("backupOperationId"), BACKUP_SECRET);
        marker.put("restoreOperationId", started.getString("operationId"));
        JSONObject restored = awaitPortableOperation(manager, started.getString("operationId"),
            portableWaitMs(arguments));
        if (!restored.optBoolean("verified")) throw new IllegalStateException("PHYSICAL_H_BACKUP_RESTORE_NOT_VERIFIED");
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        long speedCount = new DriveSenseSpeedArchiveRepository(context).state().optLong("bucketCount");
        if (health.optLong("liveCount", -1L) != marker.optLong("backupLiveCount", -2L)
            || speedCount != marker.optLong("backupSpeedBucketCount", -2L)) {
            throw new IllegalStateException("PHYSICAL_H_RESTORE_DOMAIN_COUNT_MISMATCH");
        }
        marker.put("restoreVerified", true);
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "PORTABLE_RESTORE_VERIFIED")
            .put("operationState", restored.optString("phase"))
            .put("verified", true).put("liveCount", health.optLong("liveCount"))
            .put("pendingCount", health.optLong("pendingCount"))
            .put("nextMarker", "NEXT_PHASE")
            .put("mutatesState", true).json();
    }

    private static JSONObject erasurePrepare(Context context, String scenario) throws Exception {
        java.util.concurrent.CountDownLatch leaseReached = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch releaseBackup = new java.util.concurrent.CountDownLatch(1);
        DriveSenseStreamBackupManager.setTestHookForTests((point, operationId) -> {
            if ("AFTER_EXPORT_LEASE".equals(point)) {
                leaseReached.countDown();
                if (!releaseBackup.await(30, java.util.concurrent.TimeUnit.SECONDS)) {
                    throw new IllegalStateException("PHYSICAL_H_ERASURE_LEASE_HOLD_TIMEOUT");
                }
            }
        });
        JSONObject backup = backupStart(context, "PH11_ERASURE_BACKUP", false);
        if (!leaseReached.await(30, java.util.concurrent.TimeUnit.SECONDS)) {
            releaseBackup.countDown(); DriveSenseStreamBackupManager.setTestHookForTests(null);
            throw new IllegalStateException("PHYSICAL_H_EXPORT_LEASE_NOT_REACHED");
        }
        boolean refused = false;
        try {
            trips(context).rolloverGenerationForIdentityErasure("physical_h_ph11_lease_refusal");
        } catch (IllegalStateException expected) {
            refused = "EXPORT_SNAPSHOT_CONFLICT_RETRY".equals(expected.getMessage());
            if (!refused) throw expected;
        } finally {
            releaseBackup.countDown(); DriveSenseStreamBackupManager.setTestHookForTests(null);
        }
        if (!refused) throw new IllegalStateException("PHYSICAL_H_ERASURE_LEASE_REFUSAL_MISSING");
        JSONObject marker = PhysicalHCaseStore.read(context);
        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(
            context, trips(context), new DriveSenseSpeedArchiveRepository(context));
        JSONObject completed = awaitPortableOperation(manager, marker.getString("backupOperationId"),
            portableWaitMs(null));
        if (!completed.optBoolean("verified")) throw new IllegalStateException("PHYSICAL_H_ERASURE_BACKUP_NOT_VERIFIED");
        String nativePath = completed.getString("nativePath");
        marker.put("state", "PH11_BACKUP_VERIFIED").put("backupVerified", true)
            .put("backupNativePath", nativePath).put("backupSha256", sha256File(new File(nativePath)));
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "ERASURE_PORTABLE_BACKUP_VERIFIED")
            .put("operationState", completed.optString("phase"))
            .put("leaseRefused", true)
            .put("verified", true).put("nextMarker", "ERASE_TRIPS")
            .put("mutatesState", true).json();
    }

    private static JSONObject erasureTrips(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context);
        if (marker == null || !marker.optBoolean("backupVerified")) throw new IllegalStateException("PHYSICAL_H_VERIFIED_BACKUP_REQUIRED");
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject before = DriveSenseArchiveHealth.inventory(trips.coordinator());
        JSONObject result = trips.rolloverGenerationForIdentityErasure("physical_h_ph11_interrupted");
        marker.put("state", "PH11_TRIP_GENERATION_ROLLED");
        marker.put("priorGeneration", before.optString("archiveGeneration"));
        marker.put("archiveGeneration", result.optString("archiveGeneration"));
        PhysicalHCaseStore.write(context, marker);
        return base(scenario, "ARMED_FOR_EXTERNAL_ACTION", "TRIP_GENERATION_ROLLED_BEFORE_REMAINING_DOMAINS")
            .put("removedTripCount", result.optLong("removedTripCount"))
            .put("generationChanged", true).put("externalAction", "KILL_APP_PROCESS_NOT_FORCE_STOP")
            .put("restartExpected", true).put("mutatesState", true).json();
    }

    private static JSONObject erasureComplete(Context context, String scenario) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context); requireMarker(marker, "PH11_TRIP_GENERATION_ROLLED");
        DriveSenseTripArchiveRepository trips = trips(context);
        JSONObject speed = new DriveSenseSpeedArchiveRepository(context).rolloverGeneration("physical_h_ph11_retry");
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        DriveSenseActiveTripSpool.eraseAllForDataRights(context);
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        requireHealthy(health, 0L, 0L);
        marker.put("state", "PH11_NATIVE_ERASURE_COMPLETE"); PhysicalHCaseStore.write(context, marker);
        return base(scenario, "ARMED_FOR_EXTERNAL_ACTION", "NATIVE_ERASURE_COMPLETE_DELETE_TEST_PROJECTION")
            .put("removedBucketCount", speed.optLong("removedBucketCount"))
            .put("liveCount", 0L).put("pendingCount", 0L)
            .put("externalAction", "INSTRUMENTATION_DELETE_IDB_THEN_VERIFY_NEW_TRIP")
            .put("mutatesState", true).json();
    }

    private static JSONObject postErasureVerify(Context context, String scenario, Bundle arguments) throws Exception {
        JSONObject marker = PhysicalHCaseStore.read(context); requireMarker(marker, "PH11_NATIVE_ERASURE_COMPLETE");
        if (arguments == null || !arguments.getBoolean("projectionDeleted", false)) {
            throw new IllegalStateException("PHYSICAL_H_PROJECTION_ERASURE_EVIDENCE_REQUIRED");
        }
        DriveSenseTripArchiveRepository trips = trips(context);
        File spool = new File(context.getCacheDir(), "physical-h-post-erasure.json");
        byte[] bytes = "{\"id\":\"physical-h-post-erasure\",\"start_time\":1820000000000,\"end_time\":1820000060000,\"status\":\"completed\",\"route_points\":[]}"
            .getBytes(StandardCharsets.UTF_8);
        writeSync(spool, bytes); trips.commitSpool(spool, "physical-h-post-erasure", "physical_h_post_erasure");
        if (spool.exists() && !spool.delete()) throw new IllegalStateException("PHYSICAL_H_POST_ERASURE_TEMP_DELETE_FAILED");
        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator()); requireHealthy(health, 1L, 0L);
        if (trips.getMetadata("physical-h-post-erasure") == null) throw new IllegalStateException("PHYSICAL_H_POST_ERASURE_COMMIT_MISSING");
        marker.put("state", "PH11_COMPLETED"); PhysicalHCaseStore.write(context, marker);
        return base(scenario, "PASS", "ERASURE_AND_NEW_GENERATION_VERIFIED")
            .put("liveCount", 1L).put("pendingCount", 0L).put("generationChanged", true)
            .put("projectionRecovered", true).put("mutatesState", true).json();
    }

    private static DriveSenseTripArchiveRepository trips(Context context) throws Exception {
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        DriveSenseTripArchiveRepository trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        return trips;
    }

    private static void requireCurrentHarness() {
        if (!BuildConfig.PHYSICAL_H_BUILD || BuildConfig.PHYSICAL_H_LEGACY_BUILD) {
            throw new IllegalStateException("PHYSICAL_H_CURRENT_BUILD_REQUIRED");
        }
    }

    private static void requireMarker(JSONObject marker, String state) {
        if (marker == null || !"remainingPhaseControl".equals(marker.optString("caseId"))) {
            throw new IllegalStateException("PHYSICAL_H_CASE_MARKER_MISSING");
        }
        if (!state.equals(marker.optString("state"))) throw new IllegalStateException("PHYSICAL_H_CASE_SEQUENCE_INVALID");
    }

    private static void requireHealthy(JSONObject health, long live, long pending) {
        if (!"HEALTHY".equals(health.optString("recoveryState")) || !health.optBoolean("sentinelMatches")) {
            throw new IllegalStateException("PHYSICAL_H_ARCHIVE_UNHEALTHY");
        }
        if (health.optLong("liveCount", -1L) != live || health.optLong("pendingCount", -1L) != pending) {
            throw new IllegalStateException("PHYSICAL_H_CANONICAL_BASELINE_MISMATCH");
        }
    }

    /**
     * Instrumentation extras arrive as Strings from `am instrument -e`, so Bundle.getInt/getLong
     * would silently return the default and run a different case than the operator asked for.
     * Parse the way requiredBytes/expectedLiveCount already do, and fail closed on a malformed value.
     */
    private static int argInt(Bundle arguments, String key, int fallback) {
        return (int) argLong(arguments, key, fallback);
    }

    private static long argLong(Bundle arguments, String key, long fallback) {
        if (arguments == null || !arguments.containsKey(key)) return fallback;
        try {
            return Long.parseLong(String.valueOf(arguments.get(key)).trim());
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("PHYSICAL_H_ARGUMENT_NOT_NUMERIC:" + key);
        }
    }

    private static long expectedLive(Bundle arguments, long fallback) {
        if (arguments == null || !arguments.containsKey("expectedLiveCount")) return fallback;
        long value = Long.parseLong(String.valueOf(arguments.get("expectedLiveCount")));
        if (value < 0L) throw new IllegalArgumentException("PHYSICAL_H_EXPECTED_LIVE_INVALID");
        return value;
    }

    private static PhysicalHReceipt base(String scenario, String status, String code) {
        return new PhysicalHReceipt("remainingPhaseControl", status)
            .put("scenario", scenario).put("code", code);
    }

    /**
     * Bounded inventory: {fileCount, fileBytes, limitExceeded}. The walk still
     * stops at {@code max} so the inspection is never O(total files), but
     * overflow is now reported as a marker instead of a throw. Throwing made
     * the refusal swallow the SQLite integrity reading at scale (PH-9, 20,000
     * trips), which is a harness ordering problem, not an archive problem.
     */
    private static long[] boundedFileInventory(File root, int max) {
        long[] result = new long[3];
        java.util.ArrayDeque<File> queue = new java.util.ArrayDeque<>(); queue.add(root);
        while (!queue.isEmpty() && result[0] <= max) {
            File file = queue.removeFirst();
            File[] children = file.listFiles();
            if (children == null) continue;
            for (File child : children) {
                if (child.isDirectory()) queue.addLast(child);
                else { result[0]++; result[1] += Math.max(0L, child.length()); }
                if (result[0] > max) { result[2] = 1L; return result; }
            }
        }
        return result;
    }

    private static JSONObject speedModel(int cells) throws Exception {
        JSONObject root = new JSONObject().put("schemaVersion", 2).put("knowledgeRevision", cells)
            .put("knowledgeUpdatedAt", "2026-08-23T00:00:00Z");
        JSONObject map = new JSONObject();
        for (int index = 0; index < cells; index++) {
            map.put("dpz8" + String.format(Locale.ROOT, "%04x", index),
                new JSONObject().put("limitKmh", 50).put("samples", new JSONArray().put(48).put(50)));
        }
        root.put("cells", map).put("corrections", new JSONArray())
            .put("excludedSections", new JSONArray()).put("roadMemory", new JSONObject())
            .put("history", new JSONObject().put("undo", new JSONArray()).put("redo", new JSONArray()));
        return root;
    }

    private static String prefix4(long value) {
        String alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
        char[] out = new char[4];
        long current = value;
        for (int index = 3; index >= 0; index--) { out[index] = alphabet.charAt((int) (current & 31L)); current >>>= 5; }
        return new String(out);
    }

    private static void writeSync(File file, byte[] bytes) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(bytes); output.flush(); output.getFD().sync();
        }
    }

    private static JSONObject awaitPortableOperation(DriveSenseStreamBackupManager manager, String operationId,
                                                     long timeoutMs) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs;
        JSONObject status = manager.status(operationId);
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            status = manager.status(operationId);
            if (status.optBoolean("done")) {
                if (!status.optBoolean("verified")) {
                    throw new IllegalStateException("PHYSICAL_H_PORTABLE_OPERATION_FAILED:" + status.optString("error", status.optString("phase")));
                }
                return status;
            }
            android.os.SystemClock.sleep(50L);
        }
        // Report where the operation actually reached. An opaque timeout is why the PH-10
        // step 2 refusal could not be told apart from a genuinely stalled export.
        throw new IllegalStateException("PHYSICAL_H_PORTABLE_OPERATION_TIMEOUT:" + timeoutMs
            + "ms:phase=" + status.optString("phase")
            + ":items=" + status.optLong("completedItems")
            + ":bytes=" + status.optLong("completedBytes"));
    }

    /**
     * The portable backup/restore wait has to be proportional to the canonical volume the
     * operator asked to export, not a fixed constant. At the PH-10 boundary the archive holds
     * ~1.5 GB across 20,004 trips and 10,000 speed buckets, and the export writes every byte
     * and then re-reads the whole file in verify(), so the original hardcoded 120,000 ms
     * deadline refused a perfectly healthy operation. The bound stays explicit,
     * operator-supplied and capped, and the typed timeout refusal itself is unchanged - only
     * its size is now stated rather than assumed. No part of the backup integrity contract is
     * relaxed: verified still means verified.
     *
     * The wait cannot be split across `am instrument` invocations instead. The operation lives
     * in DriveSenseStreamBackupManager's in-memory map inside the app process, and that
     * manager's constructor runs cleanupInterrupted(), which deletes every *.partial. Polling
     * from a fresh process would destroy the very operation it was polling for.
     */
    private static long portableWaitMs(Bundle arguments) {
        long seconds = argLong(arguments, "operationTimeoutSeconds", PORTABLE_WAIT_DEFAULT_SECONDS);
        if (seconds < PORTABLE_WAIT_DEFAULT_SECONDS || seconds > PORTABLE_WAIT_MAX_SECONDS) {
            throw new IllegalArgumentException("PHYSICAL_H_PORTABLE_WAIT_RANGE_INVALID");
        }
        return seconds * 1000L;
    }

    private static void recoverVerifiedBackup(DriveSenseStreamBackupManager manager, JSONObject marker) throws Exception {
        manager.recoverVerifiedBackup(marker.getString("backupOperationId"), marker.getString("backupNativePath"),
            marker.getString("backupSha256"), BACKUP_SECRET);
    }

    private static String sha256File(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    private static long heapUsed() { Runtime r = Runtime.getRuntime(); return r.totalMemory() - r.freeMemory(); }
    private static String sha256Hex(String value) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    private static String hex(byte[] value) { return DriveSenseEnvelopeCrypto.hex(value); }
    private static String safeToken(String value) {
        String result = value == null ? "normal" : value.replaceAll("[^A-Za-z0-9_-]", "_");
        return result.substring(0, Math.min(48, result.length()));
    }
}
