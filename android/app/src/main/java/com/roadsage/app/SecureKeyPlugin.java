package com.roadsage.app;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureKey")
public class SecureKeyPlugin extends Plugin {
    private static final String KEY_ALIAS = "road_sage_js_enc_key_v2";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    @PluginMethod
    public void encrypt(PluginCall call) {
        String plaintextB64 = call.getString("data");
        if (plaintextB64 == null) {
            call.reject("Missing data");
            return;
        }

        try {
            SecretKey key = getOrCreateKey();
            byte[] iv = new byte[IV_BYTES];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));
            byte[] ct = cipher.doFinal(Base64.decode(plaintextB64, Base64.NO_WRAP));
            JSObject result = new JSObject();
            result.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            result.put("ct", Base64.encodeToString(ct, Base64.NO_WRAP));
            result.put("backing", keyBacking());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Encrypt failed: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        String ivB64 = call.getString("iv");
        String ctB64 = call.getString("ct");
        if (ivB64 == null || ctB64 == null) {
            call.reject("Missing iv or ct");
            return;
        }

        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP)));
            byte[] pt = cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP));
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(pt, Base64.NO_WRAP));
            result.put("backing", keyBacking());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Decrypt failed: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void keyBacking(PluginCall call) {
        JSObject result = new JSObject();
        result.put("backing", keyBacking());
        call.resolve(result);
    }

    @PluginMethod
    public void wipeAllFiles(PluginCall call) {
        JSObject result = new JSObject();
        result.put("deleted", SecureDelete.wipeSensitiveFiles(getContext()));
        call.resolve(result);
    }

    static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS) && !isHardwareBacked(keyStore)) {
            keyStore.deleteEntry(KEY_ALIAS);
        }
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            generateKey(true);
        }
        if (!isHardwareBacked(keyStore)) {
            keyStore.deleteEntry(KEY_ALIAS);
            throw new java.security.GeneralSecurityException("Road Sage requires a hardware-backed Android Keystore key.");
        }
        return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    static String keyBacking() {
        try {
            SecretKey key = getOrCreateKey();
            SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore");
            KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_STRONGBOX) return "StrongBox";
                if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT) return "TEE";
                return "Software";
            }
            return info.isInsideSecureHardware() ? "TEE" : "Software";
        } catch (Exception ignored) {
            return "Unknown";
        }
    }

    private static void generateKey(boolean preferStrongBox) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && preferStrongBox) {
            builder.setIsStrongBoxBacked(true);
        }

        try {
            generator.init(builder.build());
            generator.generateKey();
        } catch (Exception error) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && preferStrongBox) {
                generateKey(false);
                return;
            }
            throw error;
        }
    }

    private static boolean isHardwareBacked(KeyStore keyStore) {
        try {
            KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
            if (!(entry instanceof KeyStore.SecretKeyEntry)) return false;
            SecretKey key = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore");
            KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_STRONGBOX ||
                    info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT;
            }
            return info.isInsideSecureHardware();
        } catch (Exception ignored) {
            return false;
        }
    }
}
