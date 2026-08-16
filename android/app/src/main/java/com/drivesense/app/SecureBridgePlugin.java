package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
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
        P0CallTiming p0Timing = startP0Timing(call);
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
            resolveWithP0(call, payload, p0Timing);
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_INIT_FAILED", error);
        }
    }

    @PluginMethod
    public void echo(PluginCall call) {
        try {
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "echo", p0Timing);
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
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "setPreference", p0Timing);
            JSONObject payload = envelope.payload;
            String key = payload.optString("key", "");
            String value = payload.optString("value", null);
            String context = payload.optString("context", "drivesense");
            boolean encryptAtRest = payload.optBoolean("encryptAtRest", false);
            if (key.trim().isEmpty() || value == null) {
                call.reject("PREFERENCE_KEY_VALUE_REQUIRED");
                return;
            }

            long p0WorkStart = p0Timing != null ? p0Timing.nanoTime() : 0L;
            String storedValue = encryptAtRest
                ? DriveSensePayloadCrypto.encryptForStorage(value, context)
                : value;
            SharedPreferences prefs = getContext().getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
            prefs.edit().putString(key, storedValue).apply();
            if (p0Timing != null) p0Timing.addMethodWork(p0Timing.nanoTime() - p0WorkStart);

            JSObject result = new JSObject();
            result.put("stored", true);
            resolveWithP0(call, result, p0Timing);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_CALL_FAILED", error);
        }
    }

    @PluginMethod
    public void encryptSensitivePayload(PluginCall call) {
        try {
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "encryptSensitivePayload", p0Timing);
            String plaintext = envelope.payload.optString("plaintext", null);
            String context = envelope.payload.optString("context", "drivesense");
            int keyVersion = envelope.payload.optInt("keyVersion", 1);
            if (plaintext == null) {
                call.reject("PLAINTEXT_REQUIRED");
                return;
            }

            long p0WorkStart = p0Timing != null ? p0Timing.nanoTime() : 0L;
            String encryptedAtRest = DriveSensePayloadCrypto.encrypt(plaintext, context, keyVersion);
            if (p0Timing != null) p0Timing.addMethodWork(p0Timing.nanoTime() - p0WorkStart);

            JSObject result = new JSObject();
            result.put("ciphertext", encryptedAtRest);
            result.put("keyVersion", keyVersion);
            resolveWithP0(call, result, p0Timing);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_ENCRYPT_FAILED", error);
        }
    }

    @PluginMethod
    public void decryptSensitivePayload(PluginCall call) {
        try {
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "decryptSensitivePayload", p0Timing);
            String ciphertext = envelope.payload.optString("ciphertext", null);
            String context = envelope.payload.optString("context", "drivesense");
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            if (ciphertext == null) {
                call.reject("CIPHERTEXT_REQUIRED");
                return;
            }

            long p0WorkStart = p0Timing != null ? p0Timing.nanoTime() : 0L;
            String decryptedAtRest = DriveSensePayloadCrypto.decrypt(ciphertext, context, keyVersion);
            if (p0Timing != null) p0Timing.addMethodWork(p0Timing.nanoTime() - p0WorkStart);

            JSObject result = new JSObject();
            result.put("plaintext", decryptedAtRest);
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
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "ensureSensitivePayloadKey", p0Timing);
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            long p0WorkStart = p0Timing != null ? p0Timing.nanoTime() : 0L;
            DriveSensePayloadCrypto.ensureKeyVersion(keyVersion);
            if (p0Timing != null) p0Timing.addMethodWork(p0Timing.nanoTime() - p0WorkStart);
            JSObject result = new JSObject();
            result.put("keyVersion", keyVersion);
            resolveWithP0(call, result, p0Timing);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_KEY_CREATE_FAILED", error);
        }
    }

    @PluginMethod
    public void deleteSensitivePayloadKey(PluginCall call) {
        try {
            P0CallTiming p0Timing = startP0Timing(call);
            BridgeEnvelope envelope = decryptBridgePayload(call, "SecureBridge", "deleteSensitivePayloadKey", p0Timing);
            int keyVersion = envelope.payload.optInt("keyVersion", 0);
            long p0WorkStart = p0Timing != null ? p0Timing.nanoTime() : 0L;
            DriveSensePayloadCrypto.deleteKeyVersion(keyVersion);
            if (p0Timing != null) p0Timing.addMethodWork(p0Timing.nanoTime() - p0WorkStart);
            JSObject result = new JSObject();
            result.put("deleted", true);
            resolveWithP0(call, result, p0Timing);
        } catch (SecurityException error) {
            call.reject(error.getMessage());
        } catch (Exception error) {
            call.reject("SECURE_BRIDGE_KEY_DELETE_FAILED", error);
        }
    }

    private BridgeEnvelope decryptBridgePayload(PluginCall call, String pluginName, String method) throws Exception {
        return decryptBridgePayload(call, pluginName, method, null);
    }

    private BridgeEnvelope decryptBridgePayload(
        PluginCall call,
        String pluginName,
        String method,
        P0CallTiming timing
    ) throws Exception {
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

        long p0B64Start = timing != null ? timing.nanoTime() : 0L;
        byte[] iv = Base64.decode(call.getString("iv", ""), Base64.NO_WRAP);
        if (iv.length != 12) {
            throw new SecurityException("INVALID_BRIDGE_IV");
        }
        byte[] encrypted = Base64.decode(call.getString("data", ""), Base64.NO_WRAP);
        long p0AesStart = timing != null ? timing.nanoTime() : 0L;

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, session.key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
        cipher.updateAAD(associatedData(sessionId, pluginName, method, nonce).getBytes(StandardCharsets.UTF_8));
        String plaintext = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        long p0ParseStart = timing != null ? timing.nanoTime() : 0L;

        synchronized (session) {
            if (nonce <= session.lastNonce) {
                throw new SecurityException("REPLAY_DETECTED");
            }
            session.lastNonce = nonce;
        }
        JSONObject parsedPayload = new JSONObject(plaintext);
        if (timing != null) {
            timing.addTransportB64Decode(p0AesStart - p0B64Start);
            timing.addTransportAesDecrypt(p0ParseStart - p0AesStart);
            timing.addEnvelopeJsonParse(timing.nanoTime() - p0ParseStart);
        }
        BridgeEnvelope envelope = new BridgeEnvelope(parsedPayload, session, sessionId);
        envelope.timing = timing;
        return envelope;
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

        P0CallTiming timing = envelope.timing;
        JSObject result = new JSObject();
        result.put("encrypted", true);
        result.put("version", BRIDGE_VERSION);
        result.put("sessionId", envelope.sessionId);
        result.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));

        // Split purely so each response phase is separately timeable. Values,
        // order and the ciphertext are identical to the pre-instrumentation form.
        long p0JsonStart = timing != null ? timing.nanoTime() : 0L;
        String payloadJson = payload.toString();
        long p0Utf8Start = timing != null ? timing.nanoTime() : 0L;
        byte[] payloadBytes = payloadJson.getBytes(StandardCharsets.UTF_8);
        long p0EncryptStart = timing != null ? timing.nanoTime() : 0L;
        byte[] responseCipher = cipher.doFinal(payloadBytes);
        long p0B64Start = timing != null ? timing.nanoTime() : 0L;
        String responseBase64 = Base64.encodeToString(responseCipher, Base64.NO_WRAP);
        if (timing != null) {
            timing.addResponseJson(p0Utf8Start - p0JsonStart);
            timing.addResponseUtf8(p0EncryptStart - p0Utf8Start);
            timing.addResponseAesEncrypt(p0B64Start - p0EncryptStart);
            timing.addResponseB64Encode(timing.nanoTime() - p0B64Start);
        }

        result.put("data", responseBase64);
        result.put("nonce", nonce);
        attachP0(result, timing);
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
        P0CallTiming timing;

        BridgeEnvelope(JSONObject payload, BridgeSession session, String sessionId) {
            this.payload = payload;
            this.session = session;
            this.sessionId = sessionId;
        }
    }

    // ---------------------------------------------------------------------
    // P0 diagnostic timing. Everything below is measurement only: it never
    // participates in encryption, AAD, nonce handling or replay checks.
    // ---------------------------------------------------------------------

    private static final P0CallTiming.NanoClock P0_NANO_CLOCK = SystemClock::elapsedRealtimeNanos;
    private static final P0CallTiming.WallClock P0_WALL_CLOCK = System::currentTimeMillis;

    /**
     * Begin timing at plugin-method entry — the observable post-dispatch
     * boundary — but <b>only</b> when JS actually asked for instrumentation.
     *
     * <p>Returns {@code null} when the inbound {@code _p0} block is missing,
     * malformed, or carries no valid call id. That null propagates: no clock is
     * read, no timing object is allocated, and {@link #attachP0} emits nothing,
     * so an Arm-D or release call does no P0 work on the native side at all.
     * Timing every call regardless would leave the A/D comparison unable to see
     * the native half of the probe's cost.
     *
     * <p>The inbound {@code _p0} field is untrusted: unparseable or hostile
     * values degrade to "not instrumented" rather than throwing, because a
     * diagnostic field must never be able to fail the call it describes.
     */
    private static P0CallTiming startP0Timing(PluginCall call) {
        long callId = 0L;
        long sendWallMs = 0L;
        try {
            JSObject requested = call.getObject("_p0");
            if (requested != null) {
                callId = requested.optLong("call_id", 0L);
                sendWallMs = requested.optLong("send_wall_ms", 0L);
            }
        } catch (Throwable ignored) {
            callId = 0L;
            sendWallMs = 0L;
        }
        if (!P0CallTiming.isInstrumentedRequest(callId)) return null;
        return new P0CallTiming(callId, sendWallMs, P0_NANO_CLOCK, P0_WALL_CLOCK);
    }

    /**
     * Attach the outer diagnostic block. Called for {@code resolveEncrypted} and
     * for every direct plaintext {@code call.resolve} branch, so no method is
     * silently unmeasured. A failure here is swallowed: diagnostics must never
     * break a bridge call.
     */
    private static void attachP0(JSObject result, P0CallTiming timing) {
        if (result == null || timing == null) return;
        try {
            timing.markResponseReady();
            JSObject block = new JSObject();
            block.put("call_id", timing.jsCallId());
            block.put("js_send_wall_ms", timing.jsSendWallMs());
            block.put("native_entry_wall_ms", timing.entryWallMs());
            block.put("response_ready_wall_ms", timing.responseReadyWallMs());
            block.put("native_total_internal_us", timing.totalInternalMicros());
            block.put("named_phase_total_us", timing.namedPhaseTotalMicros());
            block.put("named_phase_residual_us", timing.namedPhaseResidualMicros());
            block.put("transport_b64_decode_us", timing.transportB64DecodeMicros());
            block.put("transport_aes_decrypt_us", timing.transportAesDecryptMicros());
            block.put("envelope_json_parse_us", timing.envelopeJsonParseMicros());
            block.put("method_work_us", timing.methodWorkMicros());
            block.put("response_json_us", timing.responseJsonMicros());
            block.put("response_utf8_us", timing.responseUtf8Micros());
            block.put("response_aes_encrypt_us", timing.responseAesEncryptMicros());
            block.put("response_b64_encode_us", timing.responseB64EncodeMicros());
            result.put("_p0", block);
        } catch (Throwable ignored) {
            // Diagnostics are best-effort and must never affect the response.
        }
    }

    /** Resolve a plaintext result with the outer diagnostic block attached. */
    private static void resolveWithP0(PluginCall call, JSObject result, P0CallTiming timing) {
        attachP0(result, timing);
        call.resolve(result);
    }
}
