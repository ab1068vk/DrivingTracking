package com.drivesense.app;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class DriveSenseActiveTripCheckpointStore {
    private static final String TAG = "TripCheckpointStore";
    private static final String FILE_NAME = "active_trip_checkpoint.enc";
    private static final String ENCRYPTION_CONTEXT = "native:active_trip_checkpoint";
    static final int VERSION = 1;
    static final int MAX_ROUTE_POINTS = 1500;
    static final int MAX_TIMELINE_EVENTS = 40;
    static final int MAX_INCIDENT_EVENTS = 4;
    static final int MAX_PLAINTEXT_BYTES = 360 * 1024;
    static final int MAX_ENCRYPTED_BYTES = 512 * 1024;
    static final long MAX_AGE_MS = 7L * 24L * 60L * 60_000L;
    static final long MAX_CANDIDATE_AGE_MS = 24L * 60L * 60_000L;

    private static final String[] ROUTE_POINT_KEYS = new String[] {
        "lat",
        "lng",
        "speed_kmh",
        "heading",
        "accuracy",
        "altitude",
        "timestamp",
        "tracking_gap",
        "route_gap"
    };

    private DriveSenseActiveTripCheckpointStore() {}

    static JSONArray compactRoutePoints(JSONArray points) {
        JSONArray compacted = new JSONArray();
        if (points == null || points.length() == 0) return compacted;

        int sourceCount = points.length();
        int outputCount = Math.min(sourceCount, MAX_ROUTE_POINTS);
        for (int index = 0; index < outputCount; index++) {
            int sourceIndex = outputCount == 1
                ? sourceCount - 1
                : (int) Math.round(index * (sourceCount - 1d) / (outputCount - 1d));
            JSONObject source = points.optJSONObject(sourceIndex);
            if (source == null) continue;
            JSONObject point = new JSONObject();
            for (String key : ROUTE_POINT_KEYS) {
                if (!source.has(key)) continue;
                try {
                    point.put(key, source.opt(key));
                } catch (Exception error) {
                    Log.w(TAG, "Could not compact route points", error);
                }
            }
            if (point.has("timestamp")) compacted.put(point);
        }
        return compacted;
    }

    static JSONArray compactTail(JSONArray values, int limit) {
        JSONArray compacted = new JSONArray();
        if (values == null || values.length() == 0 || limit <= 0) return compacted;
        int start = Math.max(0, values.length() - limit);
        for (int index = start; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value != null) compacted.put(value);
        }
        return compacted;
    }

    static int utf8Size(JSONObject payload) {
        if (payload == null) return 0;
        return payload.toString().getBytes(StandardCharsets.UTF_8).length;
    }

    static boolean save(Context context, JSONObject payload) {
        if (context == null || payload == null) return false;
        try {
            byte[] plaintext = payload.toString().getBytes(StandardCharsets.UTF_8);
            if (plaintext.length == 0 || plaintext.length > MAX_PLAINTEXT_BYTES) {
                Log.e(TAG, "Checkpoint plaintext exceeded bounded size");
                return false;
            }
            byte[] encrypted = DriveSensePayloadCrypto
                .encryptForStorage(payload.toString(), ENCRYPTION_CONTEXT)
                .getBytes(StandardCharsets.UTF_8);
            if (encrypted.length == 0 || encrypted.length > MAX_ENCRYPTED_BYTES) {
                Log.e(TAG, "Checkpoint ciphertext exceeded bounded size");
                return false;
            }

            AtomicFile atomicFile = atomicFile(context);
            FileOutputStream output = null;
            try {
                output = atomicFile.startWrite();
                output.write(encrypted);
                output.flush();
                output.getFD().sync();
                atomicFile.finishWrite(output);
                return true;
            } catch (Exception error) {
                if (output != null) atomicFile.failWrite(output);
                throw error;
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not save active trip checkpoint", error);
            return false;
        }
    }

    static JSONObject load(Context context, long nowMs) {
        if (context == null) return null;
        AtomicFile atomicFile = atomicFile(context);
        File baseFile = atomicFile.getBaseFile();

        try (InputStream input = atomicFile.openRead()) {
            int initialCapacity = (int) Math.min(Math.max(32L, baseFile.length()), 8192L);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(initialCapacity);
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_ENCRYPTED_BYTES) throw new IllegalStateException("Checkpoint exceeds size limit");
                bytes.write(buffer, 0, read);
            }
            String stored = bytes.toString(StandardCharsets.UTF_8.name());
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, ENCRYPTION_CONTEXT);
            if (raw.getBytes(StandardCharsets.UTF_8).length > MAX_PLAINTEXT_BYTES) {
                throw new IllegalStateException("Checkpoint plaintext exceeds size limit");
            }
            JSONObject payload = new JSONObject(raw);
            long updatedAtMs = payload.optLong("updated_at_ms", 0L);
            long ageMs = Math.max(0L, nowMs - updatedAtMs);
            long allowedAgeMs = payload.optBoolean("candidate", false)
                ? MAX_CANDIDATE_AGE_MS
                : MAX_AGE_MS;
            if (
                payload.optInt("version", 0) != VERSION ||
                updatedAtMs <= 0L ||
                ageMs > allowedAgeMs ||
                payload.optLong("start_time_ms", 0L) <= 0L ||
                payload.optString("trip_id", "").trim().isEmpty() ||
                payload.optJSONArray("route_points") == null ||
                payload.optJSONArray("route_points").length() < 2
            ) {
                atomicFile.delete();
                return null;
            }
            return payload;
        } catch (FileNotFoundException ignored) {
            return null;
        } catch (Exception error) {
            Log.e(TAG, "Could not load active trip checkpoint", error);
            atomicFile.delete();
            return null;
        }
    }

    static JSONObject getStatus(Context context, long nowMs) {
        JSONObject status = new JSONObject();
        try {
            status.put("supported", context != null);
            status.put("state", context == null ? "unknown" : "none");
            status.put("present", false);
            status.put("updatedAtMs", JSONObject.NULL);
            status.put("ageSeconds", JSONObject.NULL);
            status.put("encryptedBytes", 0L);
            status.put("maxEncryptedBytes", MAX_ENCRYPTED_BYTES);
            status.put("maxAgeSeconds", MAX_AGE_MS / 1_000L);
            if (context == null) return status;

            File baseFile = atomicFile(context).getBaseFile();
            if (!baseFile.exists()) return status;

            long encryptedBytes = Math.max(0L, baseFile.length());
            JSONObject payload = load(context, nowMs);
            if (payload == null) {
                status.put("state", "invalid_removed");
                return status;
            }

            long updatedAtMs = payload.optLong("updated_at_ms", 0L);
            status.put("state", "protected");
            status.put("present", true);
            status.put(
                "maxAgeSeconds",
                payload.optBoolean("candidate", false)
                    ? MAX_CANDIDATE_AGE_MS / 1_000L
                    : MAX_AGE_MS / 1_000L
            );
            status.put("updatedAtMs", updatedAtMs);
            status.put("ageSeconds", Math.max(0L, (nowMs - updatedAtMs) / 1_000L));
            status.put("encryptedBytes", encryptedBytes);
            return status;
        } catch (Exception error) {
            Log.e(TAG, "Could not read active trip checkpoint status", error);
            try {
                status.put("state", "unknown");
                status.put("present", false);
            } catch (Exception fallbackError) {
                Log.w(TAG, "Could not write unknown checkpoint status fallback", fallbackError);
            }
            return status;
        }
    }

    static void clear(Context context) {
        if (context == null) return;
        atomicFile(context).delete();
    }

    private static AtomicFile atomicFile(Context context) {
        File directory = context.getNoBackupFilesDir();
        return new AtomicFile(new File(directory, FILE_NAME));
    }
}
