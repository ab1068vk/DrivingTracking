package com.drivesense.app;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

final class DriveSenseTripChunkStore {
    private static volatile String testFaultPoint;
    static final int CHUNK_BYTES = 256 * 1024;
    private static final int MAGIC = 0x52535443;
    private static final int FORMAT_VERSION = 1;
    private final Context context;

    DriveSenseTripChunkStore(Context context) { this.context=context.getApplicationContext(); }

    File createPlaintextSpool(String operationId) throws Exception {
        File directory = tempDirectory();
        File file = new File(directory, operationId + ".plain.tmp");
        if(file.exists()&&!file.delete()) throw new IllegalStateException("Could not reset trip spool");
        return file;
    }

    List<ChunkPlan> plan(File spool, byte[] dek, String generation, String tripId, int revision,
                         byte[] payloadHash, String operationId) throws Exception {
        long length=spool.length();
        int count=(int)Math.max(1L,(length+CHUNK_BYTES-1L)/CHUNK_BYTES);
        List<ChunkPlan> plans=new ArrayList<>(count);
        try(RandomAccessFile input=new RandomAccessFile(spool,"r")) {
            for(int index=0;index<count;index++) {
                int size=(int)Math.min(CHUNK_BYTES,Math.max(0L,length-(long)index*CHUNK_BYTES));
                byte[] plain=new byte[size]; input.readFully(plain);
                byte[] nonce=DriveSenseEnvelopeCrypto.newNonce();
                byte[] aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_payload",1,tripId,revision,index,count,size,payloadHash);
                byte[] cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,nonce,aad).ciphertext;
                byte[] hash=DriveSenseEnvelopeCrypto.sha256(fileBytes(nonce,cipher));
                String relative=DriveSenseEnvelopeCrypto.hex(hash)+".rstc";
                plans.add(new ChunkPlan(index,size,nonce,hash,relative,cipher.length,operationId));
                java.util.Arrays.fill(plain,(byte)0); java.util.Arrays.fill(cipher,(byte)0);
            }
        }
        return plans;
    }

    /**
     * Creates a bounded streaming plan before any payload bytes are written.
     * The placeholder hashes are replaced only after each immutable chunk has
     * been encrypted, fsynced and published. This lets the catalog enter
     * PENDING before filesystem mutation without requiring a plaintext spool.
     */
    List<ChunkPlan> planStreaming(long plaintextBytes, String operationId) {
        if (plaintextBytes <= 0L) throw new IllegalArgumentException("Trip payload stream is empty");
        long countLong=(plaintextBytes+CHUNK_BYTES-1L)/CHUNK_BYTES;
        if(countLong>Integer.MAX_VALUE)throw new IllegalArgumentException("Trip payload has too many chunks");
        int count=(int)Math.max(1L,countLong);
        List<ChunkPlan> plans=new ArrayList<>(count);
        for(int index=0;index<count;index++){
            int size=(int)Math.min(CHUNK_BYTES,plaintextBytes-(long)index*CHUNK_BYTES);
            byte[] nonce=DriveSenseEnvelopeCrypto.newNonce();
            String relative=operationId+"."+index+".rstc";
            plans.add(new ChunkPlan(index,size,nonce,new byte[32],relative,size+16,operationId));
        }
        return plans;
    }

    List<ChunkPlan> planVariable(List<Integer> plaintextSizes,String operationId){
        if(plaintextSizes==null||plaintextSizes.isEmpty())throw new IllegalArgumentException("Trip payload stream is empty");
        List<ChunkPlan>plans=new ArrayList<>(plaintextSizes.size());
        for(int index=0;index<plaintextSizes.size();index++){
            int size=plaintextSizes.get(index);if(size<1||size>CHUNK_BYTES)throw new IllegalArgumentException("Invalid streamed chunk size");
            plans.add(new ChunkPlan(index,size,DriveSenseEnvelopeCrypto.newNonce(),new byte[32],operationId+"."+index+".rstc",size+16,operationId));
        }
        return plans;
    }

    ChunkPlan planVariableOne(int index,int count,int plaintextBytes,String operationId){
        if(index<0||index>=count||plaintextBytes<1||plaintextBytes>CHUNK_BYTES)throw new IllegalArgumentException("Invalid streamed chunk descriptor");
        return new ChunkPlan(index,plaintextBytes,DriveSenseEnvelopeCrypto.newNonce(),new byte[32],operationId+"."+index+".rstc",plaintextBytes+16,operationId);
    }

    ChunkPlan writePublishVerifyOne(byte[]plain,ChunkPlan prior,byte[]dek,String generation,String tripId,int revision,int count,byte[]payloadHash)throws Exception{
        if(plain==null||plain.length!=prior.plaintextBytes||plain.length>CHUNK_BYTES)throw new IllegalArgumentException("Trip stream chunk length changed");
        byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_payload",1,tripId,revision,prior.index,count,plain.length,payloadHash);
        byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,prior.nonce,aad).ciphertext;
        byte[]encoded=fileBytes(prior.nonce,cipher),hash=DriveSenseEnvelopeCrypto.sha256(encoded);
        ChunkPlan actual=new ChunkPlan(prior.index,plain.length,prior.nonce,hash,prior.relativePath,cipher.length,prior.operationId);
        File temporary=new File(tempDirectory(),actual.operationId+"."+actual.index+".chunk.tmp");writeSync(temporary,encoded);
        File target=new File(chunkDirectory(),actual.relativePath);
        if(target.exists()){
            if(!java.util.Arrays.equals(Files.readAllBytes(target.toPath()),encoded))throw new SecurityException("Retention canonical chunk replay mismatch");
            if(!temporary.delete())throw new IllegalStateException("Retention canonical temp cleanup failed");
        }else if(!temporary.renameTo(target))throw new IllegalStateException("Could not publish retention chunk");
        DriveSenseArchiveSentinelStore.fsyncDirectory(chunkDirectory());
        byte[]verified=readChunk(actual,dek,generation,tripId,revision,count,payloadHash);try{if(!java.util.Arrays.equals(plain,verified))throw new SecurityException("Retention canonical readback failed");}finally{java.util.Arrays.fill(verified,(byte)0);java.util.Arrays.fill(cipher,(byte)0);java.util.Arrays.fill(encoded,(byte)0);}
        return actual;
    }

    /** Streams a repeatable source directly into canonical encrypted chunks. */
    StreamResult writePublishVerifyStream(StreamProducer producer,List<ChunkPlan> plans,byte[] dek,
                                          String generation,String tripId,int revision,byte[] payloadHash)throws Exception{
        if(producer==null||plans==null||plans.isEmpty())throw new IllegalArgumentException("Trip stream plan unavailable");
        StreamingChunkOutput sink=new StreamingChunkOutput(plans,dek,generation,tripId,revision,payloadHash);
        StreamSourceResult source;
        try{
            source=producer.writeTo(sink);
            sink.finish();
        }finally{
            sink.close();
        }
        if(sink.totalBytes!=source.plaintextBytes)throw new SecurityException("Trip stream byte count changed");
        // The producer is the authenticated journal reader: it computes and
        // verifies its digest against the durable manifest while delivering
        // these exact bytes. Byte count below proves the sink accepted the
        // complete stream; re-hashing inside the chunk sink would only repeat
        // that authenticated check.
        DriveSenseArchiveSentinelStore.fsyncDirectory(chunkDirectory());
        maybeFault("AFTER_DIRECTORY_FSYNC");
        for(ChunkPlan plan:plans){byte[] verified=readChunk(plan,dek,generation,tripId,revision,plans.size(),payloadHash);java.util.Arrays.fill(verified,(byte)0);}
        maybeFault("AFTER_AUTHENTICATED_READBACK");
        return new StreamResult(source,sink.maximumBufferedBytes);
    }

    void writePublishVerify(File spool,List<ChunkPlan> plans,byte[] dek,String generation,
                            String tripId,int revision,byte[] payloadHash) throws Exception {
        File directory=chunkDirectory();
        try(RandomAccessFile input=new RandomAccessFile(spool,"r")) {
            for(ChunkPlan plan:plans) {
                byte[] plain=new byte[plan.plaintextBytes]; input.readFully(plain);
                byte[] aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_payload",1,tripId,revision,
                    plan.index,plans.size(),plain.length,payloadHash);
                byte[] cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,plan.nonce,aad).ciphertext;
                byte[] encoded=fileBytes(plan.nonce,cipher);
                if(!java.util.Arrays.equals(DriveSenseEnvelopeCrypto.sha256(encoded),plan.ciphertextHash)) throw new IllegalStateException("Chunk plan changed");
                File temp=new File(tempDirectory(),plan.operationId+"."+plan.index+".chunk.tmp");
                writeSync(temp,encoded);
                File target=new File(directory,plan.relativePath);
                if(target.exists()) {
                    if(!java.util.Arrays.equals(Files.readAllBytes(target.toPath()),encoded)) throw new IllegalStateException("Chunk hash collision");
                    temp.delete();
                } else if(!temp.renameTo(target)) throw new IllegalStateException("Could not publish trip chunk");
                java.util.Arrays.fill(plain,(byte)0); java.util.Arrays.fill(cipher,(byte)0); java.util.Arrays.fill(encoded,(byte)0);
            }
        }
        DriveSenseArchiveSentinelStore.fsyncDirectory(directory);
        for(ChunkPlan plan:plans) {
            byte[] verified=readChunk(plan,dek,generation,tripId,revision,plans.size(),payloadHash);
            java.util.Arrays.fill(verified,(byte)0);
        }
    }

    OverviewPlan writeOverview(byte[] plaintext,byte[] dek,String generation,String tripId,int revision,
                               byte[] payloadHash,String operationId) throws Exception {
        if(plaintext==null||plaintext.length==0) return null;
        byte[] nonce=DriveSenseEnvelopeCrypto.newNonce();
        byte[] aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_overview",1,tripId,revision,0,1,plaintext.length,payloadHash);
        byte[] cipher=DriveSenseEnvelopeCrypto.encrypt(plaintext,dek,nonce,aad).ciphertext;
        byte[] encoded=fileBytes(nonce,cipher);
        byte[] hash=DriveSenseEnvelopeCrypto.sha256(encoded);
        String relative=DriveSenseEnvelopeCrypto.hex(hash)+".overview.rstc";
        File temp=new File(tempDirectory(),operationId+".overview.tmp"); writeSync(temp,encoded);
        File target=new File(chunkDirectory(),relative);
        if(!target.exists()&&!temp.renameTo(target)) throw new IllegalStateException("Could not publish overview");
        if(temp.exists()) temp.delete();
        DriveSenseArchiveSentinelStore.fsyncDirectory(chunkDirectory());
        byte[] decoded=readEncoded(target,dek,nonce,aad);
        if(!java.util.Arrays.equals(decoded,plaintext)) throw new IllegalStateException("Overview verification failed");
        return new OverviewPlan(relative,hash,nonce,plaintext.length,cipher.length);
    }

    byte[] readChunk(ChunkPlan plan,byte[] dek,String generation,String tripId,int revision,int count,byte[] payloadHash) throws Exception {
        File file=new File(chunkDirectory(),plan.relativePath);
        byte[] aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_payload",1,tripId,revision,plan.index,count,plan.plaintextBytes,payloadHash);
        return readEncoded(file,dek,plan.nonce,aad);
    }

    byte[] readRelative(String relative,byte[] dek,byte[] nonce,byte[] aad) throws Exception {
        return readEncoded(new File(chunkDirectory(),relative),dek,nonce,aad);
    }

    File relativeFile(String relative) { return new File(chunkDirectory(),relative); }
    /** Directory handle for the explicit fixed-memory audit owner only. */
    File inventoryDirectory(){return chunkDirectory();}
    void deleteRelative(String relative) {
        if (relative == null || relative.isEmpty() || relative.contains("..") || relative.contains("/") || relative.contains("\\")) return;
        File file = new File(chunkDirectory(), relative);
        try { SecureDeleteHelper.secureWipeFile(file); }
        catch (Exception ignored) { if (file.exists()) file.delete(); }
    }
    void deleteOwnedTemp(String operationId) { File[] files=tempDirectory().listFiles((d,n)->n.startsWith(operationId+".")); if(files!=null)for(File f:files)f.delete(); }

    private byte[] readEncoded(File file,byte[] dek,byte[] expectedNonce,byte[] aad) throws Exception {
        long maximumPlaintext=Math.max(CHUNK_BYTES,DriveSenseTripOverviewBuilder.MAX_PLAINTEXT_BYTES);
        if(!file.isFile()||file.length()>maximumPlaintext+4096L) throw new IllegalStateException("Chunk unavailable or oversized");
        try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            if(input.readInt()!=MAGIC||input.readInt()!=FORMAT_VERSION) throw new IllegalStateException("Invalid chunk header");
            int nonceLength=input.readInt(); if(nonceLength!=12) throw new IllegalStateException("Invalid chunk nonce");
            byte[] nonce=new byte[nonceLength]; input.readFully(nonce);
            if(!java.util.Arrays.equals(nonce,expectedNonce)) throw new IllegalStateException("Chunk nonce mismatch");
            int length=input.readInt(); if(length<16||length>maximumPlaintext+32) throw new IllegalStateException("Invalid chunk length");
            byte[] cipher=new byte[length]; input.readFully(cipher);
            if(input.read()!=-1) throw new IllegalStateException("Trailing chunk bytes");
            return DriveSenseEnvelopeCrypto.decrypt(cipher,dek,nonce,aad);
        }
    }
    private byte[] fileBytes(byte[] nonce,byte[] cipher) throws Exception {
        java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream(cipher.length+32);
        try(DataOutputStream output=new DataOutputStream(bytes)) { output.writeInt(MAGIC); output.writeInt(FORMAT_VERSION); output.writeInt(nonce.length); output.write(nonce); output.writeInt(cipher.length); output.write(cipher); }
        return bytes.toByteArray();
    }
    static void setFaultPointForTests(String point){testFaultPoint=point;}
    private static void maybeFault(String point){if(point.equals(testFaultPoint)){testFaultPoint=null;throw new IllegalStateException("TEST_FAULT_"+point);}}
    private static void writePartialTempAndFault(File file,byte[]bytes)throws Exception{
        if(!"PARTIAL_TEMP".equals(testFaultPoint))return;
        testFaultPoint=null;
        try(FileOutputStream output=new FileOutputStream(file,false)){
            output.write(bytes,0,Math.max(1,bytes.length/2));
            output.getFD().sync();
        }
        throw new IllegalStateException("TEST_FAULT_PARTIAL_TEMP");
    }
    private void writeSync(File file,byte[] bytes) throws Exception { try(FileOutputStream output=new FileOutputStream(file,false)){output.write(bytes);output.getFD().sync();} }
    private File root(){File d=new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Archive directory unavailable");return d;}
    private File chunkDirectory(){File d=new File(root(),"chunks");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Chunk directory unavailable");return d;}
    private File tempDirectory(){File d=new File(root(),"temp");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Temp directory unavailable");return d;}

    static final class ChunkPlan {
        final int index,plaintextBytes,ciphertextBytes; final byte[] nonce,ciphertextHash; final String relativePath,operationId;
        ChunkPlan(int i,int p,byte[] n,byte[] h,String r,int c,String o){index=i;plaintextBytes=p;nonce=n;ciphertextHash=h;relativePath=r;ciphertextBytes=c;operationId=o;}
    }
    static final class OverviewPlan { final String relativePath; final byte[] hash,nonce; final int plaintextBytes,ciphertextBytes; OverviewPlan(String r,byte[] h,byte[] n,int p,int c){relativePath=r;hash=h;nonce=n;plaintextBytes=p;ciphertextBytes=c;} }

    interface StreamProducer { StreamSourceResult writeTo(OutputStream output)throws Exception; }
    static final class StreamSourceResult {
        final long plaintextBytes; final String sha256;
        StreamSourceResult(long bytes,String hash){plaintextBytes=bytes;sha256=hash;}
    }
    static final class StreamResult {
        final StreamSourceResult source; final int maximumBufferedBytes;
        StreamResult(StreamSourceResult s,int max){source=s;maximumBufferedBytes=max;}
    }

    private final class StreamingChunkOutput extends OutputStream {
        private final List<ChunkPlan> plans; private final byte[]dek,payloadHash; private final String generation,tripId; private final int revision;
        private final byte[]buffer=new byte[CHUNK_BYTES]; private int buffered,index,maximumBufferedBytes; private long totalBytes;
        private boolean finished;
        StreamingChunkOutput(List<ChunkPlan> p,byte[]d,String g,String id,int r,byte[]h){plans=p;dek=d;generation=g;tripId=id;revision=r;payloadHash=h;}
        @Override public void write(int value)throws java.io.IOException{byte[]one={(byte)value};write(one,0,1);}
        @Override public void write(byte[]source,int offset,int length)throws java.io.IOException{
            if(finished)throw new java.io.IOException("Trip stream already finished");
            if(source==null||offset<0||length<0||offset+length>source.length)throw new IndexOutOfBoundsException();
            int cursor=offset,remaining=length;
            while(remaining>0){int take=Math.min(remaining,buffer.length-buffered);System.arraycopy(source,cursor,buffer,buffered,take);buffered+=take;totalBytes+=take;maximumBufferedBytes=Math.max(maximumBufferedBytes,buffered);cursor+=take;remaining-=take;if(buffered==buffer.length){try{publish();}catch(Exception error){throw new java.io.IOException(error);}}}
        }
        void finish()throws Exception{if(finished)return;if(buffered>0)publish();finished=true;if(index!=plans.size())throw new IllegalStateException("Trip stream ended before planned chunks");}
        private void publish()throws Exception{
            if(index>=plans.size())throw new IllegalStateException("Trip stream exceeded planned chunks");
            ChunkPlan prior=plans.get(index);if(buffered!=prior.plaintextBytes)throw new IllegalStateException("Trip stream chunk length changed");
            byte[]plain=java.util.Arrays.copyOf(buffer,buffered);
            byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"trip_payload",1,tripId,revision,index,plans.size(),plain.length,payloadHash);
            byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,prior.nonce,aad).ciphertext;
            byte[]encoded=fileBytes(prior.nonce,cipher);byte[]hash=DriveSenseEnvelopeCrypto.sha256(encoded);
            ChunkPlan actual=new ChunkPlan(index,plain.length,prior.nonce,hash,prior.relativePath,cipher.length,prior.operationId);
            File temporary=new File(tempDirectory(),actual.operationId+"."+actual.index+".chunk.tmp");
            writePartialTempAndFault(temporary,encoded);
            writeSync(temporary,encoded);
            maybeFault("AFTER_FILE_FSYNC");
            File target=new File(chunkDirectory(),actual.relativePath);
            if(target.exists())throw new IllegalStateException("Streaming chunk target already exists");
            maybeFault("DURING_RENAME");
            if(!temporary.renameTo(target))throw new IllegalStateException("Could not publish streaming trip chunk");
            maybeFault("AFTER_RENAME_BEFORE_DIRECTORY_FSYNC");
            plans.set(index,actual);java.util.Arrays.fill(buffer,0,buffered,(byte)0);java.util.Arrays.fill(plain,(byte)0);java.util.Arrays.fill(cipher,(byte)0);java.util.Arrays.fill(encoded,(byte)0);buffered=0;index+=1;
        }
        @Override public void close(){java.util.Arrays.fill(buffer,(byte)0);}
    }
}
