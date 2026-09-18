package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
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
public class DriveSenseP35IntegrityRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository repository;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x51);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        repository = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(repository.coordinator());
    }

    @After public void tearDown() {
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);
        DriveSenseArchiveIntegrity.setFaultPointForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void scheduledReconciliationDetectsSilentNonTipDeletionAndBlocksMutation() throws Exception {
        commit("trip-a", 1_700_000_000_000L);
        commit("trip-b", 1_700_000_100_000L);
        DriveSenseArchiveIntegrity.CheckpointResult before = DriveSenseArchiveIntegrity.createCheckpoint(repository.coordinator());
        assertTrue(before.verified);

        JSONObject fastBefore = DriveSenseArchiveHealth.inventory(repository.coordinator());
        assertTrue(fastBefore.getBoolean("sentinelMatches"));
        assertEquals("FAST_HEALTHY", fastBefore.getString("healthCode"));

        // Simulate backing-store loss outside the canonical mutation/event protocol.
        repository.coordinator().write(db -> {
            assertEquals(1, db.delete("trip_current", "trip_id=?", new String[]{"trip-a"}));
            return null;
        });

        JSONObject stillFastHealthy = DriveSenseArchiveHealth.inventory(repository.coordinator());
        assertTrue(stillFastHealthy.getBoolean("sentinelMatches"));
        assertEquals("FAST_HEALTHY", stillFastHealthy.getString("healthCode"));
        assertFalse(DriveSenseArchiveIntegrity.reconcileCount(repository.coordinator()));

        JSONObject blocked = DriveSenseArchiveHealth.inventory(repository.coordinator());
        assertEquals("RECOVERY_REQUIRED", blocked.getString("recoveryState"));
        try {
            commit("trip-c", 1_700_000_200_000L);
            fail("Mutation must fail closed after silent membership loss");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("RECOVERY_REQUIRED"));
        }

        DriveSenseArchiveIntegrity.CheckpointResult after = DriveSenseArchiveIntegrity.createCheckpoint(repository.coordinator());
        assertFalse(after.verified);
        assertNotEquals(DriveSenseEnvelopeCrypto.hex(before.root), DriveSenseEnvelopeCrypto.hex(after.root));
    }

    @Test public void commitRecoveryIsIdempotentAcrossEveryDurabilityBoundary() throws Exception {
        String[] boundaries = {
            "BEFORE_PENDING",
            "AFTER_PENDING",
            "AFTER_CHUNKS_PUBLISHED",
            "AFTER_OVERVIEW_PUBLISHED",
            "AFTER_COMMITTED_BEFORE_SENTINEL",
            "AFTER_SENTINEL_BEFORE_VERIFY",
        };
        for (int index = 0; index < boundaries.length; index++) {
            DriveSenseStorageCoordinator.resetForTests();
            context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
            deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
            repository = new DriveSenseTripArchiveRepository(context);
            DriveSenseArchiveHealth.inventory(repository.coordinator());
            String id = "fault-" + index;
            File source = source(id, 1_710_000_000_000L + index * 100_000L);
            DriveSenseTripArchiveRepository.setFaultPointForTests(boundaries[index]);
            try {
                repository.commitSpool(source, id, "fault_fixture");
                fail("Expected injected crash boundary " + boundaries[index]);
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("TEST_FAULT_"));
            }

            DriveSenseStorageCoordinator.resetForTests();
            repository = new DriveSenseTripArchiveRepository(context);
            JSONObject recovered = repository.commitSpool(source, id, "fault_retry");
            assertTrue(recovered.getBoolean("verified"));
            assertNotNull(repository.getMetadata(id));
            JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
            assertTrue(health.getBoolean("sentinelMatches"));
            long[] pending = repository.coordinator().read(db -> {
                try (android.database.Cursor rows = db.rawQuery(
                    "SELECT (SELECT COUNT(*) FROM trip_revisions WHERE commit_state='PENDING')," +
                        "(SELECT COUNT(*) FROM open_operations WHERE operation_type='TRIP_COMMIT')", null)) {
                    rows.moveToFirst(); return new long[]{rows.getLong(0), rows.getLong(1)};
                }
            });
            assertEquals(0L, pending[0]);
            assertEquals(0L, pending[1]);
            assertTrue(source.delete());
        }
    }

    @Test public void identityErasureRollsGenerationAndRemovesOldIdentityAndPayloads() throws Exception {
        commit("erase-a", 1_720_000_000_000L);
        commit("erase-b", 1_720_000_100_000L);
        JSONObject before = DriveSenseArchiveHealth.inventory(repository.coordinator());
        String oldGeneration = before.getString("archiveGeneration");
        long filesBefore = repository.coordinator().read(db -> {
            try (android.database.Cursor rows = db.rawQuery("SELECT COUNT(*) FROM trip_chunks", null)) {
                rows.moveToFirst(); return rows.getLong(0);
            }
        });
        assertTrue(filesBefore > 0L);

        JSONObject erased = repository.rolloverGenerationForIdentityErasure("test_data_rights");
        assertTrue(erased.getBoolean("erased"));
        assertEquals(2L, erased.getLong("removedTripCount"));
        assertNotEquals(oldGeneration, erased.getString("archiveGeneration"));
        assertTrue(repository.getMetadata("erase-a") == null);
        long[] counts = repository.coordinator().read(db -> {
            try (android.database.Cursor rows = db.rawQuery(
                "SELECT (SELECT COUNT(*) FROM trip_current)," +
                    "(SELECT COUNT(*) FROM trip_revisions)," +
                    "(SELECT COUNT(*) FROM trip_chunks)," +
                    "(SELECT COUNT(*) FROM archive_events WHERE trip_id IS NOT NULL)," +
                    "(SELECT COUNT(*) FROM key_reference_counts WHERE domain_id='trip_archive')", null)) {
                rows.moveToFirst();
                return new long[]{rows.getLong(0),rows.getLong(1),rows.getLong(2),rows.getLong(3),rows.getLong(4)};
            }
        });
        assertTrue(Arrays.equals(new long[]{0,0,0,0,0}, counts));
        JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
        assertEquals("HEALTHY", health.getString("recoveryState"));
        assertTrue(health.getBoolean("sentinelMatches"));
        commit("post-erase", 1_720_000_200_000L);
        assertNotNull(repository.getMetadata("post-erase"));
    }

    @Test public void corruptCommittedChunkFailsClosedAndLowSpaceLeavesNoCanonicalResidue() throws Exception {
        commit("corrupt-me",1_730_000_000_000L);
        String relative=repository.coordinator().read(db->{try(android.database.Cursor c=db.rawQuery("SELECT relative_path FROM trip_chunks WHERE trip_id='corrupt-me' ORDER BY chunk_index LIMIT 1",null)){c.moveToFirst();return c.getString(0);}});
        File chunk=new DriveSenseTripChunkStore(context).relativeFile(relative);
        assertTrue(chunk.isFile());assertTrue(chunk.delete());
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor("corrupt-me",null)){
            try{repository.readPayloadChunk(descriptor,0);fail("Missing committed chunk must fail");}
            catch(Exception expected){assertNotNull(expected.getMessage());}
        }
        assertEquals("RECOVERY_REQUIRED",DriveSenseArchiveHealth.inventory(repository.coordinator()).getString("recoveryState"));

        DriveSenseStorageCoordinator.resetForTests();context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1"));deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_archive_meta"));
        repository=new DriveSenseTripArchiveRepository(context);DriveSenseArchiveHealth.inventory(repository.coordinator());
        DriveSenseStorageAdmission.setAvailableBytesForTests(128L*1024L*1024L);
        File source=source("low-space",1_730_000_100_000L);
        try{repository.commitSpool(source,"low-space","low_space_fixture");fail("Low space must refuse before PENDING");}
        catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("LOW_SPACE_BLOCKED"));}
        long[] counts=repository.coordinator().read(db->{try(android.database.Cursor c=db.rawQuery("SELECT (SELECT COUNT(*) FROM trip_current),(SELECT COUNT(*) FROM trip_revisions),(SELECT COUNT(*) FROM trip_chunks)",null)){c.moveToFirst();return new long[]{c.getLong(0),c.getLong(1),c.getLong(2)};}});
        assertTrue(Arrays.equals(new long[]{0,0,0},counts));assertTrue(source.delete());
    }

    private void commit(String id, long startMs) throws Exception {
        File source = source(id, startMs);
        try { repository.commitSpool(source, id, "test"); }
        finally { source.delete(); }
    }

    private File source(String id, long startMs) throws Exception {
        File source = new File(context.getCacheDir(), id + ".json");
        String json = "{\"id\":\"" + id + "\",\"start_time\":" + startMs +
            ",\"end_time\":" + (startMs + 60_000L) +
            ",\"status\":\"completed\",\"distance_km\":1.2,\"duration_seconds\":60," +
            "\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}]}";
        try (FileOutputStream output = new FileOutputStream(source, false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        return source;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
