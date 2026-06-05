package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.StrongBoxUnavailableException;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;

final class EncryptedPreferenceStore {
    private static final String TAG = "EncryptedPreferenceStore";
    private static final String MASTER_KEY_ALIAS = "road_sage_master_key_v3";
    private static final Object PREFS_CACHE_LOCK = new Object();
    private static final Map<String, SharedPreferences> PREFS_CACHE = new HashMap<>();
    private static MasterKey cachedMasterKey = null;

    private EncryptedPreferenceStore() {}

    static SharedPreferences open(Context context, String prefsName) {
        SharedPreferences cached = cachedPrefs(prefsName);
        if (cached != null) return cached;

        Context appContext = context.getApplicationContext();
        MasterKey masterKey = masterKey(appContext);

        try {
            SharedPreferences prefs = openEncryptedPrefs(appContext, prefsName, masterKey);
            return cachePrefs(prefsName, prefs);
        } catch (GeneralSecurityException | IOException firstOpenError) {
            Log.w(TAG, "First encrypted preferences open failed for " + prefsName, firstOpenError);
            SecureDelete.wipePlaintextPrefs(appContext, prefsName);
            SecureDelete.wipeEncryptedPrefs(appContext, prefsName);
            resetMasterKey();
            MasterKey freshKey = masterKey(appContext);
            try {
                SharedPreferences prefs = openEncryptedPrefs(appContext, prefsName, freshKey);
                return cachePrefs(prefsName, prefs);
            } catch (GeneralSecurityException | IOException secondOpenError) {
                Log.e(TAG, "Second encrypted preferences open failed for " + prefsName, secondOpenError);
                throw new IllegalStateException("Encrypted preferences are unavailable after recovery attempt.", secondOpenError);
            }
        }
    }

    private static SharedPreferences cachedPrefs(String prefsName) {
        synchronized (PREFS_CACHE_LOCK) {
            return PREFS_CACHE.get(prefsName);
        }
    }

    private static SharedPreferences cachePrefs(String prefsName, SharedPreferences prefs) {
        synchronized (PREFS_CACHE_LOCK) {
            SharedPreferences cached = PREFS_CACHE.get(prefsName);
            if (cached != null) return cached;
            PREFS_CACHE.put(prefsName, prefs);
            return prefs;
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

    static void warmMasterKey(Context context) {
        masterKey(context.getApplicationContext());
    }

    private static synchronized MasterKey masterKey(Context context) {
        if (cachedMasterKey != null) return cachedMasterKey;
        try {
            cachedMasterKey = buildHardwareMasterKey(context);
            return cachedMasterKey;
        } catch (GeneralSecurityException | IOException error) {
            throw new IllegalStateException("Encrypted preferences are unavailable.", error);
        }
    }

    private static void resetMasterKey() {
        synchronized (EncryptedPreferenceStore.class) {
            cachedMasterKey = null;
        }
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(MASTER_KEY_ALIAS)) {
                keyStore.deleteEntry(MASTER_KEY_ALIAS);
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not delete encrypted preferences master key alias.", error);
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

    private static MasterKey buildHardwareMasterKey(Context context)
            throws GeneralSecurityException, IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return buildMasterKey(context, true);
            } catch (StrongBoxUnavailableException ignored) {}
        }

        return buildMasterKey(context, false);
    }

    private static MasterKey buildMasterKey(Context context, boolean requestStrongBox)
            throws GeneralSecurityException, IOException {
        MasterKey.Builder builder = new MasterKey.Builder(context, MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setUserAuthenticationRequired(false);

        if (requestStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setRequestStrongBoxBacked(true);
        }

        return builder.build();
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
