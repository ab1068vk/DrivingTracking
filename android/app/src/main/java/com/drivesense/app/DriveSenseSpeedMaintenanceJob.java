package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Explicit, cursor/checkpointed saved-road maintenance. Never runs on read/startup. */
final class DriveSenseSpeedMaintenanceJob {
    static final int MAX_BUCKETS_PER_STEP = 8;
    private final DriveSenseSpeedArchiveRepository speed;
    private final DriveSenseStorageCoordinator coordinator;

    DriveSenseSpeedMaintenanceJob(DriveSenseSpeedArchiveRepository speed) {
        this.speed = speed;
        this.coordinator = speed.coordinator();
    }

    JSONObject begin(String type, int maxAgeDays) throws Exception {
        String jobType = normalizeType(type);
        String generation = speed.state().getString("speedGeneration");
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        coordinator.write(db -> {
            ContentValues row = new ContentValues();
            row.put("job_id", jobId);
            row.put("job_type", jobType);
            row.put("state", "RUNNING");
            row.put("max_age_days", Math.max(1, Math.min(3650, maxAgeDays)));
            row.put("speed_generation", generation);
            row.put("created_at_ms", now);
            row.put("updated_at_ms", now);
            db.insertOrThrow("speed_maintenance_jobs", null, row);
            return null;
        });
        return status(jobId);
    }

    /**
     * P4-C-F08. Resume the currently compatible RUNNING job, or start one.
     *
     * The renderer used to hold the only pointer to a durable RUNNING job: a
     * process death between two bounded steps lost the job id, and the next
     * admission called {@link #begin} again, orphaning the original checkpoint
     * and leaving a second RUNNING row behind. The durable owner of that
     * identity is this table, so it - not renderer memory - answers which job a
     * bounded step should continue. Compatibility is the existing pair the step
     * fence already requires: the same job type and the same speed generation.
     */
    JSONObject beginOrResume(String type, int maxAgeDays) throws Exception {
        String jobType = normalizeType(type);
        String generation = speed.state().getString("speedGeneration");
        retireSupersededJobs(jobType, generation);
        String existing = findActive(jobType, generation);
        if (existing != null) return status(existing);
        return begin(type, maxAgeDays);
    }

    /** The current compatible RUNNING job id, or null when none exists. */
    private String findActive(String jobType, String generation) throws Exception {
        return coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT job_id FROM speed_maintenance_jobs WHERE state='RUNNING' AND job_type=? AND speed_generation=? ORDER BY created_at_ms DESC LIMIT 1", new String[]{jobType, generation})) {
                return cursor.moveToFirst() ? cursor.getString(0) : null;
            }
        });
    }

    /**
     * A RUNNING job bound to a superseded generation can never take another
     * step - the generation fence rejects it - so it is closed here rather than
     * left to accumulate as an unreachable RUNNING row.
     */
    private void retireSupersededJobs(String jobType, String generation) throws Exception {
        coordinator.write(db -> {
            db.execSQL("UPDATE speed_maintenance_jobs SET state='GENERATION_CHANGED',updated_at_ms=? WHERE state='RUNNING' AND job_type=? AND speed_generation<>?",
                new Object[]{System.currentTimeMillis(), jobType, generation});
            return null;
        });
    }

    JSONObject step(String jobId, int requestedBuckets) throws Exception {
        Job job = load(jobId);
        if (!"RUNNING".equals(job.state)) return status(jobId);
        String currentGeneration = speed.state().getString("speedGeneration");
        if (!currentGeneration.equals(job.generation)) {
            fail(jobId, "GENERATION_CHANGED");
            throw new IllegalStateException("SPEED_MAINTENANCE_GENERATION_CHANGED");
        }
        int budget = Math.max(1, Math.min(MAX_BUCKETS_PER_STEP, requestedBuckets));
        JSONObject page = speed.page(job.cursor, budget);
        JSONArray items = page.optJSONArray("items");
        int changed = 0;
        int removed = 0;
        String cursor = job.cursor;
        for (int index = 0; items != null && index < items.length(); index++) {
            cursor = items.getJSONObject(index).getString("bucketId");
            JSONObject document = speed.readBucketJson(cursor);
            Result result = maintain(document, job.type, job.maxAgeDays);
            if (result.changed) {
                write(cursor, document);
                changed += 1;
                removed += result.removed;
            }
        }
        boolean complete = page.isNull("nextCursor") || items == null || items.length() == 0;
        String nextCursor = cursor;
        int processed = items == null ? 0 : items.length();
        final int changedCount = changed;
        final int removedCount = removed;
        coordinator.write(db -> {
            db.execSQL("UPDATE speed_maintenance_jobs SET state=?,cursor_bucket=?,processed_buckets=processed_buckets+?,changed_buckets=changed_buckets+?,removed_items=removed_items+?,updated_at_ms=? WHERE job_id=? AND state='RUNNING'",
                new Object[]{complete ? "COMPLETED" : "RUNNING", nextCursor, processed, changedCount, removedCount, System.currentTimeMillis(), jobId});
            return null;
        });
        return status(jobId);
    }

    JSONObject cancel(String jobId) throws Exception {
        coordinator.write(db -> {
            db.execSQL("UPDATE speed_maintenance_jobs SET state='CANCELLED',updated_at_ms=? WHERE job_id=? AND state='RUNNING'",
                new Object[]{System.currentTimeMillis(), jobId});
            return null;
        });
        return status(jobId);
    }

    JSONObject status(String jobId) throws Exception {
        Job job = load(jobId);
        JSONObject out = new JSONObject();
        out.put("jobId", job.id);
        out.put("jobType", job.type);
        out.put("state", job.state);
        out.put("cursor", job.cursor);
        out.put("processedBuckets", job.processed);
        out.put("changedBuckets", job.changed);
        out.put("removedItems", job.removed);
        out.put("speedGeneration", job.generation);
        out.put("bounded", true);
        out.put("maxBucketsPerStep", MAX_BUCKETS_PER_STEP);
        return out;
    }

    private void write(String bucketId, JSONObject document) throws Exception {
        byte[] bytes = document.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > DriveSenseSpeedArchiveRepository.MAX_EDITOR_INDEX_BUCKET_BYTES) {
            throw new IllegalStateException("SPEED_BUCKET_ENCODED_BYTES_EXCEEDED");
        }
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        JSONObject descriptor = new JSONObject()
            .put("bucketId", bucketId)
            .put("expectedBytes", bytes.length)
            .put("cellCount", itemCount(document))
            .put("payloadHash", DriveSenseEnvelopeCrypto.hex(hash));
        JSONObject started = speed.begin(new JSONArray().put(descriptor));
        String batch = started.getString("batchId");
        try {
            for (int offset = 0, chunk = 0; offset < bytes.length; offset += DriveSenseSpeedArchiveRepository.MAX_INGRESS_CHUNK, chunk++) {
                int length = Math.min(DriveSenseSpeedArchiveRepository.MAX_INGRESS_CHUNK, bytes.length - offset);
                byte[] part = java.util.Arrays.copyOfRange(bytes, offset, offset + length);
                try { speed.append(batch, bucketId, chunk, Base64.encodeToString(part, Base64.NO_WRAP)); }
                finally { java.util.Arrays.fill(part, (byte) 0); }
            }
            speed.finish(batch);
        } catch (Exception error) {
            try { speed.abort(batch); } catch (Exception ignored) {}
            throw error;
        } finally {
            java.util.Arrays.fill(bytes, (byte) 0);
        }
    }

    private static Result maintain(JSONObject document, String type, int maxAgeDays) {
        long cutoff = System.currentTimeMillis() - maxAgeDays * 86_400_000L;
        int removed = 0;
        JSONObject cells = document.optJSONObject("cells");
        JSONArray names = cells == null ? null : cells.names();
        for (int index = names == null ? -1 : names.length() - 1; index >= 0; index--) {
            String key = names.optString(index, "");
            JSONObject cell = cells.optJSONObject(key);
            if ("PRUNE".equals(type) && time(cell, "lastUpdatedAt") < cutoff) {
                cells.remove(key);
                removed++;
            }
        }
        // Preserve the exact legacy maintenance contract: prune/repair applies
        // to learned cells and correction revisions only. Exclusions and Road
        // Memory candidates are user/review state and have no age-based
        // deletion rule; treating a missing timestamp as stale would silently
        // erase valid saved-road decisions.
        removed += maintainArray(document.optJSONArray("corrections"), type, cutoff, "correction");
        return new Result(removed > 0, removed);
    }

    private static int maintainArray(JSONArray array, String type, long cutoff, String kind) {
        if (array == null) return 0;
        int removed = 0;
        Set<String> seen = new HashSet<>();
        for (int index = array.length() - 1; index >= 0; index--) {
            JSONObject item = array.optJSONObject(index);
            String identity = DriveSenseSpeedEditorIndex.stableIdentity(kind, item);
            boolean duplicate = !identity.isEmpty() && !seen.add(identity);
            boolean stale = "PRUNE".equals(type) && !historical(item) && newestTime(item) < cutoff;
            if (duplicate || stale) {
                array.remove(index);
                removed++;
            }
        }
        return removed;
    }

    private static boolean historical(JSONObject item) {
        return item != null && item.optBoolean("historicalVersion", false);
    }

    private static long newestTime(JSONObject item) {
        long value = Math.max(time(item, "lastUpdatedAt"), time(item, "appliedAt"));
        return Math.max(value, time(item, "reviewedAt"));
    }

    private static long time(JSONObject value, String key) {
        if (value == null) return 0L;
        try { return Instant.parse(value.optString(key, "")).toEpochMilli(); }
        catch (Exception ignored) { return 0L; }
    }

    private static int itemCount(JSONObject document) {
        int count = document.optJSONObject("cells") == null ? 0 : document.optJSONObject("cells").length();
        count += document.optJSONArray("corrections") == null ? 0 : document.optJSONArray("corrections").length();
        count += document.optJSONArray("excludedSections") == null ? 0 : document.optJSONArray("excludedSections").length();
        JSONObject memory = document.optJSONObject("roadMemory");
        return count + (memory == null || memory.optJSONArray("candidates") == null ? 0 : memory.optJSONArray("candidates").length());
    }

    private Job load(String id) throws Exception {
        return coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT job_id,job_type,state,cursor_bucket,processed_buckets,changed_buckets,removed_items,max_age_days,speed_generation FROM speed_maintenance_jobs WHERE job_id=?", new String[]{id})) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("SPEED_MAINTENANCE_JOB_NOT_FOUND");
                return new Job(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3), cursor.getInt(4), cursor.getInt(5), cursor.getInt(6), cursor.getInt(7), cursor.getString(8));
            }
        });
    }

    private void fail(String id, String state) throws Exception {
        coordinator.write(db -> { db.execSQL("UPDATE speed_maintenance_jobs SET state=?,updated_at_ms=? WHERE job_id=?", new Object[]{state,System.currentTimeMillis(),id}); return null; });
    }

    private static String normalizeType(String value) {
        String type = value == null ? "" : value.trim().toUpperCase(java.util.Locale.ROOT);
        if (!"REPAIR".equals(type) && !"PRUNE".equals(type)) throw new IllegalArgumentException("SPEED_MAINTENANCE_TYPE_INVALID");
        return type;
    }

    private static final class Result { final boolean changed; final int removed; Result(boolean c, int r) { changed=c; removed=r; } }
    private static final class Job {
        final String id,type,state,cursor,generation; final int processed,changed,removed,maxAgeDays;
        Job(String id,String type,String state,String cursor,int processed,int changed,int removed,int maxAgeDays,String generation){this.id=id;this.type=type;this.state=state;this.cursor=cursor;this.processed=processed;this.changed=changed;this.removed=removed;this.maxAgeDays=maxAgeDays;this.generation=generation;}
    }
}
