package com.drivesense.app;

import android.content.Context;
import android.os.StatFs;
import android.util.AtomicFile;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

final class DriveSenseCompletedTripJournal {
    private static final String TAG = "CompletedTripJournal";
    private static final String DIRECTORY_NAME = "completed_trip_journal_v1";
    private static final String MANIFEST_SUFFIX = ".manifest.enc";
    private static final String CHUNK_SUFFIX = ".chunk.enc";
    private static final String MANIFEST_CONTEXT_PREFIX = "native:completed_trip_manifest:";
    private static final String CHUNK_CONTEXT_PREFIX = "native:completed_trip_chunk:";
    private static final int VERSION = 1;
    // Intake capacity is governed by deterministic free-space admission, not a
    // supported trip-count or ordinary route-size ceiling. The integer bound is
    // only the representation limit of the legacy v1 manifest.
    // AUD-005: Integer.MAX_VALUE is not a bound. At 320 KiB of plaintext per chunk this
    // ceiling still admits far more than any real drive (a 52 MiB capture is ~167 chunks)
    // while refusing a manifest that claims an unbounded read. A manifest over the ceiling
    // is PRESERVED and counted unreadable -- never truncated and never deleted.
    private static final int MAX_CHUNKS_PER_TRIP = 4096;
    private static final int MAX_PLAINTEXT_CHUNK_BYTES = 320 * 1024;
    private static final int MAX_ENCRYPTED_CHUNK_BYTES = 512 * 1024;
    private static final int MAX_MANIFEST_BYTES = 64 * 1024;
    private static final long STORAGE_RESERVE_BYTES = 256L * 1024L * 1024L;
    private static final long ORPHAN_MAX_AGE_MS = 24L * 60L * 60_000L;
    // Package-visible only so the journal-owned P5 registry/bootstrap can share
    // the same critical section. It does not create another journal owner.
    static final Object LOCK = new Object();
    private static final OutputStream NULL_OUTPUT = new OutputStream() {
        @Override public void write(int value) {}
        @Override public void write(byte[] value, int offset, int length) {}
    };

    private static final String KEY_OVERFLOW_COUNT = "completed_trip_journal_overflow_count";
    private static final String KEY_OVERFLOW_AT_MS = "completed_trip_journal_overflow_at_ms";
    private static final String KEY_OVERFLOW_REASON = "completed_trip_journal_overflow_reason";

    private DriveSenseCompletedTripJournal() {}

    /**
     * A refused trip is real data the user drove and will never see, so it must not fail
     * silently. The counter is surfaced through {@link #status(Context)} and cleared once the
     * JS layer drains the queue, letting the app warn instead of losing trips quietly.
     */
    private static void recordOverflow(Context context, String reason) {
        Log.e(TAG, "Completed trip journal is full; trip not queued (" + reason + ")");
        try {
            android.content.SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
            int previous = prefs.getInt(KEY_OVERFLOW_COUNT, 0);
            prefs.edit()
                .putInt(KEY_OVERFLOW_COUNT, previous + 1)
                .putLong(KEY_OVERFLOW_AT_MS, System.currentTimeMillis())
                .putString(KEY_OVERFLOW_REASON, reason)
                .apply();
        } catch (Exception error) {
            Log.w(TAG, "Could not record journal overflow", error);
        }
    }

    /** Called once queued trips are safely handed to the JS store. */
    static void clearOverflowRecord(Context context) {
        try {
            DriveSenseNativeTripStore.prefs(context).edit()
                .remove(KEY_OVERFLOW_COUNT)
                .remove(KEY_OVERFLOW_AT_MS)
                .remove(KEY_OVERFLOW_REASON)
                .apply();
        } catch (Exception error) {
            Log.w(TAG, "Could not clear journal overflow record", error);
        }
    }

    /** AUD-005 round 2: one compatibility turn may materialize at most this many bytes. */
    static final long MAX_PAGE_PLAINTEXT_BYTES = 8L * 1024L * 1024L;

    /**
     * AUD-005 round 2. A bounded page, bounded in ITEMS and in BYTES.
     *
     * Round 1 bounded the item count but still enumerated, read and sorted the entire
     * pending backlog before applying that limit, so a four-item page cost O(all pending
     * trips). And an item bound is not a byte bound: one enormous trip could still be
     * reconstructed whole and handed to Capacitor whole.
     *
     * Acquisition now comes from pendingTripIdsPage(), which uses the durable ordered
     * manifest index when it is available and a bounded directory page when it is not.
     * Each candidate's declared plaintext_bytes is checked against the remaining budget
     * BEFORE the trip is materialized:
     *
     *  - a trip that does not fit the REMAINING budget ends the page and is offered next
     *    turn -- not truncated, not acknowledged;
     *  - a trip too large for a WHOLE budget is reported as a typed oversized refusal,
     *    its journal entry is preserved, and it is never acknowledged;
     *  - a trip that cannot be read is preserved and reported unreadable, as before.
     */
    static JSONObject getCompletedTripPage(Context context, int maxItems) {
        int limit = Math.max(1, maxItems);
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            JSONArray trips = new JSONArray();
            JSONArray oversized = new JSONArray();
            JSONArray unreadable = new JSONArray();
            long budget = MAX_PAGE_PLAINTEXT_BYTES;
            long bytes = 0L;
            boolean hasMore = false;

            JSONObject out = new JSONObject();
            try {
                PendingPage page = pendingTripIdsPage(context, limit);
                hasMore = page.hasMore;
                // AUD-005. What the ACQUISITION could not resolve is part of this page's
                // truth. Without this the fallback branch reached end of directory with
                // zero trips, zero unreadables and hasMore:false while preserved
                // unreadable manifests were still sitting in the directory.
                for (String preserved : page.unreadableTripIds) unreadable.put(preserved);
                for (String tripId : page.tripIds) {
                    if (trips.length() >= limit) { hasMore = true; break; }
                    File directory = directory(context);
                    String stem = stemForTripId(tripId);
                    JSONObject manifest = readManifest(manifestFile(directory, stem), stem);
                    if (manifest == null) { unreadable.put(tripId); continue; }

                    long declared = Math.max(0L, manifest.optLong("plaintext_bytes", 0L));
                    if (declared > MAX_PAGE_PLAINTEXT_BYTES) {
                        oversized.put(tripId);
                        continue;
                    }
                    if (declared > budget) { hasMore = true; break; }

                    JSONObject trip = readTrip(directory, stem, manifest);
                    if (trip == null) { unreadable.put(tripId); continue; }
                    trips.put(trip);
                    budget -= declared;
                    bytes += declared;
                }
                // AUD-005 round 3. Unresolved is unresolved, whatever class it belongs to.
                // An index holding only `readable=0` rows never reaches this page at all,
                // so the page's own counters say nothing about it — the journal summary
                // has to be consulted, or a queue that is deliberately preserving work
                // reports itself drained.
                long preservedUnreadable = 0L;
                try {
                    preservedUnreadable = DriveSenseJournalControlPlane.enabled(context)
                        ? DriveSenseJournalControlPlane.status(context).optLong("unreadableCount", 0L)
                        // The fallback branch has no summary to consult, so the page's own
                        // scan is the only witness there and it must be counted.
                        : page.unreadableTripIds.size();
                } catch (Exception ignored) {
                    // Cannot tell => treat as unresolved rather than as drained.
                    preservedUnreadable = 1L;
                }
                out.put("trips", trips);
                out.put("oversizedTripIds", oversized);
                out.put("unreadableTripIds", unreadable);
                out.put("plaintextBytes", bytes);
                out.put("preservedUnreadableCount", preservedUnreadable);
                out.put("hasMore", hasMore
                    || oversized.length() > 0
                    || unreadable.length() > 0
                    || preservedUnreadable > 0L);
                out.put("maxPageBytes", MAX_PAGE_PLAINTEXT_BYTES);
            } catch (Exception error) {
                Log.e(TAG, "Completed-trip page could not be acquired", error);
                try {
                    out.put("trips", new JSONArray());
                    out.put("oversizedTripIds", new JSONArray());
                    out.put("unreadableTripIds", new JSONArray());
                    out.put("plaintextBytes", 0L);
                    out.put("blocked", true);
                    out.put("hasMore", true);
                } catch (Exception ignored) {
                    Log.w(TAG, "Could not encode blocked completed-trip page", ignored);
                }
            }
            return out;
        }
    }

    /**
     * A bounded page of pending trip ids, what it could NOT resolve, and where to resume.
     *
     * AUD-005. `tripIds` and `hasMore` alone lost the reason a page came back short. The
     * fallback scan saw an unreadable manifest, stepped past it (which is right — being
     * unreadable is a fact about the entry, not a reason to stall) and then forgot it
     * (which is wrong). At end of directory that produced zero trips, zero unreadables and
     * `hasMore:false`: a queue deliberately preserving work, describing itself as cleanly
     * drained. The fact now travels on the page, because the page is all the caller sees.
     */
    static final class PendingPage {
        final List<String> tripIds;
        final boolean hasMore;
        /** Entries seen but not resolvable to pending work. Preserved, never acknowledged. */
        final List<String> unreadableTripIds;
        /** Resume point for the NEXT page, or null when there is nothing to resume from. */
        final String nextCursor;
        PendingPage(List<String> tripIds, boolean hasMore, List<String> unreadableTripIds, String nextCursor) {
            this.tripIds = tripIds;
            this.hasMore = hasMore;
            this.unreadableTripIds = unreadableTripIds == null ? new ArrayList<>() : unreadableTripIds;
            this.nextCursor = nextCursor;
        }
    }

    /**
     * Bounded acquisition. The durable ordered manifest index answers with a SQL LIMIT,
     * so a four-item page costs four rows regardless of backlog. Without that index a
     * bounded DIRECTORY page is taken instead: the stream stops as soon as it has enough
     * names, so neither the listing nor the manifest set is materialized whole.
     */
    static PendingPage pendingTripIdsPage(Context context, int maxItems) throws Exception {
        return pendingTripIdsPage(context, maxItems, null);
    }

    /**
     * @param cursor resume point from a previous page's {@code nextCursor}, or null to
     *               start at the beginning of the ordering (the fallback branch then uses
     *               its own durable watermark instead, so lifecycle turns still advance).
     */
    static PendingPage pendingTripIdsPage(Context context, int maxItems, String cursor) throws Exception {
        int limit = Math.max(1, maxItems);
        List<String> unreadableTripIds = new ArrayList<>();
        if (DriveSenseJournalControlPlane.enabled(context)) {
            JSONObject indexPage = DriveSenseJournalControlPlane.oldestPage(context, limit + 1, cursor);
            JSONArray rows = indexPage.optJSONArray("rows");
            // The query clamps its own window. A page that FILLED that window may have more
            // behind it even though it returned fewer rows than this caller asked for.
            int cap = indexPage.optInt("limit", Integer.MAX_VALUE);
            List<String> page = new ArrayList<>();
            String next = null;
            int seen = rows == null ? 0 : rows.length();
            for (int index = 0; index < seen && page.size() < limit; index++) {
                JSONObject row = rows.optJSONObject(index);
                String tripId = row == null ? "" : row.optString("trip_id", "");
                // An indexed row with no trip id is unresolved, not absent.
                if (tripId.isEmpty()) {
                    unreadableTripIds.add(row.optString("cursor", "unknown"));
                    continue;
                }
                page.add(tripId);
                // The cursor of the last row ACCEPTED, so the next page resumes exactly
                // after it rather than after whatever this query happened to read last.
                next = row.optString("cursor", null);
            }
            boolean more = seen > page.size() || (seen > 0 && seen >= cap);
            return new PendingPage(page, more, unreadableTripIds, next);
        }

        // AUD-005 round 3. The fallback must ADVANCE, not restart.
        //
        // Filtering unreadable manifests out of a page that always begins at the first
        // name means a stable prefix of unreadable entries consumes the whole bounded
        // scan on every turn and the readable work behind it is never reached. The scan
        // now resumes after a durable watermark, and unreadable names are REPORTED and
        // STEPPED PAST rather than silently dropped — being unreadable is a fact about
        // the entry, not a reason to stop making progress.
        // An explicit cursor pages WITHIN one call; the durable watermark advances the
        // lifecycle turn ACROSS calls. Both resume the same ordering.
        String resumeAfter = cursor != null && !cursor.isEmpty()
            ? cursor
            : readFallbackScanWatermark(context);
        List<String> page = new ArrayList<>();
        List<ManifestEntry> entries = new ArrayList<>();
        String[] lastName = { resumeAfter };
        int[] examined = { 0 };
        boolean[] more = { false };

        boolean reachedEnd = DriveSenseDirectoryStream.visit(
            directory(context),
            path -> path.getFileName().toString().endsWith(MANIFEST_SUFFIX),
            path -> {
                String name = path.getFileName().toString();
                if (resumeAfter != null && name.compareTo(resumeAfter) <= 0) return true;
                if (entries.size() >= limit || examined[0] >= MAX_FALLBACK_SCAN_ENTRIES) {
                    more[0] = true;
                    return false;
                }
                examined[0] += 1;
                lastName[0] = name;
                String stem = name.substring(0, name.length() - MANIFEST_SUFFIX.length());
                JSONObject manifest = readManifest(manifestFile(directory(context), stem), stem);
                if (manifest == null) {
                    // Unreadable: stepped past so the scan still advances, and RECORDED so
                    // the page cannot describe itself as drained while holding it.
                    unreadableTripIds.add(stem);
                    return true;
                }
                String tripId = manifest.optString("trip_id", "");
                if (tripId.isEmpty()) {
                    // Readable file, no pending identity: equally unresolved, and it was
                    // being dropped without a trace.
                    unreadableTripIds.add(stem);
                    return true;
                }
                entries.add(new ManifestEntry(tripId, manifest.optLong("created_at_ms", 0L)));
                return true;
            });

        // Exhausting the directory clears the watermark so the next turn starts fresh;
        // otherwise it records exactly how far this turn got.
        boolean exhausted = reachedEnd && !more[0];
        // Only a lifecycle turn owns the durable watermark. An explicit in-call cursor is
        // the caller's own continuation and must not rewind the shared one.
        if (cursor == null || cursor.isEmpty()) {
            writeFallbackScanWatermark(context, exhausted ? null : lastName[0]);
        }
        entries.sort(Comparator.comparingLong(item -> item.createdAtMs));
        for (ManifestEntry entry : entries) page.add(entry.tripId);
        // Unresolved work is still work: a page holding preserved unreadable names is not
        // a drained queue, even at end of directory.
        return new PendingPage(page, more[0] || !reachedEnd, unreadableTripIds,
            exhausted ? null : lastName[0]);
    }

    /** Bounded names examined per fallback turn. */
    private static final int MAX_FALLBACK_SCAN_ENTRIES = 64;
    private static final String FALLBACK_SCAN_WATERMARK_KEY = "journal_fallback_scan_after";

    private static String readFallbackScanWatermark(Context context) {
        try {
            String value = DriveSenseNativeTripStore.prefs(context)
                .getString(FALLBACK_SCAN_WATERMARK_KEY, null);
            return value == null || value.isEmpty() ? null : value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void writeFallbackScanWatermark(Context context, String value) {
        try {
            if (value == null) {
                DriveSenseNativeTripStore.prefs(context).edit()
                    .remove(FALLBACK_SCAN_WATERMARK_KEY).apply();
            } else {
                DriveSenseNativeTripStore.prefs(context).edit()
                    .putString(FALLBACK_SCAN_WATERMARK_KEY, value).apply();
            }
        } catch (Exception ignored) {
            // A watermark that will not persist costs a repeated scan, never a lost entry.
        }
    }

    static boolean hasCompletedTrip(Context context, String tripId) {
        if (tripId == null || tripId.trim().isEmpty()) return false;
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            String stem = stemForTripId(tripId);
            JSONObject manifest = readManifest(manifestFile(directory(context), stem), stem);
            return manifest != null && tripId.equals(manifest.optString("trip_id", ""));
        }
    }

    static boolean addCompletedTrip(Context context, JSONObject trip) {
        if (context == null || trip == null) return false;
        String tripId = trip.optString("id", "").trim();
        if (tripId.isEmpty()) return false;

        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            DriveSenseJournalControlPlane.beginEntryMutation(context,tripId);
            // Never delete unreferenced intake bytes by age. P3.5 recovery/cleanup is
            // catalog-state and ownership driven after raw preservation.
            boolean saved=writeStreamingJournalEntry(context,trip,tripId);
            if(saved)DriveSenseJournalControlPlane.recordEntry(context,tripId);
            else DriveSenseJournalControlPlane.finishFailedEntryMutation(context,tripId);
            return saved;
        }
    }

    /**
     * Returns only bounded, authenticated metadata needed to stream an RSAS
     * intake entry directly into canonical encryption. No route segment is
     * decrypted by this inventory operation.
     */
    static CompletedStreamDescriptor describeCompletedStream(Context context, String tripId) throws Exception {
        if (context == null || tripId == null || tripId.trim().isEmpty()) return null;
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            String normalized = tripId.trim();
            String stem = stemForTripId(normalized);
            File journalDirectory = directory(context);
            JSONObject manifest = readManifest(manifestFile(journalDirectory, stem), stem);
            if (manifest == null || manifest.optInt("version", 0) != 2 ||
                !"RSAS_V1".equals(manifest.optString("source_format", "")) ||
                !normalized.equals(manifest.optString("trip_id", ""))) return null;
            long plaintextBytes = manifest.optLong("plaintext_bytes", 0L);
            String sha256 = manifest.optString("sha256", "");
            JSONObject metadata = manifest.optJSONObject("completion_metadata");
            if (plaintextBytes <= 0L || !sha256.matches("[0-9a-f]{64}") || metadata == null) {
                throw new SecurityException("RSAS journal descriptor is incomplete");
            }
            String sessionId = manifest.getString("rsas_session_id");
            File adopted = DriveSenseActiveTripSpool.locateJournalSession(context, journalDirectory, sessionId);
            JSONObject spoolManifest = DriveSenseActiveTripSpool.readManifestForStatus(context, adopted);
            metadata.put("point_count", manifest.optLong("point_count",
                spoolManifest.optLong("point_count", metadata.optLong("point_count", 0L))));
            JSONArray points = spoolManifest.optJSONArray("overview");
            JSONObject overview = new JSONObject();
            overview.put("schemaVersion", 1); overview.put("tripId", normalized);
            overview.put("points", points == null ? new JSONArray() : points);
            byte[] overviewBytes = overview.toString().getBytes(StandardCharsets.UTF_8);
            if (overviewBytes.length > DriveSenseTripOverviewBuilder.MAX_PLAINTEXT_BYTES) {
                throw new SecurityException("RSAS overview exceeds canonical bound");
            }
            return new CompletedStreamDescriptor(
                normalized, plaintextBytes, sha256, new JSONObject(metadata.toString()),
                overviewBytes, points == null ? 0 : points.length(), directoryBytes(adopted)
            );
        }
    }

    /**
     * Adopts a sealed RSAS directory into journal ownership without copying or
     * re-encrypting route segments. The encrypted journal manifest contains
     * only bounded completion metadata and the adopted session identifier.
     */
    private static volatile String testJournalFaultPoint;

    /** Deterministic crash boundary for the adoption seam. Tests only. */
    static void setFaultPointForTests(String point) { testJournalFaultPoint = point; }

    private static void maybeJournalFault(String point) {
        if (point.equals(testJournalFaultPoint)) throw new IllegalStateException("TEST_FAULT_" + point);
    }

    static boolean addCompletedActiveSpool(
        Context context,
        DriveSenseActiveTripSpool spool,
        JSONObject completionMetadata
    ) {
        if (context == null || spool == null || completionMetadata == null) return false;
        String tripId = completionMetadata.optString("id", "").trim();
        if (tripId.isEmpty() || !tripId.equals(spool.tripId())) return false;
        synchronized (LOCK) {
            boolean mutationStarted = false;
            boolean journalPrepared = false;
            File targetManifest = null;
            try {
                // Normalize bounded metadata through the same JSON parse path
                // used on recovery so numeric spellings cannot change the
                // authenticated completed-stream byte count after restart.
                JSONObject stableMetadata = new JSONObject(completionMetadata.toString());
                if (!ensureLegacyMigrated(context)) return false;
                if (hasJournalTripWithoutMigration(context, tripId)) { DriveSenseJournalControlPlane.recordEntry(context,tripId); return true; }
                DriveSenseJournalControlPlane.beginEntryMutation(context,tripId);
                mutationStarted = true;
                spool.seal();
                spool.markJournalOwned();
                journalPrepared = true;
                File journalDirectory = directory(context);
                File rsasRoot = new File(journalDirectory, "rsas_v1");
                if (!rsasRoot.exists() && !rsasRoot.mkdirs()) throw new IllegalStateException("RSAS_JOURNAL_DIRECTORY_UNAVAILABLE");
                File adopted = new File(rsasRoot, spool.sessionId());

                JSONObject manifest = new JSONObject();
                manifest.put("version", 2);
                manifest.put("source_format", "RSAS_V1");
                manifest.put("trip_id", tripId);
                manifest.put("rsas_session_id", spool.sessionId());
                manifest.put("completion_metadata", stableMetadata);
                manifest.put("chunk_count", Math.max(1, spool.sealedSegmentCount()));
                manifest.put("point_count", spool.pointCount());
                manifest.put("created_at_ms", stableMetadata.optLong("end_time_ms", System.currentTimeMillis()));
                manifest.put("updated_at_ms", System.currentTimeMillis());
                MessageDigest sourceDigest = MessageDigest.getInstance("SHA-256");
                CountingDigestOutput sourceCount = new CountingDigestOutput(NULL_OUTPUT, sourceDigest);
                spool.streamCompletedTrip(stableMetadata, sourceCount);
                JournalStreamResult verified = new JournalStreamResult(
                    tripId,
                    sourceCount.count,
                    Math.max(1, spool.sealedSegmentCount()),
                    DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES,
                    hex(sourceDigest.digest())
                );
                manifest.put("plaintext_bytes", verified.plaintextBytes);
                manifest.put("chunk_count", verified.chunkCount);
                manifest.put("sha256", verified.sha256);
                String stem = stemForTripId(tripId);
                targetManifest = manifestFile(journalDirectory, stem);
                byte[] encryptedManifest = DriveSensePayloadCrypto
                    .encryptForStorage(manifest.toString(), manifestContext(stem))
                    .getBytes(StandardCharsets.UTF_8);
                if (encryptedManifest.length <= 0 || encryptedManifest.length > MAX_MANIFEST_BYTES) {
                    throw new IllegalStateException("RSAS completed-trip manifest exceeded its size limit");
                }
                maybeJournalFault("BEFORE_JOURNAL_MANIFEST_WRITE");
                writeAtomic(targetManifest, encryptedManifest);
                maybeJournalFault("AFTER_JOURNAL_MANIFEST_WRITE");
                DriveSenseArchiveSentinelStore.fsyncDirectory(journalDirectory);
                // The durable journal manifest is the ownership hand-off point.
                // It can resolve the session from either the active or adopted
                // directory, so a crash on either side of rename is recoverable.
                try {
                    spool.transferDirectoryTo(adopted);
                } catch (Exception transferError) {
                    Log.w(TAG, "RSAS journal manifest committed before directory adoption; recovery will use prepared location", transferError);
                    spool.close();
                }
                JournalStreamResult readBack = streamCompletedTripTo(context, tripId, NULL_OUTPUT);
                if (!verified.sha256.equals(readBack.sha256) || verified.plaintextBytes != readBack.plaintextBytes) {
                    throw new SecurityException("RSAS journal read-back mismatch");
                }
                DriveSenseJournalControlPlane.recordEntry(context,tripId);
                return true;
            } catch (Exception error) {
                Log.e(TAG, "Could not transfer sealed active spool into the intake journal; bytes were preserved", error);
                // Before the manifest is durable, JOURNAL is only a prepared state and
                // has no owner that can finish after process death. Return it to ACTIVE
                // so the encrypted checkpoint plus process-incarnation handoff can retry.
                // If any target manifest exists, fail closed and retain journal ownership.
                if (journalPrepared && (targetManifest == null || !targetManifest.isFile())) {
                    try {
                        spool.resumeActiveAfterFailedJournalAdmission();
                    } catch (Exception rollbackError) {
                        Log.e(TAG, "Could not return failed journal admission to active ownership", rollbackError);
                    }
                }
                if (mutationStarted) DriveSenseJournalControlPlane.finishFailedEntryMutation(context, tripId);
                return false;
            }
        }
    }

    static JSONObject acknowledgeCompletedTrips(Context context, JSONArray tripIds) {
        JSONObject result = new JSONObject();
        synchronized (LOCK) {
            ensureLegacyMigrated(context);
            int requested = tripIds == null ? 0 : tripIds.length();
            int removed = 0;
            JSONArray missing = new JSONArray();
            JSONArray failed = new JSONArray();
            for (int index = 0; index < requested; index++) {
                String tripId = tripIds.optString(index, "").trim();
                if (tripId.isEmpty()) continue;
                String stem = stemForTripId(tripId);
                File journalDirectory = directory(context);
                if (!entryExists(journalDirectory, stem)) {
                    missing.put(tripId);
                } else {DriveSenseJournalControlPlane.beginEntryMutation(context,tripId);if (deleteEntry(context, journalDirectory, stem)) {
                    maybeJournalFault("AFTER_ACK_FILES_BEFORE_REGISTRY");
                    removed++;
                    DriveSenseJournalControlPlane.removeEntry(context,tripId);
                } else {
                    failed.put(tripId);
                }}
            }
            // Space has been reclaimed, so a past overflow is no longer an active warning.
            if (removed > 0) {
                clearOverflowRecord(context);
            }
            if(failed.length()>0)DriveSenseJournalControlPlane.markDirty(context,"UNKNOWN");
            try {
                result.put("requested", requested);
                result.put("removed", removed);
                result.put("missingTripIds", missing);
                result.put("failedTripIds", failed);
                result.put("success", failed.length() == 0);
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            return result;
        }
    }

    static JSONArray pendingTripIds(Context context, int maxItems) {
        synchronized (LOCK) {
            if (!ensureLegacyMigrated(context)) throw new IllegalStateException("JOURNAL_LEGACY_UNKNOWN");
            if(!DriveSenseJournalControlPlane.enabled(context))return legacyPendingTripIds(context,maxItems);
            try{return DriveSenseJournalControlPlane.oldest(context,maxItems);}
            catch(Exception error){throw new IllegalStateException("JOURNAL_INDEX_DIRTY",error);}
        }
    }

    static JSONObject getCompletedTrip(Context context, String tripId) {
        String safe = tripId == null ? "" : tripId.trim();
        if (safe.isEmpty()) return null;
        synchronized (LOCK) {
            if (!ensureLegacyMigrated(context)) return null;
            return readTripForStem(context, stemForTripId(safe));
        }
    }

    /** Decrypts and authenticates the chunked intake entry into an admitted spool. */
    static JournalStreamResult streamCompletedTripTo(Context context,String tripId,OutputStream output)throws Exception{
        String safe=tripId==null?"":tripId.trim();if(safe.isEmpty())throw new IllegalArgumentException("tripId required");
        synchronized(LOCK){
            if(!ensureLegacyMigrated(context))throw new IllegalStateException("Completed journal migration unavailable");
            File directory=directory(context);String stem=stemForTripId(safe);JSONObject manifest=readManifest(manifestFile(directory,stem),stem);
            if(manifest==null||!safe.equals(manifest.optString("trip_id","")))throw new IllegalStateException("Completed journal manifest unavailable");
            return streamManifestTo(directory, stem, manifest, output);
        }
    }

    static JSONObject acknowledgeOne(Context context, String tripId) {
        JSONArray ids = new JSONArray();
        ids.put(tripId);
        return acknowledgeCompletedTrips(context, ids);
    }

    static void clear(Context context) {
        synchronized (LOCK) {
            DriveSenseJournalControlPlane.markDirty(context,"UNKNOWN");
            File directory = directory(context);
            File[] files = safeFiles(directory);
            for (File file : files) {
                if (file.isDirectory()) DriveSenseActiveTripSpool.deleteAdoptedTree(file);
                else deleteFile(file);
            }
            if (directory.exists()) directory.delete();
            if (!SecureDeleteHelper.overwriteAndRemovePreference(
                DriveSenseNativeTripStore.prefs(context),
                DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS
            )) {
                DriveSenseNativeTripStore.prefs(context)
                    .edit()
                    .remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS)
                    .commit();
            }
            DriveSenseJournalControlPlane.clearRegistry(context);
            try {
                DriveSenseKeyReferenceCounts.clearFileDomain(context, "completed_trip_journal");
            } catch (Exception error) {
                throw new IllegalStateException("JOURNAL_KEY_REGISTRY_CLEAR_FAILED", error);
            }
        }
    }

    static JSONObject getStatus(Context context) {
        synchronized (LOCK) {
            boolean legacyReadable = ensureLegacyMigrated(context);
            JSONObject summary;
            if(!DriveSenseJournalControlPlane.enabled(context)){
                ScanResult legacy=scanMetadata(context);summary=new JSONObject();try{summary.put("summaryState","P3_5_COMPATIBILITY");summary.put("queueReadable",legacyReadable&&legacy.unreadableCount==0);summary.put("pendingCount",legacy.pendingCount);summary.put("unreadableCount",legacy.unreadableCount);summary.put("encryptedBytes",directoryBytes(directory(context)));summary.put("largestFileBytes",largestFileBytes(directory(context)));summary.put("oldestPendingAtMs",legacy.oldestPendingAtMs>0?legacy.oldestPendingAtMs:JSONObject.NULL);summary.put("lastVerifiedSaveAtMs",legacy.lastVerifiedSaveAtMs>0?legacy.lastVerifiedSaveAtMs:JSONObject.NULL);}catch(Exception ignored){}
            }else try{summary=DriveSenseJournalControlPlane.status(context);}catch(Exception error){summary=new JSONObject();try{summary.put("summaryState","UNKNOWN");summary.put("queueReadable",false);summary.put("pendingCount",0);summary.put("unreadableCount",1);summary.put("encryptedBytes",0);summary.put("largestFileBytes",0);summary.put("oldestPendingAtMs",JSONObject.NULL);summary.put("lastVerifiedSaveAtMs",JSONObject.NULL);}catch(Exception ignored){}}
            int unreadableCount=summary.optInt("unreadableCount",0)+(legacyReadable?0:1);
            long availableBytes = 0L;
            try {
                availableBytes = DriveSenseStorageAdmission.availableBytes(context);
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            JSONObject status = new JSONObject();
            try {
                status.put("journalVersion", VERSION);
                status.put("summaryState",summary.optString("summaryState","UNKNOWN"));
                status.put("queueReadable", summary.optBoolean("queueReadable",false)&&unreadableCount==0);
                status.put("pendingCount", summary.optLong("pendingCount",0));
                status.put("unreadableCount", unreadableCount);
                status.put("encryptedBytes", summary.optLong("encryptedBytes",0));
                status.put("maxTotalBytes", JSONObject.NULL);
                status.put("largestFileBytes", summary.optLong("largestFileBytes",0));
                status.put("maxFileBytes", MAX_ENCRYPTED_CHUNK_BYTES);
                status.put("oldestPendingAtMs", summary.opt("oldestPendingAtMs"));
                status.put("lastVerifiedSaveAtMs", summary.opt("lastVerifiedSaveAtMs"));
                status.put("availableDeviceBytes", availableBytes > 0L ? availableBytes : JSONObject.NULL);
                status.put("entryLimit", JSONObject.NULL);
                android.content.SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
                int droppedCount = prefs.getInt(KEY_OVERFLOW_COUNT, 0);
                long droppedAtMs = prefs.getLong(KEY_OVERFLOW_AT_MS, 0L);
                status.put("droppedTripCount", droppedCount);
                status.put("droppedAtMs", droppedAtMs > 0L ? droppedAtMs : JSONObject.NULL);
                status.put("droppedReason", droppedCount > 0
                    ? prefs.getString(KEY_OVERFLOW_REASON, "entry_limit")
                    : JSONObject.NULL);
                status.put("cloudBackupExcluded", true);
                status.put("storageScope", "app_private_no_backup");
            } catch (Exception error) {
                Log.w(TAG, "Could not synchronized", error);
            }
            return status;
        }
    }

    private static boolean ensureLegacyMigrated(Context context) {
        String stored = DriveSenseNativeTripStore.prefs(context)
            .getString(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS, null);
        if (stored == null) return true;
        DriveSenseJournalControlPlane.markDirty(context,"PRESENT");
        try {
            String raw = DriveSensePayloadCrypto.decryptStoredValue(
                stored,
                DriveSenseNativeTripStore.COMPLETED_TRIPS_CONTEXT
            );
            JSONArray legacyTrips = new JSONArray(raw);
            for (int index = 0; index < legacyTrips.length(); index++) {
                JSONObject trip = legacyTrips.optJSONObject(index);
                if (trip != null && !addCompletedTripWithoutMigration(context, trip)) return false;
            }
            if (!SecureDeleteHelper.overwriteAndRemovePreference(
                DriveSenseNativeTripStore.prefs(context),
                DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS
            )) {
                return DriveSenseNativeTripStore.prefs(context)
                    .edit()
                    .remove(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS)
                    .commit();
            }
            DriveSenseJournalControlPlane.markDirty(context,"ABSENT");
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Legacy completed-trip queue is unreadable and was preserved", error);
            return false;
        }
    }

    private static boolean addCompletedTripWithoutMigration(Context context, JSONObject trip) {
        String tripId = trip.optString("id", "").trim();
        if (tripId.isEmpty()) return false;
        if (hasJournalTripWithoutMigration(context, tripId)) return true;
        DriveSenseJournalControlPlane.beginEntryMutation(context,tripId);
        boolean saved=writeStreamingJournalEntry(context, trip, tripId);
        if(saved)DriveSenseJournalControlPlane.recordEntry(context,tripId);
        return saved;
    }

    /**
     * Serializes the producer object once into an operation-owned disk spool, then encrypts
     * bounded chunks. The producer may already hold a trip in memory, but the journal never
     * creates a second full String or byte[] representation.
     */
    private static boolean writeStreamingJournalEntry(Context context, JSONObject trip, String tripId) {
        String stem = stemForTripId(tripId);
        File journalDirectory = directory(context);
        if (!journalDirectory.exists() && !journalDirectory.mkdirs()) return false;
        String generation = UUID.randomUUID().toString().replace("-", "");
        File spool = new File(journalDirectory, stem + "." + generation + ".source.tmp");
        try {
            try (FileOutputStream fileOutput = new FileOutputStream(spool);
                 java.io.BufferedOutputStream output = new java.io.BufferedOutputStream(fileOutput, 64 * 1024)) {
                DriveSenseTripArchiveSerializer.write(trip, output);
                output.flush();
                fileOutput.getFD().sync();
            }
            return writeEncryptedJournalFromSpool(context, spool, tripId);
        } catch (Exception error) {
            Log.e(TAG, "Could not serialize completed trip into the intake journal", error);
            return false;
        } finally {
            try {
                SecureDeleteHelper.secureWipeFile(spool);
            } catch (Exception cleanupError) {
                Log.w(TAG, "Could not wipe completed-trip source spool", cleanupError);
                deleteFile(spool);
            }
        }
    }

    /** Bounded source contract used by the native tracker and large-route fault fixtures. */
    static boolean addCompletedTripSpool(Context context, File source, String tripId) {
        if (context == null || source == null || !source.isFile() || tripId == null || tripId.trim().isEmpty()) return false;
        synchronized (LOCK) {
            if (!ensureLegacyMigrated(context)) return false;
            if (hasJournalTripWithoutMigration(context, tripId)) { DriveSenseJournalControlPlane.recordEntry(context,tripId); return true; }
            DriveSenseJournalControlPlane.beginEntryMutation(context,tripId);
            boolean saved=writeEncryptedJournalFromSpool(context, source, tripId.trim());
            if(saved)DriveSenseJournalControlPlane.recordEntry(context,tripId.trim());
            return saved;
        }
    }

    private static boolean writeEncryptedJournalFromSpool(Context context, File spool, String tripId) {
        String stem = stemForTripId(tripId);
        File journalDirectory = directory(context);
        if (!journalDirectory.exists() && !journalDirectory.mkdirs()) return false;
        File manifestFile = manifestFile(journalDirectory, stem);
        if (manifestFile.exists() && readManifest(manifestFile, stem) == null) return false;
        String generation = UUID.randomUUID().toString().replace("-", "");
        List<File> writtenChunks = new ArrayList<>();
        byte[] previousManifest = null;
        boolean manifestCommitted = false;
        try {
            long plaintextBytes = spool.length();
            if (plaintextBytes <= 0L) throw new IllegalStateException("Completed trip was empty");
            long chunkCountLong = (plaintextBytes + MAX_PLAINTEXT_CHUNK_BYTES - 1L) / MAX_PLAINTEXT_CHUNK_BYTES;
            if (chunkCountLong <= 0L || chunkCountLong > MAX_CHUNKS_PER_TRIP) {
                throw new IllegalStateException("Completed trip exceeds journal representation bounds");
            }
            int chunkCount = (int) chunkCountLong;
            DriveSenseTripStreamInspector.Result inspected = DriveSenseTripStreamInspector.inspect(context, spool, tripId);
            String sourceHash = sha256File(spool);
            long existingEntryBytes = bytesForStem(context, journalDirectory, stem);
            long estimatedEncryptedBytes = estimateEncryptedBytes(plaintextBytes, chunkCount) + MAX_MANIFEST_BYTES;
            if (!hasStorageAdmission(context, Math.max(0L, estimatedEncryptedBytes - existingEntryBytes))) {
                recordOverflow(context, "low_space");
                return false;
            }
            if (manifestFile.exists()) previousManifest = readBounded(manifestFile, MAX_MANIFEST_BYTES);
            try (InputStream input = new FileInputStream(spool)) {
                byte[] buffer = new byte[MAX_PLAINTEXT_CHUNK_BYTES];
                for (int index = 0; index < chunkCount; index++) {
                    int length = readChunk(input, buffer);
                    if (length <= 0) throw new IllegalStateException("Completed trip spool ended early");
                    byte[] chunk = java.util.Arrays.copyOf(buffer, length);
                    byte[] encrypted = null;
                    try {
                        encrypted = DriveSensePayloadCrypto.encryptBytesForStorage(
                            chunk,
                            chunkContext(stem, generation, index)
                        );
                        if (encrypted.length > MAX_ENCRYPTED_CHUNK_BYTES) throw new IllegalStateException("Chunk too large");
                        File target = chunkFile(journalDirectory, stem, generation, index);
                        writeAtomic(target, encrypted);
                        writtenChunks.add(target);
                    } finally {
                        java.util.Arrays.fill(chunk, (byte) 0);
                        if (encrypted != null) java.util.Arrays.fill(encrypted, (byte) 0);
                    }
                }
                if (input.read() != -1) throw new IllegalStateException("Completed trip spool exceeded manifest chunk count");
                java.util.Arrays.fill(buffer, (byte) 0);
            }
            DriveSenseArchiveSentinelStore.fsyncDirectory(journalDirectory);
            JSONObject manifest = new JSONObject();
            manifest.put("version", VERSION);
            manifest.put("trip_id", tripId);
            manifest.put("generation", generation);
            manifest.put("chunk_count", chunkCount);
            manifest.put("plaintext_bytes", plaintextBytes);
            manifest.put("sha256", sourceHash);
            manifest.put("created_at_ms", inspected.display.optLong("end_time_ms", System.currentTimeMillis()));
            // AUD-005 restart discovery: recorded on every write, including the rewrite the
            // acknowledgement performs, so clearing the workflow clears this too.
            manifest.put("emergency_pending", inspected.emergencyPending ? 1 : 0);
            manifest.put("updated_at_ms", System.currentTimeMillis());
            streamManifestTo(journalDirectory, stem, manifest, NULL_OUTPUT);
            byte[] encryptedManifest = DriveSensePayloadCrypto
                .encryptForStorage(manifest.toString(), manifestContext(stem))
                .getBytes(StandardCharsets.UTF_8);
            if (encryptedManifest.length == 0 || encryptedManifest.length > MAX_MANIFEST_BYTES) {
                throw new IllegalStateException("Completed-trip manifest exceeded its size limit");
            }
            writeAtomic(manifestFile, encryptedManifest);
            manifestCommitted = true;
            DriveSenseArchiveSentinelStore.fsyncDirectory(journalDirectory);
            JournalStreamResult verified = streamCompletedTripTo(context, tripId, NULL_OUTPUT);
            if (!tripId.equals(verified.tripId) || verified.plaintextBytes != plaintextBytes) {
                throw new IllegalStateException("Completed-trip journal read-back failed");
            }
            cleanupSupersededChunks(context, journalDirectory, stem, generation);
            return true;
        } catch (Exception error) {
            Log.e(TAG, "Could not durably stream completed trip into the intake journal", error);
            if (manifestCommitted) restoreManifest(manifestFile, previousManifest);
            for (File file : writtenChunks) deleteFile(file);
            return false;
        }
    }

    private static JournalStreamResult streamManifestTo(
        File journalDirectory,
        String stem,
        JSONObject manifest,
        OutputStream output
    ) throws Exception {
        if (manifest.optInt("version", 0) == 2 && "RSAS_V1".equals(manifest.optString("source_format"))) {
            return streamRsasManifest(null, journalDirectory, manifest, output);
        }
        String tripId = manifest.getString("trip_id");
        String generation = manifest.getString("generation");
        int count = manifest.getInt("chunk_count");
        long expected = manifest.getLong("plaintext_bytes");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long written = 0L;
        int maximum = 0;
        for (int index = 0; index < count; index++) {
            byte[] encrypted = readBounded(
                chunkFile(journalDirectory, stem, generation, index),
                MAX_ENCRYPTED_CHUNK_BYTES
            );
            byte[] plain = null;
            try {
                plain = DriveSensePayloadCrypto.decryptStoredBytes(
                    encrypted,
                    chunkContext(stem, generation, index)
                );
                if (plain.length > MAX_PLAINTEXT_CHUNK_BYTES) {
                    throw new IllegalStateException("Completed journal plaintext chunk oversized");
                }
                output.write(plain);
                digest.update(plain);
                written += plain.length;
                maximum = Math.max(maximum, plain.length);
            } finally {
                java.util.Arrays.fill(encrypted, (byte) 0);
                if (plain != null) java.util.Arrays.fill(plain, (byte) 0);
            }
        }
        String actual = hex(digest.digest());
        if (written != expected || !actual.equals(manifest.optString("sha256", ""))) {
            throw new SecurityException("Completed journal stream checksum mismatch");
        }
        return new JournalStreamResult(tripId, written, count, maximum, actual);
    }

    private static JournalStreamResult streamRsasManifest(
        Context explicitContext,
        File journalDirectory,
        JSONObject manifest,
        OutputStream output
    ) throws Exception {
        Context context = explicitContext != null ? explicitContext : journalContext;
        if (context == null) throw new IllegalStateException("RSAS journal context unavailable");
        String tripId = manifest.getString("trip_id");
        String sessionId = manifest.getString("rsas_session_id");
        File adopted = DriveSenseActiveTripSpool.locateJournalSession(context, journalDirectory, sessionId);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        CountingDigestOutput counted = new CountingDigestOutput(output, digest);
        int segmentCount;
        try (DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.reopenAdopted(context, adopted)) {
            spool.streamJournalOwnedTrip(manifest.getJSONObject("completion_metadata"), counted);
            segmentCount = manifest.optInt("chunk_count", 0);
            if (segmentCount <= 0) segmentCount = 1;
        }
        String hash = hex(digest.digest());
        if (manifest.has("plaintext_bytes") && manifest.optLong("plaintext_bytes") != counted.count) {
            throw new SecurityException("RSAS journal byte-count mismatch expected=" +
                manifest.optLong("plaintext_bytes") + " actual=" + counted.count);
        }
        if (manifest.has("sha256") && !hash.equals(manifest.optString("sha256"))) {
            throw new SecurityException("RSAS journal checksum mismatch");
        }
        return new JournalStreamResult(tripId, counted.count, segmentCount, DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES, hash);
    }

    private static int readChunk(InputStream input, byte[] buffer) throws Exception {
        int total = 0;
        while (total < buffer.length) {
            int read = input.read(buffer, total, buffer.length - total);
            if (read == -1) break;
            if (read == 0) continue;
            total += read;
        }
        return total;
    }

    private static boolean hasJournalTripWithoutMigration(Context context, String tripId) {
        String stem = stemForTripId(tripId);
        JSONObject manifest = readManifest(manifestFile(directory(context), stem), stem);
        return manifest != null && tripId.equals(manifest.optString("trip_id", ""));
    }


    /** Manifest-only inventory: never decrypts or materializes a trip payload. */
    private static ScanResult scanMetadata(Context context) {
        ScanResult result = new ScanResult();
        for (File manifestFile : manifestFiles(directory(context))) {
            String stem = stemFromManifest(manifestFile);
            JSONObject manifest = readManifest(manifestFile, stem);
            if (manifest == null) {
                result.unreadableCount++;
                continue;
            }
            result.pendingCount++;
            long createdAtMs = manifest.optLong("created_at_ms", 0L);
            long updatedAtMs = manifest.optLong("updated_at_ms", 0L);
            if (createdAtMs > 0L && (result.oldestPendingAtMs == 0L || createdAtMs < result.oldestPendingAtMs)) {
                result.oldestPendingAtMs = createdAtMs;
            }
            result.lastVerifiedSaveAtMs = Math.max(result.lastVerifiedSaveAtMs, updatedAtMs);
        }
        return result;
    }

    private static JSONArray legacyPendingTripIds(Context context, int maxItems) {
        int limit = Math.max(1, Math.min(8, maxItems));
        JSONArray out = new JSONArray();
        try {
            // Round 2: the bounded directory page, not a whole-backlog enumeration.
            for (String tripId : pendingTripIdsPage(context, limit).tripIds) {
                if (out.length() >= limit) break;
                out.put(tripId);
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not enumerate a bounded pending page", error);
        }
        return out;
    }

    private static JSONObject readTripForStem(Context context, String stem) {
        File directory = directory(context);
        JSONObject manifest = readManifest(manifestFile(directory, stem), stem);
        return manifest == null ? null : readTrip(directory, stem, manifest);
    }

    static JSONObject readManifest(File file, String stem) {
        if (file == null || !file.exists()) return null;
        try {
            byte[] encrypted = readBounded(file, MAX_MANIFEST_BYTES);
            String stored = new String(encrypted, StandardCharsets.UTF_8);
            String raw = DriveSensePayloadCrypto.decryptStoredValue(stored, manifestContext(stem));
            JSONObject manifest = new JSONObject(raw);
            int version = manifest.optInt("version", 0);
            if (
                (version != VERSION && version != 2) ||
                manifest.optString("trip_id", "").trim().isEmpty() ||
                (version == VERSION && manifest.optString("generation", "").trim().isEmpty()) ||
                manifest.optInt("chunk_count", 0) <= 0 ||
                manifest.optInt("chunk_count", 0) > MAX_CHUNKS_PER_TRIP ||
                manifest.optLong("plaintext_bytes", 0L) <= 0L ||
                (version == 2 && !"RSAS_V1".equals(manifest.optString("source_format", "")))
            ) return null;
            return manifest;
        } catch (Exception error) {
            Log.e(TAG, "Completed-trip manifest is unreadable and was preserved", error);
            return null;
        }
    }

    private static JSONObject readTrip(File directory, String stem, JSONObject manifest) {
        if (manifest.optInt("version", 0) == 2) {
            try {
                long expected = manifest.optLong("plaintext_bytes", 0L);
                if (expected > Integer.MAX_VALUE - 8L) throw new IllegalStateException("Legacy whole-trip read cannot represent RSAS entry");
                ByteArrayOutputStream bytes = new ByteArrayOutputStream((int)Math.min(expected, 8192L));
                streamManifestTo(directory, stem, manifest, bytes);
                return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            } catch (Exception error) {
                Log.e(TAG, "RSAS completed trip is unreadable and was preserved", error);
                return null;
            }
        }
        String generation = manifest.optString("generation", "");
        int chunkCount = manifest.optInt("chunk_count", 0);
        long expectedBytesLong = manifest.optLong("plaintext_bytes", 0L);
        try {
            if (expectedBytesLong > Integer.MAX_VALUE - 8L) {
                throw new IllegalStateException("Legacy whole-trip read cannot represent this streamed journal entry");
            }
            int expectedBytes = (int) expectedBytesLong;
            ByteArrayOutputStream plaintext = new ByteArrayOutputStream(Math.min(expectedBytes, 8192));
            for (int index = 0; index < chunkCount; index++) {
                File file = chunkFile(directory, stem, generation, index);
                byte[] encrypted = readBounded(file, MAX_ENCRYPTED_CHUNK_BYTES);
                byte[] chunk = DriveSensePayloadCrypto.decryptStoredBytes(
                    encrypted,
                    chunkContext(stem, generation, index)
                );
                if ((long) plaintext.size() + chunk.length > Integer.MAX_VALUE - 8L) {
                    throw new IllegalStateException("Completed trip exceeded read limit");
                }
                plaintext.write(chunk);
            }
            byte[] raw = plaintext.toByteArray();
            if (raw.length != expectedBytes || !sha256Hex(raw).equals(manifest.optString("sha256", ""))) {
                throw new IllegalStateException("Completed-trip checksum mismatch");
            }
            JSONObject trip = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (!manifest.optString("trip_id", "").equals(trip.optString("id", ""))) {
                throw new IllegalStateException("Completed-trip ID mismatch");
            }
            return trip;
        } catch (Exception error) {
            Log.e(TAG, "Completed trip is unreadable and was preserved", error);
            return null;
        }
    }

    private static void writeAtomic(File file, byte[] data) throws Exception {
        AtomicFile atomicFile = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomicFile.startWrite();
            output.write(data);
            output.flush();
            output.getFD().sync();
            atomicFile.finishWrite(output);
        } catch (Exception error) {
            if (output != null) atomicFile.failWrite(output);
            throw error;
        }
    }

    private static void restoreManifest(File manifestFile, byte[] previousManifest) {
        try {
            if (previousManifest == null) {
                deleteFile(manifestFile);
            } else {
                writeAtomic(manifestFile, previousManifest);
            }
        } catch (Exception error) {
            Log.e(TAG, "Could not restore the previous completed-trip manifest", error);
        }
    }

    private static byte[] readBounded(File file, int maxBytes) throws Exception {
        if (file == null || !file.exists()) throw new FileNotFoundException("Journal file missing");
        try (InputStream input = new FileInputStream(file)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(Math.max(32L, file.length()), 8192L));
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IllegalStateException("Journal file exceeded bounded size");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static long estimateEncryptedBytes(long plaintextBytes, int chunkCount) {
        return Math.round(plaintextBytes * 1.38d) + chunkCount * 128L;
    }

    private static boolean hasStorageAdmission(Context context, long requiredBytes) {
        try {
            long available = DriveSenseStorageAdmission.availableBytes(context);
            return requiredBytes >= 0L && available - requiredBytes >= STORAGE_RESERVE_BYTES;
        } catch (Exception error) {
            Log.e(TAG, "Could not establish completed-trip intake admission", error);
            return false;
        }
    }

    private static long parseCreatedAtMs(JSONObject trip) {
        String timestamp = trip.optString("end_time", trip.optString("created_at", ""));
        try {
            return java.time.Instant.parse(timestamp).toEpochMilli();
        } catch (Exception ignored) {
            return System.currentTimeMillis();
        }
    }

    private static String stemForTripId(String tripId) {
        return sha256Hex(tripId.getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    private static String sha256Hex(byte[] value) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }

    private static String hex(byte[] value) {
        StringBuilder encoded = new StringBuilder(value.length * 2);
        for (byte item : value) encoded.append(String.format("%02x", item & 0xff));
        return encoded.toString();
    }

    static File directory(Context context) {
        journalContext = context == null ? journalContext : context.getApplicationContext();
        return new File(context.getNoBackupFilesDir(), DIRECTORY_NAME);
    }

    static File manifestFile(File directory, String stem) {
        return new File(directory, stem + MANIFEST_SUFFIX);
    }

    private static File chunkFile(File directory, String stem, String generation, int index) {
        return new File(directory, stem + "." + generation + "." + index + CHUNK_SUFFIX);
    }

    private static String manifestContext(String stem) {
        return MANIFEST_CONTEXT_PREFIX + stem;
    }

    private static String chunkContext(String stem, String generation, int index) {
        return CHUNK_CONTEXT_PREFIX + stem + ":" + generation + ":" + index;
    }

    static File[] manifestFiles(File directory) {
        File[] files = directory.listFiles((dir, name) -> name.endsWith(MANIFEST_SUFFIX));
        return files == null ? new File[0] : files;
    }

    private static File[] safeFiles(File directory) {
        File[] files = directory.listFiles();
        return files == null ? new File[0] : files;
    }

    static String stemFromManifest(File file) {
        String name = file.getName();
        return name.substring(0, name.length() - MANIFEST_SUFFIX.length());
    }

    private static long directoryBytes(File directory) {
        long total = 0L;
        for (File file : safeFiles(directory)) total += Math.max(0L, file.length());
        return total;
    }

    private static long largestFileBytes(File directory){long largest=0L;for(File file:safeFiles(directory))largest=Math.max(largest,Math.max(0L,file.length()));return largest;}

    private static long bytesForStem(Context context, File directory, String stem) {
        long indexed = DriveSenseJournalControlPlane.entryBytes(context, stem);
        if (indexed >= 0L) return indexed;
        long total = 0L;
        String prefix = stem + ".";
        for (File file : safeFiles(directory)) {
            if (file.getName().startsWith(prefix)) total += Math.max(0L, file.length());
        }
        return total;
    }

    private static boolean deleteEntry(Context context, File directory, String stem) {
        JSONObject manifest = readManifest(manifestFile(directory, stem), stem);
        if (manifest == null) return false;
        java.util.LinkedHashSet<File> exact = new java.util.LinkedHashSet<>();
        exact.add(manifestFile(directory, stem));
        int count = manifest.optInt("chunk_count", 0);
        if (manifest.optInt("version", 0) == 2) {
            String session = manifest.optString("rsas_session_id", "");
            if (session.isEmpty()) return false;
            File adopted = DriveSenseActiveTripSpool.locateJournalSession(context, directory, session);
            exact.add(new File(adopted, "manifest.enc"));
            for (int index = 0; index < count; index++) {
                exact.add(new File(adopted, String.format(java.util.Locale.US, "%08d.rstc", index)));
            }
        } else {
            String generation = manifest.optString("generation", "");
            if (generation.isEmpty()) return false;
            for (int index = 0; index < count; index++) exact.add(chunkFile(directory, stem, generation, index));
        }
        if (DriveSenseJournalControlPlane.enabled(context)) {
            try {
                for (String relative : DriveSenseJournalControlPlane.registeredPaths(context, stem)) {
                    File candidate = new File(directory, relative);
                    String root = directory.getCanonicalPath();
                    if (!candidate.getCanonicalPath().startsWith(root + File.separator)) return false;
                    exact.add(candidate);
                }
            } catch (Exception error) {
                DriveSenseJournalControlPlane.markDirty(context, "UNKNOWN");
                return false;
            }
        }
        boolean found = manifestFile(directory, stem).isFile();
        boolean success = true;
        // Remove the authoritative manifest last. A failed payload unlink can
        // therefore never be reported as a successful ACK.
        File authoritative = manifestFile(directory, stem);
        exact.remove(authoritative);
        for (File file : exact) if (!deleteFile(file)) success = false;
        if (success && !deleteFile(authoritative)) success = false;
        if (success && manifest.optInt("version", 0) == 2) {
            String session = manifest.optString("rsas_session_id", "");
            File adopted = DriveSenseActiveTripSpool.locateJournalSession(context, directory, session);
            adopted.delete();
            File rsasRoot = adopted.getParentFile();
            if (rsasRoot != null) rsasRoot.delete();
        }
        return found && success;
    }

    private static boolean entryExists(File directory, String stem) {
        return readManifest(manifestFile(directory, stem), stem) != null;
    }

    private static boolean deleteFile(File file) {
        return file == null || !file.exists() || file.delete();
    }

    private static void cleanupSupersededChunks(Context context, File directory, String stem, String keepGeneration) {
        if (DriveSenseJournalControlPlane.enabled(context)) {
            try {
                List<String> paths = DriveSenseJournalControlPlane.supersededChunkPaths(context, stem, keepGeneration);
                List<String> removed = new ArrayList<>();
                for (String relative : paths) {
                    File file = new File(directory, relative);
                    String root = directory.getCanonicalPath();
                    if (!file.getCanonicalPath().startsWith(root + File.separator)) throw new SecurityException("JOURNAL_PATH_ESCAPE");
                    if (deleteFile(file)) removed.add(relative);
                }
                DriveSenseJournalControlPlane.removePaths(context, removed);
                return;
            } catch (Exception error) {
                DriveSenseJournalControlPlane.markDirty(context, "UNKNOWN");
                return;
            }
        }
        String keepPrefix = stem + "." + keepGeneration + ".";
        String entryPrefix = stem + ".";
        for (File file : safeFiles(directory)) {
            String name = file.getName();
            if (
                name.startsWith(entryPrefix) &&
                name.endsWith(CHUNK_SUFFIX) &&
                !name.startsWith(keepPrefix)
            ) deleteFile(file);
        }
    }


    private static String sha256File(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[256 * 1024];
        try (InputStream input = new FileInputStream(file)) {
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        } finally {
            java.util.Arrays.fill(buffer, (byte) 0);
        }
        return hex(digest.digest());
    }

    private static final class ManifestEntry {
        final String tripId; final long createdAtMs;
        ManifestEntry(String tripId,long createdAtMs){this.tripId=tripId;this.createdAtMs=createdAtMs;}
    }

    static final class JournalStreamResult {
        final String tripId,sha256;final long plaintextBytes;final int chunkCount,maxPlaintextChunkBytes;
        JournalStreamResult(String tripId,long plaintextBytes,int chunkCount,int maxPlaintextChunkBytes,String sha256){
            this.tripId=tripId;this.plaintextBytes=plaintextBytes;this.chunkCount=chunkCount;
            this.maxPlaintextChunkBytes=maxPlaintextChunkBytes;this.sha256=sha256;
        }
    }

    static final class CompletedStreamDescriptor {
        final String tripId,sha256; final long plaintextBytes; final JSONObject metadata;
        final byte[]overviewBytes; final int overviewPoints; final long sourceDiskBytes;
        CompletedStreamDescriptor(String id,long bytes,String hash,JSONObject meta,byte[]overview,int points,long diskBytes){
            tripId=id;plaintextBytes=bytes;sha256=hash;metadata=meta;overviewBytes=overview;overviewPoints=points;sourceDiskBytes=diskBytes;
        }
    }

    private static volatile Context journalContext;

    private static final class CountingDigestOutput extends OutputStream {
        private final OutputStream delegate;
        private final MessageDigest digest;
        long count;
        CountingDigestOutput(OutputStream delegate, MessageDigest digest) { this.delegate=delegate; this.digest=digest; }
        @Override public void write(int value) throws java.io.IOException { delegate.write(value); digest.update((byte)value); count += 1L; }
        @Override public void write(byte[] value, int offset, int length) throws java.io.IOException { delegate.write(value,offset,length); digest.update(value,offset,length); count += length; }
    }

    private static final class ScanResult {
        final JSONArray trips = new JSONArray();
        int pendingCount = 0;
        int unreadableCount = 0;
        long oldestPendingAtMs = 0L;
        long lastVerifiedSaveAtMs = 0L;
    }
}
