package com.drivesense.app;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

final class SpeedSignReviewImageStore {
    static final long RETENTION_MS = 24L * 60L * 60L * 1_000L;
    private static final String DIRECTORY = "speed_sign_review_images_v1";
    private static final String CONTEXT_PREFIX = "native:speed_sign_review_image:";
    private static final int MAX_ENCODED_BYTES = 300_000;

    private SpeedSignReviewImageStore() {}

    static synchronized long write(Context context, String evidenceId, byte[] jpegBytes) {
        if (!validId(evidenceId) || jpegBytes == null || jpegBytes.length == 0
            || jpegBytes.length > MAX_ENCODED_BYTES) return 0L;
        cleanupExpired(context);
        File target = file(context, evidenceId);
        try {
            byte[] encrypted = DriveSensePayloadCrypto.encryptBytesForStorage(
                jpegBytes,
                cryptoContext(evidenceId)
            );
            try (FileOutputStream output = new FileOutputStream(target, false)) {
                output.write(encrypted);
                output.flush();
                output.getFD().sync();
            }
            long createdAt = System.currentTimeMillis();
            target.setLastModified(createdAt);
            return createdAt + RETENTION_MS;
        } catch (Exception ignored) {
            wipe(target);
            return 0L;
        }
    }

    static synchronized byte[] read(Context context, String evidenceId) {
        if (!validId(evidenceId)) return null;
        cleanupExpired(context);
        File target = file(context, evidenceId);
        if (!target.isFile()) return null;
        try {
            byte[] encrypted = readAll(target);
            return DriveSensePayloadCrypto.decryptStoredBytes(
                encrypted,
                cryptoContext(evidenceId)
            );
        } catch (Exception ignored) {
            wipe(target);
            return null;
        }
    }

    static synchronized void delete(Context context, String evidenceId) {
        if (!validId(evidenceId)) return;
        wipe(file(context, evidenceId));
    }

    static synchronized void cleanupExpired(Context context) {
        File directory = directory(context);
        File[] files = directory.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - RETENTION_MS;
        for (File file : files) {
            if (!file.isFile() || file.lastModified() <= 0L || file.lastModified() < cutoff) {
                wipe(file);
            }
        }
    }

    static synchronized void eraseAll(Context context) {
        File directory = directory(context);
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) wipe(file);
        }
        if (directory.exists()) directory.delete();
    }

    private static File directory(Context context) {
        File directory = new File(context.getNoBackupFilesDir(), DIRECTORY);
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    private static File file(Context context, String evidenceId) {
        return new File(directory(context), digest(evidenceId) + ".enc");
    }

    private static String cryptoContext(String evidenceId) {
        return CONTEXT_PREFIX + evidenceId;
    }

    private static boolean validId(String evidenceId) {
        return evidenceId != null
            && evidenceId.length() >= 8
            && evidenceId.length() <= 100
            && evidenceId.matches("sign_[A-Za-z0-9_-]+");
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder();
            for (byte part : bytes) output.append(String.format(Locale.ROOT, "%02x", part));
            return output.toString();
        } catch (Exception ignored) {
            return "unavailable";
        }
    }

    private static byte[] readAll(File file) throws Exception {
        try (
            FileInputStream input = new FileInputStream(file);
            ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(file.length(), 400_000L))
        ) {
            byte[] buffer = new byte[8_192];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count == 0) continue;
                output.write(buffer, 0, count);
                if (output.size() > 500_000) throw new IllegalArgumentException("Review image is too large.");
            }
            return output.toByteArray();
        }
    }

    private static void wipe(File file) {
        try {
            SecureDeleteHelper.secureWipeFile(file);
        } catch (Exception ignored) {
            if (file != null && file.exists()) file.delete();
        }
    }
}
