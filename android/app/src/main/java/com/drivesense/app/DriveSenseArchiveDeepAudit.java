package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.UUID;

/** Explicit fixed-memory inventory audit. Never lifecycle-admitted. */
final class DriveSenseArchiveDeepAudit {
    private static final int DB_BATCH = 128;

    private DriveSenseArchiveDeepAudit() {}

    static JSONObject step(DriveSenseTripArchiveRepository repository, String requestedJob) throws Exception {
        final String job = requestedJob == null || requestedJob.trim().isEmpty()
            ? UUID.randomUUID().toString() : requestedJob.trim();
        final String attempt = UUID.randomUUID().toString();
        final long[] totals = new long[3]; // examined, anomalies, accounting bytes

        repository.coordinator().exclusive(db -> {
            long now = System.currentTimeMillis();
            db.beginTransaction();
            try {
                db.delete("archive_blob_inventory", "authoritative=0", null);
                ContentValues row = new ContentValues();
                row.put("job_id", job); row.put("state", "ACTIVE");
                row.put("directory_shard", "chunks"); row.put("cursor_name", "");
                row.put("examined", 0); row.put("anomalies", 0); row.put("attempt_id", attempt);
                row.put("created_at_ms", now); row.put("updated_at_ms", now);
                db.insertWithOnConflict("archive_deep_audit_jobs", null, row, SQLiteDatabase.CONFLICT_REPLACE);
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }

            File directory = repository.chunkStore().inventoryDirectory();
            final int[] inBatch = {0};
            db.beginTransaction();
            try {
                boolean eof = DriveSenseDirectoryStream.visit(directory, path -> Files.isRegularFile(path), path -> {
                    String name = path.getFileName().toString();
                    if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) {
                        throw new SecurityException("ARCHIVE_AUDIT_PATH_INVALID");
                    }
                    long encoded = Math.max(0L, Files.size(path));
                    boolean referenced;
                    try (Cursor c = db.rawQuery(
                        "SELECT 1 FROM trip_chunks WHERE relative_path=? " +
                        "UNION SELECT 1 FROM trip_revisions WHERE overview_path=? " +
                        "UNION SELECT 1 FROM archive_unlink_debt WHERE opaque_path=? LIMIT 1",
                        new String[]{name, name, name})) {
                        referenced = c.moveToFirst();
                    }
                    ContentValues inventory = new ContentValues();
                    inventory.put("opaque_path", name); inventory.put("encoded_bytes", encoded);
                    inventory.put("catalog_state", referenced ? "REFERENCED" : "ANOMALY");
                    inventory.put("audit_attempt_id", attempt); inventory.put("authoritative", 0);
                    inventory.put("updated_at_ms", System.currentTimeMillis());
                    db.insertWithOnConflict("archive_blob_inventory", null, inventory, SQLiteDatabase.CONFLICT_REPLACE);
                    totals[0]++; if (!referenced) totals[1]++;
                    totals[2] += name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length + encoded + 32L;
                    inBatch[0]++;
                    if (inBatch[0] == DB_BATCH) {
                        db.setTransactionSuccessful(); db.endTransaction(); db.beginTransaction(); inBatch[0] = 0;
                    }
                    return true;
                });
                if (!eof) throw new IllegalStateException("ARCHIVE_DEEP_AUDIT_CANCELLED");
                db.setTransactionSuccessful();
            } finally {
                if (db.inTransaction()) db.endTransaction();
            }

            // Only truthful EOF under the exclusive owner fence can replace the
            // prior authoritative inventory. A killed attempt leaves only rows
            // with authoritative=0, which J4 must ignore.
            db.beginTransaction();
            try {
                try (Cursor anomalies = db.rawQuery(
                    "SELECT opaque_path,encoded_bytes FROM archive_blob_inventory WHERE audit_attempt_id=? AND catalog_state='ANOMALY' ORDER BY opaque_path",
                    new String[]{attempt})) {
                    while (anomalies.moveToNext()) {
                        DriveSenseArchiveUnlinkDebt.record(db, anomalies.getString(0), anomalies.getLong(1), "deep_audit_anomaly");
                    }
                }
                db.delete("archive_blob_inventory", "audit_attempt_id IS NULL OR audit_attempt_id<>?", new String[]{attempt});
                db.execSQL("UPDATE archive_blob_inventory SET authoritative=1,audit_attempt_id=NULL WHERE audit_attempt_id=?", new Object[]{attempt});
                db.execSQL("UPDATE archive_deep_audit_jobs SET state='COMPLETE',cursor_name='',examined=?,anomalies=?,attempt_id=NULL,updated_at_ms=? WHERE job_id=? AND attempt_id=?",
                    new Object[]{totals[0], totals[1], System.currentTimeMillis(), job, attempt});
                db.execSQL("UPDATE p5_control_state SET blob_inventory_state='VERIFIED',updated_at_ms=? WHERE id=1",
                    new Object[]{System.currentTimeMillis()});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return null;
        });

        JSONObject out = new JSONObject();
        out.put("jobId", job); out.put("state", "COMPLETE");
        out.put("itemsWorked", totals[0]); out.put("changedItems", totals[1]);
        out.put("bytesWorked", totals[2]); out.put("hasMore", false);
        return out;
    }
}
