package com.drivesense.app;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.UUID;

/** AuditAnchor-owned format/loss fence. No ledger head, payload or native generation. */
final class PrivacyAuditFormatStore {
    static final String FILE_NAME = "privacy_audit_format_v2";
    static final String PREFERENCES_GROUP = "CapacitorStorage";
    private PrivacyAuditFormatStore() {}

    static File preferenceFile(Context context, boolean backup) {
        return new File(context.getApplicationInfo().dataDir,
                "shared_prefs/" + PREFERENCES_GROUP + ".xml" + (backup ? ".bak" : ""));
    }

    private static AtomicFile file(Context context) {
        return new AtomicFile(new File(context.getNoBackupFilesDir(), FILE_NAME));
    }

    // Distinguish an absent path from a denied/failed metadata probe. Neither
    // operation opens SharedPreferences or materializes its history-sized XML.
    private static boolean present(File path) throws IOException {
        try { Files.readAttributes(path.toPath(), BasicFileAttributes.class); return true; }
        catch (NoSuchFileException absent) { return false; }
    }

    static synchronized void initializeBeforeWebView(Context context) {
        try {
            AtomicFile marker = file(context);
            if (marker.getBaseFile().exists() || new File(marker.getBaseFile().getPath() + ".bak").exists()) return;
            boolean fresh;
            try { fresh = !present(preferenceFile(context, false)) && !present(preferenceFile(context, true)); }
            catch (Exception denied) { fresh = false; }
            JSONObject fence = new JSONObject().put("state", fresh ? "FRESH_PENDING" : "LEGACY_AUDIT_UNKNOWN");
            if (fresh) fence.put("ledgerId", UUID.randomUUID().toString().replace("-", ""));
            write(context, fence);
        } catch (Exception unavailable) {
            // App startup remains available; read() reports a typed failure or
            // UNKNOWN. It must never re-probe after WebView writers have started.
        }
    }

    static JSONObject validate(JSONObject fence) throws Exception {
        String state = fence.optString("state", "");
        if (!state.matches("FRESH_PENDING|LEGACY_AUDIT_UNKNOWN|CUTOVER_PENDING|V2|ERASING"))
            throw new IOException("AUDIT_FORMAT_INVALID");
        if (!"LEGACY_AUDIT_UNKNOWN".equals(state) && !fence.optString("ledgerId", "").matches("[a-f0-9]{32}"))
            throw new IOException("AUDIT_FORMAT_INVALID");
        java.util.Iterator<String> keys = fence.keys();
        while (keys.hasNext()) { String key = keys.next(); if (!"state".equals(key) && !"ledgerId".equals(key)) throw new IOException("AUDIT_FORMAT_INVALID"); }
        if (fence.toString().getBytes(StandardCharsets.UTF_8).length > 256) throw new IOException("AUDIT_FORMAT_INVALID");
        return fence;
    }

    static synchronized JSONObject read(Context context) throws Exception {
        JSONObject result = new JSONObject().put("itemsWorked", 1).put("bytesWorked", 0);
        AtomicFile marker = file(context);
        if (!marker.getBaseFile().exists() && !new File(marker.getBaseFile().getPath() + ".bak").exists())
            return result.put("fence", new JSONObject().put("state", "LEGACY_AUDIT_UNKNOWN"));
        try (FileInputStream stream = marker.openRead()) {
            byte[] bytes = new byte[257]; int size = 0; int count;
            while (size < bytes.length && (count = stream.read(bytes, size, bytes.length - size)) > 0) size += count;
            result.put("bytesWorked", size * 2L);
            if (size > 256) return result.put("error", "AUDIT_FORMAT_INVALID");
            return result.put("fence", validate(new JSONObject(new String(bytes, 0, size, StandardCharsets.UTF_8))));
        } catch (Exception error) { return result.put("error", "AUDIT_FORMAT_INVALID"); }
    }

    static synchronized JSONObject write(Context context, JSONObject fence) throws Exception {
        validate(fence);
        byte[] bytes = fence.toString().getBytes(StandardCharsets.UTF_8);
        AtomicFile marker = file(context); FileOutputStream stream = null;
        try {
            stream = marker.startWrite(); stream.write(bytes); marker.finishWrite(stream);
            return new JSONObject().put("itemsWorked", 0).put("bytesWorked", bytes.length);
        } catch (Exception error) {
            if (stream != null) marker.failWrite(stream);
            return new JSONObject().put("itemsWorked", 0).put("bytesWorked", stream == null ? 0 : bytes.length)
                    .put("error", "AUDIT_STORAGE_UNAVAILABLE");
        }
    }
}
