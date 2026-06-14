package com.drivesense.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;

final class RoadDataQueueStore {
    private static final String DIRECTORY = "road_data_queue";
    private static final String CRYPTO_CONTEXT = "drivesense-road-data-queue-v1";

    private RoadDataQueueStore() {}

    static String keyFor(String requestId) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(requestId.getBytes(StandardCharsets.UTF_8));
        StringBuilder value = new StringBuilder();
        for (byte part : digest) value.append(String.format("%02x", part));
        return value.toString();
    }

    static void writeRequest(Context context, String requestId, JSONObject request) throws Exception {
        writeEncrypted(file(context, requestId, ".request"), request.toString());
    }

    static JSONObject readRequest(Context context, String requestId) throws Exception {
        return new JSONObject(readEncrypted(file(context, requestId, ".request")));
    }

    static void writeResult(Context context, String requestId, JSONObject result) throws Exception {
        writeEncrypted(file(context, requestId, ".result"), result.toString());
    }

    static JSONObject readResult(Context context, String requestId) throws Exception {
        File resultFile = file(context, requestId, ".result");
        return resultFile.exists() ? new JSONObject(readEncrypted(resultFile)) : null;
    }

    static void remove(Context context, String requestId) throws Exception {
        Files.deleteIfExists(file(context, requestId, ".request").toPath());
        Files.deleteIfExists(file(context, requestId, ".result").toPath());
    }

    private static File file(Context context, String requestId, String suffix) throws Exception {
        File directory = new File(context.getFilesDir(), DIRECTORY);
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IllegalStateException("Could not create road-data queue directory");
        }
        return new File(directory, keyFor(requestId) + suffix);
    }

    private static void writeEncrypted(File file, String plaintext) throws Exception {
        String encrypted = DriveSensePayloadCrypto.encryptForStorage(plaintext, CRYPTO_CONTEXT);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(encrypted.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readEncrypted(File file) throws Exception {
        byte[] data = new byte[(int) file.length()];
        int offset = 0;
        try (FileInputStream input = new FileInputStream(file)) {
            while (offset < data.length) {
                int count = input.read(data, offset, data.length - offset);
                if (count < 0) break;
                offset += count;
            }
        }
        String encrypted = new String(data, 0, offset, StandardCharsets.UTF_8);
        return DriveSensePayloadCrypto.decryptStoredValue(encrypted, CRYPTO_CONTEXT);
    }
}
