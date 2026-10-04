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

import java.io.File;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseDpd055JournalRobolectricTest {
    private Context context;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        DriveSenseNativeTripStore.prefs(context).edit()
            .remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS).commit();
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 0x55);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
    }

    @After public void tearDown() {
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void legacyJournalRetainsFormatAcrossRouteSizes() throws Exception {
        for (int count : new int[] { 100, 250, 500, 1000, 2000, 5000 }) {
            JSONObject trip = trip("dpd055-size-" + count, count);
            long start = System.nanoTime();
            assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, trip));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000L;
            JSONObject restored = DriveSenseCompletedTripJournal.getCompletedTrip(context, trip.getString("id"));
            assertNotNull(restored);
            assertEquals(count, restored.getJSONArray("route_points").length());
            File[] chunks = DriveSenseCompletedTripJournal.directory(context).listFiles(
                (dir, name) -> name.endsWith(".chunk.enc")
            );
            int totalChunks = chunks == null ? 0 : chunks.length;
            assertTrue(totalChunks > 0);
            System.out.println("DPD055_SIZE points=" + count + " elapsed_ms=" + elapsedMs +
                " cumulative_chunks=" + totalChunks + " json_bytes=" + trip.toString().getBytes("UTF-8").length);
        }
        assertEquals(6, DriveSenseCompletedTripJournal.getStatus(context).getInt("pendingCount"));
    }

    @Test public void failedCommitHasNoFalseAcknowledgementAndRetryIsOneGeneration() throws Exception {
        JSONObject trip = trip("dpd055-retry", 250);
        DriveSenseCompletedTripJournal.setFaultPointForTests("BEFORE_JOURNAL_MANIFEST_WRITE");
        assertFalse(DriveSenseCompletedTripJournal.addCompletedTrip(context, trip));
        assertFalse(DriveSenseCompletedTripJournal.hasCompletedTrip(context, "dpd055-retry"));
        DriveSenseCompletedTripJournal.setFaultPointForTests(null);
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTripIfAbsent(context, trip, () -> false));
        File manifest = manifestFor("dpd055-retry");
        byte[] before = Files.readAllBytes(manifest.toPath());
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTripIfAbsent(context, trip, () -> false));
        assertTrue(Arrays.equals(before, Files.readAllBytes(manifest.toPath())));
        DriveSenseStorageCoordinator.resetForTests();
        assertNotNull(DriveSenseCompletedTripJournal.getCompletedTrip(context, "dpd055-retry"));
        assertEquals(1, DriveSenseCompletedTripJournal.getStatus(context).getInt("pendingCount"));
    }

    @Test public void cancelledQueuedCompletionCannotRecreateErasedJournal() throws Exception {
        JSONObject trip = trip("dpd055-erased", 250);
        assertFalse(DriveSenseCompletedTripJournal.addCompletedTripIfAbsent(context, trip, () -> true));
        assertFalse(DriveSenseCompletedTripJournal.hasCompletedTrip(context, "dpd055-erased"));
        assertEquals(0, DriveSenseCompletedTripJournal.getStatus(context).getInt("pendingCount"));
    }

    @Test public void ordinaryJournalUpdateStillRewritesExistingEmergencyState() throws Exception {
        // Robolectric's Windows AtomicFile implementation cannot rename .new over
        // an existing target. Keep this correctness test active on Linux CI.
        org.junit.Assume.assumeFalse(
            System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")
        );
        JSONObject trip = trip("dpd055-emergency-update", 100);
        trip.put("emergency_workflow_pending", true);
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, trip));
        trip.put("emergency_workflow_pending", false);
        trip.put("emergency_workflow_acknowledged", "ok");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, trip));
        JSONObject restored = DriveSenseCompletedTripJournal.getCompletedTrip(context, trip.getString("id"));
        assertNotNull(restored);
        assertFalse(restored.getBoolean("emergency_workflow_pending"));
        assertEquals("ok", restored.getString("emergency_workflow_acknowledged"));
    }

    private File manifestFor(String id) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes("UTF-8"));
        StringBuilder stem = new StringBuilder();
        for (byte value : digest) stem.append(String.format("%02x", value & 0xff));
        return new File(DriveSenseCompletedTripJournal.directory(context),
            stem.substring(0, 32) + ".manifest.enc");
    }

    private static JSONObject trip(String id, int count) throws Exception {
        JSONArray points = new JSONArray();
        for (int i = 0; i < count; i++) {
            points.put(new JSONObject().put("lat", 43.7 + i * 0.00002)
                .put("lng", -79.4 + i * 0.00002)
                .put("timestamp", "2026-10-03T12:00:00.000Z")
                .put("speed_kmh", 40));
        }
        return new JSONObject().put("id", id).put("status", "completed")
            .put("start_time", "2026-10-03T12:00:00.000Z")
            .put("end_time", "2026-10-03T12:30:00.000Z")
            .put("route_points", points);
    }

    private static void deleteTree(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
