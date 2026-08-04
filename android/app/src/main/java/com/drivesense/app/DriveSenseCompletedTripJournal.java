package com.drivesense.app;

import android.content.Context;
import android.os.StatFs;
import android.util.AtomicFile;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

final class DriveSenseCompletedTripJournal {
    private static final String TAG = "CompletedTripJournal";
    private static final String DIRECTORY_NAME = "completed_trip_journal_v1";
    private static final String MANIFEST_SUFFIX = ".manifest.enc";
    private static final String CHUNK_SUFFIX = ".chunk.enc";
    private static final String MANIFEST_CONTEXT_PREFIX = "native:completed_trip_manifest:";
    private static final String CHUNK_CONTEXT_PREFIX = "native:completed_trip_chunk:";
    private static final int VERSION = 1;
    private static final int MAX_ENTRIES = 64;
    private static final int MAX_CHUNKS_PER_TRIP = 32;
    private static final int MAX_PLAINTEXT_CHUNK_BYTES = 320 * 1024;
    private static final int MAX_ENCRYPTED_CHUNK_BYTES = 512 * 1024;
    private static final int MAX_MANIFEST_BYTES = 64 * 1024;
    private static final int MAX_TRIP_PLAINTEXT_BYTES = 8 * 1024 * 1024;
    private static final long MAX_TOTAL_JOURNAL_BYTES = 32L * 1024L * 1024L;
    private static final long ORPHAN_MAX_AGE_MS = 24L * 60L * 60_000L;
    private static final Object LOCK = new Object();

    private static final String KEY_OVERFLOW_COUNT = "completed_trip_journal_overflow_count";
    private static final String KEY_OVERFLOW_AT_MS = "completed_trip_journal_overflow_at_ms";
    private static final String KEY_OVERFLOW_REASON = "completed_trip_journal_overflow_reason";

    private DriveSenseCompletedTripJournal() {}

    /**
     * A refused trip is real data the user drove and will never see, so it must not fail
     * silently. The counter is surfaced through {@link #status(Context)} and cleared once the
     * JS layer drains the queue, letting the app warn instead of losing trips quietly.
     */
    private static void recordOverflow(Context context, String reason) {
        Log.e(TAG, "Completed trip journal is full; trip not queued (" + reason + ")");
        try {
            android.content.SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
            int previous = prefs.getInt(KEY_OVERFLOW_COUNT, 0);
            prefs.edit()
                .putInt(KEY_OVERFLOW_COUNT, previous + 1)
                .putLong(KEY_OVERFLOW_AT_MS, System.currentTimeMillis())
                .putString(KEY_OVERFLOW_REASON, reason)
                .apply();
        } catch (Exception error) {
            Log.w(TAG, "Could not record journal overflow", error);
        }
    }

    /** Called once queued trips are safely handed to the JS store. */
    static void clearOverflowRecord(Context context) {
        try {
            DriveSenseNativeTripStore.prefs(context).edit()
                .remove(KEY_OVERFLOW_COUNT)
                .remove(KEY_OVERFLOW_AT_MS)
                .remove(KEY_OVERFLOW_REASON)
                .apply();
        } catch (Exception error) {
            Log.w(TAG, "Could not clear journal overflow record", error);
        }
    }

    static JSONArray getCompletedTrips(Context context) {
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            return scan(context).trips;
        }
    }

    static boolean hasCompletedTrip(Context context, String tripId) {
        if (tripId == null || tripId.trim().isEmpty()) return false;
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            JSONObject trip = readTripForStem(context, stemForTripId(tripId));
            return trip != null && tripId.equals(trip.optString("id", ""));
        }
    }

    static boolean addCompletedTrip(Context context, JSONObject trip) {
        if (context == null || trip == null) return false;
        String tripId = trip.optString("id", "").trim();
        if (tripId.isEmpty()) return false;

        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            cleanupOldOrphans(context, System.currentTimeMillis());

            byte[] plaintext = trip.toString().getBytes(StandardCharsets.UTF_8);
            if (plaintext.length == 0 || plaintext.length > MAX_TRIP_PLAINTEXT_BYTES) {
                Log.e(TAG, "Completed trip exceeded the per-trip journal limit");
                return false;
            }

            int chunkCount = (plaintext.length + MAX_PLAINTEXT_CHUNK_BYTES - 1) / MAX_PLAINTEXT_CHUNK_BYTES;
            if (chunkCount <= 0 || chunkCount > MAX_CHUNKS_PER_TRIP) return false;

            String stem = stemForTripId(tripId);
            File directory = directory(context);
            if (!directory.exists() && !directory.mkdirs()) return false;
            File manifestFile = manifestFile(directory, stem);
            if (manifestFile.exists() && readManifest(manifestFile, stem) == null) {
                Log.e(TAG, "Refusing to overwrite an unreadable completed-trip manifest");
                return false;
            }
            int manifestCount = manifestFiles(directory).length;
            if (!manifestFile.exists() && manifestCount >= MAX_ENTRIES) {
                recordOverflow(context, "entry_limit");
                return false;
            }

            long existingEntryBytes = bytesForStem(directory, stem);
            long estimatedEncryptedBytes = estimateEncryptedBytes(plaintext.length, chunkCount) + MAX_MANIFEST_BYTES;
            long currentBytes = directoryBytes(directory);
            if (currentBytes - existingEntryBytes + estimatedEncryptedBytes > MAX_TOTAL_JOURNAL_BYTES) {
                Log.e(TAG, "Completed trip journal reached its bounded total size");
                recordOverflow(context, "size_limit");
                return false;
            }

            String generation = UUID.randomUUID().toString().replace("-", "");
            List<File> writtenChunks = new ArrayList<>();
            byte[] previousManifest = null;
            boolean manifestCommitted = false;
            try {
                if (manifestFile.exists()) previousManifest = readBounded(manifestFile, MAX_MANIFEST_BYTES);
                for (int index = 0; index < chunkCount; index++) {
                    int start = index * MAX_PLAINTEXT_CHUNK_BYTES;
                    int length = Math.min(MAX_PLAINTEXT_CHUNK_BYTES, plaintext.length - start);
                    byte[] chunk = new byte[length];
                    System.arraycopy(plaintext, start, chunk, 0, length);
                    byte[] encrypted = DriveSensePayloadCrypto.encryptBytesForStorage(
                        chunk,
                        chunkContext(stem, generation, index)
                    );
                    if (encrypted.length == 0 || encrypted.length > MAX_ENCRYPTED_CHUNK_BYTES) {
                        throw new IllegalStateException("Encrypted completed-trip chunk exceeded its size limit");
                    }
                    File chunkFile = chunkFile(directory, stem, generation, index);
                    writeAtomic(chunkFile, encrypted);
                    writtenChunks.add(chunkFile);
                }

                JSONObject manifest = new JSONObject();
                manifest.put("version", VERSION);
                manifest.put("trip_id", tripId);
                manifest.put("generation", generation);
                manifest.put("chunk_count", chunkCount);
                manifest.put("plaintext_bytes", plaintext.length);
                manifest.put("sha256", sha256Hex(plaintext));
                manifest.put("created_at_ms", parseCreatedAtMs(trip));
                manifest.put("updated_at_ms", System.currentTimeMillis());
                JSONObject chunkVerified = readTrip(directory, stem, manifest);
                if (chunkVerified == null || !tripId.equals(chunkVerified.optString("id", ""))) {
                    throw new IllegalStateException("Completed-trip chunks failed pre-commit verification");
                }
                byte[] encryptedManifest = DriveSensePayloadCrypto
                    .encryptForStorage(manifest.toString(), manifestContext(stem))
                    .getBytes(StandardCharsets.UTF_8);
                if (encryptedManifest.length == 0 || encryptedManifest.length > MAX_MANIFEST_BYTES) {
                    throw new IllegalStateException("Completed-trip manifest exceeded its size limit");
                }
                writeAtomic(manifestFile, encryptedManifest);
                manifestCommitted = true;

                JSONObject verified = readTripForStem(context, stem);
                if (verified == null || !tripId.equals(verified.optString("id", ""))) {
                    throw new IllegalStateException("Completed-trip journal read-back verification failed");
                }
                cleanupSupersededChunks(directory, stem, generation);
                return true;
            } catch (Exception error) {
                Log.e(TAG, "Could not save completed trip journal entry", error);
                if (manifestCommitted) restoreManifest(manifestFile, previousManifest);
                for (File file : writtenChunks) deleteFile(file);
                return false;
            }
        }
    }

    static JSONObject acknowledgeCompletedTrips(Context context, JSONArray tripIds) {
        JSONObject result = new JSONObject();
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            int requested = tripIds == null ? 0 : tripIds.length();
            int removed = 0;
            JSONArray missing = new JSONArray();
            JSONArray failed = new JSONArray();
            for (int index = 0; index < requested; index++) {
                String tripId = tripIds.optString(index, "").trim();
                if (tripId.isEmpty()) continue;
                String stem = stemForTripId(tripId);
                File journalDirectory = directory(context);
                if (!entryExists(journalDirectory, stem)) {
                    missing.put(tripId);
                } else if (deleteEntry(journalDirectory, stem)) {
                    removed++;
                } else {
                    failed.put(tripId);
                }
            }
            // Space has been reclaimed, so a past overflow is no longer an active warning.
            if (removed > 0 && manifestFiles(directory(context)).length < MAX_ENTRIES) {
                clearOverflowRecord(context);
            }
            try {
                result.put("requested", requested);
                result.put("removed", removed);
                result.put("missingTripIds", missing);
                result.put("failedTripIds", failed);
                result.put("success", failed.length() == 0);
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            return result;
        }
    }

    static void clear(Context context) {
        synchronized (LOCK) {
            File directory = directory(context);
            File[] files = safeFiles(directory);
            for (File file : files) deleteFile(file);
            if (directory.exists()) directory.delete();
            if (!SecureDeleteHelper.overwriteAndRemovePreference(
                DriveSenseNativeTripStore.prefs(context),
                DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS
            )) {
                DriveSenseNativeTripStore.prefs(context)
                    .edit()
                    .remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS)
                    .commit();
            }
        }
    }

    static JSONObject getStatus(Context context) {
        synchronized (LOCK) {
            boolean legacyReadable = ensureLegacyMigrated(context);
            ScanResult scan = scan(context);
            File directory = directory(context);
            long totalBytes = directoryBytes(directory);
            long largestFileBytes = 0L;
            for (File file : safeFiles(directory)) {
                largestFileBytes = Math.max(largestFileBytes, Math.max(0L, file.length()));
            }
            int unreadableCount = scan.unreadableCount + (legacyReadable ? 0 : 1);
            long availableBytes = 0L;
            try {
                availableBytes = new StatFs(context.getNoBackupFilesDir().getAbsolutePath()).getAvailableBytes();
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            JSONObject status = new JSONObject();
            try {
                status.put("journalVersion", VERSION);
                status.put("queueReadable", unreadableCount == 0);
                status.put("pendingCount", scan.trips.length());
                status.put("unreadableCount", unreadableCount);
                status.put("encryptedBytes", totalBytes);
                status.put("maxTotalBytes", MAX_TOTAL_JOURNAL_BYTES);
                status.put("largestFileBytes", largestFileBytes);
                status.put("maxFileBytes", MAX_ENCRYPTED_CHUNK_BYTES);
                status.put("oldestPendingAtMs", scan.oldestPendingAtMs > 0L ? scan.oldestPendingAtMs : JSONObject.NULL);
                status.put("lastVerifiedSaveAtMs", scan.lastVerifiedSaveAtMs > 0L ? scan.lastVerifiedSaveAtMs : JSONObject.NULL);
                status.put("availableDeviceBytes", availableBytes > 0L ? availableBytes : JSONObject.NULL);
                status.put("entryLimit", MAX_ENTRIES);
                android.content.SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
                int droppedCount = prefs.getInt(KEY_OVERFLOW_COUNT, 0);
                long droppedAtMs = prefs.getLong(KEY_OVERFLOW_AT_MS, 0L);
                status.put("droppedTripCount", droppedCount);
                status.put("droppedAtMs", droppedAtMs > 0L ? droppedAtMs : JSONObject.NULL);
                status.put("droppedReason", droppedCount > 0
                    ? prefs.getString(KEY_OVERFLOW_REASON, "entry_limit")
                    : JSONObject.NULL);
                status.put("cloudBackupExcluded", true);
                status.put("storageScope", "app_private_no_backup");
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            return status;
        }
    }

    private static boolean ensureLegacyMigrated(Context context) {
        String stored = DriveSenseNativeTripStore.prefs(context)
            .getString(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS, null);
        if (stored == null) return true;
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(
                stored,
                DriveSenseNativeTripStore.COMPLETED_TRIPS_CONTEXT
            );
            JSONArray legacyTrips = new JSONArray(raw);
            for (int index = 0; index < legacyTrips.length(); index++) {
                JSONObject trip = legacyTrips.optJSONObject(index);
                if (trip != null && !addCompletedTripWithoutMigration(context, trip)) return false;
            }
            if (!SecureDeleteHelper.overwriteAndRemovePreference(
                DriveSenseNativeTripStore.prefs(context),
                DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS
            )) {
                return DriveSenseNativeTripStore.prefs(context)
                    .edit()
                    .remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS)
                    .commit();
            }
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Legacy completed-trip queue is unreadable and was preserved", error);
            return false;
        }
    }

    private static boolean addCompletedTripWithoutMigration(Context context, JSONObject trip) {
        String tripId = trip.optString("id", "").trim();
        if (tripId.isEmpty()) return false;
        if (hasJournalTripWithoutMigration(context, tripId)) return true;

        byte[] plaintext = trip.toString().getBytes(StandardCharsets.UTF_8);
        if (plaintext.length == 0 || plaintext.length > MAX_TRIP_PLAINTEXT_BYTES) return false;
        int chunkCount = (plaintext.length + MAX_PLAINTEXT_CHUNK_BYTES - 1) / MAX_PLAINTEXT_CHUNK_BYTES;
        if (chunkCount <= 0 || chunkCount > MAX_CHUNKS_PER_TRIP) return false;

        String stem = stemForTripId(tripId);
        File directory = directory(context);
        if (!directory.exists() && !directory.mkdirs()) return false;
        File manifestFile = manifestFile(directory, stem);
        if (manifestFile.exists() && readManifest(manifestFile, stem) == null) return false;
        int manifestCount = manifestFiles(directory).length;
        if (!manifestFile.exists() && manifestCount >= MAX_ENTRIES) {
            recordOverflow(context, "entry_limit");
            return false;
        }
        long existingEntryBytes = bytesForStem(directory, stem);
        long estimatedEncryptedBytes = estimateEncryptedBytes(plaintext.length, chunkCount) + MAX_MANIFEST_BYTES;
        long currentBytes = directoryBytes(directory);
        if (currentBytes - existingEntryBytes + estimatedEncryptedBytes > MAX_TOTAL_JOURNAL_BYTES) {
            recordOverflow(context, "size_limit");
            return false;
        }

        String generation = UUID.randomUUID().toString().replace("-", "");
        List<File> writtenChunks = new ArrayList<>();
        byte[] previousManifest = null;
        boolean manifestCommitted = false;
        try {
            if (manifestFile.exists()) previousManifest = readBounded(manifestFile, MAX_MANIFEST_BYTES);
            for (int index = 0; index < chunkCount; index++) {
                int start = index * MAX_PLAINTEXT_CHUNK_BYTES;
                int length = Math.min(MAX_PLAINTEXT_CHUNK_BYTES, plaintext.length - start);
                byte[] chunk = new byte[length];
                System.arraycopy(plaintext, start, chunk, 0, length);
                byte[] encrypted = DriveSensePayloadCrypto.encryptBytesForStorage(
                    chunk,
                    chunkContext(stem, generation, index)
                );
                if (encrypted.length > MAX_ENCRYPTED_CHUNK_BYTES) throw new IllegalStateException("Chunk too large");
                File chunkFile = chunkFile(directory, stem, generation, index);
                writeAtomic(chunkFile, encrypted);
                writtenChunks.add(chunkFile);
            }
            JSONObject manifest = new JSONObject();
            manifest.put("version", VERSION);
            manifest.put("trip_id", tripId);
            manifest.put("generation", generation);
            manifest.put("chunk_count", chunkCount);
            manifest.put("plaintext_bytes", plaintext.length);
            manifest.put("sha256", sha256Hex(plaintext));
            manifest.put("created_at_ms", parseCreatedAtMs(trip));
            manifest.put("updated_at_ms", System.currentTimeMillis());
            JSONObject chunkVerified = readTrip(directory, stem, manifest);
            if (chunkVerified == null || !tripId.equals(chunkVerified.optString("id", ""))) {
                throw new IllegalStateException("Legacy migration chunks failed pre-commit verification");
            }
            byte[] encryptedManifest = DriveSensePayloadCrypto
                .encryptForStorage(manifest.toString(), manifestContext(stem))
                .getBytes(StandardCharsets.UTF_8);
            if (encryptedManifest.length == 0 || encryptedManifest.length > MAX_MANIFEST_BYTES) {
                throw new IllegalStateException("Legacy migration manifest exceeded its size limit");
            }
            writeAtomic(manifestFile, encryptedManifest);
            manifestCommitted = true;
            JSONObject verified = readTripForStem(context, stem);
            if (verified == null || !tripId.equals(verified.optString("id", ""))) {
                throw new IllegalStateException("Legacy migration read-back failed");
            }
            cleanupSupersededChunks(directory, stem, generation);
            return true;
        } catch (Exception error) {
            if (manifestCommitted) restoreManifest(manifestFile, previousManifest);
            for (File file : writtenChunks) deleteFile(file);
            return false;
        }
    }

    private static boolean hasJournalTripWithoutMigration(Context context, String tripId) {
        JSONObject trip = readTripForStem(context, stemForTripId(tripId));
        return trip != null && tripId.equals(trip.optString("id", ""));
    }

    private static ScanResult scan(Context context) {
        ScanResult result = new ScanResult();
        List<LoadedTrip> loaded = new ArrayList<>();
        for (File manifestFile : manifestFiles(directory(context))) {
            String stem = stemFromManifest(manifestFile);
            JSONObject manifest = readManifest(manifestFile, stem);
            JSONObject trip = manifest == null ? null : readTrip(directory(context), stem, manifest);
            if (trip == null) {
                result.unreadableCount++;
                continue;
            }
            long createdAtMs = manifest.optLong("created_at_ms", 0L);
            long updatedAtMs = manifest.optLong("updated_at_ms", 0L);
            loaded.add(new LoadedTrip(trip, createdAtMs));
            if (createdAtMs > 0L && (result.oldestPendingAtMs == 0L || createdAtMs < result.oldestPendingAtMs)) {
                result.oldestPendingAtMs = createdAtMs;
            }
            result.lastVerifiedSaveAtMs = Math.max(result.lastVerifiedSaveAtMs, updatedAtMs);
        }
        loaded.sort(Comparator.comparingLong(item -> item.createdAtMs));
        for (LoadedTrip item : loaded) result.trips.put(item.trip);
        return result;
    }

    private static JSONObject readTripForStem(Context context, String stem) {
        File directory = directory(context);
        JSONObject manifest = readManifest(manifestFile(directory, stem), stem);
        return manifest == null ? null : readTrip(directory, stem, manifest);
    }

    private static JSONObject readManifest(File file, String stem) {
        if (file == null || !file.exists()) return null;
        try {
            byte[] encrypted = readBounded(file, MAX_MANIFEST_BYTES);
            String stored = new String(encrypted, StandardCharsets.UTF_8);
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, manifestContext(stem));
            JSONObject manifest = new JSONObject(raw);
            if (
                manifest.optInt("version", 0) != VERSION ||
                manifest.optString("trip_id", "").trim().isEmpty() ||
                manifest.optString("generation", "").trim().isEmpty() ||
                manifest.optInt("chunk_count", 0) <= 0 ||
                manifest.optInt("chunk_count", 0) > MAX_CHUNKS_PER_TRIP ||
                manifest.optInt("plaintext_bytes", 0) <= 0 ||
                manifest.optInt("plaintext_bytes", 0) > MAX_TRIP_PLAINTEXT_BYTES
            ) return null;
            return manifest;
        } catch (Exception error) {
            Log.e(TAG, "Completed-trip manifest is unreadable and was preserved", error);
            return null;
        }
    }

    private static JSONObject readTrip(File directory, String stem, JSONObject manifest) {
        String generation = manifest.optString("generation", "");
        int chunkCount = manifest.optInt("chunk_count", 0);
        int expectedBytes = manifest.optInt("plaintext_bytes", 0);
        try {
            ByteArrayOutputStream plaintext = new ByteArrayOutputStream(Math.min(expectedBytes, 8192));
            for (int index = 0; index < chunkCount; index++) {
                File file = chunkFile(directory, stem, generation, index);
                byte[] encrypted = readBounded(file, MAX_ENCRYPTED_CHUNK_BYTES);
                byte[] chunk = DriveSensePayloadCrypto.decryptStoredBytes(
                    encrypted,
                    chunkContext(stem, generation, index)
                );
                if (plaintext.size() + chunk.length > MAX_TRIP_PLAINTEXT_BYTES) {
                    throw new IllegalStateException("Completed trip exceeded read limit");
                }
                plaintext.write(chunk);
            }
            byte[] raw = plaintext.toByteArray();
            if (raw.length != expectedBytes || !sha256Hex(raw).equals(manifest.optString("sha256", ""))) {
                throw new IllegalStateException("Completed-trip checksum mismatch");
            }
            JSONObject trip = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (!manifest.optString("trip_id", "").equals(trip.optString("id", ""))) {
                throw new IllegalStateException("Completed-trip ID mismatch");
            }
            return trip;
        } catch (Exception error) {
            Log.e(TAG, "Completed trip is unreadable and was preserved", error);
            return null;
        }
    }

    private static void writeAtomic(File file, byte[] data) throws Exception {
        AtomicFile atomicFile = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomicFile.startWrite();
            output.write(data);
            output.flush();
            output.getFD().sync();
            atomicFile.finishWrite(output);
        } catch (Exception error) {
            if (output != null) atomicFile.failWrite(output);
            throw error;
        }
    }

    private static void restoreManifest(File manifestFile, byte[] previousManifest) {
        try {
            if (previousManifest == null) {
                deleteFile(manifestFile);
            } else {
                writeAtomic(manifestFile, previousManifest);
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not restore the previous completed-trip manifest", error);
        }
    }

    private static byte[] readBounded(File file, int maxBytes) throws Exception {
        if (file == null || !file.exists()) throw new FileNotFoundException("Journal file missing");
        try (InputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(Math.max(32L, file.length()), 8192L));
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IllegalStateException("Journal file exceeded bounded size");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static long estimateEncryptedBytes(int plaintextBytes, int chunkCount) {
        return Math.round(plaintextBytes * 1.38d) + chunkCount * 128L;
    }

    private static long parseCreatedAtMs(JSONObject trip) {
        String timestamp = trip.optString("end_time", trip.optString("created_at", ""));
        try {
            return java.time.Instant.parse(timestamp).toEpochMilli();
        } catch (Exception ignored) {
            return System.currentTimeMillis();
        }
    }

    private static String stemForTripId(String tripId) {
        return sha256Hex(tripId.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    private static String sha256Hex(byte[] value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) hex.append(String.format("%02x", item & 0xff));
            return hex.toString();
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    private static File directory(Context context) {
        return new File(context.getNoBackupFilesDir(), DIRECTORY_NAME);
    }

    private static File manifestFile(File directory, String stem) {
        return new File(directory, stem + MANIFEST_SUFFIX);
    }

    private static File chunkFile(File directory, String stem, String generation, int index) {
        return new File(directory, stem + "." + generation + "." + index + CHUNK_SUFFIX);
    }

    private static String manifestContext(String stem) {
        return MANIFEST_CONTEXT_PREFIX + stem;
    }

    private static String chunkContext(String stem, String generation, int index) {
        return CHUNK_CONTEXT_PREFIX + stem + ":" + generation + ":" + index;
    }

    private static File[] manifestFiles(File directory) {
        File[] files = directory.listFiles((dir, name) -> name.endsWith(MANIFEST_SUFFIX));
        return files == null ? new File[0] : files;
    }

    private static File[] safeFiles(File directory) {
        File[] files = directory.listFiles();
        return files == null ? new File[0] : files;
    }

    private static String stemFromManifest(File file) {
        String name = file.getName();
        return name.substring(0, name.length() - MANIFEST_SUFFIX.length());
    }

    private static long directoryBytes(File directory) {
        long total = 0L;
        for (File file : safeFiles(directory)) total += Math.max(0L, file.length());
        return total;
    }

    private static long bytesForStem(File directory, String stem) {
        long total = 0L;
        String prefix = stem + ".";
        for (File file : safeFiles(directory)) {
            if (file.getName().startsWith(prefix)) total += Math.max(0L, file.length());
        }
        return total;
    }

    private static boolean deleteEntry(File directory, String stem) {
        boolean found = false;
        boolean success = true;
        String prefix = stem + ".";
        for (File file : safeFiles(directory)) {
            if (!file.getName().startsWith(prefix)) continue;
            found = true;
            if (!deleteFile(file)) success = false;
        }
        return found && success;
    }

    private static boolean entryExists(File directory, String stem) {
        String prefix = stem + ".";
        for (File file : safeFiles(directory)) {
            if (file.getName().startsWith(prefix)) return true;
        }
        return false;
    }

    private static boolean deleteFile(File file) {
        return file == null || !file.exists() || file.delete();
    }

    private static void cleanupSupersededChunks(File directory, String stem, String keepGeneration) {
        String keepPrefix = stem + "." + keepGeneration + ".";
        String entryPrefix = stem + ".";
        for (File file : safeFiles(directory)) {
            String name = file.getName();
            if (
                name.startsWith(entryPrefix) &&
                name.endsWith(CHUNK_SUFFIX) &&
                !name.startsWith(keepPrefix)
            ) deleteFile(file);
        }
    }

    private static void cleanupOldOrphans(Context context, long nowMs) {
        File directory = directory(context);
        List<String> referencedPrefixes = new ArrayList<>();
        for (File manifestFile : manifestFiles(directory)) {
            String stem = stemFromManifest(manifestFile);
            JSONObject manifest = readManifest(manifestFile, stem);
            if (manifest != null) {
                referencedPrefixes.add(stem + "." + manifest.optString("generation", "") + ".");
            }
        }
        for (File file : safeFiles(directory)) {
            if (!file.getName().endsWith(CHUNK_SUFFIX)) continue;
            boolean referenced = false;
            for (String prefix : referencedPrefixes) {
                if (file.getName().startsWith(prefix)) {
                    referenced = true;
                    break;
                }
            }
            if (!referenced && nowMs - Math.max(0L, file.lastModified()) > ORPHAN_MAX_AGE_MS) {
                deleteFile(file);
            }
        }
    }

    private static final class LoadedTrip {
        final JSONObject trip;
        final long createdAtMs;

        LoadedTrip(JSONObject trip, long createdAtMs) {
            this.trip = trip;
            this.createdAtMs = createdAtMs;
        }
    }

    private static final class ScanResult {
        final JSONArray trips = new JSONArray();
        int unreadableCount = 0;
        long oldestPendingAtMs = 0L;
        long lastVerifiedSaveAtMs = 0L;
    }
}
