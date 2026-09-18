package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Robolectric;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35BackupRestoreRobolectricTest {
    private Context context;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        resetStorage();
        installKeys((byte) 0x61);
    }

    @After public void tearDown() {
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void portableV2RestoresTripsAndSpeedAfterInternalKeyLoss() throws Exception {
        DriveSenseTripArchiveRepository trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        File trip = jsonFile("backup-trip.json", "{\"id\":\"backup-trip\",\"start_time\":\"2026-08-21T12:00:00Z\",\"end_time\":\"2026-08-21T12:05:00Z\",\"status\":\"completed\",\"distance_km\":2.5,\"duration_seconds\":300,\"route_points\":[{\"lat\":43.1,\"lng\":-79.1,\"timestamp\":1776945600000}]}");
        trips.commitSpool(trip, "backup-trip", "backup_fixture");
        DriveSenseSpeedArchiveRepository speed = new DriveSenseSpeedArchiveRepository(context);
        File bucket = jsonFile("speed-bucket.json", "{\"bucketId\":\"dpz8\",\"schemaVersion\":1,\"cells\":{\"dpz8abc\":{\"speedLimitKmh\":50}}}");
        speed.restoreSpool(bucket, "dpz8", 1, sha256(bucket));
        context.getSharedPreferences(DriveSensePortableBackupDomains.PREFS_NAME,Context.MODE_PRIVATE).edit()
            .putString("drivesense_vehicles","[{\"id\":\"vehicle-1\",\"name\":\"Road Sage\"}]")
            .putString("drivesense_settings","{\"units\":\"metric\",\"privacy_zones\":[{\"id\":\"home\",\"label\":\"Home\",\"lat\":43.1,\"lng\":-79.1,\"radius_m\":250}]}")
            .putString("road_sage_trip_filter_presets","[{\"name\":\"Work\"}]")
            .putString("road_sage_calibration_labels","[{\"tripId\":\"backup-trip\"}]")
            .putString("road_sage_calibration_survey_markers","{\"backup-trip\":{\"reviewed\":true}}")
            .commit();

        DriveSenseStreamBackupManager manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        JSONObject started = manager.begin("roundtrip", "correct horse battery staple");
        JSONObject status = await(manager, started.getString("operationId"));
        assertTrue(status.getBoolean("verified"));
        File portable = new File(status.getString("nativePath"));
        assertTrue(portable.isFile());

        long liveBeforeNegativeVerification = trips.aggregates(new JSONObject()).getLong("liveCount");
        byte[] wrongPortableKey = new byte[32]; Arrays.fill(wrongPortableKey, (byte) 0x30);
        DriveSenseStreamBackupManager.installPortableKeyForTests(wrongPortableKey);
        Arrays.fill(wrongPortableKey, (byte) 0);
        try {
            new DriveSenseStreamBackupRestore(trips, speed)
                .verifyOnly(portable, "wrong portable passphrase".toCharArray());
            fail("Wrong portable key must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("authentication"));
        } finally {
            byte[] portableKey = new byte[32]; Arrays.fill(portableKey, (byte) 0x2f);
            DriveSenseStreamBackupManager.installPortableKeyForTests(portableKey);
            Arrays.fill(portableKey, (byte) 0);
        }
        assertEquals(liveBeforeNegativeVerification, trips.aggregates(new JSONObject()).getLong("liveCount"));

        // Simulate loss of the device-bound archive and its Android-Keystore keys.
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        context.getSharedPreferences(DriveSensePortableBackupDomains.PREFS_NAME,Context.MODE_PRIVATE).edit().clear().commit();
        installKeys((byte) 0x72);

        DriveSenseTripArchiveRepository restoredTrips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(restoredTrips.coordinator());
        DriveSenseSpeedArchiveRepository restoredSpeed = new DriveSenseSpeedArchiveRepository(context);
        JSONObject restored = new DriveSenseStreamBackupRestore(restoredTrips, restoredSpeed)
            .restore(portable, "correct horse battery staple".toCharArray());
        assertTrue(restored.getBoolean("verified"));
        assertEquals(1, restored.getLong("tripCount"));
        assertEquals(1, restored.getLong("speedBucketCount"));
        assertEquals(5, restored.getLong("portableDomainCount"));
        assertNotNull(restoredTrips.getMetadata("backup-trip"));
        assertNotNull(restoredSpeed.open("dpz8"));
        JSONObject health = DriveSenseArchiveHealth.inventory(restoredTrips.coordinator());
        assertEquals("NATIVE", health.getString("authorityState"));
        assertTrue(health.getBoolean("sentinelMatches"));
        String restoredSettings=context.getSharedPreferences(DriveSensePortableBackupDomains.PREFS_NAME,Context.MODE_PRIVATE).getString("drivesense_settings","");
        assertTrue(restoredSettings.contains("\"units\":\"metric\""));
        assertTrue(restoredSettings.contains("masked_for_privacy"));
        assertTrue(!restoredSettings.contains("\"lat\""));
        assertTrue(context.getSharedPreferences(DriveSensePortableBackupDomains.PREFS_NAME,Context.MODE_PRIVATE).contains("drivesense_vehicles"));

        File truncated = new File(context.getCacheDir(), "roundtrip-truncated.rsb2");
        copyPrefix(portable, truncated, portable.length() - 24);
        try {
            new DriveSenseStreamBackupRestore(restoredTrips, restoredSpeed)
                .verifyOnly(truncated, "correct horse battery staple".toCharArray());
            fail("Truncated backup must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("trailer") || expected.getMessage().contains("frame"));
        }

        assertRejected(mutatePortable(portable,"substitution",Mutation.SUBSTITUTE));
        assertRejected(mutatePortable(portable,"wrong-aad",Mutation.WRONG_AAD));
        assertRejected(mutatePortable(portable,"duplicate-index",Mutation.DUPLICATE_INDEX));
        assertRejected(mutatePortable(portable,"reorder",Mutation.REORDER));
        assertRejected(mutateHeaderGeneration(portable));
        assertEquals("negative verification must not mutate canonical state", 1L,
            restoredTrips.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(0L, DriveSenseArchiveHealth.inventory(restoredTrips.coordinator()).getLong("pendingCount"));

        // Exercise the reviewed Storage Access Framework/content-provider path.
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        context.getSharedPreferences(DriveSensePortableBackupDomains.PREFS_NAME,Context.MODE_PRIVATE).edit().clear().commit();
        installKeys((byte) 0x73);
        DriveSenseTripArchiveRepository providerTrips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(providerTrips.coordinator());
        DriveSenseSpeedArchiveRepository providerSpeed = new DriveSenseSpeedArchiveRepository(context);
        BackupFileProvider.source = portable;
        Robolectric.setupContentProvider(BackupFileProvider.class, "roadsage.backup.fixture");
        DriveSenseStreamBackupManager uriManager = DriveSenseStreamBackupManager.get(context, providerTrips, providerSpeed);
        JSONObject uriStarted = uriManager.beginRestoreFromUri(
            "content://roadsage.backup.fixture/roundtrip.rsb2",
            "correct horse battery staple"
        );
        JSONObject uriRestored = await(uriManager, uriStarted.getString("operationId"));
        assertTrue(uriRestored.getBoolean("verified"));
        assertEquals("COMPLETE", uriRestored.getString("phase"));

        DriveSenseStorageAdmission.setAvailableBytesForTests(64L * 1024L * 1024L);
        JSONObject lowSpaceStarted = uriManager.beginRestoreFromUri(
            "content://roadsage.backup.fixture/roundtrip.rsb2",
            "correct horse battery staple"
        );
        JSONObject lowSpace = awaitDone(uriManager, lowSpaceStarted.getString("operationId"));
        assertEquals("FAILED", lowSpace.getString("phase"));
        assertTrue(lowSpace.getString("error").contains("LOW_SPACE_BLOCKED"));
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
    }

    @Test public void recordManifestRejectsWrongPayloadHashWithoutCanonicalMutation() throws Exception {
        DriveSenseTripArchiveRepository trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        byte[] actual = new byte[] { 1, 2, 3 };
        byte[] other = new byte[] { 1, 2, 4 };
        JSONObject metadata = new JSONObject()
            .put("tripId", "manifest-negative")
            .put("payloadBytes", actual.length)
            .put("chunkCount", 1)
            .put("payloadHash", DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(other)));
        DriveSenseStreamBackupRestore.RecordVerifier verifier =
            DriveSenseStreamBackupRestore.RecordVerifier.begin(1, metadata);
        verifier.append(actual);
        try {
            verifier.verify();
            fail("Invalid canonical record hash must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("Backup record manifest mismatch"));
        }
        assertEquals(0L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(0L, DriveSenseArchiveHealth.inventory(trips.coordinator()).getLong("pendingCount"));
    }

    @Test public void unrelatedPickerArtifactReachesNativeFormatValidationAndIsRejected() throws Exception {
        DriveSenseTripArchiveRepository trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        DriveSenseSpeedArchiveRepository speed = new DriveSenseSpeedArchiveRepository(context);
        File unrelated = jsonFile("unrelated-picker-artifact.bin", "not an rsb2 archive");

        try {
            new DriveSenseStreamBackupRestore(trips, speed)
                .verifyOnly(unrelated, "correct horse battery staple".toCharArray());
            fail("Picker MIME admission must not bypass native RSB2 validation");
        } catch (SecurityException expected) {
            assertNotNull(expected.getMessage());
        }

        assertEquals(0L, trips.aggregates(new JSONObject()).getLong("liveCount"));
    }

    private static JSONObject await(DriveSenseStreamBackupManager manager, String id) throws Exception {
        for (int i = 0; i < 400; i++) {
            JSONObject status = manager.status(id);
            if (status.getBoolean("done")) {
                if (!status.getBoolean("verified")) throw new AssertionError(status.toString());
                return status;
            }
            Thread.sleep(25L);
        }
        throw new AssertionError("Portable backup did not finish");
    }

    private static JSONObject awaitDone(DriveSenseStreamBackupManager manager, String id) throws Exception {
        for (int i = 0; i < 400; i++) {
            JSONObject status = manager.status(id);
            if (status.getBoolean("done")) return status;
            Thread.sleep(25L);
        }
        throw new AssertionError("Portable operation did not finish");
    }

    public static final class BackupFileProvider extends ContentProvider {
        static volatile File source;
        @Override public boolean onCreate() { return true; }
        @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
            if (source == null || !source.isFile()) throw new java.io.FileNotFoundException("fixture unavailable");
            return ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY);
        }
        @Override public String getType(Uri uri) { return DriveSenseStreamBackupMimeContract.ROAD_SAGE_STREAM_BACKUP; }
        @Override public Cursor query(Uri uri,String[] projection,String selection,String[] selectionArgs,String sortOrder){return null;}
        @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
        @Override public int delete(Uri uri,String selection,String[] selectionArgs){return 0;}
        @Override public int update(Uri uri,ContentValues values,String selection,String[] selectionArgs){return 0;}
    }

    private void resetStorage() {
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2"));
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
    }

    private static void installKeys(byte fill) {
        byte[] key = new byte[32]; Arrays.fill(key, fill);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        byte[] portable = new byte[32]; Arrays.fill(portable, (byte) 0x2f);
        DriveSenseStreamBackupManager.installPortableKeyForTests(portable);
        Arrays.fill(portable, (byte) 0);
        Arrays.fill(key, (byte) 0);
    }

    private File jsonFile(String name, String value) throws Exception {
        File file = new File(context.getCacheDir(), name);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(value.getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        }
        return file;
    }

    private static byte[] sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024]; int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return digest.digest();
    }

    private static void copyPrefix(File source, File target, long bytes) throws Exception {
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target, false)) {
            byte[] buffer = new byte[64 * 1024]; long remaining = bytes;
            while (remaining > 0) { int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (read < 0) break; output.write(buffer, 0, read); remaining -= read; }
        }
    }

    private void assertRejected(File file) throws Exception {
        try {
            new DriveSenseStreamBackupRestore(
                new DriveSenseTripArchiveRepository(context),new DriveSenseSpeedArchiveRepository(context))
                .verifyOnly(file,"correct horse battery staple".toCharArray());
            fail("Tampered portable backup must be rejected: "+file.getName());
        } catch (SecurityException expected) { assertNotNull(expected.getMessage()); }
    }

    private File mutatePortable(File source,String suffix,Mutation mutation)throws Exception{
        byte[] bytes=Files.readAllBytes(source.toPath());ByteBuffer b=ByteBuffer.wrap(bytes);
        b.position(DriveSenseStreamBackupManager.MAGIC.length);int header=b.getInt();int first=DriveSenseStreamBackupManager.MAGIC.length+4+header;
        int firstCipher=first+4+8+4+4+12;int firstLength=4+8+4+4+12+b.getInt(first+4+8+4);
        int second=first+firstLength;
        if(mutation==Mutation.SUBSTITUTE)bytes[firstCipher]^=0x40;
        else if(mutation==Mutation.WRONG_AAD)ByteBuffer.wrap(bytes).putInt(first,3);
        else if(mutation==Mutation.DUPLICATE_INDEX)ByteBuffer.wrap(bytes).putLong(second+4,ByteBuffer.wrap(bytes).getLong(first+4));
        else{
            int secondLength=4+8+4+4+12+ByteBuffer.wrap(bytes).getInt(second+4+8+4);byte[]copy=bytes.clone();
            System.arraycopy(copy,second,bytes,first,secondLength);System.arraycopy(copy,first,bytes,first+secondLength,firstLength);
        }
        File target=new File(context.getCacheDir(),"roundtrip-"+suffix+".rsb2");Files.write(target.toPath(),bytes);Arrays.fill(bytes,(byte)0);return target;
    }

    private File mutateHeaderGeneration(File source)throws Exception{
        byte[] bytes=Files.readAllBytes(source.toPath());
        int headerLength=ByteBuffer.wrap(bytes).getInt(DriveSenseStreamBackupManager.MAGIC.length);
        int headerOffset=DriveSenseStreamBackupManager.MAGIC.length+4;
        String header=new String(bytes,headerOffset,headerLength,StandardCharsets.UTF_8);
        String generation=new JSONObject(header).getString("archiveGeneration");
        byte[] encoded=generation.getBytes(StandardCharsets.UTF_8);
        int generationOffset=-1;
        outer:for(int index=headerOffset;index<=headerOffset+headerLength-encoded.length;index++){
            for(int item=0;item<encoded.length;item++)if(bytes[index+item]!=encoded[item])continue outer;
            generationOffset=index;break;
        }
        if(generationOffset<0)throw new AssertionError("Archive generation not found in header");
        bytes[generationOffset]=(byte)(bytes[generationOffset]=='a'?'b':'a');
        File target=new File(context.getCacheDir(),"roundtrip-generation.rsb2");
        Files.write(target.toPath(),bytes);Arrays.fill(bytes,(byte)0);return target;
    }

    private enum Mutation{SUBSTITUTE,WRONG_AAD,DUPLICATE_INDEX,REORDER}

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child); file.delete();
    }
}
