package com.drivesense.app;

import android.content.SharedPreferences;
import android.util.Base64;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.SecureRandom;

final class SecureDeleteHelper {
    private static final int BUFFER_SIZE = 4096;
    private static final SecureRandom RANDOM = new SecureRandom();

    private SecureDeleteHelper() {}

    /**
     * Commits random replacement data before removing a preference.
     *
     * This is defense in depth, not a physical-media sanitization guarantee:
     * Android filesystems and flash controllers may retain prior blocks.
     */
    static boolean overwriteAndRemovePreference(SharedPreferences preferences, String key) {
        String existing = preferences.getString(key, null);
        if (existing == null) return true;

        byte[] noise = new byte[Math.max(BUFFER_SIZE, existing.length())];
        RANDOM.nextBytes(noise);
        String replacement = Base64.encodeToString(noise, Base64.NO_WRAP);

        if (!preferences.edit().putString(key, replacement).commit()) return false;
        return preferences.edit().remove(key).commit();
    }

    /**
     * Best-effort overwrite for app-owned files on storage with stable writes.
     * Flash wear-leveling can prevent an overwrite from reaching the old block.
     */
    static void secureWipeFile(File file) throws IOException {
        if (file == null || !file.exists()) return;

        long remaining = file.length();
        byte[] buffer = new byte[BUFFER_SIZE];
        try (RandomAccessFile target = new RandomAccessFile(file, "rws")) {
            target.seek(0);
            while (remaining > 0) {
                RANDOM.nextBytes(buffer);
                int count = (int) Math.min(buffer.length, remaining);
                target.write(buffer, 0, count);
                remaining -= count;
            }
            target.getFD().sync();
        }

        if (!file.delete()) {
            throw new IOException("Could not delete overwritten file: " + file.getPath());
        }
    }
}
