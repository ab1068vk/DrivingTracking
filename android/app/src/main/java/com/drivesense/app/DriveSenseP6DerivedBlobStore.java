package com.drivesense.app;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.UUID;

/** Bounded encrypted payload helper for rebuildable P6 native state. */
final class DriveSenseP6DerivedBlobStore {
    private DriveSenseP6DerivedBlobStore() {}

    static Prepared prepare(DriveSenseTripArchiveRepository repository,String generation,
                            String domain,String subject,int revision,String contentVersion,
                            int ordinal,byte[] plaintext)throws Exception {
        DriveSenseP6DerivedState.requireDerivedAdmission(
            repository.coordinator().context(),plaintext.length+4096L);
        byte[]hash=DriveSenseEnvelopeCrypto.sha256(plaintext);
        byte[]dek=DriveSenseEnvelopeCrypto.newDek();
        int keyVersion=DriveSenseEnvelopeCrypto.activeKekVersion(repository.coordinator());
        String identity=identity(subject,contentVersion,ordinal);
        DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(
            dek,keyVersion,DriveSenseEnvelopeCrypto.wrapAad(
                generation,domain,identity,revision,hash,keyVersion));
        byte[]nonce=DriveSenseEnvelopeCrypto.newNonce();
        byte[]aad=aad(generation,domain,identity,revision,plaintext.length,hash);
        byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plaintext,dek,nonce,aad).ciphertext;
        Arrays.fill(dek,(byte)0);
        return new Prepared(
            generation,domain,subject,revision,contentVersion,ordinal,
            plaintext.length,cipher,nonce,hash,wrapped.ciphertext,wrapped.nonce,
            keyVersion,DriveSenseEnvelopeCrypto.hex(DriveSenseEnvelopeCrypto.sha256(cipher))+".p6d",
            UUID.randomUUID().toString());
    }

    /** Encrypt an admitted inline row while the caller holds the owner
     * transaction. The KEK version was resolved before entering that write. */
    static Prepared prepareWithKey(String generation,String domain,String subject,int revision,
                                   String contentVersion,int ordinal,byte[]plaintext,
                                   int keyVersion)throws Exception{
        byte[]hash=DriveSenseEnvelopeCrypto.sha256(plaintext);
        byte[]dek=DriveSenseEnvelopeCrypto.newDek();
        String identity=identity(subject,contentVersion,ordinal);
        DriveSenseEnvelopeCrypto.WrappedDek wrapped=DriveSenseEnvelopeCrypto.wrapDek(
            dek,keyVersion,DriveSenseEnvelopeCrypto.wrapAad(
                generation,domain,identity,revision,hash,keyVersion));
        byte[]nonce=DriveSenseEnvelopeCrypto.newNonce();
        byte[]cipher=DriveSenseEnvelopeCrypto.encrypt(plaintext,dek,nonce,
            aad(generation,domain,identity,revision,plaintext.length,hash)).ciphertext;
        Arrays.fill(dek,(byte)0);
        return new Prepared(generation,domain,subject,revision,contentVersion,ordinal,
            plaintext.length,cipher,nonce,hash,wrapped.ciphertext,wrapped.nonce,keyVersion,"","");
    }

    static void publishFile(Context context,Prepared value)throws Exception {
        File directory=directory(context);
        File target=new File(directory,value.relativePath);
        if(target.isFile()){
            if(!Arrays.equals(Files.readAllBytes(target.toPath()),value.ciphertext))
                throw new SecurityException("P6_DERIVED_FILE_HASH_COLLISION");
            return;
        }
        File temporary=new File(directory,value.operationId+".tmp");
        try(FileOutputStream output=new FileOutputStream(temporary,false)){
            output.write(value.ciphertext);
            output.getFD().sync();
        }
        if(!temporary.renameTo(target))throw new IllegalStateException("P6_DERIVED_FILE_PUBLISH_FAILED");
        DriveSenseArchiveSentinelStore.fsyncDirectory(directory);
    }

    static byte[] readFile(Context context,Prepared value)throws Exception {
        byte[]cipher=Files.readAllBytes(new File(directory(context),value.relativePath).toPath());
        return decrypt(value,cipher);
    }

    static byte[] decrypt(Prepared value,byte[]ciphertext)throws Exception {
        byte[]dek=DriveSenseEnvelopeCrypto.unwrapDek(
            value.wrappedDek,value.wrapNonce,value.keyVersion,
            DriveSenseEnvelopeCrypto.wrapAad(
                value.generation,value.domain,
                identity(value.subject,value.contentVersion,value.ordinal),
                value.revision,value.payloadHash,value.keyVersion));
        try{
            byte[]plain=DriveSenseEnvelopeCrypto.decrypt(
                ciphertext,dek,value.payloadNonce,
                aad(value.generation,value.domain,
                    identity(value.subject,value.contentVersion,value.ordinal),
                    value.revision,value.plaintextBytes,value.payloadHash));
            if(!Arrays.equals(DriveSenseEnvelopeCrypto.sha256(plain),value.payloadHash))
                throw new SecurityException("P6_DERIVED_PAYLOAD_HASH_MISMATCH");
            return plain;
        }finally{Arrays.fill(dek,(byte)0);}
    }

    static boolean deleteFile(Context context,String relativePath){
        if(relativePath==null||relativePath.contains("/")||relativePath.contains("\\")||relativePath.contains(".."))return false;
        File file=new File(directory(context),relativePath);
        try{SecureDeleteHelper.secureWipeFile(file);}
        catch(Exception ignored){if(file.exists())file.delete();}
        return !file.exists();
    }

    private static File directory(Context context){
        File root=new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1");
        File directory=new File(root,"p6_derived");
        if(!directory.exists()&&!directory.mkdirs())throw new IllegalStateException("P6_DERIVED_DIRECTORY_UNAVAILABLE");
        return directory;
    }
    private static String identity(String subject,String version,int ordinal){
        return subject+"|"+version+"|"+ordinal;
    }
    private static byte[]aad(String generation,String domain,String identity,int revision,
                             int plaintextBytes,byte[]hash){
        return DriveSenseEnvelopeCrypto.encode(
            "roadsage.p6.derived.v1",generation,domain,identity,
            Integer.toString(revision),Integer.toString(plaintextBytes),
            DriveSenseEnvelopeCrypto.hex(hash));
    }

    static final class Prepared {
        final String generation,domain,subject,contentVersion,relativePath,operationId;
        final int revision,ordinal,plaintextBytes,keyVersion;
        final byte[]ciphertext,payloadNonce,payloadHash,wrappedDek,wrapNonce;
        Prepared(String generation,String domain,String subject,int revision,
                 String contentVersion,int ordinal,int plaintextBytes,byte[]ciphertext,
                 byte[]payloadNonce,byte[]payloadHash,byte[]wrappedDek,byte[]wrapNonce,
                 int keyVersion,String relativePath,String operationId){
            this.generation=generation;this.domain=domain;this.subject=subject;
            this.revision=revision;this.contentVersion=contentVersion;this.ordinal=ordinal;
            this.plaintextBytes=plaintextBytes;this.ciphertext=ciphertext;
            this.payloadNonce=payloadNonce;this.payloadHash=payloadHash;
            this.wrappedDek=wrappedDek;this.wrapNonce=wrapNonce;this.keyVersion=keyVersion;
            this.relativePath=relativePath;this.operationId=operationId;
        }
    }
}
