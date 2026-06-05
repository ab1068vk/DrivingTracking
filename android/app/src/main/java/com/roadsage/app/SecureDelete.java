package com.roadsage.app;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.SecureRandom;
import java.util.Arrays;

public final class SecureDelete {
    private static final String TAG = "SecureDelete";
    private static final int BUFFER_SIZE = 65536;
    private static final SecureRandom RNG = new SecureRandom();

    private SecureDelete() {}

    public static boolean wipeAndDelete(File file) {
        if (file == null || !file.exists()) return true;
        if (file.isDirectory()) return false;

        long length = file.length();
        if (length > 0L) {
            byte[] zeros = new byte[BUFFER_SIZE];
            byte[] ones = new byte[BUFFER_SIZE];
            Arrays.fill(ones, (byte) 0xFF);

            overwrite(file, length, null);
            overwrite(file, length, zeros);
            overwrite(file, length, ones);
        }

        boolean deleted = file.delete();
        if (!deleted) Log.w(TAG, "Could not delete file: " + file.getAbsolutePath());
        return deleted;
    }

    public static int wipeMatching(File dir, String prefix, String suffix) {
        File[] files = dir == null ? null : dir.listFiles((ignored, name) ->
            (prefix == null || name.startsWith(prefix)) &&
                (suffix == null || name.endsWith(suffix))
        );
        if (files == null) return 0;

        int count = 0;
        for (File file : files) {
            if (file.isFile() && wipeAndDelete(file)) count++;
        }
        return count;
    }

    public static boolean wipePlaintextPrefs(Context context, String prefsName) {
        if (context == null || prefsName == null || prefsName.trim().isEmpty()) return true;
        File prefsDir = new File(context.getApplicationInfo().dataDir, "shared_prefs");
        boolean xml = wipeAndDelete(new File(prefsDir, prefsName + ".xml"));
        boolean backup = wipeAndDelete(new File(prefsDir, prefsName + ".xml.bak"));
        context.deleteSharedPreferences(prefsName);
        return xml && backup;
    }

    public static int wipeSensitiveFiles(Context context) {
        if (context == null) return 0;
        int count = 0;
        count += wipeMatching(context.getFilesDir(), "widget_map_", ".png");
        count += wipeMatching(context.getFilesDir(), "parked_map_widget_", ".png");
        count += wipeMatching(context.getCacheDir(), null, ".tmp");
        count += wipeMatching(context.getCacheDir(), null, ".csv");
        count += wipeMatching(context.getCacheDir(), null, ".json");
        count += wipeMatching(context.getCacheDir(), null, ".pdf");
        count += wipeMatching(context.getCacheDir(), null, ".rsexport");
        count += wipeMatching(context.getCacheDir(), null, ".rsbackup");
        return count;
    }

    private static void overwrite(File file, long length, byte[] pattern) {
        try (RandomAccessFile raf = new RandomAccessFile(file, "rws")) {
            raf.seek(0L);
            byte[] buffer = pattern == null ? new byte[BUFFER_SIZE] : pattern;
            long remaining = length;
            while (remaining > 0L) {
                if (pattern == null) RNG.nextBytes(buffer);
                int toWrite = (int) Math.min(remaining, buffer.length);
                raf.write(buffer, 0, toWrite);
                remaining -= toWrite;
            }
            raf.getFD().sync();
        } catch (IOException error) {
            Log.w(TAG, "Overwrite failed for " + file.getName(), error);
        }
    }
}
