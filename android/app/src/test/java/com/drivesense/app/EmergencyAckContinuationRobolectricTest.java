package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;

/**
 * AUD-005 — a bounded emergency acknowledgement must hand its continuation across the
 * method boundary, and the caller must act on it.
 *
 * With more pending emergency workflows than the 16-action budget, the previous code knew
 * work remained, logged it, and returned success. The caller then recorded that the driver
 * had checked in OK and cancelled the prompt, with nothing durable and nothing scheduled —
 * so the rest could be abandoned until some unrelated future invocation happened to run.
 *
 * These are real journal entries written through the production writer, seventeen of them,
 * exercised through the production acknowledgement path. Java is otherwise compile-only in
 * this audit; this is a JVM unit test, not an instrumentation test, and makes no device
 * claim.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class EmergencyAckContinuationRobolectricTest {
    /** One more than the bounded action budget, so a continuation is unavoidable. */
    private static final int PENDING_WORKFLOWS = 17;
    private static final String ACKNOWLEDGED_AT = "2026-09-14T12:00:00.000Z";

    private Context context;

    @Before public void setUp() {
        org.robolectric.shadows.ShadowLog.stream = System.out;
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        byte[] key = new byte[32];
        java.util.Arrays.fill(key, (byte) 0x65);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        java.util.Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
    }

    private static void deleteTree(File root) {
        if (root == null || !root.exists()) return;
        File[] children = root.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        root.delete();
    }

    /** A completed trip carrying one pending `possible_crash` emergency workflow. */
    private static JSONObject pendingWorkflowTrip(int index) throws Exception {
        JSONObject event = new JSONObject();
        event.put("type", "possible_crash");
        event.put("emergency_workflow_pending", true);
        event.put("timestamp", String.format("2026-09-0%dT0%d:00:00.000Z", 1 + (index % 8), index % 10));
        JSONArray events = new JSONArray();
        events.put(event);

        JSONObject trip = new JSONObject();
        trip.put("id", "emergency-" + index);
        trip.put("status", "completed");
        // Distinct, increasing creation order so the keyset continuation has a real
        // ordering to advance through rather than an accidental one.
        trip.put("created_at_ms", 1_780_000_000_000L + index * 1_000L);
        trip.put("start_time", String.format("2026-09-14T%02d:00:00.000Z", index % 24));
        trip.put("end_time", String.format("2026-09-14T%02d:20:00.000Z", index % 24));
        trip.put("driving_events", events);
        return trip;
    }

    private void seedPendingWorkflows() throws Exception {
        for (int index = 0; index < PENDING_WORKFLOWS; index += 1) {
            assertTrue("journal write " + index,
                DriveSenseCompletedTripJournal.addCompletedTrip(context, pendingWorkflowTrip(index)));
        }
    }

    private static int stillPending(Context context) {
        int pending = 0;
        for (int index = 0; index < PENDING_WORKFLOWS; index += 1) {
            JSONObject trip = DriveSenseCompletedTripJournal.getCompletedTrip(context, "emergency-" + index);
            if (trip == null) continue;
            JSONArray events = trip.optJSONArray("driving_events");
            for (int e = 0; events != null && e < events.length(); e += 1) {
                JSONObject event = events.optJSONObject(e);
                if (event != null && event.optBoolean("emergency_workflow_pending", false)) pending += 1;
            }
        }
        return pending;
    }

    /**
     * A PLATFORM LIMIT, recorded rather than worked around.
     *
     * Acknowledgement persists its mutation by rewriting the journal entry. Under
     * Robolectric on Windows `AtomicFile` cannot rename over an existing file, so that
     * rewrite reports failure here and `outcome.saved` is false — the journal's own log
     * says `Failed to rename ….manifest.enc.new to ….manifest.enc`. This is a host
     * filesystem behaviour, not the contract under test, so nothing below asserts that a
     * flag was persisted. Every assertion is about the CONTINUATION contract, which is
     * what AUD-005 is about and which is independent of the rewrite.
     */
    @Test public void theRewriteLimitOfThisHostIsRecordedNotAssumedAway() throws Exception {
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, pendingWorkflowTrip(0)));
        JSONObject back = DriveSenseCompletedTripJournal.getCompletedTrip(context, "emergency-0");
        assertNotNull("the entry must read back", back);
        assertEquals("emergency-0", back.optString("id", ""));
        // The pending workflow is genuinely there to be acknowledged; the acknowledgement
        // path therefore has real work, whether or not this host can commit the rewrite.
        assertTrue(back.optJSONArray("driving_events").optJSONObject(0)
            .optBoolean("emergency_workflow_pending", false));
    }

    /** 1 + 2. One action spends only its budget, and reports the remainder across it. */
    @Test public void oneActionProcessesOnlyItsBudgetAndReportsTheRemainder() throws Exception {
        seedPendingWorkflows();

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertTrue("the action must do real work", outcome.changed);
        assertTrue("it must report the continuation", outcome.hasMore);
        assertTrue(outcome.needsContinuation());
        // 5. False completion is impossible while work remains.
        assertFalse("a turn with work left may never report completion", outcome.complete());
        assertTrue("no whole-backlog enumeration", outcome.acknowledged <= 16);
        assertTrue("it must make progress", outcome.acknowledged > 0);
    }

    /**
     * 3. Unresolved work is durably recorded.
     *
     * The MARKER, not the cursor: a turn whose write failed keeps the cursor it started
     * with — null at the head of the ordering — so the cursor alone cannot distinguish
     * "start from the beginning" from "nothing pending".
     */
    @Test public void theContinuationIsPersistedAcrossTheProcessBoundary() throws Exception {
        seedPendingWorkflows();
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertTrue("work remains", outcome.needsContinuation());
        assertTrue("and a restart must be able to find it",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
        assertTrue("which this turn recorded durably", outcome.continuationDurable);
    }

    /**
     * 4. Later entries are genuinely reached.
     *
     * Driven at the PAGING layer, which is where the defect lived and which needs no
     * journal rewrite: the old code re-read the same capped prefix on every turn, so
     * entries past the first page were unreachable however often the driver tapped OK.
     */
    @Test public void laterEntriesBecomeReachableAcrossBoundedTurns() throws Exception {
        seedPendingWorkflows();

        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        java.util.List<String> cursors = new java.util.ArrayList<>();
        String cursor = null;
        int guard = 0;
        while (true) {
            DriveSenseCompletedTripJournal.PendingPage page =
                DriveSenseCompletedTripJournal.pendingTripIdsPage(context, 16, cursor);
            for (String tripId : page.tripIds) seen.add(tripId);
            if (page.nextCursor != null) {
                assertFalse("a continuation must advance, never repeat", cursors.contains(page.nextCursor));
                cursors.add(page.nextCursor);
            }
            cursor = page.nextCursor;
            guard += 1;
            // 6. No infinite tight loop.
            assertTrue("bounded turns must converge", guard < 12);
            if (!page.hasMore || page.tripIds.isEmpty() || cursor == null) break;
        }

        assertTrue("the queue must take more than one page", guard > 1);
        assertEquals("every pending entry must be reached", PENDING_WORKFLOWS, seen.size());
    }

    /** A second page resumes rather than re-walking the prefix the first one visited. */
    @Test public void aSecondActionResumesInsteadOfRepeatingTheSamePage() throws Exception {
        seedPendingWorkflows();
        DriveSenseCompletedTripJournal.PendingPage first =
            DriveSenseCompletedTripJournal.pendingTripIdsPage(context, 16, null);
        assertTrue("the first page must leave work", first.hasMore);
        assertNotNull(first.nextCursor);

        DriveSenseCompletedTripJournal.PendingPage second =
            DriveSenseCompletedTripJournal.pendingTripIdsPage(context, 16, first.nextCursor);

        assertFalse("the second page must not be empty of new work", second.tripIds.isEmpty());
        for (String tripId : second.tripIds) {
            assertFalse("it must not re-read the first page", first.tripIds.contains(tripId));
        }
    }

    /**
     * A turn that could not save must REVISIT the rows it failed on, so it keeps the
     * cursor it started with instead of advancing past unsaved work.
     */
    @Test public void afailedTurnRetainsItsResumePointInsteadOfAdvancing() throws Exception {
        seedPendingWorkflows();
        DriveSenseNativeTripStore.EmergencyAckOutcome first =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);
        assertFalse("this host cannot commit the rewrite", first.saved);
        String afterFirst = DriveSenseNativeTripStore.pendingEmergencyAckCursor(context);

        DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);
        String afterSecond = DriveSenseNativeTripStore.pendingEmergencyAckCursor(context);

        // Identical, including both being null at the head of the ordering: unsaved rows
        // are retried, not skipped.
        assertEquals(afterFirst, afterSecond);
        assertTrue("and the work stays recorded",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** 6. Zero remaining still behaves normally - no continuation, no false alarm. */
    @Test public void anEmptyQueueCompletesWithoutAContinuation() {
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertFalse("nothing to acknowledge", outcome.changed);
        assertFalse("nothing outstanding", outcome.hasMore);
        assertTrue("an empty queue is complete", outcome.complete());
        assertFalse(outcome.needsContinuation());
        assertNull(DriveSenseNativeTripStore.pendingEmergencyAckCursor(context));
    }

    // ─── AUD-005 failure semantics ────────────────────────────────────────────────────

    /**
     * A context whose preferences refuse to persist. `commit()` returning false and
     * `commit()` throwing are both real Android behaviours, and both used to be swallowed
     * into apparent success.
     */
    private static final class FailingPrefsContext extends android.content.ContextWrapper {
        private final android.content.SharedPreferences delegate;
        private final boolean throwOnCommit;

        FailingPrefsContext(Context base, boolean throwOnCommit) {
            super(base);
            this.delegate = base.getSharedPreferences("drivesense_native_prefs_failing", MODE_PRIVATE);
            this.throwOnCommit = throwOnCommit;
        }

        @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) {
            final android.content.SharedPreferences real = delegate;
            return (android.content.SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(
                android.content.SharedPreferences.class.getClassLoader(),
                new Class<?>[]{ android.content.SharedPreferences.class },
                (proxy, method, args) -> {
                    if (!"edit".equals(method.getName())) return method.invoke(real, args);
                    final android.content.SharedPreferences.Editor realEditor = real.edit();
                    return java.lang.reflect.Proxy.newProxyInstance(
                        android.content.SharedPreferences.Editor.class.getClassLoader(),
                        new Class<?>[]{ android.content.SharedPreferences.Editor.class },
                        (editorProxy, editorMethod, editorArgs) -> {
                            if ("commit".equals(editorMethod.getName())) {
                                if (throwOnCommit) throw new IllegalStateException("preferences unavailable");
                                return Boolean.FALSE;
                            }
                            if ("apply".equals(editorMethod.getName())) return null;
                            Object result = editorMethod.invoke(realEditor, editorArgs);
                            return result == realEditor ? editorProxy : result;
                        });
                });
        }
    }

    /** 1. The final row changes in memory and then fails to save. */
    @Test public void afailedFinalRewriteIsNotCompletion() throws Exception {
        // This host cannot rename over an existing file, so the journal rewrite that
        // persists an acknowledgement fails here - which is exactly the production failure
        // this case is about, reproduced without having to inject anything.
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, pendingWorkflowTrip(0)));

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertTrue("the row did change in memory", outcome.changed);
        assertFalse("but it did not persist", outcome.saved);
        assertFalse("paging is exhausted", outcome.hasMore);
        // The defect: `hasMore == false` used to read as finished.
        assertFalse("unsaved work is not complete", outcome.complete());
        assertTrue("and it must be retried", outcome.needsContinuation());

        DriveSenseNativeTripStore.EmergencyAckDisposition disposition =
            DriveSenseNativeTripStore.dispositionFor(outcome);
        assertFalse("no completion may be emitted", disposition.reportComplete);
        assertTrue("a continuation must be scheduled", disposition.scheduleContinuation);
        assertFalse("the completion diagnostic may not be used",
            "notification_ok_complete".equals(disposition.reason));
        // 6. The work survives a restart.
        assertTrue("unresolved work must remain recorded",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** 2. `commit()` returns false: the continuation is not durable and is not claimed. */
    @Test public void afailedCursorCommitIsNotADurableContinuation() throws Exception {
        seedPendingWorkflows();
        Context failing = new FailingPrefsContext(context, false);

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(failing, ACKNOWLEDGED_AT);

        assertTrue("work remains", outcome.needsContinuation());
        assertFalse("a continuation that did not commit is not durable", outcome.continuationDurable);
        assertFalse("and completion is impossible", outcome.complete());

        DriveSenseNativeTripStore.EmergencyAckDisposition disposition =
            DriveSenseNativeTripStore.dispositionFor(outcome);
        assertFalse(disposition.reportComplete);
        assertTrue("the caller must be told only this process knows", disposition.continuationAtRisk);
        assertTrue("and it must still schedule a retry", disposition.scheduleContinuation);
    }

    /** 3. `commit()` throws: the same fail-safe result, never apparent success. */
    @Test public void athrowingCursorCommitIsNotADurableContinuation() throws Exception {
        seedPendingWorkflows();
        Context failing = new FailingPrefsContext(context, true);

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(failing, ACKNOWLEDGED_AT);

        assertFalse("a thrown commit is not a durable continuation", outcome.continuationDurable);
        assertFalse(outcome.complete());
        assertTrue(DriveSenseNativeTripStore.dispositionFor(outcome).scheduleContinuation);
        assertTrue(DriveSenseNativeTripStore.dispositionFor(outcome).continuationAtRisk);
    }

    /**
     * 4. A successful final acknowledgement still completes normally.
     *
     * The outcome is constructed rather than produced by a journal rewrite, because this
     * host cannot commit one (see the recorded platform limit above). What is under test
     * is the CALLER's contract - that completion follows `complete()` - and that is
     * exercised exactly.
     */
    @Test public void asuccessfulFinalAcknowledgementStillCompletes() {
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            new DriveSenseNativeTripStore.EmergencyAckOutcome(true, true, false, null, 1, true);

        assertTrue(outcome.complete());
        assertFalse(outcome.needsContinuation());

        DriveSenseNativeTripStore.EmergencyAckDisposition disposition =
            DriveSenseNativeTripStore.dispositionFor(outcome);
        assertTrue("a saved, exhausted queue completes", disposition.reportComplete);
        assertFalse("and schedules nothing", disposition.scheduleContinuation);
        assertFalse(disposition.continuationAtRisk);
        assertEquals("notification_ok_complete", disposition.reason);
    }

    /** 5. A successful non-terminal turn schedules, and does not complete. */
    @Test public void asuccessfulNonTerminalTurnSchedulesWithoutCompleting() {
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            new DriveSenseNativeTripStore.EmergencyAckOutcome(true, true, true, "1|entry", 16, true);

        assertFalse(outcome.complete());
        assertTrue(outcome.needsContinuation());

        DriveSenseNativeTripStore.EmergencyAckDisposition disposition =
            DriveSenseNativeTripStore.dispositionFor(outcome);
        assertFalse(disposition.reportComplete);
        assertTrue(disposition.scheduleContinuation);
        assertFalse("a committed continuation is not at risk", disposition.continuationAtRisk);
        assertEquals("notification_ok_continuation", disposition.reason);
    }

    /** A missing outcome may never be read as success. */
    @Test public void anAbsentOutcomeIsNeverCompletion() {
        DriveSenseNativeTripStore.EmergencyAckDisposition disposition =
            DriveSenseNativeTripStore.dispositionFor(null);
        assertFalse(disposition.reportComplete);
        assertTrue(disposition.scheduleContinuation);
        assertTrue(disposition.continuationAtRisk);
    }

    /** 6. A completed queue leaves nothing for a restart to resume. */
    @Test public void acompletedQueueLeavesNothingToResume() {
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertTrue(outcome.complete());
        assertFalse(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    // ─── AUD-005 restart discovery ────────────────────────────────────────────────────

    /** Wipe every preference a restart could read, exactly as a fresh install-state would. */
    private void simulateProcessRestart() {
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        assertNull("a restart must see no cursor",
            DriveSenseNativeTripStore.pendingEmergencyAckCursor(context));
        assertFalse("and no pending marker",
            DriveSenseNativeTripStore.prefs(context)
                .getBoolean(DriveSenseNativeTripStore.KEY_EMERGENCY_ACK_PENDING, false));
    }

    /**
     * THE RESTART DISCRIMINATOR — `commit()` returns false, then the process dies.
     *
     * The failure that puts the continuation at risk is the same failure that erases the
     * only record that work existed. Discovery therefore may not depend on it: the durable
     * journal still says `emergency_workflow_pending:true`, and startup has to find that
     * on its own.
     */
    @Test public void afailedPreferenceCommitFollowedByProcessDeathStillRecovers() throws Exception {
        seedPendingWorkflows();
        Context failing = new FailingPrefsContext(context, false);

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(failing, ACKNOWLEDGED_AT);
        // 3. This process knows the continuation is only in memory.
        assertFalse(outcome.continuationDurable);
        assertTrue(DriveSenseNativeTripStore.dispositionFor(outcome).continuationAtRisk);
        // 4. The scheduled volatile retry is never executed - the process dies instead.

        simulateProcessRestart();

        // 7 + 8. Startup discovers the work WITHOUT the preference hint.
        assertTrue("the durable journal must still say there is emergency work",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_PENDING,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));

        // 9. Bounded recovery from a safe beginning can reach the pending rows.
        DriveSenseNativeTripStore.EmergencyAckOutcome recovery =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);
        assertTrue("recovery must reach real work", recovery.changed);
        // 10. And it still may not claim completion, because the rewrite did not persist.
        assertFalse(recovery.complete());
        assertFalse(DriveSenseNativeTripStore.dispositionFor(recovery).reportComplete);
    }

    /** The same, with `commit()` throwing rather than returning false. */
    @Test public void athrowingPreferenceCommitFollowedByProcessDeathStillRecovers() throws Exception {
        seedPendingWorkflows();
        Context failing = new FailingPrefsContext(context, true);

        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(failing, ACKNOWLEDGED_AT);
        assertFalse(outcome.continuationDurable);

        simulateProcessRestart();

        assertTrue("a thrown commit must not erase the work either",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
        DriveSenseNativeTripStore.EmergencyAckOutcome recovery =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);
        assertTrue(recovery.changed);
        assertFalse(recovery.complete());
    }

    /** CONTROL: a journal with no emergency workflow creates no phantom retry. */
    @Test public void agenuinelyQuietJournalSchedulesNothingAtStartup() throws Exception {
        JSONObject ordinary = pendingWorkflowTrip(0);
        ordinary.put("driving_events", new JSONArray());
        ordinary.remove("emergency_workflow_pending");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, ordinary));

        simulateProcessRestart();

        assertEquals("the journal must answer authoritatively",
            DriveSenseJournalControlPlane.EMERGENCY_NONE,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
        assertFalse("and startup must do nothing",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CONTROL: an empty journal is not unresolved work. */
    @Test public void anEmptyJournalSchedulesNothingAtStartup() {
        simulateProcessRestart();
        assertFalse(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CONTROL: a valid durable hint still takes the fast path, without a journal read. */
    @Test public void avalidDurableHintStillResumesDirectly() throws Exception {
        seedPendingWorkflows();
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);

        assertTrue("this turn recorded its continuation", outcome.continuationDurable);
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckHint(context));
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CONTROL: discovery is ONE indexed lookup, never proportional to history. */
    @Test public void discoveryIsBoundedRegardlessOfJournalSize() throws Exception {
        for (int index = 0; index < 40; index += 1) {
            JSONObject ordinary = pendingWorkflowTrip(index);
            ordinary.put("driving_events", new JSONArray());
            ordinary.put("id", "quiet-" + index);
            assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, ordinary));
        }
        simulateProcessRestart();

        long start = System.nanoTime();
        int state = DriveSenseJournalControlPlane.emergencyWorkflowState(context);
        long elapsedMs = (System.nanoTime() - start) / 1_000_000L;

        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_NONE, state);
        // Not a performance assertion so much as a shape one: a scan of forty encrypted
        // entries could not finish in this budget, an indexed LIMIT 1 always does.
        assertTrue("discovery must not read the journal itself, it took " + elapsedMs + "ms",
            elapsedMs < 750L);
    }

    /** CONTROL: an unreadable/unknown answer retains rather than declaring completion. */
    @Test public void anUnknownDiscoveryAnswerRetains() throws Exception {
        seedPendingWorkflows();
        simulateProcessRestart();
        // A dirty index cannot answer authoritatively.
        DriveSenseJournalControlPlane.markDirty(context, "UNKNOWN");

        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_UNKNOWN,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
        assertTrue("unknown must retain, never complete",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    // ─── AUD-005 startup discovery truth table ────────────────────────────────────────
    //
    // The previous suite's UNKNOWN case hit the dirty-index path, which is why it stayed
    // green while the disabled-control-plane + unreadable-manifest path silently turned
    // UNKNOWN into NONE. Every unresolved class now has its own row.

    private static DriveSenseNativeTripStore.DiscoveryEvidence evidence() {
        return new DriveSenseNativeTripStore.DiscoveryEvidence();
    }

    private static int classify(DriveSenseNativeTripStore.DiscoveryEvidence evidence) {
        return DriveSenseNativeTripStore.classifyEmergencyDiscovery(
            evidence, DriveSenseJournalControlPlane.EMERGENCY_UNKNOWN);
    }

    /** Turn the control plane off so startup must fall back to the bounded page. */
    private void disableControlPlane() throws Exception {
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            helper.getWritableDatabase().execSQL("UPDATE p5_control_state SET writers_enabled=0 WHERE id=1");
        }
        assertFalse("the control plane must be disabled for this case",
            DriveSenseJournalControlPlane.enabled(context));
        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_UNKNOWN,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
    }

    /** Corrupt the manifest so the entry is preserved-but-unreadable. */
    private void makeEveryManifestUnreadable() throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1");
        File[] files = directory.listFiles();
        assertNotNull("the journal directory must exist", files);
        int corrupted = 0;
        for (File file : files) {
            if (!file.getName().endsWith(".manifest.enc")) continue;
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
                out.write("not a readable manifest".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            corrupted += 1;
        }
        assertTrue("at least one manifest must have been corrupted", corrupted > 0);
    }

    /**
     * CASE 1 — THE DISCRIMINATOR. Disabled control plane over an unreadable manifest.
     *
     * The page is truthfully `tripIds=[]`, `unreadableTripIds=[x]`, `hasMore=true`. Reading
     * only `tripIds.isEmpty()` called that "no work" and startup scheduled nothing, while
     * the journal still held the entry.
     */
    @Test public void adisabledPlaneOverAnUnreadableManifestIsNeverNone() throws Exception {
        seedPendingWorkflows();
        makeEveryManifestUnreadable();
        disableControlPlane();
        simulateProcessRestart();

        DriveSenseCompletedTripJournal.PendingPage page =
            DriveSenseCompletedTripJournal.pendingTripIdsPage(context, 1, null);
        // The evidence really is the shape CODEX described.
        assertTrue("no readable ids", page.tripIds.isEmpty());
        assertFalse("but preserved unreadable work", page.unreadableTripIds.isEmpty());

        assertEquals("unresolved evidence may never classify as NONE",
            DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN,
            DriveSenseNativeTripStore.classifyStartupEmergencyDiscovery(context));
        assertTrue("and startup must retain",
            DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 2 — unreadable-only queue. */
    @Test public void aunreadableOnlyEvidenceRetains() {
        DriveSenseNativeTripStore.DiscoveryEvidence unreadable = evidence();
        unreadable.unreadable = true;
        unreadable.preservedUnreadableCount = 1L;
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(unreadable));
    }

    /** CASE 3 — oversized-only queue. */
    @Test public void aoversizedOnlyEvidenceRetains() {
        DriveSenseNativeTripStore.DiscoveryEvidence oversized = evidence();
        oversized.oversized = true;
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(oversized));
    }

    /** CASE 4 — a typed blocked result. */
    @Test public void ablockedEvidenceRetains() {
        DriveSenseNativeTripStore.DiscoveryEvidence blocked = evidence();
        blocked.blocked = true;
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(blocked));
    }

    /** CASE 5 — `hasMore` with zero readable ids is not an empty journal. */
    @Test public void ahasMoreWithNoReadableIdsIsNotNone() {
        DriveSenseNativeTripStore.DiscoveryEvidence more = evidence();
        more.hasMore = true;
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(more));
    }

    /** CASE 6 — the bounded page could not be acquired at all. */
    @Test public void aafailedAcquisitionRetains() {
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN,
            classify(DriveSenseNativeTripStore.DiscoveryEvidence.failedAcquisition()));
        // A null page is the same statement.
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN,
            classify(DriveSenseNativeTripStore.DiscoveryEvidence.fromPendingPage(null)));
    }

    /** CASE 6b — a queue that cannot describe its own state. */
    @Test public void anUnresolvedQueueStatusRetains() {
        DriveSenseNativeTripStore.DiscoveryEvidence unresolved = evidence();
        unresolved.queueStatusUnresolved = true;
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(unresolved));
    }

    /** CASE 7 — a dirty / non-VERIFIED index. */
    @Test public void adirtyIndexRetains() throws Exception {
        seedPendingWorkflows();
        simulateProcessRestart();
        DriveSenseJournalControlPlane.markDirty(context, "UNKNOWN");

        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_UNKNOWN,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 8 — a genuinely empty fallback journal earns NONE, and retries nothing. */
    @Test public void agenuinelyEmptyFallbackJournalIsNone() throws Exception {
        disableControlPlane();
        simulateProcessRestart();

        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_NONE,
            DriveSenseNativeTripStore.classifyStartupEmergencyDiscovery(context));
        assertFalse(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 9 — readable pending entries classify as PENDING. */
    @Test public void areadablePendingEvidenceIsPending() throws Exception {
        seedPendingWorkflows();
        disableControlPlane();
        simulateProcessRestart();

        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_PENDING,
            DriveSenseNativeTripStore.classifyStartupEmergencyDiscovery(context));
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 10 — readable entries with no emergency work, authority says none. */
    @Test public void anAuthoritativeNoneIsNone() throws Exception {
        JSONObject ordinary = pendingWorkflowTrip(0);
        ordinary.put("driving_events", new JSONArray());
        ordinary.remove("emergency_workflow_pending");
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, ordinary));
        simulateProcessRestart();

        assertEquals(DriveSenseJournalControlPlane.EMERGENCY_NONE,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_NONE,
            DriveSenseNativeTripStore.classifyStartupEmergencyDiscovery(context));
        assertFalse(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 11 — a legacy UNKNOWN index row must not become NONE just for being legacy. */
    @Test public void alegacyUnknownIndexRowIsNotNone() throws Exception {
        JSONObject ordinary = pendingWorkflowTrip(0);
        ordinary.put("driving_events", new JSONArray());
        assertTrue(DriveSenseCompletedTripJournal.addCompletedTrip(context, ordinary));
        // Exactly what a row indexed before the column existed looks like.
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            helper.getWritableDatabase().execSQL("UPDATE journal_manifest_index SET emergency_pending=-1");
        }
        simulateProcessRestart();

        assertEquals("a legacy row is unknown, not none",
            DriveSenseJournalControlPlane.EMERGENCY_UNKNOWN,
            DriveSenseJournalControlPlane.emergencyWorkflowState(context));
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** CASE 12 — a valid preference hint still short-circuits the fallback. */
    @Test public void avalidHintStillShortCircuitsDiscovery() throws Exception {
        seedPendingWorkflows();
        DriveSenseNativeTripStore.EmergencyAckOutcome outcome =
            DriveSenseNativeTripStore.acknowledgePendingEmergencyWorkflow(context, ACKNOWLEDGED_AT);
        assertTrue(outcome.continuationDurable);

        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckHint(context));
        assertTrue(DriveSenseNativeTripStore.hasPendingEmergencyAckWork(context));
    }

    /** The principle, stated as a test: an empty readable page is not an empty journal. */
    @Test public void anEmptyReadablePageIsNotTheSameStatementAsNoWork() {
        DriveSenseNativeTripStore.DiscoveryEvidence emptyButUnresolved = evidence();
        emptyButUnresolved.readablePending = false;
        emptyButUnresolved.unreadable = true;
        emptyButUnresolved.hasMore = true;

        DriveSenseNativeTripStore.DiscoveryEvidence emptyAndSettled = evidence();

        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_UNKNOWN, classify(emptyButUnresolved));
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_NONE, classify(emptyAndSettled));
    }

    /** An authoritative PENDING outranks any page evidence. */
    @Test public void anAuthoritativePendingWins() {
        assertEquals(DriveSenseNativeTripStore.EMERGENCY_DISCOVERY_PENDING,
            DriveSenseNativeTripStore.classifyEmergencyDiscovery(
                evidence(), DriveSenseJournalControlPlane.EMERGENCY_PENDING));
    }
}
