package com.drivesense.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.UUID;

class DriveSenseNativeTripStore {
    private static final String TAG = "NativeTripStore";
    private static final String PREFS = "drivesense_native_tracking";
    private static final String CAPACITOR_PREFS = "CapacitorStorage";
    static final String KEY_COMPLETED_TRIPS = "completed_trips";
    private static final String KEY_SERVICE_ENABLED = "service_enabled";
    private static final String KEY_ACTIVE_TRIP_STATUS = "active_trip_status";
    private static final String KEY_WIDGET_TRIP_ACTIVE = "widget_trip_active";
    private static final String KEY_WIDGET_TRIP_CANDIDATE = "widget_trip_candidate";
    private static final String KEY_DIAGNOSTIC_EVENTS = "diagnostic_events";
    private static final String KEY_LAST_PARKED = "last_parked_location";
    private static final String KEY_LAST_PARKING_STATE = "last_parking_state";
    private static final String KEY_PARKING_REMINDER_STATE = "parking_reminder_state";
    private static final String SHARED_LAST_PARKED_KEY = "drivesense_last_parked";
    private static final String SHARED_LAST_PARKING_STATE_KEY = "drivesense_last_parking_state";
    static final String COMPLETED_TRIPS_CONTEXT = "native:completed_trips";
    private static final String ACTIVE_TRIP_STATUS_CONTEXT = "native:active_trip_status";
    private static final String LAST_PARKED_CONTEXT = "native:last_parked";
    private static final String LAST_PARKING_STATE_CONTEXT = "native:last_parking_state";
    private static final String PARKING_REMINDER_STATE_CONTEXT = "native:parking_reminder_state";
    private static final String SHARED_LAST_PARKED_CONTEXT = "storage:drivesense_last_parked";
    private static final String SHARED_LAST_PARKING_STATE_CONTEXT = "storage:drivesense_last_parking_state";
    private static final int MAX_DIAGNOSTIC_EVENTS = 120;

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isServiceEnabled(Context context) {
        return prefs(context).getBoolean(KEY_SERVICE_ENABLED, false);
    }

    static void setServiceEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_SERVICE_ENABLED, enabled).apply();
    }

    static JSONObject getActiveTripStatus(Context context) {
        String stored = prefs(context).getString(KEY_ACTIVE_TRIP_STATUS, "");
        if (stored == null || stored.trim().isEmpty()) return null;
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, ACTIVE_TRIP_STATUS_CONTEXT);
            JSONObject status = new JSONObject(raw);
            if (!DriveSensePayloadCrypto.isEncryptedStoredValue(stored)) {
                setActiveTripStatus(context, status);
            }
            return status;
        } catch (Exception error) {
            clearActiveTripStatus(context);
            return null;
        }
    }

    static void setActiveTripStatus(Context context, JSONObject status) {
        if (status == null) {
            clearActiveTripStatus(context);
            return;
        }
        try {
            boolean wasActive = prefs(context).getBoolean(KEY_WIDGET_TRIP_ACTIVE, false);
            boolean wasCandidate = prefs(context).getBoolean(KEY_WIDGET_TRIP_CANDIDATE, false);
            boolean isActive = status.optBoolean("active", false);
            boolean isCandidate = isActive && status.optBoolean(
                "candidate",
                "candidate".equals(status.optString("state", ""))
            );
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(status.toString(), ACTIVE_TRIP_STATUS_CONTEXT);
            prefs(context).edit()
                .putString(KEY_ACTIVE_TRIP_STATUS, encrypted)
                .putBoolean(KEY_WIDGET_TRIP_ACTIVE, isActive)
                .putBoolean(KEY_WIDGET_TRIP_CANDIDATE, isCandidate)
                .apply();
            if (wasActive != isActive || wasCandidate != isCandidate) {
                WhereIParkedWidgetProvider.refreshAll(context);
            }
        } catch (Exception ignored) {}
    }

    static void clearActiveTripStatus(Context context) {
        boolean wasActive = prefs(context).getBoolean(KEY_WIDGET_TRIP_ACTIVE, false);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(prefs(context), KEY_ACTIVE_TRIP_STATUS)) {
            prefs(context).edit().remove(KEY_ACTIVE_TRIP_STATUS).apply();
        }
        prefs(context).edit()
            .putBoolean(KEY_WIDGET_TRIP_ACTIVE, false)
            .putBoolean(KEY_WIDGET_TRIP_CANDIDATE, false)
            .apply();
        if (wasActive) WhereIParkedWidgetProvider.refreshAll(context);
    }

    static JSONArray getCompletedTrips(Context context) {
        return DriveSenseCompletedTripJournal.getCompletedTrips(context);
    }

    static boolean hasCompletedTrip(Context context, String tripId) {
        return DriveSenseCompletedTripJournal.hasCompletedTrip(context, tripId);
    }

    static boolean addCompletedTrip(Context context, JSONObject trip) {
        return DriveSenseCompletedTripJournal.addCompletedTrip(context, trip);
    }

    static boolean acknowledgePendingEmergencyWorkflow(Context context, String acknowledgedAt) {
        JSONArray current = getCompletedTrips(context);
        JSONArray next = new JSONArray();
        boolean changed = false;
        for (int i = 0; i < current.length(); i++) {
            JSONObject trip = current.optJSONObject(i);
            if (trip == null) continue;
            boolean tripChanged = false;
            JSONArray events = trip.optJSONArray("driving_events");
            if (events != null) {
                for (int eventIndex = 0; eventIndex < events.length(); eventIndex++) {
                    JSONObject event = events.optJSONObject(eventIndex);
                    if (event == null || !"possible_crash".equals(event.optString("type", ""))) continue;
                    if (!event.optBoolean("emergency_workflow_pending", false) && event.has("emergency_workflow_acknowledged")) continue;
                    try {
                        event.put("emergency_workflow_pending", false);
                        event.put("emergency_workflow_acknowledged", "ok");
                        event.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                        tripChanged = true;
                    } catch (JSONException ignored) {}
                }
            }
            if (trip.optBoolean("emergency_workflow_pending", false)) {
                try {
                    trip.put("emergency_workflow_pending", false);
                    trip.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                    trip.put("emergency_workflow_acknowledged_action", "ok");
                    tripChanged = true;
                } catch (JSONException ignored) {}
            }
            if (tripChanged) changed = true;
            next.put(trip);
        }
        if (!changed) return false;
        boolean saved = true;
        for (int index = 0; index < next.length(); index++) {
            JSONObject trip = next.optJSONObject(index);
            if (trip != null && !DriveSenseCompletedTripJournal.addCompletedTrip(context, trip)) saved = false;
        }
        return saved;
    }

    static void clearCompletedTrips(Context context) {
        DriveSenseCompletedTripJournal.clear(context);
    }

    static void eraseAllForDataRights(Context context) {
        clearCompletedTrips(context);
        DriveSenseActiveTripCheckpointStore.clear(context);
        SharedPreferences nativePreferences = prefs(context);
        for (String key : new String[] {
            KEY_ACTIVE_TRIP_STATUS,
            KEY_DIAGNOSTIC_EVENTS,
            KEY_LAST_PARKED,
            KEY_LAST_PARKING_STATE
        }) {
            SecureDeleteHelper.overwriteAndRemovePreference(nativePreferences, key);
        }
        nativePreferences.edit().clear().commit();
        AppExperienceWatchdog.erase(context);
        DriveSenseAutoTrackingService.clearNotificationStateForDataErasure(context);
        WhereIParkedWidgetProvider.refreshAll(context);
    }

    static JSONObject acknowledgeCompletedTrips(Context context, JSONArray tripIds) {
        return DriveSenseCompletedTripJournal.acknowledgeCompletedTrips(context, tripIds);
    }

    static JSONObject getCompletedTripJournalStatus(Context context) {
        return DriveSenseCompletedTripJournal.getStatus(context);
    }

    static JSONArray getDiagnosticEvents(Context context) {
        String raw = prefs(context).getString(KEY_DIAGNOSTIC_EVENTS, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void addDiagnosticEvent(Context context, JSONObject event) {
        JSONArray current = getDiagnosticEvents(context);
        JSONArray next = new JSONArray();
        next.put(event);
        for (int i = 0; i < current.length() && next.length() < MAX_DIAGNOSTIC_EVENTS; i++) {
            JSONObject item = current.optJSONObject(i);
            if (item != null) next.put(item);
        }
        prefs(context).edit().putString(KEY_DIAGNOSTIC_EVENTS, next.toString()).apply();
    }

    static void clearDiagnosticEvents(Context context) {
        prefs(context).edit().putString(KEY_DIAGNOSTIC_EVENTS, "[]").apply();
    }

    static JSONObject getLastParkedLocation(Context context) {
        JSONObject parkingState = getLastParkingState(context);
        if (parkingState == null || !"saved".equals(parkingState.optString("status", ""))) return null;
        JSONObject nativeParked = readParkingRecord(
            prefs(context).getString(KEY_LAST_PARKED, null),
            LAST_PARKED_CONTEXT
        );
        JSONObject sharedParked = readParkingRecord(
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .getString(SHARED_LAST_PARKED_KEY, null),
            SHARED_LAST_PARKED_CONTEXT
        );
        if (nativeParked != null && nativeParked.optBoolean("suppressed", false)) nativeParked = null;
        if (sharedParked != null && sharedParked.optBoolean("suppressed", false)) sharedParked = null;
        JSONObject parked = newerParkingRecord(nativeParked, sharedParked);
        if (parked == null) return null;
        if (PrivacyZoneChecker.isInsidePrivacyZone(
            context,
            parked.optDouble("lat", Double.NaN),
            parked.optDouble("lng", Double.NaN)
        )) {
            suppressLastParkedLocation(
                context,
                parkedTimestampMs(parked),
                parked.optString("tripId", ""),
                "privacy_zone"
            );
            clearExactParkedLocations(context);
            return null;
        }
        return parked;
    }

    static JSONObject getLastParkingState(Context context) {
        SharedPreferences nativePreferences = prefs(context);
        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        JSONObject nativeState = readParkingRecord(
            nativePreferences.getString(KEY_LAST_PARKING_STATE, null),
            LAST_PARKING_STATE_CONTEXT
        );
        JSONObject sharedState = readParkingRecord(
            sharedPreferences.getString(SHARED_LAST_PARKING_STATE_KEY, null),
            SHARED_LAST_PARKING_STATE_CONTEXT
        );
        JSONObject nativeParked = readParkingRecord(
            nativePreferences.getString(KEY_LAST_PARKED, null),
            LAST_PARKED_CONTEXT
        );
        JSONObject sharedParked = readParkingRecord(
            sharedPreferences.getString(SHARED_LAST_PARKED_KEY, null),
            SHARED_LAST_PARKED_CONTEXT
        );
        JSONObject latest = newerParkingRecord(nativeState, sharedState);
        latest = newerParkingRecord(latest, parkingStateFromLegacy(nativeParked));
        latest = newerParkingRecord(latest, parkingStateFromLegacy(sharedParked));
        return latest;
    }

    static JSONObject newerParkingRecord(JSONObject first, JSONObject second) {
        long firstRevision = parkingStateRevision(first);
        long secondRevision = parkingStateRevision(second);
        if (secondRevision != firstRevision) return secondRevision > firstRevision ? second : first;
        long firstMs = parkedTimestampMs(first);
        long secondMs = parkedTimestampMs(second);
        if (secondMs != firstMs) return secondMs > firstMs ? second : first;
        return parkingStatusPriority(second) > parkingStatusPriority(first) ? second : first;
    }

    private static int parkingStatusPriority(JSONObject record) {
        if (record == null) return 0;
        String status = record.optString("status", "");
        if ("private".equals(status)) return 3;
        if ("unavailable".equals(status)) return 2;
        if ("saved".equals(status)) return 1;
        return 0;
    }

    private static JSONObject parkingStateFromLegacy(JSONObject parked) {
        if (parked == null) return null;
        JSONObject state = new JSONObject();
        try {
            boolean suppressed = parked.optBoolean("suppressed", false);
            String source = parked.optString("source", suppressed ? "trip_end_unavailable" : "trip_end");
            state.put("version", 2);
            state.put("status", suppressed
                ? ("privacy_zone".equals(source) ? "private" : "unavailable")
                : "saved");
            state.put("timestamp", parked.optString("timestamp", ""));
            if (parked.has("timestamp_ms")) state.put("timestamp_ms", parked.optLong("timestamp_ms", 0L));
            state.put("source", source);
            state.put("tripId", parked.optString("tripId", ""));
            state.put("state_revision", parkingStateRevision(parked));
            if (!suppressed) {
                state.put("confidence", parked.optString("confidence", "estimated"));
                state.put("confidence_score", parked.optInt("confidence_score", 0));
                state.put("verified", parked.optBoolean("verified", false));
                state.put("strategy", parked.optString("strategy", "last_trip_point"));
                state.put("refinement_count", parked.optInt("refinement_count", 0));
                JSONArray evidence = parked.optJSONArray("evidence");
                if (evidence != null) state.put("evidence", evidence);
            }
            return state;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONObject readParkingRecord(String stored, String contextName) {
        if (stored == null || stored.trim().isEmpty()) return null;
        try {
            String raw;
            if (DriveSensePayloadCrypto.isEncryptedStoredValue(stored)) {
                raw = DriveSensePayloadCrypto.decryptStoredValue(stored, contextName);
            } else {
                JSONObject wrapper = new JSONObject(stored);
                if (wrapper.optBoolean("encrypted", false) && wrapper.has("ciphertext")) {
                    raw = DriveSensePayloadCrypto.decrypt(
                        wrapper.getString("ciphertext"),
                        contextName,
                        wrapper.optInt("key_version", 0)
                    );
                } else {
                    raw = stored;
                }
            }
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static long parkedTimestampMs(JSONObject parked) {
        if (parked == null) return Long.MIN_VALUE;
        long storedMs = parked.optLong("timestamp_ms", 0L);
        if (storedMs > 0L) return storedMs;
        try {
            return Instant.parse(parked.optString("timestamp", "")).toEpochMilli();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    static long parkingStateRevision(JSONObject record) {
        if (record == null) return 0L;
        long revision = record.optLong("state_revision", 0L);
        return revision > 0L ? revision : Math.max(0L, parkedTimestampMs(record));
    }

    static boolean shouldPreserveHigherConfidence(JSONObject existing, JSONObject incoming) {
        if (existing == null || incoming == null) return false;
        String existingTrip = existing.optString("tripId", "");
        String incomingTrip = incoming.optString("tripId", "");
        if (existingTrip.isEmpty() || !existingTrip.equals(incomingTrip)) return false;
        if (incoming.optBoolean("verified", false)) return false;
        int existingScore = existing.optInt("confidence_score", 0);
        int incomingScore = incoming.optInt("confidence_score", 0);
        return existing.optBoolean("verified", false) || existingScore > incomingScore;
    }

    static JSONObject commitParkingSnapshot(
        Context context,
        JSONObject incomingState,
        JSONObject incomingLocation
    ) throws Exception {
        if (incomingState == null) throw new IllegalArgumentException("Parking state is required.");
        JSONObject existing = getLastParkingState(context);
        long incomingRevision = parkingStateRevision(incomingState);
        if (incomingRevision <= 0L) throw new IllegalArgumentException("A parking revision is required.");
        if (parkingStateRevision(existing) > incomingRevision ||
            shouldPreserveHigherConfidence(existing, incomingState)) {
            return existing;
        }

        String status = incomingState.optString("status", "");
        if (!"saved".equals(status) && !"private".equals(status) && !"unavailable".equals(status)) {
            throw new IllegalArgumentException("Unsupported parking status.");
        }
        JSONObject state = new JSONObject(incomingState.toString());
        String encryptedLocation = null;
        if ("saved".equals(status)) {
            if (incomingLocation == null) throw new IllegalArgumentException("Saved parking requires a location.");
            double lat = incomingLocation.optDouble("lat", Double.NaN);
            double lng = incomingLocation.optDouble("lng", Double.NaN);
            if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90d || Math.abs(lng) > 180d) {
                throw new IllegalArgumentException("Saved parking coordinates are invalid.");
            }
            if (PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng)) {
                throw new SecurityException("A privacy-zone coordinate cannot be committed to parking storage.");
            }
            JSONObject location = new JSONObject(incomingLocation.toString());
            location.put("state_revision", incomingRevision);
            encryptedLocation = DriveSensePayloadCrypto.encryptForStorage(
                location.toString(),
                LAST_PARKED_CONTEXT
            );
        }
        String encryptedState = DriveSensePayloadCrypto.encryptForStorage(
            state.toString(),
            LAST_PARKING_STATE_CONTEXT
        );
        SharedPreferences.Editor editor = prefs(context).edit()
            .putString(KEY_LAST_PARKING_STATE, encryptedState);
        if (encryptedLocation != null) editor.putString(KEY_LAST_PARKED, encryptedLocation);
        else editor.remove(KEY_LAST_PARKED);
        if (!editor.commit()) {
            throw new IllegalStateException("The native parking snapshot could not be committed.");
        }
        if (incomingLocation != null) {
            String photoId = incomingLocation.optString("photo_file_id", "");
            String expiry = incomingLocation.optString("photo_expires_at", "");
            if (!photoId.isEmpty() && !expiry.isEmpty()) {
                try {
                    ParkingPhotoExpiryScheduler.schedule(
                        context,
                        photoId,
                        Instant.parse(expiry).toEpochMilli()
                    );
                } catch (Exception ignored) {}
            } else if (!photoId.isEmpty()) {
                ParkingPhotoExpiryScheduler.cancel(context, photoId);
            }
        }
        if (!"saved".equals(status)) {
            SharedPreferences sharedPreferences =
                context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
            if (!SecureDeleteHelper.overwriteAndRemovePreference(
                sharedPreferences,
                SHARED_LAST_PARKED_KEY
            )) {
                sharedPreferences.edit().remove(SHARED_LAST_PARKED_KEY).apply();
            }
        }
        WhereIParkedWidgetProvider.refreshAll(context);
        ParkingReviewNotifier.reconcile(context);
        return state;
    }

    private static long nextParkingStateRevision(JSONObject existing, long timestampMs) {
        return Math.max(
            Math.max(System.currentTimeMillis(), timestampMs),
            parkingStateRevision(existing) + 1L
        );
    }

    static void saveLastParkedLocation(Context context, double lat, double lng, long timestampMs, String tripId, String source) {
        saveLastParkedLocation(context, lat, lng, timestampMs, tripId, source, null);
    }

    static void saveLastParkedLocation(
        Context context,
        double lat,
        double lng,
        long timestampMs,
        String tripId,
        String source,
        JSONObject resolution
    ) {
        if (!Double.isFinite(lat) || !Double.isFinite(lng) || Math.abs(lat) > 90d || Math.abs(lng) > 180d) {
            return;
        }
        JSONObject existingState = getLastParkingState(context);
        if (parkedTimestampMs(existingState) > timestampMs) return;
        long stateRevision = nextParkingStateRevision(existingState, timestampMs);
        if (PrivacyZoneChecker.isInsidePrivacyZone(context, lat, lng)) {
            suppressLastParkedLocation(context, timestampMs, tripId, "privacy_zone");
            purgePrivateExactParkedLocations(context);
            Log.i(TAG, "Parked location suppressed (privacy zone)");
            return;
        }

        JSONObject parked = new JSONObject();
        try {
            parked.put("lat", lat);
            parked.put("lng", lng);
            parked.put("timestamp", DriveSenseAutoTrackingService.iso(timestampMs));
            parked.put("timestamp_ms", timestampMs);
            parked.put("tripId", tripId);
            parked.put("source", source);
            parked.put("state_revision", stateRevision);
            if (resolution != null) {
                parked.put("confidence", resolution.optString("confidence", "estimated"));
                parked.put("confidence_score", resolution.optInt("confidence_score", 0));
                parked.put("accuracy_m", resolution.optLong("accuracy_m", 0L));
                parked.put("strategy", resolution.optString("strategy", "last_trip_point"));
                parked.put("sample_count", resolution.optInt("sample_count", 1));
                parked.put("refinement_count", resolution.optInt("refinement_count", 0));
                parked.put("spread_m", resolution.optLong("spread_m", 0L));
                parked.put("indoor_estimated", resolution.optBoolean("indoor_estimated", false));
                if (resolution.has("vehicle_id")) {
                    parked.put("vehicle_id", resolution.optString("vehicle_id", ""));
                }
                if (resolution.has("vehicle_name")) {
                    parked.put("vehicle_name", resolution.optString("vehicle_name", ""));
                }
                if (resolution.has("garage_hint")) {
                    parked.put("garage_hint", resolution.optString("garage_hint", ""));
                }
                JSONObject garageEntrance = resolution.optJSONObject("garage_entrance");
                if (garageEntrance != null && !PrivacyZoneChecker.isInsidePrivacyZone(
                    context,
                    garageEntrance.optDouble("lat", Double.NaN),
                    garageEntrance.optDouble("lng", Double.NaN)
                )) {
                    parked.put("garage_entrance", garageEntrance);
                }
                JSONArray evidence = resolution.optJSONArray("evidence");
                if (evidence != null) parked.put("evidence", evidence);
            }
            JSONObject incomingState = parkingStateFromLegacy(parked);
            if (shouldPreserveHigherConfidence(existingState, incomingState)) {
                JSONObject event = new JSONObject();
                event.put("type", "parking_confidence_downgrade_blocked");
                event.put("timestamp", DriveSenseAutoTrackingService.iso(System.currentTimeMillis()));
                event.put("trip_id", tripId == null ? "" : tripId);
                event.put("existing_score", existingState.optInt("confidence_score", 0));
                event.put("incoming_score", incomingState.optInt("confidence_score", 0));
                addDiagnosticEvent(context, event);
                return;
            }
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(parked.toString(), LAST_PARKED_CONTEXT);
            prefs(context).edit().putString(KEY_LAST_PARKED, encrypted).apply();
            saveParkingState(context, incomingState);
            WhereIParkedWidgetProvider.refreshAll(context);
            ParkingReviewNotifier.reconcile(context);
        } catch (Exception ignored) {}
    }

    static void suppressLastParkedLocation(
        Context context,
        long timestampMs,
        String tripId,
        String source
    ) {
        JSONObject existingState = getLastParkingState(context);
        if (parkedTimestampMs(existingState) > timestampMs) return;
        long stateRevision = nextParkingStateRevision(existingState, timestampMs);
        JSONObject state = new JSONObject();
        try {
            state.put("version", 2);
            state.put("status", "privacy_zone".equals(source) ? "private" : "unavailable");
            state.put("timestamp", DriveSenseAutoTrackingService.iso(timestampMs));
            state.put("timestamp_ms", timestampMs);
            state.put("tripId", tripId == null ? "" : tripId);
            state.put("source", source == null ? "trip_end_unavailable" : source);
            state.put("state_revision", stateRevision);
            saveParkingState(context, state);
            WhereIParkedWidgetProvider.refreshAll(context);
            ParkingReviewNotifier.cancel(context);
        } catch (Exception ignored) {}
    }

    private static void saveParkingState(Context context, JSONObject state) throws Exception {
        String encrypted = DriveSensePayloadCrypto.encryptForStorage(
            state.toString(),
            LAST_PARKING_STATE_CONTEXT
        );
        prefs(context).edit().putString(KEY_LAST_PARKING_STATE, encrypted).apply();
    }

    private static void clearExactParkedLocations(Context context) {
        SharedPreferences nativePreferences = prefs(context);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(nativePreferences, KEY_LAST_PARKED)) {
            nativePreferences.edit().remove(KEY_LAST_PARKED).apply();
        }

        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(
            sharedPreferences,
            SHARED_LAST_PARKED_KEY
        )) {
            sharedPreferences.edit().remove(SHARED_LAST_PARKED_KEY).apply();
        }
    }

    static void clearParkingPhotoReference(Context context, String photoId) {
        if (photoId == null || photoId.trim().isEmpty()) return;
        SharedPreferences nativePreferences = prefs(context);
        JSONObject parked = readParkingRecord(
            nativePreferences.getString(KEY_LAST_PARKED, null),
            LAST_PARKED_CONTEXT
        );
        if (parked == null || !photoId.equals(parked.optString("photo_file_id", ""))) return;
        try {
            parked.remove("photo_data_url");
            parked.remove("photo_file_id");
            parked.remove("photo_expires_at");
            parked.remove("photo_retention_hours");
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(
                parked.toString(),
                LAST_PARKED_CONTEXT
            );
            nativePreferences.edit().putString(KEY_LAST_PARKED, encrypted).commit();
            WhereIParkedWidgetProvider.refreshAll(context);
        } catch (Exception ignored) {}
    }

    private static void purgePrivateExactParkedLocations(Context context) {
        SharedPreferences nativePreferences = prefs(context);
        JSONObject nativeParked = readParkingRecord(
            nativePreferences.getString(KEY_LAST_PARKED, null),
            LAST_PARKED_CONTEXT
        );
        if (nativeParked != null && PrivacyZoneChecker.isInsidePrivacyZone(
            context,
            nativeParked.optDouble("lat", Double.NaN),
            nativeParked.optDouble("lng", Double.NaN)
        )) {
            if (!SecureDeleteHelper.overwriteAndRemovePreference(nativePreferences, KEY_LAST_PARKED)) {
                nativePreferences.edit().remove(KEY_LAST_PARKED).apply();
            }
        }

        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        JSONObject sharedParked = readParkingRecord(
            sharedPreferences.getString(SHARED_LAST_PARKED_KEY, null),
            SHARED_LAST_PARKED_CONTEXT
        );
        if (sharedParked != null && PrivacyZoneChecker.isInsidePrivacyZone(
            context,
            sharedParked.optDouble("lat", Double.NaN),
            sharedParked.optDouble("lng", Double.NaN)
        )) {
            if (!SecureDeleteHelper.overwriteAndRemovePreference(sharedPreferences, SHARED_LAST_PARKED_KEY)) {
                sharedPreferences.edit().remove(SHARED_LAST_PARKED_KEY).apply();
            }
        }
    }

    static void clearLastParkedLocation(Context context) {
        clearExactParkedLocations(context);
        SharedPreferences nativePreferences = prefs(context);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(nativePreferences, KEY_LAST_PARKING_STATE)) {
            nativePreferences.edit().remove(KEY_LAST_PARKING_STATE).apply();
        }
        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(
            sharedPreferences,
            SHARED_LAST_PARKING_STATE_KEY
        )) {
            sharedPreferences.edit().remove(SHARED_LAST_PARKING_STATE_KEY).apply();
        }
        WhereIParkedWidgetProvider.refreshAll(context);
    }

    static void clearParkingSnapshotAtomic(Context context) {
        SharedPreferences nativePreferences = prefs(context);
        if (!nativePreferences.edit()
            .remove(KEY_LAST_PARKED)
            .remove(KEY_LAST_PARKING_STATE)
            .commit()) {
            throw new IllegalStateException("The native parking snapshot could not be cleared.");
        }
        SharedPreferences sharedPreferences =
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE);
        sharedPreferences.edit()
            .remove(SHARED_LAST_PARKED_KEY)
            .remove(SHARED_LAST_PARKING_STATE_KEY)
            .apply();
        WhereIParkedWidgetProvider.refreshAll(context);
    }

    static JSONObject getParkingReminderState(Context context) {
        JSONObject state = readParkingRecord(
            prefs(context).getString(KEY_PARKING_REMINDER_STATE, null),
            PARKING_REMINDER_STATE_CONTEXT
        );
        if (state == null) return null;
        long reminderAtMs = state.optLong("reminder_at_ms", 0L);
        if (reminderAtMs <= System.currentTimeMillis()) {
            removeParkingReminderState(context, false);
            return null;
        }
        return state;
    }

    static void saveParkingReminderState(
        Context context,
        long reminderAtMs,
        long stateRevision,
        String vehicleName
    ) {
        if (reminderAtMs <= System.currentTimeMillis()) {
            clearParkingReminderState(context);
            return;
        }
        try {
            JSONObject state = new JSONObject();
            state.put("reminder_at_ms", reminderAtMs);
            state.put("state_revision", Math.max(0L, stateRevision));
            state.put("vehicle_name", vehicleName == null ? "" : vehicleName);
            String encrypted = DriveSensePayloadCrypto.encryptForStorage(
                state.toString(),
                PARKING_REMINDER_STATE_CONTEXT
            );
            prefs(context).edit().putString(KEY_PARKING_REMINDER_STATE, encrypted).apply();
            WhereIParkedWidgetProvider.scheduleReminderDeadlineRefresh(context, reminderAtMs);
            WhereIParkedWidgetProvider.refreshAll(context);
        } catch (Exception ignored) {}
    }

    static void clearParkingReminderState(Context context) {
        removeParkingReminderState(context, true);
    }

    private static void removeParkingReminderState(Context context, boolean refreshWidget) {
        SharedPreferences preferences = prefs(context);
        if (!SecureDeleteHelper.overwriteAndRemovePreference(
            preferences,
            KEY_PARKING_REMINDER_STATE
        )) {
            preferences.edit().remove(KEY_PARKING_REMINDER_STATE).apply();
        }
        WhereIParkedWidgetProvider.cancelReminderDeadlineRefresh(context);
        if (refreshWidget) WhereIParkedWidgetProvider.refreshAll(context);
    }

    static String newTripId() {
        return "native_trip_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 8);
    }
}
