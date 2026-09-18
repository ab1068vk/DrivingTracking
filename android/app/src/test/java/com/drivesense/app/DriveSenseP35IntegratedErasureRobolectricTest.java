package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.util.Base64;

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
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35IntegratedErasureRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository trips;
    private DriveSenseSpeedArchiveRepository speed;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x65);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        trips.coordinator().write(db -> {
            db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY' WHERE id=1");
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(trips.coordinator());
        speed = new DriveSenseSpeedArchiveRepository(context);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
    }

    @Test public void exportLeaseBlocksTheWholeNativeErasureBeforeAnyGenerationChanges() throws Exception {
        Fixture fixture = populateAllNativeDomains();
        String tripGeneration = generation("archive_meta", "archive_generation");
        String speedGeneration = generation("speed_state", "speed_generation");
        insertLease("erasure-export");
        try {
            trips.rolloverGenerationForIdentityErasure("data_rights_test");
            fail("an export lease must block identity erasure before canonical mutation");
        } catch (IllegalStateException expected) {
            assertEquals("EXPORT_SNAPSHOT_CONFLICT_RETRY", expected.getMessage());
        }
        assertEquals(tripGeneration, generation("archive_meta", "archive_generation"));
        assertEquals(speedGeneration, generation("speed_state", "speed_generation"));
        assertNotNull(trips.getMetadata(fixture.tripId));
        assertNotNull(speed.open("dpz8"));
        assertTrue(fixture.activeDirectory.isDirectory());
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
    }

    @Test public void interruptedMultiDomainErasureRetriesToOneTruthfulCompleteState() throws Exception {
        Fixture fixture = populateAllNativeDomains();
        String oldTripGeneration = generation("archive_meta", "archive_generation");
        String oldSpeedGeneration = generation("speed_state", "speed_generation");

        // Simulate process loss after the trip generation committed but before
        // speed/spool/journal/legacy cleanup. No success receipt exists here.
        JSONObject tripResult = trips.rolloverGenerationForIdentityErasure("data_rights_interrupted");
        assertTrue(tripResult.getBoolean("verified"));
        assertNotEquals(oldTripGeneration, generation("archive_meta", "archive_generation"));
        assertEquals(oldSpeedGeneration, generation("speed_state", "speed_generation"));
        assertNotNull(speed.open("dpz8"));
        assertTrue(fixture.activeDirectory.isDirectory());
        assertTrue(DriveSenseCompletedTripJournal.hasCompletedTrip(context, "erasure-pending"));
        try {
            DriveSenseCompletedTripJournal.pendingTripIds(context, 10);
            fail("a dirty pre-erasure journal must not be admitted into the new generation");
        } catch (IllegalStateException expected) {
            assertEquals("JOURNAL_INDEX_DIRTY", expected.getMessage());
        }

        DriveSenseStorageCoordinator.resetForTests();
        trips = new DriveSenseTripArchiveRepository(context);
        speed = new DriveSenseSpeedArchiveRepository(context);
        JSONObject speedResult = speed.rolloverGeneration("data_rights_retry");
        assertTrue(speedResult.getBoolean("verified"));
        DriveSenseNativeTripStore.eraseAllForDataRights(context);
        DriveSenseActiveTripSpool.eraseAllForDataRights(context);

        JSONObject health = DriveSenseArchiveHealth.inventory(trips.coordinator());
        assertEquals("NATIVE", health.getString("authorityState"));
        assertEquals("HEALTHY", health.getString("recoveryState"));
        assertEquals(0L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(0L, speed.state().getLong("bucketCount"));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertFalse(fixture.activeDirectory.exists());
        assertEquals(0, directoryCount(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1/active_spools")));
        assertEquals(0, directoryCount(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1/rsas_v1")));

        DriveSenseEncryptedDomainRegistry.ReferenceProof oldReferences = trips.coordinator().exclusive(db ->
            DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(context, db, 1, false)
        );
        // P6 trip-derived references are removed transactionally with the trip
        // generation. If the remaining owners restore exact accounting during
        // their own erasure, the fresh registry proof may already be complete.
        DriveSenseEnvelopeKeyRotation rotation = new DriveSenseEnvelopeKeyRotation(trips.coordinator());
        for (int turn = 0; turn < 8 && !trips.coordinator().read(DriveSenseKeyReferenceCounts::isVerified); turn++) {
            JSONObject repaired = rotation.rotateBatch(2, 100);
            assertEquals(0, repaired.getInt("rewrapped"));
        }
        assertTrue(trips.coordinator().read(DriveSenseKeyReferenceCounts::isVerified));
        oldReferences = trips.coordinator().exclusive(db ->
            DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(context, db, 1, false)
        );
        assertTrue(oldReferences.provesZero());

        // A healthy new generation remains writable after the completed erase.
        commitTrip("after-erasure", 1_770_000_000_000L);
        assertNotNull(trips.getMetadata("after-erasure"));
        assertEquals(1L, trips.aggregates(new JSONObject()).getLong("liveCount"));
    }

    private Fixture populateAllNativeDomains() throws Exception {
        commitTrip("erasure-canonical", 1_769_000_000_000L);
        byte[] bucket = new JSONObject()
            .put("bucketId", "dpz8")
            .put("cells", new JSONObject().put("dpz800", new JSONObject().put("limitKmh", 50)))
            .toString().getBytes(StandardCharsets.UTF_8);
        JSONArray descriptors = new JSONArray().put(new JSONObject()
            .put("bucketId", "dpz8")
            .put("expectedBytes", bucket.length)
            .put("cellCount", 1)
            .put("payloadHash", DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(bucket))));
        String batch = speed.begin(descriptors).getString("batchId");
        speed.append(batch, "dpz8", 0, Base64.encodeToString(bucket, Base64.NO_WRAP));
        speed.finish(batch);
        Arrays.fill(bucket, (byte) 0);

        DriveSenseActiveTripSpool active = DriveSenseActiveTripSpool.create(
            context, "erasure-active", 1_769_100_000_000L, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        active.append(point(1_769_100_000_000L));
        File activeDirectory = active.directory();
        active.close();

        DriveSenseActiveTripSpool pending = DriveSenseActiveTripSpool.create(
            context, "erasure-pending", 1_769_200_000_000L, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        pending.append(point(1_769_200_000_000L));
        JSONObject completion = new JSONObject()
            .put("id", "erasure-pending")
            .put("start_time", 1_769_200_000_000L)
            .put("end_time", 1_769_200_001_000L)
            .put("end_time_ms", 1_769_200_001_000L)
            .put("status", "completed");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedActiveSpool(context, pending, completion));
        return new Fixture("erasure-canonical", activeDirectory);
    }

    private void insertLease(String id) throws Exception {
        trips.coordinator().write(db -> {
            ContentValues value = new ContentValues();
            value.put("lease_id", id);
            value.put("archive_generation", generation(db, "archive_meta", "archive_generation"));
            value.put("through_seq", 1);
            value.put("speed_generation", generation(db, "speed_state", "speed_generation"));
            value.put("speed_through_seq", 1);
            value.put("state", "ACTIVE"); value.put("owner_token", id);
            value.put("created_at_ms", System.currentTimeMillis()); value.put("updated_at_ms", System.currentTimeMillis());
            db.insertOrThrow("export_leases", null, value); return null;
        });
    }

    private void commitTrip(String id, long start) throws Exception {
        File source = new File(context.getCacheDir(), id + ".json");
        String json = "{\"id\":\"" + id + "\",\"start_time\":" + start + ",\"end_time\":" + (start + 60_000L) +
            ",\"status\":\"completed\",\"distance_km\":1,\"duration_seconds\":60,\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}]}";
        try (FileOutputStream output = new FileOutputStream(source, false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        }
        trips.commitSpool(source, id, "integrated_erasure_fixture");
        //noinspection ResultOfMethodCallIgnored
        source.delete();
    }

    private static JSONObject point(long timestamp) throws Exception {
        return new JSONObject().put("lat", 43.1).put("lng", -79.1)
            .put("timestamp", timestamp).put("speed_kmh", 30).put("accuracy", 5);
    }

    private String generation(String table, String column) throws Exception {
        return trips.coordinator().read(db -> generation(db, table, column));
    }

    private static String generation(android.database.sqlite.SQLiteDatabase db, String table, String column) {
        try (Cursor cursor = db.rawQuery("SELECT " + column + " FROM " + table + " WHERE id=1", null)) {
            cursor.moveToFirst(); return cursor.getString(0);
        }
    }

    private static int directoryCount(File directory) {
        File[] files = directory.listFiles(File::isDirectory); return files == null ? 0 : files.length;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static final class Fixture {
        final String tripId; final File activeDirectory;
        Fixture(String tripId, File activeDirectory) { this.tripId = tripId; this.activeDirectory = activeDirectory; }
    }
}
