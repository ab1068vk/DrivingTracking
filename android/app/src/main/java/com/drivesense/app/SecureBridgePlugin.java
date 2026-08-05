package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

@CapacitorPlugin(name = "SecureBridge")
public class SecureBridgePlugin extends Plugin {
    private static final int BRIDGE_VERSION = 1;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final long NONCE_WINDOW_MS = 30_000L;
    private static final String BRIDGE_CONTEXT = "drivesense-secure-bridge-v1";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";

    // Every WebView reload or app resume re-handshakes, and the tracking foreground service
    // keeps this process alive for days, so sessions must expire or they accumulate forever.
    private static final long SESSION_MAX_AGE_MS = 12 * 60 * 60_000L;
    private static final int MAX_SESSIONS = 32;

    private final Map<String, BridgeSession> sessions = new ConcurrentHashMap<>();
    private final SecureRandom secureRandom = new SecureRandom();

    private void pruneExpiredSessions() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, BridgeSession>> entries = sessions.entrySet().iterator();
        while (entries.hasNext()) {
            Map.Entry<String, BridgeSession> entry = entries.next();
            BridgeSession session = entry.getValue();
            if (session == null || now - session.createdAtMs > SESSION_MAX_AGE_MS) entries.remove();
        }

        // Hard ceiling in case a client re-handshakes faster than sessions age out.
        while (sessions.size() >= MAX_SESSIONS) {
            String oldestId = null;
            long oldestCreatedAtMs = Long.MAX_VALUE;
            for (Map.Entry<String, BridgeSession> entry : sessions.entrySet()) {
                BridgeSession session = entry.getValue();
                long createdAtMs = session == null ? 0L : session.createdAtMs;
                if (createdAtMs < oldestCreatedAtMs) {
                    oldestCreatedAtMs = createdAtMs;
                    oldestId = entry.getKey();
                }
            }
            if (oldestId == null) break;
            sessions.remove(oldestId);
        }
    }

    @PluginMethod
    public void initSession(PluginCall call) {
        String clientPublicKey = call.getString("clientPublicKey");
        if (clientPublicKey == null || clientPublicKey.trim().isEmpty()) {
            call.reject("CLIENT_PUBLIC_KEY_REQUIRED");
            return;
        }

        try {
            PublicKey clientKey = KeyFactory.getInstance("EC").generatePublic(
                new X509EncodedKeySpec(Base64.decode(clientPublicKey, Base64.NO_WRAP))
            );

            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"), secureRandom);
            KeyPair nativePair = generator.generateKeyPair();

            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(nativePair.getPrivate());
            agreement.doPhase(clientKey, true);

            String sessionId = randomSessionId();
            byte[] sharedSecret = agreement.generateSecret();
            SecretKey bridgeKey = deriveBridgeKey(sharedSecret, sessionId);
            pruneExpiredSessions();
            sessions.put(sessionId, new BridgeSession(bridgeKey));

            JSObject payload = new JSObject();
            payload.put("version", BRIDGE_VERSION);
            payload.put("sessionId", sessionId);
            payload.put("nativePublicKey", Base64.encodeToString(nativePair.getPublic().getEncoded(), Base64.NO_WRAP));
            call.resolve(payload);
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_INIT_FAILED", error);
        }
    }

    @PluginMethod
    public void echo(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "echo");
            JSObject result = new JSObject();
            result.put("canary", envelope.payload.optLong("canary"));
            resolveEncrypted(call, envelope, "SecureBridge", "echo", result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_ECHO_FAILED", error);
        }
    }

    @PluginMethod
    public void setPreference(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "setPreference");
            JSONObject payload = envelope.payload;
            String key = payload.optString("key", "");
            String value = payload.optString("value", null);
            String context = payload.optString("context", "drivesense");
            boolean encryptAtRest = payload.optBoolean("encryptAtRest", false);
            if (key.trim().isEmpty() || value == null) {
                call.reject("PREFERENCE_KEY_VALUE_REQUIRED");
                return;
            }

            String storedValue = encryptAtRest
                ? DriveSensePayloadCrypto.encryptForStorage(value, context)
                : value;
            SharedPreferences prefs = getContext().getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
            prefs.edit().putString(key, storedValue).apply();

            JSObject result = new JSObject();
            result.put("stored", true);
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_CALL_FAILED", error);
        }
    }

    @PluginMethod
    public void encryptSensitivePayload(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "encryptSensitivePayload");
            String plaintext = envelope.payload.optString("plaintext", null);
            String context = envelope.payload.optString("context", "drivesense");
            int keyVersion = envelope.payload.optInt("keyVersion", 1);
            if (plaintext == null) {
                call.reject("PLAINTEXT_REQUIRED");
                return;
            }

            JSObject result = new JSObject();
            result.put("ciphertext", DriveSensePayloadCrypto.encrypt(plaintext, context, keyVersion));
            result.put("keyVersion", keyVersion);
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_ENCRYPT_FAILED", error);
        }
    }

    @PluginMethod
    public void decryptSensitivePayload(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "decryptSensitivePayload");
            String ciphertext = envelope.payload.optString("ciphertext", null);
            String context = envelope.payload.optString("context", "drivesense");
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            if (ciphertext == null) {
                call.reject("CIPHERTEXT_REQUIRED");
                return;
            }

            JSObject result = new JSObject();
            result.put("plaintext", DriveSensePayloadCrypto.decrypt(ciphertext, context, keyVersion));
            resolveEncrypted(call, envelope, "SecureBridge", "decryptSensitivePayload", result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_DECRYPT_FAILED", error);
        }
    }

    @PluginMethod
    public void ensureSensitivePayloadKey(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "ensureSensitivePayloadKey");
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            DriveSensePayloadCrypto.ensureKeyVersion(keyVersion);
            JSObject result = new JSObject();
            result.put("keyVersion", keyVersion);
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_KEY_CREATE_FAILED", error);
        }
    }

    @PluginMethod
    public void deleteSensitivePayloadKey(PluginCall call) {
        try {
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "deleteSensitivePayloadKey");
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            DriveSensePayloadCrypto.deleteKeyVersion(keyVersion);
            JSObject result = new JSObject();
            result.put("deleted", true);
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_KEY_DELETE_FAILED", error);
        }
    }

    private BridgeEnvelope decryptBridgePayload(PluginCall call, String pluginName, String method) throws Exception {
        if (!Boolean.TRUE.equals(call.getBoolean("encrypted", false))) {
            throw new SecurityException("ENCRYPTED_PAYLOAD_REQUIRED");
        }
        Integer version = call.getInt("version", 0);
        if (version == null || version != BRIDGE_VERSION) {
            throw new SecurityException("UNSUPPORTED_BRIDGE_VERSION");
        }

        String sessionId = call.getString("sessionId", "");
        BridgeSession session = sessions.get(sessionId);
        if (session == null) {
            throw new SecurityException("UNKNOWN_BRIDGE_SESSION");
        }

        Long nonceValue = call.getLong("nonce", 0L);
        long nonce = nonceValue != null ? nonceValue : 0L;
        long now = System.currentTimeMillis();
        synchronized (session) {
            if (nonce <= session.lastNonce) {
                throw new SecurityException("REPLAY_DETECTED");
            }
            if (Math.abs(nonce - now) > NONCE_WINDOW_MS) {
                throw new SecurityException("NONCE_EXPIRED");
            }
        }

        byte[] iv = Base64.decode(call.getString("iv", ""), Base64.NO_WRAP);
        if (iv.length != 12) {
            throw new SecurityException("INVALID_BRIDGE_IV");
        }
        byte[] encrypted = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, session.key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
        cipher.updateAAD(associatedData(sessionId, pluginName, method, nonce).getBytes(StandardCharsets.UTF_8));
        String plaintext = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);

        synchronized (session) {
            if (nonce <= session.lastNonce) {
                throw new SecurityException("REPLAY_DETECTED");
            }
            session.lastNonce = nonce;
        }
        return new BridgeEnvelope(new JSONObject(plaintext), session, sessionId);
    }

    private void resolveEncrypted(
        PluginCall call,
        BridgeEnvelope envelope,
        String pluginName,
        String method,
        JSObject payload
    ) throws Exception {
        long nonce;
        synchronized (envelope.session) {
            nonce = Math.max(System.currentTimeMillis(), envelope.session.lastResponseNonce + 1);
            envelope.session.lastResponseNonce = nonce;
        }

        byte[] iv = new byte[12];
        secureRandom.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, envelope.session.key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
        cipher.updateAAD(associatedData(envelope.sessionId, pluginName, method + ":result", nonce).getBytes(StandardCharsets.UTF_8));

        JSObject result = new JSObject();
        result.put("encrypted", true);
        result.put("version", BRIDGE_VERSION);
        result.put("sessionId", envelope.sessionId);
        result.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        result.put("data", Base64.encodeToString(
            cipher.doFinal(payload.toString().getBytes(StandardCharsets.UTF_8)),
            Base64.NO_WRAP
        ));
        result.put("nonce", nonce);
        call.resolve(result);
    }

    private SecretKey deriveBridgeKey(byte[] sharedSecret, String sessionId) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(sharedSecret);
        digest.update((BRIDGE_CONTEXT + ":" + sessionId).getBytes(StandardCharsets.UTF_8));
        return new SecretKeySpec(digest.digest(), "AES");
    }

    private String randomSessionId() {
        byte[] bytes = new byte[16];
        secureRandom.nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
    }

    private String associatedData(String sessionId, String pluginName, String method, long nonce) {
        return BRIDGE_CONTEXT + "|" + sessionId + "|" + pluginName + "|" + method + "|" + nonce;
    }

    private static final class BridgeSession {
        final SecretKey key;
        final long createdAtMs = System.currentTimeMillis();
        long lastNonce = 0L;
        long lastResponseNonce = 0L;

        BridgeSession(SecretKey key) {
            this.key = key;
        }
    }

    private static final class BridgeEnvelope {
        final JSONObject payload;
        final BridgeSession session;
        final String sessionId;

        BridgeEnvelope(JSONObject payload, BridgeSession session, String sessionId) {
            this.payload = payload;
            this.session = session;
            this.sessionId = sessionId;
        }
    }
}
