package com.drivesense.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.StatFs;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/** Prefix-4 canonical speed storage. No operation reads an unrelated bucket. */
final class DriveSenseSpeedArchiveRepository {
    static final int MAX_DESCRIPTOR_PAGE=32,MAX_INGRESS_CHUNK=256*1024,MAX_BUCKET_QUERY=32;
    static final int MAX_EDITOR_INDEX_BUCKET_BYTES=8*1024*1024;
    private static final long SPACE_RESERVE_BYTES=256L*1024L*1024L;
    private static final String P6_STAGE_BATCH_MARKER="__batch__";
    private final DriveSenseStorageCoordinator coordinator;
    private final DriveSenseSpeedChunkStore chunks;
    private static volatile String testFaultPoint;
    DriveSenseSpeedArchiveRepository(Context context)throws Exception{coordinator=DriveSenseStorageCoordinator.get(context);chunks=new DriveSenseSpeedChunkStore(context);coordinator.helper().getWritableDatabase();recoverInterruptedBatches();}
    DriveSenseStorageCoordinator coordinator(){return coordinator;}

    JSONObject state()throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT speed_generation,last_seq,integrity_tip,bucket_count,total_item_count,total_payload_bytes,recovery_state,updated_at_ms FROM speed_state WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("SPEED_CANONICAL_MISSING");JSONObject out=new JSONObject();out.put("speedGeneration",c.getString(0));out.put("lastSeq",c.getLong(1));out.put("integrityTip",DriveSenseEnvelopeCrypto.hex(c.getBlob(2)));out.put("bucketCount",c.getLong(3));out.put("totalItemCount",c.getLong(4));out.put("totalPayloadBytes",c.getLong(5));out.put("recoveryState",c.getString(6));out.put("updatedAtMs",c.getLong(7));return out;}});}

    JSONObject begin(JSONArray descriptors)throws Exception{
        if(descriptors==null||descriptors.length()<1||descriptors.length()>MAX_DESCRIPTOR_PAGE)throw new IllegalArgumentException("Speed descriptor page out of range");
        JSONObject planned=beginPlan(descriptors.length());String batch=planned.getString("batchId");addDescriptors(batch,descriptors);return sealPlan(batch);
    }

    JSONObject beginPlan(int bucketCount)throws Exception{return beginPlan(bucketCount,false);}

    JSONObject beginPlan(int bucketCount,boolean p6Automatic)throws Exception{
        if(bucketCount<1||bucketCount>1_000_000)throw new IllegalArgumentException("Speed logical batch count out of range");
        String batch=UUID.randomUUID().toString();String generation=state().getString("speedGeneration");coordinator.write(db->{db.beginTransaction();try{long now=System.currentTimeMillis();ContentValues b=new ContentValues();b.put("batch_id",batch);b.put("state","PLANNING");b.put("bucket_count",bucketCount);b.put("created_at_ms",now);b.put("updated_at_ms",now);db.insertOrThrow("speed_ingress_batches",null,b);if(p6Automatic){ContentValues stage=new ContentValues();stage.put("operation_id",batch);stage.put("bucket_id",P6_STAGE_BATCH_MARKER);stage.put("speed_generation",generation);stage.put("expected_revision",-1);stage.put("publication_version",1);stage.put("state","PLANNING");stage.put("encoded_bytes",0);stage.put("updated_at_ms",now);db.insertOrThrow("p6_speed_stages",null,stage);}db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        JSONObject out=new JSONObject();out.put("batchId",batch);out.put("bucketCount",bucketCount);out.put("maxDescriptorItems",MAX_DESCRIPTOR_PAGE);out.put("maxChunkBytes",MAX_INGRESS_CHUNK);return out;
    }

    JSONObject addDescriptors(String batch,JSONArray descriptors)throws Exception{
        if(descriptors==null||descriptors.length()<1||descriptors.length()>MAX_DESCRIPTOR_PAGE)throw new IllegalArgumentException("Speed descriptor page out of range");
        String state=batchState(batch);if(!"PLANNING".equals(state))throw new IllegalStateException("Speed batch is not accepting descriptors");
        List<Ingress> inputs=new ArrayList<>();
        for(int i=0;i<descriptors.length();i++){JSONObject item=descriptors.optJSONObject(i);if(item==null)throw new IllegalArgumentException("Invalid speed bucket descriptor");String id=bucketId(item.optString("bucketId",""));long expected=item.optLong("expectedBytes",-1);if(expected<=0||expected>Integer.MAX_VALUE-8L)throw new IllegalArgumentException("Invalid speed bucket byte count");byte[]hash=parseHash(item.optString("payloadHash",""));int cells=item.optInt("cellCount",0);if(cells<0)throw new IllegalArgumentException("Invalid speed cell count");File temp=chunks.ingress(batch,id);inputs.add(new Ingress(id,expected,0,0,hash,cells,temp.getAbsolutePath()));}
        coordinator.write(db->{db.beginTransaction();try{boolean p6=false;String generation="";try(Cursor marker=db.rawQuery("SELECT speed_generation FROM p6_speed_stages WHERE operation_id=? AND bucket_id=?",new String[]{batch,P6_STAGE_BATCH_MARKER})){if(marker.moveToFirst()){p6=true;generation=marker.getString(0);}}long now=System.currentTimeMillis();for(Ingress input:inputs){ContentValues row=new ContentValues();row.put("batch_id",batch);row.put("bucket_id",input.bucketId);row.put("expected_bytes",input.expected);row.put("payload_hash",input.payloadHash);row.put("cell_count",input.cellCount);row.put("temp_path",input.path);db.insertOrThrow("speed_ingress_buckets",null,row);if(p6){int expectedRevision=0;try(Cursor current=db.rawQuery("SELECT revision FROM speed_current WHERE bucket_id=?",new String[]{input.bucketId})){if(current.moveToFirst())expectedRevision=current.getInt(0);}ContentValues stage=new ContentValues();stage.put("operation_id",batch);stage.put("bucket_id",input.bucketId);stage.put("speed_generation",generation);stage.put("expected_revision",expectedRevision);stage.put("publication_version",1);stage.put("state","STAGED");stage.put("encoded_bytes",input.expected);stage.put("updated_at_ms",now);db.insertOrThrow("p6_speed_stages",null,stage);}}db.execSQL("UPDATE speed_ingress_batches SET updated_at_ms=? WHERE batch_id=? AND state='PLANNING'",new Object[]{now,batch});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        JSONObject out=new JSONObject();out.put("batchId",batch);out.put("accepted",inputs.size());out.put("registered",loadBatch(batch).size());return out;
    }

    JSONObject sealPlan(String batch)throws Exception{
        long[] totals=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT b.bucket_count,COUNT(i.bucket_id),COALESCE(SUM(i.expected_bytes + i.expected_bytes/8 + 4194304),0) FROM speed_ingress_batches b LEFT JOIN speed_ingress_buckets i ON i.batch_id=b.batch_id WHERE b.batch_id=? AND b.state='PLANNING' GROUP BY b.bucket_count",new String[]{batch})){if(!c.moveToFirst())throw new IllegalStateException("Speed batch unavailable");return new long[]{c.getLong(0),c.getLong(1),c.getLong(2)};}});
        if(totals[0]!=totals[1])throw new IllegalStateException("Speed descriptor plan is incomplete");admission(totals[2]);coordinator.write(db->{db.execSQL("UPDATE speed_ingress_batches SET state='RECEIVING',updated_at_ms=? WHERE batch_id=? AND state='PLANNING'",new Object[]{System.currentTimeMillis(),batch});return null;});
        JSONObject out=new JSONObject();out.put("batchId",batch);out.put("bucketCount",totals[0]);out.put("maxChunkBytes",MAX_INGRESS_CHUNK);out.put("sealed",true);return out;
    }

    JSONObject append(String batch,String bucket,int index,String encoded)throws Exception{
        String id=bucketId(bucket);if(index<0||encoded==null||encoded.length()>400000)throw new IllegalArgumentException("Invalid speed ingress chunk");byte[]bytes=Base64.decode(encoded,Base64.NO_WRAP);if(bytes.length<1||bytes.length>MAX_INGRESS_CHUNK)throw new IllegalArgumentException("Speed ingress chunk out of range");int count=bytes.length;Ingress input=load(batch,id);if(index!=input.nextIndex||input.received+count>input.expected)throw new IllegalStateException("Speed ingress sequence mismatch");try(FileOutputStream output=new FileOutputStream(input.path,true)){output.write(bytes);output.getFD().sync();}finally{Arrays.fill(bytes,(byte)0);}coordinator.write(db->{db.execSQL("UPDATE speed_ingress_buckets SET received_bytes=received_bytes+?,next_chunk_index=next_chunk_index+1 WHERE batch_id=? AND bucket_id=? AND next_chunk_index=?",new Object[]{count,batch,id,index});db.execSQL("UPDATE speed_ingress_batches SET updated_at_ms=? WHERE batch_id=?",new Object[]{System.currentTimeMillis(),batch});return null;});JSONObject out=new JSONObject();out.put("batchId",batch);out.put("bucketId",id);out.put("nextChunkIndex",index+1);out.put("receivedBytes",input.received+count);return out;
    }

    JSONObject finish(String batch)throws Exception{
        List<Ingress>inputs=loadBatch(batch);if(inputs.isEmpty())throw new IllegalStateException("Speed batch unavailable");String generation=state().getString("speedGeneration");List<Prepared>prepared=new ArrayList<>();
        try{
            if(!p6StageStillCurrent(batch,generation,inputs)){
                markP6StageObsolete(batch);abort(batch);JSONObject obsolete=new JSONObject();obsolete.put("batchId",batch);obsolete.put("status","OBSOLETE");obsolete.put("speedGeneration",generation);return obsolete;
            }
            int activeKek=DriveSenseEnvelopeCrypto.activeKekVersion(coordinator);for(Ingress input:inputs){File source=new File(input.path);if(input.received!=input.expected||source.length()!=input.expected)throw new IllegalStateException("Incomplete speed bucket ingress");byte[]actual=hashFile(source);if(!Arrays.equals(actual,input.payloadHash))throw new SecurityException("Speed bucket source hash mismatch");int revision=nextRevision(input.bucketId,generation);byte[]dek=DriveSenseEnvelopeCrypto.newDek();DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(dek,activeKek,DriveSenseEnvelopeCrypto.wrapAad(generation,"speed_bucket",input.bucketId,revision,input.payloadHash,activeKek));List<DriveSenseSpeedChunkStore.Plan>plans=chunks.plan(source,dek,generation,input.bucketId,revision,input.payloadHash,batch);List<DriveSenseSpeedEditorIndex.Entry>editorEntries=DriveSenseSpeedEditorIndex.collect(input.bucketId,readBoundedBucketDocument(source));prepared.add(new Prepared(input,revision,dek,wrapped,plans,editorEntries));}
            injectFault("BEFORE_PENDING");
            insertPending(batch,generation,prepared);
            injectFault("AFTER_PENDING");
            int published=0;
            for(Prepared item:prepared){chunks.publishVerify(new File(item.ingress.path),item.plans,item.dek,generation,item.ingress.bucketId,item.revision,item.ingress.payloadHash);published+=1;if(published==1)injectFault("AFTER_FIRST_BUCKET_PUBLISHED");}
            injectFault("AFTER_ALL_BUCKETS_PUBLISHED");
            long seq=commitBatch(batch,generation,prepared);
            injectFault("AFTER_COMMIT_BEFORE_SENTINEL");
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            injectFault("AFTER_SENTINEL_BEFORE_CLEANUP");
            for(Prepared item:prepared)verify(item,generation,seq);
            cleanup(batch,prepared);
            JSONObject out=new JSONObject();out.put("batchId",batch);out.put("status","COMMITTED");out.put("updatedSeq",seq);out.put("bucketCount",prepared.size());out.put("speedGeneration",generation);return out;
        }finally{for(Prepared item:prepared)Arrays.fill(item.dek,(byte)0);}
    }

    JSONObject abort(String batch)throws Exception{List<Ingress>items=loadBatch(batch);rollbackBatchArtifacts(batch);for(Ingress item:items)chunks.cleanupIngress(new File(item.path));JSONObject out=new JSONObject();out.put("aborted",true);return out;}

    /**
     * A logical bucket batch is visible only when its single SQLite commit
     * advances every current pointer.  A process death before that transaction
     * may leave authenticated immutable chunks and PENDING rows.  Roll those
     * rows back to the durable RECEIVING ingress state, retaining the admitted
     * plaintext spool so the exact batch can be retried.  Cleanup is driven by
     * catalog ownership, never by age.
     */
    private void recoverInterruptedBatches() throws Exception {
        List<String>obsoleteStages=coordinator.read(db->{List<String>out=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT DISTINCT operation_id FROM p6_speed_stages WHERE state='OBSOLETE'",null)){while(c.moveToNext())out.add(c.getString(0));}return out;});
        for(String batch:obsoleteStages){List<Ingress>inputs;try{inputs=loadBatch(batch);}catch(Exception absent){inputs=new ArrayList<>();}rollbackBatchArtifacts(batch);for(Ingress input:inputs)chunks.cleanupIngress(new File(input.path));}
        List<String> orphanFiles=new ArrayList<>();
        List<String> committedBatches=new ArrayList<>();
        coordinator.exclusive(db->{db.beginTransaction();try{
            try(Cursor c=db.rawQuery("SELECT c.relative_path FROM speed_chunks c JOIN speed_buckets b ON b.bucket_id=c.bucket_id AND b.speed_generation=c.speed_generation AND b.revision=c.revision WHERE b.commit_state='PENDING'",null)){while(c.moveToNext())orphanFiles.add(c.getString(0));}
            db.execSQL("DELETE FROM speed_chunks WHERE EXISTS (SELECT 1 FROM speed_buckets b WHERE b.bucket_id=speed_chunks.bucket_id AND b.speed_generation=speed_chunks.speed_generation AND b.revision=speed_chunks.revision AND b.commit_state='PENDING')");
            try(Cursor refs=db.rawQuery("SELECT kek_version,COUNT(*) FROM speed_buckets WHERE commit_state='PENDING' AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' GROUP BY kek_version",null)){while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(db,"speed_archive",refs.getInt(0),-refs.getLong(1));}
            db.delete("speed_buckets","commit_state='PENDING'",null);
            db.execSQL("UPDATE speed_ingress_batches SET state='RECEIVING',updated_at_ms=? WHERE state='PENDING'",new Object[]{System.currentTimeMillis()});
            try(Cursor c=db.rawQuery("SELECT batch_id FROM speed_ingress_batches WHERE state='COMMITTED' ORDER BY created_at_ms",null)){while(c.moveToNext())committedBatches.add(c.getString(0));}
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
        for(String relative:orphanFiles){
            boolean referenced=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM speed_chunks WHERE relative_path=? LIMIT 1",new String[]{relative})){return c.moveToFirst();}});
            if(!referenced)chunks.deleteRelative(relative);
        }
        for(String batch:committedBatches){
            boolean verified=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT COUNT(*),SUM(CASE WHEN b.commit_state IN ('COMMITTED','SUPERSEDED') AND s.revision>=b.revision AND b.payload_hash=i.payload_hash THEN 1 ELSE 0 END) FROM speed_ingress_buckets i JOIN speed_buckets b ON b.operation_id=i.batch_id AND b.bucket_id=i.bucket_id JOIN speed_current s ON s.bucket_id=i.bucket_id WHERE i.batch_id=?",new String[]{batch})){if(!c.moveToFirst())return false;int expected=c.getInt(0),matched=c.isNull(1)?0:c.getInt(1);return expected>0&&expected==matched;}});
            if(!verified)throw new IllegalStateException("SPEED_COMMITTED_BATCH_RECOVERY_DIVERGENCE");
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            List<Ingress>inputs=loadBatch(batch);for(Ingress input:inputs)chunks.cleanupIngress(new File(input.path));
            coordinator.write(db->{db.delete("speed_ingress_batches","batch_id=?",new String[]{batch});return null;});
        }
    }

    JSONObject metadata(JSONArray ids)throws Exception{if(ids==null||ids.length()<1||ids.length()>MAX_BUCKET_QUERY)throw new IllegalArgumentException("Speed bucket query out of range");JSONArray items=new JSONArray();for(int i=0;i<ids.length();i++){String id=bucketId(ids.optString(i,""));JSONObject item=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT bucket_id,speed_generation,revision,updated_seq,cell_count,payload_bytes,payload_hash,updated_at_ms FROM speed_current WHERE bucket_id=?",new String[]{id})){if(!c.moveToFirst())return null;JSONObject o=new JSONObject();o.put("bucketId",c.getString(0));o.put("speedGeneration",c.getString(1));o.put("revision",c.getInt(2));o.put("updatedSeq",c.getLong(3));o.put("cellCount",c.getInt(4));o.put("payloadBytes",c.getLong(5));o.put("payloadHash",DriveSenseEnvelopeCrypto.hex(c.getBlob(6)));o.put("updatedAtMs",c.getLong(7));return o;}});if(item!=null)items.put(item);}JSONObject out=new JSONObject();out.put("items",items);out.put("itemCount",items.length());out.put("requestedCount",ids.length());out.put("examinedBucketIds",ids.length());return out;}

    JSONObject page(String afterBucket,int maxItems)throws Exception{int limit=Math.max(1,Math.min(MAX_BUCKET_QUERY,maxItems));String after=afterBucket==null?"":afterBucket.trim().toLowerCase();if(!after.isEmpty())bucketId(after);JSONArray items=new JSONArray();coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT bucket_id,revision,updated_seq,cell_count,payload_bytes,payload_hash FROM speed_current WHERE bucket_id>? ORDER BY bucket_id LIMIT ?",new String[]{after,Integer.toString(limit+1)})){while(c.moveToNext()&&items.length()<limit){JSONObject o=new JSONObject();o.put("bucketId",c.getString(0));o.put("revision",c.getInt(1));o.put("updatedSeq",c.getLong(2));o.put("cellCount",c.getInt(3));o.put("payloadBytes",c.getLong(4));o.put("payloadHash",DriveSenseEnvelopeCrypto.hex(c.getBlob(5)));items.put(o);}}return null;});String next=items.length()==limit?items.getJSONObject(items.length()-1).getString("bucketId"):null;JSONObject out=new JSONObject();out.put("items",items);out.put("itemCount",items.length());out.put("nextCursor",next==null?JSONObject.NULL:next);return out;}

    Descriptor open(String bucket)throws Exception{String id=bucketId(bucket);return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT b.speed_generation,b.revision,b.payload_bytes,b.payload_hash,b.chunk_count,b.wrapped_dek,b.wrap_nonce,b.kek_version FROM speed_buckets b JOIN speed_current s ON s.bucket_id=b.bucket_id AND s.speed_generation=b.speed_generation AND s.revision=b.revision WHERE b.bucket_id=? AND b.commit_state='COMMITTED'",new String[]{id})){return c.moveToFirst()?descriptor(c,id):null;}});}
    Descriptor openRevision(String bucket,String generation,int revision)throws Exception{String id=bucketId(bucket);return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT speed_generation,revision,payload_bytes,payload_hash,chunk_count,wrapped_dek,wrap_nonce,kek_version FROM speed_buckets WHERE bucket_id=? AND speed_generation=? AND revision=? AND commit_state IN ('COMMITTED','SUPERSEDED')",new String[]{id,generation,Integer.toString(revision)})){return c.moveToFirst()?descriptor(c,id):null;}});}
    private Descriptor descriptor(Cursor c,String id)throws Exception{String generation=c.getString(0);int revision=c.getInt(1),count=c.getInt(4),kek=c.getInt(7);byte[]hash=c.getBlob(3);byte[]dek=DriveSenseEnvelopeCrypto.unwrapDek(c.getBlob(5),c.getBlob(6),kek,DriveSenseEnvelopeCrypto.wrapAad(generation,"speed_bucket",id,revision,hash,kek));return new Descriptor(id,generation,revision,c.getLong(2),hash,count,dek);}
    byte[]read(Descriptor d,int index)throws Exception{if(index<0||index>=d.chunkCount)throw new IllegalArgumentException("Speed chunk index out of range");DriveSenseSpeedChunkStore.Plan plan=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT plaintext_bytes,ciphertext_bytes,nonce,ciphertext_hash,relative_path FROM speed_chunks WHERE bucket_id=? AND speed_generation=? AND revision=? AND chunk_index=?",new String[]{d.bucketId,d.generation,Integer.toString(d.revision),Integer.toString(index)})){if(!c.moveToFirst())throw new IllegalStateException("SPEED_CHUNK_MISSING");return new DriveSenseSpeedChunkStore.Plan(index,c.getInt(0),c.getInt(1),c.getBlob(2),c.getBlob(3),c.getString(4),"");}});return chunks.read(plan,d.dek,d.generation,d.bucketId,d.revision,d.chunkCount,d.payloadHash);}
    JSONObject readBucketJson(String bucket)throws Exception{try(Descriptor descriptor=open(bucket)){if(descriptor==null)return null;java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream((int)Math.min(descriptor.payloadBytes,1024L*1024L));for(int index=0;index<descriptor.chunkCount;index++){byte[]plain=read(descriptor,index);try{output.write(plain);}finally{Arrays.fill(plain,(byte)0);}}return new JSONObject(output.toString(java.nio.charset.StandardCharsets.UTF_8.name()));}}
    boolean hasCanonicalBuckets()throws Exception{return state().optLong("bucketCount",0L)>0L;}

    JSONObject tombstone(JSONArray bucketIds,String reason)throws Exception{
        if(bucketIds==null||bucketIds.length()<1||bucketIds.length()>MAX_BUCKET_QUERY)throw new IllegalArgumentException("Speed tombstone batch out of range");
        List<String>ids=new ArrayList<>();for(int i=0;i<bucketIds.length();i++){String id=bucketId(bucketIds.optString(i,""));if(!ids.contains(id))ids.add(id);}
        List<String>files=new ArrayList<>();long removed=coordinator.exclusive(db->{db.beginTransaction();try{
            try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' LIMIT 1",null)){if(lease.moveToFirst())throw new IllegalStateException("EXPORT_SNAPSHOT_CONFLICT_RETRY");}
            MessageDigest digest=MessageDigest.getInstance("SHA-256");long removedCount=0,removedItems=0,removedBytes=0;for(String id:ids){digest.update(DriveSenseEnvelopeCrypto.encode(id));try(Cursor current=db.rawQuery("SELECT cell_count,payload_bytes FROM speed_current WHERE bucket_id=?",new String[]{id})){if(current.moveToFirst()){removedItems+=current.getLong(0);removedBytes+=current.getLong(1);}}try(Cursor c=db.rawQuery("SELECT relative_path FROM speed_chunks WHERE bucket_id=?",new String[]{id})){while(c.moveToNext())files.add(c.getString(0));}try(Cursor refs=db.rawQuery("SELECT kek_version,COUNT(*) FROM speed_buckets WHERE bucket_id=? AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' GROUP BY kek_version",new String[]{id})){while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(db,"speed_archive",refs.getInt(0),-refs.getLong(1));}removedCount+=db.delete("speed_current","bucket_id=?",new String[]{id});ContentValues retired=new ContentValues();retired.put("commit_state","TOMBSTONED");retired.put("wrapped_dek",new byte[0]);retired.put("wrap_nonce",new byte[0]);db.update("speed_buckets",retired,"bucket_id=?",new String[]{id});db.delete("speed_chunks","bucket_id=?",new String[]{id});}
            byte[]previous;try(Cursor c=db.rawQuery("SELECT integrity_tip FROM speed_state WHERE id=1",null)){c.moveToFirst();previous=c.getBlob(0);}long now=System.currentTimeMillis();String batch=UUID.randomUUID().toString();byte[]batchDigest=digest.digest();byte[]chain=DriveSenseEnvelopeCrypto.sha256(DriveSenseEnvelopeCrypto.encode("roadsage.speed.event.v1",DriveSenseEnvelopeCrypto.hex(previous),"BUCKET_TOMBSTONE_BATCH",batch,DriveSenseEnvelopeCrypto.hex(batchDigest),Long.toString(now)));ContentValues event=new ContentValues();event.put("event_type","BUCKET_TOMBSTONE_BATCH");event.put("batch_id",batch);event.put("bucket_digest",batchDigest);event.put("previous_chain_hash",previous);event.put("chain_hash",chain);event.put("created_at_ms",now);long seq=db.insertOrThrow("speed_journal",null,event);db.execSQL("UPDATE speed_buckets SET retired_seq=COALESCE(retired_seq,?) WHERE commit_state='TOMBSTONED' AND bucket_id IN ("+placeholders(ids.size())+")",concat(new Object[]{seq},ids));db.execSQL("UPDATE speed_state SET last_seq=?,integrity_tip=?,bucket_count=MAX(0,bucket_count-?),total_item_count=MAX(0,total_item_count-?),total_payload_bytes=MAX(0,total_payload_bytes-?),updated_at_ms=? WHERE id=1",new Object[]{seq,chain,removedCount,removedItems,removedBytes,now});db.setTransactionSuccessful();return removedCount;
        }finally{db.endTransaction();}});for(String file:files)chunks.deleteRelative(file);JSONObject out=new JSONObject();out.put("removedBucketCount",removed);out.put("requestedBucketCount",ids.size());out.put("reason",reason==null?"removed_bucket":reason);return out;
    }

    /** Bounded restore ingress. The portable file has already passed a complete verification pass. */
    JSONObject restoreSpool(File source,String bucket,int cellCount,byte[]expectedHash)throws Exception{
        String id=bucketId(bucket);if(source==null||!source.isFile()||source.length()<1)throw new IllegalArgumentException("Speed restore source is unavailable");
        byte[]actual=hashFile(source);if(!MessageDigest.isEqual(actual,expectedHash))throw new SecurityException("Speed restore payload hash mismatch");
        JSONObject descriptor=new JSONObject();descriptor.put("bucketId",id);descriptor.put("expectedBytes",source.length());descriptor.put("cellCount",Math.max(0,cellCount));descriptor.put("payloadHash",DriveSenseEnvelopeCrypto.hex(actual));
        JSONObject started=begin(new JSONArray().put(descriptor));String batch=started.getString("batchId");
        try(FileInputStream input=new FileInputStream(source)){
            byte[]buffer=new byte[MAX_INGRESS_CHUNK];int read,index=0;
            while((read=input.read(buffer))!=-1){byte[]part=read==buffer.length?buffer:Arrays.copyOf(buffer,read);try{append(batch,id,index++,Base64.encodeToString(part,Base64.NO_WRAP));}finally{if(part!=buffer)Arrays.fill(part,(byte)0);}}
            Arrays.fill(buffer,(byte)0);
            return finish(batch);
        }catch(Exception error){try{abort(batch);}catch(Exception ignored){}throw error;}
    }

    JSONObject rolloverGeneration(String reason)throws Exception{
        List<String>files=new ArrayList<>();long[]removed=new long[1];String[]prior=new String[1];
        JSONObject result=coordinator.exclusive(db->{db.beginTransaction();try{
            try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' LIMIT 1",null)){if(lease.moveToFirst())throw new IllegalStateException("EXPORT_SNAPSHOT_CONFLICT_RETRY");}
            try(Cursor c=db.rawQuery("SELECT speed_generation,bucket_count FROM speed_state WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("speed_state missing");prior[0]=c.getString(0);removed[0]=c.getLong(1);}
            try(Cursor c=db.rawQuery("SELECT relative_path FROM speed_chunks",null)){while(c.moveToNext())files.add(c.getString(0));}
            db.delete("speed_current",null,null);db.delete("speed_chunks",null,null);db.delete("speed_buckets",null,null);db.delete("speed_journal",null,null);db.delete("speed_ingress_buckets",null,null);db.delete("speed_ingress_batches",null,null);db.delete("key_reference_counts","domain_id='speed_archive'",null);
            String generation=UUID.randomUUID().toString();long now=System.currentTimeMillis();db.execSQL("UPDATE speed_state SET speed_generation=?,last_seq=0,integrity_tip=?,bucket_count=0,total_item_count=0,total_payload_bytes=0,recovery_state='HEALTHY',updated_at_ms=? WHERE id=1",new Object[]{generation,new byte[32],now});try{db.execSQL("DELETE FROM sqlite_sequence WHERE name='speed_journal'");}catch(Exception ignored){}
            // D4 receipts and lookup publication are bound to the canonical
            // speed generation. Requeue source-derived road work in the same
            // transaction that publishes the new generation so coverage can
            // never remain VERIFIED against erased speed state.
            db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,cursor=NULL,storage_outcome='SPEED_GENERATION_CHANGED',updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",new Object[]{now});
            db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",new Object[]{now});
            db.execSQL("UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? WHERE state!='TOMBSTONE_CLEANUP'",new Object[]{now});
            db.setTransactionSuccessful();JSONObject out=new JSONObject();out.put("erased",true);out.put("verified",true);out.put("removedBucketCount",removed[0]);out.put("priorGeneration",prior[0]);out.put("speedGeneration",generation);out.put("reason",reason==null?"generation_rollover":reason);return out;
        }finally{db.endTransaction();}});
        for(String file:files)chunks.deleteRelative(file);
        // Speed generation is part of the independent sentinel. Publishing the
        // new generation without refreshing it would make the next healthy
        // canonical write fail closed after restore or data-rights rollover.
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        return result;
    }

    private void insertPending(String batch,String generation,List<Prepared>items)throws Exception{coordinator.write(db->{db.beginTransaction();try{for(Prepared item:items){ContentValues row=new ContentValues();row.put("bucket_id",item.ingress.bucketId);row.put("speed_generation",generation);row.put("revision",item.revision);row.put("operation_id",batch);row.put("commit_state","PENDING");row.put("cell_count",item.ingress.cellCount);row.put("payload_bytes",item.ingress.expected);row.put("payload_hash",item.ingress.payloadHash);row.put("chunk_count",item.plans.size());row.put("wrapped_dek",item.wrapped.ciphertext);row.put("wrap_nonce",item.wrapped.nonce);row.put("kek_version",item.wrapped.version);row.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("speed_buckets",null,row);db.execSQL("INSERT INTO key_reference_counts(domain_id,key_version,reference_count,updated_at_ms) VALUES('speed_archive',?,?,?) ON CONFLICT(domain_id,key_version) DO UPDATE SET reference_count=reference_count+1,updated_at_ms=excluded.updated_at_ms",new Object[]{item.wrapped.version,1,System.currentTimeMillis()});for(DriveSenseSpeedChunkStore.Plan plan:item.plans){ContentValues chunk=new ContentValues();chunk.put("bucket_id",item.ingress.bucketId);chunk.put("speed_generation",generation);chunk.put("revision",item.revision);chunk.put("chunk_index",plan.index);chunk.put("relative_path",plan.relativePath);chunk.put("nonce",plan.nonce);chunk.put("ciphertext_hash",plan.ciphertextHash);chunk.put("plaintext_bytes",plan.plaintextBytes);chunk.put("ciphertext_bytes",plan.ciphertextBytes);db.insertOrThrow("speed_chunks",null,chunk);}}db.execSQL("UPDATE speed_ingress_batches SET state='PENDING',updated_at_ms=? WHERE batch_id=?",new Object[]{System.currentTimeMillis(),batch});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}
    private long commitBatch(String batch,String generation,List<Prepared>items)throws Exception{return coordinator.write(db->{db.beginTransaction();try{
        byte[]digest=batchDigest(items);long now=System.currentTimeMillis();byte[]previous;
        try(Cursor c=db.rawQuery("SELECT integrity_tip FROM speed_state WHERE id=1",null)){c.moveToFirst();previous=c.getBlob(0);}
        byte[]chain=DriveSenseEnvelopeCrypto.sha256(DriveSenseEnvelopeCrypto.encode("roadsage.speed.event.v1",DriveSenseEnvelopeCrypto.hex(previous),"BUCKET_BATCH",batch,DriveSenseEnvelopeCrypto.hex(digest),Long.toString(now)));
        ContentValues event=new ContentValues();event.put("event_type","BUCKET_BATCH");event.put("batch_id",batch);event.put("bucket_digest",digest);event.put("previous_chain_hash",previous);event.put("chain_hash",chain);event.put("created_at_ms",now);long seq=db.insertOrThrow("speed_journal",null,event);injectFault("INSIDE_FINAL_TRANSACTION");
        int added=0;long itemDelta=0L,byteDelta=0L;
        for(Prepared item:items){Integer prior=null;long priorItems=0L,priorBytes=0L;
            try(Cursor c=db.rawQuery("SELECT revision,cell_count,payload_bytes FROM speed_current WHERE bucket_id=?",new String[]{item.ingress.bucketId})){if(c.moveToFirst()){prior=c.getInt(0);priorItems=c.getLong(1);priorBytes=c.getLong(2);}}
            if(prior==null)added++;else db.execSQL("UPDATE speed_buckets SET commit_state='SUPERSEDED',retired_seq=? WHERE bucket_id=? AND speed_generation=? AND revision=?",new Object[]{seq,item.ingress.bucketId,generation,prior});
            itemDelta+=item.ingress.cellCount-priorItems;byteDelta+=item.ingress.expected-priorBytes;
            db.execSQL("UPDATE speed_buckets SET commit_state='COMMITTED',updated_seq=?,updated_at_ms=? WHERE bucket_id=? AND speed_generation=? AND revision=?",new Object[]{seq,now,item.ingress.bucketId,generation,item.revision});
            ContentValues current=new ContentValues();current.put("bucket_id",item.ingress.bucketId);current.put("speed_generation",generation);current.put("revision",item.revision);current.put("updated_seq",seq);current.put("cell_count",item.ingress.cellCount);current.put("payload_bytes",item.ingress.expected);current.put("payload_hash",item.ingress.payloadHash);current.put("updated_at_ms",now);db.insertWithOnConflict("speed_current",null,current,SQLiteDatabase.CONFLICT_REPLACE);
            DriveSenseSpeedEditorIndex.replaceBucket(db,item.ingress.bucketId,generation,item.revision,seq,item.editorEntries);
            // A canonical manual revision owns the logical prefix immediately.
            // Any older automatic P6 stage was built against a different head
            // and may be cleaned or rebuilt, but it may never overwrite this
            // newly published revision on a later retry.
            db.execSQL("UPDATE p6_speed_stages SET state='OBSOLETE',updated_at_ms=? WHERE bucket_id=? AND operation_id<>? AND speed_generation=? AND expected_revision<? AND state<>'OBSOLETE'",
                new Object[]{now,item.ingress.bucketId,batch,generation,item.revision});
        }
        db.execSQL("UPDATE speed_state SET last_seq=?,integrity_tip=?,bucket_count=bucket_count+?,total_item_count=MAX(0,total_item_count+?),total_payload_bytes=MAX(0,total_payload_bytes+?),updated_at_ms=? WHERE id=1",new Object[]{seq,chain,added,itemDelta,byteDelta,now});
        db.execSQL("UPDATE speed_ingress_batches SET state='COMMITTED',updated_at_ms=? WHERE batch_id=?",new Object[]{now,batch});db.setTransactionSuccessful();return seq;
    }finally{db.endTransaction();}});}
    private void verify(Prepared p,String generation,long seq)throws Exception{coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT commit_state,updated_seq,payload_hash FROM speed_buckets WHERE bucket_id=? AND speed_generation=? AND revision=?",new String[]{p.ingress.bucketId,generation,Integer.toString(p.revision)})){if(!c.moveToFirst()||!"COMMITTED".equals(c.getString(0))||c.getLong(1)!=seq||!Arrays.equals(c.getBlob(2),p.ingress.payloadHash))throw new IllegalStateException("SPEED_CANONICAL_VERIFY_FAILED");}return null;});}
    private void cleanup(String batch,List<Prepared>items)throws Exception{for(Prepared item:items)chunks.cleanupIngress(new File(item.ingress.path));coordinator.write(db->{db.beginTransaction();try{db.delete("p6_speed_stages","operation_id=?",new String[]{batch});db.delete("speed_ingress_batches","batch_id=?",new String[]{batch});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}
    private List<Ingress>loadBatch(String batch)throws Exception{return coordinator.read(db->{List<Ingress>out=new ArrayList<>();try(Cursor c=db.rawQuery("SELECT bucket_id,expected_bytes,received_bytes,next_chunk_index,payload_hash,cell_count,temp_path FROM speed_ingress_buckets WHERE batch_id=? ORDER BY bucket_id",new String[]{batch})){while(c.moveToNext())out.add(new Ingress(c.getString(0),c.getLong(1),c.getLong(2),c.getInt(3),c.getBlob(4),c.getInt(5),c.getString(6)));}return out;});}
    private Ingress load(String batch,String id)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT bucket_id,expected_bytes,received_bytes,next_chunk_index,payload_hash,cell_count,temp_path FROM speed_ingress_buckets WHERE batch_id=? AND bucket_id=?",new String[]{batch,id})){if(!c.moveToFirst())throw new IllegalStateException("Speed ingress unavailable");return new Ingress(c.getString(0),c.getLong(1),c.getLong(2),c.getInt(3),c.getBlob(4),c.getInt(5),c.getString(6));}});}
    private String batchState(String batch)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT state FROM speed_ingress_batches WHERE batch_id=?",new String[]{batch})){if(!c.moveToFirst())throw new IllegalStateException("Speed batch unavailable");return c.getString(0);}});}
    private int nextRevision(String id,String generation)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT COALESCE(MAX(revision),0)+1 FROM speed_buckets WHERE bucket_id=? AND speed_generation=?",new String[]{id,generation})){c.moveToFirst();return c.getInt(0);}});}
    private boolean p6StageStillCurrent(String batch,String generation,List<Ingress>inputs)throws Exception{return coordinator.read(db->{boolean marked=false;try(Cursor marker=db.rawQuery("SELECT state,speed_generation FROM p6_speed_stages WHERE operation_id=? AND bucket_id=?",new String[]{batch,P6_STAGE_BATCH_MARKER})){if(!marker.moveToFirst())return true;marked=true;if("OBSOLETE".equals(marker.getString(0))||!generation.equals(marker.getString(1)))return false;}if(!marked)return true;for(Ingress input:inputs){int expected;String stageState;try(Cursor stage=db.rawQuery("SELECT expected_revision,state FROM p6_speed_stages WHERE operation_id=? AND bucket_id=?",new String[]{batch,input.bucketId})){if(!stage.moveToFirst())return false;expected=stage.getInt(0);stageState=stage.getString(1);}if("OBSOLETE".equals(stageState))return false;int current=0;try(Cursor head=db.rawQuery("SELECT revision FROM speed_current WHERE bucket_id=?",new String[]{input.bucketId})){if(head.moveToFirst())current=head.getInt(0);}if(current!=expected)return false;}return true;});}
    private void markP6StageObsolete(String batch)throws Exception{coordinator.write(db->{db.execSQL("UPDATE p6_speed_stages SET state='OBSOLETE',updated_at_ms=? WHERE operation_id=?",new Object[]{System.currentTimeMillis(),batch});return null;});}
    private void rollbackBatchArtifacts(String batch)throws Exception{List<String>files=new ArrayList<>();coordinator.exclusive(db->{db.beginTransaction();try{try(Cursor c=db.rawQuery("SELECT c.relative_path FROM speed_chunks c JOIN speed_buckets b ON b.bucket_id=c.bucket_id AND b.speed_generation=c.speed_generation AND b.revision=c.revision WHERE b.operation_id=? AND b.commit_state='PENDING'",new String[]{batch})){while(c.moveToNext())files.add(c.getString(0));}try(Cursor refs=db.rawQuery("SELECT kek_version,COUNT(*) FROM speed_buckets WHERE operation_id=? AND commit_state='PENDING' AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' GROUP BY kek_version",new String[]{batch})){while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(db,"speed_archive",refs.getInt(0),-refs.getLong(1));}db.execSQL("DELETE FROM speed_chunks WHERE EXISTS (SELECT 1 FROM speed_buckets b WHERE b.operation_id=? AND b.commit_state='PENDING' AND b.bucket_id=speed_chunks.bucket_id AND b.speed_generation=speed_chunks.speed_generation AND b.revision=speed_chunks.revision)",new Object[]{batch});db.delete("speed_buckets","operation_id=? AND commit_state='PENDING'",new String[]{batch});db.delete("p6_speed_stages","operation_id=?",new String[]{batch});db.delete("speed_ingress_batches","batch_id=?",new String[]{batch});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});for(String relative:files){boolean referenced=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM speed_chunks WHERE relative_path=? LIMIT 1",new String[]{relative})){return c.moveToFirst();}});if(!referenced)chunks.deleteRelative(relative);}}
    private void admission(long required){long available=DriveSenseStorageAdmission.availableBytes(coordinator.context());if(required<0||available-required<SPACE_RESERVE_BYTES)throw new IllegalStateException("LOW_SPACE_BLOCKED");}
    private static byte[]batchDigest(List<Prepared>items)throws Exception{List<Prepared>sorted=new ArrayList<>(items);sorted.sort(Comparator.comparing(p->p.ingress.bucketId));MessageDigest digest=MessageDigest.getInstance("SHA-256");for(Prepared p:sorted)digest.update(DriveSenseEnvelopeCrypto.encode(p.ingress.bucketId,Integer.toString(p.revision),DriveSenseEnvelopeCrypto.hex(p.ingress.payloadHash)));return digest.digest();}
    private static byte[]hashFile(File file)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(FileInputStream input=new FileInputStream(file)){byte[]buffer=new byte[256*1024];int n;while((n=input.read(buffer))!=-1)digest.update(buffer,0,n);}return digest.digest();}
    private static JSONObject readBoundedBucketDocument(File file)throws Exception{if(file.length()<1||file.length()>MAX_EDITOR_INDEX_BUCKET_BYTES)throw new IllegalStateException("SPEED_BUCKET_ENCODED_BYTES_EXCEEDED");try(FileInputStream input=new FileInputStream(file);java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream((int)file.length())){byte[]buffer=new byte[64*1024];int read;while((read=input.read(buffer))!=-1)output.write(buffer,0,read);Arrays.fill(buffer,(byte)0);byte[]bytes=output.toByteArray();try{return new JSONObject(new String(bytes,StandardCharsets.UTF_8));}finally{Arrays.fill(bytes,(byte)0);}}}
    private static byte[]parseHash(String hex){if(hex==null||!hex.matches("[0-9a-fA-F]{64}"))throw new IllegalArgumentException("payloadHash must be SHA-256 hex");byte[]out=new byte[32];for(int i=0;i<32;i++)out[i]=(byte)Integer.parseInt(hex.substring(i*2,i*2+2),16);return out;}
    private static String placeholders(int count){return String.join(",",java.util.Collections.nCopies(count,"?"));}
    private static Object[]concat(Object[]prefix,List<String>ids){Object[]out=Arrays.copyOf(prefix,prefix.length+ids.size());for(int i=0;i<ids.size();i++)out[prefix.length+i]=ids.get(i);return out;}
    static void setFaultPointForTests(String point){testFaultPoint=point;}
    private static void injectFault(String point){if(point.equals(testFaultPoint)){testFaultPoint=null;throw new IllegalStateException("TEST_FAULT_"+point);}}
    private static String bucketId(String value){String id=value==null?"":value.trim().toLowerCase();if(!id.matches("[0-9bcdefghjkmnpqrstuvwxyz]{4}"))throw new IllegalArgumentException("bucketId must be geohash prefix-4");return id;}
    private static final class Ingress{final String bucketId,path;final long expected,received;final int nextIndex,cellCount;final byte[]payloadHash;Ingress(String b,long e,long r,int n,byte[]h,int c,String p){bucketId=b;expected=e;received=r;nextIndex=n;payloadHash=h;cellCount=c;path=p;}}
    private static final class Prepared{final Ingress ingress;final int revision;final byte[]dek;final DriveSenseEnvelopeCrypto.WrappedDek wrapped;final List<DriveSenseSpeedChunkStore.Plan>plans;final List<DriveSenseSpeedEditorIndex.Entry>editorEntries;Prepared(Ingress i,int r,byte[]d,DriveSenseEnvelopeCrypto.WrappedDek w,List<DriveSenseSpeedChunkStore.Plan>p,List<DriveSenseSpeedEditorIndex.Entry>e){ingress=i;revision=r;dek=d;wrapped=w;plans=p;editorEntries=e;}}
    static final class Descriptor implements AutoCloseable{final String bucketId,generation;final int revision,chunkCount;final long payloadBytes;final byte[]payloadHash,dek;Descriptor(String b,String g,int r,long p,byte[]h,int c,byte[]d){bucketId=b;generation=g;revision=r;payloadBytes=p;payloadHash=h;chunkCount=c;dek=d;}public void close(){Arrays.fill(dek,(byte)0);}}
}
