package com.drivesense.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.StatFs;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

final class DriveSenseTripArchiveRepository {
    private static final Object COMPLETED_JOURNAL_INGEST_LOCK = new Object();
    static final int DEFAULT_PAGE_ITEMS=100, MAX_PAGE_ITEMS=200;
    static final int DEFAULT_PAGE_BYTES=256*1024, MAX_RESPONSE_BYTES=512*1024;
    private static final long SPACE_RESERVE_BYTES=256L*1024L*1024L;
    private final DriveSenseStorageCoordinator coordinator;
    private final DriveSenseTripChunkStore chunks;
    private final DriveSenseArchiveCursorCodec cursors;
    private static volatile String testFaultPoint;

    DriveSenseTripArchiveRepository(Context context) throws Exception {
        coordinator=DriveSenseStorageCoordinator.get(context);
        chunks=new DriveSenseTripChunkStore(context);
        cursors=new DriveSenseArchiveCursorCodec(context);
        // Repository construction also happens during ordinary completed-trip
        // admission. Only the process-wide bootstrap owner admits recovery.
        coordinator.initializeTripArchive(chunks);
        // Checkpoint reconciliation is independently idempotent and retains its
        // existing repository-admission behavior; it never reclaims ingress.
        DriveSenseArchiveIntegrity.recoverInterruptedCheckpoints(coordinator);
    }

    DriveSenseStorageCoordinator coordinator(){return coordinator;}
    DriveSenseTripChunkStore chunkStore(){return chunks;}

    /**
     * Canonicalises an admitted operation-owned disk spool without ever loading
     * its complete payload into memory. The caller retains ownership of the
     * source spool until this method returns verified.
     */
    JSONObject commitSpool(File spool,String expectedTripId,String actor) throws Exception {
        return commitSpool(spool,expectedTripId,actor,null,null,false,null,null);
    }

    JSONObject commitRetentionSpool(File spool,String expectedTripId,int sourceRevision,byte[] sourceHash,
                                    boolean rawExpired,String policyIdentity,String generation)throws Exception{
        return commitSpool(spool,expectedTripId,"raw_gps_retention",sourceRevision,sourceHash,rawExpired,policyIdentity,generation);
    }

    /** Creates or resumes the PENDING canonical revision for an encrypted retention stage. */
    int prepareRetentionPublication(String jobId,String tripId,int sourceRevision,byte[]sourceHash,String policyIdentity,
                                    String expectedGeneration,long plaintextBytes,byte[]payloadHash,JSONObject capturedMetadata,
                                    int stageCount)throws Exception{
        String id=requireId(tripId),operation="retention-"+jobId;
        Integer existing=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT revision FROM trip_revisions WHERE trip_id=? AND operation_id=? AND commit_state='PENDING'",new String[]{id,operation})){return c.moveToFirst()?c.getInt(0):null;}});
        if(existing!=null){markRetentionPlanning(jobId,existing,operation);return existing;}
        if(stageCount<1)throw new IllegalArgumentException("Retention stage is empty");
        requireHealthyMutation();admission(Math.min(plaintextBytes+4L*1024L*1024L,32L*1024L*1024L));
        JSONObject display=normalizeRetentionMetadata(capturedMetadata,id);
        int revision=nextRevision(id),kekVersion=DriveSenseEnvelopeCrypto.activeKekVersion(coordinator);byte[]dek=DriveSenseEnvelopeCrypto.newDek();
        try{
            DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(dek,kekVersion,DriveSenseEnvelopeCrypto.wrapAad(expectedGeneration,"trip_payload",id,revision,payloadHash,kekVersion));
            byte[]metadataBytes=display.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),metadataHash=DriveSenseEnvelopeCrypto.sha256(metadataBytes);
            byte[]encryptedMetadata=encryptSmall(metadataBytes,dek,DriveSenseEnvelopeCrypto.chunkAad(expectedGeneration,"trip_metadata",1,id,revision,0,1,metadataBytes.length,payloadHash));
            insertPending(display,id,revision,operation,plaintextBytes,payloadHash,metadataHash,wrapped,encryptedMetadata,java.util.Collections.emptyList(),stageCount);
            markRetentionPlanning(jobId,revision,operation);return revision;
        }finally{Arrays.fill(dek,(byte)0);}
    }

    private void markRetentionPlanning(String jobId,int revision,String operation)throws Exception{coordinator.write(db->{ContentValues values=new ContentValues();values.put("phase","PLAN_PUBLISH_CHUNKS");values.put("publish_revision",revision);values.put("publish_operation_id",operation);values.put("updated_at_ms",System.currentTimeMillis());if(db.update("trip_retention_jobs",values,"job_id=?",new String[]{jobId})!=1)throw new IllegalStateException("RETENTION_JOB_MISSING");return null;});}

    JSONObject planRetentionPublicationChunks(String jobId)throws Exception{
        RetentionPlanState state=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT source_trip_id,publish_revision,publish_operation_id,stage_chunk_count,publish_plan_index FROM trip_retention_jobs WHERE job_id=? AND phase='PLAN_PUBLISH_CHUNKS'",new String[]{jobId})){if(!c.moveToFirst())throw new IllegalStateException("RETENTION_PLAN_STATE_MISSING");return new RetentionPlanState(c.getString(0),c.getInt(1),c.getString(2),c.getInt(3),c.getInt(4));}});
        List<DriveSenseTripChunkStore.ChunkPlan>plans=coordinator.read(db->{List<DriveSenseTripChunkStore.ChunkPlan>out=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT chunk_index,plaintext_bytes FROM retention_stage_chunks WHERE job_id=? AND chunk_index>=? ORDER BY chunk_index LIMIT 8",new String[]{jobId,Integer.toString(state.next)})){while(c.moveToNext())out.add(chunks.planVariableOne(c.getInt(0),state.count,c.getInt(1),state.operation));}return out;});
        if(plans.isEmpty()&&state.next<state.count)throw new IllegalStateException("RETENTION_STAGE_CATALOG_MISMATCH");
        coordinator.write(db->{db.beginTransaction();try{try(Cursor c=db.rawQuery("SELECT publish_plan_index FROM trip_retention_jobs WHERE job_id=? AND phase='PLAN_PUBLISH_CHUNKS'",new String[]{jobId})){if(!c.moveToFirst()||c.getInt(0)!=state.next)throw new IllegalStateException("RETENTION_PLAN_CURSOR_CONFLICT");}for(DriveSenseTripChunkStore.ChunkPlan p:plans){ContentValues row=new ContentValues();row.put("trip_id",state.tripId);row.put("revision",state.revision);row.put("chunk_index",p.index);row.put("operation_id",state.operation);row.put("relative_path",p.relativePath);row.put("plaintext_bytes",p.plaintextBytes);row.put("ciphertext_bytes",p.ciphertextBytes);row.put("nonce",p.nonce);row.put("ciphertext_hash",p.ciphertextHash);row.put("format_version",1);db.insertOrThrow("trip_chunks",null,row);}int next=state.next+plans.size();ContentValues update=new ContentValues();update.put("publish_plan_index",next);update.put("updated_at_ms",System.currentTimeMillis());if(next==state.count)update.put("phase","PUBLISH_CHUNKS");db.update("trip_retention_jobs",update,"job_id=?",new String[]{jobId});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});int next=state.next+plans.size();JSONObject out=new JSONObject();out.put("state",next==state.count?"PUBLISH_PLANNED":"PLAN_PUBLISH_CHUNKS");out.put("itemsWorked",plans.size());out.put("changedItems",plans.size());out.put("bytesWorked",plans.size()*128L);out.put("hasMore",true);return out;
    }

    long publishRetentionChunk(String jobId,String expectedGeneration,byte[]payloadHash,DriveSenseRetentionStage stage,int index)throws Exception{
        RetentionPublish row=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT j.source_trip_id,j.publish_revision,j.publish_operation_id,j.stage_chunk_count,r.wrapped_dek,r.wrap_nonce,r.kek_version,p.plaintext_bytes,p.nonce,p.ciphertext_hash,p.relative_path,p.ciphertext_bytes,p.operation_id FROM trip_retention_jobs j JOIN trip_revisions r ON r.trip_id=j.source_trip_id AND r.revision=j.publish_revision JOIN trip_chunks p ON p.trip_id=r.trip_id AND p.revision=r.revision AND p.chunk_index=? WHERE j.job_id=? AND j.phase='PUBLISH_CHUNKS'",new String[]{Integer.toString(index),jobId})){if(!c.moveToFirst())throw new IllegalStateException("RETENTION_PUBLISH_STATE_MISSING");return new RetentionPublish(c.getString(0),c.getInt(1),c.getString(2),c.getInt(3),c.getBlob(4),c.getBlob(5),c.getInt(6),new DriveSenseTripChunkStore.ChunkPlan(index,c.getInt(7),c.getBlob(8),c.getBlob(9),c.getString(10),c.getInt(11),c.getString(12)));}});
        byte[]stageDek=retentionStageDek(jobId,expectedGeneration),plain=null,canonicalDek=null;
        try{
            plain=stage.read(expectedGeneration,jobId,index,stageDek);
            canonicalDek=DriveSenseEnvelopeCrypto.unwrapDek(row.wrapped,row.wrapNonce,row.kekVersion,DriveSenseEnvelopeCrypto.wrapAad(expectedGeneration,"trip_payload",row.tripId,row.revision,payloadHash,row.kekVersion));
            DriveSenseTripChunkStore.ChunkPlan actual=chunks.writePublishVerifyOne(plain,row.plan,canonicalDek,expectedGeneration,row.tripId,row.revision,row.count,payloadHash);
            final DriveSenseTripChunkStore.ChunkPlan saved=actual;
            coordinator.write(db->{db.beginTransaction();try{ContentValues values=new ContentValues();values.put("ciphertext_hash",saved.ciphertextHash);values.put("ciphertext_bytes",saved.ciphertextBytes);if(db.update("trip_chunks",values,"trip_id=? AND revision=? AND chunk_index=?",new String[]{row.tripId,Integer.toString(row.revision),Integer.toString(index)})!=1)throw new IllegalStateException("RETENTION_CHUNK_ROW_MISSING");db.execSQL("UPDATE trip_retention_jobs SET publish_chunk_index=?,published_ciphertext_bytes=published_ciphertext_bytes+?,updated_at_ms=? WHERE job_id=?",new Object[]{index+1,saved.ciphertextBytes,System.currentTimeMillis(),jobId});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
            return plain.length+stage.encodedBytes(expectedGeneration,jobId,index)+actual.ciphertextBytes;
        }finally{if(stageDek!=null)Arrays.fill(stageDek,(byte)0);if(canonicalDek!=null)Arrays.fill(canonicalDek,(byte)0);if(plain!=null)Arrays.fill(plain,(byte)0);}
    }

    JSONObject finalizeRetentionPublication(String jobId,String policyIdentity,String expectedGeneration,boolean rawExpired,long purgedPoints,long purgedMotion)throws Exception{
        RetentionFinalize row=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT j.source_trip_id,j.source_revision,j.source_payload_hash,j.publish_revision,j.publish_operation_id,j.stage_chunk_count,j.catalog_metadata,r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,j.publish_chunk_index,j.published_ciphertext_bytes FROM trip_retention_jobs j JOIN trip_revisions r ON r.trip_id=j.source_trip_id AND r.revision=j.publish_revision WHERE j.job_id=?",new String[]{jobId})){if(!c.moveToFirst())throw new IllegalStateException("RETENTION_FINALIZE_STATE_MISSING");return new RetentionFinalize(c.getString(0),c.getInt(1),c.getBlob(2),c.getInt(3),c.getString(4),c.getInt(5),new JSONObject(c.getString(6)),c.getBlob(7),c.getBlob(8),c.getBlob(9),c.getInt(10),c.getInt(11),c.getLong(12));}});
        JSONObject display=normalizeRetentionMetadata(row.metadata,row.tripId);
        if(row.publishedCount!=row.count)throw new IllegalStateException("RETENTION_CANONICAL_CHUNK_COUNT_MISMATCH");
        byte[]dek=DriveSenseEnvelopeCrypto.unwrapDek(row.wrapped,row.wrapNonce,row.kekVersion,DriveSenseEnvelopeCrypto.wrapAad(expectedGeneration,"trip_payload",row.tripId,row.revision,row.payloadHash,row.kekVersion));
        try{
            DriveSenseTripChunkStore.OverviewPlan overview=null;int overviewPoints=0;
            if(!rawExpired){byte[]prior=overview(row.tripId,DriveSenseTripOverviewBuilder.MAX_POINTS);if(prior!=null&&prior.length>0){overview=chunks.writeOverview(prior,dek,expectedGeneration,row.tripId,row.revision,row.payloadHash,row.operation);Arrays.fill(prior,(byte)0);overviewPoints=display.optInt("point_count",0);}}
            byte[]metadataBytes=display.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),metadataHash=DriveSenseEnvelopeCrypto.sha256(metadataBytes);
            long seq=commitCatalog(display,row.tripId,row.revision,row.operation,row.payloadHash,metadataHash,java.util.Collections.emptyList(),overview,overviewPoints,"raw_gps_retention",row.sourceRevision,row.sourceHash,policyIdentity,expectedGeneration,purgedPoints,purgedMotion,jobId,row.ciphertextBytes);
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);verifyCommitted(row.tripId,row.revision,seq,row.payloadHash);
            coordinator.write(db->{db.execSQL("UPDATE trip_retention_jobs SET phase='CLEANUP_STAGE',state='COMMITTED',updated_at_ms=? WHERE job_id=?",new Object[]{System.currentTimeMillis(),jobId});return null;});
            JSONObject out=new JSONObject();out.put("tripId",row.tripId);out.put("revision",row.revision);out.put("seq",seq);out.put("verified",true);return out;
        }finally{Arrays.fill(dek,(byte)0);}
    }

    byte[] retentionStageDek(String jobId,String generation)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT source_revision,source_payload_hash,stage_wrapped_dek,stage_wrap_nonce,stage_kek_version FROM trip_retention_jobs WHERE job_id=?",new String[]{jobId})){if(!c.moveToFirst())throw new IllegalStateException("RETENTION_JOB_MISSING");int version=c.getInt(4);return DriveSenseEnvelopeCrypto.unwrapDek(c.getBlob(2),c.getBlob(3),version,DriveSenseEnvelopeCrypto.wrapAad(generation,"retention_stage",jobId,c.getInt(0),c.getBlob(1),version));}});}

    private JSONObject commitSpool(File spool,String expectedTripId,String actor,Integer expectedSourceRevision,
                                   byte[] expectedSourceHash,boolean noOverview,String expectedPolicy,String expectedGeneration) throws Exception {
        if(spool==null||!spool.isFile()||spool.length()<=0)throw new IllegalArgumentException("Trip payload spool is empty");
        String operationId=UUID.randomUUID().toString();
        byte[] dek=null;
        try {
            long plaintextBytes=spool.length();
            byte[] payloadHash=sha256File(spool);
            DriveSenseTripStreamInspector.Result inspected=DriveSenseTripStreamInspector.inspect(
                coordinator.context(),spool,requireId(expectedTripId));
            JSONObject display=inspected.display;
            if(noOverview){display.put("start_address",JSONObject.NULL);display.put("end_address",JSONObject.NULL);display.put("route_points_map_count",0);display.put("route_data_expired_at",System.currentTimeMillis());display.put("route_data_expiration_reason","raw_gps_retention_policy");display.put("point_count",0);}
            String tripId=requireId(display.optString("id",""));
            JSONObject existing=findCommittedByHash(tripId,payloadHash);
            if(existing!=null){verifyExactCommittedPayloadAndRepairSentinel(tripId,existing.getInt("revision"),existing.getLong("seq"),payloadHash);return existing;}
            requireHealthyMutation();
            admission(plaintextBytes*2L+4L*1024L*1024L);
            byte[] metadataBytes=display.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            byte[] metadataHash=DriveSenseEnvelopeCrypto.sha256(metadataBytes);
            String generation=archiveGeneration();
            int revision=nextRevision(tripId);
            dek=DriveSenseEnvelopeCrypto.newDek();
            int kekVersion=DriveSenseEnvelopeCrypto.activeKekVersion(coordinator);
            DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(dek,kekVersion,
                DriveSenseEnvelopeCrypto.wrapAad(generation,"trip_payload",tripId,revision,payloadHash,kekVersion));
            byte[] encryptedMetadata=encryptSmall(metadataBytes,dek,
                DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_metadata",1,tripId,revision,0,1,metadataBytes.length,payloadHash));
            List<DriveSenseTripChunkStore.ChunkPlan> plans=chunks.plan(spool,dek,generation,tripId,revision,payloadHash,operationId);
            injectFault("BEFORE_PENDING");
            insertPending(display,tripId,revision,operationId,plaintextBytes,payloadHash,metadataHash,wrapped,encryptedMetadata,plans);
            injectFault("AFTER_PENDING");
            chunks.writePublishVerify(spool,plans,dek,generation,tripId,revision,payloadHash);
            injectFault("AFTER_CHUNKS_PUBLISHED");
            DriveSenseTripChunkStore.OverviewPlan overviewPlan=noOverview?null:chunks.writeOverview(inspected.overviewBytes,dek,generation,tripId,revision,payloadHash,operationId);
            injectFault("AFTER_OVERVIEW_PUBLISHED");
            long seq=commitCatalog(display,tripId,revision,operationId,payloadHash,metadataHash,plans,overviewPlan,noOverview?0:inspected.overviewPoints,actor,expectedSourceRevision,expectedSourceHash,expectedPolicy,expectedGeneration,0L,0L,null,null);
            injectFault("AFTER_COMMITTED_BEFORE_SENTINEL");
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            injectFault("AFTER_SENTINEL_BEFORE_VERIFY");
            verifyCommitted(tripId,revision,seq,payloadHash);
            JSONObject result=new JSONObject();
            result.put("tripId",tripId);result.put("revision",revision);result.put("seq",seq);
            result.put("archiveGeneration",generation);result.put("payloadHash",DriveSenseEnvelopeCrypto.hex(payloadHash));
            result.put("verified",true);result.put("overviewPoints",inspected.overviewPoints);
            result.put("maxSourceBufferBytes",inspected.sourceBufferBytes);
            result.put("maxMetadataFieldBytes",inspected.fieldBufferBytes);
            result.put("maxDisplayMetadataBytes",inspected.displayBufferBytes);
            result.put("maxPlaintextChunkBytes",DriveSenseTripChunkStore.CHUNK_BYTES);
            DriveSenseDurabilityJournal.record(coordinator.context(),"WARN","TRIP_COMMIT_VERIFIED",operationId,plans.size(),plans.size(),seq,"HEALTHY");
            return result;
        } finally {
            if(dek!=null) Arrays.fill(dek,(byte)0);
            chunks.deleteOwnedTemp(operationId);
        }
    }

    JSONObject queryHistoryPage(JSONObject request) throws Exception {
        int maxItems=boundedInt(request.optInt("maxItems",DEFAULT_PAGE_ITEMS),1,MAX_PAGE_ITEMS,"maxItems");
        int maxBytes=boundedInt(request.optInt("maxBytes",DEFAULT_PAGE_BYTES),1024,MAX_RESPONSE_BYTES,"maxBytes");
        String sort=request.optString("sort","-start_time");
        if(!"-start_time".equals(sort)&&!"start_time".equals(sort))throw new IllegalArgumentException("Unsupported sort");
        String status=safeFilter(request.optString("status",""));
        // P7 Q1 row selection: a filter parameter over the already-existing
        // trip_current_vehicle_status_idx(vehicle_id, status, start_time_ms DESC, trip_id DESC).
        // No schema change, and it licenses no trip-count-proportional aggregate.
        String vehicleId=safeFilter(request.optString("vehicleId",""));
        // P7-IMPL-F05. The date range is part of the **query**, so it is bound
        // into the SQL and into the cursor identity. Narrowing the returned page
        // in JavaScript instead left the range out of the cursor entirely, so a
        // continuation minted for one window could be resumed under another, and
        // an older window paid for every newer row it had to walk past.
        // Half-open [fromMs, toMs), matching Annex C §C2 on both authorities.
        final boolean hasFrom=request.has("fromMs")&&!request.isNull("fromMs");
        final boolean hasTo=request.has("toMs")&&!request.isNull("toMs");
        final long fromMs=hasFrom?request.getLong("fromMs"):Long.MIN_VALUE;
        final long toMs=hasTo?request.getLong("toMs"):Long.MAX_VALUE;
        if(hasFrom&&hasTo&&toMs<fromMs)throw new IllegalArgumentException("Invalid range");
        String rangeId=(hasFrom?Long.toString(fromMs):"")+":"+(hasTo?Long.toString(toMs):"");
        JSONObject cursor=request.has("cursor")?cursors.decode(request.optString("cursor")):null;
        // P7-IMPL-F05 (atomicity). The generation AND the committed sequence are
        // read together, once, BEFORE any page row is selected - and the same
        // pair is re-read after the page is assembled (see below). The delivered
        // code read the generation here, selected rows, enriched them through
        // further independent reads, and only then read `last_committed_seq`,
        // so a page selected at S could be stamped S+1.
        JSONObject sourceBefore=sourceIdentity();
        String generation=sourceBefore.getString("generation");
        if(cursor!=null&&(!generation.equals(cursor.optString("generation"))||!sort.equals(cursor.optString("sort"))||!status.equals(cursor.optString("status"))||!vehicleId.equals(cursor.optString("vehicleId",""))||!rangeId.equals(cursor.optString("range",""))))throw new IllegalArgumentException("CURSOR_QUERY_MISMATCH");
        final long cursorStart=cursor==null?0L:cursor.optLong("start",0L);
        final String cursorId=cursor==null?"":cursor.optString("id","");
        JSONArray items=new JSONArray();
        long[] last=new long[]{0L}; String[] lastId=new String[]{""}; boolean[] more=new boolean[]{false};
        coordinator.read(db->{
            List<String> args=new ArrayList<>();StringBuilder where=new StringBuilder("1=1");
            if(!vehicleId.isEmpty()){where.append(" AND vehicle_id=?");args.add(vehicleId);}
            if(!status.isEmpty()){where.append(" AND status=?");args.add(status);}
            if(hasFrom){where.append(" AND start_time_ms>=?");args.add(Long.toString(fromMs));}
            if(hasTo){where.append(" AND start_time_ms<?");args.add(Long.toString(toMs));}
            if(cursor!=null){boolean desc=sort.startsWith("-");where.append(desc?" AND (start_time_ms < ? OR (start_time_ms=? AND trip_id < ?))":" AND (start_time_ms > ? OR (start_time_ms=? AND trip_id > ?))");args.add(Long.toString(cursorStart));args.add(Long.toString(cursorStart));args.add(cursorId);}
            String order=sort.startsWith("-")?"DESC":"ASC";
            try(Cursor rows=db.rawQuery("SELECT trip_id,revision,seq,start_time_ms,end_time_ms,status,vehicle_id,point_count,distance,duration,score,score_safety,score_smoothness,score_status,needs_rescore,payload_available,overview_available FROM trip_current WHERE "+where+" ORDER BY start_time_ms "+order+",trip_id "+order+" LIMIT ?",append(args,Integer.toString(maxItems+1)))){
                int bytes=128;
                while(rows.moveToNext()){
                    if(items.length()>=maxItems){more[0]=true;break;}
                    JSONObject item=metadataFromCursor(rows);
                    int itemBytes=item.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if(items.length()>0&&bytes+itemBytes>maxBytes){more[0]=true;break;}
                    items.put(item);bytes+=itemBytes;last[0]=rows.getLong(3);lastId[0]=rows.getString(0);
                }
            }
            return null;
        });
        // The exact seam the interleaving regression drives: row selection has
        // completed and its read is released, and nothing has been published.
        // Production leaves this null and pays one null check.
        runPageAssemblySeam();
        for(int index=0;index<items.length();index++)enrichDisplayMetadata(items.getJSONObject(index),false);
        // P7-IMPL-F05. Enrichment happens outside the read that built the page,
        // so the byte budget above measured the unenriched rows. Re-apply it to
        // what is actually being returned: a page trimmed here is a SHORT page
        // WITH a cursor, which the facade reports as PARTIAL and the caller
        // pages past — never a silently oversized response that the plugin
        // rejects wholesale, and never a truncated page claiming to be complete.
        JSONArray page=items;
        {
            int budget=128,kept=0;
            while(kept<page.length()){
                int size=page.getJSONObject(kept).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                if(kept>0&&budget+size>maxBytes)break;
                budget+=size;kept++;
            }
            if(kept<page.length()){
                JSONArray trimmed=new JSONArray();
                for(int index=0;index<kept;index++)trimmed.put(page.getJSONObject(index));
                page=trimmed;more[0]=true;
                if(kept>0){JSONObject lastItem=page.getJSONObject(kept-1);last[0]=lastItem.optLong("start_time_ms");lastId[0]=lastItem.optString("id","");}
            }
        }
        // P7-IMPL-F05 (atomicity). Re-read the identity and refuse if the source
        // moved while this page was being assembled.
        //
        // Why an equality check is a proof and not a heuristic: every commit
        // advances `last_committed_seq` inside the SAME SQLite transaction that
        // changes the rows (`DriveSenseArchiveIntegrity.appendEventInTransaction`,
        // called from `commitCatalog`), and the sequence is monotonic. So if it
        // reads the same value before and after, no commit completed in between,
        // and every read this page made observed one committed state.
        //
        // Why not simply widen `coordinator.read`: `write` takes the SAME read
        // lock (only `exclusive` takes the write lock), so an ordinary commit
        // runs concurrently with any read however much is wrapped in one.
        //
        // Why not one SQLite transaction: Android's `beginTransaction` family
        // opens a WRITE transaction, which would serialise a routine page read
        // against the writer thread and could stall active trip capture. This
        // check adds no critical section at all - two single-row reads, O(1).
        JSONObject sourceAfter=sourceIdentity();
        if(!generation.equals(sourceAfter.getString("generation"))
            ||sourceBefore.getLong("seq")!=sourceAfter.getLong("seq")){
            // Nothing is published: no page, and above all no continuation, so a
            // later turn cannot resume from a position that belongs to a source
            // state this answer never saw.
            throw new IllegalStateException("SNAPSHOT_MOVED_DURING_PAGE");
        }
        JSONObject response=new JSONObject();response.put("archiveGeneration",generation);response.put("canonicalSeq",sourceBefore.getLong("seq"));response.put("items",page);response.put("itemCount",page.length());
        if(more[0]&&page.length()>0){JSONObject next=new JSONObject();next.put("v",1);next.put("generation",generation);next.put("sort",sort);next.put("status",status);next.put("vehicleId",vehicleId);next.put("range",rangeId);next.put("start",last[0]);next.put("id",lastId[0]);response.put("nextCursor",cursors.encode(next));}else response.put("nextCursor",JSONObject.NULL);
        response.put("responseBytes",response.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length);response.put("maxBytes",maxBytes);
        return response;
    }

    /**
     * **Q7** - the capped tag-context page, with its source identity captured in
     * the SAME statement that selects its rows.
     *
     * Q7 cannot borrow Q1's detect-and-refuse guard: Annex A §A1.4 gives Q7
     * storage/authority codes only, so it may not raise a cursor restart, and
     * the previous `publishesSnapshot:false` opt-out was worse - it suppressed
     * verification while the JavaScript facade still published a generic
     * snapshot, so Q7 could return data from S+1 under an envelope saying S.
     *
     * The fix needs no refusal at all. `archive_meta` is LEFT JOINed as the
     * driving row, so **one** SQLite statement - and therefore one committed
     * snapshot - yields both the identity and the rows, including when no row
     * matches. There is nothing for a concurrent commit to split, so Q7 keeps
     * its one-state capped `EXACT` contract with its existing outcome table
     * intact, and adds no lock, no transaction and no retry.
     *
     * Display enrichment still runs afterwards, and cannot change what this
     * answer says: it reads the display blob of the exact `(trip_id, revision)`
     * pairs already selected, and a committed revision's blob is immutable - a
     * new revision inserts a new row rather than rewriting that one.
     */
    JSONObject tagContextPage(int maxRecent,int maxBytes) throws Exception {
        int maxItems=boundedInt(maxRecent,1,100,"maxRecent");
        int bytesBound=boundedInt(maxBytes,1024,MAX_RESPONSE_BYTES,"maxBytes");
        JSONArray items=new JSONArray();
        String[] generation=new String[]{null};
        long[] seq=new long[]{0L};
        coordinator.read(db->{
            try(Cursor rows=db.rawQuery(
                "SELECT m.archive_generation,m.last_committed_seq,"
                +"t.trip_id,t.revision,t.seq,t.start_time_ms,t.end_time_ms,t.status,t.vehicle_id,"
                +"t.point_count,t.distance,t.duration,t.score,t.score_safety,t.score_smoothness,"
                +"t.score_status,t.needs_rescore,t.payload_available,t.overview_available "
                +"FROM archive_meta m LEFT JOIN (SELECT trip_id,revision,seq,start_time_ms,end_time_ms,"
                +"status,vehicle_id,point_count,distance,duration,score,score_safety,score_smoothness,"
                +"score_status,needs_rescore,payload_available,overview_available FROM trip_current "
                +"ORDER BY start_time_ms DESC,trip_id DESC LIMIT ?) t "
                +"WHERE m.id=1",new String[]{Integer.toString(maxItems)})){
                while(rows.moveToNext()){
                    if(generation[0]==null){generation[0]=rows.getString(0);seq[0]=rows.getLong(1);}
                    // The LEFT JOIN's no-match row carries the identity and no trip.
                    if(rows.isNull(2))continue;
                    items.put(metadataFromCursor(new OffsetCursor(rows,2)));
                }
            }
            return null;
        });
        if(generation[0]==null)throw new IllegalStateException("archive_meta missing");
        for(int index=0;index<items.length();index++)enrichDisplayMetadata(items.getJSONObject(index),false);
        // The same post-enrichment byte budget Q1 applies, so a capped answer
        // cannot grow past the bridge response limit after enrichment.
        JSONArray capped=new JSONArray();
        int budget=128;
        for(int index=0;index<items.length();index++){
            JSONObject item=items.getJSONObject(index);
            int size=item.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            if(index>0&&budget+size>bytesBound)break;
            budget+=size;capped.put(item);
        }
        JSONObject out=new JSONObject();
        out.put("items",capped);out.put("itemCount",capped.length());
        out.put("archiveGeneration",generation[0]);out.put("canonicalSeq",seq[0]);
        return out;
    }

    JSONObject getMetadata(String id) throws Exception {
        String tripId=requireId(id);
        JSONObject result=coordinator.read(db->{try(Cursor rows=db.rawQuery("SELECT trip_id,revision,seq,start_time_ms,end_time_ms,status,vehicle_id,point_count,distance,duration,score,score_safety,score_smoothness,score_status,needs_rescore,payload_available,overview_available FROM trip_current WHERE trip_id=?",new String[]{tripId})){if(!rows.moveToFirst())return null;return metadataFromCursor(rows);}});if(result!=null)enrichDisplayMetadata(result,true);return result;
    }

    JSONObject adjacent(String id,String direction,String status) throws Exception {
        JSONObject current=getMetadata(id);if(current==null)return null;
        boolean previous="previous".equals(direction);if(!previous&&!"next".equals(direction))throw new IllegalArgumentException("Invalid direction");
        long start=current.optLong("start_time_ms");String operator=previous?"<":">";String order=previous?"DESC":"ASC";
        String filter=status==null||status.isEmpty()?"":" AND status=?";
        String[] args=status==null||status.isEmpty()?new String[]{Long.toString(start),Long.toString(start),id}:new String[]{Long.toString(start),Long.toString(start),id,status};
        JSONObject result=coordinator.read(db->{try(Cursor rows=db.rawQuery("SELECT trip_id,revision,seq,start_time_ms,end_time_ms,status,vehicle_id,point_count,distance,duration,score,score_safety,score_smoothness,score_status,needs_rescore,payload_available,overview_available FROM trip_current WHERE (start_time_ms "+operator+" ? OR (start_time_ms=? AND trip_id "+operator+" ?))"+filter+" ORDER BY start_time_ms "+order+",trip_id "+order+" LIMIT 1",args)){return rows.moveToFirst()?metadataFromCursor(rows):null;}});if(result!=null)enrichDisplayMetadata(result,false);return result;
    }

    JSONObject aggregates(JSONObject request) throws Exception {
        boolean unfiltered=!request.has("fromMs")&&!request.has("toMs")&&safeFilter(request.optString("vehicleId","")).isEmpty()&&safeFilter(request.optString("status","")).isEmpty();
        if(unfiltered)return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT live_count,total_distance,total_duration,score_sum,score_count,through_seq FROM trip_aggregate_totals WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("Aggregate totals missing");return aggregateObject(c);}});
        long from=request.optLong("fromMs",Long.MIN_VALUE),to=request.optLong("toMs",Long.MAX_VALUE);String vehicle=safeFilter(request.optString("vehicleId","")),status=safeFilter(request.optString("status",""));
        return coordinator.read(db->{List<String>args=new ArrayList<>();StringBuilder where=new StringBuilder("start_time_ms>=? AND start_time_ms<=?");args.add(Long.toString(from));args.add(Long.toString(to));if(!vehicle.isEmpty()){where.append(" AND vehicle_id=?");args.add(vehicle);}if(!status.isEmpty()){where.append(" AND status=?");args.add(status);}try(Cursor c=db.rawQuery("SELECT COUNT(*),COALESCE(SUM(distance),0),COALESCE(SUM(duration),0),COALESCE(SUM(score),0),COUNT(score),MAX(seq) FROM trip_current WHERE "+where,args.toArray(new String[0]))){c.moveToFirst();return aggregateObject(c);}});
    }

    JSONObject chartBuckets(JSONObject request) throws Exception {
        long from=request.getLong("fromMs"),to=request.getLong("toMs");if(to<from)throw new IllegalArgumentException("Invalid range");
        int max=boundedInt(request.optInt("maxBuckets",366),1,1000,"maxBuckets");String gran=request.optString("granularity","day");if(!"day".equals(gran)&&!"week".equals(gran)&&!"month".equals(gran))throw new IllegalArgumentException("Invalid granularity");
        long unit="day".equals(gran)?86400000L:"week".equals(gran)?7L*86400000L:31L*86400000L;if((to-from)/unit>max*2L)throw new IllegalArgumentException("Range exceeds bucket bound");
        String expression="day".equals(gran)?"day_start_ms":"week".equals(gran)?"((day_start_ms / 604800000) * 604800000)":"(CAST(strftime('%s',strftime('%Y-%m-01',day_start_ms/1000,'unixepoch')) AS INTEGER)*1000)";
        String vehicle=safeFilter(request.optString("vehicleId","")),status=safeFilter(request.optString("status",""));List<String>args=new ArrayList<>();args.add(Long.toString(from));args.add(Long.toString(to));StringBuilder filter=new StringBuilder();if(!vehicle.isEmpty()){filter.append(" AND vehicle_id=?");args.add(vehicle);}if(!status.isEmpty()){filter.append(" AND status=?");args.add(status);}args.add(Integer.toString(max));
        JSONArray items=new JSONArray();coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT "+expression+" AS bucket_start,SUM(trip_count),SUM(total_distance),SUM(total_duration),SUM(score_sum),SUM(score_count),MAX(through_seq) FROM trip_aggregate_buckets WHERE day_start_ms>=? AND day_start_ms<=?"+filter+" GROUP BY bucket_start ORDER BY bucket_start LIMIT ?",args.toArray(new String[0]))){while(c.moveToNext()){JSONObject o=new JSONObject();o.put("startMs",c.getLong(0));o.put("tripCount",c.getLong(1));o.put("totalDistance",c.getDouble(2));o.put("totalDuration",c.getDouble(3));o.put("scoreSum",c.getDouble(4));o.put("scoreCount",c.getLong(5));o.put("throughSeq",c.getLong(6));items.put(o);}}return null;});JSONObject result=new JSONObject();result.put("granularity",gran);result.put("items",items);result.put("itemCount",items.length());return result;
    }

    JSONObject projectionFeed(long afterSeq,int maxItems,int maxBytes) throws Exception {
        int itemsBound=boundedInt(maxItems,1,MAX_PAGE_ITEMS,"maxItems"),bytesBound=boundedInt(maxBytes,1024,MAX_RESPONSE_BYTES,"maxBytes");JSONArray items=new JSONArray();boolean[] more={false};long[] last={afterSeq};
        long oldest=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT COALESCE(MIN(seq),0) FROM archive_events",null)){c.moveToFirst();return c.getLong(0);}});coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT seq,event_type,trip_id,revision,reason_code FROM archive_events WHERE seq>? ORDER BY seq LIMIT ?",new String[]{Long.toString(afterSeq),Integer.toString(itemsBound+1)})){int bytes=128;while(c.moveToNext()){if(items.length()>=itemsBound){more[0]=true;break;}JSONObject o=new JSONObject();o.put("seq",c.getLong(0));o.put("eventType",c.getString(1));if(!c.isNull(2))o.put("tripId",c.getString(2));if(!c.isNull(3))o.put("revision",c.getInt(3));o.put("reason",c.getString(4));int next=o.toString().length();if(items.length()>0&&bytes+next>bytesBound){more[0]=true;break;}items.put(o);bytes+=next;last[0]=c.getLong(0);}}return null;});JSONObject out=new JSONObject();out.put("items",items);out.put("itemCount",items.length());out.put("afterSeq",last[0]);out.put("oldestAvailableSeq",oldest);out.put("hasMore",more[0]);out.put("requiredSeq",metaLong("projection_required_seq"));return out;
    }

    JSONObject ingestCompletedJournal(int maxItems,long maxWorkBytes) throws Exception {
        synchronized (COMPLETED_JOURNAL_INGEST_LOCK) {
            return ingestCompletedJournalLocked(maxItems, maxWorkBytes);
        }
    }

    private JSONObject ingestCompletedJournalLocked(int maxItems,long maxWorkBytes) throws Exception {
        int itemLimit=boundedInt(maxItems,1,50,"maxItems");
        if(maxWorkBytes<1024||maxWorkBytes>32L*1024L*1024L)throw new IllegalArgumentException("maxWorkBytes out of range");
        JSONArray ids;
        try {
            ids=DriveSenseCompletedTripJournal.pendingTripIds(coordinator.context(),itemLimit);
        } catch (IllegalStateException blocked) {
            if (!"JOURNAL_INDEX_DIRTY".equals(blocked.getMessage())) throw blocked;
            JSONObject result=new JSONObject();
            result.put("state","BLOCKED_JOURNAL_REPAIR");
            result.put("receipts",new JSONArray());result.put("itemCount",0);
            result.put("workBytes",0);result.put("hasMore",false);
            return result;
        }
        JSONArray receipts=new JSONArray();long used=0;boolean hasMore=false;
        for(int index=0;index<ids.length();index++){
            String id=ids.optString(index,"");String spoolOperation=UUID.randomUUID().toString();File spool=null;
            JSONObject receipt=new JSONObject();receipt.put("tripId",id);
            try{
                DriveSenseCompletedTripJournal.CompletedStreamDescriptor descriptor=
                    DriveSenseCompletedTripJournal.describeCompletedStream(coordinator.context(),id);
                long sourceBytes=descriptor==null?0L:descriptor.plaintextBytes;
                if(descriptor!=null&&receipts.length()>0&&used+sourceBytes>maxWorkBytes){hasMore=true;break;}
                JSONObject committed;
                int sourceChunks;int maxSourceChunk;
                if(descriptor!=null){
                    committed=commitCompletedJournalStream(descriptor);
                    sourceChunks=committed.optInt("sourceChunks",0);
                    maxSourceChunk=DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES;
                }else{
                    // Compatibility-only path for journals written by released
                    // builds before RSAS. New production intake never creates
                    // this plaintext operation spool.
                    spool=chunks.createPlaintextSpool(spoolOperation);
                    DriveSenseCompletedTripJournal.JournalStreamResult source;
                    try(FileOutputStream output=new FileOutputStream(spool,false)){
                        source=DriveSenseCompletedTripJournal.streamCompletedTripTo(coordinator.context(),id,output);
                        output.getFD().sync();
                    }
                    sourceBytes=source.plaintextBytes;
                    if(receipts.length()>0&&used+sourceBytes>maxWorkBytes){hasMore=true;break;}
                    committed=commitSpool(spool,id,"completed_journal_legacy_ingest");
                    sourceChunks=source.chunkCount;maxSourceChunk=source.maxPlaintextChunkBytes;
                }
                injectFault("AFTER_VERIFY_BEFORE_ACK");
                injectFault("DURING_ACK");
                JSONObject ack=DriveSenseCompletedTripJournal.acknowledgeOne(coordinator.context(),id);boolean exact=ack.optBoolean("success",false)&&ack.optInt("removed",0)==1;
                receipt.put("status",exact?"COMMITTED_ACKNOWLEDGED":"COMMITTED_ACK_DEFERRED");receipt.put("seq",committed.optLong("seq"));receipt.put("acknowledged",exact);
                receipt.put("sourceChunks",sourceChunks);receipt.put("maxSourceChunkBytes",maxSourceChunk);
                receipt.put("maxCanonicalStreamBufferBytes",committed.optInt("maxCanonicalStreamBufferBytes",0));
                if(committed.has("peakRouteDiskBytes")){receipt.put("sourceDiskBytes",committed.optLong("sourceDiskBytes"));receipt.put("canonicalDiskBytes",committed.optLong("canonicalDiskBytes"));receipt.put("peakRouteDiskBytes",committed.optLong("peakRouteDiskBytes"));}
                used+=sourceBytes;
            }
            catch(Exception error){android.util.Log.e("DriveSenseTripArchive","Completed-journal ingest retained for retry",error);receipt.put("status","RETRY_REQUIRED");receipt.put("errorCode",safeError(error));}
            finally{if(spool!=null){try{SecureDeleteHelper.secureWipeFile(spool);}catch(Exception ignored){if(spool.exists())spool.delete();}}chunks.deleteOwnedTemp(spoolOperation);}
            if(hasMore)break;
            receipts.put(receipt);
        }
        if(ids.length()>=itemLimit)hasMore=true;
        JSONObject result=new JSONObject();result.put("receipts",receipts);result.put("itemCount",receipts.length());result.put("workBytes",used);result.put("hasMore",hasMore);return result;
    }

    /**
     * Canonicalises an RSAS-owned journal stream with no full plaintext file.
     * Peak route storage is the retained intake representation plus the new
     * canonical ciphertext; the journal is acknowledged only after exact
     * canonical and sentinel verification.
     */
    private JSONObject commitCompletedJournalStream(DriveSenseCompletedTripJournal.CompletedStreamDescriptor source)throws Exception{
        String operationId=UUID.randomUUID().toString();byte[]dek=null;
        try{
            String tripId=requireId(source.tripId);byte[]payloadHash=decodeHex(source.sha256);
            JSONObject existing=findCommittedByHash(tripId,payloadHash);
            boolean authenticatedRepair=false;
            if(existing!=null){
                try{
                    verifyExactCommittedPayloadAndRepairSentinel(tripId,existing.getInt("revision"),existing.getLong("seq"),payloadHash);
                    existing.put("sourceChunks",Math.max(1,(source.plaintextBytes+DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES-1L)/DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES));
                    return existing;
                }catch(SecurityException corruptedCurrent){
                    JSONObject health=DriveSenseArchiveHealth.inventory(coordinator);
                    if(!"RECOVERY_REQUIRED".equals(health.optString("recoveryState"))
                        || health.optBoolean("sentinelMatches")
                        || health.optLong("pendingCount",-1L)!=0L){
                        throw corruptedCurrent;
                    }
                    authenticatedRepair=true;
                }
            }
            if(!authenticatedRepair)requireHealthyMutation();
            admission(source.plaintextBytes+4L*1024L*1024L);
            JSONObject display=displayMetadata(source.metadata);display.put("id",tripId);
            byte[]metadataBytes=display.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);byte[]metadataHash=DriveSenseEnvelopeCrypto.sha256(metadataBytes);
            String generation=archiveGeneration();int revision=nextRevision(tripId);dek=DriveSenseEnvelopeCrypto.newDek();int kekVersion=DriveSenseEnvelopeCrypto.activeKekVersion(coordinator);
            DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(dek,kekVersion,DriveSenseEnvelopeCrypto.wrapAad(generation,"trip_payload",tripId,revision,payloadHash,kekVersion));
            byte[]encryptedMetadata=encryptSmall(metadataBytes,dek,DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_metadata",1,tripId,revision,0,1,metadataBytes.length,payloadHash));
            List<DriveSenseTripChunkStore.ChunkPlan>plans=chunks.planStreaming(source.plaintextBytes,operationId);
            injectFault("BEFORE_PENDING");insertPending(display,tripId,revision,operationId,source.plaintextBytes,payloadHash,metadataHash,wrapped,encryptedMetadata,plans);injectFault("AFTER_PENDING");
            DriveSenseTripChunkStore.StreamResult streamed=chunks.writePublishVerifyStream(output->{
                DriveSenseCompletedTripJournal.JournalStreamResult result=DriveSenseCompletedTripJournal.streamCompletedTripTo(coordinator.context(),tripId,output);
                return new DriveSenseTripChunkStore.StreamSourceResult(result.plaintextBytes,result.sha256);
            },plans,dek,generation,tripId,revision,payloadHash);
            updateStreamingChunkRows(tripId,revision,plans);injectFault("AFTER_CHUNKS_PUBLISHED");
            DriveSenseTripChunkStore.OverviewPlan overview=chunks.writeOverview(source.overviewBytes,dek,generation,tripId,revision,payloadHash,operationId);injectFault("AFTER_OVERVIEW_PUBLISHED");
            long seq=commitCatalog(display,tripId,revision,operationId,payloadHash,metadataHash,plans,overview,source.overviewPoints,"completed_journal_ingest",null,null,null,null,0L,0L,null,null);injectFault("AFTER_COMMITTED_BEFORE_SENTINEL");
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);injectFault("AFTER_SENTINEL_BEFORE_VERIFY");verifyCommitted(tripId,revision,seq,payloadHash);
            long canonicalDiskBytes=sumCipher(plans)+plans.size()*28L+(overview==null?0L:overview.ciphertextBytes+28L);
            JSONObject result=new JSONObject();result.put("tripId",tripId);result.put("revision",revision);result.put("seq",seq);result.put("archiveGeneration",generation);result.put("payloadHash",source.sha256);result.put("verified",true);result.put("overviewPoints",source.overviewPoints);result.put("maxCanonicalStreamBufferBytes",streamed.maximumBufferedBytes);result.put("sourceChunks",Math.max(1,(source.plaintextBytes+DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES-1L)/DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES));result.put("sourceDiskBytes",source.sourceDiskBytes);result.put("canonicalDiskBytes",canonicalDiskBytes);result.put("peakRouteDiskBytes",source.sourceDiskBytes+canonicalDiskBytes);
            DriveSenseDurabilityJournal.record(coordinator.context(),"WARN","TRIP_COMMIT_VERIFIED",operationId,plans.size(),plans.size(),seq,"HEALTHY");return result;
        }finally{if(dek!=null)Arrays.fill(dek,(byte)0);chunks.deleteOwnedTemp(operationId);}
    }

    private void updateStreamingChunkRows(String tripId,int revision,List<DriveSenseTripChunkStore.ChunkPlan>plans)throws Exception{
        coordinator.write(db->{db.beginTransaction();try{for(DriveSenseTripChunkStore.ChunkPlan plan:plans){ContentValues values=new ContentValues();values.put("relative_path",plan.relativePath);values.put("plaintext_bytes",plan.plaintextBytes);values.put("ciphertext_bytes",plan.ciphertextBytes);values.put("nonce",plan.nonce);values.put("ciphertext_hash",plan.ciphertextHash);int changed=db.update("trip_chunks",values,"trip_id=? AND revision=? AND chunk_index=?",new String[]{tripId,Integer.toString(revision),Integer.toString(plan.index)});if(changed!=1)throw new IllegalStateException("Streaming chunk catalog row missing");}db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
    }

    JSONObject tombstone(String tripId,String reason,boolean dataRights)throws Exception {
        requireHealthyMutation();
        String id=requireId(tripId);String safeReason=reason==null?"user_delete":reason;
        List<String> files=new ArrayList<>();
        JSONObject result=coordinator.exclusive(db->{
            db.beginTransaction();
            try {
                try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' LIMIT 1",null)){
                    if(lease.moveToFirst())throw new IllegalStateException("EXPORT_SNAPSHOT_CONFLICT_RETRY");
                }
                JSONObject prior=null;int revision;byte[]payloadHash;
                try(Cursor c=db.rawQuery("SELECT c.revision,c.distance,c.duration,c.score,c.start_time_ms,c.vehicle_id,c.status,r.payload_hash FROM trip_current c JOIN trip_revisions r ON r.trip_id=c.trip_id AND r.revision=c.revision WHERE c.trip_id=?",new String[]{id})){
                    if(!c.moveToFirst()){JSONObject missing=new JSONObject();missing.put("deleted",false);missing.put("missing",true);db.setTransactionSuccessful();return missing;}
                    revision=c.getInt(0);prior=new JSONObject();prior.put("distance",c.getDouble(1));prior.put("duration",c.getDouble(2));if(!c.isNull(3))prior.put("score",c.getDouble(3));prior.put("start_time_ms",c.getLong(4));prior.put("vehicle_id",c.getString(5));prior.put("status",c.getString(6));payloadHash=c.getBlob(7);
                }
                try(Cursor c=db.rawQuery("SELECT relative_path,ciphertext_bytes FROM trip_chunks WHERE trip_id=? UNION ALL SELECT overview_path,overview_plaintext_bytes FROM trip_revisions WHERE trip_id=? AND overview_path IS NOT NULL",new String[]{id,id})){
                    while(c.moveToNext()){String path=c.getString(0);files.add(path);DriveSenseArchiveUnlinkDebt.record(db,path,c.getLong(1),"trip_tombstone");}
                }
                byte[]eventHash=dataRights?null:payloadHash;
                long seq=DriveSenseArchiveIntegrity.appendEventInTransaction(db,"TOMBSTONE",dataRights?null:id,dataRights?null:revision,revision,eventHash,null,safeReason,dataRights?"data_rights":"user",null,null,null,System.currentTimeMillis());
                db.delete("trip_current","trip_id=?",new String[]{id});
                DriveSenseP6DerivedState.markTripTombstone(db,id,revision,payloadHash,seq);
                DriveSenseRetentionDue.remove(db,id);
                try(Cursor refs=db.rawQuery("SELECT kek_version,COUNT(*) FROM trip_revisions WHERE trip_id=? AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' GROUP BY kek_version",new String[]{id})){
                    while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(db,"trip_archive",refs.getInt(0),-refs.getLong(1));
                }
                ContentValues retired=new ContentValues();retired.put("commit_state","TOMBSTONED");retired.put("wrapped_dek",new byte[0]);retired.put("wrap_nonce",new byte[0]);
                db.update("trip_revisions",retired,"trip_id=?",new String[]{id});
                db.execSQL("UPDATE trip_revisions SET retired_seq=COALESCE(retired_seq,?) WHERE trip_id=?",new Object[]{seq,id});
                db.delete("trip_chunks","trip_id=?",new String[]{id});
                db.execSQL("UPDATE archive_meta SET live_count=MAX(0,live_count-1) WHERE id=1");applyAggregate(db,prior,-1,seq);
                db.setTransactionSuccessful();
                JSONObject out=new JSONObject();out.put("deleted",true);out.put("tripId",id);out.put("tombstoneSeq",seq);out.put("dataRights",dataRights);out.put("cryptoShreddedRevisions",true);return out;
            } finally { db.endTransaction(); }
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        injectFault("AFTER_TOMBSTONE_CATALOG_BEFORE_UNLINK");
        for(String relative:files){chunks.deleteRelative(relative);DriveSenseArchiveUnlinkDebt.completeIfAbsent(coordinator,chunks,relative);}
        return result;
    }

    /**
     * Data-rights erasure is a generation boundary, not N individual tombstones.
     * The old event chain and trip identities are removed in the same exclusive
     * SQLite transaction. Chunk unlink follows crypto-shredding and a durable
     * new-generation sentinel; secure_delete/WAL truncation are best-effort
     * residual-copy controls and are not represented as physical flash erasure.
     */
    JSONObject rolloverGenerationForIdentityErasure(String reason)throws Exception {
        List<String> files=new ArrayList<>();
        List<String> p6Files=new ArrayList<>();
        String[] prior=new String[2];
        long[] removed=new long[1];
        JSONObject result=coordinator.exclusive(db->{
            db.beginTransaction();
            try{
                try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' LIMIT 1",null)){
                    if(lease.moveToFirst())throw new IllegalStateException("EXPORT_SNAPSHOT_CONFLICT_RETRY");
                }
                try(Cursor c=db.rawQuery("SELECT archive_generation,authority_state,live_count FROM archive_meta WHERE id=1",null)){
                    if(!c.moveToFirst())throw new IllegalStateException("archive_meta missing");
                    prior[0]=c.getString(0);prior[1]=c.getString(1);removed[0]=c.getLong(2);
                }
                try(Cursor c=db.rawQuery("SELECT relative_path,ciphertext_bytes FROM trip_chunks UNION ALL SELECT overview_path,overview_plaintext_bytes FROM trip_revisions WHERE overview_path IS NOT NULL",null)){
                    while(c.moveToNext()){String path=c.getString(0);files.add(path);DriveSenseArchiveUnlinkDebt.record(db,path,c.getLong(1),"generation_erasure");}
                }
                try(Cursor c=db.rawQuery("SELECT j.archive_generation,j.job_id,s.chunk_index,s.encoded_bytes FROM trip_retention_jobs j JOIN retention_stage_chunks s ON s.job_id=j.job_id",null)){
                    while(c.moveToNext())DriveSenseArchiveUnlinkDebt.record(db,DriveSenseRetentionStage.debtPath(c.getString(0),c.getString(1),c.getInt(2)),c.getLong(3),"generation_erasure_stage");
                }
                try(Cursor c=db.rawQuery("SELECT relative_path FROM p6_geometry_chunks",null)){
                    while(c.moveToNext())p6Files.add(c.getString(0));
                }
                db.delete("trip_current",null,null);
                db.delete("trip_chunks",null,null);
                db.delete("trip_revisions",null,null);
                db.delete("archive_events",null,null);
                db.delete("integrity_checkpoint_jobs",null,null);
                db.delete("trip_retention_jobs",null,null);
                db.delete("retention_stage_chunks",null,null);
                db.delete("trip_retention_due",null,null);
                db.delete("archive_blob_inventory",null,null);
                db.delete("archive_deep_audit_jobs",null,null);
                db.execSQL("UPDATE journal_summary SET state='DIRTY',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE journal_repair_state SET state='DIRTY',cursor='',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE rotation_state SET count_state='DIRTY',cursor=NULL,cursor_kek_version=NULL,cursor_commit_state=NULL,cursor_item_id=NULL,cursor_revision=NULL,zero_proof=0,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE p5_control_state SET writers_enabled=1,journal_state='DIRTY',retention_policy_version=NULL,retention_raw_days=0,retention_motion_days=0,retention_index_state='BACKFILL_REQUIRED',kek_count_state='DIRTY',blob_inventory_state='BACKFILL_REQUIRED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.delete("migration_records",null,null);
                db.delete("migration_quarantine",null,null);
                db.delete("migration_shortfall",null,null);
                db.delete("migration_ingress",null,null);
                db.delete("open_operations",null,null);
                db.delete("key_reference_counts","domain_id='trip_archive'",null);
                db.delete("encrypted_file_key_registry","domain_id='retention_stage'",null);
                db.delete("trip_aggregate_buckets",null,null);
                db.execSQL("UPDATE trip_aggregate_totals SET live_count=0,total_distance=0,total_duration=0,score_sum=0,score_count=0,through_seq=0 WHERE id=1");
                DriveSenseP6DerivedState.eraseTripDerivedForGeneration(db);
                String generation=UUID.randomUUID().toString();long now=System.currentTimeMillis();
                db.execSQL("UPDATE archive_meta SET archive_generation=?,recovery_state='HEALTHY',last_committed_seq=0,live_count=0,tip_chain_hash=?,pending_count=0,projection_required_seq=0,updated_at_ms=? WHERE id=1",new Object[]{generation,new byte[32],now});
                try{db.execSQL("DELETE FROM sqlite_sequence WHERE name='archive_events'");}catch(Exception ignored){}
                long seq=DriveSenseArchiveIntegrity.appendEventInTransaction(db,"GENERATION_INIT",null,null,null,null,null,reason==null?"data_rights_erasure":reason,"data_rights",null,null,null,now);
                db.setTransactionSuccessful();
                JSONObject out=new JSONObject();out.put("erased",true);out.put("verified",true);out.put("removedTripCount",removed[0]);out.put("priorGeneration",prior[0]);out.put("archiveGeneration",generation);out.put("generationInitSeq",seq);out.put("authorityState",prior[1]);return out;
            }finally{db.endTransaction();}
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        injectFault("AFTER_ERASURE_CATALOG_BEFORE_UNLINK");
        for(String relative:files){chunks.deleteRelative(relative);DriveSenseArchiveUnlinkDebt.completeIfAbsent(coordinator,chunks,relative);}
        for(String relative:p6Files)DriveSenseP6DerivedBlobStore.deleteFile(coordinator.context(),relative);
        coordinator.write(db->{try(Cursor ignored=db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)",null)){if(ignored.moveToFirst())ignored.getInt(0);}return null;});
        DriveSenseDurabilityJournal.record(coordinator.context(),"CRITICAL","IDENTITY_ERASURE_GENERATION_ROLLOVER",null,removed[0],0,0,"HEALTHY");
        return result;
    }

    JSONObject reportIndexedDbOpen(String dbName,long oldVersion,long newVersion)throws Exception {
        JSONObject out=new JSONObject();out.put("databaseName",dbName);out.put("oldVersion",oldVersion);out.put("newVersion",newVersion);long live=metaLong("live_count");long seq=metaLong("last_committed_seq");boolean mismatch=oldVersion==0L&&live>0L;if(mismatch){coordinator.write(db->{db.execSQL("UPDATE archive_meta SET projection_required_seq=last_committed_seq,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});return null;});DriveSenseDurabilityJournal.record(coordinator.context(),"CRITICAL","INDEXEDDB_GENERATION_MISMATCH",null,oldVersion,newVersion,seq,"PROJECTION_REBUILD_REQUIRED");}out.put("generationMismatch",mismatch);out.put("canonicalDataSafe",true);out.put("projectionRequiredSeq",mismatch?seq:metaLong("projection_required_seq"));return out;
    }

    PayloadDescriptor descriptor(String tripId,Integer requestedRevision) throws Exception {
        String id=requireId(tripId);return coordinator.read(db->{String sql=requestedRevision==null?"SELECT r.revision,r.chunk_count,r.plaintext_bytes,r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,m.archive_generation FROM trip_revisions r JOIN trip_current c ON c.trip_id=r.trip_id AND c.revision=r.revision JOIN archive_meta m ON m.id=1 WHERE r.trip_id=? AND r.commit_state='COMMITTED'":"SELECT r.revision,r.chunk_count,r.plaintext_bytes,r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,m.archive_generation FROM trip_revisions r JOIN archive_meta m ON m.id=1 WHERE r.trip_id=? AND r.revision=? AND r.commit_state IN ('COMMITTED','SUPERSEDED')";String[]args=requestedRevision==null?new String[]{id}:new String[]{id,Integer.toString(requestedRevision)};try(Cursor c=db.rawQuery(sql,args)){if(!c.moveToFirst())return null;int rev=c.getInt(0),count=c.getInt(1);byte[]hash=c.getBlob(3);int kv=c.getInt(6);String gen=c.getString(7);byte[]dek=DriveSenseEnvelopeCrypto.unwrapDek(c.getBlob(4),c.getBlob(5),kv,DriveSenseEnvelopeCrypto.wrapAad(gen,"trip_payload",id,rev,hash,kv));return new PayloadDescriptor(id,rev,count,c.getLong(2),hash,gen,dek);}});
    }

    byte[] readPayloadChunk(PayloadDescriptor descriptor,int index) throws Exception {
        if(index<0||index>=descriptor.chunkCount)throw new IllegalArgumentException("Chunk index out of range");
        DriveSenseTripChunkStore.ChunkPlan plan=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT plaintext_bytes,nonce,ciphertext_hash,relative_path,ciphertext_bytes,operation_id FROM trip_chunks WHERE trip_id=? AND revision=? AND chunk_index=?",new String[]{descriptor.tripId,Integer.toString(descriptor.revision),Integer.toString(index)})){if(!c.moveToFirst())throw new IllegalStateException("PAYLOAD_CHUNK_MISSING");return new DriveSenseTripChunkStore.ChunkPlan(index,c.getInt(0),c.getBlob(1),c.getBlob(2),c.getString(3),c.getInt(4),c.getString(5));}});
        try{return chunks.readChunk(plan,descriptor.dek,descriptor.generation,descriptor.tripId,descriptor.revision,descriptor.chunkCount,descriptor.payloadHash);}
        catch(Exception error){enterRecoveryRequired("COMMITTED_PAYLOAD_CHUNK_INVALID",descriptor.tripId,descriptor.revision);throw error;}
    }

    private void enterRecoveryRequired(String event,String tripId,long detail)throws Exception{
        coordinator.write(db->{db.execSQL("UPDATE archive_meta SET recovery_state='RECOVERY_REQUIRED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});return null;});
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        DriveSenseDurabilityJournal.record(coordinator.context(),"CRITICAL",event,null,detail,0,metaLong("last_committed_seq"),"RECOVERY_REQUIRED");
    }

    byte[] overview(String tripId,int maxPoints) throws Exception {
        if(maxPoints<1||maxPoints>DriveSenseTripOverviewBuilder.MAX_POINTS)throw new IllegalArgumentException("maxPoints out of range");
        String id=requireId(tripId);return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT r.revision,r.overview_path,r.overview_nonce,r.overview_hash,r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,m.archive_generation,r.overview_plaintext_bytes FROM trip_revisions r JOIN trip_current t ON t.trip_id=r.trip_id AND t.revision=r.revision JOIN archive_meta m ON m.id=1 WHERE r.trip_id=? AND r.overview_path IS NOT NULL",new String[]{id})){if(!c.moveToFirst())return null;int rev=c.getInt(0),kv=c.getInt(7),plainBytes=c.getInt(9);String path=c.getString(1),gen=c.getString(8);byte[]payloadHash=c.getBlob(4),dek=DriveSenseEnvelopeCrypto.unwrapDek(c.getBlob(5),c.getBlob(6),kv,DriveSenseEnvelopeCrypto.wrapAad(gen,"trip_payload",id,rev,payloadHash,kv));try{byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(gen,"trip_overview",1,id,rev,0,1,plainBytes,payloadHash);return chunks.readRelative(path,dek,c.getBlob(2),aad);}finally{Arrays.fill(dek,(byte)0);}}});
    }

    private void insertPending(JSONObject display,String id,int revision,String operation,long plaintextBytes,byte[]payloadHash,byte[]metadataHash,DriveSenseEnvelopeCrypto.WrappedDek wrapped,byte[]encryptedMetadata,List<DriveSenseTripChunkStore.ChunkPlan>plans)throws Exception{
        insertPending(display,id,revision,operation,plaintextBytes,payloadHash,metadataHash,wrapped,encryptedMetadata,plans,plans.size());
    }

    private void insertPending(JSONObject display,String id,int revision,String operation,long plaintextBytes,byte[]payloadHash,byte[]metadataHash,DriveSenseEnvelopeCrypto.WrappedDek wrapped,byte[]encryptedMetadata,List<DriveSenseTripChunkStore.ChunkPlan>plans,int declaredChunkCount)throws Exception{
        coordinator.write(db->{db.beginTransaction();try{ContentValues r=revisionValues(display,id,revision,operation,plaintextBytes,payloadHash,metadataHash);r.put("commit_state","PENDING");r.put("wrapped_dek",wrapped.ciphertext);r.put("wrap_nonce",wrapped.nonce);r.put("wrap_algorithm_version",1);r.put("kek_version",wrapped.version);r.put("chunk_count",declaredChunkCount);r.put("display_metadata_ciphertext",encryptedMetadata);db.insertOrThrow("trip_revisions",null,r);db.execSQL("INSERT INTO key_reference_counts(domain_id,key_version,reference_count,updated_at_ms) VALUES('trip_archive',?,?,?) ON CONFLICT(domain_id,key_version) DO UPDATE SET reference_count=reference_count+1,updated_at_ms=excluded.updated_at_ms",new Object[]{wrapped.version,1,System.currentTimeMillis()});for(DriveSenseTripChunkStore.ChunkPlan p:plans){ContentValues c=new ContentValues();c.put("trip_id",id);c.put("revision",revision);c.put("chunk_index",p.index);c.put("operation_id",operation);c.put("relative_path",p.relativePath);c.put("plaintext_bytes",p.plaintextBytes);c.put("ciphertext_bytes",p.ciphertextBytes);c.put("nonce",p.nonce);c.put("ciphertext_hash",p.ciphertextHash);c.put("format_version",1);db.insertOrThrow("trip_chunks",null,c);}db.execSQL("UPDATE archive_meta SET pending_count=pending_count+1,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});ContentValues op=new ContentValues();op.put("operation_id",operation);op.put("operation_type","TRIP_COMMIT");op.put("state","PENDING");op.put("owner_token",operation);op.put("created_at_ms",System.currentTimeMillis());op.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("open_operations",null,op);db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
    }

    private long commitCatalog(JSONObject display,String id,int revision,String operation,byte[]payloadHash,byte[]metadataHash,List<DriveSenseTripChunkStore.ChunkPlan>plans,DriveSenseTripChunkStore.OverviewPlan overview,int overviewPoints,String actor,Integer expectedSourceRevision,byte[]expectedSourceHash,String expectedPolicy,String expectedGeneration,long purgedPoints,long purgedMotion,String retentionJobId,Long knownCiphertextBytes)throws Exception{
        return coordinator.write(db->{db.beginTransaction();try{Integer prior=null;JSONObject priorMeta=null;try(Cursor c=db.rawQuery("SELECT revision,distance,duration,score,start_time_ms,vehicle_id,status FROM trip_current WHERE trip_id=?",new String[]{id})){if(c.moveToFirst()){prior=c.getInt(0);priorMeta=new JSONObject();priorMeta.put("distance",c.getDouble(1));priorMeta.put("duration",c.getDouble(2));if(!c.isNull(3))priorMeta.put("score",c.getDouble(3));priorMeta.put("start_time_ms",c.getLong(4));priorMeta.put("vehicle_id",c.getString(5));priorMeta.put("status",c.getString(6));}}
            boolean sourceLeaseProtected=false;
            if(expectedSourceRevision!=null){if(prior==null||prior.intValue()!=expectedSourceRevision||retentionJobId==null)throw new IllegalStateException("RETENTION_SOURCE_CHANGED");try(Cursor policy=db.rawQuery("SELECT m.archive_generation,p.retention_policy_version FROM archive_meta m JOIN p5_control_state p ON p.id=1 WHERE m.id=1",null)){if(!policy.moveToFirst()||expectedGeneration==null||expectedPolicy==null||!expectedGeneration.equals(policy.getString(0))||!expectedPolicy.equals(policy.getString(1)))throw new IllegalStateException("RETENTION_POLICY_OR_GENERATION_CHANGED");}try(Cursor source=db.rawQuery("SELECT payload_hash,seq FROM trip_revisions WHERE trip_id=? AND revision=?",new String[]{id,Integer.toString(expectedSourceRevision)})){if(!source.moveToFirst()||!Arrays.equals(expectedSourceHash,source.getBlob(0))||source.isNull(1))throw new IllegalStateException("RETENTION_SOURCE_CHANGED");long sourceSeq=source.getLong(1);try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' AND archive_generation=? AND through_seq>=? LIMIT 1",new String[]{expectedGeneration,Long.toString(sourceSeq)})){sourceLeaseProtected=lease.moveToFirst();}}}
            if(prior!=null){long supersedeSeq=DriveSenseArchiveIntegrity.appendEventInTransaction(db,"SUPERSEDE",id,prior,prior,payloadHash,metadataHash,"new_revision",actor,null,null,null,System.currentTimeMillis());db.execSQL("UPDATE trip_revisions SET commit_state='SUPERSEDED',retired_seq=COALESCE(retired_seq,?) WHERE trip_id=? AND revision=?",new Object[]{supersedeSeq,id,prior});}
            long seq=DriveSenseArchiveIntegrity.appendEventInTransaction(db,"COMMIT",id,revision,prior,payloadHash,metadataHash,"canonical_commit",actor,null,null,null,System.currentTimeMillis());
            ContentValues update=new ContentValues();update.put("commit_state","COMMITTED");update.put("seq",seq);update.put("committed_at_ms",System.currentTimeMillis());update.put("ciphertext_bytes",knownCiphertextBytes==null?sumCipher(plans):knownCiphertextBytes);if(overview!=null){update.put("overview_path",overview.relativePath);update.put("overview_hash",overview.hash);update.put("overview_nonce",overview.nonce);update.put("overview_plaintext_bytes",overview.plaintextBytes);update.put("overview_point_count",overviewPoints);}db.update("trip_revisions",update,"trip_id=? AND revision=?",new String[]{id,Integer.toString(revision)});
            ContentValues current=currentValues(display,id,revision,seq,overview!=null);db.insertWithOnConflict("trip_current",null,current,SQLiteDatabase.CONFLICT_REPLACE);
            DriveSenseRetentionDue.maintainCurrent(db,id,revision,display.optLong("start_time_ms",0L),display.optLong("end_time_ms",0L));
            db.execSQL("UPDATE archive_meta SET live_count=live_count+?,pending_count=MAX(0,pending_count-1) WHERE id=1",new Object[]{prior==null?1:0});
            updateAggregates(db,priorMeta,display,seq);
            DriveSenseP6DerivedState.markTripDesired(db,id,revision,payloadHash,seq,
                expectedSourceRevision!=null?"RETENTION_FREEZE":"UPSERT");
            if(expectedSourceRevision!=null){ContentValues retirement=new ContentValues();retirement.put("source_retirement_state",sourceLeaseProtected?"LEASE_HELD":"READY");retirement.put("source_retire_cursor",-1);retirement.put("updated_at_ms",System.currentTimeMillis());if(db.update("trip_retention_jobs",retirement,"job_id=?",new String[]{retentionJobId})!=1)throw new IllegalStateException("RETENTION_JOB_MISSING");ContentValues receipt=new ContentValues();receipt.put("operation_id",operation);receipt.put("event_type","RAW_GPS_AUTO_PURGED");receipt.put("reason_code","raw_gps_retention_policy");receipt.put("trip_count",1);receipt.put("point_count",Math.max(0L,purgedPoints));receipt.put("motion_sample_count",Math.max(0L,purgedMotion));receipt.put("state","PENDING");receipt.put("created_at_ms",System.currentTimeMillis());receipt.put("updated_at_ms",System.currentTimeMillis());db.insertWithOnConflict("privacy_receipt_debt",null,receipt,SQLiteDatabase.CONFLICT_IGNORE);}
            db.delete("open_operations","operation_id=?",new String[]{operation});injectFault("DURING_COMMITTED_TRANSACTION");db.setTransactionSuccessful();return seq;}finally{db.endTransaction();}});
    }

    private void verifyCommitted(String id,int revision,long seq,byte[]hash)throws Exception{coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT commit_state,seq,payload_hash FROM trip_revisions WHERE trip_id=? AND revision=?",new String[]{id,Integer.toString(revision)})){if(!c.moveToFirst()||!"COMMITTED".equals(c.getString(0))||c.getLong(1)!=seq||!Arrays.equals(hash,c.getBlob(2)))throw new IllegalStateException("CANONICAL_VERIFY_FAILED");}return null;});JSONObject health=DriveSenseArchiveHealth.inventory(coordinator);if(!health.optBoolean("sentinelMatches",false))throw new IllegalStateException("SENTINEL_VERIFY_FAILED");}
    private void verifyExactCommittedPayloadAndRepairSentinel(String id,int revision,long seq,byte[]hash)throws Exception{
        coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT commit_state,seq,payload_hash FROM trip_revisions WHERE trip_id=? AND revision=?",new String[]{id,Integer.toString(revision)})){if(!c.moveToFirst()||!"COMMITTED".equals(c.getString(0))||c.getLong(1)!=seq||!Arrays.equals(hash,c.getBlob(2)))throw new IllegalStateException("CANONICAL_VERIFY_FAILED");}return null;});
        MessageDigest digest=MessageDigest.getInstance("SHA-256");long bytes=0L;
        try(PayloadDescriptor descriptor=descriptor(id,revision)){
            if(descriptor==null)throw new IllegalStateException("CANONICAL_VERIFY_FAILED: revision unavailable");
            for(int index=0;index<descriptor.chunkCount;index++){byte[]plain=readPayloadChunk(descriptor,index);try{digest.update(plain);bytes+=plain.length;}finally{Arrays.fill(plain,(byte)0);}}
            byte[] plaintextDigest=digest.digest();
            byte[] legacyJournalDigest=DriveSenseEnvelopeCrypto.sha256(plaintextDigest);
            boolean identityMatches=Arrays.equals(hash,plaintextDigest)||Arrays.equals(hash,legacyJournalDigest);
            Arrays.fill(plaintextDigest,(byte)0);Arrays.fill(legacyJournalDigest,(byte)0);
            if(bytes!=descriptor.plaintextBytes||!identityMatches)throw new SecurityException("CANONICAL_PAYLOAD_VERIFY_FAILED");
        }
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        JSONObject health=DriveSenseArchiveHealth.inventory(coordinator);if(!"HEALTHY".equals(health.optString("recoveryState"))||!health.optBoolean("sentinelMatches",false))throw new IllegalStateException("SENTINEL_VERIFY_FAILED");
    }
    private ContentValues revisionValues(JSONObject d,String id,int revision,String operation,long plaintextBytes,byte[]payloadHash,byte[]metadataHash){ContentValues v=new ContentValues();v.put("trip_id",id);v.put("revision",revision);v.put("operation_id",operation);v.put("start_time_ms",d.optLong("start_time_ms"));v.put("end_time_ms",d.optLong("end_time_ms"));v.put("status",d.optString("status","completed"));v.put("vehicle_id",d.optString("vehicle_id",null));v.put("point_count",d.optInt("point_count"));v.put("distance",d.optDouble("distance"));v.put("duration",d.optDouble("duration"));putNullable(v,"score",d.opt("score"));putNullable(v,"score_safety",d.opt("score_safety"));putNullable(v,"score_smoothness",d.opt("score_smoothness"));v.put("score_status",d.optString("score_status",null));v.put("needs_rescore",d.optBoolean("needs_rescore")?1:0);v.put("plaintext_bytes",plaintextBytes);v.put("payload_hash",payloadHash);v.put("metadata_hash",metadataHash);v.put("schema_version",1);return v;}
    private ContentValues currentValues(JSONObject d,String id,int revision,long seq,boolean overview){ContentValues v=new ContentValues();v.put("trip_id",id);v.put("revision",revision);v.put("seq",seq);v.put("last_mutation_seq",seq);v.put("start_time_ms",d.optLong("start_time_ms"));v.put("end_time_ms",d.optLong("end_time_ms"));v.put("status",d.optString("status","completed"));v.put("vehicle_id",d.optString("vehicle_id",null));v.put("point_count",d.optInt("point_count"));v.put("distance",d.optDouble("distance"));v.put("duration",d.optDouble("duration"));putNullable(v,"score",d.opt("score"));putNullable(v,"score_safety",d.opt("score_safety"));putNullable(v,"score_smoothness",d.opt("score_smoothness"));v.put("score_status",d.optString("score_status",null));v.put("needs_rescore",d.optBoolean("needs_rescore")?1:0);v.put("payload_available",1);v.put("overview_available",overview?1:0);return v;}
    private void updateAggregates(SQLiteDatabase db,JSONObject prior,JSONObject current,long seq)throws Exception{if(prior!=null)applyAggregate(db,prior,-1,seq);applyAggregate(db,current,1,seq);}
    private void applyAggregate(SQLiteDatabase db,JSONObject d,int sign,long seq)throws Exception{double distance=finite(d.optDouble("distance",0)),duration=finite(d.optDouble("duration",0)),score=d.has("score")&&!d.isNull("score")?finite(d.optDouble("score",0)):0;int sc=d.has("score")&&!d.isNull("score")?1:0;db.execSQL("UPDATE trip_aggregate_totals SET live_count=live_count+?,total_distance=total_distance+?,total_duration=total_duration+?,score_sum=score_sum+?,score_count=score_count+?,through_seq=? WHERE id=1",new Object[]{sign,sign*distance,sign*duration,sign*score,sign*sc,seq});long day=(d.optLong("start_time_ms")/86400000L)*86400000L;String vehicle=d.optString("vehicle_id",""),status=d.optString("status","");db.execSQL("INSERT INTO trip_aggregate_buckets(day_start_ms,vehicle_id,status,trip_count,total_distance,total_duration,score_sum,score_count,through_seq) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(day_start_ms,vehicle_id,status) DO UPDATE SET trip_count=trip_count+excluded.trip_count,total_distance=total_distance+excluded.total_distance,total_duration=total_duration+excluded.total_duration,score_sum=score_sum+excluded.score_sum,score_count=score_count+excluded.score_count,through_seq=excluded.through_seq",new Object[]{day,vehicle,status,sign,sign*distance,sign*duration,sign*score,sign*sc,seq});}
    private JSONObject displayMetadata(JSONObject trip){JSONObject d=new JSONObject();try{JSONArray route=trip.optJSONArray("route_points");d.put("id",trip.optString("id",""));d.put("start_time_ms",timeMs(trip.opt("start_time")));d.put("end_time_ms",timeMs(trip.opt("end_time")));d.put("status",trip.optString("status","completed"));d.put("vehicle_id",trip.optString("vehicle_id",trip.optString("vehicleId","")));d.put("point_count",route==null?trip.optInt("point_count",0):route.length());d.put("distance",trip.optDouble("distance",trip.optDouble("distance_km",0)));d.put("duration",trip.optDouble("duration",trip.optDouble("duration_seconds",0)));copyNullable(trip,d,"score_overall","score");copyNullable(trip,d,"score_safety","score_safety");copyNullable(trip,d,"score_smoothness","score_smoothness");d.put("score_status",trip.optString("score_status",""));d.put("needs_rescore",trip.optBoolean("needs_rescore",false));java.util.Iterator<String>keys=trip.keys();while(keys.hasNext()){String key=keys.next();if(isPayloadOnlyField(key)||d.has(key))continue;Object value=trip.opt(key);if(value==null||value==JSONObject.NULL||value instanceof Number||value instanceof Boolean){d.put(key,value);continue;}String encoded=value instanceof String?(String)value:value.toString();if(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=8192)d.put(key,value);if(d.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>96*1024){d.remove(key);break;}}}catch(Exception error){throw new IllegalArgumentException("Invalid trip metadata",error);}return d;}
    private JSONObject normalizeRetentionMetadata(JSONObject captured,String expectedId)throws Exception{JSONObject d=new JSONObject();String id=requireId(captured.optString("id",expectedId));if(!expectedId.equals(id))throw new SecurityException("RETENTION_TRIP_ID_CHANGED");for(java.util.Iterator<String>it=captured.keys();it.hasNext();){String key=it.next();Object value=captured.opt(key);if(value==null||value==JSONObject.NULL||value instanceof Number||value instanceof Boolean||value instanceof String)d.put(key,value);}d.put("id",id);d.put("start_time_ms",captured.has("start_time_ms")?captured.optLong("start_time_ms"):timeMs(captured.opt("start_time")));d.put("end_time_ms",captured.has("end_time_ms")?captured.optLong("end_time_ms"):timeMs(captured.opt("end_time")));d.put("status",captured.optString("status","completed"));d.put("vehicle_id",captured.optString("vehicle_id",captured.optString("vehicleId","")));d.put("point_count",captured.optInt("point_count",0));d.put("distance",finite(captured.has("distance")?captured.optDouble("distance",0):captured.optDouble("distance_km",0)));d.put("duration",finite(captured.has("duration")?captured.optDouble("duration",0):captured.optDouble("duration_seconds",0)));if(captured.has("score_overall"))d.put("score",captured.opt("score_overall"));if(!d.has("score"))d.put("score",JSONObject.NULL);if(!d.has("score_safety"))d.put("score_safety",JSONObject.NULL);if(!d.has("score_smoothness"))d.put("score_smoothness",JSONObject.NULL);d.put("score_status",captured.optString("score_status",""));d.put("needs_rescore",captured.optBoolean("needs_rescore",false));return d;}
    private static double finite(double value){return Double.isFinite(value)?value:0D;}
    private static boolean isPayloadOnlyField(String key){String k=key==null?"":key.toLowerCase(java.util.Locale.ROOT);return k.equals("route_points")||k.equals("driving_events")||k.contains("sensor_samples")||k.contains("obd_samples")||k.contains("raw_gps")||k.contains("route_geometry")||k.contains("accelerometer_samples")||k.contains("gyroscope_samples");}
    private void enrichDisplayMetadata(JSONObject item,boolean detail)throws Exception{String id=item.getString("id");int revision=item.getInt("revision");JSONObject display=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,r.display_metadata_ciphertext,m.archive_generation FROM trip_revisions r JOIN archive_meta m ON m.id=1 WHERE r.trip_id=? AND r.revision=?",new String[]{id,Integer.toString(revision)})){if(!c.moveToFirst()||c.isNull(4))return null;byte[]hash=c.getBlob(0);int kek=c.getInt(3);byte[]dek=DriveSenseEnvelopeCrypto.unwrapDek(c.getBlob(1),c.getBlob(2),kek,DriveSenseEnvelopeCrypto.wrapAad(c.getString(5),"trip_payload",id,revision,hash,kek));try{return new JSONObject(new String(decryptSmall(c.getBlob(4),dek,DriveSenseEnvelopeCrypto.chunkAad(c.getString(5),"trip_metadata",1,id,revision,0,1,displayPlaintextLength(c.getBlob(4)),hash)),java.nio.charset.StandardCharsets.UTF_8));}finally{Arrays.fill(dek,(byte)0);}}});if(display==null)return;if(detail){java.util.Iterator<String>keys=display.keys();while(keys.hasNext()){String key=keys.next();if(!isPayloadOnlyField(key))item.put(key,display.opt(key));}}else for(String key:PAGE_PROJECTION_FIELDS)if(display.has(key))item.put(key,display.opt(key));}
    /**
     * The fields a bounded page row carries out of the already-decrypted
     * display-metadata blob (P7-IMPL-F05).
     *
     * The page path used to copy four of them. Q10 runs the same registered
     * reducers over a native page as over a browser page, and without
     * driver_metric_eligible every P-DRIVER population is empty, so every
     * report figure came back as a confident zero. These fields cost nothing
     * extra: the blob is already decrypted for this row before this runs.
     *
     * src/lib/queryContracts/nativeProjection.js is the single owner of this
     * set; p7NativeWireContract.test.js fails if the two lists diverge.
     */
    static final String[] PAGE_PROJECTION_FIELDS={"avg_running_speed_kmh","avg_speed_kmh","braking_efficiency_score","city_crawl_ratio","co2_saved_kg","cornering_consistency_score","distance_km","distraction_events_count","driver_metric_eligible","duration_seconds","emergency_heavy_braking_count","harsh_brakes_count","heading_deviation_count","high_speed_ratio","is_favorite","nickname","night_driving","optimal_band_ratio","overall_compliance_score","phone_use_high_confidence_count","phone_use_score_available","privacy_mode","rapid_accel_count","road_type","route_data_expired_at","route_key","route_points_map_count","route_replay_available","score_confidence","score_version","severe_event_count","sharp_turns_count","speeding_events_count","start_source","stop_start_pattern_count","svi_score","tag","tag_sources","tags","tailgate_cycle_count","trip_utc_offset_minutes","wet_signal_count"};

    /**
     * A read-only column-shifted view, so `metadataFromCursor` can read the
     * same 17 trip columns when they start at an offset (Q7 prepends the two
     * identity columns it captured in the same statement).
     */
    private static final class OffsetCursor extends android.database.CursorWrapper {
        private final int offset;
        OffsetCursor(Cursor cursor,int offset){super(cursor);this.offset=offset;}
        @Override public String getString(int index){return super.getString(index+offset);}
        @Override public int getInt(int index){return super.getInt(index+offset);}
        @Override public long getLong(int index){return super.getLong(index+offset);}
        @Override public double getDouble(int index){return super.getDouble(index+offset);}
        @Override public boolean isNull(int index){return super.isNull(index+offset);}
    }

    private JSONObject metadataFromCursor(Cursor c)throws Exception{JSONObject o=new JSONObject();o.put("id",c.getString(0));o.put("revision",c.getInt(1));o.put("canonical_seq",c.getLong(2));o.put("start_time_ms",c.getLong(3));o.put("start_time",Instant.ofEpochMilli(c.getLong(3)).toString());o.put("end_time_ms",c.getLong(4));o.put("end_time",Instant.ofEpochMilli(c.getLong(4)).toString());o.put("status",c.getString(5));o.put("vehicle_id",c.getString(6));o.put("point_count",c.getInt(7));o.put("distance",c.getDouble(8));o.put("duration",c.getDouble(9));if(!c.isNull(10))o.put("score_overall",c.getDouble(10));if(!c.isNull(11))o.put("score_safety",c.getDouble(11));if(!c.isNull(12))o.put("score_smoothness",c.getDouble(12));o.put("score_status",c.getString(13));o.put("needs_rescore",c.getInt(14)!=0);o.put("payload_available",c.getInt(15)!=0);o.put("overview_available",c.getInt(16)!=0);return o;}
    private JSONObject aggregateObject(Cursor c)throws Exception{JSONObject o=new JSONObject();o.put("liveCount",c.getLong(0));o.put("totalDistance",c.getDouble(1));o.put("totalDuration",c.getDouble(2));o.put("scoreSum",c.getDouble(3));o.put("scoreCount",c.getLong(4));o.put("scoreAverage",c.getLong(4)>0?c.getDouble(3)/c.getLong(4):JSONObject.NULL);o.put("throughSeq",c.isNull(5)?0:c.getLong(5));return o;}
    private String archiveGeneration()throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("archive_meta missing");return c.getString(0);}});}
    private int nextRevision(String id)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT COALESCE(MAX(revision),0)+1 FROM trip_revisions WHERE trip_id=?",new String[]{id})){c.moveToFirst();return c.getInt(0);}});}
    private JSONObject findCommittedByHash(String id,byte[]hash)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT r.revision,r.seq,m.archive_generation FROM trip_revisions r JOIN trip_current t ON t.trip_id=r.trip_id AND t.revision=r.revision JOIN archive_meta m ON m.id=1 WHERE r.trip_id=? AND r.commit_state='COMMITTED' AND hex(r.payload_hash)=?",new String[]{id,DriveSenseEnvelopeCrypto.hex(hash).toUpperCase(java.util.Locale.ROOT)})){if(!c.moveToFirst())return null;JSONObject out=new JSONObject();out.put("tripId",id);out.put("revision",c.getInt(0));out.put("seq",c.getLong(1));out.put("archiveGeneration",c.getString(2));out.put("payloadHash",DriveSenseEnvelopeCrypto.hex(hash));out.put("verified",true);out.put("idempotent",true);return out;}});}
    /**
     * The archive's source identity - generation and committed sequence - read
     * together in one statement so the two cannot disagree with each other.
     */
    private JSONObject sourceIdentity()throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT archive_generation,last_committed_seq FROM archive_meta WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("archive_meta missing");JSONObject o=new JSONObject();o.put("generation",c.getString(0));o.put("seq",c.getLong(1));return o;}});}

    /**
     * Test-only seam, run once after Q1 has selected its page rows and released
     * that read, and before any part of the answer is published.
     *
     * It exists so the interleaving regression can commit at exactly the
     * dangerous moment without sleeps or thread races. It is null in production.
     */
    private static volatile Runnable pageAssemblySeam;
    static void setPageAssemblySeamForTests(Runnable seam){pageAssemblySeam=seam;}
    private static void runPageAssemblySeam(){Runnable seam=pageAssemblySeam;if(seam!=null){pageAssemblySeam=null;seam.run();}}

    private long metaLong(String column)throws Exception{return coordinator.read(db->DriveSenseArchiveIntegrity.readMetaLong(db,column));}
    private void requireHealthyMutation()throws Exception{JSONObject health=DriveSenseArchiveHealth.inventory(coordinator);if(!"HEALTHY".equals(health.optString("recoveryState"))||!health.optBoolean("sentinelMatches",false))throw new IllegalStateException("RECOVERY_REQUIRED: canonical mutation blocked");}
    private void admission(long required){long available=DriveSenseStorageAdmission.availableBytes(coordinator.context());if(available-required<SPACE_RESERVE_BYTES){DriveSenseDurabilityJournal.record(coordinator.context(),"ERROR","FREE_SPACE_REFUSAL",null,required,available,0,"LOW_SPACE_BLOCKED");throw new IllegalStateException("LOW_SPACE_BLOCKED required="+required+" available="+available);}}
    static void requireAdmissionForPhysicalHarness(Context context,long required){long available=DriveSenseStorageAdmission.availableBytes(context);if(required<0L||available-required<SPACE_RESERVE_BYTES){DriveSenseDurabilityJournal.record(context,"ERROR","FREE_SPACE_REFUSAL",null,required,available,0,"LOW_SPACE_BLOCKED");throw new IllegalStateException("LOW_SPACE_BLOCKED required="+required+" available="+available);}}
    private byte[] encryptSmall(byte[]plain,byte[]dek,byte[]aad)throws Exception{byte[]nonce=DriveSenseEnvelopeCrypto.newNonce(),cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,nonce,aad).ciphertext;java.nio.ByteBuffer b=java.nio.ByteBuffer.allocate(4+nonce.length+cipher.length);b.putInt(nonce.length).put(nonce).put(cipher);return b.array();}
    private byte[] decryptSmall(byte[]encoded,byte[]dek,byte[]aad)throws Exception{java.nio.ByteBuffer b=java.nio.ByteBuffer.wrap(encoded);int length=b.getInt();if(length!=12||b.remaining()<=length)throw new SecurityException("Invalid encrypted metadata");byte[]nonce=new byte[length];b.get(nonce);byte[]cipher=new byte[b.remaining()];b.get(cipher);return DriveSenseEnvelopeCrypto.decrypt(cipher,dek,nonce,aad);}
    private int displayPlaintextLength(byte[]encoded){return encoded.length-4-12-16;}
    private long sumCipher(List<DriveSenseTripChunkStore.ChunkPlan> plans){long total=0;for(DriveSenseTripChunkStore.ChunkPlan p:plans)total+=p.ciphertextBytes;return total;}
    private static byte[] sha256File(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(FileInputStream input=new FileInputStream(file)){byte[]buffer=new byte[DriveSenseTripChunkStore.CHUNK_BYTES];int count;while((count=input.read(buffer))!=-1)digest.update(buffer,0,count);Arrays.fill(buffer,(byte)0);}return digest.digest();}
    private static byte[] decodeHex(String value){String text=value==null?"":value.trim();if(!text.matches("[0-9a-fA-F]{64}"))throw new IllegalArgumentException("Invalid SHA-256");byte[]out=new byte[32];for(int index=0;index<out.length;index++)out[index]=(byte)Integer.parseInt(text.substring(index*2,index*2+2),16);return out;}
    private static long timeMs(Object value){if(value instanceof Number)return ((Number)value).longValue();String text=value==null?"":String.valueOf(value);if(text.isEmpty())return 0;try{return Instant.parse(text).toEpochMilli();}catch(DateTimeParseException ignored){try{return Long.parseLong(text);}catch(Exception e){return 0;}}}
    private static String requireId(String id){String value=id==null?"":id.trim();if(value.isEmpty()||value.length()>128||!value.matches("[A-Za-z0-9._:-]+"))throw new IllegalArgumentException("Invalid trip id");return value;}
    private static String safeFilter(String value){String v=value==null?"":value.trim();if(v.length()>128)throw new IllegalArgumentException("Filter too long");return v;}
    private static int boundedInt(int value,int min,int max,String name){if(value<min||value>max)throw new IllegalArgumentException(name+" out of range");return value;}
    private static String[] append(List<String> values,String tail){List<String> all=new ArrayList<>(values);all.add(tail);return all.toArray(new String[0]);}
    private static void copyNullable(JSONObject from,JSONObject to,String source,String target)throws Exception{if(from.has(source)&&!from.isNull(source))to.put(target,from.opt(source));else to.put(target,JSONObject.NULL);}
    private static void putNullable(ContentValues values,String key,Object value){if(value==null||value==JSONObject.NULL)values.putNull(key);else values.put(key,((Number)value).doubleValue());}
    private static String safeError(Exception error){
        if(error!=null){String message=error.getMessage();if(message!=null&&message.matches("[A-Z][A-Z0-9_]{2,63}"))return message;}
        String name=error==null?"UNKNOWN":error.getClass().getSimpleName();return name.length()>64?name.substring(0,64):name;
    }
    static void setFaultPointForTests(String point){testFaultPoint=point;}
    private static void injectFault(String point){if(point.equals(testFaultPoint)){testFaultPoint=null;throw new IllegalStateException("TEST_FAULT_"+point);}}

    static final class PayloadDescriptor implements AutoCloseable {final String tripId,generation;final int revision,chunkCount;final long plaintextBytes;final byte[]payloadHash,dek;PayloadDescriptor(String i,int r,int c,long p,byte[]h,String g,byte[]d){tripId=i;revision=r;chunkCount=c;plaintextBytes=p;payloadHash=h;generation=g;dek=d;}public void close(){Arrays.fill(dek,(byte)0);}}
    private static final class RetentionPlanState{final String tripId,operation;final int revision,count,next;RetentionPlanState(String i,int r,String o,int c,int n){tripId=i;revision=r;operation=o;count=c;next=n;}}
    private static final class RetentionPublish {final String tripId,operation;final int revision,count,kekVersion;final byte[]wrapped,wrapNonce;final DriveSenseTripChunkStore.ChunkPlan plan;RetentionPublish(String i,int r,String o,int c,byte[]w,byte[]n,int k,DriveSenseTripChunkStore.ChunkPlan p){tripId=i;revision=r;operation=o;count=c;wrapped=w;wrapNonce=n;kekVersion=k;plan=p;}}
    private static final class RetentionFinalize {final String tripId,operation;final int sourceRevision,revision,count,kekVersion,publishedCount;final long ciphertextBytes;final byte[]sourceHash,payloadHash,wrapped,wrapNonce;final JSONObject metadata;RetentionFinalize(String i,int s,byte[]h,int r,String o,int c,JSONObject m,byte[]p,byte[]w,byte[]n,int k,int pc,long cb){tripId=i;sourceRevision=s;sourceHash=h;revision=r;operation=o;count=c;metadata=m;payloadHash=p;wrapped=w;wrapNonce=n;kekVersion=k;publishedCount=pc;ciphertextBytes=cb;}}
}
