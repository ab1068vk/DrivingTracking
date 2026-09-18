package com.drivesense.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.Callable;
import java.util.concurrent.locks.ReentrantReadWriteLock;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class DriveSenseEnvelopeCrypto {
    static final int CURRENT_KEK_VERSION = 1;
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS_PREFIX = "roadsage_archive_kek_v";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final java.util.Map<Integer, SecretKey> TEST_KEKS = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.Set<Integer> RETIRED_KEKS = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /**
     * A final retirement proof must be indivisible from key deletion.  Normal
     * reference creation holds the read side; the proof/delete seam holds the
     * write side.  This is deliberately process-local because every app
     * component runs in the same Android process.
     */
    private static final ReentrantReadWriteLock REFERENCE_EPOCH = new ReentrantReadWriteLock(true);

    private DriveSenseEnvelopeCrypto() {}

    static byte[] newDek() { byte[] dek = new byte[32]; RANDOM.nextBytes(dek); return dek; }
    static byte[] newNonce() { byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce); return nonce; }

    static Encrypted encrypt(byte[] plaintext, byte[] dek, byte[] nonce, byte[] aad) throws Exception {
        if (dek == null || dek.length != 32 || nonce == null || nonce.length != 12) throw new IllegalArgumentException("Invalid AES-GCM material");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        return new Encrypted(nonce, cipher.doFinal(plaintext));
    }

    static byte[] decrypt(byte[] ciphertext, byte[] dek, byte[] nonce, byte[] aad) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(aad);
        return cipher.doFinal(ciphertext);
    }

    static WrappedDek wrapDek(byte[] dek, int kekVersion, byte[] aad) throws Exception {
        return withReferenceCreationFence(() -> {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKek(kekVersion));
            cipher.updateAAD(aad);
            return new WrappedDek(cipher.getIV(), cipher.doFinal(dek), kekVersion);
        });
    }

    static byte[] unwrapDek(byte[] wrapped, byte[] iv, int kekVersion, byte[] aad) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getExistingKek(kekVersion), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad);
        return cipher.doFinal(wrapped);
    }

    static byte[] chunkAad(String generation, String domain, int schemaVersion, String id,
                           int revision, int index, int count, int plaintextLength, byte[] payloadHash) {
        return encode("roadsage.trip.chunk.v1",generation,domain,Integer.toString(schemaVersion),id,
            Integer.toString(revision),Integer.toString(index),Integer.toString(count),
            Integer.toString(plaintextLength),hex(payloadHash));
    }

    static byte[] wrapAad(String generation, String domain, String id, int revision,
                          byte[] payloadHash, int kekVersion) {
        return encode("roadsage.trip.dek.wrap.v1",generation,domain,id,Integer.toString(revision),
            hex(payloadHash),Integer.toString(kekVersion));
    }

    static byte[] speedAad(String generation, String bucketId, int revision, byte[] payloadHash) {
        return encode("roadsage.speed.bucket.v1",generation,"speed_bucket",bucketId,Integer.toString(revision),hex(payloadHash));
    }

    static byte[] sha256(byte[] bytes) throws Exception { return MessageDigest.getInstance("SHA-256").digest(bytes); }

    static byte[] encode(String... values) {
        int size = 0;
        byte[][] encoded = new byte[values.length][];
        for (int i=0;i<values.length;i++) { encoded[i]=(values[i]==null?"":values[i]).getBytes(StandardCharsets.UTF_8); size += 4 + encoded[i].length; }
        ByteBuffer buffer = ByteBuffer.allocate(size);
        for (byte[] value : encoded) { buffer.putInt(value.length); buffer.put(value); }
        return buffer.array();
    }

    static String hex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder out=new StringBuilder(bytes.length*2);
        for(byte value:bytes) out.append(String.format(java.util.Locale.US,"%02x",value&0xff));
        return out.toString();
    }

    private static SecretKey getOrCreateKek(int version) throws Exception {
        if (RETIRED_KEKS.contains(version)) throw new IllegalStateException("Archive KEK version is retired");
        SecretKey testKey = TEST_KEKS.get(version);
        if (testKey != null) return testKey;
        KeyStore store=KeyStore.getInstance(ANDROID_KEYSTORE); store.load(null);
        String alias=ALIAS_PREFIX+version;
        KeyStore.Entry existing=store.getEntry(alias,null);
        if(existing instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry)existing).getSecretKey();
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    private static SecretKey getExistingKek(int version) throws Exception {
        SecretKey testKey = TEST_KEKS.get(version);
        if (testKey != null) return testKey;
        KeyStore store=KeyStore.getInstance(ANDROID_KEYSTORE); store.load(null);
        KeyStore.Entry existing=store.getEntry(ALIAS_PREFIX+version,null);
        if(existing instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry)existing).getSecretKey();
        throw new IllegalStateException("Archive KEK version is unavailable");
    }

    private static boolean deleteKekLocked(int version)throws Exception{RETIRED_KEKS.add(version);if(TEST_KEKS.remove(version)!=null)return true;KeyStore store=KeyStore.getInstance(ANDROID_KEYSTORE);store.load(null);String alias=ALIAS_PREFIX+version;if(!store.containsAlias(alias))return false;store.deleteEntry(alias);return true;}

    static <T> T withReferenceCreationFence(Callable<T> work) throws Exception {
        REFERENCE_EPOCH.readLock().lock();
        try { return work.call(); }
        finally { REFERENCE_EPOCH.readLock().unlock(); }
    }

    /** The caller performs a fresh registry scan and deletion in this fence. */
    static <T> T withRetirementFence(Callable<T> work) throws Exception {
        REFERENCE_EPOCH.writeLock().lock();
        try { return work.call(); }
        finally { REFERENCE_EPOCH.writeLock().unlock(); }
    }

    static boolean deleteKekInsideRetirementFence(int version)throws Exception{
        if(!REFERENCE_EPOCH.isWriteLockedByCurrentThread())throw new IllegalStateException("KEK_RETIREMENT_FENCE_REQUIRED");
        return deleteKekLocked(version);
    }

    /** Package-private deterministic test hook; no plugin or production call path exposes it. */
    static void installTestKek(int version, byte[] key) {
        if (key == null || key.length != 32) throw new IllegalArgumentException("Test KEK must contain 32 bytes");
        RETIRED_KEKS.remove(version);
        TEST_KEKS.put(version, new SecretKeySpec(java.util.Arrays.copyOf(key, key.length), "AES"));
    }

    static void clearTestKeks() { TEST_KEKS.clear(); RETIRED_KEKS.clear(); }

    static int activeKekVersion(DriveSenseStorageCoordinator coordinator)throws Exception{return coordinator.read(db->{try(android.database.Cursor c=db.rawQuery("SELECT target_kek_version FROM rotation_state WHERE id=1 AND phase IN ('REWRAPPING','ZERO_PROOF','COMPLETE')",null)){return c.moveToFirst()?Math.max(CURRENT_KEK_VERSION,c.getInt(0)):CURRENT_KEK_VERSION;}});}

    static final class Encrypted { final byte[] nonce,ciphertext; Encrypted(byte[] n,byte[] c){nonce=n;ciphertext=c;} }
    static final class WrappedDek { final byte[] nonce,ciphertext; final int version; WrappedDek(byte[] n,byte[] c,int v){nonce=n;ciphertext=c;version=v;} }
}
