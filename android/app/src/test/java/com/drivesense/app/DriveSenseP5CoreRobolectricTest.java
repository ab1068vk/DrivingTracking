package com.drivesense.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.ContentValues;
import android.database.Cursor;
import androidx.test.core.app.ApplicationProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.io.FileOutputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Random;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP5CoreRobolectricTest {
    private Context context;private DriveSenseTripArchiveRepository repository;
    @Before public void setUp()throws Exception{context= ApplicationProvider.getApplicationContext();reset();byte[]key=new byte[32];Arrays.fill(key,(byte)0x51);DriveSenseEnvelopeCrypto.installTestKek(1,key);DriveSensePayloadCrypto.installTestKey(0,key);byte[]portable=new byte[32];Arrays.fill(portable,(byte)0x2f);DriveSenseStreamBackupManager.installPortableKeyForTests(portable);Arrays.fill(portable,(byte)0);Arrays.fill(key,(byte)0);repository=new DriveSenseTripArchiveRepository(context);repository.coordinator().write(db->{db.execSQL("UPDATE archive_meta SET authority_state='NATIVE' WHERE id=1");return null;});DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());}
    @After public void tearDown(){DriveSenseTripArchiveRepository.setFaultPointForTests(null);DriveSenseStreamBackupManager.resetForTests();DriveSenseStorageCoordinator.resetForTests();DriveSenseEnvelopeCrypto.clearTestKeks();DriveSensePayloadCrypto.clearTestKeys();DriveSenseStorageAdmission.setAvailableBytesForTests(null);DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);}

    @Test public void v16SerializableShaMatchesJcaAcrossSplitsAndPadding()throws Exception{
        Random random=new Random(0x505);int[]lengths={0,1,55,56,63,64,65,127,1024,8193};
        for(int length:lengths){byte[]input=new byte[length];random.nextBytes(input);byte[]expected=MessageDigest.getInstance("SHA-256").digest(input);for(int split=0;split<=length;split+=Math.max(1,length/7)){DriveSenseSha256State sha=new DriveSenseSha256State();sha.update(input,0,split);DriveSenseSha256State restored=DriveSenseSha256State.restore(sha.chainingState(),sha.byteCount(),sha.partialBlock());restored.update(input,split,length-split);assertArrayEquals("length="+length+" split="+split,expected,restored.digest());}}
    }

    @Test public void v6RetentionTokenizerResumesAcrossEveryByteBoundary()throws Exception{
        String source="{ \"id\" : \"trip-1\",\"start_time\":1700000000000,\"route_points\":[{\"lat\":1,\"lng\":2},{\"lat\":3,\"lng\":4}],\"driving_events\":[{\"type\":\"brake\",\"lat\":9,\"nested\":{\"lat\":7}}],\"start_address\":\"private\",\"motion_samples\":[{\"x\":1}],\"distance\":12.50,\"note\":\"untouched\\u263a\"}";
        byte[]bytes=source.getBytes(StandardCharsets.UTF_8);String expected=null;
        for(int split=0;split<=bytes.length;split++){
            DriveSenseRetentionTokenizer tokenizer=new DriveSenseRetentionTokenizer(true,30,true,7,1_760_000_000_000L);
            ByteArrayOutputStream output=new ByteArrayOutputStream();output.write(tokenizer.process(Arrays.copyOfRange(bytes,0,split),false));
            tokenizer=DriveSenseRetentionTokenizer.restore(tokenizer.save());output.write(tokenizer.process(Arrays.copyOfRange(bytes,split,bytes.length),true));
            String transformed=output.toString("UTF-8");new JSONObject(transformed);
            if(expected==null)expected=transformed;else assertEquals(expected,transformed);
            JSONObject value=new JSONObject(transformed);assertEquals(1_700_000_000_000L,tokenizer.catalogMetadata().getLong("start_time"));assertEquals(0,value.getJSONArray("route_points").length());assertEquals(2,value.getInt("route_points_raw_count"));assertEquals(0,value.getInt("route_points_map_count"));assertTrue(value.isNull("start_address"));assertEquals(0,value.getJSONArray("motion_samples").length());assertFalse(value.getJSONArray("driving_events").getJSONObject(0).has("lat"));assertEquals(7,value.getJSONArray("driving_events").getJSONObject(0).getJSONObject("nested").getInt("lat"));
        }
    }

    @Test public void v6RetentionTokenizerPreservesPriorCountsAndStreamsHugeScalars()throws Exception{
        String huge="x".repeat(DriveSenseTripChunkStore.CHUNK_BYTES*3+73);
        String source="{\"id\":\"prior\",\"route_points_raw_count\":17,\"route_points\":[],\"motion_samples_expired_count\":9,\"motion_samples\":[],\"note\":\""+huge+"\",\"route_points_raw_count\":17}";
        byte[]bytes=source.getBytes(StandardCharsets.UTF_8);DriveSenseRetentionTokenizer tokenizer=new DriveSenseRetentionTokenizer(true,30,true,7,1_760_000_000_000L);ByteArrayOutputStream output=new ByteArrayOutputStream();
        for(int offset=0;offset<bytes.length;){int next=Math.min(bytes.length,offset+65_537);output.write(tokenizer.process(Arrays.copyOfRange(bytes,offset,next),false));tokenizer=DriveSenseRetentionTokenizer.restore(tokenizer.save());offset=next;}
        output.write(tokenizer.process(new byte[0],true));JSONObject transformed=new JSONObject(output.toString("UTF-8"));
        assertEquals(17,transformed.getInt("route_points_raw_count"));assertEquals(9,transformed.getInt("motion_samples_expired_count"));assertEquals(huge,transformed.getString("note"));assertEquals(17L,tokenizer.routeCount());assertEquals(9L,tokenizer.motionCount());
    }

    @Test public void v4ThroughV8NativeRetentionPublishesFromEncryptedBoundedStage()throws Exception{
        long tripTime=1_700_000_000_000L;commit("retained",tripTime,43.7);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;
        for(int i=0;i<20;i++){turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);if("COMPLETE".equals(turn.getString("state"))&&scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE phase<>'DONE' AND phase<>'BACKFILL'")==0)break;}
        assertNotNull(turn);assertEquals(2L,scalar("SELECT revision FROM trip_current WHERE trip_id='retained'"));assertEquals(tripTime,scalar("SELECT start_time_ms FROM trip_current WHERE trip_id='retained'"));assertEquals(tripTime+60000L,scalar("SELECT end_time_ms FROM trip_current WHERE trip_id='retained'"));assertEquals(0L,scalar("SELECT overview_available FROM trip_current WHERE trip_id='retained'"));assertEquals(0L,scalar("SELECT COUNT(*) FROM encrypted_file_key_registry WHERE domain_id='retention_stage'"));assertEquals(0L,scalar("SELECT COUNT(*) FROM retention_stage_chunks"));
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor("retained",null)){ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int i=0;i<descriptor.chunkCount;i++)bytes.write(repository.readPayloadChunk(descriptor,i));JSONObject payload=new JSONObject(bytes.toString("UTF-8"));assertEquals(0,payload.getJSONArray("route_points").length());assertTrue(payload.isNull("start_address"));assertEquals(1,payload.getInt("route_points_raw_count"));}
        assertEquals("HEALTHY",DriveSenseArchiveHealth.inventory(repository.coordinator()).getString("recoveryState"));
    }

    @Test public void v4ExportLeaseKeepsOnlyPreRetentionSnapshotUntilProvenClose()throws Exception{
        long tripTime=1_700_100_000_000L;commit("leased-retention",tripTime,43.8);long sourceSeq=scalar("SELECT seq FROM trip_revisions WHERE trip_id='leased-retention' AND revision=1");String generation=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        repository.coordinator().write(db->{db.execSQL("INSERT INTO export_leases(lease_id,archive_generation,through_seq,state,owner_token,created_at_ms,updated_at_ms) VALUES('lease-before-retention',?,?,'ACTIVE','fixture',?,?)",new Object[]{generation,sourceSeq,System.currentTimeMillis(),System.currentTimeMillis()});return null;});
        DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;for(int i=0;i<30;i++){turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);if("BLOCKED_EXPORT_LEASE".equals(turn.getString("state")))break;}
        assertNotNull(turn);assertEquals("BLOCKED_EXPORT_LEASE",turn.getString("state"));assertEquals(2L,scalar("SELECT revision FROM trip_current WHERE trip_id='leased-retention'"));assertTrue(scalar("SELECT COUNT(*) FROM trip_chunks WHERE trip_id='leased-retention' AND revision=1")>0);assertTrue(scalar("SELECT length(wrapped_dek) FROM trip_revisions WHERE trip_id='leased-retention' AND revision=1")>0);
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor("leased-retention",1)){assertNotNull(descriptor);assertTrue(repository.readPayloadChunk(descriptor,0).length>0);}
        repository.coordinator().write(db->{db.delete("export_leases","lease_id='lease-before-retention'",null);return null;});for(int i=0;i<20;i++){turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);if("COMPLETE".equals(turn.getString("state"))&&scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE phase<>'DONE' AND phase<>'BACKFILL'")==0)break;}
        assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_chunks WHERE trip_id='leased-retention' AND revision=1"));assertEquals(0L,scalar("SELECT length(wrapped_dek) FROM trip_revisions WHERE trip_id='leased-retention' AND revision=1"));assertTrue(scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0);
    }

    @Test public void v6LargeRetentionResumesAndEveryTurnKeepsFixedCeilings()throws Exception{
        long tripTime=1_700_200_000_000L;int points=120_000;commitLarge("large-retention",tripTime,points);assertTrue(scalar("SELECT chunk_count FROM trip_revisions WHERE trip_id='large-retention' AND revision=1")>8);
        DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;boolean restarted=false,sawPagedPlan=false,sawStageCleanup=false,sawRetire=false;int turns=0;
        for(;turns<180;turns++){turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);assertTrue(turn.getInt("itemsWorked")<=16);assertTrue(turn.getLong("bytesWorked")<=DriveSenseRawGpsRetention.MAX_WORK_BYTES);String state=turn.getString("state");if("PLAN_PUBLISH_CHUNKS".equals(state)){sawPagedPlan=true;assertTrue(turn.getInt("changedItems")<=8);}if("STAGE_CLEANUP".equals(state)){sawStageCleanup=true;assertEquals(1,turn.getInt("changedItems"));}if("RETIRE_SOURCE".equals(state)){sawRetire=true;assertTrue(turn.getInt("changedItems")<=16);}if(!restarted&&turns==4){DriveSenseStorageCoordinator.resetForTests();repository=new DriveSenseTripArchiveRepository(context);retention=new DriveSenseRawGpsRetention(repository);restarted=true;}if("COMPLETE".equals(state)&&scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE phase<>'DONE' AND phase<>'BACKFILL'")==0)break;}
        assertTrue(restarted);assertTrue(sawPagedPlan);assertTrue(sawStageCleanup);assertTrue(sawRetire);assertTrue(turns>30);assertNotNull(turn);assertEquals("COMPLETE",turn.getString("state"));try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor("large-retention",null)){assertNotNull(descriptor);ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int i=0;i<descriptor.chunkCount;i++)bytes.write(repository.readPayloadChunk(descriptor,i));JSONObject payload=new JSONObject(bytes.toString("UTF-8"));assertEquals(0,payload.getJSONArray("route_points").length());assertEquals(points,payload.getInt("route_points_raw_count"));}
    }

    @Test public void v8PolicyReplacementRetiresStagingAndPendingPublishInBoundedTurns()throws Exception{
        long tripTime=1_700_300_000_000L;commitLarge("obsolete-pending",tripTime,40_000);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;
        for(int i=0;i<120;i++){turn=retention.step(1,0,tripTime+3L*86_400_000L,false);if("PUBLISH_CHUNK".equals(turn.getString("state")))break;}
        assertNotNull(turn);assertEquals("PUBLISH_CHUNK",turn.getString("state"));assertTrue(scalar("SELECT COUNT(*) FROM trip_revisions WHERE trip_id='obsolete-pending' AND commit_state='PENDING'")>0);
        boolean sawStageDebt=false,sawPublishDebt=false;for(int i=0;i<100;i++){turn=retention.step(2,0,tripTime+3L*86_400_000L,false);assertTrue(turn.getInt("itemsWorked")<=16);assertTrue(turn.getLong("bytesWorked")<=DriveSenseRawGpsRetention.MAX_WORK_BYTES);sawStageDebt|="OBSOLETE_STAGE_DEBT".equals(turn.getString("state"));sawPublishDebt|="OBSOLETE_PUBLISH_DEBT".equals(turn.getString("state"));if(scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE state='OBSOLETE'")==0)break;}
        assertTrue(sawStageDebt);assertTrue(sawPublishDebt);assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_revisions WHERE trip_id='obsolete-pending' AND commit_state='PENDING'"));assertEquals(1L,scalar("SELECT revision FROM trip_current WHERE trip_id='obsolete-pending'"));assertEquals(0L,scalar("SELECT COUNT(*) FROM retention_stage_chunks"));assertEquals(0L,scalar("SELECT COUNT(*) FROM encrypted_file_key_registry WHERE domain_id='retention_stage'"));assertTrue(scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0);
        for(int i=0;i<100&&scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0;i++){JSONObject gc=DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore());assertTrue(gc.getInt("itemsWorked")<=32);assertTrue(gc.getInt("changedItems")<=16);assertTrue(gc.getLong("bytesWorked")<=DriveSenseArchiveUnlinkDebt.MAX_WORK_BYTES);}
        assertEquals(0L,scalar("SELECT COUNT(*) FROM archive_unlink_debt"));
    }

    @Test public void v8PolicyReplacementAfterCommitPreservesPublishedRevisionAndRetiresSource()throws Exception{
        long tripTime=1_700_400_000_000L;commit("obsolete-committed",tripTime,43.9);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;
        for(int i=0;i<40;i++){turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);if("PUBLISHED".equals(turn.getString("state")))break;}
        assertNotNull(turn);assertEquals("PUBLISHED",turn.getString("state"));assertEquals(2L,scalar("SELECT revision FROM trip_current WHERE trip_id='obsolete-committed'"));
        for(int i=0;i<40;i++){turn=retention.step(2,0,tripTime+3L*86_400_000L,false);assertTrue(turn.getInt("itemsWorked")<=16);assertTrue(turn.getLong("bytesWorked")<=DriveSenseRawGpsRetention.MAX_WORK_BYTES);if(scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE state='OBSOLETE'")==0)break;}
        assertEquals(2L,scalar("SELECT revision FROM trip_current WHERE trip_id='obsolete-committed'"));assertEquals("COMMITTED",stringScalar("SELECT commit_state FROM trip_revisions WHERE trip_id='obsolete-committed' AND revision=2"));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_chunks WHERE trip_id='obsolete-committed' AND revision=1"));assertEquals(0L,scalar("SELECT length(wrapped_dek) FROM trip_revisions WHERE trip_id='obsolete-committed' AND revision=1"));
    }

    @Test public void v8GenerationErasureDominatesStagedRetentionAndCarriesExactDebt()throws Exception{
        long tripTime=1_700_500_000_000L;commitLarge("erase-staged",tripTime,40_000);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject turn=null;
        for(int i=0;i<20;i++){turn=retention.step(1,0,tripTime+3L*86_400_000L,false);if(scalar("SELECT COUNT(*) FROM retention_stage_chunks")>0)break;}
        assertNotNull(turn);assertTrue(scalar("SELECT COUNT(*) FROM retention_stage_chunks")>0);String oldGeneration=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        JSONObject erased=repository.rolloverGenerationForIdentityErasure("p5_staged_fixture");assertNotEquals(oldGeneration,erased.getString("archiveGeneration"));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_retention_jobs"));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_current"));assertTrue(scalar("SELECT COUNT(*) FROM archive_unlink_debt WHERE opaque_path LIKE 'rstg:%'")>0);
        DriveSenseStorageCoordinator.resetForTests();repository=new DriveSenseTripArchiveRepository(context);retention=new DriveSenseRawGpsRetention(repository);turn=retention.step(1,0,tripTime+3L*86_400_000L,false);assertFalse("PUBLISHED".equals(turn.getString("state")));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_current"));
        for(int i=0;i<100&&scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0;i++)DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore());assertEquals(0L,scalar("SELECT COUNT(*) FROM archive_unlink_debt"));
    }

    @Test public void v7NativeRetentionReceiptIsStablePrivacySafeAndAcknowledgedOnce()throws Exception{
        long tripTime=1_700_600_000_000L;commit("receipt",tripTime,44.1);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);for(int i=0;i<30;i++){JSONObject turn=stepRetention(retention,1,0,tripTime+3L*86_400_000L,false);if("COMPLETE".equals(turn.getString("state"))&&scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE phase<>'DONE' AND phase<>'BACKFILL'")==0)break;}
        JSONObject first=DriveSenseP5PrivacyReceipts.pending(repository.coordinator()),again=DriveSenseP5PrivacyReceipts.pending(repository.coordinator());assertEquals(1,first.getInt("itemCount"));assertEquals(first.toString(),again.toString());JSONObject receipt=first.getJSONArray("receipts").getJSONObject(0);assertEquals("RAW_GPS_AUTO_PURGED",receipt.getString("eventType"));assertEquals(1,receipt.getInt("tripCount"));assertEquals(1,receipt.getInt("pointCount"));assertEquals(0,receipt.getInt("motionSampleCount"));assertFalse(receipt.toString().contains("receipt"));assertFalse(receipt.has("tripId"));assertFalse(receipt.has("payloadHash"));
        String operation=receipt.getString("operationId");assertTrue(DriveSenseP5PrivacyReceipts.acknowledge(repository.coordinator(),operation).getBoolean("acknowledged"));assertFalse(DriveSenseP5PrivacyReceipts.acknowledge(repository.coordinator(),operation).getBoolean("acknowledged"));assertEquals(0,DriveSenseP5PrivacyReceipts.pending(repository.coordinator()).getInt("itemCount"));
    }

    @Test public void v25ReceiptPrimaryKeyProbesAndObservedBytesStayFixedAcrossDebtGrowth()throws Exception{
        for(int n:new int[]{0,100,1000,5000}){
            repository.coordinator().write(db->{db.delete("privacy_receipt_debt",null,null);db.beginTransaction();try{
                for(int i=0;i<n;i++)db.execSQL("INSERT INTO privacy_receipt_debt(operation_id,event_type,reason_code,trip_count,point_count,motion_sample_count,state,created_at_ms,updated_at_ms) VALUES(?, 'RAW_GPS_AUTO_PURGED','raw_gps_retention_policy',1,30,0,'PENDING',100,100)",new Object[]{String.format(java.util.Locale.ROOT,"receipt-%05d",i)});
                db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
            long expected=repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT operation_id,event_type,reason_code,trip_count,point_count,motion_sample_count,created_at_ms,state FROM privacy_receipt_debt ORDER BY operation_id LIMIT 1",null)){
                long bytes=0;if(c.moveToFirst())for(int i=0;i<c.getColumnCount();i++)bytes+=2L*(c.getType(i)==Cursor.FIELD_TYPE_STRING?c.getString(i).getBytes(StandardCharsets.UTF_8).length:8);return bytes;}});
            JSONObject first=DriveSenseP5PrivacyReceipts.pending(repository.coordinator());assertEquals(1,first.getInt("itemsWorked"));assertEquals(expected,first.getLong("bytesWorked"));assertEquals(n==0?0:1,first.getJSONArray("receipts").length());
            if(n>0){String id="receipt-00000";JSONObject ack=DriveSenseP5PrivacyReceipts.acknowledge(repository.coordinator(),id);
                long nextBytes=2L*("receipt-00001".getBytes(StandardCharsets.UTF_8).length+"PENDING".length());
                assertEquals(2,ack.getInt("itemsWorked"));assertEquals(expected+id.length()+nextBytes,ack.getLong("bytesWorked"));assertTrue(ack.getBoolean("hasMore"));
                assertFalse(DriveSenseP5PrivacyReceipts.acknowledge(repository.coordinator(),id).getBoolean("acknowledged"));
                // SQL plan uses the PK order, not a history-sized temporary sort.
                repository.coordinator().read(db->{try(Cursor c=db.rawQuery("EXPLAIN QUERY PLAN SELECT operation_id,state FROM privacy_receipt_debt ORDER BY operation_id LIMIT 1",null)){while(c.moveToNext())assertFalse(c.getString(3).contains("TEMP B-TREE"));}return null;});
            }
        }
    }

    @Test public void v17SupersedeThenLaterTombstoneKeepsAsOfMembershipImmutable()throws Exception{
        commit("immutable",1_760_000_000_000L,43.1);long through=scalar("SELECT last_committed_seq FROM archive_meta WHERE id=1");
        commit("immutable",1_760_000_100_000L,43.2);through=scalar("SELECT last_committed_seq FROM archive_meta WHERE id=1");long firstDeath=scalar("SELECT retired_seq FROM trip_revisions WHERE trip_id='immutable' AND revision=1");
        assertTrue(firstDeath<=through);repository.tombstone("immutable","fixture",false);
        assertEquals(firstDeath,scalar("SELECT retired_seq FROM trip_revisions WHERE trip_id='immutable' AND revision=1"));
        assertEquals(1L,scalar("SELECT COUNT(*) FROM trip_revisions WHERE trip_id='immutable' AND seq IS NOT NULL AND seq<="+through+" AND commit_state<>'PENDING' AND (retired_seq IS NULL OR retired_seq>"+through+")"));
        assertEquals(2L,scalar("SELECT revision FROM trip_revisions WHERE trip_id='immutable' AND seq IS NOT NULL AND seq<="+through+" AND commit_state<>'PENDING' AND (retired_seq IS NULL OR retired_seq>"+through+")"));
        assertEquals("HEALTHY",DriveSenseArchiveHealth.inventory(repository.coordinator()).getString("recoveryState"));
    }

    @Test public void v17CheckpointCapturedBeforeLaterTombstoneKeepsOnlyAsOfCurrentRevision()throws Exception{
        commit("as-of",1_760_010_000_000L,43.1);
        commit("as-of",1_760_010_100_000L,43.2);
        long through=scalar("SELECT last_committed_seq FROM archive_meta WHERE id=1");
        long firstDeath=scalar("SELECT retired_seq FROM trip_revisions WHERE trip_id='as-of' AND revision=1");
        byte[] expected=asOfRoot(through);

        JSONObject scan=DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator());
        assertEquals("FINALIZE_READY",scan.getString("state"));
        assertEquals(1,scan.getInt("itemsWorked"));
        repository.tombstone("as-of","fixture",false);
        long tombstoneSeq=scalar("SELECT retired_seq FROM trip_revisions WHERE trip_id='as-of' AND revision=2");
        assertTrue(tombstoneSeq>through);
        assertEquals(firstDeath,scalar("SELECT retired_seq FROM trip_revisions WHERE trip_id='as-of' AND revision=1"));

        assertEquals("SENTINEL_READY",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
        DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator());
        assertEquals("COMPLETE",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
        assertEquals(1L,scalar("SELECT live_count FROM integrity_checkpoint_jobs WHERE state='COMMITTED' ORDER BY created_at_ms DESC LIMIT 1"));
        assertArrayEquals(expected,blob("SELECT live_set_root FROM integrity_checkpoint_jobs WHERE state='COMMITTED' ORDER BY created_at_ms DESC LIMIT 1"));
        assertEquals(0L,scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs WHERE state='FAILED_COUNT_MISMATCH'"));
        assertEquals("HEALTHY",stringScalar("SELECT recovery_state FROM archive_meta WHERE id=1"));
    }

    @Test public void v17GenuineCapturedCountMismatchStillFailsClosed()throws Exception{
        commit("count-mismatch",1_760_020_000_000L,43.1);
        assertEquals("FINALIZE_READY",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
        repository.coordinator().write(db->{db.execSQL("UPDATE integrity_checkpoint_jobs SET live_count=live_count+1 WHERE state='P5_ACTIVE'");return null;});
        assertEquals("FAILED_COUNT_MISMATCH",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
        assertEquals("RECOVERY_REQUIRED",stringScalar("SELECT recovery_state FROM archive_meta WHERE id=1"));
    }

    @Test public void v16CheckpointMidstateResumesMonotonicallyAcrossCoordinatorRestart()throws Exception{
        DriveSenseStorageCoordinator coordinator=repository.coordinator();
        seedIntegrityRows(coordinator,300);
        JSONObject first=DriveSenseArchiveIntegrity.stepBoundedCheckpoint(coordinator);
        assertEquals("SCAN",first.getString("state")); assertEquals(256,first.getInt("itemsWorked"));
        String cursor=stringScalar(coordinator,"SELECT cursor_trip_id FROM integrity_checkpoint_jobs WHERE state='P5_ACTIVE'");
        assertFalse(cursor.isEmpty()); assertEquals(256L,scalar(coordinator,"SELECT observed_count FROM integrity_checkpoint_jobs WHERE state='P5_ACTIVE'"));
        DriveSenseStorageCoordinator.resetForTests();
        coordinator=DriveSenseStorageCoordinator.get(context);
        JSONObject resumed=DriveSenseArchiveIntegrity.stepBoundedCheckpoint(coordinator);
        assertEquals("FINALIZE_READY",resumed.getString("state")); assertEquals(44,resumed.getInt("itemsWorked"));
        assertEquals(300L,scalar(coordinator,"SELECT observed_count FROM integrity_checkpoint_jobs WHERE state='P5_ACTIVE'"));
        assertEquals("SENTINEL_READY",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(coordinator).getString("state"));
        DriveSenseArchiveIntegrity.stepBoundedCheckpoint(coordinator);
        assertEquals("COMPLETE",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(coordinator).getString("state"));
        assertArrayEquals(asOfRoot(coordinator,1000L),blob(coordinator,"SELECT live_set_root FROM integrity_checkpoint_jobs WHERE state='COMMITTED' ORDER BY created_at_ms DESC LIMIT 1"));
    }

    @Test public void v16MidstateVersionMismatchIsDiscardedInsteadOfReinterpreted()throws Exception{
        commit("version",1_760_030_000_000L,43.1);
        DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator());
        repository.coordinator().write(db->{db.execSQL("UPDATE integrity_checkpoint_jobs SET state_format_version=999 WHERE state='P5_ACTIVE'");return null;});
        assertEquals("RESTART_REQUIRED",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
        assertEquals(1L,scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs WHERE state='OBSOLETE'"));
        assertEquals("FINALIZE_READY",DriveSenseArchiveIntegrity.stepBoundedCheckpoint(repository.coordinator()).getString("state"));
    }

    @Test public void v20PendingWrappedDekCountsAndRecoveryRemovesIt()throws Exception{
        DriveSenseTripArchiveRepository.setFaultPointForTests("AFTER_PENDING");try{commit("pending",1_760_100_000_000L,44.0);fail("fault expected");}catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("TEST_FAULT"));}
        assertEquals(1L,scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_archive' AND key_version=1"));
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);DriveSenseStorageCoordinator.resetForTests();repository=new DriveSenseTripArchiveRepository(context);
        assertEquals(0L,scalar("SELECT COUNT(*) FROM key_reference_counts WHERE domain_id='trip_archive' AND reference_count>0"));
    }

    @Test public void v20StageOnlyOldKekReferenceBlocksRetirementAndDirtyRepairIsBounded()throws Exception{
        long tripTime=1_760_150_000_000L;commit("stage-kek",tripTime,44.2);DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);JSONObject selected=null;for(int i=0;i<8;i++){selected=retention.step(1,0,tripTime+3L*86_400_000L,false);if("SELECTED".equals(selected.getString("state")))break;}assertNotNull(selected);assertEquals("SELECTED",selected.getString("state"));assertEquals(1L,scalar("SELECT COUNT(*) FROM encrypted_file_key_registry WHERE domain_id='retention_stage' AND key_version=1"));
        byte[]key2=new byte[32];Arrays.fill(key2,(byte)0x62);DriveSenseEnvelopeCrypto.installTestKek(2,key2);Arrays.fill(key2,(byte)0);DriveSenseEnvelopeKeyRotation rotation=new DriveSenseEnvelopeKeyRotation(repository.coordinator());JSONObject turn=null;for(int i=0;i<12;i++){turn=rotation.rotateBatch(2,100);assertTrue(turn.getInt("recordsExamined")<=100);if("BLOCKED_REFERENCES".equals(rotation.status().optString("phase")))break;}
        assertNotNull(turn);assertFalse(turn.getBoolean("complete"));JSONArray domains=turn.getJSONObject("registryProof").getJSONArray("domains");int stageReferences=-1;for(int i=0;i<domains.length();i++){JSONObject domain=domains.getJSONObject(i);if("retention_stage".equals(domain.getString("domain")))stageReferences=domain.getInt("references");}assertEquals(1,stageReferences);
        repository.coordinator().write(db->{DriveSenseKeyReferenceCounts.markDirty(db);return null;});boolean repaired=false;for(int i=0;i<12;i++){turn=rotation.rotateBatch(2,100);assertTrue(turn.getInt("recordsExamined")<=100);if("COUNT_REPAIR_COMPLETE".equals(turn.optString("phase"))){repaired=true;break;}}assertTrue(repaired);assertEquals("VERIFIED",stringScalar("SELECT kek_count_state FROM p5_control_state WHERE id=1"));assertEquals(scalar("SELECT COUNT(*) FROM trip_revisions WHERE wrapped_dek IS NOT NULL AND wrapped_dek<>X'' AND kek_version=2"),scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_archive' AND key_version=2"));
    }

    @Test public void v18TombstoneCapturesOpaqueDebtBeforeCatalogDeletionAndJ4Converges()throws Exception{
        commit("debt",1_760_200_000_000L,45.0);DriveSenseTripArchiveRepository.setFaultPointForTests("AFTER_TOMBSTONE_CATALOG_BEFORE_UNLINK");try{repository.tombstone("debt","fixture",false);fail("fault expected");}catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("TEST_FAULT"));}assertTrue(scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0);
        try(Cursor c=repository.coordinator().read(db->db.rawQuery("SELECT opaque_path FROM archive_unlink_debt LIMIT 1",null))){assertTrue(c.moveToFirst());String path=c.getString(0);assertFalse(path.contains("debt"));assertFalse(path.contains("/"));}
        JSONObject turn=DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore());assertTrue(turn.getInt("itemsWorked")<=32);assertTrue(turn.getInt("changedItems")<=16);assertEquals(0L,scalar("SELECT COUNT(*) FROM archive_unlink_debt"));
    }

    @Test public void v19ResidueGcObeysLeaseOperationAndGrowthCeilingsAcrossRestart()throws Exception{
        File directory=repository.chunkStore().inventoryDirectory();for(int i=0;i<70;i++){String name=String.format(java.util.Locale.US,"orphan-%03d.rstc",i);File file=new File(directory,name);try(FileOutputStream out=new FileOutputStream(file)){out.write(new byte[1024]);out.getFD().sync();}}
        JSONObject audit=DriveSenseArchiveDeepAudit.step(repository,"");assertEquals("COMPLETE",audit.getString("state"));assertEquals(70,audit.getInt("changedItems"));assertEquals(70L,scalar("SELECT COUNT(*) FROM archive_unlink_debt"));String generation=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        repository.coordinator().write(db->{long now=System.currentTimeMillis();db.execSQL("INSERT INTO export_leases(lease_id,archive_generation,through_seq,state,owner_token,created_at_ms,updated_at_ms) VALUES('gc-lease',?,0,'ACTIVE','fixture',?,?)",new Object[]{generation,now,now});return null;});assertEquals("BLOCKED_EXPORT_LEASE",DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore()).getString("state"));repository.coordinator().write(db->{db.delete("export_leases","lease_id='gc-lease'",null);long now=System.currentTimeMillis();db.execSQL("INSERT INTO open_operations(operation_id,operation_type,state,owner_token,created_at_ms,updated_at_ms) VALUES('gc-open','fixture','ACTIVE','fixture',?,?)",new Object[]{now,now});return null;});assertEquals("BLOCKED_NATIVE_OPERATION",DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore()).getString("state"));repository.coordinator().write(db->{db.delete("open_operations","operation_id='gc-open'",null);return null;});
        int turns=0;while(scalar("SELECT COUNT(*) FROM archive_unlink_debt")>0){JSONObject turn=DriveSenseArchiveUnlinkDebt.step(repository.coordinator(),repository.chunkStore());assertTrue(turn.getInt("itemsWorked")<=DriveSenseArchiveUnlinkDebt.MAX_EXAMINED);assertTrue(turn.getInt("changedItems")<=DriveSenseArchiveUnlinkDebt.MAX_UNLINKS);assertTrue(turn.getLong("bytesWorked")<=DriveSenseArchiveUnlinkDebt.MAX_WORK_BYTES);turns++;if(turns==1){DriveSenseStorageCoordinator.resetForTests();repository=new DriveSenseTripArchiveRepository(context);}assertTrue(turns<10);}assertTrue(turns>=5);for(int i=0;i<70;i++)assertFalse(new File(repository.chunkStore().inventoryDirectory(),String.format(java.util.Locale.US,"orphan-%03d.rstc",i)).exists());
    }

    @Test public void v13ThroughV15JournalSummaryRepairAndAckUseBoundedRegistryPages()throws Exception{
        repository.coordinator().write(db->{db.execSQL("UPDATE p5_control_state SET writers_enabled=1 WHERE id=1");return null;});DriveSenseJournalControlPlane.ensureProbed(context);assertEquals("VERIFIED",DriveSenseJournalControlPlane.status(context).getString("summaryState"));
        for(int i=0;i<65;i++){JSONObject trip=new JSONObject().put("id",String.format(java.util.Locale.US,"journal-%03d",i)).put("status","completed").put("start_time",1_760_300_000_000L+i);assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context,trip));}
        JSONObject status=DriveSenseCompletedTripJournal.getStatus(context);assertEquals("VERIFIED",status.getString("summaryState"));assertEquals(65,status.getInt("pendingCount"));assertEquals(65L,scalar("SELECT COUNT(*) FROM journal_manifest_index WHERE readable=1"));assertEquals(8,DriveSenseCompletedTripJournal.pendingTripIds(context,8).length());
        JSONArray ack=new JSONArray().put("journal-000").put("journal-001");JSONObject acknowledged=DriveSenseCompletedTripJournal.acknowledgeCompletedTrips(context,ack);assertEquals(2,acknowledged.getInt("removed"));assertEquals(63,DriveSenseCompletedTripJournal.getStatus(context).getInt("pendingCount"));
        DriveSenseJournalControlPlane.markDirty(context,"ABSENT");int turns=0,total=0;JSONObject repair=null;do{repair=DriveSenseJournalControlPlane.reconcile(context);assertTrue(repair.getInt("itemsWorked")<=DriveSenseJournalControlPlane.MAX_EXAMINED);assertTrue(repair.getLong("bytesWorked")<=DriveSenseJournalControlPlane.MAX_WORK_BYTES);total+=repair.getInt("itemsWorked");turns++;assertTrue(turns<10);}while(repair.getBoolean("hasMore"));
        assertEquals(scalar("SELECT COUNT(*) FROM journal_file_registry WHERE state<>'REMOVED'"),total);assertTrue(turns>=2);status=DriveSenseCompletedTripJournal.getStatus(context);assertEquals("VERIFIED",status.getString("summaryState"));assertEquals(63,status.getInt("pendingCount"));assertEquals(scalar("SELECT COALESCE(SUM(encoded_bytes),0) FROM journal_file_registry WHERE state<>'REMOVED'"),status.getLong("encryptedBytes"));
        DriveSenseCompletedTripJournal.clear(context);status=DriveSenseCompletedTripJournal.getStatus(context);assertEquals("VERIFIED",status.getString("summaryState"));assertEquals(0,status.getInt("pendingCount"));
    }

    @Test public void v14NonEmptyPreP5JournalCannotAppearEmptyBeforeExplicitBootstrap()throws Exception{
        repository.coordinator().write(db->{db.execSQL("UPDATE p5_control_state SET writers_enabled=0 WHERE id=1");return null;});assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context,new JSONObject().put("id","legacy-bootstrap").put("status","completed").put("start_time",1_760_400_000_000L)));
        repository.coordinator().write(db->{db.execSQL("UPDATE p5_control_state SET writers_enabled=1 WHERE id=1");return null;});DriveSenseJournalControlPlane.ensureProbed(context);JSONObject blocked=DriveSenseCompletedTripJournal.getStatus(context);assertEquals("BOOTSTRAP_REQUIRED",blocked.getString("summaryState"));assertFalse(blocked.getBoolean("queueReadable"));try{DriveSenseCompletedTripJournal.pendingTripIds(context,8);fail("dirty index must not claim empty");}catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("JOURNAL_INDEX_DIRTY"));}
        JSONObject bootstrap=DriveSenseJournalControlPlane.bootstrap(context);assertEquals("COMPLETE",bootstrap.getString("state"));assertEquals(1,bootstrap.getInt("itemsWorked"));JSONObject status=DriveSenseCompletedTripJournal.getStatus(context);assertEquals("VERIFIED",status.getString("summaryState"));assertEquals(1,status.getInt("pendingCount"));assertEquals("legacy-bootstrap",DriveSenseCompletedTripJournal.pendingTripIds(context,8).getString(0));
    }

    @Test public void v14LargeJournalManifestRepairPagesItsFileRegistryAcrossRestart()throws Exception{
        repository.coordinator().write(db->{db.execSQL("UPDATE p5_control_state SET writers_enabled=1 WHERE id=1");return null;});DriveSenseJournalControlPlane.ensureProbed(context);File spool=new File(context.getCacheDir(),"journal-large-spool.bin");try(FileOutputStream out=new FileOutputStream(spool)){out.write("{\"id\":\"journal-large\",\"status\":\"completed\",\"raw_gps\":\"".getBytes(StandardCharsets.UTF_8));byte[]block=new byte[64*1024];Arrays.fill(block,(byte)'j');for(int i=0;i<180;i++)out.write(block);out.write("\"}".getBytes(StandardCharsets.UTF_8));out.getFD().sync();}assertTrue("large spool admitted",DriveSenseCompletedTripJournal.addCompletedTripSpool(context,spool,"journal-large"));long expectedFiles=scalar("SELECT chunk_count+1 FROM journal_manifest_index WHERE trip_id='journal-large'");assertTrue("fixture must exceed one registry page: "+expectedFiles,expectedFiles>32);DriveSenseJournalControlPlane.markDirty(context,"ABSENT");JSONObject first=DriveSenseJournalControlPlane.reconcile(context);assertTrue("first turn must continue: "+first,first.getBoolean("hasMore"));assertTrue("first item ceiling: "+first,first.getInt("itemsWorked")<=DriveSenseJournalControlPlane.MAX_EXAMINED);assertTrue("first byte ceiling: "+first,first.getLong("bytesWorked")<=DriveSenseJournalControlPlane.MAX_WORK_BYTES);DriveSenseStorageCoordinator.resetForTests();repository=new DriveSenseTripArchiveRepository(context);int turns=1;JSONObject turn=first;while(turn.getBoolean("hasMore")){turn=DriveSenseJournalControlPlane.reconcile(context);assertTrue("item ceiling: "+turn,turn.getInt("itemsWorked")<=DriveSenseJournalControlPlane.MAX_EXAMINED);assertTrue("byte ceiling: "+turn,turn.getLong("bytesWorked")<=DriveSenseJournalControlPlane.MAX_WORK_BYTES);assertTrue("repair failed to converge: "+turn,++turns<10);}assertTrue("repair was not paged",turns>=2);assertEquals("VERIFIED",DriveSenseCompletedTripJournal.getStatus(context).getString("summaryState"));assertEquals(expectedFiles,scalar("SELECT COUNT(*) FROM journal_file_registry WHERE entry_key=(SELECT entry_key FROM journal_manifest_index WHERE trip_id='journal-large') AND state='PRESENT'"));
    }

    @Test public void v14AbsentAckAndAddIntentsRepairWithoutBootstrapButCorruptManifestDoesNot()throws Exception{
        DriveSenseJournalControlPlane.ensureProbed(context);
        JSONObject live=new JSONObject().put("id","survives").put("status","completed");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context,live));
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context,new JSONObject().put("id","ack-crash").put("status","completed")));
        DriveSenseCompletedTripJournal.setFaultPointForTests("AFTER_ACK_FILES_BEFORE_REGISTRY");
        try { DriveSenseCompletedTripJournal.acknowledgeOne(context,"ack-crash"); } catch(IllegalStateException expected) { assertTrue(expected.getMessage().contains("TEST_FAULT")); }
        finally { DriveSenseCompletedTripJournal.setFaultPointForTests(null); }
        assertEquals(1,scalar("SELECT COUNT(*) FROM journal_manifest_index WHERE trip_id='ack-crash'"));
        // Re-enter the persisted in-entry repair branch as well as a fresh intent.
        repository.coordinator().write(db->{db.execSQL("UPDATE journal_repair_state SET state='REPAIRING',entry_key=(SELECT entry_key FROM journal_manifest_index WHERE trip_id='ack-crash'),file_ordinal=0,cursor='' WHERE id=1");return null;});
        JSONObject blocked=repository.ingestCompletedJournal(8,8L*1024*1024);
        assertEquals("BLOCKED_JOURNAL_REPAIR",blocked.getString("state"));assertFalse(blocked.getBoolean("hasMore"));
        JSONObject repair;do{repair=DriveSenseJournalControlPlane.reconcile(context);}while(repair.getBoolean("hasMore"));
        assertEquals(0,scalar("SELECT COUNT(*) FROM journal_manifest_index WHERE trip_id='ack-crash'"));
        DriveSenseJournalControlPlane.beginEntryMutation(context,"add-crash");
        assertEquals(-1,scalar("SELECT readable FROM journal_manifest_index WHERE trip_id='add-crash'"));
        do{repair=DriveSenseJournalControlPlane.reconcile(context);}while(repair.getBoolean("hasMore"));
        assertEquals(0,scalar("SELECT COUNT(*) FROM journal_manifest_index WHERE trip_id='add-crash'"));
        assertEquals("VERIFIED",repair.getString("summaryState"));
        JSONObject status=DriveSenseCompletedTripJournal.getStatus(context);
        assertEquals(0,status.getInt("unreadableCount"));assertEquals(1,status.getInt("pendingCount"));
        assertEquals("survives",DriveSenseCompletedTripJournal.pendingTripIds(context,8).getString(0));
        assertEquals(0,scalar("SELECT COUNT(*) FROM journal_file_registry WHERE entry_key NOT IN (SELECT entry_key FROM journal_manifest_index)"));
        String key=stringScalar("SELECT entry_key FROM journal_manifest_index WHERE trip_id='survives'");
        File manifest=DriveSenseCompletedTripJournal.manifestFile(DriveSenseCompletedTripJournal.directory(context),key);
        try(FileOutputStream out=new FileOutputStream(manifest)){out.write(new byte[]{1,2,3});}
        DriveSenseJournalControlPlane.markDirty(context,"ABSENT");
        do{repair=DriveSenseJournalControlPlane.reconcile(context);}while(repair.getBoolean("hasMore"));
        assertTrue(manifest.exists());assertEquals("DIRTY",repair.getString("summaryState"));
        assertEquals(1,DriveSenseCompletedTripJournal.getStatus(context).getInt("unreadableCount"));
        assertEquals("BLOCKED_JOURNAL_REPAIR",repository.ingestCompletedJournal(8,8L*1024*1024).getString("state"));
    }

    @Test public void v6AllProductCoordinateKeysAreRemovedOnlyAtTargetPaths()throws Exception{
        String[] keys={"lat","lng","latitude","longitude","original_lat","original_lng","matched_lat","matched_lng","lon","coordinates","location"};
        JSONObject event=new JSONObject().put("kind","brake");for(String key:keys)event.put(key,12.5);
        String source="{\"outside\":{ \"matched_lat\" : 1.2500, \"original_lng\": -2.00 },\"route_points\":[],\"driving_events\":["+event+"]}";
        byte[] input=source.getBytes(StandardCharsets.UTF_8);
        for(int split=0;split<=input.length;split++){
            DriveSenseRetentionTokenizer t=new DriveSenseRetentionTokenizer(true,1,false,0,1_760_000_000_000L);
            ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(t.process(Arrays.copyOfRange(input,0,split),false));t=DriveSenseRetentionTokenizer.restore(t.save());out.write(t.process(Arrays.copyOfRange(input,split,input.length),true));
            String result=out.toString("UTF-8");assertTrue(result.contains("{ \"matched_lat\" : 1.2500, \"original_lng\": -2.00 }"));
            JSONObject redacted=new JSONObject(result).getJSONArray("driving_events").getJSONObject(0);
            for(String key:keys)assertFalse(key,redacted.has(key));assertEquals("brake",redacted.getString("kind"));
        }
    }

    @Test public void v4PublishedCoordinateRedactionSurvivesMetadataProjectionAndPortableExport()throws Exception{
        String id="retention-event-privacy";long time=1_700_000_000_000L;
        String[] keys={"lat","lng","latitude","longitude","original_lat","original_lng","matched_lat","matched_lng","lon","coordinates","location"};
        JSONObject event=new JSONObject().put("type","brake");for(String key:keys)event.put(key,43.25);
        JSONObject source=new JSONObject().put("id",id).put("status","completed").put("start_time",time).put("end_time",time+60000).put("route_points",new JSONArray().put(new JSONObject().put("lat",43).put("lng",-79)));
        for(String target:new String[]{"driving_events","phone_proxy_events","phone_use_events","native_phone_usage_events","native_tracking_timeline"})source.put(target,new JSONArray().put(event));
        File input=new File(context.getCacheDir(),"p5-f04.json");try(FileOutputStream out=new FileOutputStream(input)){out.write(source.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}repository.commitSpool(input,id,"p5_f04");
        DriveSenseRawGpsRetention retention=new DriveSenseRawGpsRetention(repository);
        for(int i=0;i<50;i++){JSONObject result=stepRetention(retention,1,0,time+3L*86400000,false);if("COMPLETE".equals(result.optString("state"))&&scalar("SELECT COUNT(*) FROM trip_retention_jobs WHERE phase NOT IN ('DONE','BACKFILL')")==0)break;}
        assertEquals(2,scalar("SELECT revision FROM trip_current WHERE trip_id='"+id+"'"));
        assertRedactedPayload(id,keys);
        String metadata=repository.getMetadata(id).toString(),projection=repository.projectionFeed(0,32,128*1024).toString();
        for(String key:keys){assertFalse(metadata.contains("\""+key+"\":"));assertFalse(projection.contains("\""+key+"\":"));}
        DriveSenseSpeedArchiveRepository speed=new DriveSenseSpeedArchiveRepository(context);
        DriveSenseStreamBackupManager manager=DriveSenseStreamBackupManager.get(context,repository,speed);
        JSONObject backup=awaitBackup(manager,manager.begin("p5-f04","correct horse battery staple").getString("operationId"));
        File portable=new File(backup.getString("nativePath"));
        repository.rolloverGenerationForIdentityErasure("p5_f04_restore");
        assertTrue(new DriveSenseStreamBackupRestore(repository,speed).restore(portable,"correct horse battery staple".toCharArray()).getBoolean("verified"));
        assertRedactedPayload(id,keys);
    }

    private void assertRedactedPayload(String id,String[]keys)throws Exception{
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor(id,null)){
            ByteArrayOutputStream out=new ByteArrayOutputStream();for(int i=0;i<descriptor.chunkCount;i++)out.write(repository.readPayloadChunk(descriptor,i));JSONObject payload=new JSONObject(out.toString("UTF-8"));
            for(String target:new String[]{"driving_events","phone_proxy_events","phone_use_events","native_phone_usage_events","native_tracking_timeline"}){
                JSONObject event=payload.getJSONArray(target).getJSONObject(0);assertEquals("brake",event.getString("type"));for(String key:keys)assertFalse(target+"."+key,event.has(key));
            }
        }
    }

    @Test public void v26P5SchemaIsAdditiveAndWritersStartEnabled()throws Exception{
        assertEquals(8,DriveSenseArchiveOpenHelper.DATABASE_VERSION);assertEquals(1L,scalar("SELECT writers_enabled FROM p5_control_state WHERE id=1"));
        for(String table:new String[]{"trip_retention_jobs","journal_summary","journal_manifest_index","archive_unlink_debt","archive_blob_inventory","privacy_receipt_debt"})assertEquals(1L,scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='"+table+"'"));
    }

    @Test public void v24RestoreRebuildsLocalControlStateButCarriesCleanupAndPrivacyDebt()throws Exception{
        long tripTime=1_760_500_000_000L;commit("restore-p5",tripTime,45.2);DriveSenseSpeedArchiveRepository speed=new DriveSenseSpeedArchiveRepository(context);DriveSenseStreamBackupManager manager=DriveSenseStreamBackupManager.get(context,repository,speed);JSONObject exported=awaitBackup(manager,manager.begin("p5-v24","correct horse battery staple").getString("operationId"));File portable=new File(exported.getString("nativePath"));assertTrue(portable.isFile());
        repository.coordinator().write(db->{db.execSQL("UPDATE p5_control_state SET retention_policy_version='roadsage.retention.policy.v1|rawDays=99|motionDays=88',retention_raw_days=99,retention_motion_days=88 WHERE id=1");return null;});
        repository.rolloverGenerationForIdentityErasure("p5_v24_empty_target");new DriveSenseEnvelopeKeyRotation(repository.coordinator()).rotateBatch(1,1);String generation=stringScalar("SELECT archive_generation FROM archive_meta WHERE id=1");String job="restore-stage";byte[]dek=new byte[32];Arrays.fill(dek,(byte)0x33);DriveSenseRetentionStage stage=new DriveSenseRetentionStage(context);stage.write(generation,job,0,"private-stage".getBytes(StandardCharsets.UTF_8),13,dek);Arrays.fill(dek,(byte)0);long stageBytes=stage.encodedBytes(generation,job,0),now=System.currentTimeMillis();
        repository.coordinator().write(db->{db.beginTransaction();try{db.execSQL("INSERT INTO trip_retention_jobs(job_id,archive_generation,erasure_token,policy_version,state,phase,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",new Object[]{job,generation,"erasure","roadsage.retention.policy.v1|rawDays=1|motionDays=0","ACTIVE","TRANSFORM",now,now});db.execSQL("INSERT INTO retention_stage_chunks(job_id,chunk_index,plaintext_bytes,encoded_bytes) VALUES(?,?,?,?)",new Object[]{job,0,13,stageBytes});DriveSenseArchiveUnlinkDebt.record(db,"rstg:"+generation+":preexisting:0",7,"preexisting");db.execSQL("INSERT INTO privacy_receipt_debt(operation_id,event_type,reason_code,trip_count,point_count,motion_sample_count,state,created_at_ms,updated_at_ms) VALUES('privacy-carry','RAW_GPS_AUTO_PURGED','RETENTION',1,2,3,'PENDING',?,?)",new Object[]{now,now});db.execSQL("UPDATE journal_summary SET state='VERIFIED' WHERE id=1");db.execSQL("UPDATE rotation_state SET count_state='VERIFIED' WHERE id=1");db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        JSONObject restored=new DriveSenseStreamBackupRestore(repository,speed).restore(portable,"correct horse battery staple".toCharArray());assertTrue(restored.getBoolean("verified"));assertNotNull(repository.getMetadata("restore-p5"));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_retention_jobs"));assertEquals(0L,scalar("SELECT COUNT(*) FROM retention_stage_chunks"));assertEquals(0L,scalar("SELECT COUNT(*) FROM trip_retention_due"));assertEquals(0L,scalar("SELECT COUNT(*) FROM integrity_checkpoint_jobs"));assertEquals(1L,scalar("SELECT COUNT(*) FROM archive_unlink_debt WHERE opaque_path='rstg:"+generation+":"+job+":0' AND reason_code='restore_cutover_stage'"));assertEquals(1L,scalar("SELECT COUNT(*) FROM archive_unlink_debt WHERE opaque_path='rstg:"+generation+":preexisting:0'"));assertEquals(1L,scalar("SELECT COUNT(*) FROM privacy_receipt_debt WHERE operation_id='privacy-carry' AND state='PENDING'"));assertEquals("DIRTY",stringScalar("SELECT state FROM journal_summary WHERE id=1"));assertEquals("DIRTY",stringScalar("SELECT count_state FROM rotation_state WHERE id=1"));assertEquals("BACKFILL_REQUIRED",stringScalar("SELECT retention_index_state FROM p5_control_state WHERE id=1"));assertNull(repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT retention_policy_version FROM p5_control_state WHERE id=1",null)){assertTrue(c.moveToFirst());return c.isNull(0)?null:c.getString(0);}}));assertEquals("NATIVE",stringScalar("SELECT authority_state FROM archive_meta WHERE id=1"));assertEquals("HEALTHY",stringScalar("SELECT recovery_state FROM archive_meta WHERE id=1"));assertTrue(DriveSenseArchiveHealth.inventory(repository.coordinator()).getBoolean("sentinelMatches"));
    }

    private void commit(String id,long time,double lat)throws Exception{File file=new File(context.getCacheDir(),id+"-"+time+".json");String json="{\"id\":\""+id+"\",\"start_time\":"+time+",\"end_time\":"+(time+60000)+",\"status\":\"completed\",\"start_address\":\"secret\",\"route_points\":[{\"lat\":"+lat+",\"lng\":-79.1}]}";try(FileOutputStream out=new FileOutputStream(file)){out.write(json.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}repository.commitSpool(file,id,"p5_fixture");}
    private void commitLarge(String id,long time,int points)throws Exception{File file=new File(context.getCacheDir(),id+"-"+time+".json");try(FileOutputStream raw=new FileOutputStream(file);BufferedOutputStream out=new BufferedOutputStream(raw)){out.write(("{\"id\":\""+id+"\",\"start_time\":"+time+",\"end_time\":"+(time+60000)+",\"status\":\"completed\",\"note\":\"").getBytes(StandardCharsets.UTF_8));byte[]text=new byte[8192];Arrays.fill(text,(byte)'x');for(int remaining=DriveSenseTripChunkStore.CHUNK_BYTES*10;remaining>0;remaining-=Math.min(remaining,text.length))out.write(text,0,Math.min(remaining,text.length));out.write("\",\"route_points\":[".getBytes(StandardCharsets.UTF_8));byte[]point="{\"lat\":43.7,\"lng\":-79.1}".getBytes(StandardCharsets.UTF_8);for(int i=0;i<points;i++){if(i>0)out.write(',');out.write(point);}out.write("]}".getBytes(StandardCharsets.UTF_8));out.flush();raw.getFD().sync();}repository.commitSpool(file,id,"p5_large_fixture");}
    private long scalar(String sql)throws Exception{return repository.coordinator().read(db->{try(Cursor c=db.rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getLong(0);}});}
    private long scalar(DriveSenseStorageCoordinator coordinator,String sql)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getLong(0);}});}
    private String stringScalar(String sql)throws Exception{return stringScalar(repository.coordinator(),sql);}
    private String stringScalar(DriveSenseStorageCoordinator coordinator,String sql)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getString(0);}});}
    private byte[] blob(String sql)throws Exception{return blob(repository.coordinator(),sql);}
    private byte[] blob(DriveSenseStorageCoordinator coordinator,String sql)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery(sql,null)){assertTrue(c.moveToFirst());return c.getBlob(0);}});}
    private byte[] asOfRoot(long through)throws Exception{return asOfRoot(repository.coordinator(),through);}
    private byte[] asOfRoot(DriveSenseStorageCoordinator coordinator,long through)throws Exception{return coordinator.read(db->{MessageDigest digest=MessageDigest.getInstance("SHA-256");digest.update("roadsage.archive.live.v1".getBytes(StandardCharsets.UTF_8));try(Cursor c=db.rawQuery("SELECT trip_id,revision,payload_hash FROM trip_revisions WHERE seq IS NOT NULL AND seq<=? AND commit_state<>'PENDING' AND (retired_seq IS NULL OR retired_seq>?) ORDER BY trip_id,revision",new String[]{Long.toString(through),Long.toString(through)})){while(c.moveToNext()){byte[]id=c.getString(0).getBytes(StandardCharsets.UTF_8);byte[]hash=c.getBlob(2);digest.update(ByteBuffer.allocate(4).putInt(id.length).array());digest.update(id);digest.update(ByteBuffer.allocate(4).putInt(c.getInt(1)).array());digest.update(ByteBuffer.allocate(4).putInt(hash.length).array());digest.update(hash);}}return digest.digest();});}
    private void seedIntegrityRows(DriveSenseStorageCoordinator coordinator,int count)throws Exception{coordinator.write(db->{db.beginTransaction();try{db.delete("trip_current",null,null);db.delete("trip_revisions",null,null);for(int index=0;index<count;index++){ContentValues row=new ContentValues();row.put("trip_id",String.format(java.util.Locale.US,"synthetic-%04d",index));row.put("revision",1);row.put("operation_id","synthetic-"+index);row.put("commit_state","COMMITTED");row.put("seq",100L+index);row.put("status","completed");row.put("plaintext_bytes",1);row.put("payload_hash",MessageDigest.getInstance("SHA-256").digest(new byte[]{(byte)index}));row.put("metadata_hash",new byte[32]);row.put("chunk_count",1);row.put("wrapped_dek",new byte[]{1});row.put("wrap_nonce",new byte[12]);row.put("wrap_algorithm_version",1);row.put("kek_version",1);row.put("schema_version",1);db.insertOrThrow("trip_revisions",null,row);}db.execSQL("UPDATE archive_meta SET last_committed_seq=1000,live_count=?,recovery_state='HEALTHY',authority_state='NATIVE' WHERE id=1",new Object[]{count});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}
    private static JSONObject stepRetention(DriveSenseRawGpsRetention retention,int rawDays,int motionDays,long now,boolean explicit)throws Exception{JSONObject turn=retention.step(rawDays,motionDays,now,explicit);if("P6_FREEZE_REQUIRED".equals(turn.optString("state"))){retention.acknowledgeP6Freeze(turn.getString("jobId"),null,true);turn=retention.step(rawDays,motionDays,now,explicit);}return turn;}
    private static JSONObject awaitBackup(DriveSenseStreamBackupManager manager,String id)throws Exception{for(int i=0;i<400;i++){JSONObject status=manager.status(id);if(status.getBoolean("done")){if(!status.getBoolean("verified"))throw new AssertionError(status.toString());return status;}Thread.sleep(25L);}throw new AssertionError("Portable backup did not finish");}
    private void reset(){DriveSenseStreamBackupManager.resetForTests();DriveSenseStorageCoordinator.resetForTests();context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);delete(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1"));delete(new File(context.getNoBackupFilesDir(),"roadsage_speed_archive_v1"));delete(new File(context.getNoBackupFilesDir(),"roadsage_archive_meta"));delete(new File(context.getNoBackupFilesDir(),"roadsage-p5-retention"));delete(new File(context.getNoBackupFilesDir(),"completed_trip_journal_v1"));delete(new File(context.getNoBackupFilesDir(),"roadsage_stream_backups_v2"));DriveSenseNativeTripStore.prefs(context).edit().remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS).commit();DriveSenseStorageAdmission.setAvailableBytesForTests(8L*1024L*1024L*1024L);DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);}
    private static void delete(File file){if(file==null||!file.exists())return;File[]children=file.listFiles();if(children!=null)for(File child:children)delete(child);file.delete();}
}
