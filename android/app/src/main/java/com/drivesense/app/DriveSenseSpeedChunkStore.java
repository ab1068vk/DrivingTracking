package com.drivesense.app;

import android.content.Context;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Immutable encrypted chunks for one prefix-4 speed bucket revision. */
final class DriveSenseSpeedChunkStore {
    static final int CHUNK_BYTES=256*1024;
    private static final int MAGIC=0x52535342,FORMAT=1;
    private final Context context;
    DriveSenseSpeedChunkStore(Context context){this.context=context.getApplicationContext();}

    File ingress(String batch,String bucket)throws Exception{File file=new File(tempDirectory(),batch+"."+bucket+".plain.tmp");if(file.exists()&&!file.delete())throw new IllegalStateException("Could not reset speed ingress");return file;}
    List<Plan> plan(File source,byte[]dek,String generation,String bucket,int revision,byte[]payloadHash,String operation)throws Exception{
        long length=source.length();long countLong=Math.max(1L,(length+CHUNK_BYTES-1L)/CHUNK_BYTES);if(countLong>Integer.MAX_VALUE)throw new IllegalStateException("Speed bucket chunk manifest overflow");int count=(int)countLong;List<Plan>plans=new ArrayList<>(count);
        try(RandomAccessFile input=new RandomAccessFile(source,"r")){for(int index=0;index<count;index++){int size=(int)Math.min(CHUNK_BYTES,Math.max(0L,length-(long)index*CHUNK_BYTES));byte[]plain=new byte[size];input.readFully(plain);byte[]nonce=DriveSenseEnvelopeCrypto.newNonce();byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"speed_bucket",1,bucket,revision,index,count,size,payloadHash);byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,nonce,aad).ciphertext;byte[]encoded=encode(nonce,cipher);byte[]hash=DriveSenseEnvelopeCrypto.sha256(encoded);plans.add(new Plan(index,size,cipher.length,nonce,hash,DriveSenseEnvelopeCrypto.hex(hash)+".rssb",operation));Arrays.fill(plain,(byte)0);Arrays.fill(cipher,(byte)0);Arrays.fill(encoded,(byte)0);}}
        return plans;
    }
    void publishVerify(File source,List<Plan>plans,byte[]dek,String generation,String bucket,int revision,byte[]payloadHash)throws Exception{
        try(RandomAccessFile input=new RandomAccessFile(source,"r")){for(Plan plan:plans){byte[]plain=new byte[plan.plaintextBytes];input.readFully(plain);byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"speed_bucket",1,bucket,revision,plan.index,plans.size(),plain.length,payloadHash);byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plain,dek,plan.nonce,aad).ciphertext;byte[]encoded=encode(plan.nonce,cipher);if(!Arrays.equals(plan.ciphertextHash,DriveSenseEnvelopeCrypto.sha256(encoded)))throw new SecurityException("Speed chunk plan changed");File temp=new File(tempDirectory(),plan.operationId+"."+bucket+"."+plan.index+".chunk.tmp");writeSync(temp,encoded);File target=new File(chunkDirectory(),plan.relativePath);if(target.exists()){if(!Arrays.equals(Files.readAllBytes(target.toPath()),encoded))throw new SecurityException("Speed chunk hash collision");temp.delete();}else if(!temp.renameTo(target))throw new IllegalStateException("Could not publish speed chunk");Arrays.fill(plain,(byte)0);Arrays.fill(cipher,(byte)0);Arrays.fill(encoded,(byte)0);}}
        DriveSenseArchiveSentinelStore.fsyncDirectory(chunkDirectory());for(Plan plan:plans){byte[]plain=read(plan,dek,generation,bucket,revision,plans.size(),payloadHash);Arrays.fill(plain,(byte)0);}
    }
    byte[]read(Plan plan,byte[]dek,String generation,String bucket,int revision,int count,byte[]payloadHash)throws Exception{byte[]aad=DriveSenseEnvelopeCrypto.chunkAad(generation,"speed_bucket",1,bucket,revision,plan.index,count,plan.plaintextBytes,payloadHash);File file=new File(chunkDirectory(),plan.relativePath);if(!file.isFile()||file.length()>CHUNK_BYTES+4096L)throw new IllegalStateException("Speed chunk unavailable");try(DataInputStream input=new DataInputStream(new BufferedInputStream(new FileInputStream(file)))){if(input.readInt()!=MAGIC||input.readInt()!=FORMAT)throw new SecurityException("Invalid speed chunk");int n=input.readInt();if(n!=12)throw new SecurityException("Invalid speed nonce");byte[]nonce=new byte[n];input.readFully(nonce);if(!Arrays.equals(nonce,plan.nonce))throw new SecurityException("Speed nonce mismatch");int length=input.readInt();if(length<16||length>CHUNK_BYTES+32)throw new SecurityException("Invalid speed ciphertext");byte[]cipher=new byte[length];input.readFully(cipher);if(input.read()!=-1)throw new SecurityException("Trailing speed bytes");return DriveSenseEnvelopeCrypto.decrypt(cipher,dek,nonce,aad);}}
    void cleanupIngress(File file){try{SecureDeleteHelper.secureWipeFile(file);}catch(Exception ignored){if(file!=null&&file.exists())file.delete();}}
    File file(String relative){return new File(chunkDirectory(),relative);}
    void deleteRelative(String relative){if(relative==null||relative.isEmpty()||relative.contains("..")||relative.contains("/")||relative.contains("\\"))return;File target=file(relative);try{SecureDeleteHelper.secureWipeFile(target);}catch(Exception ignored){if(target.exists())target.delete();}}
    private byte[]encode(byte[]nonce,byte[]cipher)throws Exception{java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream(cipher.length+32);try(DataOutputStream out=new DataOutputStream(bytes)){out.writeInt(MAGIC);out.writeInt(FORMAT);out.writeInt(nonce.length);out.write(nonce);out.writeInt(cipher.length);out.write(cipher);}return bytes.toByteArray();}
    private void writeSync(File file,byte[]bytes)throws Exception{try(FileOutputStream output=new FileOutputStream(file,false)){output.write(bytes);output.getFD().sync();}}
    private File root(){File d=new File(context.getNoBackupFilesDir(),"roadsage_speed_archive_v1");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Speed archive unavailable");return d;}
    private File chunkDirectory(){File d=new File(root(),"chunks");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Speed chunks unavailable");return d;}
    private File tempDirectory(){File d=new File(root(),"temp");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Speed temp unavailable");return d;}
    static final class Plan{final int index,plaintextBytes,ciphertextBytes;final byte[]nonce,ciphertextHash;final String relativePath,operationId;Plan(int i,int p,int c,byte[]n,byte[]h,String r,String o){index=i;plaintextBytes=p;ciphertextBytes=c;nonce=n;ciphertextHash=h;relativePath=r;operationId=o;}}
}
