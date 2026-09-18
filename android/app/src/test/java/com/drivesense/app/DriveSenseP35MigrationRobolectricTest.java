package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.database.Cursor;
import android.util.Base64;

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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35MigrationRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository repository;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests(); context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_migration_v1"));
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x47);
        DriveSenseEnvelopeCrypto.installTestKek(1, key); DriveSensePayloadCrypto.installTestKey(0, key); Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        repository = new DriveSenseTripArchiveRepository(context); DriveSenseArchiveHealth.inventory(repository.coordinator());
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests(); DriveSenseEnvelopeCrypto.clearTestKeks(); DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null); DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void migrationIngressResumesByDurableChunkIndexAndVerifiesExactly() throws Exception {
        byte[] payload = validTrip("migration-trip", 700_000);
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository);
        JSONObject started = migration.begin("migration-trip", hex(sha256(payload)), payload.length);
        String operation = started.getString("operationId");
        migration.append(operation, 0, Base64.encodeToString(Arrays.copyOfRange(payload, 0, 256 * 1024), Base64.NO_WRAP));

        DriveSenseStorageCoordinator.resetForTests();
        repository = new DriveSenseTripArchiveRepository(context);
        migration = new DriveSenseArchiveMigration(repository);
        int index = 1;
        for (int offset = 256 * 1024; offset < payload.length; offset += 256 * 1024) {
            byte[] chunk = Arrays.copyOfRange(payload, offset, Math.min(payload.length, offset + 256 * 1024));
            migration.append(operation, index++, Base64.encodeToString(chunk, Base64.NO_WRAP)); Arrays.fill(chunk, (byte) 0);
        }
        JSONObject committed = migration.finish(operation);
        assertEquals("migration-trip", committed.getString("tripId"));
        assertNotNull(repository.getMetadata("migration-trip"));
        JSONObject complete = migration.complete(1, 1, 0, hex(sha256(payload)));
        assertTrue(complete.getBoolean("verified"));
        assertEquals("NATIVE", complete.getString("authorityState"));
        Arrays.fill(payload, (byte) 0);
    }

    @Test public void damagedSourceIsQuarantinedAndLowSpaceRetainsIngress() throws Exception {
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository);
        byte[] invalid = "{\"id\":\"bad\",\"route_points\":[".getBytes(StandardCharsets.UTF_8);
        JSONObject bad = migration.begin("bad", hex(sha256(invalid)), invalid.length);
        migration.append(bad.getString("operationId"), 0, Base64.encodeToString(invalid, Base64.NO_WRAP));
        try { migration.finish(bad.getString("operationId")); fail("Malformed source must not migrate"); }
        catch (Exception expected) { assertTrue(expected.getMessage() != null); }
        repository.coordinator().read(db -> {
            try (Cursor c = db.rawQuery("SELECT preserved_artifact FROM migration_quarantine WHERE source_locator LIKE '%legacy.tmp'", null)) {
                assertTrue(c.moveToFirst()); assertTrue(new File(c.getString(0)).isFile());
            }
            return null;
        });

        byte[] payload = validTrip("low-space", 1024);
        JSONObject low = migration.begin("low-space", hex(sha256(payload)), payload.length);
        migration.append(low.getString("operationId"), 0, Base64.encodeToString(payload, Base64.NO_WRAP));
        DriveSenseStorageAdmission.setAvailableBytesForTests(1L);
        try { migration.finish(low.getString("operationId")); fail("Low-space migration must be refused"); }
        catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("LOW_SPACE")); }
        repository.coordinator().read(db -> {
            try (Cursor c = db.rawQuery("SELECT state,temp_path FROM migration_ingress WHERE operation_id=?", new String[]{low.getString("operationId")})) {
                assertTrue(c.moveToFirst()); assertEquals("RECEIVING", c.getString(0)); assertTrue(new File(c.getString(1)).isFile());
            }
            return null;
        });
    }

    @Test public void pageCheckpointAndPreIngressQuarantineSurviveCoordinatorRestart() throws Exception {
        DriveSenseArchiveMigration migration = new DriveSenseArchiveMigration(repository);
        JSONObject checkpoint = new JSONObject();
        checkpoint.put("phase", "MIGRATING");
        checkpoint.put("pageCursor", "cursor-17");
        checkpoint.put("rowOffset", 9);
        checkpoint.put("visitedCount", 109);
        checkpoint.put("quarantineCount", 2);
        checkpoint.put("manifestHash", "a".repeat(64));
        assertTrue(migration.checkpoint(checkpoint).getBoolean("saved"));
        migration.quarantineUnopened(
            "indexeddb:trips:unreadable-1",
            new JSONObject().put("id", "unreadable-1").put("start_time", 123L),
            "DecryptError",
            "legacy wrapper could not authenticate"
        );

        DriveSenseStorageCoordinator.resetForTests();
        repository = new DriveSenseTripArchiveRepository(context);
        migration = new DriveSenseArchiveMigration(repository);
        JSONObject restored = migration.checkpointStatus().getJSONObject("checkpoint");
        assertEquals("cursor-17", restored.getString("pageCursor"));
        assertEquals(9, restored.getInt("rowOffset"));
        assertEquals(109L, restored.getLong("visitedCount"));
        repository.coordinator().read(db -> {
            try (Cursor c = db.rawQuery(
                "SELECT source_locator,error_class,known_metadata,preserved_artifact FROM migration_quarantine WHERE source_locator=?",
                new String[]{"indexeddb:trips:unreadable-1"}
            )) {
                assertTrue(c.moveToFirst());
                assertEquals("DecryptError", c.getString(1));
                assertTrue(c.getString(2).contains("unreadable-1"));
                assertEquals(c.getString(0), c.getString(3));
            }
            return null;
        });
    }

    private static byte[] validTrip(String id, int padding) {
        return ("{\"id\":\"" + id + "\",\"start_time\":\"2026-08-21T00:00:00Z\",\"end_time\":\"2026-08-21T00:01:00Z\",\"status\":\"completed\",\"route_points\":[],\"padding\":\"" + "x".repeat(padding) + "\"}").getBytes(StandardCharsets.UTF_8);
    }
    private static byte[] sha256(byte[] bytes) throws Exception { return MessageDigest.getInstance("SHA-256").digest(bytes); }
    private static String hex(byte[] bytes) { StringBuilder out=new StringBuilder(); for(byte value:bytes)out.append(String.format("%02x",value)); return out.toString(); }
    private static void deleteTree(File file){if(file==null||!file.exists())return;File[]children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);file.delete();}
}
