package com.roadsage.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
        result.put("playIntegrityAvailable", false);
        result.put("note", "Local runtime integrity checks are enforced; Play Integrity API requires server nonce verification.");
        call.resolve(result);
    }
}
