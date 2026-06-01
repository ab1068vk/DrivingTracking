package com.roadsage.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.Map;

final class EncryptedPreferenceStore {
    private EncryptedPreferenceStore() {}

    static SharedPreferences open(Context context, String prefsName) {
        try {
            MasterKey masterKey = new MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .setUserAuthenticationRequired(false)
                .build();
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

    static SharedPreferences plaintext(Context context, String prefsName) {
        return context.getSharedPreferences(prefsName, Context.MODE_PRIVATE);
    }

    static boolean hasEntries(Context context, String prefsName) {
        return !plaintext(context, prefsName).getAll().isEmpty();
    }

    static void put(SharedPreferences.Editor editor, String key, Object value) {
        if (value instanceof String) editor.putString(key, (String) value);
        else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
        else if (value instanceof Integer) editor.putInt(key, (Integer) value);
        else if (value instanceof Long) editor.putLong(key, (Long) value);
        else if (value instanceof Float) editor.putFloat(key, (Float) value);
    }

    static void copyEntries(SharedPreferences from, SharedPreferences.Editor to) {
        for (Map.Entry<String, ?> entry : from.getAll().entrySet()) {
            put(to, entry.getKey(), entry.getValue());
        }
    }

    static void deletePlaintext(Context context, String prefsName) {
        plaintext(context, prefsName).edit().clear().commit();
        context.deleteSharedPreferences(prefsName);
    }
}
