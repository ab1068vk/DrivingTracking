package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;

final class EncryptedPreferenceStore {
    private static final String MASTER_KEY_ALIAS = "road_sage_master_key_v3";

    private EncryptedPreferenceStore() {}

    static SharedPreferences open(Context context, String prefsName) {
        MasterKey masterKey;
        try {
            masterKey = buildHardwareMasterKey(context);
        } catch (GeneralSecurityException | IOException error) {
            throw new IllegalStateException("Encrypted preferences are unavailable.", error);
        }

        try {
            return openEncryptedPrefs(context, prefsName, masterKey);
        } catch (GeneralSecurityException | IOException firstOpenError) {
            SecureDelete.wipePlaintextPrefs(context, prefsName);
            try {
                return openEncryptedPrefs(context, prefsName, masterKey);
            } catch (GeneralSecurityException | IOException secondOpenError) {
                throw new IllegalStateException("Encrypted preferences are unavailable.", secondOpenError);
            }
        }
    }

    private static SharedPreferences openEncryptedPrefs(Context context, String prefsName, MasterKey masterKey)
            throws GeneralSecurityException, IOException {
            return EncryptedSharedPreferences.create(
                context,
                prefsName,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
    }

    static String keyBacking(Context context) {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            KeyStore.Entry entry = keyStore.getEntry(MASTER_KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                SecretKey key = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore");
                KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_STRONGBOX) return "StrongBox";
                    if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT) return "TEE";
                    return "Software";
                }
                return info.isInsideSecureHardware() ? "TEE" : "Software";
            }
        } catch (Exception ignored) {}
        return "Unknown";
    }

    private static MasterKey buildHardwareMasterKey(Context context)
            throws GeneralSecurityException, IOException {
        MasterKey.Builder builder = new MasterKey.Builder(context, MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setUserAuthenticationRequired(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setRequestStrongBoxBacked(true);
        }

        MasterKey key = builder.build();
        if (!isRequiredBacking()) {
            deleteMasterKey();
            throw new GeneralSecurityException(
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? "Road Sage requires a StrongBox-backed Android Keystore key."
                    : "Road Sage requires a hardware-backed Android Keystore key."
            );
        }
        return key;
    }

    private static boolean isRequiredBacking() {
        String backing = keyBackingInternal();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return "StrongBox".equals(backing);
        return "TEE".equals(backing);
    }

    private static String keyBackingInternal() {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            KeyStore.Entry entry = keyStore.getEntry(MASTER_KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                SecretKey key = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore");
                KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_STRONGBOX) return "StrongBox";
                    if (info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT) return "TEE";
                    return "Software";
                }
                return info.isInsideSecureHardware() ? "TEE" : "Software";
            }
        } catch (Exception ignored) {}
        return "Unknown";
    }

    private static void deleteMasterKey() {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(MASTER_KEY_ALIAS)) {
                keyStore.deleteEntry(MASTER_KEY_ALIAS);
            }
        } catch (Exception ignored) {}
    }

    static void put(SharedPreferences.Editor editor, String key, Object value) {
        if (value instanceof String) editor.putString(key, (String) value);
        else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
        else if (value instanceof Integer) editor.putInt(key, (Integer) value);
        else if (value instanceof Long) editor.putLong(key, (Long) value);
        else if (value instanceof Float) editor.putFloat(key, (Float) value);
    }

    static void deletePlaintext(Context context, String prefsName) {
        SecureDelete.wipePlaintextPrefs(context, prefsName);
    }
}
