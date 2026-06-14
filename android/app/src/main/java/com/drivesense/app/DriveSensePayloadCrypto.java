package com.drivesense.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class DriveSensePayloadCrypto {
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "drivesense_gps_key_v1";
    private static final String ROTATING_KEY_ALIAS_PREFIX = "drivesense_gps_payload_key_v";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int TAG_LENGTH_BITS = 128;
    private static final String STORED_PREFIX = "enc:v1:";

    private DriveSensePayloadCrypto() {}

    private static String aliasForVersion(int keyVersion) {
        return keyVersion <= 0 ? KEY_ALIAS : ROTATING_KEY_ALIAS_PREFIX + keyVersion;
    }

    private static SecretKey getOrCreateKey(int keyVersion) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        String alias = aliasForVersion(keyVersion);
        KeyStore.Entry existing = keyStore.getEntry(alias, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    static String encrypt(String plaintext, String context) throws Exception {
        return encrypt(plaintext, context, 0);
    }

    static String encrypt(String plaintext, String context, int keyVersion) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey(keyVersion));
        if (context != null) {
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
        }
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        ByteBuffer payload = ByteBuffer.allocate(1 + iv.length + ciphertext.length);
        payload.put((byte) iv.length);
        payload.put(iv);
        payload.put(ciphertext);
        return Base64.encodeToString(payload.array(), Base64.NO_WRAP);
    }

    static String decrypt(String payloadBase64, String context) throws Exception {
        return decrypt(payloadBase64, context, 0);
    }

    static String decrypt(String payloadBase64, String context, int keyVersion) throws Exception {
        byte[] payload = Base64.decode(payloadBase64, Base64.NO_WRAP);
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        int ivLength = Byte.toUnsignedInt(buffer.get());
        if (ivLength < 12 || ivLength > 16 || buffer.remaining() <= ivLength) {
            throw new IllegalArgumentException("Invalid encrypted payload.");
        }
        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()];
        buffer.get(ciphertext);

        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(keyVersion), new GCMParameterSpec(TAG_LENGTH_BITS, iv));
        if (context != null) {
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
        }
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    static String encryptForStorage(String plaintext, String context) throws Exception {
        return STORED_PREFIX + encrypt(plaintext, context);
    }

    static String decryptStoredValue(String stored, String context) throws Exception {
        if (stored == null || !stored.startsWith(STORED_PREFIX)) return stored;
        return decrypt(stored.substring(STORED_PREFIX.length()), context);
    }

    static boolean isEncryptedStoredValue(String stored) {
        return stored != null && stored.startsWith(STORED_PREFIX);
    }

    static void ensureKeyVersion(int keyVersion) throws Exception {
        if (keyVersion <= 0) throw new IllegalArgumentException("Invalid rotating key version.");
        getOrCreateKey(keyVersion);
    }

    static void deleteKeyVersion(int keyVersion) throws Exception {
        if (keyVersion <= 0) return;
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        String alias = aliasForVersion(keyVersion);
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias);
    }
}
