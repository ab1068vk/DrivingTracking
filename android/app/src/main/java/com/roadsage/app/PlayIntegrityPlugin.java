package com.roadsage.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.integrity.IntegrityManager;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;

@CapacitorPlugin(name = "PlayIntegrity")
public class PlayIntegrityPlugin extends Plugin {
    @PluginMethod
    public void getRuntimeIntegrity(PluginCall call) {
        JSObject result = new JSObject();
        String status = RuntimeIntegrityCheck.status(getContext());
        result.put("status", status);
        result.put("ok", "ok".equals(status));
        result.put("rootLikely", RuntimeIntegrityCheck.isRootLikely());
        result.put("debuggerAttached", RuntimeIntegrityCheck.isDebuggerAttached());
        result.put("emulatorLikely", RuntimeIntegrityCheck.isProbablyEmulator());
        result.put("adbEnabled", RuntimeIntegrityCheck.isAdbEnabled(getContext()));
        result.put("playIntegrityAvailable", true);
        result.put("note", "Play Integrity tokens are requested on-device and must be decrypted and verified by a trusted backend.");
        call.resolve(result);
    }

    @PluginMethod
    public void requestAttestation(PluginCall call) {
        String localStatus = RuntimeIntegrityCheck.status(getContext());
        if (!"ok".equals(localStatus)) {
            call.reject("Runtime integrity failed: " + localStatus);
            return;
        }

        String nonce = call.getString("nonce");
        if (nonce == null || nonce.trim().length() < 16) {
            call.reject("nonce is required.");
            return;
        }

        try {
            IntegrityTokenRequest.Builder request = IntegrityTokenRequest.builder().setNonce(nonce);
            String cloudProjectNumber = call.getString("cloudProjectNumber");
            if (cloudProjectNumber != null && !cloudProjectNumber.trim().isEmpty()) {
                request.setCloudProjectNumber(Long.parseLong(cloudProjectNumber.trim()));
            }

            IntegrityManager manager = IntegrityManagerFactory.create(getContext());
            manager.requestIntegrityToken(request.build())
                .addOnSuccessListener(response -> {
                    JSObject result = new JSObject();
                    result.put("token", response.token());
                    result.put("nonce", nonce);
                    result.put("runtimeStatus", localStatus);
                    result.put("requiresServerVerification", true);
                    call.resolve(result);
                })
                .addOnFailureListener(error -> call.reject("Play Integrity attestation failed: " + error.getMessage(), error));
        } catch (Exception error) {
            call.reject("Play Integrity attestation could not start: " + error.getMessage(), error);
        }
    }
}
