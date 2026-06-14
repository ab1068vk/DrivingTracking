package com.drivesense.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

@CapacitorPlugin(name = "AuditAnchor")
public class AuditAnchorPlugin extends Plugin {
    private static final String KEY_ALIAS = "ds_audit_anchor_key_v1";

    @PluginMethod
    public void signTipHash(PluginCall call) {
        String tipHash = call.getString("tipHash");
        if (tipHash == null || tipHash.trim().isEmpty()) {
            call.reject("TIP_HASH_REQUIRED");
            return;
        }

        try {
            KeyPair keyPair = getOrCreateSigningKeyPair();
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(keyPair.getPrivate());
            signer.update(tipHash.getBytes(StandardCharsets.UTF_8));

            JSObject result = new JSObject();
            result.put("signature", Base64.encodeToString(signer.sign(), Base64.NO_WRAP));
            result.put(
                "publicKey",
                Base64.encodeToString(keyPair.getPublic().getEncoded(), Base64.NO_WRAP)
            );
            call.resolve(result);
        } catch (Exception error) {
            call.reject("AUDIT_ANCHOR_SIGN_FAILED", error);
        }
    }

    private KeyPair getOrCreateSigningKeyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                "AndroidKeyStore"
            );
            generator.initialize(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN
            )
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .build());
            generator.generateKeyPair();
        }

        PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
        PublicKey publicKey = keyStore.getCertificate(KEY_ALIAS).getPublicKey();
        return new KeyPair(publicKey, privateKey);
    }
}
