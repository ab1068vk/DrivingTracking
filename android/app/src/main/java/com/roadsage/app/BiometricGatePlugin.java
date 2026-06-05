package com.roadsage.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

@CapacitorPlugin(name = "BiometricGate")
public class BiometricGatePlugin extends Plugin {
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", isDeviceSecure());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || !isDeviceSecure()) {
            resolveStatus(call, "unavailable", null);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && activity instanceof FragmentActivity) {
            authenticateWithBiometricPrompt((FragmentActivity) activity, call);
            return;
        }

        authenticateWithDeviceCredentialIntent(activity, call);
    }

    @SuppressWarnings("deprecation")
    private void authenticateWithBiometricPrompt(FragmentActivity activity, PluginCall call) {
        Executor executor = ContextCompat.getMainExecutor(activity);
        BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                resolveStatus(call, "success", null);
            }

            @Override
            public void onAuthenticationError(int errorCode, CharSequence errString) {
                String status = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                    ? "cancelled"
                    : "error";
                resolveStatus(call, status, errString == null ? null : errString.toString());
            }

            @Override
            public void onAuthenticationFailed() {
                // Keep the prompt open so the user can retry.
            }
        };

        BiometricPrompt prompt = new BiometricPrompt(activity, executor, callback);
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Road Sage")
            .setSubtitle("Use your device credential to continue")
            .setDeviceCredentialAllowed(true)
            .build();
        prompt.authenticate(promptInfo);
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
        call.resolve(result);
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
}
