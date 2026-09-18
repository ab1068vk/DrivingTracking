package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

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
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35RotationFaultRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository trips;
    private DriveSenseSpeedArchiveRepository speed;

    @Before public void setUp() throws Exception {
        context=ApplicationProvider.getApplicationContext();
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L*1024L*1024L*1024L);
        resetFixture();
    }

    @After public void tearDown(){
        DriveSenseEnvelopeKeyRotation.setFaultPointForTests(null);
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseStorageCoordinator.resetForTests();
    }

    @Test public void everyRotationBoundaryResumesWithoutPayloadRewriteOrEarlyRetirement() throws Exception {
        String[]faults={"BEFORE_REWRAP","AFTER_REWRAP_BEFORE_TRANSACTION","DURING_REWRAP_TRANSACTION","AFTER_REWRAP_TRANSACTION","BEFORE_ZERO_PROOF","AFTER_ZERO_PROOF_BEFORE_RETIREMENT","BEFORE_OLD_KEK_RETIREMENT"};
        for(String fault:faults){
            resetFixture();
            DriveSenseEnvelopeKeyRotation rotation=new DriveSenseEnvelopeKeyRotation(trips.coordinator());
            DriveSenseEnvelopeKeyRotation.setFaultPointForTests(fault);
            boolean faulted=false;
            for(int attempt=0;attempt<6&&!faulted;attempt++){
                try{rotation.rotateBatch(2,1);}catch(IllegalStateException expected){
                    assertTrue(expected.getMessage().contains("TEST_FAULT_"+fault));faulted=true;
                }
            }
            assertTrue("fault boundary was not reached: "+fault,faulted);

            // Restart the operation and finish from durable per-row key versions.
            JSONObject result=null;
            for(int attempt=0;attempt<8;attempt++){
                result=rotation.rotateBatch(2,1);
                if(result.getBoolean("complete"))break;
            }
            assertTrue(result!=null&&result.getBoolean("complete"));
            assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_revisions WHERE length(wrapped_dek)>0 AND kek_version<>2"));
            assertEquals(0L,scalar("SELECT COUNT(*) FROM speed_buckets WHERE length(wrapped_dek)>0 AND kek_version<>2"));
            assertEquals(1L,scalar("SELECT zero_proof FROM rotation_state WHERE id=1"));
            assertEquals(0L,result.getLong("payloadBytesRewritten"));
            tryOldKekMustBeRetired();
        }
    }

    @Test public void registryProducesAnExplicitProofForEveryEncryptedDomain() throws Exception {
        DriveSenseEncryptedDomainRegistry.ReferenceProof proof = trips.coordinator().exclusive(db ->
            DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(context, db, 1, false)
        );
        assertEquals(DriveSenseEncryptedDomainRegistry.all().size(), proof.domains.size());
        assertEquals(15, proof.domains.size());
        assertEquals(2, proof.references()); // one trip revision and one speed bucket
        boolean retentionStageProved = false;
        for (DriveSenseEncryptedDomainRegistry.DomainProof domain : proof.domains) {
            assertTrue("missing strategy for " + domain.domain.id,
                domain.evidence != null && !domain.evidence.isEmpty());
            if ("retention_stage".equals(domain.domain.id)) {
                retentionStageProved = true;
                assertEquals("AUTHENTICATED_OWNER_REGISTRY", domain.evidence);
                assertEquals(0, domain.references);
            }
            if (DriveSenseEncryptedDomainRegistry.LEGACY_PAYLOAD_KEY.equals(domain.domain.keyFamily)) {
                assertEquals("SEPARATE_KEY_FAMILY", domain.evidence);
                assertEquals("SEPARATE_KEY_FAMILY_RETIREMENT_BLOCKED", domain.domain.proofStrategy);
            }
        }
        assertTrue("retention stage must have an explicit envelope-KEK proof", retentionStageProved);
        assertTrue(!proof.provesZero());
    }

    @Test public void adoptedCompletedJournalIsARegistryReferenceUntilAcknowledged() throws Exception {
        // Use an otherwise empty archive so the journal reference is isolated.
        resetFixture();
        trips.coordinator().write(db -> {
            db.delete("trip_current", null, null);
            db.delete("trip_chunks", null, null);
            db.delete("trip_revisions", null, null);
            db.delete("speed_current", null, null);
            db.delete("speed_chunks", null, null);
            db.delete("speed_buckets", null, null);
            return null;
        });
        DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.create(
            context, "rotation-journal", 1_742_000_000_000L, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        spool.append(new JSONObject()
            .put("lat", 43.1).put("lng", -79.1).put("timestamp", 1_742_000_000_000L)
            .put("speed_kmh", 30).put("accuracy", 5));
        JSONObject completion = new JSONObject()
            .put("id", "rotation-journal")
            .put("start_time", 1_742_000_000_000L)
            .put("end_time", 1_742_000_001_000L)
            .put("end_time_ms", 1_742_000_001_000L)
            .put("status", "completed");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedActiveSpool(context, spool, completion));

        DriveSenseEncryptedDomainRegistry.ReferenceProof proof = trips.coordinator().exclusive(db ->
            DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(context, db, 1, false)
        );
        assertEquals(1, proof.referencesFor("completed_trip_journal"));
        assertTrue(!proof.provesZero());
    }

    private void resetFixture() throws Exception {
        DriveSenseEnvelopeKeyRotation.setFaultPointForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_archive_meta"));
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_speed_archive_v1"));
        byte[]one=new byte[32];Arrays.fill(one,(byte)0x31);DriveSenseEnvelopeCrypto.installTestKek(1,one);DriveSensePayloadCrypto.installTestKey(0,one);Arrays.fill(one,(byte)0);
        byte[]two=new byte[32];Arrays.fill(two,(byte)0x32);DriveSenseEnvelopeCrypto.installTestKek(2,two);Arrays.fill(two,(byte)0);
        trips=new DriveSenseTripArchiveRepository(context);DriveSenseArchiveHealth.inventory(trips.coordinator());
        speed=new DriveSenseSpeedArchiveRepository(context);
        commitTrip();commitSpeed();
    }

    private void commitTrip() throws Exception {
        File source=new File(context.getCacheDir(),"rotation-trip.json");
        String json="{\"id\":\"rotation-trip\",\"start_time\":1742000000000,\"end_time\":1742000060000,\"status\":\"completed\",\"distance_km\":1,\"duration_seconds\":60,\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}]}";
        try(FileOutputStream output=new FileOutputStream(source,false)){output.write(json.getBytes(StandardCharsets.UTF_8));output.getFD().sync();}
        try{trips.commitSpool(source,"rotation-trip","rotation_fixture");}finally{source.delete();}
    }

    private void commitSpeed() throws Exception {
        byte[]payload=new JSONObject().put("bucketId","dpz8").put("cells",new JSONObject().put("dpz800",new JSONObject().put("limitKmh",50))).put("corrections",new JSONArray()).put("excludedSections",new JSONArray()).put("roadMemory",new JSONObject().put("candidates",new JSONArray())).toString().getBytes(StandardCharsets.UTF_8);
        JSONArray descriptors=new JSONArray().put(new JSONObject().put("bucketId","dpz8").put("expectedBytes",payload.length).put("cellCount",1).put("payloadHash",DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(payload))));
        String batch=speed.begin(descriptors).getString("batchId");speed.append(batch,"dpz8",0,Base64.encodeToString(payload,Base64.NO_WRAP));speed.finish(batch);Arrays.fill(payload,(byte)0);
    }

    private long scalar(String sql)throws Exception{return trips.coordinator().read(db->{try(android.database.Cursor c=db.rawQuery(sql,null)){c.moveToFirst();return c.getLong(0);}});}
    private static void tryOldKekMustBeRetired() throws Exception {byte[]probe=DriveSenseEnvelopeCrypto.newDek();boolean retired=false;try{DriveSenseEnvelopeCrypto.wrapDek(probe,1,DriveSenseEnvelopeCrypto.encode("test","retired"));}catch(Exception expected){retired=true;}finally{Arrays.fill(probe,(byte)0);}assertTrue("old KEK remained usable",retired);}
    private static void deleteTree(File file){if(file==null||!file.exists())return;File[]children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);file.delete();}
}
