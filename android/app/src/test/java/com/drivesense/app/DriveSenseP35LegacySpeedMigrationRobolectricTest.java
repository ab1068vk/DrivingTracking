package com.drivesense.app;

import static org.junit.Assert.*;

import android.content.Context;
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
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35LegacySpeedMigrationRobolectricTest {
    private Context context;
    private DriveSenseSpeedArchiveRepository speed;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_p35/prde1_speed"));
        byte[] payload = new byte[32]; Arrays.fill(payload, (byte) 0x31);
        DriveSensePayloadCrypto.installTestKey(3, payload);
        byte[] kek = new byte[32]; Arrays.fill(kek, (byte) 0x51);
        DriveSenseEnvelopeCrypto.installTestKek(1, kek);
        Arrays.fill(payload, (byte) 0); Arrays.fill(kek, (byte) 0);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        speed = new DriveSenseSpeedArchiveRepository(context);
        admit();
    }

    @After public void tearDown() {
        DriveSenseLegacySpeedMigration.setAdmissionProbeForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void explicitDecodePartitionsOnceDropsHistoryAndVerifies() throws Exception {
        JSONObject model = model(48, true);
        byte[] encrypted = encrypted(model);
        String hash = DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted));
        DriveSenseLegacySpeedMigration migration = new DriveSenseLegacySpeedMigration(context, speed);
        JSONObject started = migration.begin(descriptor(encrypted.length, hash));
        append(migration, started.getString("operationId"), encrypted);
        JSONObject result = migration.execute(started.getString("operationId"));

        assertEquals("VERIFIED", result.getString("state"));
        assertTrue(result.getBoolean("plaintextReleasedBeforeCommit"));
        assertTrue(result.getBoolean("historyDropped"));
        assertTrue(result.getBoolean("legacyAuthorityPreserved"));
        assertEquals(hash, result.getString("sourceCiphertextHashAfter"));
        assertEquals(48, result.getLong("cellCount"));
        assertNotNull(speed.open("dpz8"));
        JSONObject global = speed.readBucketJson("zzzz");
        assertEquals(0, global.getJSONObject("global").getJSONObject("history").getJSONArray("undo").length());
        Arrays.fill(encrypted, (byte) 0);
    }

    @Test public void resourceRefusalPreservesSourceAndCreatesNoBucket() throws Exception {
        byte[] encrypted = encrypted(model(2, false));
        String hash = DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted));
        DriveSenseLegacySpeedMigration.setAdmissionProbeForTests(new DriveSenseLegacySpeedMigration.AdmissionProbe(
            16L*1024L*1024L, 15L*1024L*1024L, 16L*1024L*1024L,
            16L*1024L*1024L, 8L*1024L*1024L, 128L*1024L*1024L, true));
        JSONObject refused = new DriveSenseLegacySpeedMigration(context, speed).begin(descriptor(encrypted.length, hash));
        assertEquals(DriveSenseLegacySpeedMigration.BLOCKED_RESOURCE, refused.getString("state"));
        assertTrue(refused.getBoolean("legacyAuthorityPreserved"));
        assertTrue(refused.getBoolean("retryable"));
        assertEquals(0L, speed.state().getLong("bucketCount"));
        assertEquals(hash, DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted)));
    }

    @Test public void authenticationFailureNeverBecomesEmptySuccess() throws Exception {
        byte[] encrypted = encrypted(model(4, false)); encrypted[encrypted.length - 1] ^= 1;
        String hash = DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted));
        DriveSenseLegacySpeedMigration migration = new DriveSenseLegacySpeedMigration(context, speed);
        JSONObject started = migration.begin(descriptor(encrypted.length, hash)); append(migration, started.getString("operationId"), encrypted);
        try { migration.execute(started.getString("operationId")); fail("tamper must fail"); }
        catch (IllegalStateException expected) { assertTrue(expected.getMessage().startsWith("PRDE1_")); }
        JSONObject status = migration.status(started.getString("operationId"));
        assertTrue(status.getBoolean("legacyAuthorityPreserved"));
        assertFalse(status.getBoolean("authorityFlipEligible"));
        assertEquals(0L, speed.state().getLong("bucketCount"));
    }

    @Test public void stagedCiphertextResumesAfterRecreation() throws Exception {
        byte[] encrypted = encrypted(model(16, false));
        String hash = DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted));
        DriveSenseLegacySpeedMigration first = new DriveSenseLegacySpeedMigration(context, speed);
        JSONObject started = first.begin(descriptor(encrypted.length, hash));
        append(first, started.getString("operationId"), encrypted);

        DriveSenseLegacySpeedMigration recreated = new DriveSenseLegacySpeedMigration(context, speed);
        assertEquals("STAGING", recreated.status(started.getString("operationId")).getString("state"));
        assertEquals("VERIFIED", recreated.execute(started.getString("operationId")).getString("state"));
        Arrays.fill(encrypted, (byte) 0);
    }

    @Test public void maximumPrefixFourBucketFitsCeiling() throws Exception {
        JSONObject root = model(0, false);
        JSONObject cells = new JSONObject();
        JSONArray samples = new JSONArray();
        for (int sample = 0; sample < 40; sample++) samples.put(30 + sample);
        for (int index = 0; index < 1024; index++) {
            cells.put("dpz8" + base32(index / 32) + base32(index % 32),
                new JSONObject().put("limitKmh", 50).put("samples", samples));
        }
        cells.put("dpz8b", new JSONObject().put("limitKmh", 40).put("samples", samples));
        root.put("cells", cells);
        byte[] encrypted = encrypted(root);
        String hash = DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(encrypted));
        DriveSenseLegacySpeedMigration migration = new DriveSenseLegacySpeedMigration(context, speed);
        JSONObject started = migration.begin(descriptor(encrypted.length, hash));
        append(migration, started.getString("operationId"), encrypted);
        JSONObject result = migration.execute(started.getString("operationId"));

        assertEquals("VERIFIED", result.getString("state"));
        assertEquals(1025L, result.getLong("cellCount"));
        assertTrue(result.getBoolean("precision6LookupVerified"));
        assertTrue(result.getBoolean("precision5FallbackVerified"));
        try (DriveSenseSpeedArchiveRepository.Descriptor bucket = speed.open("dpz8")) {
            assertNotNull(bucket);
            assertTrue(bucket.payloadBytes < DriveSenseLegacySpeedMigration.MAX_BUCKET_ENCODED_BYTES);
        }
        Arrays.fill(encrypted, (byte) 0);
    }

    private JSONObject descriptor(int bytes,String hash)throws Exception{JSONObject d=new JSONObject();d.put("sourceId","indexeddb");d.put("sourceContext","indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1");d.put("sourceCiphertextHash",hash);d.put("sourceRevision",9);d.put("keyVersion",3);d.put("expectedCiphertextBytes",bytes);return d;}
    private byte[] encrypted(JSONObject model)throws Exception{return Base64.decode(DriveSensePayloadCrypto.encrypt(model.toString(),"indexeddb:drivesense_speed_knowledge/knowledge:speed_knowledge_v1",3),Base64.NO_WRAP);}
    private static void append(DriveSenseLegacySpeedMigration migration,String id,byte[] bytes)throws Exception{int index=0;for(int offset=0;offset<bytes.length;offset+=DriveSenseLegacySpeedMigration.BRIDGE_CHUNK_BYTES){int n=Math.min(DriveSenseLegacySpeedMigration.BRIDGE_CHUNK_BYTES,bytes.length-offset);byte[]part=Arrays.copyOfRange(bytes,offset,offset+n);migration.append(id,index++,Base64.encodeToString(part,Base64.NO_WRAP));Arrays.fill(part,(byte)0);}}
    private static JSONObject model(int cells,boolean history)throws Exception{JSONObject root=new JSONObject();root.put("schemaVersion",2);root.put("knowledgeRevision",9);root.put("knowledgeUpdatedAt","2026-08-22T00:00:00Z");JSONObject map=new JSONObject();for(int i=0;i<cells;i++)map.put(String.format("dpz8%02x",i),new JSONObject().put("limitKmh",50).put("samples",new JSONArray().put(48).put(50)));root.put("cells",map);root.put("corrections",new JSONArray().put(new JSONObject().put("geohash","dpz9aa").put("limitKmh",60)));root.put("excludedSections",new JSONArray().put(new JSONObject().put("geohash","dpzb11").put("reason","private")));root.put("roadMemory",new JSONObject().put("candidates",new JSONArray().put(new JSONObject().put("geohash","dpzc22").put("score",1))).put("processedTrips",new JSONObject().put("trip-1",true)).put("intelligence",new JSONObject().put("version",1)));JSONArray undo=new JSONArray();if(history)for(int i=0;i<20;i++)undo.put(new JSONObject().put("data",new JSONObject().put("cells",map)));root.put("history",new JSONObject().put("undo",undo).put("redo",undo));return root;}
    private void admit(){long huge=8L*1024L*1024L*1024L;DriveSenseLegacySpeedMigration.setAdmissionProbeForTests(new DriveSenseLegacySpeedMigration.AdmissionProbe(huge,0,huge,huge,0,huge,false));}
    private static char base32(int value){return "0123456789bcdefghjkmnpqrstuvwxyz".charAt(value & 31);}
    private static void deleteTree(File file){if(file==null||!file.exists())return;if(file.isDirectory()){File[]children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);}file.delete();}
}
