package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

final class PrivacyZoneChecker {
    static final String PRIVACY_ZONES_KEY = "privacy_zones_v1";
    private static final String TAG = "PrivacyZone";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String DRIVE_SENSE_SETTINGS_PREFS = "DriveSenseSettings";
    private static final String SETTINGS_KEY = "drivesense_settings";
    private static final String PRIVACY_ZONES_CONTEXT = "native:privacy_zones_v1";
    private static final double GUARD_METERS = 50.0d;

    private PrivacyZoneChecker() {}

    static boolean isInsidePrivacyZone(Context context, double lat, double lng) {
        return findPrivacyZone(context, lat, lng) != null;
    }

    static JSONObject findPrivacyZone(Context context, double lat, double lng) {
        if (!isValidCoordinate(lat, lng)) return null;

        JSONArray zones = getPrivacyZones(context);
        for (int i = 0; i < zones.length(); i++) {
            JSONObject zone = zones.optJSONObject(i);
            if (zone == null) continue;

            double zoneLat = firstFinite(zone, "lat", "latitude");
            double zoneLng = firstFinite(zone, "lng", "longitude");
            double zoneRadiusM = firstFinite(zone, "radius_m", "radius");
            if (!isValidCoordinate(zoneLat, zoneLng) || !Double.isFinite(zoneRadiusM) || zoneRadiusM <= 0d) {
                continue;
            }

            float[] distanceM = new float[1];
            Location.distanceBetween(lat, lng, zoneLat, zoneLng, distanceM);
            if (distanceM[0] <= zoneRadiusM + GUARD_METERS) {
                return zone;
            }
        }
        return null;
    }

    static JSONArray redactRoutePoints(Context context, JSONArray points) {
        JSONArray redactedPoints = new JSONArray();
        if (points == null) return redactedPoints;

        for (int i = 0; i < points.length(); i++) {
            JSONObject point = points.optJSONObject(i);
            if (point == null) continue;

            JSONObject zone = findPrivacyZone(
                context,
                point.optDouble("lat", Double.NaN),
                point.optDouble("lng", Double.NaN)
            );
            if (zone == null) {
                redactedPoints.put(point);
                continue;
            }

            try {
                JSONObject redacted = new JSONObject(point.toString());
                redacted.remove("lat");
                redacted.remove("lng");
                redacted.remove("latitude");
                redacted.remove("longitude");
                redacted.remove("original_lat");
                redacted.remove("original_lng");
                redacted.remove("matched_lat");
                redacted.remove("matched_lng");
                redacted.put("lat", JSONObject.NULL);
                redacted.put("lng", JSONObject.NULL);
                redacted.put("masked_for_privacy", true);
                redacted.put("privacy_gap", true);
                redacted.put("privacy_live_redacted", true);
                redacted.put("privacy_zone_id", zone.optString("id", ""));
                redacted.put("privacy_zone_label", zone.optString("label", "Private place"));
                redactedPoints.put(redacted);
            } catch (Exception error) {
                JSONObject placeholder = new JSONObject();
                try {
                    placeholder.put("lat", JSONObject.NULL);
                    placeholder.put("lng", JSONObject.NULL);
                    placeholder.put("timestamp", point.optString("timestamp", ""));
                    placeholder.put("speed_kmh", point.optDouble("speed_kmh", 0d));
                    placeholder.put("masked_for_privacy", true);
                    placeholder.put("privacy_gap", true);
                    placeholder.put("privacy_live_redacted", true);
                    placeholder.put("privacy_zone_id", zone.optString("id", ""));
                    placeholder.put("privacy_zone_label", zone.optString("label", "Private place"));
                    redactedPoints.put(placeholder);
                } catch (Exception ignored) {}
            }
        }

        return redactedPoints;
    }

    private static JSONArray getPrivacyZones(Context context) {
        JSONArray mirroredZones = parseZoneArray(readString(context, CAPACITOR_PREFS, PRIVACY_ZONES_KEY));
        if (mirroredZones.length() > 0) return mirroredZones;

        JSONArray legacyMirroredZones = parseZoneArray(readString(context, DRIVE_SENSE_SETTINGS_PREFS, PRIVACY_ZONES_KEY));
        if (legacyMirroredZones.length() > 0) return legacyMirroredZones;

        try {
            String rawSettings = readString(context, CAPACITOR_PREFS, SETTINGS_KEY);
            if (rawSettings == null || rawSettings.trim().isEmpty()) return new JSONArray();
            JSONObject settings = new JSONObject(rawSettings);
            JSONArray settingsZones = settings.optJSONArray("privacy_zones");
            return settingsZones != null ? settingsZones : new JSONArray();
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone settings parse failed", error);
            return new JSONArray();
        }
    }

    private static JSONArray parseZoneArray(String raw) {
        if (raw == null || raw.trim().isEmpty()) return new JSONArray();
        try {
            String text = raw.trim();
            if (DriveSensePayloadCrypto.isEncryptedStoredValue(text)) {
                return new JSONArray(DriveSensePayloadCrypto.decryptStoredValue(text, PRIVACY_ZONES_CONTEXT));
            }
            if (text.startsWith("{")) {
                JSONObject payload = new JSONObject(text);
                if (payload.optBoolean("encrypted", false) && payload.has("ciphertext")) {
                    return new JSONArray(DriveSensePayloadCrypto.decrypt(
                        payload.getString("ciphertext"),
                        PRIVACY_ZONES_CONTEXT
                    ));
                }
            }
            return new JSONArray(text);
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone mirror parse failed", error);
            return new JSONArray();
        }
    }

    private static String readString(Context context, String prefsName, String key) {
        SharedPreferences prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE);
        return prefs.getString(key, null);
    }

    private static double firstFinite(JSONObject object, String primaryKey, String fallbackKey) {
        double primary = object.optDouble(primaryKey, Double.NaN);
        if (Double.isFinite(primary)) return primary;
        return object.optDouble(fallbackKey, Double.NaN);
    }

    private static boolean isValidCoordinate(double lat, double lng) {
        return Double.isFinite(lat) &&
            Double.isFinite(lng) &&
            Math.abs(lat) <= 90d &&
            Math.abs(lng) <= 180d;
    }
}
