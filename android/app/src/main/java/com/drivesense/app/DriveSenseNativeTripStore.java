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

    /** Deliberate-stop ordering needs the enable bit durable before success is published. */
    static boolean setServiceEnabledDurably(Context context, boolean enabled) {
        return prefs(context).edit().putBoolean(KEY_SERVICE_ENABLED, enabled).commit();
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
        } catch (Exception error) {
            Log.w(TAG, "Could not set active trip status", error);
        }
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

    /**
     * AUD-005 round 2: a typed bounded page — items AND bytes — carrying the queue truth
     * (hasMore, oversized refusals, unreadable preserved entries) rather than leaving the
     * caller to infer continuation from how many trips came back.
     */
    static JSONObject getCompletedTripPage(Context context, int maxItems) {
        return DriveSenseCompletedTripJournal.getCompletedTripPage(context, maxItems);
    }

    static boolean hasCompletedTrip(Context context, String tripId) {
        return DriveSenseCompletedTripJournal.hasCompletedTrip(context, tripId);
    }

    static boolean addCompletedTrip(Context context, JSONObject trip) {
        boolean journaled = DriveSenseCompletedTripJournal.addCompletedTrip(context, trip);
        if (!journaled) return false;
        if (!DriveSenseP35Flags.nativeAuthorityEnabled()) return true;
        try {
            DriveSenseTripArchiveRepository archive = new DriveSenseTripArchiveRepository(context);
            // The just-written journal is the bounded source. Never hand the
            // complete JSONObject to canonical storage or ACK it by a second
            // in-memory serialization path.
            archive.ingestCompletedJournal(1,32L*1024L*1024L);
        } catch (Exception error) {
            // The intake journal remains the durable retry source. Never turn a
            // canonical failure into an ACK or a failed journal admission.
            DriveSenseDurabilityJournal.record(context, "ERROR", "CANONICAL_COMMIT_DEFERRED",
                null, 1L, 0L, 0L, "RECOVERY_REQUIRED");
            Log.w(TAG, "Completed trip retained in intake journal for native archive retry", error);
        }
        return true;
    }

    /**
     * AUD-005. One trip in memory at a time.
     *
     * This used to reconstruct every pending journal entry into one array, mutate the
     * array, and write the whole thing back, so acknowledging a crash prompt cost the
     * whole backlog. The ids are enumerated from manifests (small and bounded by the
     * journal's own entry ceiling) and each trip is read, mutated and rewritten on its
     * own. A trip that cannot be read is preserved and skipped, exactly as before.
     */
    /** One bounded emergency-acknowledgement action, across bounded turns. */
    private static final int MAX_EMERGENCY_ACK_TRIPS = 16;
    private static final int MAX_EMERGENCY_ACK_TURNS = 8;
    /** Durable resume point, so a continuation survives the process that started it. */
    static final String KEY_EMERGENCY_ACK_CURSOR = "emergency_ack_cursor";
    /**
     * Unresolved-work marker, kept separately from the cursor.
     *
     * A failed write at the HEAD of the ordering leaves work to redo with no cursor to
     * resume from — null means "start at the beginning", which is indistinguishable from
     * "nothing pending" if the cursor is the only record. This flag is the record.
     */
    static final String KEY_EMERGENCY_ACK_PENDING = "emergency_ack_pending";

    /**
     * AUD-005. The outcome of ONE bounded emergency-acknowledgement action.
     *
     * A boolean could not carry the fact that mattered. The budget is 16 actions, so with
     * 17 pending workflows the method truthfully knew work remained — and then returned
     * `true`, the caller recorded that the driver had checked in OK, the notification was
     * cancelled, and nothing durable or scheduled existed to finish the rest. The
     * continuation has to cross the method boundary, so it does, as a value.
     */
    static final class EmergencyAckOutcome {
        /** At least one pending workflow was acknowledged by this turn. */
        final boolean changed;
        /** Every change this turn made was persisted. */
        final boolean saved;
        /** Pending emergency work remains after this turn's budget was spent. */
        final boolean hasMore;
        /** Durable resume point for the next turn, or null when the queue is exhausted. */
        final String nextCursor;
        /** How many trips this turn actually acknowledged. */
        final int acknowledged;
        /**
         * Whether the continuation this turn leaves behind was DURABLY recorded.
         *
         * `SharedPreferences.commit()` returns a boolean and can throw. Swallowing either
         * turns "we could not remember there is work left" into apparent success, and a
         * process death afterwards then converts unresolved work into silence.
         */
        final boolean continuationDurable;

        EmergencyAckOutcome(boolean changed, boolean saved, boolean hasMore,
                            String nextCursor, int acknowledged, boolean continuationDurable) {
            this.changed = changed;
            this.saved = saved;
            this.hasMore = hasMore;
            this.nextCursor = nextCursor;
            this.acknowledged = acknowledged;
            this.continuationDurable = continuationDurable;
        }

        /** True only when nothing is outstanding. A caller may claim completion on this. */
        boolean complete() {
            return saved && !hasMore;
        }

        /**
         * True when the caller must schedule or persist a continuation.
         *
         * AUD-005: a turn whose write did NOT persist has unresolved work even though the
         * paging is exhausted. Reading only `hasMore` here let the final row fail to save
         * and still be treated as finished — no retry, prompt cancelled, completion
         * emitted. Unsaved is unresolved.
         */
        boolean needsContinuation() {
            return hasMore || !saved;
        }
    }

    /**
     * AUD-005. What a caller must DO with an outcome, decided in one place.
     *
     * The service used to branch on `hasMore` directly, which is why a final row that
     * changed in memory and then failed to save was treated as finished. Completion is
     * predicated on `complete()` here and nowhere else, so there is one answer rather than
     * one per call site.
     */
    static final class EmergencyAckDisposition {
        /** Another bounded turn is required. */
        final boolean scheduleContinuation;
        /** The queue is genuinely finished and a caller may say so. */
        final boolean reportComplete;
        /** Work remains and it is NOT durably recorded; only this process still knows. */
        final boolean continuationAtRisk;
        /** Diagnostic reason, so the log distinguishes these states after the fact. */
        final String reason;

        EmergencyAckDisposition(boolean scheduleContinuation, boolean reportComplete,
                                boolean continuationAtRisk, String reason) {
            this.scheduleContinuation = scheduleContinuation;
            this.reportComplete = reportComplete;
            this.continuationAtRisk = continuationAtRisk;
            this.reason = reason;
        }
    }

    static EmergencyAckDisposition dispositionFor(EmergencyAckOutcome outcome) {
        if (outcome == null) {
            return new EmergencyAckDisposition(true, false, true, "notification_ok_unknown");
        }
        if (outcome.complete()) {
            return new EmergencyAckDisposition(false, true, false, "notification_ok_complete");
        }
        // Not complete. Either paging has more, or a write did not persist - both mean the
        // queue is unresolved, so another bounded turn is required and nothing may report
        // completion. A continuation that could not be made durable is flagged, because
        // only this process then knows the work exists.
        boolean atRisk = !outcome.continuationDurable;
        String reason = !outcome.saved
            ? (atRisk ? "notification_ok_unsaved_volatile" : "notification_ok_unsaved")
            : (atRisk ? "notification_ok_continuation_volatile" : "notification_ok_continuation");
        return new EmergencyAckDisposition(true, false, atRisk, reason);
    }

    /** The durable continuation left by a previous turn, or null. */
    static String pendingEmergencyAckCursor(Context context) {
        try {
            String value = prefs(context).getString(KEY_EMERGENCY_ACK_CURSOR, null);
            return value == null || value.isEmpty() ? null : value;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** The preference HINT only. Fast, and never the sole authority. */
    static boolean hasPendingEmergencyAckHint(Context context) {
        try {
            return prefs(context).getBoolean(KEY_EMERGENCY_ACK_PENDING, false)
                || pendingEmergencyAckCursor(context) != null;
        } catch (Exception ignored) {
            // Cannot tell => assume there is work. Resuming a finished queue costs one
            // bounded turn that finds nothing; skipping a real one strands it.
            return true;
        }
    }

    /**
     * AUD-005 restart discovery. Is there unresolved emergency acknowledgement work?
     *
     * THE DEFECT: this used to be the preference hint alone. The very failure that put a
     * continuation at risk — `commit()` returning false or throwing — also erased the only
     * record that work existed, so a process death immediately afterwards turned a durable
     * `emergency_workflow_pending:true` in the journal into silence at the next startup.
     *
     * The hint is kept because it is fast and carries a resume position. It is no longer
     * the authority: when it says nothing, the DURABLE journal is asked, boundedly, and
     * only an authoritative "none" lets startup do nothing.
     */
    static boolean hasPendingEmergencyAckWork(Context context) {
        if (hasPendingEmergencyAckHint(context)) return true;
        // Only a classified NONE lets startup do nothing. PENDING and UNKNOWN both retain,
        // and startup applies the SAME bounded recovery policy to each - UNKNOWN failing
        // safe is not the same as UNKNOWN retrying without bound.
        return classifyStartupEmergencyDiscovery(context) != EMERGENCY_DISCOVERY_NONE;
    }

    /**
     * ─── AUD-005 startup discovery: ONE interpretation point ──────────────────────────
     *
     * THE DEFECT THIS REPLACES. Startup asked `page.tripIds.isEmpty()` and read the answer
     * as "the journal holds no unresolved emergency work". Those are different statements.
     * A disabled control plane over an unreadable manifest returns a page that is
     * truthfully `tripIds=[]`, `unreadableTripIds=[x]`, `hasMore=true` — the evidence of
     * unresolved work is RIGHT THERE and the caller threw it away, silently converting
     * UNKNOWN into NONE, so a restart scheduled nothing.
     *
     * The lesson is the one `EmergencyAckOutcome.complete()` already taught: a truth
     * contract needs exactly one authoritative interpretation point. Raw fields are never
     * read by startup again; they are turned into evidence, and the evidence is classified
     * here.
     */
    static final int EMERGENCY_DISCOVERY_NONE = 0;
    static final int EMERGENCY_DISCOVERY_PENDING = 1;
    static final int EMERGENCY_DISCOVERY_UNKNOWN = -1;

    /**
     * What a bounded acquisition actually told us. Every field is evidence that already
     * exists on a `PendingPage` or a plugin page; none is a weaker alias invented here.
     */
    static final class DiscoveryEvidence {
        /** Readable pending trip ids came back. */
        boolean readablePending;
        /** Entries seen but not resolvable — preserved, never acknowledged. */
        boolean unreadable;
        /** Entries preserved because they exceed the materialization ceiling. */
        boolean oversized;
        /** A typed blocked page. */
        boolean blocked;
        /** The acquisition says more remains behind this page. */
        boolean hasMore;
        /** The queue's own count of preserved unreadable entries. */
        long preservedUnreadableCount;
        /** The bounded page could not be acquired at all. */
        boolean acquisitionFailed;
        /** The queue could not describe its own state. */
        boolean queueStatusUnresolved;

        /**
         * Map a bounded `PendingPage`. `blocked` and `oversized` are not expressed at this
         * layer — an acquisition that cannot answer THROWS, which the caller records as
         * `acquisitionFailed`, and an oversized entry is still a readable id here. They are
         * carried on the evidence anyway so a caller holding a plugin page classifies
         * through the same contract rather than reinterpreting fields of its own.
         */
        static DiscoveryEvidence fromPendingPage(DriveSenseCompletedTripJournal.PendingPage page) {
            DiscoveryEvidence evidence = new DiscoveryEvidence();
            if (page == null) {
                evidence.acquisitionFailed = true;
                return evidence;
            }
            evidence.readablePending = page.tripIds != null && !page.tripIds.isEmpty();
            evidence.unreadable = page.unreadableTripIds != null && !page.unreadableTripIds.isEmpty();
            evidence.preservedUnreadableCount = page.unreadableTripIds == null ? 0L : page.unreadableTripIds.size();
            evidence.hasMore = page.hasMore;
            return evidence;
        }

        static DiscoveryEvidence failedAcquisition() {
            DiscoveryEvidence evidence = new DiscoveryEvidence();
            evidence.acquisitionFailed = true;
            return evidence;
        }
    }

    /**
     * The truth table, in one place.
     *
     * NONE has to be EARNED: it is returned only when the authoritative source proves it,
     * or when a bounded page came back with no readable work AND no unresolved evidence of
     * any kind. Everything else is PENDING or UNKNOWN, and UNKNOWN retains.
     *
     * @param evidence           what the bounded acquisition reported
     * @param authoritativeState DriveSenseJournalControlPlane.EMERGENCY_*
     */
    static int classifyEmergencyDiscovery(DiscoveryEvidence evidence, int authoritativeState) {
        if (authoritativeState == DriveSenseJournalControlPlane.EMERGENCY_PENDING) {
            return EMERGENCY_DISCOVERY_PENDING;
        }
        if (authoritativeState == DriveSenseJournalControlPlane.EMERGENCY_NONE) {
            return EMERGENCY_DISCOVERY_NONE;
        }
        // The authority could not answer: a disabled control plane, an index that is not
        // VERIFIED, a legacy row indexed as UNKNOWN. The bounded page is all there is.
        if (evidence == null) return EMERGENCY_DISCOVERY_UNKNOWN;
        if (evidence.acquisitionFailed || evidence.blocked || evidence.queueStatusUnresolved) {
            return EMERGENCY_DISCOVERY_UNKNOWN;
        }
        if (evidence.unreadable || evidence.oversized || evidence.preservedUnreadableCount > 0L) {
            // Preserved work whose nature cannot be determined. It is not nothing.
            return EMERGENCY_DISCOVERY_UNKNOWN;
        }
        if (evidence.readablePending) return EMERGENCY_DISCOVERY_PENDING;
        // No readable ids. `hasMore` means something is behind this page that was not
        // shown, which is not the same as an empty journal.
        if (evidence.hasMore) return EMERGENCY_DISCOVERY_UNKNOWN;
        return EMERGENCY_DISCOVERY_NONE;
    }

    /** The startup question, answered once, in three states. */
    static int classifyStartupEmergencyDiscovery(Context context) {
        int authoritative = DriveSenseJournalControlPlane.emergencyWorkflowState(context);
        if (authoritative == DriveSenseJournalControlPlane.EMERGENCY_PENDING
            || authoritative == DriveSenseJournalControlPlane.EMERGENCY_NONE) {
            return classifyEmergencyDiscovery(null, authoritative);
        }
        DiscoveryEvidence evidence;
        try {
            // One bounded page. Never a scan, never a listing, never a decrypt-all.
            evidence = DiscoveryEvidence.fromPendingPage(
                DriveSenseCompletedTripJournal.pendingTripIdsPage(context, 1, null));
        } catch (Exception error) {
            Log.w(TAG, "Bounded emergency discovery page could not be acquired", error);
            evidence = DiscoveryEvidence.failedAcquisition();
        }
        return classifyEmergencyDiscovery(evidence, authoritative);
    }


    /**
     * Record the continuation, and report whether it is DURABLE.
     *
     * AUD-005: this used to swallow both `commit() == false` and any exception, so a
     * failure to remember unresolved work looked exactly like success.
     *
     * @return true only if the state below is known to be on disk
     */
    private static boolean writeEmergencyAckContinuation(Context context, String cursor, boolean pending) {
        try {
            SharedPreferences.Editor editor = prefs(context).edit();
            if (cursor == null || cursor.isEmpty()) editor.remove(KEY_EMERGENCY_ACK_CURSOR);
            else editor.putString(KEY_EMERGENCY_ACK_CURSOR, cursor);
            if (pending) editor.putBoolean(KEY_EMERGENCY_ACK_PENDING, true);
            else editor.remove(KEY_EMERGENCY_ACK_PENDING);
            boolean committed = editor.commit();
            if (!committed) {
                Log.w(TAG, "Emergency acknowledgement continuation was not committed");
            }
            return committed;
        } catch (Exception error) {
            Log.w(TAG, "Could not persist the emergency acknowledgement continuation", error);
            return false;
        }
    }

    static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow(Context context, String acknowledgedAt) {
        boolean changed = false;
        boolean saved = true;
        // Round 2: bounded acquisition here too. The whole-backlog enumeration this
        // replaced read and sorted every manifest before it could touch the first trip.
        // AUD-005 round 3. One page is not the queue. The index caps a page below the
        // action budget, so asking once and discarding `hasMore` left later pending crash
        // workflows untouched while reporting success. Bounded TURNS are driven until the
        // action budget is spent or the queue is exhausted, and whatever is left is
        // reported so it can be scheduled again.
        java.util.List<String> pending = new java.util.ArrayList<>();
        boolean remaining = false;
        int acknowledged = 0;
        final String startCursor = pendingEmergencyAckCursor(context);
        String lastCursor = null;
        try {
            int budget = MAX_EMERGENCY_ACK_TRIPS;
            // AUD-005. Turns without a continuation are not progress.
            //
            // Acknowledging a crash prompt does not remove a journal entry, and the page
            // was always taken from the start of the ordering, so every turn re-read the
            // same capped prefix: the de-duplication silently discarded it, the budget
            // never moved, and every pending workflow past the first page was unreachable
            // while this reported success. Each turn now resumes AFTER the last row the
            // previous turn accepted.
            // AUD-005: resume where the previous action's budget ran out. Without this a
            // fresh action re-walks rows it already acknowledged, spends the budget on
            // no-ops, and the tail stays unreachable no matter how often the user taps OK.
            String cursor = startCursor;
            for (int turn = 0; turn < MAX_EMERGENCY_ACK_TURNS && budget > 0; turn += 1) {
                DriveSenseCompletedTripJournal.PendingPage page =
                    DriveSenseCompletedTripJournal.pendingTripIdsPage(context, budget, cursor);
                for (String tripId : page.tripIds) {
                    if (pending.contains(tripId)) continue;
                    pending.add(tripId);
                    budget -= 1;
                }
                remaining = page.hasMore;
                cursor = page.nextCursor;
                if (cursor != null) lastCursor = cursor;
                // No continuation means this turn cannot advance. Stopping and reporting
                // what is left is truthful; asking again would re-read the same page.
                if (!page.hasMore || page.tripIds.isEmpty() || page.nextCursor == null) break;
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not enumerate pending trips for emergency acknowledgement", error);
            // Unknown is not "nothing left": the continuation stays where it was, and the
            // caller is told work may remain rather than being allowed to claim success.
            return new EmergencyAckOutcome(false, false, true, pendingEmergencyAckCursor(context), 0,
                hasPendingEmergencyAckWork(context));
        }
        for (String tripId : pending) {
            JSONObject trip = DriveSenseCompletedTripJournal.getCompletedTrip(context, tripId);
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
                    } catch (JSONException error) {
                        Log.w(TAG, "Could not acknowledge pending emergency workflow", error);
                    }
                }
            }
            if (trip.optBoolean("emergency_workflow_pending", false)) {
                try {
                    trip.put("emergency_workflow_pending", false);
                    trip.put("emergency_workflow_acknowledged_at", acknowledgedAt);
                    trip.put("emergency_workflow_acknowledged_action", "ok");
                    tripChanged = true;
                } catch (JSONException error) {
                    Log.w(TAG, "Could not acknowledge pending emergency workflow", error);
                }
            }
            if (!tripChanged) continue;
            changed = true;
            acknowledged += 1;
            if (!DriveSenseCompletedTripJournal.addCompletedTrip(context, trip)) saved = false;
        }
        // The continuation is durable BEFORE the caller is told anything, so a process that
        // dies between this return and the caller's scheduling still resumes where it
        // stopped. Exhausting the queue clears it, so the next action starts fresh.
        // Unknown is RETAIN: a turn that reports more work but produces no new resume
        // point keeps the one it started with, rather than rewinding to the head of the
        // ordering and re-walking the same prefix on every future action.
        // AUD-005: a turn whose write did not persist must REVISIT the rows it failed on,
        // so it keeps the cursor it started with rather than advancing past them.
        String continuation = !saved
            ? startCursor
            : remaining ? (lastCursor != null ? lastCursor : startCursor) : null;
        boolean unresolved = remaining || !saved;
        boolean continuationDurable = writeEmergencyAckContinuation(context, continuation, unresolved);
        if (unresolved) {
            Log.w(TAG, "Emergency acknowledgement left pending journal work for a later turn");
        }
        return new EmergencyAckOutcome(changed, saved, remaining, continuation, acknowledged,
            continuationDurable);
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
        // Imported process-exit evidence must never be stamped as this launch.
        if (!event.optBoolean("historical_attribution", false)) {
            try {
                event.put("sessionId", DiagnosticsBuildIdentity.PROCESS_SESSION_ID);
                event.put("buildScopeId", DiagnosticsBuildIdentity.currentArtifactId());
            } catch (JSONException ignored) {}
        }
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
                } catch (Exception error) {
                    Log.w(TAG, "Could not should preserve higher confidence", error);
                }
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
        } catch (Exception error) {
            Log.w(TAG, "Could not save last parked location", error);
        }
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
        } catch (Exception error) {
            Log.w(TAG, "Could not save last parked location", error);
        }
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
        } catch (Exception error) {
            Log.w(TAG, "Could not clear parking photo reference", error);
        }
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
        } catch (Exception error) {
            Log.w(TAG, "Could not get parking reminder state", error);
        }
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
