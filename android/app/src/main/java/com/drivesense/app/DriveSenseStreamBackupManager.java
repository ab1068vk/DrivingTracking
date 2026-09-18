package com.drivesense.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.lambdapioneer.argon2kt.Argon2Kt;
import com.lambdapioneer.argon2kt.Argon2KtResult;
import com.lambdapioneer.argon2kt.Argon2Mode;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.CharBuffer;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Native, framed, bounded-memory road-sage-stream-backup v2 writer. */
final class DriveSenseStreamBackupManager {
    static final byte[]MAGIC="RSB2FRM\n".getBytes(StandardCharsets.US_ASCII);
    static final int FORMAT=2,ARGON2_TIME_COST=3,ARGON2_MEMORY_KIB=64*1024,MAX_FRAME=512*1024;
    private static final long RESTORE_SPACE_RESERVE_BYTES=64L*1024L*1024L;
    private static final SecureRandom RANDOM=new SecureRandom();
    private static volatile byte[] testPortableKey;
    interface TestHook { void onPoint(String point, String operationId) throws Exception; }
    private static volatile TestHook testHook;
    private static DriveSenseStreamBackupManager instance;
    static synchronized DriveSenseStreamBackupManager get(Context context,DriveSenseTripArchiveRepository trips,DriveSenseSpeedArchiveRepository speed){if(instance==null)instance=new DriveSenseStreamBackupManager(context,trips,speed);return instance;}
    static synchronized void resetForTests(){if(instance!=null)instance.executor.shutdownNow();instance=null;testPortableKey=null;testHook=null;}
    static void installPortableKeyForTests(byte[]key){testPortableKey=key==null?null:Arrays.copyOf(key,key.length);}
    static void setTestHookForTests(TestHook hook){testHook=hook;}

    private final Context context;private final DriveSenseTripArchiveRepository trips;private final DriveSenseSpeedArchiveRepository speed;private final DriveSenseStorageCoordinator coordinator;private final ExecutorService executor=Executors.newSingleThreadExecutor(r->{Thread t=new Thread(r,"roadsage-backup-v2");t.setDaemon(true);return t;});private final Map<String,Operation>operations=new ConcurrentHashMap<>();private final ThreadLocal<byte[]>frameChain=ThreadLocal.withInitial(()->new byte[32]);
    private DriveSenseStreamBackupManager(Context context,DriveSenseTripArchiveRepository trips,DriveSenseSpeedArchiveRepository speed){this.context=context.getApplicationContext();this.trips=trips;this.speed=speed;this.coordinator=trips.coordinator();cleanupInterrupted();}

    JSONObject begin(String filename,String passphrase)throws Exception{if(passphrase==null||passphrase.length()<8||passphrase.length()>1024)throw new IllegalArgumentException("Portable backup password must contain 8-1024 characters");if(operations.values().stream().anyMatch(o->!o.done))throw new IllegalStateException("BACKUP_ALREADY_RUNNING");String id=UUID.randomUUID().toString();String safe=safeFilename(filename);File partial=new File(directory(),safe+"."+id+".partial");File output=new File(directory(),safe.endsWith(".rsb2")?safe:safe+".rsb2");Operation operation=new Operation(id,passphrase.toCharArray(),partial,output);operations.put(id,operation);executor.execute(()->run(operation));return operation.json();}
    JSONObject beginRestore(String backupOperationId,String passphrase)throws Exception{if(passphrase==null||passphrase.length()<8||passphrase.length()>1024)throw new IllegalArgumentException("Portable backup password must contain 8-1024 characters");Operation source=operations.get(backupOperationId);if(source==null||!"BACKUP".equals(source.kind)||!source.done||!source.verified||!source.output.isFile())throw new IllegalStateException("VERIFIED_BACKUP_UNAVAILABLE");if(operations.values().stream().anyMatch(o->!o.done))throw new IllegalStateException("ARCHIVE_OPERATION_ALREADY_RUNNING");String id=UUID.randomUUID().toString();Operation operation=new Operation(id,"RESTORE",passphrase.toCharArray(),new File(directory(),id+".restore.partial"),source.output);operations.put(id,operation);executor.execute(()->runRestore(operation));return operation.json();}
    JSONObject recoverVerifiedBackup(String operationId,String nativePath,String expectedSha256,String passphrase)throws Exception{
        if(operationId==null||!operationId.matches("[0-9a-fA-F-]{36}"))throw new SecurityException("BACKUP_OPERATION_ID_INVALID");
        if(passphrase==null||passphrase.length()<8||passphrase.length()>1024)throw new IllegalArgumentException("Portable backup password must contain 8-1024 characters");
        Operation existing=operations.get(operationId);if(existing!=null)return existing.json();
        File dir=directory().getCanonicalFile(),output=new File(nativePath==null?"":nativePath).getCanonicalFile();
        if(!dir.equals(output.getParentFile())||!output.getName().endsWith(".rsb2")||!output.isFile())throw new SecurityException("VERIFIED_BACKUP_PATH_OUTSIDE_ARCHIVE");
        String actual=DriveSenseEnvelopeCrypto.hex(hashFile(output));
        if(expectedSha256==null||!MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII),expectedSha256.getBytes(StandardCharsets.US_ASCII)))throw new SecurityException("VERIFIED_BACKUP_HASH_MISMATCH");
        byte[]key=deriveFileKey(output,passphrase.toCharArray());try{verify(output,key);}finally{Arrays.fill(key,(byte)0);}
        Operation recovered=new Operation(operationId,new char[0],new File(dir,operationId+".recovered.partial"),output);
        recovered.phase="COMPLETE";recovered.completedBytes=output.length();recovered.done=true;recovered.verified=true;operations.put(operationId,recovered);
        return recovered.json();
    }
    JSONObject beginRestoreFromUri(String uriValue,String passphrase)throws Exception{
        if(passphrase==null||passphrase.length()<8||passphrase.length()>1024)throw new IllegalArgumentException("Portable backup password must contain 8-1024 characters");
        if(operations.values().stream().anyMatch(o->!o.done))throw new IllegalStateException("ARCHIVE_OPERATION_ALREADY_RUNNING");
        Uri uri=Uri.parse(uriValue==null?"":uriValue);
        if(!"content".equalsIgnoreCase(uri.getScheme()))throw new SecurityException("RESTORE_REQUIRES_REVIEWED_CONTENT_URI");
        String id=UUID.randomUUID().toString();
        File staged=new File(directory(),id+".restore-input.partial");
        Operation operation=new Operation(id,"RESTORE",passphrase.toCharArray(),new File(directory(),id+".restore.partial"),staged);
        operation.deleteInputWhenDone=true;operations.put(id,operation);
        executor.execute(()->runRestoreFromUri(operation,uri));
        return operation.json();
    }
    JSONObject status(String id)throws Exception{Operation operation=operations.get(id);if(operation==null)throw new IllegalStateException("BACKUP_OPERATION_UNAVAILABLE");return operation.json();}
    JSONObject cancel(String id)throws Exception{Operation operation=operations.get(id);if(operation==null)throw new IllegalStateException("BACKUP_OPERATION_UNAVAILABLE");operation.cancel.set(true);return operation.json();}
    JSONObject publish(String id)throws Exception{Operation operation=operations.get(id);if(operation==null||!"BACKUP".equals(operation.kind)||!operation.done||!operation.verified||!operation.output.isFile())throw new IllegalStateException("BACKUP_NOT_VERIFIED");String name=operation.output.getName();if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q){ContentValues values=mediaStoreBackupValues(name);Uri uri=context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values);if(uri==null)throw new IllegalStateException("Could not create backup destination");try(OutputStream output=context.getContentResolver().openOutputStream(uri,"w")){if(output==null)throw new IllegalStateException("Could not open backup destination");copy(operation.output,output);}catch(Exception error){context.getContentResolver().delete(uri,null,null);throw error;}ContentValues ready=new ContentValues();ready.put(MediaStore.Downloads.IS_PENDING,0);context.getContentResolver().update(uri,ready,null,null);JSONObject out=new JSONObject();out.put("published",true);out.put("uri",uri.toString());out.put("filename",name);out.put("leaseClosed",operation.leaseClosed);return out;}File directory=context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);if(directory==null)throw new IllegalStateException("External backup destination unavailable");File target=new File(directory,name);try(OutputStream output=new FileOutputStream(target,false)){copy(operation.output,output);}JSONObject out=new JSONObject();out.put("published",true);out.put("uri",Uri.fromFile(target).toString());out.put("filename",name);out.put("appSpecific",true);out.put("leaseClosed",operation.leaseClosed);return out;}

    static ContentValues mediaStoreBackupValues(String name){ContentValues values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,name);values.put(MediaStore.Downloads.MIME_TYPE,DriveSenseStreamBackupMimeContract.ROAD_SAGE_STREAM_BACKUP);values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/Road Sage");values.put(MediaStore.Downloads.IS_PENDING,1);return values;}

    private void run(Operation op){byte[]key=null;String lease=null;try{Snapshot snapshot=snapshot();admitExport(snapshot);lease=op.id;createLease(lease,snapshot);testPoint("AFTER_EXPORT_LEASE",op);op.phase="DERIVING_KEY";byte[]salt=new byte[16];RANDOM.nextBytes(salt);key=deriveKey(op.passphrase,salt);frameChain.set(new byte[32]);Arrays.fill(op.passphrase,'\0');op.passphrase=null;JSONObject header=new JSONObject();header.put("format","road-sage-stream-backup");header.put("version",FORMAT);header.put("kdf","ARGON2ID");header.put("timeCost",ARGON2_TIME_COST);header.put("memoryKiB",ARGON2_MEMORY_KIB);header.put("salt",Base64.encodeToString(salt,Base64.NO_WRAP));header.put("archiveGeneration",snapshot.archiveGeneration);header.put("throughSeq",snapshot.tripSeq);header.put("speedGeneration",snapshot.speedGeneration);header.put("speedThroughSeq",snapshot.speedSeq);header.put("createdAtMs",System.currentTimeMillis());byte[]headerBytes=header.toString().getBytes(StandardCharsets.UTF_8);byte[]headerHash=MessageDigest.getInstance("SHA-256").digest(headerBytes);MessageDigest outputDigest=MessageDigest.getInstance("SHA-256");try(FileOutputStream raw=new FileOutputStream(op.partial,false);DataOutputStream output=new DataOutputStream(new BufferedOutputStream(raw))){output.write(MAGIC);output.writeInt(headerBytes.length);output.write(headerBytes);outputDigest.update(MAGIC);outputDigest.update(intBytes(headerBytes.length));outputDigest.update(headerBytes);long frame=0;op.phase="TRIPS";try(Cursor rows=coordinator.read(db->db.rawQuery("SELECT trip_id,revision FROM trip_revisions WHERE seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED') ORDER BY seq",new String[]{Long.toString(snapshot.tripSeq),Long.toString(snapshot.tripSeq)}))){while(rows.moveToNext()){checkCancelled(op);testPoint("EXPORT_TRIP_RECORD",op);String id=rows.getString(0);int revision=rows.getInt(1);try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=trips.descriptor(id,revision)){if(descriptor==null)throw new IllegalStateException("Export trip revision unavailable");JSONObject meta=new JSONObject();meta.put("tripId",id);meta.put("revision",revision);meta.put("payloadBytes",descriptor.plaintextBytes);meta.put("payloadHash",DriveSenseEnvelopeCrypto.hex(descriptor.payloadHash));meta.put("chunkCount",descriptor.chunkCount);frame=writeFrame(output,outputDigest,key,headerHash,1,frame,meta.toString().getBytes(StandardCharsets.UTF_8));for(int index=0;index<descriptor.chunkCount;index++){checkCancelled(op);byte[]plain=trips.readPayloadChunk(descriptor,index);try{frame=writeFrame(output,outputDigest,key,headerHash,2,frame,plain);}finally{Arrays.fill(plain,(byte)0);}op.completedBytes+=Math.min(DriveSenseTripChunkStore.CHUNK_BYTES,descriptor.plaintextBytes-(long)index*DriveSenseTripChunkStore.CHUNK_BYTES);}}op.completedItems++;}}
                op.phase="SPEED";try(Cursor rows=coordinator.read(db->db.rawQuery("SELECT bucket_id,speed_generation,revision,cell_count FROM speed_buckets WHERE updated_seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED') ORDER BY bucket_id",new String[]{Long.toString(snapshot.speedSeq),Long.toString(snapshot.speedSeq)}))){while(rows.moveToNext()){checkCancelled(op);String bucket=rows.getString(0),generation=rows.getString(1);int revision=rows.getInt(2),cellCount=rows.getInt(3);try(DriveSenseSpeedArchiveRepository.Descriptor descriptor=speed.openRevision(bucket,generation,revision)){if(descriptor==null)throw new IllegalStateException("Export speed revision unavailable");JSONObject meta=new JSONObject();meta.put("bucketId",bucket);meta.put("speedGeneration",generation);meta.put("revision",revision);meta.put("cellCount",cellCount);meta.put("payloadBytes",descriptor.payloadBytes);meta.put("payloadHash",DriveSenseEnvelopeCrypto.hex(descriptor.payloadHash));meta.put("chunkCount",descriptor.chunkCount);frame=writeFrame(output,outputDigest,key,headerHash,3,frame,meta.toString().getBytes(StandardCharsets.UTF_8));for(int index=0;index<descriptor.chunkCount;index++){checkCancelled(op);byte[]plain=speed.read(descriptor,index);try{frame=writeFrame(output,outputDigest,key,headerHash,4,frame,plain);}finally{Arrays.fill(plain,(byte)0);}}}op.completedItems++;}}
                op.phase="PORTABLE_DOMAINS";java.util.List<DriveSensePortableBackupDomains.Record> domains=new DriveSensePortableBackupDomains(context).snapshot();
                try{for(DriveSensePortableBackupDomains.Record domain:domains){checkCancelled(op);JSONObject meta=new JSONObject();meta.put("domainId",domain.domainId);meta.put("payloadBytes",domain.bytes.length);meta.put("payloadHash",DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(domain.bytes)));meta.put("chunkCount",Math.max(1,(domain.bytes.length+MAX_FRAME-1)/MAX_FRAME));frame=writeFrame(output,outputDigest,key,headerHash,5,frame,meta.toString().getBytes(StandardCharsets.UTF_8));if(domain.bytes.length==0){frame=writeFrame(output,outputDigest,key,headerHash,6,frame,new byte[0]);}else for(int offset=0;offset<domain.bytes.length;offset+=MAX_FRAME){int end=Math.min(domain.bytes.length,offset+MAX_FRAME);byte[]slice=Arrays.copyOfRange(domain.bytes,offset,end);try{frame=writeFrame(output,outputDigest,key,headerHash,6,frame,slice);}finally{Arrays.fill(slice,(byte)0);}}op.completedItems++;}}
                finally{for(DriveSensePortableBackupDomains.Record domain:domains)domain.clear();}
                op.phase="FINALIZING";byte[]digest=outputDigest.digest();byte[]trailer=trailer(snapshot,digest,key,domains.size());writeFrame(output,null,key,headerHash,127,frame,trailer);Arrays.fill(digest,(byte)0);Arrays.fill(trailer,(byte)0);output.flush();raw.getFD().sync();}
            testPoint("BEFORE_EXPORT_FINAL_VERIFY",op);verify(op.partial,key);testPoint("AFTER_EXPORT_FINAL_VERIFY",op);if(op.output.exists()&&!op.output.delete())throw new IllegalStateException("Could not replace prior backup output");if(!op.partial.renameTo(op.output))throw new IllegalStateException("Could not publish verified backup");DriveSenseArchiveSentinelStore.fsyncDirectory(op.output.getParentFile());op.phase="COMPLETE";op.verified=true;
        }catch(Cancelled cancelled){op.phase="CANCELLED";cleanupPartial(op);}catch(Throwable error){op.phase="FAILED";op.error=safe(error);cleanupPartial(op);DriveSenseDurabilityJournal.record(context,"ERROR","BACKUP_V2_FAILED",op.id,op.completedItems,op.completedBytes,0,"HEALTHY");}finally{if(op.passphrase!=null)Arrays.fill(op.passphrase,'\0');if(key!=null)Arrays.fill(key,(byte)0);op.leaseClosed=releaseLeaseAndProveAbsent(op.id);op.done=true;}}

    private void runRestore(Operation op){runRestore(op,true);}
    private void runRestore(Operation op,boolean publishDone){try{op.phase="VERIFYING";testPoint("BEFORE_RESTORE_VERIFY",op);JSONObject result=new DriveSenseStreamBackupRestore(trips,speed).restore(op.output,op.passphrase,()->checkCancelled(op));op.passphrase=null;op.result=result;op.completedItems=result.optLong("tripCount")+result.optLong("speedBucketCount")+result.optLong("portableDomainCount");op.phase="COMPLETE";op.verified=true;}catch(Cancelled cancelled){op.phase="CANCELLED";}catch(Throwable error){op.phase="FAILED";op.error=safe(error);}finally{if(publishDone){if(op.passphrase!=null)Arrays.fill(op.passphrase,'\0');if(op.deleteInputWhenDone&&op.output.exists())op.output.delete();op.done=true;}}}

    private void runRestoreFromUri(Operation op,Uri uri){
        byte[]buffer=new byte[256*1024];
        try{
            op.phase="STAGING_INPUT";
            long available=DriveSenseStorageAdmission.availableBytes(context),written=0;
            try(InputStream input=context.getContentResolver().openInputStream(uri);FileOutputStream output=new FileOutputStream(op.output,false)){
                if(input==null)throw new IllegalArgumentException("Portable backup URI is unreadable");
                int read;
                while((read=input.read(buffer))!=-1){
                    checkCancelled(op);
                    testPoint("RESTORE_PROVIDER_CHUNK",op);
                    written+=read;
                    if(available-written<RESTORE_SPACE_RESERVE_BYTES)throw new IllegalStateException("LOW_SPACE_BLOCKED");
                    output.write(buffer,0,read);op.completedBytes=written;
                }
                output.flush();output.getFD().sync();
            }
            checkCancelled(op);
            DriveSenseArchiveSentinelStore.fsyncDirectory(op.output.getParentFile());
            runRestore(op,false);
        }catch(Cancelled cancelled){op.phase="CANCELLED";cleanupPartial(op);}
        catch(Throwable error){op.phase="FAILED";op.error=safe(error);cleanupPartial(op);}
        finally{
            Arrays.fill(buffer,(byte)0);
            if(!op.verified&&op.passphrase!=null){Arrays.fill(op.passphrase,'\0');op.passphrase=null;}
            if(op.output.exists())op.output.delete();
            op.done=true;
        }
    }

    private Snapshot snapshot()throws Exception{return coordinator.read(db->{try(Cursor trip=db.rawQuery("SELECT archive_generation,last_committed_seq FROM archive_meta WHERE id=1",null);Cursor road=db.rawQuery("SELECT speed_generation,last_seq FROM speed_state WHERE id=1",null)){if(!trip.moveToFirst()||!road.moveToFirst())throw new IllegalStateException("Backup snapshot unavailable");return new Snapshot(trip.getString(0),trip.getLong(1),road.getString(0),road.getLong(1));}});}
    private void admitExport(Snapshot snapshot)throws Exception{
        long payloadBytes=coordinator.read(db->{long tripBytes,speedBytes;
            try(Cursor c=db.rawQuery("SELECT COALESCE(SUM(plaintext_bytes),0) FROM trip_revisions WHERE seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED')",new String[]{Long.toString(snapshot.tripSeq),Long.toString(snapshot.tripSeq)})){c.moveToFirst();tripBytes=c.getLong(0);}
            try(Cursor c=db.rawQuery("SELECT COALESCE(SUM(payload_bytes),0) FROM speed_buckets WHERE updated_seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED')",new String[]{Long.toString(snapshot.speedSeq),Long.toString(snapshot.speedSeq)})){c.moveToFirst();speedBytes=c.getLong(0);}
            return Math.addExact(tripBytes,speedBytes);
        });
        long framing=Math.max(8L*1024L*1024L,payloadBytes/6L);
        long required;
        try{required=Math.addExact(Math.addExact(payloadBytes,framing),RESTORE_SPACE_RESERVE_BYTES);}catch(ArithmeticException overflow){throw new IllegalStateException("LOW_SPACE_BLOCKED");}
        if(DriveSenseStorageAdmission.availableBytes(context)<required)throw new IllegalStateException("LOW_SPACE_BLOCKED");
    }
    private void createLease(String id,Snapshot snapshot)throws Exception{coordinator.write(db->{ContentValues value=new ContentValues();value.put("lease_id",id);value.put("archive_generation",snapshot.archiveGeneration);value.put("through_seq",snapshot.tripSeq);value.put("speed_generation",snapshot.speedGeneration);value.put("speed_through_seq",snapshot.speedSeq);value.put("state","ACTIVE");value.put("owner_token",id);value.put("created_at_ms",System.currentTimeMillis());value.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("export_leases",null,value);return null;});}
    private boolean releaseLeaseAndProveAbsent(String id){try{coordinator.write(db->{db.delete("export_leases","lease_id=?",new String[]{id});return null;});return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM export_leases WHERE lease_id=? LIMIT 1",new String[]{id})){return !c.moveToFirst();}});}catch(Exception ignored){return false;}}
    private long writeFrame(DataOutputStream output,MessageDigest digest,byte[]key,byte[]headerHash,int type,long index,byte[]plain)throws Exception{
        if(plain.length>MAX_FRAME)throw new IllegalStateException("Backup frame exceeded bound");
        byte[]nonce=java.nio.ByteBuffer.allocate(12).putInt(0).putLong(index).array();
        byte[]previous=frameChain.get();
        byte[]aad=DriveSenseEnvelopeCrypto.encode("roadsage.stream.backup.frame.v2",DriveSenseEnvelopeCrypto.hex(headerHash),Integer.toString(type),Long.toString(index),Integer.toString(plain.length),DriveSenseEnvelopeCrypto.hex(previous));
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aad);
        byte[]encrypted=cipher.doFinal(plain);java.io.ByteArrayOutputStream buffer=new java.io.ByteArrayOutputStream(encrypted.length+32);
        try(DataOutputStream frame=new DataOutputStream(buffer)){frame.writeInt(type);frame.writeLong(index);frame.writeInt(nonce.length);frame.writeInt(encrypted.length);frame.write(nonce);frame.write(encrypted);}
        byte[]encoded=buffer.toByteArray();output.write(encoded);if(digest!=null)digest.update(encoded);frameChain.set(MessageDigest.getInstance("SHA-256").digest(encoded));
        Arrays.fill(encrypted,(byte)0);Arrays.fill(encoded,(byte)0);return index+1;
    }
    private byte[]trailer(Snapshot snapshot,byte[]rollingHash,byte[]key,long domainCount)throws Exception{
        long[]counts=coordinator.read(db->{
            long tripCount,speedCount;
            try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM trip_revisions WHERE seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED')",new String[]{Long.toString(snapshot.tripSeq),Long.toString(snapshot.tripSeq)})){c.moveToFirst();tripCount=c.getLong(0);}
            try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM speed_buckets WHERE updated_seq<=? AND (retired_seq IS NULL OR retired_seq>?) AND commit_state IN ('COMMITTED','SUPERSEDED')",new String[]{Long.toString(snapshot.speedSeq),Long.toString(snapshot.speedSeq)})){c.moveToFirst();speedCount=c.getLong(0);}
            return new long[]{tripCount,speedCount};
        });
        JSONObject value=new JSONObject();value.put("archiveGeneration",snapshot.archiveGeneration);value.put("throughSeq",snapshot.tripSeq);value.put("speedGeneration",snapshot.speedGeneration);value.put("speedThroughSeq",snapshot.speedSeq);value.put("tripCount",counts[0]);value.put("speedBucketCount",counts[1]);value.put("portableDomainCount",domainCount);value.put("rollingCiphertextHash",DriveSenseEnvelopeCrypto.hex(rollingHash));
        byte[]commitment=value.toString().getBytes(StandardCharsets.UTF_8);javax.crypto.Mac mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(key,"HmacSHA256"));value.put("hmac",DriveSenseEnvelopeCrypto.hex(mac.doFinal(DriveSenseEnvelopeCrypto.encode("roadsage.stream.backup.trailer.v2",DriveSenseEnvelopeCrypto.hex(commitment)))));Arrays.fill(commitment,(byte)0);return value.toString().getBytes(StandardCharsets.UTF_8);
    }
    private void verify(File file,byte[]key)throws Exception{
        try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(file)))){
            byte[]magic=new byte[MAGIC.length];input.readFully(magic);if(!Arrays.equals(magic,MAGIC))throw new SecurityException("Backup magic mismatch");
            int headerLength=input.readInt();if(headerLength<2||headerLength>64*1024)throw new SecurityException("Backup header invalid");
            byte[]header=new byte[headerLength];input.readFully(header);JSONObject headerJson=new JSONObject(new String(header,StandardCharsets.UTF_8));byte[]headerHash=MessageDigest.getInstance("SHA-256").digest(header);
            MessageDigest digest=MessageDigest.getInstance("SHA-256");digest.update(MAGIC);digest.update(intBytes(headerLength));digest.update(header);
            long expectedIndex=0;byte[]previous=new byte[32];DriveSenseStreamBackupRestore.RecordVerifier record=null;
            while(true){
                int type;try{type=input.readInt();}catch(EOFException error){throw new SecurityException("Backup trailer missing");}
                long index=input.readLong();int nonceLength=input.readInt(),cipherLength=input.readInt();
                if(index!=expectedIndex++||nonceLength!=12||cipherLength<16||cipherLength>MAX_FRAME+16)throw new SecurityException("Backup frame invalid");
                byte[]nonce=new byte[nonceLength],ciphertext=new byte[cipherLength];input.readFully(nonce);input.readFully(ciphertext);
                byte[]expectedNonce=java.nio.ByteBuffer.allocate(12).putInt(0).putLong(index).array();if(!Arrays.equals(nonce,expectedNonce))throw new SecurityException("Backup frame nonce mismatch");
                byte[]aad=DriveSenseEnvelopeCrypto.encode("roadsage.stream.backup.frame.v2",DriveSenseEnvelopeCrypto.hex(headerHash),Integer.toString(type),Long.toString(index),Integer.toString(cipherLength-16),DriveSenseEnvelopeCrypto.hex(previous));
                Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aad);byte[]plain=cipher.doFinal(ciphertext);
                if(type==127){if(record!=null){record.verify();record=null;}verifyTrailer(plain,digest.digest(),key,headerJson);if(input.read()!=-1)throw new SecurityException("Backup trailing bytes");Arrays.fill(plain,(byte)0);return;}
                java.io.ByteArrayOutputStream encoded=new java.io.ByteArrayOutputStream(cipherLength+32);try(DataOutputStream frame=new DataOutputStream(encoded)){frame.writeInt(type);frame.writeLong(index);frame.writeInt(nonceLength);frame.writeInt(cipherLength);frame.write(nonce);frame.write(ciphertext);}
                byte[]frameBytes=encoded.toByteArray();digest.update(frameBytes);previous=MessageDigest.getInstance("SHA-256").digest(frameBytes);Arrays.fill(frameBytes,(byte)0);
                if(type==1||type==3||type==5){if(record!=null)record.verify();record=DriveSenseStreamBackupRestore.RecordVerifier.begin(type,new JSONObject(new String(plain,StandardCharsets.UTF_8)));}
                else if(type==2||type==4||type==6){if(record==null||(type==2&&record.type!=1)||(type==4&&record.type!=3)||(type==6&&record.type!=5))throw new SecurityException("Backup frame order invalid");record.append(plain);}
                else throw new SecurityException("Unknown backup frame type");
                Arrays.fill(plain,(byte)0);Arrays.fill(ciphertext,(byte)0);
            }
        }
    }
    private byte[]deriveFileKey(File file,char[]passphrase)throws Exception{
        try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(file)))){
            byte[]magic=new byte[MAGIC.length];input.readFully(magic);if(!Arrays.equals(magic,MAGIC))throw new SecurityException("Backup magic mismatch");
            int headerLength=input.readInt();if(headerLength<2||headerLength>64*1024)throw new SecurityException("Backup header invalid");
            byte[]header=new byte[headerLength];input.readFully(header);JSONObject value=new JSONObject(new String(header,StandardCharsets.UTF_8));
            byte[]salt=Base64.decode(value.getString("salt"),Base64.NO_WRAP);try{return deriveKey(passphrase,salt);}finally{Arrays.fill(salt,(byte)0);Arrays.fill(header,(byte)0);Arrays.fill(passphrase,'\0');}
        }
    }
    private void verifyTrailer(byte[]encoded,byte[]rollingHash,byte[]key,JSONObject header)throws Exception{
        JSONObject trailer=new JSONObject(new String(encoded,StandardCharsets.UTF_8));
        if(!header.optString("archiveGeneration").equals(trailer.optString("archiveGeneration"))||header.optLong("throughSeq")!=trailer.optLong("throughSeq")||!header.optString("speedGeneration").equals(trailer.optString("speedGeneration"))||header.optLong("speedThroughSeq")!=trailer.optLong("speedThroughSeq")||!DriveSenseEnvelopeCrypto.hex(rollingHash).equals(trailer.optString("rollingCiphertextHash"))||trailer.optLong("tripCount",-1)<0||trailer.optLong("speedBucketCount",-1)<0)throw new SecurityException("Backup trailer snapshot mismatch");
        String supplied=trailer.optString("hmac","");trailer.remove("hmac");byte[]commitment=trailer.toString().getBytes(StandardCharsets.UTF_8);javax.crypto.Mac mac=javax.crypto.Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(key,"HmacSHA256"));String expected=DriveSenseEnvelopeCrypto.hex(mac.doFinal(DriveSenseEnvelopeCrypto.encode("roadsage.stream.backup.trailer.v2",DriveSenseEnvelopeCrypto.hex(commitment))));Arrays.fill(commitment,(byte)0);if(!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),supplied.getBytes(StandardCharsets.US_ASCII)))throw new SecurityException("Backup trailer HMAC mismatch");
    }
    static byte[]deriveKey(char[]passphrase,byte[]salt)throws Exception{
        byte[]fixture=testPortableKey;if(fixture!=null)return Arrays.copyOf(fixture,fixture.length);
        java.nio.ByteBuffer encoded=StandardCharsets.UTF_8.encode(CharBuffer.wrap(passphrase));
        byte[]password=new byte[encoded.remaining()];encoded.get(password);
        try{
            Argon2KtResult result=new Argon2Kt().hash(Argon2Mode.ARGON2_ID,password,salt,ARGON2_TIME_COST,ARGON2_MEMORY_KIB);
            String output=result.encodedOutputAsString();
            String raw=output.substring(output.lastIndexOf('$')+1);
            int padding=(4-raw.length()%4)%4;
            byte[]key=java.util.Base64.getDecoder().decode(raw+"=".repeat(padding));
            if(key.length!=32)throw new SecurityException("Argon2id backup key length is invalid");
            return key;
        }finally{Arrays.fill(password,(byte)0);}
    }
    private void checkCancelled(Operation op)throws Cancelled{if(op.cancel.get()||Thread.currentThread().isInterrupted())throw new Cancelled();}
    private void testPoint(String point,Operation op)throws Exception{TestHook hook=testHook;if(hook!=null)hook.onPoint(point,op.id);checkCancelled(op);}
    private void cleanupInterrupted(){File dir=directory();File[]partial=dir.listFiles((d,n)->n.endsWith(".partial"));if(partial!=null)for(File file:partial)file.delete();try{coordinator.write(db->{db.delete("export_leases",null,null);return null;});}catch(Exception ignored){}}
    private void cleanupPartial(Operation op){if(op.partial.exists())op.partial.delete();}
    private static void copy(File source,OutputStream output)throws Exception{try(InputStream input=new FileInputStream(source)){byte[]buffer=new byte[256*1024];int read;while((read=input.read(buffer))!=-1)output.write(buffer,0,read);output.flush();}}
    private static byte[]hashFile(File source)throws Exception{MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(source)){byte[]buffer=new byte[256*1024];int read;while((read=input.read(buffer))!=-1)digest.update(buffer,0,read);}return digest.digest();}
    private File directory(){File dir=new File(context.getNoBackupFilesDir(),"roadsage_stream_backups_v2");if(!dir.exists())dir.mkdirs();return dir;}
    private static String safeFilename(String value){String safe=(value==null?"road-sage-backup":value).replaceAll("[^A-Za-z0-9._-]","_");return safe.length()>96?safe.substring(0,96):safe;}
    private static byte[]intBytes(int value){return java.nio.ByteBuffer.allocate(4).putInt(value).array();}
    private static String safe(Throwable error){String text=error.getClass().getSimpleName()+": "+String.valueOf(error.getMessage());return text.length()>240?text.substring(0,240):text;}
    private static final class Cancelled extends Exception{}
    private static final class Snapshot{final String archiveGeneration,speedGeneration;final long tripSeq,speedSeq;Snapshot(String a,long t,String s,long q){archiveGeneration=a;tripSeq=t;speedGeneration=s;speedSeq=q;}}
    private static final class Operation{final String id,kind;char[]passphrase;final File partial,output;final AtomicBoolean cancel=new AtomicBoolean();volatile String phase="QUEUED",error="";volatile long completedItems,completedBytes;volatile boolean done,verified,deleteInputWhenDone,leaseClosed;volatile JSONObject result;Operation(String i,char[]p,File a,File o){this(i,"BACKUP",p,a,o);}Operation(String i,String k,char[]p,File a,File o){id=i;kind=k;passphrase=p;partial=a;output=o;}JSONObject json()throws Exception{JSONObject value=new JSONObject();value.put("operationId",id);value.put("operationType",kind);value.put("phase",phase);value.put("completedItems",completedItems);value.put("completedBytes",completedBytes);value.put("done",done);value.put("verified",verified);if(done&&leaseClosed)value.put("leaseClosed",true);if(!error.isEmpty())value.put("error",error);if(verified&&"BACKUP".equals(kind))value.put("nativePath",output.getAbsolutePath());if(result!=null)value.put("result",result);value.put("restartPolicy","RESTORE".equals(kind)?"VERIFY_THEN_IMPORT":"RESTART_FROM_ZERO");return value;}}
}
