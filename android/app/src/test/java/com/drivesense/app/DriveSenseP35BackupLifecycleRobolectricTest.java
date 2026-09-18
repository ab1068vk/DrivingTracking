package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Base64;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35BackupLifecycleRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository trips;
    private DriveSenseSpeedArchiveRepository speed;
    private DriveSenseStreamBackupManager manager;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        resetCanonical();
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2"));
        installKeys();
        trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        speed = new DriveSenseSpeedArchiveRepository(context);
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
    }

    @After public void tearDown() {
        DriveSenseStreamBackupRestore.setFaultPointForTests(null);
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void cancelledExportCleansOnlyItsPartialAndRestartsAtFrameZero() throws Exception {
        commitTrip("cancel-export", 1_760_000_000_000L);
        DriveSenseStreamBackupManager.setTestHookForTests((point, operationId) -> {
            if ("AFTER_EXPORT_LEASE".equals(point)) manager.cancel(operationId);
        });
        JSONObject cancelledStart = manager.begin("cancelled", "correct horse battery staple");
        JSONObject cancelled = awaitDone(manager, cancelledStart.getString("operationId"));
        assertEquals("CANCELLED", cancelled.getString("phase"));
        assertEquals("RESTART_FROM_ZERO", cancelled.getString("restartPolicy"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM export_leases"));
        assertEquals(1L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(0, partialFiles().length);

        DriveSenseStreamBackupManager.setTestHookForTests(null);
        JSONObject restarted = awaitVerified(manager,
            manager.begin("cancelled", "correct horse battery staple").getString("operationId"));
        assertTrue(new File(restarted.getString("nativePath")).isFile());
        assertEquals(0L, scalar("SELECT COUNT(*) FROM export_leases"));
    }

    @Test public void snapshotLeaseAllowsNewCommitAndDefersTombstoneGcUntilRelease() throws Exception {
        File firstSource = commitTrip("snapshot-first", 1_761_000_000_000L);
        final String[] firstChunk = new String[1];
        trips.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT relative_path FROM trip_chunks WHERE trip_id='snapshot-first' LIMIT 1", null)) {
                cursor.moveToFirst(); firstChunk[0] = cursor.getString(0);
            }
            return null;
        });
        File chunkFile = new DriveSenseTripChunkStore(context).relativeFile(firstChunk[0]);
        assertTrue(chunkFile.isFile());

        CountDownLatch leaseReady = new CountDownLatch(1);
        CountDownLatch continueExport = new CountDownLatch(1);
        DriveSenseStreamBackupManager.setTestHookForTests((point, operationId) -> {
            if ("AFTER_EXPORT_LEASE".equals(point)) {
                leaseReady.countDown();
                if (!continueExport.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("TEST_EXPORT_LEASE_TIMEOUT");
            }
        });
        String operationId = manager.begin("snapshot", "correct horse battery staple").getString("operationId");
        assertTrue(leaseReady.await(10, TimeUnit.SECONDS));
        assertEquals(1L, scalar("SELECT COUNT(*) FROM export_leases WHERE state='ACTIVE'"));

        commitTrip("snapshot-new", 1_762_000_000_000L);
        assertEquals(2L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        try {
            trips.tombstone("snapshot-first", "concurrent_delete", false);
            fail("snapshot data must not be unlinked under an active export lease");
        } catch (IllegalStateException expected) {
            assertEquals("EXPORT_SNAPSHOT_CONFLICT_RETRY", expected.getMessage());
        }
        assertTrue(chunkFile.isFile());

        continueExport.countDown();
        JSONObject complete = awaitVerified(manager, operationId);
        DriveSenseStreamBackupRestore.Verified snapshot = new DriveSenseStreamBackupRestore(trips, speed)
            .verifyOnly(new File(complete.getString("nativePath")), "correct horse battery staple".toCharArray());
        assertEquals(1L, snapshot.tripCount); // seq > throughSeq was not frozen out of canonical writes
        assertEquals(0L, scalar("SELECT COUNT(*) FROM export_leases"));

        assertTrue(trips.tombstone("snapshot-first", "after_export", false).getBoolean("deleted"));
        assertFalse(chunkFile.exists());
        assertTrue(firstSource.delete() || !firstSource.exists());
    }

    @Test public void failuresAndProcessRecreationRemoveOwnedStateWithoutCanonicalMutation() throws Exception {
        commitTrip("failure-export", 1_763_000_000_000L);
        DriveSenseStreamBackupManager.setTestHookForTests((point, operationId) -> {
            if ("BEFORE_EXPORT_FINAL_VERIFY".equals(point)) throw new SecurityException("TEST_FINAL_VERIFY_FAILURE");
        });
        JSONObject failed = awaitDone(manager,
            manager.begin("failed", "correct horse battery staple").getString("operationId"));
        assertEquals("FAILED", failed.getString("phase"));
        assertTrue(failed.getString("error").contains("TEST_FINAL_VERIFY_FAILURE"));
        assertEquals(0, partialFiles().length);
        assertEquals(0L, scalar("SELECT COUNT(*) FROM export_leases"));
        assertEquals(1L, trips.aggregates(new JSONObject()).getLong("liveCount"));

        File directory = new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2");
        File abandoned = new File(directory, "abandoned.process.partial");
        try (FileOutputStream output = new FileOutputStream(abandoned, false)) { output.write(new byte[] { 1, 2, 3 }); }
        File verified = new File(directory, "keep.rsb2");
        try (FileOutputStream output = new FileOutputStream(verified, false)) { output.write(new byte[] { 7, 8, 9 }); }
        trips.coordinator().write(db -> {
            ContentValues lease = new ContentValues();
            lease.put("lease_id", "abandoned"); lease.put("archive_generation", "old"); lease.put("through_seq", 1);
            lease.put("speed_generation", "old-speed"); lease.put("speed_through_seq", 0); lease.put("state", "ACTIVE");
            lease.put("owner_token", "dead-process"); lease.put("created_at_ms", 1); lease.put("updated_at_ms", 1);
            db.insertOrThrow("export_leases", null, lease); return null;
        });
        DriveSenseStreamBackupManager.resetForTests();
        installPortableKey();
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        assertFalse(abandoned.exists());
        assertTrue("verified output is not operation-owned partial state", verified.isFile());
        assertEquals(0L, scalar("SELECT COUNT(*) FROM export_leases"));

        DriveSenseStorageAdmission.setAvailableBytesForTests(64L * 1024L * 1024L);
        JSONObject low = awaitDone(manager,
            manager.begin("low-space", "correct horse battery staple").getString("operationId"));
        assertEquals("FAILED", low.getString("phase"));
        assertTrue(low.getString("error").contains("LOW_SPACE_BLOCKED"));
        assertEquals(1L, trips.aggregates(new JSONObject()).getLong("liveCount"));
    }

    @Test public void providerCancellationAndPartialProviderInputNeverPromoteRestore() throws Exception {
        commitTrip("provider-trip", 1_764_000_000_000L);
        JSONObject exported = awaitVerified(manager,
            manager.begin("provider", "correct horse battery staple").getString("operationId"));
        File portable = new File(exported.getString("nativePath"));

        resetCanonicalKeepBackup();
        installKeys();
        trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        speed = new DriveSenseSpeedArchiveRepository(context);
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        LifecycleProvider.source = portable;
        LifecycleProvider.truncateAt = -1L;
        Robolectric.setupContentProvider(LifecycleProvider.class, "roadsage.backup.lifecycle");

        DriveSenseStreamBackupManager.setTestHookForTests((point, operationId) -> {
            if ("RESTORE_PROVIDER_CHUNK".equals(point)) manager.cancel(operationId);
        });
        JSONObject cancelled = awaitDone(manager, manager.beginRestoreFromUri(
            "content://roadsage.backup.lifecycle/value.rsb2", "correct horse battery staple"
        ).getString("operationId"));
        assertEquals("CANCELLED", cancelled.getString("phase"));
        assertEquals(0L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        assertEquals(0, partialFiles().length);

        DriveSenseStreamBackupManager.setTestHookForTests(null);
        LifecycleProvider.truncateAt = Math.max(1L, portable.length() / 2L);
        JSONObject failed = awaitDone(manager, manager.beginRestoreFromUri(
            "content://roadsage.backup.lifecycle/value.rsb2", "correct horse battery staple"
        ).getString("operationId"));
        assertEquals("FAILED", failed.getString("phase"));
        assertEquals(0L, trips.aggregates(new JSONObject()).getLong("liveCount"));
    }

    @Test public void verifiedBackupCanBeCryptographicallyReadoptedAfterManagerRecreation() throws Exception {
        commitTrip("readopted-backup", 1_764_500_000_000L);
        JSONObject completed = awaitVerified(manager,
            manager.begin("readopted", "correct horse battery staple").getString("operationId"));
        String operationId = completed.getString("operationId");
        File portable = new File(completed.getString("nativePath"));
        String expectedHash = DriveSenseEnvelopeCrypto.hex(hashFile(portable));

        DriveSenseStreamBackupManager.resetForTests();
        installPortableKey();
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        JSONObject recovered = manager.recoverVerifiedBackup(operationId, portable.getAbsolutePath(),
            expectedHash, "correct horse battery staple");

        assertEquals("COMPLETE", recovered.getString("phase"));
        assertTrue(recovered.getBoolean("done"));
        assertTrue(recovered.getBoolean("verified"));
        assertEquals(operationId, manager.status(operationId).getString("operationId"));
    }

    @Test public void interruptedRestoreRollsBackItsPartialGenerationAndRestartsFromZero() throws Exception {
        commitTrip("restore-restart", 1_765_000_000_000L);
        writeSpeedBucket("dpz8", 47);
        JSONObject exported = awaitVerified(manager,
            manager.begin("restore-restart", "correct horse battery staple").getString("operationId"));
        File portable = new File(exported.getString("nativePath"));

        resetCanonicalKeepBackup();
        installKeys();
        trips = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        speed = new DriveSenseSpeedArchiveRepository(context);
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        LifecycleProvider.source = portable;
        LifecycleProvider.truncateAt = -1L;
        Robolectric.setupContentProvider(LifecycleProvider.class, "roadsage.backup.restart");

        DriveSenseStreamBackupRestore.setFaultPointForTests("AFTER_FIRST_RESTORED_RECORD");
        JSONObject interrupted = awaitDone(manager, manager.beginRestoreFromUri(
            "content://roadsage.backup.restart/value.rsb2", "correct horse battery staple"
        ).getString("operationId"));
        assertEquals("FAILED", interrupted.getString("phase"));
        assertEquals("RECOVERY_REQUIRED", DriveSenseArchiveHealth.inventory(trips.coordinator()).getString("recoveryState"));
        String interruptedGeneration=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        assertEquals(1L,scalar("SELECT COUNT(*) FROM p6_trip_work WHERE trip_id='restore-restart'"));

        // A recreated coordinator/manager sees the durable failed operation,
        // rolls both partial generations, and imports from frame zero.
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        installKeys();
        trips = new DriveSenseTripArchiveRepository(context);
        speed = new DriveSenseSpeedArchiveRepository(context);
        manager = DriveSenseStreamBackupManager.get(context, trips, speed);
        JSONObject restored = awaitDone(manager, manager.beginRestoreFromUri(
            "content://roadsage.backup.restart/value.rsb2", "correct horse battery staple"
        ).getString("operationId"));
        assertEquals(restored.toString(), "COMPLETE", restored.getString("phase"));
        assertTrue(restored.getBoolean("verified"));
        assertEquals(1L, trips.aggregates(new JSONObject()).getLong("liveCount"));
        assertTrue(trips.getMetadata("restore-restart") != null);
        assertEquals(47,speed.readBucketJson("dpz8").getInt("value"));
        assertEquals(0L, scalar("SELECT COUNT(*) FROM open_operations WHERE operation_type='BACKUP_V2_RESTORE'"));
        String restoredGeneration=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        assertFalse(interruptedGeneration.equals(restoredGeneration));
        assertEquals(0L,scalar("SELECT COUNT(*) FROM p6_source_applied"));
        assertEquals(0L,scalar("SELECT COUNT(*) FROM p6_manifests"));
        assertEquals(0L,scalar("SELECT COUNT(*) FROM p6_geometry_chunks"));
        assertEquals(1L,scalar("SELECT COUNT(*) FROM p6_trip_work WHERE trip_id='restore-restart' AND archive_generation='"+restoredGeneration+"'"));
        assertEquals("REBUILD_REQUIRED",stringScalar("SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'"));
        assertEquals("BACKFILL_REQUIRED",stringScalar("SELECT retention_index_state FROM p5_control_state WHERE id=1"));
        assertEquals("DIRTY",stringScalar("SELECT journal_state FROM p5_control_state WHERE id=1"));

        JSONObject turn=null;
        for(int index=0;index<120;index++){
            turn=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(turn.optString("state")))break;
        }
        assertEquals("VERIFIED",turn.getString("state"));
        assertEquals(true,DriveSenseP6Jobs.finalizeExplicitTripBuild(trips,false).getBoolean("complete"));
        assertEquals(restoredGeneration,stringScalar("SELECT source_binding FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals(3L,scalar("SELECT COUNT(*) FROM p6_source_applied WHERE archive_generation='"+restoredGeneration+"' AND trip_id='restore-restart'"));
    }

    public static final class LifecycleProvider extends ContentProvider {
        static volatile File source;
        static volatile long truncateAt = -1L;
        @Override public boolean onCreate() { return true; }
        @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
            if (source == null || !source.isFile()) throw new java.io.FileNotFoundException("provider failure");
            if (truncateAt < 0L) return ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY);
            try {
                File partial = new File(source.getParentFile(), "provider-partial.rsb2");
                try (java.io.FileInputStream input = new java.io.FileInputStream(source);
                     FileOutputStream output = new FileOutputStream(partial, false)) {
                    byte[] buffer = new byte[64 * 1024]; long remaining = truncateAt;
                    while (remaining > 0) { int read = input.read(buffer, 0, (int)Math.min(buffer.length, remaining)); if (read < 0) break; output.write(buffer, 0, read); remaining -= read; }
                }
                return ParcelFileDescriptor.open(partial, ParcelFileDescriptor.MODE_READ_ONLY);
            } catch (Exception error) { throw new java.io.FileNotFoundException(error.getMessage()); }
        }
        @Override public String getType(Uri uri) { return DriveSenseStreamBackupMimeContract.ROAD_SAGE_STREAM_BACKUP; }
        @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){return null;}
        @Override public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
        @Override public int delete(Uri uri,String selection,String[] args){return 0;}
        @Override public int update(Uri uri,ContentValues values,String selection,String[] args){return 0;}
    }

    private File commitTrip(String id, long start) throws Exception {
        File source = new File(context.getCacheDir(), id + ".json");
        String json = "{\"id\":\"" + id + "\",\"start_time\":" + start + ",\"end_time\":" + (start + 60_000L) +
            ",\"status\":\"completed\",\"distance_km\":1.5,\"duration_seconds\":60,\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}]}";
        try (FileOutputStream output = new FileOutputStream(source, false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        }
        trips.commitSpool(source, id, "backup_lifecycle_fixture");
        return source;
    }

    private void writeSpeedBucket(String bucket,int value)throws Exception{
        JSONObject document=new JSONObject().put("bucketId",bucket).put("value",value)
            .put("cells",new JSONObject()).put("corrections",new JSONArray())
            .put("excludedSections",new JSONArray())
            .put("roadMemory",new JSONObject().put("candidates",new JSONArray()));
        byte[]bytes=document.toString().getBytes(StandardCharsets.UTF_8);
        JSONObject descriptor=new JSONObject().put("bucketId",bucket).put("expectedBytes",bytes.length)
            .put("cellCount",0).put("payloadHash",DriveSenseEnvelopeCrypto.hex(
                MessageDigest.getInstance("SHA-256").digest(bytes)));
        String batch=speed.begin(new JSONArray().put(descriptor)).getString("batchId");
        speed.append(batch,bucket,0,Base64.encodeToString(bytes,Base64.NO_WRAP));speed.finish(batch);
    }

    private long scalar(String sql) throws Exception {
        return trips.coordinator().read(db -> { try (Cursor cursor = db.rawQuery(sql, null)) { cursor.moveToFirst(); return cursor.getLong(0); } });
    }

    private String stringScalar(String sql) throws Exception {
        return trips.coordinator().read(db -> { try (Cursor cursor = db.rawQuery(sql, null)) { cursor.moveToFirst(); return cursor.getString(0); } });
    }

    private File[] partialFiles() {
        File[] files = new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2")
            .listFiles((directory, name) -> name.endsWith(".partial"));
        return files == null ? new File[0] : files;
    }

    private static JSONObject awaitDone(DriveSenseStreamBackupManager manager, String id) throws Exception {
        for (int index = 0; index < 600; index++) {
            JSONObject status = manager.status(id);
            if (status.getBoolean("done")) return status;
            Thread.sleep(10L);
        }
        throw new AssertionError("backup operation did not finish");
    }

    private static JSONObject awaitVerified(DriveSenseStreamBackupManager manager, String id) throws Exception {
        JSONObject status = awaitDone(manager, id);
        if (!status.getBoolean("verified")) throw new AssertionError(status.toString());
        return status;
    }

    private static byte[] hashFile(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return digest.digest();
    }

    private void resetCanonicalKeepBackup() {
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
    }

    private void resetCanonical() {
        resetCanonicalKeepBackup();
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
    }

    private static void installKeys() {
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x43);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        installPortableKey();
    }

    private static void installPortableKey() {
        byte[] portable = new byte[32]; Arrays.fill(portable, (byte) 0x26);
        DriveSenseStreamBackupManager.installPortableKeyForTests(portable);
        Arrays.fill(portable, (byte) 0);
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
