package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * P0 native envelope contract — the assertions that <em>only</em> a real device can make.
 *
 * <p>The JS suites prove that the inputs to {@code subtle.encrypt} are byte-identical with the probe
 * on and off, and they round-trip a response through a genuine ECDH peer — but that peer is a
 * JavaScript stand-in for this plugin, not the plugin itself. The JVM suite proves
 * {@link P0CallTiming} arithmetic against injected clocks, with no Android, no JSON and no crypto.
 * Neither can prove what this test proves: that the <em>real</em> {@code SecureBridgePlugin}, running
 * against the real Android Keystore, keeps {@code _p0} outside the ciphertext and outside the AAD,
 * and that no value in {@code _p0} can reach, alter, or break a caller-visible result.
 *
 * <p>The test drives the plugin through a faithful reimplementation of the JS client
 * ({@link BridgeClient}): the same P-256 ECDH handshake, the same
 * {@code SHA-256(sharedSecret || "drivesense-secure-bridge-v1:" + sessionId)} key derivation, and the
 * same {@code BRIDGE_CONTEXT|sessionId|plugin|method|nonce} associated-data string. Nothing about the
 * plugin is stubbed. The AAD this test computes contains no reference to {@code _p0} whatsoever, so a
 * plugin that folded {@code _p0} into the AAD would fail every response decryption below with
 * {@code AEADBadTagException} — that is the mechanism, not an incidental detail.
 *
 * <p><b>Execution status: WRITTEN — EXECUTION DEFERRED TO FINAL DEVICE VALIDATION AFTER P7.</b>
 * This file compiles as part of {@code assembleDebugAndroidTest} but has never been executed: it
 * requires {@code connectedDebugAndroidTest} against an attached device or emulator, because
 * {@link DriveSensePayloadCrypto} depends on the Android Keystore, which does not exist off-device.
 * No assertion here has been weakened to compensate for that. Until this suite runs green on the
 * physical matrix, the native {@code _p0} placement claims rest on source review alone.
 */
@RunWith(AndroidJUnit4.class)
public class SecureBridgeP0EnvelopeInstrumentedTest {
    private static final String BRIDGE_CONTEXT = "drivesense-secure-bridge-v1";
    private static final int BRIDGE_VERSION = 1;
    private static final int GCM_TAG_LENGTH_BITS = 128;
    private static final String CAPACITOR_PREFS = "CapacitorStorage";

    /** Well clear of any key version the app itself uses, so a failed run cannot disturb real data. */
    private static final int TEST_KEY_VERSION = 9091;

    /** The exact outer envelope keys a caller may see. `_p0` is deliberately absent. */
    private static final Set<String> CALLER_VISIBLE_ENCRYPTED_KEYS = new HashSet<>(
        Arrays.asList("encrypted", "version", "sessionId", "iv", "data", "nonce")
    );

    /** Everything `_p0` is permitted to contain. Nothing derived from payload content is listed. */
    private static final Set<String> ALLOWED_P0_KEYS = new HashSet<>(Arrays.asList(
        "call_id",
        "js_send_wall_ms",
        "native_entry_wall_ms",
        "response_ready_wall_ms",
        "native_total_internal_us",
        "named_phase_total_us",
        "named_phase_residual_us",
        "transport_b64_decode_us",
        "transport_aes_decrypt_us",
        "envelope_json_parse_us",
        "method_work_us",
        "response_json_us",
        "response_utf8_us",
        "response_aes_encrypt_us",
        "response_b64_encode_us"
    ));

    private Context context;
    private TestSecureBridgePlugin plugin;
    private BridgeClient client;
    private Map<String, Object> capacitorPrefsSnapshot;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        capacitorPrefsSnapshot = snapshotPrefs(context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE));
        plugin = new TestSecureBridgePlugin(context);
        client = BridgeClient.handshake(plugin);
    }

    @After
    public void tearDown() {
        restorePrefs(context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE), capacitorPrefsSnapshot);
        try {
            DriveSensePayloadCrypto.deleteKeyVersion(TEST_KEY_VERSION);
        } catch (Exception ignored) {
            // The key may never have been created; teardown must not mask a test failure.
        }
    }

    // -----------------------------------------------------------------------
    // `_p0` placement: outside the ciphertext, outside the AAD
    // -----------------------------------------------------------------------

    @Test
    public void p0BlockIsAttachedOutsideTheResponseCiphertext() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 4242L);

        JSObject result = client.callEncrypted("echo", payload, defaultP0Block());

        // The diagnostic block rides on the outer object...
        assertTrue("native did not attach the _p0 block", result.has("_p0"));
        // ...and the decrypted application payload has no trace of it. If `_p0` were inside the
        // ciphertext it would appear here, and every caller would receive diagnostics as data.
        JSONObject decrypted = client.decryptResponse(result, "echo");
        assertFalse("_p0 leaked inside the response ciphertext", decrypted.has("_p0"));
        assertEquals(4242L, decrypted.getLong("canary"));
    }

    @Test
    public void responseDecryptsWithAnAssociatedDataStringThatIgnoresP0() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 7L);

        // One genuinely instrumented call and one with no metadata at all, so the
        // instrumented side really does carry an outbound block.
        JSObject withP0 = client.callEncrypted("echo", payload, defaultP0Block());
        JSObject withoutP0 = client.callEncrypted("echo", payload, null);
        assertTrue(withP0.has("_p0"));
        assertFalse(withoutP0.has("_p0"));

        // `decryptResponse` builds its AAD from BRIDGE_CONTEXT, session, plugin, method and nonce
        // only. Both decryptions succeeding proves `_p0` is not authenticated data: had the plugin
        // mixed it into the AAD, the first would fail the GCM tag check and the second would not.
        assertEquals(7L, client.decryptResponse(withP0, "echo").getLong("canary"));
        assertEquals(7L, client.decryptResponse(withoutP0, "echo").getLong("canary"));
    }

    @Test
    public void p0BlockCarriesOnlyAllowlistedDiagnosticKeys() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 11L);
        payload.put("secret_note", "Dentist appointment");

        JSObject result = client.callEncrypted("echo", payload, defaultP0Block());
        JSONObject block = result.getJSObject("_p0");
        assertNotNull(block);

        Iterator<String> keys = block.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            assertTrue("_p0 exposed unexpected key " + key, ALLOWED_P0_KEYS.contains(key));
        }
        // Nothing payload-derived may reach diagnostics, in any form.
        assertFalse("_p0 leaked payload content", block.toString().contains("Dentist appointment"));
    }

    // -----------------------------------------------------------------------
    // Round-trip equivalence with `_p0` present versus absent
    // -----------------------------------------------------------------------

    @Test
    public void encryptedRoundTripIsIdenticalWithAndWithoutP0() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 20250815L);

        JSObject withP0 = client.callEncrypted("echo", payload, defaultP0Block());
        JSObject withoutP0 = client.callEncrypted("echo", payload, null);

        // The decrypted application payload — the only thing a caller actually receives — must be
        // byte-identical. The outer IV and nonce differ by design: a fresh random IV and a strictly
        // increasing response nonce are correct behaviour, not a P0 side effect.
        assertEquals(
            client.decryptResponse(withoutP0, "echo").toString(),
            client.decryptResponse(withP0, "echo").toString()
        );

        // The caller-visible envelope shape is identical too: `_p0` adds a key and changes nothing else.
        assertEquals(CALLER_VISIBLE_ENCRYPTED_KEYS, callerVisibleKeys(withP0));
        assertEquals(CALLER_VISIBLE_ENCRYPTED_KEYS, callerVisibleKeys(withoutP0));
        assertTrue(withP0.has("_p0"));
        assertEquals(BRIDGE_VERSION, withP0.getInt("version"));
        assertEquals(withoutP0.getString("sessionId"), withP0.getString("sessionId"));
    }

    // -----------------------------------------------------------------------
    // Nonce and replay behaviour is unchanged by P0
    // -----------------------------------------------------------------------

    @Test
    public void replayIsRejectedIdenticallyWithAndWithoutP0() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 1L);

        // Each arm gets its own fresh session, so both start from identical
        // replay state. Running the no-`_p0` arm on a session the `_p0` arm has
        // already advanced and rejected would prove nothing about `_p0` — the
        // second rejection could come entirely from the first arm's leftovers.
        BridgeClient withP0 = BridgeClient.handshake(plugin);
        BridgeClient withoutP0 = BridgeClient.handshake(plugin);

        long withP0Nonce = withP0.nextNonce();
        assertNotNull(
            "first instrumented call should have been accepted",
            invoke("echo", withP0.envelope("echo", payload, defaultP0Block(), withP0Nonce)).resolved
        );
        CapturingCall withP0Replay =
            invoke("echo", withP0.envelope("echo", payload, defaultP0Block(), withP0Nonce));

        long withoutP0Nonce = withoutP0.nextNonce();
        assertNotNull(
            "first uninstrumented call should have been accepted",
            invoke("echo", withoutP0.envelope("echo", payload, null, withoutP0Nonce)).resolved
        );
        CapturingCall withoutP0Replay =
            invoke("echo", withoutP0.envelope("echo", payload, null, withoutP0Nonce));

        // Same rejection, same reason, from equivalent starting state.
        assertEquals("REPLAY_DETECTED", withP0Replay.rejectMessage);
        assertEquals("REPLAY_DETECTED", withoutP0Replay.rejectMessage);
        assertEquals(withoutP0Replay.rejectMessage, withP0Replay.rejectMessage);
    }

    // -----------------------------------------------------------------------
    // Probe-off: absent metadata must produce no native P0 work at all
    // -----------------------------------------------------------------------

    @Test
    public void anUninstrumentedCallReceivesNoOutboundP0() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 8L);

        // Arm D and every release build send no `_p0`. Native must then do no P0
        // work and attach nothing: otherwise the A/D comparison silently pays
        // native clock, allocation, Capacitor serialization and delivery cost on
        // the "off" side, and understates the probe's true overhead.
        JSObject result = client.callEncrypted("echo", payload, null);
        assertFalse("native attached _p0 to an uninstrumented call", result.has("_p0"));
        assertEquals(CALLER_VISIBLE_ENCRYPTED_KEYS, callerVisibleKeys(result));
        assertEquals(8L, client.decryptResponse(result, "echo").getLong("canary"));
    }

    @Test
    public void everyDirectResolveBranchObeysTheProbeOffGate() throws Exception {
        JSObject preference = new JSObject();
        preference.put("key", "p0_instrumented_probe_off");
        preference.put("value", "value");
        preference.put("context", "instrumented-test");
        preference.put("encryptAtRest", false);
        assertFalse(
            "setPreference attached _p0 without inbound metadata",
            client.callDirect("setPreference", preference, null).has("_p0")
        );

        JSObject ensure = new JSObject();
        ensure.put("keyVersion", TEST_KEY_VERSION);
        assertFalse(
            "ensureSensitivePayloadKey attached _p0 without inbound metadata",
            client.callDirect("ensureSensitivePayloadKey", ensure, null).has("_p0")
        );

        JSObject delete = new JSObject();
        delete.put("keyVersion", TEST_KEY_VERSION);
        assertFalse(
            "deleteSensitivePayloadKey attached _p0 without inbound metadata",
            client.callDirect("deleteSensitivePayloadKey", delete, null).has("_p0")
        );
    }

    @Test
    public void initSessionIsUninstrumentedUnlessJsAsksForIt() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();

        JSObject data = new JSObject();
        data.put("version", BRIDGE_VERSION);
        data.put("clientPublicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP));

        CapturingCall call = new CapturingCall("initSession", data);
        plugin.initSession(call);

        assertNotNull("initSession rejected: " + call.rejectMessage, call.resolved);
        // No orphan block: a handshake JS never instrumented gets no diagnostics
        // it would never ingest.
        assertFalse("initSession attached an orphan _p0", call.resolved.has("_p0"));
    }

    @Test
    public void malformedP0IsTreatedAsUninstrumentedRatherThanTimed() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 9L);

        // A block with no usable call id is indistinguishable from absent, and
        // must be treated as probe-off rather than producing a block JS cannot
        // join to any span.
        JSObject noCallId = new JSObject();
        noCallId.put("send_wall_ms", System.currentTimeMillis());

        JSObject zeroCallId = new JSObject();
        zeroCallId.put("call_id", 0L);
        zeroCallId.put("send_wall_ms", System.currentTimeMillis());

        Object[] unusable = new Object[] { noCallId, zeroCallId, "bare string", Long.valueOf(5L) };
        for (int index = 0; index < unusable.length; index += 1) {
            JSObject result = client.callEncrypted("echo", payload, unusable[index]);
            assertFalse(
                "unusable _p0 variant " + index + " was still timed and attached",
                result.has("_p0")
            );
            assertEquals(9L, client.decryptResponse(result, "echo").getLong("canary"));
        }
    }

    @Test
    public void aStaleNonceIsRejectedEvenWhenP0LooksFresh() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 2L);

        long fresh = client.nextNonce();
        assertNotNull(invoke("echo", client.envelope("echo", payload, null, fresh)).resolved);

        // A `_p0` block claiming a current send time must not rehabilitate an old nonce: the plugin
        // is required never to trust `_p0` for a security decision.
        JSObject p0 = new JSObject();
        p0.put("call_id", 99L);
        p0.put("send_wall_ms", System.currentTimeMillis());
        CapturingCall stale = invoke("echo", client.envelope("echo", payload, p0, fresh - 1));
        assertEquals("REPLAY_DETECTED", stale.rejectMessage);
    }

    @Test
    public void aNonceOutsideTheWindowIsRejectedRegardlessOfP0() throws Exception {
        // A fresh session, so the replay check cannot fire first and mask the window check.
        BridgeClient fresh = BridgeClient.handshake(plugin);
        JSObject payload = new JSObject();
        payload.put("canary", 3L);

        JSObject p0 = new JSObject();
        p0.put("call_id", 1L);
        p0.put("send_wall_ms", System.currentTimeMillis());

        long farFuture = System.currentTimeMillis() + 60_000L;
        CapturingCall call = invoke("echo", fresh.envelope("echo", payload, p0, farFuture));
        assertEquals("NONCE_EXPIRED", call.rejectMessage);
    }

    @Test
    public void responseNoncesRemainStrictlyIncreasing() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 4L);

        long previous = -1L;
        for (int index = 0; index < 5; index += 1) {
            // Alternate `_p0` on and off; the response nonce sequence must not care.
            JSObject result = client.callEncrypted("echo", payload, index % 2 == 0 ? defaultP0Block() : null);
            long nonce = result.getLong("nonce");
            assertTrue("response nonce did not strictly increase", nonce > previous);
            previous = nonce;
        }
    }

    // -----------------------------------------------------------------------
    // `_p0` cannot influence the decrypted application payload
    // -----------------------------------------------------------------------

    @Test
    public void p0FieldsCannotOverrideApplicationPayloadValues() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 4242L);

        // `_p0` carries a colliding `canary`, plus fields named after other methods' parameters.
        JSObject p0 = new JSObject();
        p0.put("call_id", 5L);
        p0.put("send_wall_ms", System.currentTimeMillis());
        p0.put("canary", 999999L);
        p0.put("key", "attacker_key");
        p0.put("value", "attacker_value");
        p0.put("plaintext", "attacker_plaintext");
        p0.put("keyVersion", 1234);

        JSObject result = client.callEncrypted("echo", payload, p0);
        JSONObject decrypted = client.decryptResponse(result, "echo");

        // The echoed value comes from the authenticated ciphertext, never from the outer block.
        assertEquals(4242L, decrypted.getLong("canary"));
        assertNotEquals(999999L, decrypted.getLong("canary"));
    }

    @Test
    public void p0FieldsCannotRedirectAPreferenceWrite() throws Exception {
        String realKey = "p0_instrumented_real_key";
        String attackerKey = "p0_instrumented_attacker_key";

        JSObject payload = new JSObject();
        payload.put("key", realKey);
        payload.put("value", "real_value");
        payload.put("context", "instrumented-test");
        payload.put("encryptAtRest", false);

        JSObject p0 = new JSObject();
        p0.put("call_id", 6L);
        p0.put("send_wall_ms", System.currentTimeMillis());
        p0.put("key", attackerKey);
        p0.put("value", "attacker_value");

        JSObject result = client.callDirect("setPreference", payload, p0);
        assertTrue(result.getBoolean("stored"));

        SharedPreferences prefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        assertEquals("real_value", prefs.getString(realKey, null));
        // The write went exactly where the ciphertext said, and nowhere else.
        assertFalse("a _p0 field redirected a preference write", prefs.contains(attackerKey));
    }

    // -----------------------------------------------------------------------
    // Hostile and malformed `_p0` cannot break a bridge call
    // -----------------------------------------------------------------------

    @Test
    public void hostileOrMalformedP0CannotBreakTheCall() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 31337L);

        JSObject nested = new JSObject();
        nested.put("call_id", new JSObject().put("toString", "trap"));
        nested.put("send_wall_ms", new JSONArray().put(1).put(2));

        JSObject overflow = new JSObject();
        overflow.put("call_id", Long.MAX_VALUE);
        overflow.put("send_wall_ms", Long.MIN_VALUE);

        JSObject textual = new JSObject();
        textual.put("call_id", "not-a-number");
        textual.put("send_wall_ms", "东京<script>alert(1)</script>");

        Object[] hostileBlocks = new Object[] {
            null,                                  // absent entirely
            new JSObject(),                        // present but empty
            "a bare string where an object belongs",
            new JSONArray().put("array").put("instead").put("of").put("object"),
            Long.valueOf(12345L),                  // a number where an object belongs
            Boolean.TRUE,
            nested,
            overflow,
            textual,
            JSONObject.NULL,
        };

        for (int index = 0; index < hostileBlocks.length; index += 1) {
            Object hostile = hostileBlocks[index];
            JSObject result = client.callEncrypted("echo", payload, hostile);
            JSONObject decrypted = client.decryptResponse(result, "echo");
            // Every one of these still produces a correct, fully decryptable response. A diagnostic
            // field must never be able to fail the call it is describing.
            assertEquals("hostile _p0 variant " + index + " changed the result", 31337L, decrypted.getLong("canary"));
            assertEquals(CALLER_VISIBLE_ENCRYPTED_KEYS, callerVisibleKeys(result));
        }
    }

    @Test
    public void hostileP0CannotBreakADirectResolveBranch() throws Exception {
        JSObject payload = new JSObject();
        payload.put("key", "p0_instrumented_hostile_direct");
        payload.put("value", "value");
        payload.put("context", "instrumented-test");
        payload.put("encryptAtRest", false);

        JSObject result = client.callDirect("setPreference", payload, "hostile string _p0");
        assertTrue(result.getBoolean("stored"));
    }

    // -----------------------------------------------------------------------
    // Every response branch preserves caller-visible behaviour
    // -----------------------------------------------------------------------

    @Test
    public void initSessionResolvesItsDocumentedShapeWithP0Attached() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();

        JSObject data = new JSObject();
        data.put("version", BRIDGE_VERSION);
        data.put("clientPublicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP));
        data.put("_p0", defaultP0Block());

        CapturingCall call = new CapturingCall("initSession", data);
        plugin.initSession(call);

        assertNotNull("initSession rejected: " + call.rejectMessage, call.resolved);
        assertEquals(BRIDGE_VERSION, call.resolved.getInt("version"));
        assertNotNull(call.resolved.getString("sessionId"));
        assertNotNull(call.resolved.getString("nativePublicKey"));
        assertTrue("initSession did not attach _p0", call.resolved.has("_p0"));
        // Stripping the diagnostic block leaves exactly the pre-P0 response.
        assertEquals(
            new HashSet<>(Arrays.asList("version", "sessionId", "nativePublicKey")),
            callerVisibleKeys(call.resolved)
        );
    }

    @Test
    public void setPreferenceDirectBranchIsUnchanged() throws Exception {
        JSObject payload = new JSObject();
        payload.put("key", "p0_instrumented_direct_branch");
        payload.put("value", "stored_value");
        payload.put("context", "instrumented-test");
        payload.put("encryptAtRest", false);

        JSObject result = client.callDirect("setPreference", payload, defaultP0Block());

        assertTrue(result.getBoolean("stored"));
        assertEquals(new HashSet<>(Arrays.asList("stored")), callerVisibleKeys(result));
        SharedPreferences prefs = context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        assertEquals("stored_value", prefs.getString("p0_instrumented_direct_branch", null));
    }

    @Test
    public void sensitivePayloadKeyLifecycleDirectBranchesAreUnchanged() throws Exception {
        JSObject ensurePayload = new JSObject();
        ensurePayload.put("keyVersion", TEST_KEY_VERSION);
        JSObject ensured = client.callDirect("ensureSensitivePayloadKey", ensurePayload, defaultP0Block());
        assertEquals(TEST_KEY_VERSION, ensured.getInt("keyVersion"));
        assertEquals(new HashSet<>(Arrays.asList("keyVersion")), callerVisibleKeys(ensured));
        assertTrue(ensured.has("_p0"));

        JSObject deletePayload = new JSObject();
        deletePayload.put("keyVersion", TEST_KEY_VERSION);
        JSObject deleted = client.callDirect("deleteSensitivePayloadKey", deletePayload, defaultP0Block());
        assertTrue(deleted.getBoolean("deleted"));
        assertEquals(new HashSet<>(Arrays.asList("deleted")), callerVisibleKeys(deleted));
        assertTrue(deleted.has("_p0"));
    }

    @Test
    public void sensitivePayloadRoundTripCrossesBothBranchesWithP0Present() throws Exception {
        // Exercises the real Android Keystore: encrypt resolves directly, decrypt resolves encrypted.
        JSObject ensurePayload = new JSObject();
        ensurePayload.put("keyVersion", TEST_KEY_VERSION);
        client.callDirect("ensureSensitivePayloadKey", ensurePayload, defaultP0Block());

        String secret = "{\"lat\":43.65,\"lng\":-79.38,\"note\":\"東京\"}";
        JSObject encryptPayload = new JSObject();
        encryptPayload.put("plaintext", secret);
        encryptPayload.put("context", "instrumented-test");
        encryptPayload.put("keyVersion", TEST_KEY_VERSION);

        JSObject encrypted = client.callDirect("encryptSensitivePayload", encryptPayload, defaultP0Block());
        String ciphertext = encrypted.getString("ciphertext");
        assertNotNull(ciphertext);
        assertEquals(TEST_KEY_VERSION, encrypted.getInt("keyVersion"));
        assertEquals(new HashSet<>(Arrays.asList("ciphertext", "keyVersion")), callerVisibleKeys(encrypted));
        // At-rest ciphertext must not contain the plaintext, with or without diagnostics attached.
        assertFalse(ciphertext.contains("43.65"));

        JSObject decryptPayload = new JSObject();
        decryptPayload.put("ciphertext", ciphertext);
        decryptPayload.put("context", "instrumented-test");
        decryptPayload.put("keyVersion", TEST_KEY_VERSION);

        JSObject decryptResult = client.callEncrypted("decryptSensitivePayload", decryptPayload, hostileP0Block());
        JSONObject decrypted = client.decryptResponse(decryptResult, "decryptSensitivePayload");
        // The recovered plaintext survives a hostile `_p0` completely intact.
        assertEquals(secret, decrypted.getString("plaintext"));
        assertFalse("_p0 leaked into the decrypt response ciphertext", decrypted.has("_p0"));
    }

    @Test
    public void aTamperedEnvelopeStillFailsClosedWithP0Present() throws Exception {
        JSObject payload = new JSObject();
        payload.put("canary", 5L);

        long nonce = client.nextNonce();
        JSObject envelope = client.envelope("echo", payload, defaultP0Block(), nonce);

        // Flip one ciphertext byte. A valid-looking `_p0` must not make a forged payload acceptable.
        byte[] data = Base64.decode(envelope.getString("data"), Base64.NO_WRAP);
        data[data.length / 2] ^= 0x40;
        envelope.put("data", Base64.encodeToString(data, Base64.NO_WRAP));

        CapturingCall call = invoke("echo", envelope);
        assertTrue("a tampered envelope was accepted", call.rejected);
        assertEquals("SECURE_BRIDGE_ECHO_FAILED", call.rejectMessage);
    }

    @Test
    public void anUnencryptedCallIsRefusedEvenWithAWellFormedP0() throws Exception {
        JSObject data = new JSObject();
        data.put("encrypted", false);
        data.put("version", BRIDGE_VERSION);
        data.put("_p0", defaultP0Block());

        CapturingCall call = invoke("echo", data);
        assertEquals("ENCRYPTED_PAYLOAD_REQUIRED", call.rejectMessage);
    }

    // -----------------------------------------------------------------------
    // Harness
    // -----------------------------------------------------------------------

    private JSObject defaultP0Block() {
        JSObject block = new JSObject();
        block.put("call_id", 1234L);
        block.put("send_wall_ms", System.currentTimeMillis());
        return block;
    }

    /** A `_p0` block full of values a well-behaved client would never send. */
    private JSObject hostileP0Block() {
        JSObject block = new JSObject();
        block.put("call_id", "not-a-number");
        block.put("send_wall_ms", Long.MIN_VALUE);
        block.put("unexpected_field", "<div>https://example.com/secret-token</div>");
        block.put("nested", new JSObject().put("deeper", new JSONArray().put("x")));
        return block;
    }

    private CapturingCall invoke(String method, JSObject data) {
        CapturingCall call = new CapturingCall(method, data);
        switch (method) {
            case "echo":
                plugin.echo(call);
                break;
            case "setPreference":
                plugin.setPreference(call);
                break;
            case "encryptSensitivePayload":
                plugin.encryptSensitivePayload(call);
                break;
            case "decryptSensitivePayload":
                plugin.decryptSensitivePayload(call);
                break;
            case "ensureSensitivePayloadKey":
                plugin.ensureSensitivePayloadKey(call);
                break;
            case "deleteSensitivePayloadKey":
                plugin.deleteSensitivePayloadKey(call);
                break;
            default:
                fail("unhandled bridge method " + method);
        }
        return call;
    }

    /** Outer keys a caller sees once the diagnostic block is stripped. */
    private static Set<String> callerVisibleKeys(JSObject result) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = result.keys();
        while (iterator.hasNext()) {
            String key = iterator.next();
            if (!"_p0".equals(key)) keys.add(key);
        }
        return keys;
    }

    /**
     * Captures resolve/reject without a Capacitor {@code MessageHandler}.
     *
     * <p>{@code PluginCall} is a plain class whose {@code resolve}/{@code reject} are ordinary public
     * methods, so overriding them intercepts the response before it would reach the (absent) message
     * handler. Every {@code reject} overload delegates to the four-argument form, so overriding that
     * one captures them all.
     */
    private static final class CapturingCall extends PluginCall {
        private JSObject resolved;
        private String rejectMessage;
        private boolean rejected;

        CapturingCall(String methodName, JSObject data) {
            super(null, "SecureBridge", "test-callback", methodName, data);
        }

        @Override
        public void resolve(JSObject data) {
            this.resolved = data;
        }

        @Override
        public void resolve() {
            this.resolved = new JSObject();
        }

        @Override
        public void reject(String msg, String code, Exception ex, JSObject data) {
            this.rejected = true;
            this.rejectMessage = msg;
        }
    }

    /** The plugin under test, with the bridge-provided {@link Context} supplied directly. */
    private static final class TestSecureBridgePlugin extends SecureBridgePlugin {
        private final Context testContext;

        TestSecureBridgePlugin(Context testContext) {
            this.testContext = testContext;
        }

        @Override
        public Context getContext() {
            return testContext;
        }
    }

    /**
     * A faithful reimplementation of the JS bridge client, so the plugin is exercised end to end
     * rather than against a stub. Mirrors `src/lib/secureBridge.js` exactly: same handshake, same key
     * derivation, same associated-data construction, same monotonic nonce rule.
     */
    private static final class BridgeClient {
        private final SecureBridgeP0EnvelopeInstrumentedTest.TestSecureBridgePlugin plugin;
        private final SecretKey key;
        private final String sessionId;
        private final SecureRandom random = new SecureRandom();
        private long lastNonce = 0L;

        private BridgeClient(TestSecureBridgePlugin plugin, SecretKey key, String sessionId) {
            this.plugin = plugin;
            this.key = key;
            this.sessionId = sessionId;
        }

        static BridgeClient handshake(TestSecureBridgePlugin plugin) throws Exception {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair clientPair = generator.generateKeyPair();

            JSObject data = new JSObject();
            data.put("version", BRIDGE_VERSION);
            data.put("clientPublicKey", Base64.encodeToString(clientPair.getPublic().getEncoded(), Base64.NO_WRAP));

            CapturingCall call = new CapturingCall("initSession", data);
            plugin.initSession(call);
            if (call.resolved == null) fail("handshake rejected: " + call.rejectMessage);

            String sessionId = call.resolved.getString("sessionId");
            PublicKey nativeKey = KeyFactory.getInstance("EC").generatePublic(
                new X509EncodedKeySpec(Base64.decode(call.resolved.getString("nativePublicKey"), Base64.NO_WRAP))
            );

            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(clientPair.getPrivate());
            agreement.doPhase(nativeKey, true);

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(agreement.generateSecret());
            digest.update((BRIDGE_CONTEXT + ":" + sessionId).getBytes(StandardCharsets.UTF_8));
            SecretKey bridgeKey = new SecretKeySpec(digest.digest(), "AES");

            return new BridgeClient(plugin, bridgeKey, sessionId);
        }

        /** Matches the JS rule: strictly increasing, anchored to wall time. */
        long nextNonce() {
            lastNonce = Math.max(System.currentTimeMillis(), lastNonce + 1);
            return lastNonce;
        }

        private static String associatedData(String sessionId, String pluginName, String method, long nonce) {
            return BRIDGE_CONTEXT + "|" + sessionId + "|" + pluginName + "|" + method + "|" + nonce;
        }

        /**
         * Build a request envelope. `_p0` is attached to the outer object only — never to the
         * plaintext, never to the AAD — exactly as the JS client does it.
         */
        JSObject envelope(String method, JSONObject payload, Object p0, long nonce) throws Exception {
            byte[] iv = new byte[12];
            random.nextBytes(iv);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            cipher.updateAAD(associatedData(sessionId, "SecureBridge", method, nonce).getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(payload.toString().getBytes(StandardCharsets.UTF_8));

            JSObject envelope = new JSObject();
            envelope.put("encrypted", true);
            envelope.put("version", BRIDGE_VERSION);
            envelope.put("sessionId", sessionId);
            envelope.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            envelope.put("data", Base64.encodeToString(ciphertext, Base64.NO_WRAP));
            envelope.put("nonce", nonce);
            if (p0 != null) envelope.put("_p0", p0);
            return envelope;
        }

        /** Invoke a method whose response comes back encrypted. */
        JSObject callEncrypted(String method, JSONObject payload, Object p0) throws Exception {
            CapturingCall call = new CapturingCall(method, envelope(method, payload, p0, nextNonce()));
            dispatch(method, call);
            if (call.resolved == null) fail(method + " rejected: " + call.rejectMessage);
            assertTrue(method + " did not return an encrypted response", call.resolved.getBoolean("encrypted"));
            return call.resolved;
        }

        /** Invoke a method that resolves a plaintext result directly. */
        JSObject callDirect(String method, JSONObject payload, Object p0) throws Exception {
            CapturingCall call = new CapturingCall(method, envelope(method, payload, p0, nextNonce()));
            dispatch(method, call);
            if (call.resolved == null) fail(method + " rejected: " + call.rejectMessage);
            return call.resolved;
        }

        private void dispatch(String method, CapturingCall call) {
            switch (method) {
                case "echo":
                    plugin.echo(call);
                    break;
                case "setPreference":
                    plugin.setPreference(call);
                    break;
                case "encryptSensitivePayload":
                    plugin.encryptSensitivePayload(call);
                    break;
                case "decryptSensitivePayload":
                    plugin.decryptSensitivePayload(call);
                    break;
                case "ensureSensitivePayloadKey":
                    plugin.ensureSensitivePayloadKey(call);
                    break;
                case "deleteSensitivePayloadKey":
                    plugin.deleteSensitivePayloadKey(call);
                    break;
                default:
                    fail("unhandled bridge method " + method);
            }
        }

        /**
         * Decrypt a response using an AAD built from the session, plugin, method and nonce alone.
         *
         * <p>No part of `_p0` participates. If the plugin ever authenticated the diagnostic block,
         * this would throw {@code AEADBadTagException} and every response test would fail — which is
         * precisely the property being asserted.
         */
        JSONObject decryptResponse(JSObject result, String method) throws Exception {
            byte[] iv = Base64.decode(result.getString("iv"), Base64.NO_WRAP);
            byte[] data = Base64.decode(result.getString("data"), Base64.NO_WRAP);
            long nonce = result.getLong("nonce");

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            cipher.updateAAD(
                associatedData(sessionId, "SecureBridge", method + ":result", nonce).getBytes(StandardCharsets.UTF_8)
            );
            return new JSONObject(new String(cipher.doFinal(data), StandardCharsets.UTF_8));
        }
    }

    private static Map<String, Object> snapshotPrefs(SharedPreferences prefs) {
        return new HashMap<>(prefs.getAll());
    }

    private static void restorePrefs(SharedPreferences prefs, Map<String, Object> snapshot) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.clear();
        for (Map.Entry<String, Object> entry : snapshot.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String) editor.putString(entry.getKey(), (String) value);
            else if (value instanceof Boolean) editor.putBoolean(entry.getKey(), (Boolean) value);
            else if (value instanceof Integer) editor.putInt(entry.getKey(), (Integer) value);
            else if (value instanceof Long) editor.putLong(entry.getKey(), (Long) value);
            else if (value instanceof Float) editor.putFloat(entry.getKey(), (Float) value);
        }
        editor.commit();
    }
}
