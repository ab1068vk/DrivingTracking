package com.roadsage.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BiometricGate")
public class BiometricGatePlugin extends Plugin {
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", keyguardManager().isDeviceSecure());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        KeyguardManager keyguardManager = keyguardManager();
        if (!keyguardManager.isDeviceSecure()) {
            call.reject("Device credential or biometric unlock is not configured.");
            return;
        }

        String title = call.getString("title", "Unlock Road Sage");
        String description = call.getString("description", "Confirm your identity to access trip data.");
        Intent intent = keyguardManager.createConfirmDeviceCredentialIntent(title, description);
        if (intent == null) {
            call.reject("Device credential prompt is unavailable.");
            return;
        }
        startActivityForResult(call, intent, "credentialResult");
    }

    @ActivityCallback
    private void credentialResult(PluginCall call, ActivityResult result) {
        JSObject payload = new JSObject();
        payload.put("authenticated", result.getResultCode() == Activity.RESULT_OK);
        call.resolve(payload);
    }

    private KeyguardManager keyguardManager() {
        return (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
    }
}
