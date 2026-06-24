package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.location.Location;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;

final class PrivacyZoneChecker {
    static final String PRIVACY_ZONES_KEY = "privacy_zones_v1";
    private static final String TAG = "PrivacyZone";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    private static final String DRIVE_SENSE_SETTINGS_PREFS = "DriveSenseSettings";
    private static final String SETTINGS_KEY = "drivesense_settings";
    private static final String PRIVACY_ZONES_CONTEXT = "native:privacy_zones_v1";
    private static final double GUARD_METERS = 50.0d;
    private static final double DEFAULT_PRIVACY_CELL_SIZE_M = 100.0d;
    private static final String[] KINEMATIC_FIELDS = new String[] {
        "speed",
        "speed_kmh",
        "speedKmh",
        "speed_mps",
        "speedMps",
        "speed_accuracy",
        "speedAccuracy",
        "obd_speed_kmh",
        "heading",
        "heading_accuracy",
        "headingAccuracy",
        "bearing",
        "bearing_accuracy",
        "bearingAccuracy",
        "course",
        "altitude",
        "altitude_m",
        "altitude_accuracy",
        "altitudeAccuracy",
        "vertical_speed",
        "verticalSpeed",
        "vertical_accuracy",
        "verticalAccuracy",
        "accuracy",
        "horizontal_accuracy",
        "horizontalAccuracy",
        "accel_ms2",
        "acceleration_ms2",
        "acceleration_x",
        "acceleration_y",
        "acceleration_z",
        "accelerationX",
        "accelerationY",
        "accelerationZ"
    };

    private PrivacyZoneChecker() {}

    private static final class ZoneReadResult {
        final JSONArray zones;
        final boolean failClosed;

        ZoneReadResult(JSONArray zones, boolean failClosed) {
            this.zones = zones != null ? zones : new JSONArray();
            this.failClosed = failClosed;
        }
    }

    private static final class ZoneParseResult {
        final JSONArray zones;
        final boolean present;
        final boolean failed;

        ZoneParseResult(JSONArray zones, boolean present, boolean failed) {
            this.zones = zones != null ? zones : new JSONArray();
            this.present = present;
            this.failed = failed;
        }
    }

    static boolean isInsidePrivacyZone(Context context, double lat, double lng) {
        return findPrivacyZone(context, lat, lng) != null;
    }

    static JSONObject findPrivacyZone(Context context, double lat, double lng) {
        if (!isValidCoordinate(lat, lng)) return null;

        ZoneReadResult zoneRead = getPrivacyZoneReadResult(context);
        if (zoneRead.failClosed) return failClosedZone();

        JSONArray zones = zoneRead.zones;
        for (int i = 0; i < zones.length(); i++) {
            JSONObject zone = zones.optJSONObject(i);
            if (zone == null) continue;
            if (isExpired(zone, System.currentTimeMillis())) continue;

            double zoneLat = firstFinite(zone, "lat", "latitude");
            double zoneLng = firstFinite(zone, "lng", "longitude");
            double zoneRadiusM = firstFinite(zone, "radius_m", "radius");
            if (!isValidCoordinate(zoneLat, zoneLng) || !Double.isFinite(zoneRadiusM) || zoneRadiusM <= 0d) {
                if (isInsidePrivacyCellZone(lat, lng, zone)) {
                    return zone;
                }
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
                nullKinematicFields(redacted);
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
                    nullKinematicFields(placeholder);
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

    private static ZoneReadResult getPrivacyZoneReadResult(Context context) {
        ZoneParseResult mirroredZones = parseZoneArray(readString(context, CAPACITOR_PREFS, PRIVACY_ZONES_KEY));
        if (mirroredZones.zones.length() > 0) return new ZoneReadResult(mirroredZones.zones, false);
        if (mirroredZones.present && mirroredZones.failed) return failClosedReadResult("Privacy zone mirror unreadable");

        ZoneParseResult legacyMirroredZones = parseZoneArray(readString(context, DRIVE_SENSE_SETTINGS_PREFS, PRIVACY_ZONES_KEY));
        if (legacyMirroredZones.zones.length() > 0) return new ZoneReadResult(legacyMirroredZones.zones, false);
        if (legacyMirroredZones.present && legacyMirroredZones.failed) return failClosedReadResult("Legacy privacy zone mirror unreadable");

        try {
            String rawSettings = readString(context, CAPACITOR_PREFS, SETTINGS_KEY);
            if (rawSettings == null || rawSettings.trim().isEmpty()) {
                return new ZoneReadResult(new JSONArray(), false);
            }
            JSONObject settings = new JSONObject(rawSettings);
            JSONArray settingsZones = settings.optJSONArray("privacy_zones");
            if (settingsZones == null || settingsZones.length() == 0) {
                return new ZoneReadResult(new JSONArray(), false);
            }
            if (hasUsableZoneGuard(settingsZones)) {
                return new ZoneReadResult(settingsZones, false);
            }
            return failClosedReadResult("Privacy zones configured without native geometry mirror");
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone settings parse failed", error);
            return failClosedReadResult("Privacy zone settings unreadable");
        }
    }

    private static ZoneParseResult parseZoneArray(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return new ZoneParseResult(new JSONArray(), false, false);
        }
        try {
            String text = raw.trim();
            if (DriveSensePayloadCrypto.isEncryptedStoredValue(text)) {
                return new ZoneParseResult(
                    new JSONArray(DriveSensePayloadCrypto.decryptStoredValue(text, PRIVACY_ZONES_CONTEXT)),
                    true,
                    false
                );
            }
            if (text.startsWith("{")) {
                JSONObject payload = new JSONObject(text);
                if (payload.optBoolean("encrypted", false) && payload.has("ciphertext")) {
                    return new ZoneParseResult(
                        new JSONArray(DriveSensePayloadCrypto.decrypt(
                            payload.getString("ciphertext"),
                            PRIVACY_ZONES_CONTEXT,
                            payload.optInt("key_version", 0)
                        )),
                        true,
                        false
                    );
                }
            }
            return new ZoneParseResult(new JSONArray(text), true, false);
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone mirror parse failed", error);
            return new ZoneParseResult(new JSONArray(), true, true);
        }
    }

    private static ZoneReadResult failClosedReadResult(String reason) {
        Log.w(TAG, reason + "; native GPS will be treated as private until zones sync.");
        return new ZoneReadResult(new JSONArray(), true);
    }

    private static JSONObject failClosedZone() {
        JSONObject zone = new JSONObject();
        try {
            zone.put("id", "native_privacy_sync_unavailable");
            zone.put("label", "Private place");
        } catch (Exception ignored) {}
        return zone;
    }

    private static boolean hasUsableZoneGuard(JSONArray zones) {
        if (zones == null) return false;
        for (int i = 0; i < zones.length(); i++) {
            JSONObject zone = zones.optJSONObject(i);
            if (zone == null) continue;
            double zoneLat = firstFinite(zone, "lat", "latitude");
            double zoneLng = firstFinite(zone, "lng", "longitude");
            double zoneRadiusM = firstFinite(zone, "radius_m", "radius");
            if (isValidCoordinate(zoneLat, zoneLng) &&
                Double.isFinite(zoneRadiusM) &&
                zoneRadiusM > 0d) {
                return true;
            }
            if (hasUsableCellGeometry(zone)) return true;
        }
        return false;
    }

    private static boolean hasUsableCellGeometry(JSONObject zone) {
        JSONArray hashes = zone.optJSONArray("privacy_cell_hashes");
        return hashes != null && hashes.length() > 0;
    }

    private static boolean isInsidePrivacyCellZone(double lat, double lng, JSONObject zone) {
        JSONArray hashes = zone.optJSONArray("privacy_cell_hashes");
        if (hashes == null || hashes.length() == 0) return false;

        double cellSizeM = zone.optDouble("privacy_cell_size_m", DEFAULT_PRIVACY_CELL_SIZE_M);
        if (!Double.isFinite(cellSizeM) || cellSizeM < 25d) {
            cellSizeM = DEFAULT_PRIVACY_CELL_SIZE_M;
        }
        long[] cell = privacyCellCoordinate(lat, lng, cellSizeM);
        String hash = privacyCellHash(cell[0], cell[1], cellSizeM);

        for (int i = 0; i < hashes.length(); i++) {
            if (hash.equals(hashes.optString(i, ""))) return true;
        }
        return false;
    }

    private static long[] privacyCellCoordinate(double lat, double lng, double cellSizeM) {
        double latStep = cellSizeM / 111320.0d;
        double lngStep = cellSizeM / 111320.0d;
        long y = (long) Math.floor((lat + 90.0d) / latStep);
        long x = (long) Math.floor((lng + 180.0d) / lngStep);
        return new long[] { y, x };
    }

    private static String privacyCellHash(long y, long x, double cellSizeM) {
        long unsignedHash = jsHashCodeUnsigned(Math.round(cellSizeM) + ":" + y + ":" + x);
        return "pzc_" + Long.toString(unsignedHash, 36);
    }

    private static long jsHashCodeUnsigned(String value) {
        int hash = 0;
        String text = value != null ? value : "";
        for (int i = 0; i < text.length(); i++) {
            hash = ((hash << 5) - hash) + text.charAt(i);
        }
        return Integer.toUnsignedLong(hash);
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

    private static void nullKinematicFields(JSONObject point) {
        if (point == null) return;
        for (String field : KINEMATIC_FIELDS) {
            if (!point.has(field)) continue;
            try {
                point.put(field, JSONObject.NULL);
            } catch (Exception ignored) {}
        }
    }

    private static boolean isExpired(JSONObject zone, long nowMs) {
        String expiresAt = zone != null ? zone.optString("expiresAt", "").trim() : "";
        if (expiresAt.isEmpty()) return false;
        try {
            return Instant.parse(expiresAt).toEpochMilli() <= nowMs;
        } catch (Exception error) {
            Log.w(TAG, "Privacy zone expiry parse failed; keeping zone active", error);
            return false;
        }
    }
}
