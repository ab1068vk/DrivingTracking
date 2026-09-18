package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Executable end-to-end proof that a 50+ MiB trip never becomes one native byte array. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35LargeTripRobolectricTest {
    private Context context;

    @Before public void setUp() {
        ShadowLog.stream = System.err;
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_v1"));
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 0x35);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        Arrays.fill(key, (byte) 0);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void journalToCanonicalArchiveStreamsFiftyMegabyteTrip() throws Exception {
        File source = new File(context.getCacheDir(), "p35-large-trip-source.json");
        writeLargeTrip(source, 52L * 1024L * 1024L);
        assertTrue(source.length() > 50L * 1024L * 1024L);

        assertTrue(DriveSenseCompletedTripJournal.addCompletedTripSpool(context, source, "large-trip-1"));
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject result = repository.ingestCompletedJournal(1, 32L * 1024L * 1024L);
        assertEquals(1, result.getInt("itemCount"));
        assertEquals("COMMITTED_ACKNOWLEDGED", result.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertTrue(result.getJSONArray("receipts").getJSONObject(0).getInt("maxSourceChunkBytes") <= 320 * 1024);
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());

        JSONObject metadata = repository.getMetadata("large-trip-1");
        assertNotNull(metadata);
        assertTrue(metadata.getInt("point_count") > 10_000);
        byte[] overview = repository.overview("large-trip-1", 900);
        assertNotNull(overview);
        assertTrue(new JSONObject(new String(overview, StandardCharsets.UTF_8)).getJSONArray("points").length() <= 2_000);

        long streamed = 0L;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (DriveSenseTripArchiveRepository.PayloadDescriptor descriptor = repository.descriptor("large-trip-1", null)) {
            assertNotNull(descriptor);
            assertTrue(descriptor.plaintextBytes > 50L * 1024L * 1024L);
            for (int index = 0; index < descriptor.chunkCount; index++) {
                byte[] chunk = repository.readPayloadChunk(descriptor, index);
                assertTrue(chunk.length <= DriveSenseTripChunkStore.CHUNK_BYTES);
                streamed += chunk.length;
                digest.update(chunk);
                Arrays.fill(chunk, (byte) 0);
            }
            assertEquals(descriptor.plaintextBytes, streamed);
            assertTrue(MessageDigest.isEqual(descriptor.payloadHash, digest.digest()));
        }
        assertFalse(DriveSenseCompletedTripJournal.hasCompletedTrip(context, "large-trip-1"));
        assertTrue(source.delete());
    }

    private static void writeLargeTrip(File file, long minimumBytes) throws Exception {
        byte[] prefix = ("{\"id\":\"large-trip-1\",\"start_time\":\"2026-08-21T12:00:00Z\"," +
            "\"end_time\":\"2026-08-21T14:00:00Z\",\"status\":\"completed\"," +
            "\"distance_km\":120.5,\"duration_seconds\":7200,\"route_points\":[")
            .getBytes(StandardCharsets.UTF_8);
        byte[] suffix = "]}".getBytes(StandardCharsets.UTF_8);
        String filler = "x".repeat(896);
        try (FileOutputStream raw = new FileOutputStream(file, false);
             BufferedOutputStream output = new BufferedOutputStream(raw, 64 * 1024)) {
            output.write(prefix);
            int index = 0;
            while (file.length() < minimumBytes || index < 10_000) {
                if (index > 0) output.write(',');
                String point = "{\"lat\":" + (43.0 + (index % 1000) * 0.000001) +
                    ",\"lng\":" + (-79.0 - (index % 1000) * 0.000001) +
                    ",\"timestamp\":" + (1_776_945_600_000L + index * 1000L) +
                    ",\"source_padding\":\"" + filler + "\"}";
                output.write(point.getBytes(StandardCharsets.UTF_8));
                index++;
                if ((index & 1023) == 0) output.flush();
            }
            output.write(suffix);
            output.flush();
            raw.getFD().sync();
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
