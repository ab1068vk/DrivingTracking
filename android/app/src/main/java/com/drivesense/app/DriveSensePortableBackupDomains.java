package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Portable, user-owned non-canonical domains included by the v2 backup policy.
 *
 * Device-bound keys, encrypted wrappers, diagnostics, queues, and ephemeral UI
 * state are deliberately absent.  Settings receive the same privacy property
 * as the legacy backup: zone geometry/cell hashes are not portable.
 */
final class DriveSensePortableBackupDomains {
    static final int MAX_DOMAIN_BYTES = 8 * 1024 * 1024;
    static final String PREFS_NAME = "CapacitorStorage";

    private static final List<String> DOMAIN_IDS = Collections.unmodifiableList(Arrays.asList(
        "drivesense_vehicles",
        "drivesense_settings",
        "road_sage_trip_filter_presets",
        "road_sage_calibration_labels",
        "road_sage_calibration_survey_markers"
    ));

    private final Context context;

    DriveSensePortableBackupDomains(Context context) {
        this.context = context.getApplicationContext();
    }

    List<Record> snapshot() throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        List<Record> records = new ArrayList<>();
        for (String domainId : DOMAIN_IDS) {
            String value = preferences.getString(domainId, null);
            if (value == null) continue;
            if ("drivesense_settings".equals(domainId)) value = privacySafeSettings(value);
            byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
            if (encoded.length > MAX_DOMAIN_BYTES) {
                Arrays.fill(encoded, (byte) 0);
                throw new IllegalStateException("PORTABLE_DOMAIN_TOO_LARGE:" + domainId);
            }
            records.add(new Record(domainId, encoded));
        }
        return records;
    }

    void applyVerified(List<Record> records) throws Exception {
        SharedPreferences.Editor editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
        for (Record record : records) {
            if (!DOMAIN_IDS.contains(record.domainId)) {
                throw new SecurityException("Unsupported portable domain: " + record.domainId);
            }
            if (record.bytes.length > MAX_DOMAIN_BYTES) {
                throw new SecurityException("Portable domain exceeded byte ceiling");
            }
            String json = new String(record.bytes, StandardCharsets.UTF_8);
            // Parse before applying so malformed portable state cannot be published.
            Object parsed = new org.json.JSONTokener(json).nextValue();
            if (!(parsed instanceof JSONObject) && !(parsed instanceof JSONArray)) {
                throw new SecurityException("Portable domain is not JSON: " + record.domainId);
            }
            editor.putString(record.domainId, json);
        }
        if (!editor.commit()) throw new IllegalStateException("Portable domain restore commit failed");
    }

    private static String privacySafeSettings(String encoded) throws Exception {
        JSONObject settings = new JSONObject(encoded);
        JSONArray source = settings.optJSONArray("privacy_zones");
        if (source != null) {
            JSONArray placeholders = new JSONArray();
            for (int index = 0; index < source.length(); index++) {
                JSONObject zone = source.optJSONObject(index);
                JSONObject safe = new JSONObject();
                safe.put("id", zone == null ? "" : bounded(zone.optString("id"), 120));
                safe.put("label", zone == null ? "Private area" : bounded(zone.optString("label", "Private area"), 120));
                safe.put("masked_for_privacy", true);
                placeholders.put(safe);
            }
            settings.put("privacy_zones", placeholders);
        }
        // These fields either disclose private geometry/cell identity or bind
        // portable state to device-only key material.
        settings.remove("privacy_cell_key");
        settings.remove("privacy_zone_cells");
        settings.remove("privacy_zones_native_sync_failed_at");
        settings.remove("privacy_zones_native_sync_status");
        return settings.toString();
    }

    private static String bounded(String value, int max) {
        String normalized = value == null ? "" : value;
        return normalized.length() <= max ? normalized : normalized.substring(0, max);
    }

    static final class Record {
        final String domainId;
        final byte[] bytes;
        Record(String domainId, byte[] bytes) {
            this.domainId = domainId;
            this.bytes = bytes;
        }
        void clear() { Arrays.fill(bytes, (byte) 0); }
    }
}
