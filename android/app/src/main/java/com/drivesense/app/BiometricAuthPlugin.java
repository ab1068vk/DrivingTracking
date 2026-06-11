package com.drivesense.app;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BiometricAuth")
public class BiometricAuthPlugin extends Plugin {
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_STRONG |
        BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private BiometricPrompt activePrompt;
    private PluginCall activeCall;

    @PluginMethod
    public void checkAvailability(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", canAuthenticate());
        result.put("deviceSecure", isDeviceSecure());
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (activeCall != null) {
                call.reject("Authentication is already in progress.", "AUTH_IN_PROGRESS");
                return;
            }
            if (!canAuthenticate()) {
                call.reject("Set a device PIN, password, pattern, fingerprint, or secure face unlock first.", "AUTH_UNAVAILABLE");
                return;
            }
            if (!(getActivity() instanceof FragmentActivity)) {
                call.reject("Authentication is unavailable in this activity.", "AUTH_UNAVAILABLE");
                return;
            }

            activeCall = call;
            FragmentActivity activity = (FragmentActivity) getActivity();
            activePrompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticationResult) {
                        JSObject result = new JSObject();
                        result.put("verified", true);
                        finish(result);
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errorMessage) {
                        JSObject result = new JSObject();
                        result.put("verified", false);
                        result.put("cancelled", isCancellation(errorCode));
                        result.put("errorCode", errorCode);
                        result.put("message", String.valueOf(errorMessage));
                        finish(result);
                    }
                }
            );

            String title = safeText(call.getString("title"), "Unlock Road Sage", 80);
            String subtitle = safeText(call.getString("subtitle"), "Verify your identity", 160);
            BiometricPrompt.PromptInfo.Builder builder = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setConfirmationRequired(false);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(AUTHENTICATORS);
            } else {
                builder.setDeviceCredentialAllowed(true);
            }
            activePrompt.authenticate(builder.build());
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (activePrompt != null) activePrompt.cancelAuthentication();
        activePrompt = null;
        activeCall = null;
        super.handleOnDestroy();
    }

    private boolean canAuthenticate() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS) ==
                BiometricManager.BIOMETRIC_SUCCESS;
        }
        return isDeviceSecure();
    }

    private boolean isDeviceSecure() {
        KeyguardManager keyguardManager =
            (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return keyguardManager != null && keyguardManager.isDeviceSecure();
    }

    private boolean isCancellation(int errorCode) {
        return errorCode == BiometricPrompt.ERROR_CANCELED ||
            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
            errorCode == BiometricPrompt.ERROR_USER_CANCELED;
    }

    private String safeText(String value, String fallback, int maxLength) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) text = fallback;
        return text.substring(0, Math.min(text.length(), maxLength));
    }

    private void finish(JSObject result) {
        PluginCall call = activeCall;
        activeCall = null;
        activePrompt = null;
        if (call != null) call.resolve(result);
    }
}
