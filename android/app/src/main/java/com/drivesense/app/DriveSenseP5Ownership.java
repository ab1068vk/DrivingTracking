package com.drivesense.app;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Executable frozen ownership inventory. It declares no scheduler. */
final class DriveSenseP5Ownership {
    static final Map<String,String> LIFECYCLE_JOBS;
    static final Map<String,String> EXPLICIT_OPERATIONS;
    static {
        Map<String,String> jobs=new LinkedHashMap<>();
        jobs.put("p5NativeRawGpsRetention","native_archive_retention");
        jobs.put("p5JournalManifestReconcile","completed_trip_journal");
        jobs.put("p5ArchiveIntegrityCheckpoint","native_archive_integrity");
        jobs.put("p5ArchiveResidueGc","native_archive_unlink_debt");
        LIFECYCLE_JOBS=Collections.unmodifiableMap(jobs);
        Map<String,String> explicit=new LinkedHashMap<>();
        explicit.put("runNativeRawGpsRetentionNow","native_archive_retention");
        explicit.put("runLegacyBrowserRawGpsRetention","browser_repository_compatibility");
        explicit.put("runNativeBlobDeepAudit","native_archive_inventory");
        explicit.put("runPreP5JournalRegistryBootstrap","completed_trip_journal_compatibility");
        explicit.put("runPrivacyAuditCompatibilityUpgrade","hashChainLog");
        EXPLICIT_OPERATIONS=Collections.unmodifiableMap(explicit);
    }
    private DriveSenseP5Ownership() {}
}
