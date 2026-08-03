package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;

final class SpeedSignEvidenceStore {
    private static final String KEY = "speed_sign_evidence_queue_v1";
    private static final String CONTEXT = "native:speed_sign_evidence";
    private static final int MAX_ITEMS = 32;

    private SpeedSignEvidenceStore() {}

    static synchronized int count(Context context) {
        SpeedSignReviewImageStore.cleanupExpired(context);
        return read(context).length();
    }

    static synchronized JSONArray drain(Context context) {
        SpeedSignReviewImageStore.cleanupExpired(context);
        JSONArray current = read(context);
        clearQueue(context);
        return current;
    }

    static synchronized void erase(Context context) {
        clearQueue(context);
        SpeedSignReviewImageStore.eraseAll(context);
    }

    private static void clearQueue(Context context) {
        SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(prefs, KEY)) {
            prefs.edit().remove(KEY).apply();
        }
    }

    static synchronized boolean append(
        Context context,
        SpeedSignObservationFusion.FusedObservation observation,
        String displayedUnit,
        String fallbackTripId,
        Location fallbackLocation,
        byte[] reviewImageJpeg,
        double visualQuality,
        String visualQualityLabel,
        String scanPolicyLabel,
        boolean signTargetFound,
        double signTargetScore
    ) {
        SpeedSignReviewImageStore.cleanupExpired(context);
        JSONObject tripStatus = DriveSenseNativeTripStore.getActiveTripStatus(context);
        JSONObject point = tripStatus != null && tripStatus.optBoolean("active", false)
            ? latestPublicPoint(tripStatus.optJSONArray("route_preview"))
            : null;
        String tripId = tripStatus != null && tripStatus.optBoolean("active", false)
            ? tripStatus.optString("id", "")
            : fallbackTripId == null ? "" : fallbackTripId.trim();
        double lat = point != null
            ? point.optDouble("lat", point.optDouble("latitude", Double.NaN))
            : fallbackLocation != null ? fallbackLocation.getLatitude() : Double.NaN;
        double lng = point != null
            ? point.optDouble("lng", point.optDouble("longitude", Double.NaN))
            : fallbackLocation != null ? fallbackLocation.getLongitude() : Double.NaN;
        double heading = point != null
            ? point.optDouble("heading", tripStatus.optDouble("heading_deg", Double.NaN))
            : fallbackLocation != null && fallbackLocation.hasBearing()
                ? fallbackLocation.getBearing()
                : Double.NaN;
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90d || Math.abs(lng) > 180d) {
            return false;
        }
        if (tripId.isEmpty() || PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng)) return false;

        String unit = "imperial".equals(displayedUnit) ? "mph" : "km/h";
        double limitKmh = "mph".equals(unit)
            ? observation.displayedValue * 1.609344d
            : observation.displayedValue;
        String evidenceId = "sign_" + UUID.randomUUID();
        long reviewImageExpiresAt = SpeedSignReviewImageStore.write(
            context,
            evidenceId,
            reviewImageJpeg
        );
        JSONObject evidence = new JSONObject();
        try {
            evidence.put("id", evidenceId);
            evidence.put("tripId", tripId);
            evidence.put("corridorId", corridorId(lat, lng, heading));
            evidence.put("limitKmh", Math.round(limitKmh * 10d) / 10d);
            evidence.put("displayedValue", observation.displayedValue);
            evidence.put("displayedUnit", unit);
            evidence.put("confidence", observation.confidence);
            evidence.put("frameCount", observation.frameCount);
            evidence.put("visualQuality", Math.max(0d, Math.min(1d, visualQuality)));
            evidence.put("visualQualityLabel", visualQualityLabel == null ? "Unavailable" : visualQualityLabel);
            evidence.put("scanPolicyLabel", scanPolicyLabel == null ? "Adaptive scan" : scanPolicyLabel);
            evidence.put("detectorMode", "local_sign_proposal_v1");
            evidence.put("signTargetFound", signTargetFound);
            evidence.put("signTargetScore", Math.max(0d, Math.min(1d, signTargetScore)));
            evidence.put("timestamp", observation.timestampMs);
            evidence.put("source", "on_device_regulatory_text");
            evidence.put("qualifierStatus", observation.qualifierKind);
            evidence.put("conditional", observation.conditional);
            evidence.put("requiresParkedConfirmation", true);
            evidence.put("affectsScore", false);
            evidence.put("affectsVoiceAlerts", false);
            evidence.put("reviewImageAvailable", reviewImageExpiresAt > 0L);
            if (reviewImageExpiresAt > 0L) {
                evidence.put("reviewImageExpiresAt", reviewImageExpiresAt);
            }
        } catch (JSONException ignored) {
            SpeedSignReviewImageStore.delete(context, evidenceId);
            return false;
        }

        JSONArray current = read(context);
        JSONArray next = new JSONArray();
        int start = Math.max(0, current.length() - (MAX_ITEMS - 1));
        for (int index = 0; index < start; index++) {
            JSONObject dropped = current.optJSONObject(index);
            if (dropped != null) {
                SpeedSignReviewImageStore.delete(context, dropped.optString("id", ""));
            }
        }
        for (int index = start; index < current.length(); index++) next.put(current.opt(index));
        next.put(evidence);
        boolean saved = write(context, next);
        if (!saved) SpeedSignReviewImageStore.delete(context, evidenceId);
        return saved;
    }

    private static JSONObject latestPublicPoint(JSONArray points) {
        if (points == null) return null;
        for (int index = points.length() - 1; index >= 0; index--) {
            JSONObject point = points.optJSONObject(index);
            if (point == null) continue;
            if (point.optBoolean("privacy_masked", false) || point.optBoolean("masked_for_privacy", false)) continue;
            double lat = point.optDouble("lat", point.optDouble("latitude", Double.NaN));
            double lng = point.optDouble("lng", point.optDouble("longitude", Double.NaN));
            if (Double.isFinite(lat) && Double.isFinite(lng)) return point;
        }
        return null;
    }

    private static String corridorId(double lat, double lng, double heading) {
        double roundedLat = Math.round(lat * 10_000d) / 10_000d;
        double roundedLng = Math.round(lng * 10_000d) / 10_000d;
        int headingBucket = Double.isFinite(heading)
            ? Math.floorMod((int) Math.round(heading / 45d), 8)
            : -1;
        String input = String.format(Locale.ROOT, "%.4f|%.4f|%d", roundedLat, roundedLng, headingBucket);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder encoded = new StringBuilder("corridor_");
            for (int index = 0; index < 9; index++) {
                encoded.append(String.format(Locale.ROOT, "%02x", digest[index]));
            }
            return encoded.toString();
        } catch (Exception ignored) {
            return "corridor_unavailable";
        }
    }

    private static JSONArray read(Context context) {
        String stored = DriveSenseNativeTripStore.prefs(context).getString(KEY, "");
        if (stored == null || stored.trim().isEmpty()) return new JSONArray();
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, CONTEXT);
            return new JSONArray(raw);
        } catch (Exception ignored) {
            erase(context);
            return new JSONArray();
        }
    }

    private static boolean write(Context context, JSONArray value) {
        try {
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(value.toString(), CONTEXT);
            DriveSenseNativeTripStore.prefs(context).edit().putString(KEY, encrypted).apply();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}
