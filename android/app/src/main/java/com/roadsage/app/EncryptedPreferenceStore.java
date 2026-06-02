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
    private static final String MASTER_KEY_ALIAS = "road_sage_master_key_v2";

    private EncryptedPreferenceStore() {}

    static SharedPreferences open(Context context, String prefsName) {
        try {
            MasterKey masterKey = buildHardwareMasterKey(context, true);
            return EncryptedSharedPreferences.create(
                context,
                prefsName,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (GeneralSecurityException | IOException e) {
            throw new IllegalStateException("Encrypted preferences are unavailable.", e);
        }
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

    private static MasterKey buildHardwareMasterKey(Context context, boolean preferStrongBox)
            throws GeneralSecurityException, IOException {
        MasterKey.Builder builder = new MasterKey.Builder(context, MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setUserAuthenticationRequired(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && preferStrongBox) {
            builder.setRequestStrongBoxBacked(true);
        }

        try {
            return builder.build();
        } catch (GeneralSecurityException | IOException error) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && preferStrongBox) {
                return buildHardwareMasterKey(context, false);
            }
            throw error;
        }
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
