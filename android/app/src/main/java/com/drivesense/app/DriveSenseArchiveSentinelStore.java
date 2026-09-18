package com.drivesense.app;

import android.database.Cursor;
import android.system.Os;
import android.system.OsConstants;

import org.json.JSONObject;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;

final class DriveSenseArchiveSentinelStore {
    private static final String FILE_NAME = "durability_sentinel_v1.json";
    // Linux O_DIRECTORY. Android's public OsConstants surface does not expose
    // the symbol on every compile SDK even though Os.open supports the flag.
    private static final int O_DIRECTORY = 0x10000;
    private static volatile boolean skipDirectoryFsyncForTests;
    private DriveSenseArchiveSentinelStore() {}

    static File file(DriveSenseStorageCoordinator coordinator) {
        File directory = new File(coordinator.context().getNoBackupFilesDir(), "roadsage_archive_meta");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Could not create archive metadata directory");
        return new File(directory, FILE_NAME);
    }

    static JSONObject read(DriveSenseStorageCoordinator coordinator) {
        File source = file(coordinator);
        if (!source.isFile()) return null;
        try {
            byte[] bytes = Files.readAllBytes(source.toPath());
            if (bytes.length == 0 || bytes.length > 64 * 1024) return null;
            JSONObject envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONObject value = envelope.optJSONObject("value");
            String checksum = envelope.optString("checksum", "");
            if (value == null || !hex(sha256(value.toString().getBytes(StandardCharsets.UTF_8))).equals(checksum)) return null;
            return value;
        } catch (Exception error) {
            return null;
        }
    }

    static void writeFromCatalog(DriveSenseStorageCoordinator coordinator) throws Exception {
        JSONObject value = coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT archive_generation,last_committed_seq,live_count,tip_chain_hash,authority_state,recovery_state,updated_at_ms FROM archive_meta WHERE id=1", null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("archive_meta missing");
                JSONObject item = new JSONObject();
                item.put("sentinelVersion", 1);
                item.put("archiveGeneration", cursor.getString(0));
                item.put("lastCommittedSeq", cursor.getLong(1));
                item.put("liveCount", cursor.getLong(2));
                item.put("tipChainHash", android.util.Base64.encodeToString(cursor.getBlob(3), android.util.Base64.NO_WRAP));
                item.put("authorityState", cursor.getString(4));
                item.put("recoveryState", cursor.getString(5));
                item.put("updatedAtMs", cursor.getLong(6));
                try (Cursor checkpoint = db.rawQuery("SELECT through_seq,checkpoint_live_count,live_set_root FROM archive_events WHERE event_type='CHECKPOINT' ORDER BY seq DESC LIMIT 1", null)) {
                    if (checkpoint.moveToFirst()) {
                        item.put("checkpointThroughSeq", checkpoint.getLong(0));
                        item.put("checkpointLiveCount", checkpoint.getLong(1));
                        item.put("liveSetRoot", android.util.Base64.encodeToString(checkpoint.getBlob(2), android.util.Base64.NO_WRAP));
                    }
                }
                try (Cursor speed = db.rawQuery("SELECT speed_generation,last_seq,bucket_count,integrity_tip,recovery_state FROM speed_state WHERE id=1", null)) {
                    if (!speed.moveToFirst()) throw new IllegalStateException("speed_state missing");
                    item.put("speedGeneration", speed.getString(0));
                    item.put("speedLastSeq", speed.getLong(1));
                    item.put("speedBucketCount", speed.getLong(2));
                    item.put("speedIntegrityTip", android.util.Base64.encodeToString(speed.getBlob(3), android.util.Base64.NO_WRAP));
                    item.put("speedRecoveryState", speed.getString(4));
                }
                return item;
            }
        });
        byte[] valueBytes = value.toString().getBytes(StandardCharsets.UTF_8);
        JSONObject envelope = new JSONObject();
        envelope.put("value", value);
        envelope.put("checksum", hex(sha256(valueBytes)));
        writeAtomic(file(coordinator), envelope.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void writeAtomic(File target, byte[] bytes) throws Exception {
        File temp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temp, false)) {
            output.write(bytes);
            output.getFD().sync();
        }
        try {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (java.nio.file.AtomicMoveNotSupportedException unsupported) {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        fsyncDirectory(target.getParentFile());
    }

    static void fsyncDirectory(File directory) throws Exception {
        if (skipDirectoryFsyncForTests) return;
        FileDescriptor descriptor = null;
        try {
            descriptor = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY | O_DIRECTORY, 0);
            Os.fsync(descriptor);
        } finally {
            if (descriptor != null) Os.close(descriptor);
        }
    }

    /** Robolectric cannot open directories as Linux file descriptors. */
    static void setSkipDirectoryFsyncForTests(boolean skip) { skipDirectoryFsyncForTests = skip; }

    private static byte[] sha256(byte[] bytes) throws Exception { return MessageDigest.getInstance("SHA-256").digest(bytes); }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(java.util.Locale.US, "%02x", value & 0xff));
        return result.toString();
    }
}
