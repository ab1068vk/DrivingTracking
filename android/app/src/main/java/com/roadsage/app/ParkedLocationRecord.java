package com.roadsage.app;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.format.DateTimeParseException;

final class ParkedLocationRecord {
    final JSONObject json;
    final long timestampMs;

    private ParkedLocationRecord(JSONObject json, long timestampMs) {
        this.json = json;
        this.timestampMs = timestampMs;
    }

    static ParkedLocationRecord parse(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;

        try {
            JSONObject json = new JSONObject(raw);
            return new ParkedLocationRecord(json, timestampMs(json));
        } catch (JSONException e) {
            return null;
        }
    }

    static boolean isNewerThan(ParkedLocationRecord candidate, ParkedLocationRecord current) {
        if (candidate == null) return false;
        if (current == null) return true;
        return candidate.timestampMs >= current.timestampMs;
    }

    private static long timestampMs(JSONObject json) {
        long millis = json.optLong("timestamp_ms", 0L);
        if (millis > 0L) return millis;

        String timestamp = json.optString("timestamp", "").trim();
        if (!timestamp.isEmpty()) {
            try {
                return Instant.parse(timestamp).toEpochMilli();
            } catch (DateTimeParseException ignored) {}
        }

        return 0L;
    }
}
