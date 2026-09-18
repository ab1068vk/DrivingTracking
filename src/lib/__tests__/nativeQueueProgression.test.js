/**
 * AUD-005 — the two mechanisms CODEX's R3 reclosure left open.
 *
 * Java is compile-only in this audit, so these are structural regressions over the native
 * source, in the same style as the existing AUD-005 suites. They pin the two properties
 * that were false, not the shape of any particular implementation:
 *
 *   A. FALLBACK UNREADABLE TRUTH AT EOF. `pendingTripIdsPage()`'s fallback branch saw
 *      `manifest == null`, stepped past it and forgot it. At end of directory it could
 *      therefore report zero trips, zero unreadables and `hasMore:false` while a preserved
 *      unreadable manifest was still sitting there — a queue that is deliberately holding
 *      work describing itself as cleanly drained.
 *
 *   B. EMERGENCY PAGING PROGRESSION. `acknowledgePendingEmergencyWorkflow()` asked
 *      `oldest()` for the same capped first rows on every turn: nothing was mutated until
 *      after the gathering loop, and no cursor was supplied. Later pending crash workflows
 *      were unreachable while the call reported success.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const NATIVE = resolve(process.cwd(), 'android/app/src/main/java/com/drivesense/app');
const read = (name) => readFileSync(resolve(NATIVE, name), 'utf8');

const bodyOf = (source, from, until) => {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(until, start + from.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('AUD-005 A — fallback unreadable truth survives to EOF', () => {
  const journal = read('DriveSenseCompletedTripJournal.java');

  it('carries unresolved truth on the page itself', () => {
    // The page is the only thing the caller sees, so the fact has to live on it.
    expect(journal).toMatch(/final\s+List<String>\s+unreadableTripIds\s*;/);
    const constructor = bodyOf(journal, 'static final class PendingPage', '}\n\n');
    expect(constructor).toMatch(/unreadableTripIds/);
  });

  it('records an unreadable manifest instead of only stepping past it', () => {
    const body = bodyOf(journal, 'static PendingPage pendingTripIdsPage', 'private static final int MAX_FALLBACK_SCAN_ENTRIES');
    // The scan must still ADVANCE past it — that gain is preserved — but the name is kept.
    expect(body).toMatch(/if \(manifest == null\) \{[\s\S]{0,400}?unreadable[\s\S]{0,200}?return true;/);
    // A manifest with no trip id is equally unresolved and was also being dropped.
    expect(body).toMatch(/tripId\.isEmpty\(\)[\s\S]{0,300}?unreadable/);
  });

  it('never reports a page as drained while it is holding unreadable work', () => {
    const body = bodyOf(journal, 'static PendingPage pendingTripIdsPage', 'private static final int MAX_FALLBACK_SCAN_ENTRIES');
    // EOF with unreadable names is not "no more work": the FALLBACK return must carry
    // them, not merely a comment further up promising that it does.
    expect(body).toMatch(/return new PendingPage\(page, more\[0\] \|\| !reachedEnd, unreadableTripIds/);
  });

  it('folds the page unreadables into the plugin verdict', () => {
    const body = bodyOf(journal, 'static JSONObject getCompletedTripPage', 'A bounded page of pending trip ids');
    expect(body).toMatch(/page\.unreadableTripIds/);
    // And into the truth the JS side reads: not acknowledged, not forgotten, not drained.
    expect(body).toMatch(/preservedUnreadable|unreadable\.length\(\)/);
  });
});

describe('AUD-005 B — emergency acknowledgement makes bounded progress', () => {
  const store = read('DriveSenseNativeTripStore.java');
  const control = read('DriveSenseJournalControlPlane.java');
  const journal = read('DriveSenseCompletedTripJournal.java');
  const service = read('DriveSenseAutoTrackingService.java');

  it('gives the index query a keyset continuation', () => {
    const body = bodyOf(control, 'static JSONArray oldest(', '/** Explicit, fixed-memory');
    // A keyset predicate over the SAME ordering the page uses, so pages cannot repeat.
    expect(body).toMatch(/created_at_ms\s*>\s*\?/);
    expect(body).toMatch(/entry_key\s*>\s*\?/);
  });

  it('threads a cursor through the bounded page', () => {
    expect(journal).toMatch(/static PendingPage pendingTripIdsPage\(Context context, int maxItems, String cursor\)/);
    expect(journal).toMatch(/final\s+String\s+nextCursor\s*;/);
  });

  it('advances the cursor between acknowledgement turns', () => {
    const body = bodyOf(store, 'static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow', '\n    static ');
    expect(body).toMatch(/pendingTripIdsPage\(context, budget, cursor\)/);
    expect(body).toMatch(/cursor\s*=\s*page\.nextCursor/);
    // A turn that cannot continue must stop rather than re-read the same page forever.
    expect(body).toMatch(/page\.nextCursor == null/);
  });

  it('returns a typed outcome rather than hiding continuation in a boolean', () => {
    expect(store).toMatch(/static final class EmergencyAckOutcome/);
    expect(store).toMatch(/final boolean hasMore;/);
    expect(store).toMatch(/final String nextCursor;/);
    // `complete()` is what a caller may claim success on, and it cannot be true while
    // work remains.
    expect(store).toMatch(/boolean complete\(\) \{\s*return saved && !hasMore;/);
    // AUD-005: unsaved is unresolved. Reading paging alone let a failed final write pass
    // for a finished queue.
    expect(store).toMatch(/boolean needsContinuation\(\) \{\s*return hasMore \|\| !saved;/);
    expect(store).toMatch(/final boolean continuationDurable;/);
    // Persistence failure must be reported, not swallowed.
    expect(store).toMatch(/boolean committed = editor\.commit\(\);/);
    expect(store).toMatch(/return committed;/);
    expect(store).toMatch(/static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow/);
  });

  it('persists the continuation durably, not only in the return value', () => {
    const body = bodyOf(store, 'static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow', 'static void clearCompletedTrips');
    expect(body).toMatch(/pendingEmergencyAckCursor\(context\)/);
    expect(body).toMatch(/writeEmergencyAckContinuation\(context, continuation, unresolved\)/);
    // AUD-005: an unsaved turn keeps the resume point it started with, so the rows it
    // failed on are revisited rather than skipped.
    expect(body).toMatch(/!saved[\s\S]{0,20}\? startCursor/);
    // Unknown is RETAIN: a turn that cannot enumerate must not clear the continuation or
    // report success.
    expect(body).toMatch(/return new EmergencyAckOutcome\(false, false, true,/);
  });

  it('acts on the continuation at the real caller boundary', () => {
    const body = bodyOf(service, 'private void acknowledgePossibleIncidentFromNotification', 'private void scheduleEmergencyAckContinuation');
    // The caller must consume the outcome through the single disposition, not a boolean
    // and not `hasMore` alone.
    expect(body).toMatch(/EmergencyAckOutcome outcome =/);
    expect(body).toMatch(/EmergencyAckDisposition disposition =[\s\S]{0,80}dispositionFor\(outcome\)/);
    expect(body).toMatch(/if \(disposition\.scheduleContinuation\) scheduleEmergencyAckContinuation\(/);
    // Completion is predicated on the full contract, never on paging alone.
    expect(body).toMatch(/disposition\.reportComplete/);
    expect(body).not.toMatch(/outcome\.hasMore/);
    expect(body).toMatch(/could not be recorded for later/);
    expect(body).toMatch(/finishing earlier check-ins/);
  });

  it('bounds the follow-up chain and falls back to the durable cursor', () => {
    const body = bodyOf(service, 'private void scheduleEmergencyAckContinuation', 'private void resumeEmergencyAckContinuationIfPending');
    expect(body).toMatch(/if \(turnsLeft <= 0\)/);
    expect(body).toMatch(/postDelayed\(/);
    expect(body).toMatch(/turnsLeft - 1/);
    // The follow-up path takes the SAME contract: a turn that could not save is not a
    // finished turn, however empty the paging looks.
    expect(body).toMatch(/EmergencyAckDisposition disposition =[\s\S]{0,80}dispositionFor\(next\)/);
    expect(body).toMatch(/if \(disposition\.scheduleContinuation\)/);
    expect(body).not.toMatch(/next\.needsContinuation\(\)/);
    // The completion reason comes from the disposition, so it cannot be hard-coded.
    expect(body).toMatch(/disposition\.reason/);
    expect(body).toMatch(/notification_ok_deferred/);
  });

  it('resumes a stored continuation when the process restarts', () => {
    expect(service).toMatch(/resumeEmergencyAckContinuationIfPending\(\);/);
    const body = bodyOf(service, 'private void resumeEmergencyAckContinuationIfPending', 'private static boolean acknowledgeIncidentEvents');
    // The MARKER, not the cursor: a failed write at the head leaves work with no cursor.
    expect(body).toMatch(/hasPendingEmergencyAckWork\(this\)/);
    expect(body).toMatch(/scheduleEmergencyAckContinuation\(/);
  });

  it('keeps the action budget bounded and reports what is left', () => {
    const body = bodyOf(store, 'static EmergencyAckOutcome acknowledgePendingEmergencyWorkflow', '\n    static ');
    expect(body).toMatch(/MAX_EMERGENCY_ACK_TRIPS/);
    expect(body).toMatch(/MAX_EMERGENCY_ACK_TURNS/);
    expect(body).toMatch(/remaining/);
    // No whole-backlog enumeration may return.
    expect(body).not.toMatch(/listCompletedTripIds\(|getAllCompletedTrips\(/);
  });
});

describe('AUD-005 C — restart discovery does not depend on the preference write', () => {
  const store = read('DriveSenseNativeTripStore.java');
  const control = read('DriveSenseJournalControlPlane.java');
  const journal = read('DriveSenseCompletedTripJournal.java');
  const schema = read('DriveSenseArchiveOpenHelper.java');
  const inspector = read('DriveSenseTripStreamInspector.java');
  const service = read('DriveSenseAutoTrackingService.java');

  it('derives the flag from the trip bytes being written, not from a second store', () => {
    // One streaming pass, no materialisation, and the acknowledgement rewrite re-derives
    // it — so the journal and the index cannot drift apart.
    expect(inspector).toMatch(/final boolean emergencyPending;/);
    expect(inspector).toMatch(/scanDrivingEventsForEmergency\(reader, emergencyPending\)/);
    expect(inspector).toMatch(/emergency_workflow_pending/);
    expect(journal).toMatch(/manifest\.put\("emergency_pending", inspected\.emergencyPending \? 1 : 0\)/);
  });

  it('indexes it durably, with UNKNOWN for rows that predate the column', () => {
    expect(schema).toMatch(/addColumnIfMissing\(db,"journal_manifest_index","emergency_pending","INTEGER NOT NULL DEFAULT -1"\)/);
    expect(schema).toMatch(/CREATE INDEX IF NOT EXISTS journal_manifest_emergency_idx/);
    expect(control).toMatch(/row\.put\("emergency_pending", manifest\.has\("emergency_pending"\)/);
  });

  it('answers the authoritative question boundedly and in three states', () => {
    expect(control).toMatch(/static final int EMERGENCY_NONE = 0;/);
    expect(control).toMatch(/static final int EMERGENCY_PENDING = 1;/);
    expect(control).toMatch(/static final int EMERGENCY_UNKNOWN = -1;/);
    const body = bodyOf(control, 'static int emergencyWorkflowState(Context context)', '/** Explicit, fixed-memory');
    // One indexed row. No scan, no listing, nothing history-proportional.
    expect(body).toMatch(/FROM journal_manifest_index WHERE emergency_pending<>0 LIMIT 1/);
    expect(body).not.toMatch(/DriveSenseDirectoryStream|getAll\(|ORDER BY/);
    // A dirty index cannot answer, and guessing "none" there is the defect.
    expect(body).toMatch(/if \(!state\.moveToFirst\(\) \|\| !"VERIFIED"\.equals\(state\.getString\(0\)\)\) return EMERGENCY_UNKNOWN;/);
    expect(body).toMatch(/return EMERGENCY_UNKNOWN;[\s\S]{0,200}?\}\s*$/);
  });

  it('asks the journal when the preference hint says nothing', () => {
    const decision = bodyOf(store, 'static boolean hasPendingEmergencyAckWork', 'static final class DiscoveryEvidence');
    expect(decision).toMatch(/if \(hasPendingEmergencyAckHint\(context\)\) return true;/);
    // The journal question now lives in the classifier, which this delegates to.
    const classifier = bodyOf(store, 'static int classifyStartupEmergencyDiscovery(', 'private static boolean writeEmergencyAckContinuation');
    expect(classifier).toMatch(/DriveSenseJournalControlPlane\.emergencyWorkflowState\(context\)/);
    // The hint alone may never be the answer.
    expect(decision).not.toMatch(/return hasPendingEmergencyAckHint\(context\);/);
  });

  it('treats unknown as retain, and an empty journal as genuinely nothing', () => {
    const table = bodyOf(store, 'static int classifyEmergencyDiscovery(', 'static int classifyStartupEmergencyDiscovery(');
    // Only an authoritative NONE, or a page with no readable work AND no unresolved
    // evidence, may be NONE.
    expect(table).toMatch(/EMERGENCY_NONE\)[\s\S]{0,60}?return EMERGENCY_DISCOVERY_NONE;/);
    expect(table).toMatch(/if \(evidence\.hasMore\) return EMERGENCY_DISCOVERY_UNKNOWN;[\s\S]{0,40}?return EMERGENCY_DISCOVERY_NONE;/);
  });

  it('is what startup actually calls', () => {
    const body = bodyOf(service, 'private void resumeEmergencyAckContinuationIfPending', 'private static boolean acknowledgeIncidentEvents');
    expect(body).toMatch(/hasPendingEmergencyAckWork\(this\)/);
    expect(body).toMatch(/scheduleEmergencyAckContinuation\(/);
    expect(service).toMatch(/resumeEmergencyAckContinuationIfPending\(\);/);
  });
});

describe('AUD-005 D — startup discovery has ONE interpretation point', () => {
  const store = read('DriveSenseNativeTripStore.java');
  const service = read('DriveSenseAutoTrackingService.java');

  it('classifies into three states rather than a boolean', () => {
    expect(store).toMatch(/static final int EMERGENCY_DISCOVERY_NONE = 0;/);
    expect(store).toMatch(/static final int EMERGENCY_DISCOVERY_PENDING = 1;/);
    expect(store).toMatch(/static final int EMERGENCY_DISCOVERY_UNKNOWN = -1;/);
    expect(store).toMatch(/static int classifyEmergencyDiscovery\(DiscoveryEvidence evidence, int authoritativeState\)/);
    expect(store).toMatch(/static int classifyStartupEmergencyDiscovery\(Context context\)/);
  });

  it('turns every unresolved class into UNKNOWN, never into NONE', () => {
    const body = bodyOf(store, 'static int classifyEmergencyDiscovery(', 'static int classifyStartupEmergencyDiscovery(');
    for (const unresolved of [
      'evidence.acquisitionFailed', 'evidence.blocked', 'evidence.queueStatusUnresolved',
      'evidence.unreadable', 'evidence.oversized', 'evidence.preservedUnreadableCount > 0L',
      'evidence.hasMore',
    ]) {
      expect(body).toContain(unresolved);
    }
    // NONE is EARNED: it is reachable only from an authoritative none, or from a page with
    // no readable work AND no unresolved evidence at all.
    const noneReturns = body.match(/return EMERGENCY_DISCOVERY_NONE;/g) ?? [];
    expect(noneReturns).toHaveLength(2);
  });

  it('never lets an empty readable page alone stand for "no work"', () => {
    const body = bodyOf(store, 'static int classifyEmergencyDiscovery(', 'static int classifyStartupEmergencyDiscovery(');
    // The exact broken rule, in any of its shapes.
    expect(body).not.toMatch(/return\s+evidence\.readablePending\s*\?/);
    expect(body).not.toMatch(/tripIds\.isEmpty\(\)/);
    // Unresolved evidence is checked BEFORE the readable/empty decision.
    const unresolvedAt = body.indexOf('evidence.unreadable');
    const readableAt = body.indexOf('if (evidence.readablePending)');
    expect(unresolvedAt).toBeGreaterThan(-1);
    expect(readableAt).toBeGreaterThan(unresolvedAt);
  });

  it('keeps startup discovery to one bounded page', () => {
    const body = bodyOf(store, 'static int classifyStartupEmergencyDiscovery(', 'private static boolean writeEmergencyAckContinuation');
    expect(body).toMatch(/pendingTripIdsPage\(context, 1, null\)/);
    // No scan, no listing, no decrypt-all, no loop.
    expect(body).not.toMatch(/DriveSenseDirectoryStream|getAllCompletedTrips|while\s*\(|for\s*\(/);
    // An acquisition that cannot answer is UNKNOWN, not "nothing".
    expect(body).toMatch(/DiscoveryEvidence\.failedAcquisition\(\)/);
  });

  it('is the only production answer to the startup question', () => {
    // hasPendingEmergencyAckWork consumes the classification, not raw fields.
    // The METHOD only: the doc comment under it names the raw fields on purpose, to
    // record what the classifier replaced.
    const decision = bodyOf(store, 'static boolean hasPendingEmergencyAckWork', '─── AUD-005 startup discovery');
    expect(decision).toMatch(/classifyStartupEmergencyDiscovery\(context\) != EMERGENCY_DISCOVERY_NONE/);
    expect(decision).not.toMatch(/tripIds|hasMore|unreadableTripIds|emergencyWorkflowState/);

    // And no sibling startup/resume path reinterprets the raw evidence for itself.
    const siblings = [...service.matchAll(/pendingTripIdsPage\(|emergencyWorkflowState\(|unreadableTripIds|oversizedTripIds/g)];
    expect(siblings).toEqual([]);
    expect(service).toMatch(/hasPendingEmergencyAckWork\(this\)/);
    // One call site asks the startup question.
    expect([...service.matchAll(/hasPendingEmergencyAckWork\(/g)]).toHaveLength(1);
  });
});

