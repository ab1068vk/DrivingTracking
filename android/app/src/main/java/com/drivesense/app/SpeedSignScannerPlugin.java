package com.drivesense.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "SpeedSignScanner",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class SpeedSignScannerPlugin extends Plugin {
    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(statusPayload());
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(statusPayload());
            return;
        }
        requestPermissionForAlias("camera", call, "cameraPermissionCallback");
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        call.resolve(statusPayload());
    }

    @PluginMethod
    public void startScanner(PluginCall call) {
        call.reject(
            "Manual sign-scanner start is disabled for driving safety. Open the Mounted Ready screen before departure and keep Road Sage visible on the mounted phone."
        );
    }

    @PluginMethod
    public void armMountedScanner(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("userInitiated", false))) {
            call.reject("Mounted scanning must be armed by the user while parked.");
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is required before arming mounted scanning.");
            return;
        }
        if (!SpeedSignScannerSettings.isScannerEnabled(getContext())) {
            call.reject("Enable on-device speed-sign scanning before arming the next drive.");
            return;
        }
        if (activeTripState().active) {
            call.reject("Arm mounted scanning before the trip starts, while parked.");
            return;
        }
        if (!SpeedSignScannerActivity.isSafeToStart(getContext())) {
            call.reject("Mounted scanning cannot be armed because the battery is low or the phone is too warm.");
            return;
        }
        if (SpeedSignScannerActivity.isRunning()) {
            if (SpeedSignScannerActivity.isArmedForTrip()) {
                JSObject payload = statusPayload();
                payload.put("alreadyArmed", true);
                call.resolve(payload);
            } else {
                call.reject("A speed-sign scanner session is already active.");
            }
            return;
        }

        Intent intent = SpeedSignScannerActivity.createArmedIntent(
            getContext(),
            "imperial".equals(call.getString("units", "metric")) ? "imperial" : "metric",
            20,
            15
        );
        getActivity().startActivity(intent);
        JSObject payload = statusPayload();
        payload.put("armRequested", true);
        payload.put("armTimeoutMinutes", 15);
        call.resolve(payload);
    }

    @PluginMethod
    public void startPreparedManualScanner(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("userInitiated", false))) {
            call.reject("Manual trip camera mode must be selected by the user while parked.");
            return;
        }
        String expectedTripId = call.getString("tripId", "").trim();
        if (expectedTripId.isEmpty() || expectedTripId.length() > 120) {
            call.reject("A valid prepared manual-trip ID is required.");
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is required for the manual trip camera.");
            return;
        }
        if (!SpeedSignScannerSettings.isScannerEnabled(getContext())) {
            call.reject("Enable on-device speed-sign scanning before starting a camera trip.");
            return;
        }
        if (!SpeedSignScannerActivity.isSafeToStart(getContext())) {
            call.reject("The camera trip cannot start because the battery is low or the phone is too warm.");
            return;
        }
        if (SpeedSignScannerActivity.isRunning()) {
            call.reject("A speed-sign scanner or Ready-screen session is already active.");
            return;
        }

        org.json.JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(getContext());
        if (
            activeTrip != null
                && activeTrip.optBoolean("active", false)
                && !SpeedSignScannerSettings.shouldStartPreparedManualScanner(
                    true,
                    activeTrip.optBoolean("candidate", true),
                    activeTrip.optBoolean("manual", false),
                    activeTrip.optString("state", ""),
                    activeTrip.optString("id", ""),
                    expectedTripId
                )
        ) {
            call.reject("A different or unconfirmed trip is active. End it before starting a manual camera trip.");
            return;
        }

        Intent intent = SpeedSignScannerActivity.createPreparedManualIntent(
            getContext(),
            expectedTripId,
            "imperial".equals(call.getString("units", "metric")) ? "imperial" : "metric",
            20
        );
        getActivity().startActivity(intent);
        JSObject payload = statusPayload();
        payload.put("manualScannerRequested", true);
        payload.put("tripId", expectedTripId);
        call.resolve(payload);
    }

    @PluginMethod
    public void drainEvidence(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("evidence", SpeedSignEvidenceStore.drain(getContext()));
        call.resolve(payload);
    }

    @PluginMethod
    public void eraseEvidence(PluginCall call) {
        SpeedSignEvidenceStore.erase(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getEvidenceImage(PluginCall call) {
        String evidenceId = call.getString("evidenceId", "");
        byte[] jpeg = SpeedSignReviewImageStore.read(getContext(), evidenceId);
        JSObject payload = new JSObject();
        payload.put("available", jpeg != null && jpeg.length > 0);
        if (jpeg != null && jpeg.length > 0) {
            payload.put(
                "dataUrl",
                "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP)
            );
        }
        call.resolve(payload);
    }

    @PluginMethod
    public void deleteEvidenceImage(PluginCall call) {
        SpeedSignReviewImageStore.delete(
            getContext(),
            call.getString("evidenceId", "")
        );
        call.resolve();
    }

    private JSObject statusPayload() {
        JSObject payload = new JSObject();
        boolean cameraGranted =
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean scannerActive = SpeedSignScannerActivity.isRunning();
        boolean tripActive = activeTripState().active;
        boolean safeToStart = SpeedSignScannerActivity.isSafeToStart(getContext());
        payload.put("scannerEnabled", SpeedSignScannerSettings.isScannerEnabled(getContext()));
        payload.put(
            "cameraPermission",
            cameraGranted
                ? "granted"
                : getPermissionState("camera") == PermissionState.DENIED ? "denied" : "prompt"
        );
        payload.put("scannerActive", scannerActive);
        payload.put("tripActive", tripActive);
        payload.put("safeToStart", safeToStart);
        payload.put("pendingEvidenceCount", SpeedSignEvidenceStore.count(getContext()));
        payload.put("mode", "local_sign_proposal_v1");
        payload.put("focusMode", "locked_forward_metering");
        payload.put("fusionRequiredFrames", SpeedSignObservationFusion.REQUIRED_FRAMES);
        payload.put("lastScanSummary", SpeedSignScannerActivity.lastScanSummary(getContext()));
        payload.put("offline", true);
        payload.put("storesFrames", false);
        payload.put("storesFullFrames", false);
        payload.put("storesTemporaryReviewCrop", true);
        payload.put("reviewImageTtlHours", 24);
        payload.put("requiresParkedConfirmation", true);
        payload.put("mountedModeEnabled", SpeedSignScannerActivity.isArmedForTrip());
        payload.put("armedForNextTrip", SpeedSignScannerActivity.isArmedForTrip());
        payload.put("armTimeoutMinutes", 15);
        payload.put("backgroundNotificationActionAvailable", false);
        payload.put("manualStartAvailable", false);
        payload.put("preparedManualStartAvailable", true);
        payload.put("safeLaunchMode", "parked_pretrip_auto_or_manual");
        return payload;
    }

    private JSONObjectTripState activeTripState() {
        org.json.JSONObject activeTrip = DriveSenseNativeTripStore.getActiveTripStatus(getContext());
        return new JSONObjectTripState(activeTrip != null && activeTrip.optBoolean("active", false));
    }

    private static final class JSONObjectTripState {
        final boolean active;

        JSONObjectTripState(boolean active) {
            this.active = active;
        }
    }
}
