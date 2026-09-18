package com.drivesense.app;

import static org.junit.Assert.assertEquals;
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
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;

/** Exact local reproduction of the real PH-3-record failure exposed by PH-7 restore. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class PhysicalHBackupRestoreIntegrityTest {
    private static final String TRIP_ID = "physical-h-seedphysicalhfixtures-1800000000000";
    private static final String PASSPHRASE = "physical-h-portable-fixture-v2";

    private Context context;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        resetCanonical(false);
        installKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
    }

    @After public void tearDown() {
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
    }

    @Test public void exactPh3ActiveStreamSurvivesRotationVerifiedBackupAndRestore() throws Exception {
        ServiceController<DriveSenseAutoTrackingService> controller =
            Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        try {
            DriveSenseAutoTrackingService service = controller.get();
            long startMs = 1_800_000_000_000L;
            assertTrue(service.beginActiveRouteForTests(TRIP_ID, startMs));
            PhysicalHIncrementalRouteGenerator generator = new PhysicalHIncrementalRouteGenerator(
                0x504859534943414cL, startMs, 64);
            while (!generator.reached(1_000L, 0L, 0d)) {
                generator.appendNext(service::appendActivePointForTests);
            }
            JSONObject completion = new JSONObject()
                .put("id", TRIP_ID)
                .put("start_time", startMs)
                .put("end_time", startMs + generator.pointCount() * 1000L)
                .put("status", "completed")
                .put("distance_km", generator.generatedDistanceMetres() / 1000d)
                .put("duration_seconds", generator.pointCount());
            assertTrue(service.sealActiveRouteToJournalForTests(completion));
            ByteArrayOutputStream journalBytes = new ByteArrayOutputStream();
            DriveSenseCompletedTripJournal.JournalStreamResult journalResult =
                DriveSenseCompletedTripJournal.streamCompletedTripTo(context, TRIP_ID, journalBytes);

            DriveSenseTripArchiveRepository trips = new DriveSenseTripArchiveRepository(context);
            JSONObject ingested = trips.ingestCompletedJournal(1, 32L * 1024L * 1024L);
            JSONArray receipts = ingested.getJSONArray("receipts");
            assertEquals(1, receipts.length());
            assertEquals("COMMITTED_ACKNOWLEDGED", receipts.getJSONObject(0).getString("status"));
            try (DriveSenseTripArchiveRepository.PayloadDescriptor descriptor = trips.descriptor(TRIP_ID, null)) {
                assertNotNull(descriptor);
                assertEquals(189_260L, descriptor.plaintextBytes);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                ByteArrayOutputStream canonicalBytes = new ByteArrayOutputStream();
                long bytes = 0L;
                for (int index = 0; index < descriptor.chunkCount; index++) {
                    byte[] chunk = trips.readPayloadChunk(descriptor, index);
                    try { digest.update(chunk); canonicalBytes.write(chunk); bytes += chunk.length; }
                    finally { Arrays.fill(chunk, (byte) 0); }
                }
                assertEquals(descriptor.plaintextBytes, bytes);
                String expectedHash = DriveSenseEnvelopeCrypto.hex(descriptor.payloadHash);
                String actualHash = DriveSenseEnvelopeCrypto.hex(digest.digest());
                assertEquals(journalResult.sha256, expectedHash);
                byte[] source = journalBytes.toByteArray();
                byte[] canonical = canonicalBytes.toByteArray();
                int firstDifference = firstDifference(source, canonical);
                assertEquals("canonical stream differs from journal stream at byte " + firstDifference,
                    -1, firstDifference);
                assertEquals("canonical descriptor hash must identify its exact decrypted bytes",
                    expectedHash, actualHash);
            }

            DriveSenseEnvelopeKeyRotation rotation = new DriveSenseEnvelopeKeyRotation(trips.coordinator());
            JSONObject rotationResult;
            do { rotationResult = rotation.rotateBatch(2, 100); }
            while (!rotationResult.getBoolean("complete"));

            DriveSenseSpeedArchiveRepository speed = new DriveSenseSpeedArchiveRepository(context);
            DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(context, trips, speed);
            JSONObject backup = awaitDone(manager,
                manager.begin("physical-h-portable-v2", PASSPHRASE).getString("operationId"));
            assertEquals(backup.toString(), "COMPLETE", backup.getString("phase"));
            assertTrue(backup.getBoolean("verified"));
            File portable = new File(backup.getString("nativePath"));

            DriveSenseStreamBackupManager.resetForTests();
            resetCanonical(true);
            installKeys();
            DriveSenseTripArchiveRepository restoredTrips = new DriveSenseTripArchiveRepository(context);
            DriveSenseArchiveHealth.inventory(restoredTrips.coordinator());
            DriveSenseSpeedArchiveRepository restoredSpeed = new DriveSenseSpeedArchiveRepository(context);
            JSONObject restored = new DriveSenseStreamBackupRestore(restoredTrips, restoredSpeed)
                .restore(portable, PASSPHRASE.toCharArray());

            assertTrue(restored.getBoolean("verified"));
            assertEquals(1L, restored.getLong("tripCount"));
            assertNotNull(restoredTrips.getMetadata(TRIP_ID));
            assertEquals(1L, restoredTrips.aggregates(new JSONObject()).getLong("liveCount"));
            assertEquals(0L, DriveSenseArchiveHealth.inventory(restoredTrips.coordinator()).getLong("pendingCount"));
        } finally {
            controller.destroy();
        }
    }

    private static JSONObject awaitDone(DriveSenseStreamBackupManager manager, String operationId) throws Exception {
        for (int attempt = 0; attempt < 1_000; attempt++) {
            JSONObject status = manager.status(operationId);
            if (status.getBoolean("done")) return status;
            Thread.sleep(10L);
        }
        throw new AssertionError("Portable operation did not finish");
    }

    private void resetCanonical(boolean keepBackup) {
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        if (!keepBackup) deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2"));
    }

    private static void installKeys() {
        byte[] version1 = new byte[32]; Arrays.fill(version1, (byte) 0x43);
        byte[] version2 = new byte[32]; Arrays.fill(version2, (byte) 0x44);
        byte[] portable = new byte[32]; Arrays.fill(portable, (byte) 0x26);
        DriveSenseEnvelopeCrypto.installTestKek(1, version1);
        DriveSenseEnvelopeCrypto.installTestKek(2, version2);
        DriveSensePayloadCrypto.installTestKey(0, version1);
        DriveSenseStreamBackupManager.installPortableKeyForTests(portable);
        Arrays.fill(version1, (byte) 0);
        Arrays.fill(version2, (byte) 0);
        Arrays.fill(portable, (byte) 0);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static int firstDifference(byte[] left, byte[] right) {
        int length = Math.min(left.length, right.length);
        for (int index = 0; index < length; index++) if (left[index] != right[index]) return index;
        return left.length == right.length ? -1 : length;
    }
}
