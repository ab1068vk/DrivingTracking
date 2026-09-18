package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/** Restartable bounded native raw-GPS/motion retention state machine. */
final class DriveSenseRawGpsRetention {
    static final int MAX_EXAMINED=16;static final long MAX_WORK_BYTES=3L*1024L*1024L;
    private final DriveSenseTripArchiveRepository repository;private final DriveSenseRetentionStage stage;
    DriveSenseRawGpsRetention(DriveSenseTripArchiveRepository r){repository=r;stage=new DriveSenseRetentionStage(r.coordinator().context());}

    JSONObject step(int rawDays,int motionDays,long now,boolean explicit)throws Exception{
        if(rawDays<0||motionDays<0)throw new IllegalArgumentException("Retention days must be non-negative");
        JSONObject health=DriveSenseArchiveHealth.inventory(repository.coordinator());
        if(!"NATIVE".equals(health.optString("authorityState"))||!"HEALTHY".equals(health.optString("recoveryState"))||!health.optBoolean("sentinelMatches",false))return result("OWNERLESS_OR_BLOCKED",0,0,0,false,null);
        DriveSenseRetentionDue.Policy policy=DriveSenseRetentionDue.configure(repository.coordinator(),rawDays,motionDays,now);
        Job obsolete=loadObsolete();if(obsolete!=null)return cleanupObsolete(obsolete);
        if(!"VERIFIED".equals(policy.state))return DriveSenseRetentionDue.backfillTurn(repository.coordinator(),policy);
        Job job=loadRunnable(policy);
        if(job==null){if(rawDays==0&&motionDays==0)return result("DISABLED",0,0,0,false,null);Candidate candidate=select(policy,now);if(candidate==null)return result("COMPLETE",0,0,0,false,null);job=create(candidate,policy,rawDays,motionDays,now);return result("SELECTED",1,0,128,true,job.id);}
        if("TRANSFORM".equals(job.phase))return transform(job);
        if("PREPARE_PUBLISH".equals(job.phase))return prepare(job);
        if("PLAN_PUBLISH_CHUNKS".equals(job.phase))return repository.planRetentionPublicationChunks(job.id);
        if("PUBLISH_CHUNKS".equals(job.phase))return publish(job);
        if("P6_FREEZE".equals(job.phase))return freezeRequired(job);
        if("CLEANUP_STAGE".equals(job.phase))return cleanupStage(job);
        if("RETIRE_SOURCE".equals(job.phase))return retireSource(job);
        throw new IllegalStateException("RETENTION_JOB_PHASE_INVALID");
    }

    private Job create(Candidate selected,DriveSenseRetentionDue.Policy policy,int rawDays,int motionDays,long now)throws Exception{
        boolean rawDue=selected.rawDue!=null&&selected.rawDue<=now,motionDue=selected.motionDue!=null&&selected.motionDue<=now;if(!rawDue&&!motionDue)throw new IllegalStateException("RETENTION_DUE_INDEX_DIVERGENCE");
        String jobId=UUID.randomUUID().toString();byte[]dek=DriveSenseEnvelopeCrypto.newDek();int keyVersion=DriveSenseEnvelopeCrypto.activeKekVersion(repository.coordinator());DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(dek,keyVersion,DriveSenseEnvelopeCrypto.wrapAad(policy.generation,"retention_stage",jobId,selected.revision,selected.hash,keyVersion));DriveSenseRetentionTokenizer tokenizer=new DriveSenseRetentionTokenizer(rawDue,rawDays,motionDue,motionDays,now);DriveSenseSha256State sha=new DriveSenseSha256State();
        try{repository.coordinator().write(db->{db.beginTransaction();try{try(Cursor current=db.rawQuery("SELECT r.payload_hash,c.status FROM trip_revisions r JOIN trip_current c ON c.trip_id=r.trip_id AND c.revision=r.revision WHERE r.trip_id=? AND r.revision=?",new String[]{selected.id,Integer.toString(selected.revision)})){if(!current.moveToFirst()||!Arrays.equals(current.getBlob(0),selected.hash)||!"completed".equals(current.getString(1)))throw new IllegalStateException("RETENTION_SOURCE_CHANGED");}ContentValues row=new ContentValues();row.put("job_id",jobId);row.put("archive_generation",policy.generation);row.put("erasure_token",policy.generation);row.put("policy_version",policy.identity);row.put("state","ACTIVE");row.put("phase","TRANSFORM");row.put("source_trip_id",selected.id);row.put("source_revision",selected.revision);row.put("source_payload_hash",selected.hash);row.put("operation_id",jobId);row.put("tokenizer_state",tokenizer.save());row.put("output_sha_state",sha.chainingState());row.put("output_sha_count",0);row.put("output_sha_partial",new byte[0]);row.put("stage_wrapped_dek",wrapped.ciphertext);row.put("stage_wrap_nonce",wrapped.nonce);row.put("stage_kek_version",keyVersion);row.put("raw_due",rawDue?1:0);row.put("motion_due",motionDue?1:0);row.put("retention_days",rawDays);row.put("motion_days",motionDays);row.put("retention_now_ms",now);row.put("created_at_ms",now);row.put("updated_at_ms",now);db.insertOrThrow("trip_retention_jobs",null,row);db.execSQL("INSERT INTO encrypted_file_key_registry(domain_id,entry_id,key_version,state,updated_at_ms) VALUES('retention_stage',?,?,'VERIFIED',?)",new Object[]{jobId,keyVersion,System.currentTimeMillis()});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}finally{Arrays.fill(dek,(byte)0);}return load(jobId);
    }

    private JSONObject transform(Job job)throws Exception{
        byte[]stageDek=repository.retentionStageDek(job.id,job.generation),source=null;List<byte[]>outputs=new ArrayList<>();
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=repository.descriptor(job.tripId,job.sourceRevision)){
            if(descriptor==null||!job.generation.equals(descriptor.generation)||!Arrays.equals(descriptor.payloadHash,job.sourceHash))throw new IllegalStateException("RETENTION_SOURCE_CHANGED");if(job.sourceChunk>=descriptor.chunkCount)throw new IllegalStateException("RETENTION_SOURCE_CURSOR_INVALID");source=repository.readPayloadChunk(descriptor,job.sourceChunk);boolean eof=job.sourceChunk+1==descriptor.chunkCount;DriveSenseRetentionTokenizer tokenizer=DriveSenseRetentionTokenizer.restore(job.tokenizerState);byte[]emitted=tokenizer.process(source,eof);for(int offset=0;offset<emitted.length;offset+=DriveSenseRetentionStage.CHUNK_BYTES)outputs.add(Arrays.copyOfRange(emitted,offset,Math.min(emitted.length,offset+DriveSenseRetentionStage.CHUNK_BYTES)));DriveSenseSha256State sha=DriveSenseSha256State.restore(job.shaState,job.shaCount,job.shaPartial);sha.update(emitted);int next=job.stageNext;long encoded=0;for(byte[]chunk:outputs){stage.write(job.generation,job.id,next,chunk,chunk.length,stageDek);encoded+=stage.encodedBytes(job.generation,job.id,next);next++;}
            final int finalNext=next;final long finalEncoded=encoded;final byte[]savedTokenizer=tokenizer.save(),savedState=sha.chainingState(),savedPartial=sha.partialBlock();final long savedCount=sha.byteCount();final boolean done=eof;final JSONObject metadata=done?tokenizer.catalogMetadata():null;final long purgedPoints=tokenizer.routeCount(),purgedMotion=tokenizer.motionCount();final int sourceBytes=source.length,emittedBytes=emitted.length;
                repository.coordinator().write(db->{db.beginTransaction();try{Job current=load(db,job.id);if(current.sourceChunk!=job.sourceChunk||current.stageNext!=job.stageNext)throw new IllegalStateException("RETENTION_CURSOR_CONFLICT");int index=job.stageNext;for(byte[]chunk:outputs){db.execSQL("INSERT OR REPLACE INTO retention_stage_chunks(job_id,chunk_index,plaintext_bytes,encoded_bytes) VALUES(?,?,?,?)",new Object[]{job.id,index,chunk.length,stage.encodedBytes(job.generation,job.id,index)});index++;}ContentValues values=new ContentValues();values.put("source_chunk_index",job.sourceChunk+1);values.put("stage_next_index",finalNext);values.put("stage_chunk_count",finalNext);values.put("stage_plaintext_bytes",savedCount);values.put("tokenizer_state",savedTokenizer);values.put("output_sha_state",savedState);values.put("output_sha_count",savedCount);values.put("output_sha_partial",savedPartial);values.put("bytes_worked",job.bytesWorked+sourceBytes+emittedBytes+finalEncoded);values.put("updated_at_ms",System.currentTimeMillis());if(done){values.put("phase","PREPARE_PUBLISH");values.put("catalog_metadata",metadata.toString());values.put("purged_point_count",purgedPoints);values.put("purged_motion_count",purgedMotion);}db.update("trip_retention_jobs",values,"job_id=?",new String[]{job.id});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});long bytes=source.length+emitted.length+encoded;Arrays.fill(emitted,(byte)0);return result(done?"TRANSFORM_COMPLETE":"TRANSFORM",1,0,bytes,true,job.id);
        }finally{Arrays.fill(stageDek,(byte)0);if(source!=null)Arrays.fill(source,(byte)0);for(byte[]value:outputs)Arrays.fill(value,(byte)0);}
    }

    private JSONObject prepare(Job job)throws Exception{byte[]hash=DriveSenseSha256State.restore(job.shaState,job.shaCount,job.shaPartial).digest();repository.prepareRetentionPublication(job.id,job.tripId,job.sourceRevision,job.sourceHash,job.policy,job.generation,job.shaCount,hash,new JSONObject(job.catalogMetadata),job.stageCount);return result("PUBLISH_PREPARED",1,0,256,true,job.id);}

    private JSONObject publish(Job job)throws Exception{byte[]hash=DriveSenseSha256State.restore(job.shaState,job.shaCount,job.shaPartial).digest();if(job.publishIndex<job.stageCount){long bytes=repository.publishRetentionChunk(job.id,job.generation,hash,stage,job.publishIndex);return result("PUBLISH_CHUNK",1,0,bytes,true,job.id);}if(!"COMPLETE".equals(job.p6FreezeState)){repository.coordinator().write(db->{db.execSQL("UPDATE trip_retention_jobs SET phase='P6_FREEZE',updated_at_ms=? WHERE job_id=?",new Object[]{System.currentTimeMillis(),job.id});return null;});return freezeRequired(load(job.id));}repository.finalizeRetentionPublication(job.id,job.policy,job.generation,job.rawDue,job.purgedPoints,job.purgedMotion);satisfy(job);JSONObject out=result("PUBLISHED",1,1,512,true,job.id);out.put("unlinkDebtAdded",false);return out;}

    private JSONObject freezeRequired(Job job)throws Exception{JSONObject out=result("P6_FREEZE_REQUIRED",1,0,128,true,job.id);out.put("tripId",job.tripId);out.put("sourceRevision",job.sourceRevision);out.put("sourceAuthority","native");out.put("freezeCursor",job.p6FreezeCursor==null?JSONObject.NULL:job.p6FreezeCursor);return out;}

    JSONObject acknowledgeP6Freeze(String jobId,String nextCursor,boolean complete)throws Exception{
        repository.coordinator().write(db->{ContentValues values=new ContentValues();values.put("p6_freeze_state",complete?"COMPLETE":"PARTIAL");if(nextCursor==null||nextCursor.isEmpty())values.putNull("p6_freeze_cursor");else values.put("p6_freeze_cursor",nextCursor);if(complete)values.put("phase","PUBLISH_CHUNKS");values.put("updated_at_ms",System.currentTimeMillis());if(db.update("trip_retention_jobs",values,"job_id=? AND phase='P6_FREEZE'",new String[]{jobId})!=1)throw new IllegalStateException("RETENTION_P6_FREEZE_STALE");return null;});return result(complete?"P6_FREEZE_COMPLETE":"P6_FREEZE_PARTIAL",1,1,128,true,jobId);
    }

    private JSONObject cleanupStage(Job job)throws Exception{
        if(job.stageCleanup<job.stageCount){long bytes=stage.encodedBytes(job.generation,job.id,job.stageCleanup);if(!stage.deleteOne(job.generation,job.id,job.stageCleanup))throw new IllegalStateException("RETENTION_STAGE_DELETE_FAILED");repository.coordinator().write(db->{db.beginTransaction();try{db.delete("retention_stage_chunks","job_id=? AND chunk_index=?",new String[]{job.id,Integer.toString(job.stageCleanup)});db.execSQL("UPDATE trip_retention_jobs SET stage_cleanup_index=?,updated_at_ms=? WHERE job_id=?",new Object[]{job.stageCleanup+1,System.currentTimeMillis(),job.id});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});return result("STAGE_CLEANUP",1,1,bytes,true,job.id);}
        boolean verified=DriveSenseKeyReferenceCounts.beginFileMutation(repository.coordinator().context());DriveSenseKeyReferenceCounts.removeFileReference(repository.coordinator().context(),"retention_stage",job.id,verified);
        repository.coordinator().write(db->{ContentValues values=new ContentValues();values.put("phase","RETIRE_SOURCE");values.putNull("stage_wrapped_dek");values.putNull("stage_wrap_nonce");values.putNull("tokenizer_state");values.putNull("output_sha_state");values.putNull("output_sha_partial");values.put("updated_at_ms",System.currentTimeMillis());db.update("trip_retention_jobs",values,"job_id=?",new String[]{job.id});return null;});return result("STAGE_CLEANUP_COMPLETE",1,1,128,true,job.id);
    }

    private JSONObject retireSource(Job job)throws Exception{
        RetireTurn turn=repository.coordinator().write(db->{db.beginTransaction();try{
            int sourceKek=0;long sourceSeq=0,retiredSeq=0;byte[]wrapped=null;String overviewPath=null;long overviewBytes=0;
            try(Cursor source=db.rawQuery("SELECT seq,retired_seq,commit_state,kek_version,wrapped_dek,overview_path,overview_plaintext_bytes FROM trip_revisions WHERE trip_id=? AND revision=?",new String[]{job.tripId,Integer.toString(job.sourceRevision)})){if(!source.moveToFirst()){db.execSQL("UPDATE trip_retention_jobs SET source_retirement_state='RETIRED',phase='DONE',state='COMPLETE',updated_at_ms=? WHERE job_id=?",new Object[]{System.currentTimeMillis(),job.id});db.setTransactionSuccessful();return new RetireTurn("COMPLETE",1,0,0,false);}sourceSeq=source.getLong(0);retiredSeq=source.isNull(1)?Long.MAX_VALUE:source.getLong(1);if(!"SUPERSEDED".equals(source.getString(2)))throw new IllegalStateException("RETENTION_SOURCE_NOT_SUPERSEDED");sourceKek=source.getInt(3);wrapped=source.getBlob(4);overviewPath=source.isNull(5)?null:source.getString(5);overviewBytes=source.getLong(6);}
            try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' AND archive_generation=? AND through_seq>=? AND through_seq<? LIMIT 1",new String[]{job.generation,Long.toString(sourceSeq),Long.toString(retiredSeq)})){if(lease.moveToFirst()){db.execSQL("UPDATE trip_retention_jobs SET source_retirement_state='LEASE_HELD',updated_at_ms=? WHERE job_id=?",new Object[]{System.currentTimeMillis(),job.id});db.setTransactionSuccessful();return new RetireTurn("BLOCKED_EXPORT_LEASE",0,0,0,true);}}
            List<RetireChunk> chunks=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT chunk_index,relative_path,ciphertext_bytes FROM trip_chunks WHERE trip_id=? AND revision=? AND chunk_index>? ORDER BY chunk_index LIMIT 16",new String[]{job.tripId,Integer.toString(job.sourceRevision),Integer.toString(job.sourceRetireCursor)})){while(c.moveToNext())chunks.add(new RetireChunk(c.getInt(0),c.getString(1),c.getLong(2)));}
            int examined=0,changed=0,last=job.sourceRetireCursor;long bytes=0;for(RetireChunk chunk:chunks){examined++;if(changed>0&&bytes+chunk.bytes>DriveSenseArchiveUnlinkDebt.MAX_UNLINK_BYTES)break;DriveSenseArchiveUnlinkDebt.record(db,chunk.path,chunk.bytes,"raw_gps_retention");db.delete("trip_chunks","trip_id=? AND revision=? AND chunk_index=?",new String[]{job.tripId,Integer.toString(job.sourceRevision),Integer.toString(chunk.index)});last=chunk.index;changed++;bytes+=chunk.bytes;}
            boolean more;try(Cursor c=db.rawQuery("SELECT 1 FROM trip_chunks WHERE trip_id=? AND revision=? LIMIT 1",new String[]{job.tripId,Integer.toString(job.sourceRevision)})){more=c.moveToFirst();}
            if(!more&&examined<16){if(overviewPath!=null){DriveSenseArchiveUnlinkDebt.record(db,overviewPath,overviewBytes,"raw_gps_retention_overview");changed++;bytes+=overviewBytes;}ContentValues shredded=new ContentValues();shredded.put("wrapped_dek",new byte[0]);shredded.put("wrap_nonce",new byte[0]);shredded.putNull("overview_path");shredded.putNull("overview_hash");shredded.putNull("overview_nonce");shredded.put("overview_plaintext_bytes",0);shredded.put("overview_point_count",0);db.update("trip_revisions",shredded,"trip_id=? AND revision=?",new String[]{job.tripId,Integer.toString(job.sourceRevision)});if(wrapped!=null&&wrapped.length>0)DriveSenseKeyReferenceCounts.adjust(db,"trip_archive",sourceKek,-1);db.execSQL("UPDATE trip_retention_jobs SET source_retirement_state='RETIRED',source_retire_cursor=?,phase='DONE',state='COMPLETE',updated_at_ms=? WHERE job_id=?",new Object[]{last,System.currentTimeMillis(),job.id});db.setTransactionSuccessful();return new RetireTurn("COMPLETE",examined+1,changed,bytes,false);}
            db.execSQL("UPDATE trip_retention_jobs SET source_retirement_state='READY',source_retire_cursor=?,updated_at_ms=? WHERE job_id=?",new Object[]{last,System.currentTimeMillis(),job.id});db.setTransactionSuccessful();return new RetireTurn("RETIRE_SOURCE",examined,changed,bytes,true);
        }finally{db.endTransaction();}});JSONObject out=result(turn.state,turn.examined,turn.changed,Math.min(MAX_WORK_BYTES,turn.bytes),turn.more,job.id);if(turn.changed>0)out.put("unlinkDebtAdded",true);return out;
    }

    private JSONObject cleanupObsolete(Job job)throws Exception{
        if(job.stageCleanup<job.stageCount){
            ObsoleteTurn turn=repository.coordinator().write(db->{db.beginTransaction();try{
                long bytes=0;int changed=0;
                try(Cursor c=db.rawQuery("SELECT encoded_bytes FROM retention_stage_chunks WHERE job_id=? AND chunk_index=?",new String[]{job.id,Integer.toString(job.stageCleanup)})){
                    if(c.moveToFirst()){
                        bytes=Math.max(0L,c.getLong(0));
                        DriveSenseArchiveUnlinkDebt.record(db,DriveSenseRetentionStage.debtPath(job.generation,job.id,job.stageCleanup),bytes,"obsolete_retention_stage");
                        db.delete("retention_stage_chunks","job_id=? AND chunk_index=?",new String[]{job.id,Integer.toString(job.stageCleanup)});changed=1;
                    }
                }
                db.execSQL("UPDATE trip_retention_jobs SET stage_cleanup_index=?,updated_at_ms=? WHERE job_id=? AND state='OBSOLETE'",new Object[]{job.stageCleanup+1,System.currentTimeMillis(),job.id});
                db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_STAGE_DEBT",1,changed,bytes,true,false);
            }finally{db.endTransaction();}});
            return obsoleteResult(turn,job.id);
        }

        boolean stageReference=repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM encrypted_file_key_registry WHERE domain_id='retention_stage' AND entry_id=? LIMIT 1",new String[]{job.id})){return c.moveToFirst();}});
        if(stageReference){boolean verified=DriveSenseKeyReferenceCounts.beginFileMutation(repository.coordinator().context());DriveSenseKeyReferenceCounts.removeFileReference(repository.coordinator().context(),"retention_stage",job.id,verified);return result("OBSOLETE_STAGE_KEY_RETIRED",1,1,128,true,job.id);}
        repository.coordinator().write(db->{ContentValues clear=new ContentValues();clear.putNull("stage_wrapped_dek");clear.putNull("stage_wrap_nonce");clear.putNull("tokenizer_state");clear.putNull("output_sha_state");clear.putNull("output_sha_partial");clear.put("updated_at_ms",System.currentTimeMillis());db.update("trip_retention_jobs",clear,"job_id=? AND state='OBSOLETE'",new String[]{job.id});return null;});

        ObsoleteTurn turn=repository.coordinator().write(db->{db.beginTransaction();try{
            Integer revision=null;String publishOperation=null;
            try(Cursor j=db.rawQuery("SELECT publish_revision,publish_operation_id FROM trip_retention_jobs WHERE job_id=? AND state='OBSOLETE'",new String[]{job.id})){
                if(!j.moveToFirst())throw new IllegalStateException("RETENTION_JOB_MISSING");
                if(!j.isNull(0))revision=j.getInt(0);publishOperation=j.isNull(1)?null:j.getString(1);
            }
            if(revision==null){finishObsolete(db,job.id);db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_COMPLETE",1,0,0,false,false);}
            String commitState=null,operation=publishOperation;int kekVersion=0;byte[]wrapped=null;
            try(Cursor r=db.rawQuery("SELECT commit_state,kek_version,wrapped_dek,operation_id FROM trip_revisions WHERE trip_id=? AND revision=?",new String[]{job.tripId,Integer.toString(revision)})){
                if(r.moveToFirst()){commitState=r.getString(0);kekVersion=r.getInt(1);wrapped=r.getBlob(2);if(!r.isNull(3))operation=r.getString(3);}
            }
            if(commitState==null){if(operation!=null)db.delete("open_operations","operation_id=?",new String[]{operation});finishObsolete(db,job.id);db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_COMPLETE",1,0,0,false,false);}
            if(!"PENDING".equals(commitState)){db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_COMMITTED",1,0,0,true,true);}

            List<RetireChunk> chunks=new ArrayList<>();
            try(Cursor paths=db.rawQuery("SELECT chunk_index,relative_path,ciphertext_bytes FROM trip_chunks WHERE trip_id=? AND revision=? ORDER BY chunk_index LIMIT 16",new String[]{job.tripId,Integer.toString(revision)})){
                while(paths.moveToNext())chunks.add(new RetireChunk(paths.getInt(0),paths.getString(1),Math.max(0L,paths.getLong(2))));
            }
            int examined=0,changed=0;long bytes=0;
            for(RetireChunk chunk:chunks){examined++;if(changed>0&&bytes+chunk.bytes>DriveSenseArchiveUnlinkDebt.MAX_UNLINK_BYTES)break;DriveSenseArchiveUnlinkDebt.record(db,chunk.path,chunk.bytes,"obsolete_retention_publish");db.delete("trip_chunks","trip_id=? AND revision=? AND chunk_index=?",new String[]{job.tripId,Integer.toString(revision),Integer.toString(chunk.index)});changed++;bytes+=chunk.bytes;}
            if(changed>0){db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_PUBLISH_DEBT",examined,changed,bytes,true,false);}

            if(wrapped!=null&&wrapped.length>0)DriveSenseKeyReferenceCounts.adjust(db,"trip_archive",kekVersion,-1);
            db.delete("trip_revisions","trip_id=? AND revision=? AND commit_state='PENDING'",new String[]{job.tripId,Integer.toString(revision)});
            if(operation!=null)db.delete("open_operations","operation_id=?",new String[]{operation});
            db.execSQL("UPDATE archive_meta SET pending_count=MAX(0,pending_count-1) WHERE id=1");
            finishObsolete(db,job.id);db.setTransactionSuccessful();return new ObsoleteTurn("OBSOLETE_COMPLETE",1,1,128,false,false);
        }finally{db.endTransaction();}});
        if(turn.retireCommitted)return retireSource(load(job.id));
        return obsoleteResult(turn,job.id);
    }

    private static void finishObsolete(android.database.sqlite.SQLiteDatabase db,String jobId){ContentValues done=new ContentValues();done.put("phase","DONE");done.put("state","OBSOLETE_COMPLETE");done.putNull("stage_wrapped_dek");done.putNull("stage_wrap_nonce");done.putNull("tokenizer_state");done.putNull("output_sha_state");done.putNull("output_sha_partial");done.put("updated_at_ms",System.currentTimeMillis());db.update("trip_retention_jobs",done,"job_id=?",new String[]{jobId});}
    private static JSONObject obsoleteResult(ObsoleteTurn turn,String job)throws Exception{return result(turn.state,turn.examined,turn.changed,Math.min(MAX_WORK_BYTES,turn.bytes),turn.more,job);}

    private void satisfy(Job job)throws Exception{repository.coordinator().write(db->{db.beginTransaction();try{try(Cursor current=db.rawQuery("SELECT revision FROM trip_current WHERE trip_id=?",new String[]{job.tripId})){if(!current.moveToFirst())throw new IllegalStateException("RETENTION_CURRENT_MISSING");int revision=current.getInt(0);try(Cursor c=db.rawQuery("SELECT raw_due_at_ms,motion_due_at_ms FROM trip_retention_due WHERE trip_id=? AND revision=? AND policy_version=? AND archive_generation=?",new String[]{job.tripId,Integer.toString(revision),job.policy,job.generation})){if(c.moveToFirst()){Long rawAt=job.rawDue?null:(c.isNull(0)?null:c.getLong(0));Long motionAt=job.motionDue?null:(c.isNull(1)?null:c.getLong(1));if(rawAt==null&&motionAt==null)db.delete("trip_retention_due","trip_id=?",new String[]{job.tripId});else{ContentValues update=new ContentValues();if(rawAt==null)update.putNull("raw_due_at_ms");else update.put("raw_due_at_ms",rawAt);if(motionAt==null)update.putNull("motion_due_at_ms");else update.put("motion_due_at_ms",motionAt);update.put("next_due_at_ms",rawAt==null?motionAt:(motionAt==null?rawAt:Math.min(rawAt,motionAt)));db.update("trip_retention_due",update,"trip_id=?",new String[]{job.tripId});}}}}db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}

    private Candidate select(DriveSenseRetentionDue.Policy p,long now)throws Exception{return repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT d.trip_id,d.revision,d.raw_due_at_ms,d.motion_due_at_ms,r.payload_hash,r.plaintext_bytes,c.point_count FROM trip_retention_due d JOIN trip_current c ON c.trip_id=d.trip_id AND c.revision=d.revision JOIN trip_revisions r ON r.trip_id=d.trip_id AND r.revision=d.revision WHERE d.state='DUE' AND d.policy_version=? AND d.archive_generation=? AND d.next_due_at_ms<=? AND c.status='completed' ORDER BY d.next_due_at_ms,d.trip_id LIMIT 1",new String[]{p.identity,p.generation,Long.toString(now)})){return c.moveToFirst()?new Candidate(c.getString(0),c.getInt(1),c.isNull(2)?null:c.getLong(2),c.isNull(3)?null:c.getLong(3),c.getBlob(4),c.getLong(5),c.getInt(6)):null;}});}
    private Job loadRunnable(DriveSenseRetentionDue.Policy p)throws Exception{return repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT job_id FROM trip_retention_jobs WHERE archive_generation=? AND policy_version=? AND state IN ('ACTIVE','COMMITTED') AND phase NOT IN ('BACKFILL','DONE') ORDER BY created_at_ms LIMIT 1",new String[]{p.generation,p.identity})){return c.moveToFirst()?load(db,c.getString(0)):null;}});}
    private Job loadObsolete()throws Exception{return repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT job_id FROM trip_retention_jobs WHERE state='OBSOLETE' ORDER BY created_at_ms LIMIT 1",null)){return c.moveToFirst()?load(db,c.getString(0)):null;}});}
    private Job load(String id)throws Exception{return repository.coordinator().read(db->load(db,id));}
    private static Job load(android.database.sqlite.SQLiteDatabase db,String id){try(Cursor c=db.rawQuery("SELECT job_id,archive_generation,policy_version,state,phase,source_trip_id,source_revision,source_payload_hash,source_chunk_index,stage_next_index,stage_chunk_count,tokenizer_state,output_sha_state,output_sha_count,output_sha_partial,raw_due,motion_due,retention_days,motion_days,retention_now_ms,publish_chunk_index,catalog_metadata,bytes_worked,purged_point_count,purged_motion_count,stage_cleanup_index,source_retire_cursor,source_retirement_state,p6_freeze_state,p6_freeze_cursor FROM trip_retention_jobs WHERE job_id=?",new String[]{id})){if(!c.moveToFirst())throw new IllegalStateException("RETENTION_JOB_MISSING");return new Job(c);}}
    private static JSONObject result(String state,int examined,int changed,long bytes,boolean more,String job)throws Exception{JSONObject out=new JSONObject();out.put("state",state);out.put("itemsWorked",examined);out.put("changedItems",changed);out.put("bytesWorked",bytes);out.put("hasMore",more);if(job!=null)out.put("jobId",job);return out;}
    private static final class Candidate{final String id;final int revision,pointCount;final Long rawDue,motionDue;final long plaintextBytes;final byte[]hash;Candidate(String i,int r,Long a,Long m,byte[]h,long p,int c){id=i;revision=r;rawDue=a;motionDue=m;hash=h;plaintextBytes=p;pointCount=c;}}
    private static final class Job{final String id,generation,policy,state,phase,tripId,catalogMetadata,sourceRetirementState,p6FreezeState,p6FreezeCursor;final int sourceRevision,sourceChunk,stageNext,stageCount,publishIndex,rawDays,motionDays,stageCleanup,sourceRetireCursor;final long shaCount,now,bytesWorked,purgedPoints,purgedMotion;final byte[]sourceHash,tokenizerState,shaState,shaPartial;final boolean rawDue,motionDue;Job(Cursor c){id=c.getString(0);generation=c.getString(1);policy=c.getString(2);state=c.getString(3);phase=c.getString(4);tripId=c.getString(5);sourceRevision=c.getInt(6);sourceHash=c.getBlob(7);sourceChunk=c.getInt(8);stageNext=c.getInt(9);stageCount=c.getInt(10);tokenizerState=c.getBlob(11);shaState=c.getBlob(12);shaCount=c.getLong(13);shaPartial=c.getBlob(14);rawDue=c.getInt(15)!=0;motionDue=c.getInt(16)!=0;rawDays=c.getInt(17);motionDays=c.getInt(18);now=c.getLong(19);publishIndex=c.getInt(20);catalogMetadata=c.isNull(21)?null:c.getString(21);bytesWorked=c.getLong(22);purgedPoints=c.getLong(23);purgedMotion=c.getLong(24);stageCleanup=c.getInt(25);sourceRetireCursor=c.getInt(26);sourceRetirementState=c.getString(27);p6FreezeState=c.getString(28);p6FreezeCursor=c.isNull(29)?null:c.getString(29);}}
    private static final class RetireChunk{final int index;final String path;final long bytes;RetireChunk(int i,String p,long b){index=i;path=p;bytes=b;}}
    private static final class RetireTurn{final String state;final int examined,changed;final long bytes;final boolean more;RetireTurn(String s,int e,int c,long b,boolean m){state=s;examined=e;changed=c;bytes=b;more=m;}}
    private static final class ObsoleteTurn{final String state;final int examined,changed;final long bytes;final boolean more,retireCommitted;ObsoleteTurn(String s,int e,int c,long b,boolean m,boolean r){state=s;examined=e;changed=c;bytes=b;more=m;retireCommitted=r;}}
}
