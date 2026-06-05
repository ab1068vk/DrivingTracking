package com.roadsage.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BiometricGate")
public class BiometricGatePlugin extends Plugin {
    private static final int APP_LOCK_AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_WEAK |
        BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", isAuthenticatorAvailable());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || !isAuthenticatorAvailable()) {
            resolveStatus(call, "unavailable", null);
            return;
        }

        call.setKeepAlive(true);
        activity.runOnUiThread(() -> {
            try {
                authenticateWithDeviceCredentialIntent(activity, call);
            } catch (Exception error) {
                resolveStatus(call, "error", safeErrorMessage(error));
            }
        });
    }

    private void authenticateWithDeviceCredentialIntent(Activity activity, PluginCall call) {
        KeyguardManager keyguardManager = keyguardManager();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP || keyguardManager == null) {
            resolveStatus(call, "unavailable", null);
            return;
        }

        String title = call.getString("title", "Unlock Road Sage");
        String description = call.getString("description", "Confirm your identity to access trip data.");
        Intent intent = keyguardManager.createConfirmDeviceCredentialIntent(title, description);
        if (intent == null) {
            resolveStatus(call, "unavailable", null);
            return;
        }
        call.setKeepAlive(true);
        startActivityForResult(call, intent, "credentialResult");
    }

    @ActivityCallback
    private void credentialResult(PluginCall call, ActivityResult result) {
        resolveStatus(
            call,
            result.getResultCode() == Activity.RESULT_OK ? "success" : "cancelled",
            null
        );
    }

    private void resolveStatus(PluginCall call, String status, String message) {
        JSObject result = new JSObject();
        result.put("status", status);
        if (message != null) {
            result.put("message", message);
        }
        Activity activity = getActivity();
        Runnable resolve = () -> {
            call.setKeepAlive(false);
            call.resolve(result);
        };
        if (activity == null) {
            resolve.run();
            return;
        }
        activity.runOnUiThread(resolve);
    }

    private boolean isDeviceSecure() {
        KeyguardManager keyguardManager = keyguardManager();
        if (keyguardManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return keyguardManager.isDeviceSecure();
        }
        return keyguardManager.isKeyguardSecure();
    }

    private KeyguardManager keyguardManager() {
        return (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
    }

    private boolean isAuthenticatorAvailable() {
        if (!isDeviceSecure()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true;
        try {
            return BiometricManager.from(getContext()).canAuthenticate(APP_LOCK_AUTHENTICATORS) ==
                BiometricManager.BIOMETRIC_SUCCESS;
        } catch (Exception ignored) {
            return true;
        }
    }

    private String safeErrorMessage(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty()
            ? "Device credential prompt could not be opened."
            : message;
    }
}
