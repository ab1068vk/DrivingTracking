package com.drivesense.app;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Generation-qualified encrypted-at-rest output owned by one retention job. */
final class DriveSenseRetentionStage {
    static final int CHUNK_BYTES=DriveSenseTripChunkStore.CHUNK_BYTES;
    private static final int MAGIC=0x52535447,VERSION=1;
    private final Context context;

    DriveSenseRetentionStage(Context context){this.context=context.getApplicationContext();}

    void write(String generation,String jobId,int index,byte[]plain,int length,byte[]dek)throws Exception{
        if(index<0||length<0||length>CHUNK_BYTES)throw new IllegalArgumentException("Invalid retention stage chunk");
        File directory=directory(generation);if(!directory.isDirectory()&&!directory.mkdirs())throw new IllegalStateException("RETENTION_STAGE_DIRECTORY_FAILED");
        byte[]nonce=DriveSenseEnvelopeCrypto.newNonce();
        byte[]aad=aad(generation,jobId,index,length);
        byte[]input=Arrays.copyOf(plain,length);
        byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(input,dek,nonce,aad).ciphertext;
        File target=file(generation,jobId,index),temp=new File(directory,target.getName()+".tmp");
        try(FileOutputStream raw=new FileOutputStream(temp,false);DataOutputStream out=new DataOutputStream(new BufferedOutputStream(raw))){
            out.writeInt(MAGIC);out.writeInt(VERSION);out.writeInt(length);out.writeInt(nonce.length);out.write(nonce);out.writeInt(cipher.length);out.write(cipher);out.flush();raw.getFD().sync();
        }
        if(target.exists()){byte[]existing=read(generation,jobId,index,dek);try{if(!Arrays.equals(existing,input))throw new SecurityException("RETENTION_STAGE_REPLAY_MISMATCH");}finally{Arrays.fill(existing,(byte)0);}if(!temp.delete())throw new IllegalStateException("RETENTION_STAGE_TEMP_DELETE_FAILED");}
        else if(!temp.renameTo(target))throw new IllegalStateException("RETENTION_STAGE_PUBLISH_FAILED");
        DriveSenseArchiveSentinelStore.fsyncDirectory(directory);
        byte[]verified=read(generation,jobId,index,dek);try{if(!Arrays.equals(verified,input))throw new SecurityException("RETENTION_STAGE_READBACK_FAILED");}finally{Arrays.fill(verified,(byte)0);Arrays.fill(input,(byte)0);Arrays.fill(cipher,(byte)0);}
    }

    byte[] read(String generation,String jobId,int index,byte[]dek)throws Exception{
        File source=file(generation,jobId,index);
        if(!source.isFile()||source.length()>CHUNK_BYTES+4096L)throw new IllegalStateException("RETENTION_STAGE_CHUNK_MISSING");
        try(DataInputStream in=new DataInputStream(new BufferedInputStream(new FileInputStream(source)))){
            if(in.readInt()!=MAGIC||in.readInt()!=VERSION)throw new SecurityException("RETENTION_STAGE_FORMAT_INVALID");
            int plain=in.readInt(),nonceLength=in.readInt();if(plain<0||plain>CHUNK_BYTES||nonceLength!=12)throw new SecurityException("RETENTION_STAGE_HEADER_INVALID");
            byte[]nonce=new byte[nonceLength];in.readFully(nonce);int cipherLength=in.readInt();if(cipherLength!=plain+16)throw new SecurityException("RETENTION_STAGE_LENGTH_INVALID");
            byte[]cipher=new byte[cipherLength];in.readFully(cipher);if(in.read()!=-1)throw new SecurityException("RETENTION_STAGE_TRAILING_BYTES");
            return DriveSenseEnvelopeCrypto.decrypt(cipher,dek,nonce,aad(generation,jobId,index,plain));
        }
    }

    long encodedBytes(String generation,String jobId,int index){File value=file(generation,jobId,index);return value.isFile()?value.length():0L;}

    void deleteExact(String generation,String jobId,int count){for(int i=0;i<count;i++){File value=file(generation,jobId,i);try{SecureDeleteHelper.secureWipeFile(value);}catch(Exception ignored){if(value.exists())value.delete();}}}
    boolean deleteOne(String generation,String jobId,int index){File value=file(generation,jobId,index);try{SecureDeleteHelper.secureWipeFile(value);}catch(Exception ignored){if(value.exists())value.delete();}return !value.exists();}

    static String debtPath(String generation,String jobId,int index){return "rstg:"+safe(generation)+":"+safe(jobId)+":"+index;}
    boolean deleteDebt(String opaque){String[]parts=opaque==null?new String[0]:opaque.split(":",4);if(parts.length!=4||!"rstg".equals(parts[0]))throw new IllegalArgumentException("Invalid retention stage debt");int index=Integer.parseInt(parts[3]);File value=file(parts[1],parts[2],index);try{SecureDeleteHelper.secureWipeFile(value);}catch(Exception ignored){if(value.exists())value.delete();}return !value.exists();}
    long debtBytes(String opaque){String[]parts=opaque==null?new String[0]:opaque.split(":",4);if(parts.length!=4||!"rstg".equals(parts[0]))return 0L;File value=file(parts[1],parts[2],Integer.parseInt(parts[3]));return value.isFile()?value.length():0L;}

    private File directory(String generation){return new File(new File(context.getNoBackupFilesDir(),"roadsage-p5-retention"),safe(generation));}
    private File file(String generation,String job,int index){return new File(directory(generation),safe(job)+"."+index+".rstg");}
    // ':' is reserved by the opaque debt encoding and is intentionally not an
    // identity character. Production generations and jobs are UUIDs.
    private static String safe(String value){String text=value==null?"":value;if(!text.matches("[A-Za-z0-9._-]{1,160}"))throw new IllegalArgumentException("Invalid retention stage identity");return text;}
    private static byte[]aad(String generation,String job,int index,int length){byte[]g=generation.getBytes(StandardCharsets.UTF_8),j=job.getBytes(StandardCharsets.UTF_8);return ByteBuffer.allocate(4+g.length+4+j.length+8).putInt(g.length).put(g).putInt(j.length).put(j).putInt(index).putInt(length).array();}
}
