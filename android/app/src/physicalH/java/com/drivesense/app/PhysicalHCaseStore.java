package com.drivesense.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Small operation-owned durable marker for externally orchestrated cases. */
final class PhysicalHCaseStore {
    private static final int MAX_BYTES = 16 * 1024;
    private static final String FILE_NAME = "physical_h_case_v1.json";

    private PhysicalHCaseStore() {}

    static void write(Context context, JSONObject state) throws Exception {
        byte[] encoded = state.toString().getBytes(StandardCharsets.UTF_8);
        if (encoded.length > MAX_BYTES) throw new IllegalArgumentException("PHYSICAL_H_CASE_STATE_TOO_LARGE");
        File root = new File(context.getNoBackupFilesDir(), "physical_h_harness");
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("PHYSICAL_H_CASE_ROOT_UNAVAILABLE");
        File target = new File(root, FILE_NAME);
        File temp = new File(root, FILE_NAME + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            out.write(encoded);
            out.flush();
            out.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("PHYSICAL_H_CASE_REPLACE_FAILED");
        if (!temp.renameTo(target)) throw new IllegalStateException("PHYSICAL_H_CASE_PUBLISH_FAILED");
        DriveSenseArchiveSentinelStore.fsyncDirectory(root);
    }

    static JSONObject read(Context context) throws Exception {
        File target = new File(new File(context.getNoBackupFilesDir(), "physical_h_harness"), FILE_NAME);
        if (!target.isFile()) return null;
        if (target.length() <= 0 || target.length() > MAX_BYTES) throw new IllegalStateException("PHYSICAL_H_CASE_STATE_INVALID");
        byte[] encoded = java.nio.file.Files.readAllBytes(target.toPath());
        if (encoded.length > MAX_BYTES) throw new IllegalStateException("PHYSICAL_H_CASE_STATE_INVALID");
        return new JSONObject(new String(encoded, StandardCharsets.UTF_8));
    }
}
