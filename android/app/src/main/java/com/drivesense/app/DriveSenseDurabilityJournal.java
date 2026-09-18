package com.drivesense.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;

final class DriveSenseDurabilityJournal {
    private static final Object LOCK = new Object();
    private static final int MAX_RECORD_BYTES = 4096;
    private static final long RETAIN_MS = 180L * 24L * 60L * 60L * 1000L;

    private DriveSenseDurabilityJournal() {}

    static void record(Context context, String severity, String code, String operationId,
                       long expected, long actual, long lastSeq, String recoveryState) {
        String normalized = normalizeSeverity(severity);
        try {
            JSONObject item = new JSONObject();
            item.put("schema", 1);
            item.put("at", System.currentTimeMillis());
            item.put("severity", normalized);
            item.put("code", safe(code, 64));
            if (operationId != null) item.put("operationId", safe(operationId, 96));
            item.put("expected", expected);
            item.put("actual", actual);
            item.put("lastSeq", lastSeq);
            if (recoveryState != null) item.put("recoveryState", safe(recoveryState, 48));
            byte[] bytes = item.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_RECORD_BYTES) return;
            synchronized (LOCK) {
                File file = file(context, normalized);
                boolean created = !file.exists();
                try (FileOutputStream stream = new FileOutputStream(file, true);
                     DataOutputStream output = new DataOutputStream(new BufferedOutputStream(stream))) {
                    output.writeInt(bytes.length);
                    output.write(bytes);
                    output.flush();
                    stream.getFD().sync();
                }
                if (created) DriveSenseArchiveSentinelStore.fsyncDirectory(file.getParentFile());
                enforceBounds(file, maxEvents(normalized), maxBytes(normalized));
            }
        } catch (Exception ignored) {
            // Durability telemetry cannot be allowed to make the canonical operation fail.
        }
    }

    static JSONObject summary(Context context) {
        JSONObject result = new JSONObject();
        synchronized (LOCK) {
            for (String severity : new String[]{"CRITICAL","ERROR","WARN"}) {
                File file = file(context, severity);
                try {
                    result.put(severity.toLowerCase(Locale.US) + "Bytes", file.isFile() ? file.length() : 0L);
                    result.put(severity.toLowerCase(Locale.US) + "Count", count(file));
                } catch (Exception ignored) {}
            }
        }
        return result;
    }

    private static void enforceBounds(File file, int maxEvents, long maxBytes) throws Exception {
        if (file.length() <= maxBytes && count(file) <= maxEvents) return;
        Deque<byte[]> keep = new ArrayDeque<>();
        long keptBytes = 0L;
        long cutoff = System.currentTimeMillis() - RETAIN_MS;
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            while (true) {
                try {
                    int length = input.readInt();
                    if (length <= 0 || length > MAX_RECORD_BYTES) break;
                    byte[] bytes = new byte[length];
                    input.readFully(bytes);
                    long at = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optLong("at", 0L);
                    if (at >= cutoff || keep.isEmpty()) {
                        keep.addLast(bytes);
                        keptBytes += 4L + length;
                    }
                    while (keep.size() > maxEvents || keptBytes > maxBytes) {
                        byte[] removed = keep.removeFirst();
                        keptBytes -= 4L + removed.length;
                    }
                } catch (EOFException end) {
                    break;
                }
            }
        }
        File temp = new File(file.getParentFile(), file.getName() + ".compact");
        try (FileOutputStream stream = new FileOutputStream(temp, false);
             DataOutputStream output = new DataOutputStream(new BufferedOutputStream(stream))) {
            for (byte[] bytes : keep) { output.writeInt(bytes.length); output.write(bytes); }
            output.flush();
            stream.getFD().sync();
        }
        if (!temp.renameTo(file)) throw new IllegalStateException("Could not compact durability journal");
        DriveSenseArchiveSentinelStore.fsyncDirectory(file.getParentFile());
    }

    private static int count(File file) throws Exception {
        if (!file.isFile()) return 0;
        int count = 0;
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            while (true) {
                try {
                    int length = input.readInt();
                    if (length <= 0 || length > MAX_RECORD_BYTES) break;
                    long skipped = 0;
                    while (skipped < length) {
                        long delta = input.skip(length - skipped);
                        if (delta <= 0) throw new EOFException();
                        skipped += delta;
                    }
                    count++;
                } catch (EOFException end) { break; }
            }
        }
        return count;
    }

    private static File file(Context context, String severity) {
        File directory = new File(context.getNoBackupFilesDir(), "roadsage_durability_journal_v1");
        if (!directory.exists()) directory.mkdirs();
        return new File(directory, severity.toLowerCase(Locale.US) + ".events");
    }
    private static String normalizeSeverity(String value) {
        if ("CRITICAL".equalsIgnoreCase(value)) return "CRITICAL";
        if ("ERROR".equalsIgnoreCase(value)) return "ERROR";
        return "WARN";
    }
    private static int maxEvents(String severity) { return "CRITICAL".equals(severity) ? 512 : "ERROR".equals(severity) ? 320 : 192; }
    private static long maxBytes(String severity) { return "CRITICAL".equals(severity) ? 512L*1024L : "ERROR".equals(severity) ? 320L*1024L : 192L*1024L; }
    private static String safe(String value, int max) { String text=value==null?"":value.trim(); return text.length()>max?text.substring(0,max):text; }
}
