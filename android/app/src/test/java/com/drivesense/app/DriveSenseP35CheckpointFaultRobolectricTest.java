package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.database.Cursor;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35CheckpointFaultRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository repository;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x63);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        resetArchive();
    }

    @After public void tearDown() {
        DriveSenseArchiveIntegrity.setFaultPointForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void checkpointRestartsSafelyAtEveryPreCompactionBoundary() throws Exception {
        String[] faults = new String[]{
            "BEFORE_CHECKPOINT_SCAN",
            "DURING_CHECKPOINT_SCAN",
            "AFTER_SCAN_BEFORE_CHECKPOINT_EVENT",
            "AFTER_CHECKPOINT_EVENT_BEFORE_SENTINEL",
            "BEFORE_CHECKPOINT_COMPACTION"
        };
        for (String fault : faults) {
            resetArchive();
            commit("checkpoint-" + fault.toLowerCase(), 1_740_000_000_000L);
            long eventsBefore = scalar("SELECT COUNT(*) FROM archive_events");
            DriveSenseArchiveIntegrity.setFaultPointForTests(fault);
            try {
                DriveSenseArchiveIntegrity.createCheckpoint(repository.coordinator());
                fail("Expected checkpoint fault " + fault);
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("TEST_FAULT_" + fault));
            }

            // Recreate the repository as a process-restart model. Recovery may only
            // complete a checkpoint when its COMMITTED job and event match.
            repository = new DriveSenseTripArchiveRepository(context);
            long committedJobsWithoutEvent = scalar(
                "SELECT COUNT(*) FROM integrity_checkpoint_jobs j " +
                "LEFT JOIN archive_events e ON e.event_type='CHECKPOINT' " +
                "AND e.through_seq=j.through_seq " +
                "AND e.checkpoint_live_count=j.live_count " +
                "AND e.live_set_root=j.live_set_root " +
                "WHERE j.state='COMMITTED' AND e.seq IS NULL"
            );
            assertEquals(0L, committedJobsWithoutEvent);
            assertEquals(0L, scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs WHERE state='PENDING'"));
            assertTrue(scalar("SELECT COUNT(*) FROM archive_events") >= eventsBefore);
            assertTrue(DriveSenseArchiveHealth.inventory(repository.coordinator()).getBoolean("sentinelMatches"));
        }
    }

    @Test public void interruptedCompactionRollsBackTheEntireProofWindow() throws Exception {
        commit("checkpoint-compaction", 1_741_000_000_000L);
        for (int i = 0; i < 12; i++) {
            assertTrue(DriveSenseArchiveIntegrity.createCheckpoint(repository.coordinator()).verified);
        }
        long eventCountBefore = scalar("SELECT COUNT(*) FROM archive_events");
        long minSeqBefore = scalar("SELECT MIN(seq) FROM archive_events");
        long jobsBefore = scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs");

        DriveSenseArchiveIntegrity.setFaultPointForTests("DURING_CHECKPOINT_COMPACTION");
        try {
            DriveSenseArchiveIntegrity.createCheckpoint(repository.coordinator());
            fail("Expected compaction interruption");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("TEST_FAULT_DURING_CHECKPOINT_COMPACTION"));
        }

        // The new checkpoint was committed before compaction, but both compaction
        // deletes are one transaction. The old proof-window anchor must survive.
        assertEquals(minSeqBefore, scalar("SELECT MIN(seq) FROM archive_events"));
        assertEquals(eventCountBefore + 1L, scalar("SELECT COUNT(*) FROM archive_events"));
        assertEquals(jobsBefore + 1L, scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs"));

        repository = new DriveSenseTripArchiveRepository(context);
        assertTrue(DriveSenseArchiveHealth.inventory(repository.coordinator()).getBoolean("sentinelMatches"));
        assertTrue(scalar("SELECT COUNT(*) FROM archive_events WHERE event_type='CHECKPOINT'") >= 12L);
    }

    private void resetArchive() throws Exception {
        DriveSenseArchiveIntegrity.setFaultPointForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        repository = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(repository.coordinator());
    }

    private void commit(String id, long startMs) throws Exception {
        File source = new File(context.getCacheDir(), id + ".json");
        String json = "{\"id\":\"" + id + "\",\"start_time\":" + startMs +
            ",\"end_time\":" + (startMs + 60_000L) +
            ",\"status\":\"completed\",\"distance_km\":1.2,\"duration_seconds\":60," +
            "\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}]}";
        try (FileOutputStream output = new FileOutputStream(source, false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        try { repository.commitSpool(source, id, "checkpoint_fault_fixture"); }
        finally { source.delete(); }
    }

    private long scalar(String sql) throws Exception {
        return repository.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery(sql, null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("scalar query failed");
                return cursor.getLong(0);
            }
        });
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
