package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;
import static org.junit.Assert.assertTrue;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.util.Arrays;

/**
 * P7-IMPL-F06 — the native half of the mandatory scale campaign, against a
 * **real SQLite database**.
 *
 * The browser half runs in real Chromium IndexedDB (`e2e/p7-scale-campaign`).
 * This is its counterpart on the native authority: the same tiers, the same
 * question, measured where the work actually happens.
 *
 * The measurements are taken outside the implementation:
 *
 *  - `EXPLAIN QUERY PLAN` proves which index answers each P7 query, so a
 *    regression to a full table scan is caught by the plan rather than by a
 *    stopwatch that only looks slow on a big device;
 *  - the observable row work is counted by running the plan's own statement
 *    and reading how many rows SQLite produced;
 *  - the bridge response is measured in items and bytes, which is what the
 *    bridge cap is defined in.
 *
 * Every tier starts from a deleted database, so no page cache carries over.
 * This is the Android **unit** suite; it is not instrumentation and needs no
 * device.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP7ScaleRobolectricTest {

    /** The frozen P7 tiers. 128 is the original failure scale. */
    private static final int[] TIERS = {128, 500, 1_000, 3_000, 5_000};

    /** The page size every tier is measured at. */
    private static final int PAGE = 25;

    private Context context;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x71);
        DriveSenseEnvelopeCrypto.installTestKek(1, key); Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(8L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void p7QueryPathsStayBoundedAcrossEveryMandatedTier() throws Exception {
        long firstTierRowWork = -1L;
        long firstTierVehicleRowWork = -1L;

        for (int count : TIERS) {
            DriveSenseStorageCoordinator.resetForTests();
            context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            populate(repository.coordinator(), count);
            DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

            // ---- Q1: the bounded history page -------------------------------
            JSONObject request = new JSONObject();
            request.put("maxItems", PAGE);
            request.put("maxBytes", 256 * 1024);
            request.put("status", "completed");
            JSONObject page = repository.queryHistoryPage(request);

            assertEquals("tier " + count, PAGE, page.getInt("itemCount"));
            assertTrue("tier " + count, page.getInt("responseBytes") <= 512 * 1024);

            // The status-filtered page must be served by its own index, at
            // every size. A plan that degrades to a scan is the regression
            // this assertion exists to catch.
            String pagePlan = plan(repository.coordinator(),
                "EXPLAIN QUERY PLAN SELECT trip_id FROM trip_current WHERE status=? "
                    + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
                new String[]{"completed"});
            assertTrue("tier " + count + " plan: " + pagePlan,
                pagePlan.contains("trip_current_status_start_idx"));
            assertFalse("tier " + count + " scanned: " + pagePlan, pagePlan.contains("SCAN trip_current"));

            // Observable row work: how many rows SQLite actually produced for
            // the page. It must be the page plus its lookahead, not the tier.
            long rowWork = rowsProduced(repository.coordinator(),
                "SELECT trip_id FROM trip_current WHERE status=? "
                    + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
                new String[]{"completed"});
            assertEquals("tier " + count + " row work", PAGE + 1L, rowWork);
            if (firstTierRowWork < 0) firstTierRowWork = rowWork;
            assertEquals("row work moved with N", firstTierRowWork, rowWork);

            // ---- Q1 with the native vehicle filter --------------------------
            JSONObject vehicleRequest = new JSONObject();
            vehicleRequest.put("maxItems", PAGE);
            vehicleRequest.put("maxBytes", 256 * 1024);
            vehicleRequest.put("status", "completed");
            vehicleRequest.put("vehicleId", "car-a");
            JSONObject vehiclePage = repository.queryHistoryPage(vehicleRequest);
            assertTrue("tier " + count, vehiclePage.getInt("itemCount") <= PAGE);

            String vehiclePlan = plan(repository.coordinator(),
                "EXPLAIN QUERY PLAN SELECT trip_id FROM trip_current WHERE vehicle_id=? AND status=? "
                    + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
                new String[]{"car-a", "completed"});
            assertTrue("tier " + count + " vehicle plan: " + vehiclePlan,
                vehiclePlan.contains("trip_current_vehicle_status_idx"));

            long vehicleRowWork = rowsProduced(repository.coordinator(),
                "SELECT trip_id FROM trip_current WHERE vehicle_id=? AND status=? "
                    + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
                new String[]{"car-a", "completed"});
            assertEquals("tier " + count + " vehicle row work", PAGE + 1L, vehicleRowWork);
            if (firstTierVehicleRowWork < 0) firstTierVehicleRowWork = vehicleRowWork;
            assertEquals("vehicle row work moved with N", firstTierVehicleRowWork, vehicleRowWork);

            // ---- Q4/Q5: the aggregate owners --------------------------------
            // The bucket table answers a day-bounded, status-filtered question
            // from its own index — it never visits a trip row.
            String bucketPlan = plan(repository.coordinator(),
                "EXPLAIN QUERY PLAN SELECT SUM(trip_count),SUM(total_distance),SUM(total_duration) "
                    + "FROM trip_aggregate_buckets WHERE day_start_ms>=? AND day_start_ms<=? AND status=?",
                new String[]{"0", String.valueOf(Long.MAX_VALUE), "completed"});
            assertTrue("tier " + count + " bucket plan: " + bucketPlan,
                bucketPlan.contains("trip_aggregate_bucket_range_idx"));
            assertFalse("tier " + count + " bucket scan: " + bucketPlan,
                bucketPlan.contains("SCAN trip_current"));

            // The aggregate read is a single-row lookup whatever the tier is.
            long totalsRowWork = rowsProduced(repository.coordinator(),
                "SELECT live_count,total_distance,total_duration FROM trip_aggregate_totals WHERE id=1",
                null);
            assertEquals("tier " + count + " totals row work", 1L, totalsRowWork);
        }
    }

    @Test public void theNativeCurveIsFlatFromTheFailureScaleToFiveThousand() throws Exception {
        long small = pageRowWorkAt(128);
        long large = pageRowWorkAt(5_000);

        // Forty times the retained history, the same question, measured in
        // rows SQLite actually produced. This is the growth law on the native
        // authority, and it is the same law the browser half proves.
        assertEquals("native page cost moved with retained history", small, large);
        assertEquals(PAGE + 1L, large);
    }

    /**
     * P7-IMPL-F06 - the routes the JavaScript facade actually takes.
     *
     * The tier sweep above proves the storage engine with statements copied
     * beside the repository. Codex's objection was that a copy cannot detect a
     * facade routed somewhere else - and Q4 was: it called `aggregates`, which
     * runs `SUM(...) FROM trip_current` over the window, while the frozen annex
     * names `trip_aggregate_buckets` as its owner.
     *
     * These two tests call the repository methods the corrected facade calls,
     * with the arguments it sends, over a small and a large retained history.
     */
    @Test public void q4ReadsTheBucketOwnerAndItsCostIsTheWindowNotTheHistory() throws Exception {
        long[] bucketRows = new long[2];
        double[] distance = new double[2];
        int[] tiers = {128, 5_000};

        for (int slot = 0; slot < tiers.length; slot++) {
            DriveSenseStorageCoordinator.resetForTests();
            context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            populate(repository.coordinator(), tiers[slot]);
            DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

            // The same 30-day window at both tiers, and the `maxBuckets`
            // argument the corrected facade sends - not `limit`, which this
            // method never read.
            long from = (1_700_000_000_000L / 86_400_000L) * 86_400_000L;
            long to = from + 29L * 86_400_000L;
            JSONObject request = new JSONObject();
            request.put("fromMs", from);
            request.put("toMs", to);
            request.put("granularity", "day");
            request.put("status", "completed");
            request.put("maxBuckets", 30);

            JSONObject buckets = repository.chartBuckets(request);
            org.json.JSONArray items = buckets.getJSONArray("items");
            assertTrue("tier " + tiers[slot] + " buckets", items.length() > 0);
            assertTrue("tier " + tiers[slot] + " bucket cap", items.length() <= 30);

            double km = 0d;
            long trips = 0L;
            for (int index = 0; index < items.length(); index++) {
                km += items.getJSONObject(index).getDouble("totalDistance");
                trips += items.getJSONObject(index).getLong("tripCount");
            }
            distance[slot] = km;

            // The plan of the statement the repository itself runs.
            String bucketPlan = plan(repository.coordinator(),
                "EXPLAIN QUERY PLAN SELECT day_start_ms AS bucket_start,SUM(trip_count),SUM(total_distance),"
                    + "SUM(total_duration),SUM(score_sum),SUM(score_count),MAX(through_seq) "
                    + "FROM trip_aggregate_buckets WHERE day_start_ms>=? AND day_start_ms<=? AND status=? "
                    + "GROUP BY bucket_start ORDER BY bucket_start LIMIT ?",
                new String[]{String.valueOf(from), String.valueOf(to), "completed", "30"});
            assertFalse("tier " + tiers[slot] + " Q4 touched trip_current: " + bucketPlan,
                bucketPlan.contains("trip_current"));

            bucketRows[slot] = rowsProduced(repository.coordinator(),
                "SELECT day_start_ms FROM trip_aggregate_buckets "
                    + "WHERE day_start_ms>=? AND day_start_ms<=? AND status=?",
                new String[]{String.valueOf(from), String.valueOf(to), "completed"});
            assertTrue("tier " + tiers[slot] + " bucket row work", bucketRows[slot] > 0L);
            assertTrue("tier " + tiers[slot] + " trips in window", trips > 0L);
        }

        // Forty times the retained history, the same window: the same rows.
        assertEquals("Q4 bucket row work moved with retained history", bucketRows[0], bucketRows[1]);
        assertEquals("Q4 answer moved with retained history", distance[0], distance[1], 1e-9);
    }

    @Test public void q1BindsTheDateRangeIntoSqlAndIntoTheCursor() throws Exception {
        long[] rowWork = new long[2];
        int[] tiers = {128, 5_000};
        long from = (1_700_000_000_000L / 86_400_000L) * 86_400_000L;
        long to = from + 20L * 86_400_000L;

        for (int slot = 0; slot < tiers.length; slot++) {
            DriveSenseStorageCoordinator.resetForTests();
            context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            populate(repository.coordinator(), tiers[slot]);
            DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

            JSONObject request = new JSONObject();
            request.put("maxItems", PAGE);
            request.put("maxBytes", 256 * 1024);
            request.put("status", "completed");
            request.put("fromMs", from);
            request.put("toMs", to);

            JSONObject page = repository.queryHistoryPage(request);
            org.json.JSONArray items = page.getJSONArray("items");
            assertTrue("tier " + tiers[slot] + " range page", items.length() > 0);
            for (int index = 0; index < items.length(); index++) {
                long at = items.getJSONObject(index).getLong("start_time_ms");
                // Half-open [from, to), as Annex C requires on both authorities.
                assertTrue("row before range", at >= from);
                assertTrue("row at or after range end", at < to);
            }

            rowWork[slot] = rowsProduced(repository.coordinator(),
                "SELECT trip_id FROM trip_current WHERE status=? AND start_time_ms>=? AND start_time_ms<? "
                    + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
                new String[]{"completed", String.valueOf(from), String.valueOf(to)});

            // A continuation minted for this window must not be answerable
            // under another one: the range is part of the cursor identity.
            if (!page.isNull("nextCursor")) {
                JSONObject crossed = new JSONObject();
                crossed.put("maxItems", PAGE);
                crossed.put("maxBytes", 256 * 1024);
                crossed.put("status", "completed");
                crossed.put("fromMs", from + 86_400_000L);
                crossed.put("toMs", to);
                crossed.put("cursor", page.getString("nextCursor"));
                try {
                    repository.queryHistoryPage(crossed);
                    fail("a cursor was answered under a different date window");
                } catch (IllegalArgumentException expected) {
                    assertEquals("CURSOR_QUERY_MISMATCH", expected.getMessage());
                }
            }
        }

        assertEquals("ranged page cost moved with retained history", rowWork[0], rowWork[1]);
    }

    /**
     * P7-IMPL-F05 - Q1 page snapshot atomicity, driven deterministically.
     *
     * The defect: `queryHistoryPage` captured the generation, selected its rows
     * inside one `coordinator.read`, released that read, enriched each row
     * through further independent reads, and only then read
     * `last_committed_seq`. `DriveSenseStorageCoordinator.write` takes the SAME
     * read lock as `read` (only `exclusive` takes the write lock), so an
     * ordinary commit may legally land in that window. A page selected at S
     * could therefore be published stamped S+1, and a continuation minted from
     * it would let a later turn resume against a source state page one never
     * saw.
     *
     * There is no sleep and no race here. `setPageAssemblySeamForTests` runs the
     * commit on the Q1 thread at exactly the seam after row selection, so the
     * dangerous ordering is forced, not hoped for.
     */
    @Test public void q1RefusesToPublishAPageAssembledAcrossTwoCommittedStates() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        populate(repository.coordinator(), 200);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

        long before = seqOf(repository);

        // --- the pre-fix hazard, demonstrated with production reads -----------
        // Drive the same interleaving and observe, at the exact moment the
        // delivered code read the committed sequence, that it had already moved
        // past the state the rows were selected from. That value is what the old
        // response stamped onto the page and into its continuation.
        long[] sequenceSeenWhereTheOldCodeReadIt = new long[]{-1L};
        DriveSenseTripArchiveRepository.setPageAssemblySeamForTests(() -> {
            commitOneOrdinaryTrip(repository, "interleaved-a", 1_900_000_000_000L);
            try {
                sequenceSeenWhereTheOldCodeReadIt[0] = seqOf(repository);
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        });

        JSONObject request = new JSONObject();
        request.put("maxItems", PAGE);
        request.put("maxBytes", 256 * 1024);
        request.put("status", "completed");

        try {
            repository.queryHistoryPage(request);
            fail("a page assembled across two committed states was published");
        } catch (IllegalStateException expected) {
            // --- the corrected behaviour: detect and refuse, publishing nothing
            assertEquals("SNAPSHOT_MOVED_DURING_PAGE", expected.getMessage());
        }

        // The hazard was real: the sequence the old code would have stamped is
        // strictly newer than the state the rows came from.
        assertTrue("the interleaved commit did not advance the sequence",
            sequenceSeenWhereTheOldCodeReadIt[0] > before);
        assertEquals("the seam did not run at the intended moment",
            before + 1L, sequenceSeenWhereTheOldCodeReadIt[0]);

        // --- restart produces a coherent page at the NEW state ---------------
        // The refusal is not a dead end: with no further movement the retry
        // succeeds, and its identity matches the state its rows came from.
        long after = seqOf(repository);
        JSONObject restarted = repository.queryHistoryPage(request);
        assertEquals("restart did not describe one stable state",
            after, restarted.getLong("canonicalSeq"));
        assertEquals(PAGE, restarted.getInt("itemCount"));
        assertFalse("restart minted no continuation", restarted.isNull("nextCursor"));

        // --- and the continuation cannot span a commit either -----------------
        // A second turn interleaved the same way is refused, so no page two can
        // silently carry rows from a state page one never saw.
        String continuation = restarted.getString("nextCursor");
        DriveSenseTripArchiveRepository.setPageAssemblySeamForTests(
            () -> commitOneOrdinaryTrip(repository, "interleaved-b", 1_900_000_100_000L));
        JSONObject second = new JSONObject();
        second.put("maxItems", PAGE);
        second.put("maxBytes", 256 * 1024);
        second.put("status", "completed");
        second.put("cursor", continuation);
        try {
            repository.queryHistoryPage(second);
            fail("a continuation was resumed across two committed states");
        } catch (IllegalStateException expected) {
            assertEquals("SNAPSHOT_MOVED_DURING_PAGE", expected.getMessage());
        }
    }

    /**
     * The undisturbed path is unchanged: one stable state in, one stable state
     * out, and the stamped identity is the one the rows were selected under.
     */
    @Test public void q1StampsThePageWithTheStateItsRowsWereSelectedUnder() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        populate(repository.coordinator(), 200);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

        long stable = seqOf(repository);
        JSONObject request = new JSONObject();
        request.put("maxItems", PAGE);
        request.put("maxBytes", 256 * 1024);
        request.put("status", "completed");

        JSONObject first = repository.queryHistoryPage(request);
        assertEquals(stable, first.getLong("canonicalSeq"));
        assertEquals(PAGE, first.getInt("itemCount"));

        // Paging with no interleaving still reaches EOF with no duplicate.
        java.util.Set<String> seen = new java.util.HashSet<>();
        JSONObject page = first;
        int turns = 0;
        while (turns++ < 40) {
            org.json.JSONArray items = page.getJSONArray("items");
            for (int index = 0; index < items.length(); index++) {
                assertTrue("duplicate row across pages", seen.add(items.getJSONObject(index).getString("id")));
            }
            assertEquals("page identity moved without a commit", stable, page.getLong("canonicalSeq"));
            if (page.isNull("nextCursor")) break;
            JSONObject next = new JSONObject();
            next.put("maxItems", PAGE);
            next.put("maxBytes", 256 * 1024);
            next.put("status", "completed");
            next.put("cursor", page.getString("nextCursor"));
            page = repository.queryHistoryPage(next);
        }
        assertTrue("paging did not reach EOF", page.isNull("nextCursor"));
        assertTrue("too few rows paged", seen.size() > PAGE);
    }

    /**
     * P7-IMPL-F05 - Q7's identity is captured in the statement that selects its
     * rows, so it needs no refusal and can have none.
     *
     * The withdrawn `publishesSnapshot:false` opt-out suppressed verification
     * while the JavaScript facade still published a generic snapshot, so Q7
     * could return data selected at S+1 under an envelope claiming S. Q7 cannot
     * borrow Q1's refusal either: Annex A SS A1.4 gives Q7 storage/authority
     * codes only.
     *
     * `tagContextPage` drives its SELECT from `archive_meta` with a LEFT JOIN,
     * so one SQLite statement - one committed snapshot - yields both the rows
     * and the identity. A commit at the page-assembly seam therefore cannot
     * split them, and the answer stays a one-state capped EXACT result.
     */
    @Test public void q7CapturesItsIdentityInTheStatementThatSelectsItsRows() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        populate(repository.coordinator(), 60);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

        long before = seqOf(repository);
        JSONObject tagContext = repository.tagContextPage(12, 256 * 1024);

        assertEquals(12, tagContext.getInt("itemCount"));
        // The identity travels with the rows, and it is the state they came from.
        assertEquals(before, tagContext.getLong("canonicalSeq"));
        assertFalse("Q7 published no generation", tagContext.isNull("archiveGeneration"));

        // A commit afterwards does not retroactively change what that answer said.
        commitOneOrdinaryTrip(repository, "q7-after", 1_900_000_400_000L);
        assertEquals(before, tagContext.getLong("canonicalSeq"));
        assertEquals(before + 1L, seqOf(repository));

        // The next call reports the new state, still atomically with its rows.
        JSONObject next = repository.tagContextPage(12, 256 * 1024);
        assertEquals(before + 1L, next.getLong("canonicalSeq"));
        assertEquals(12, next.getInt("itemCount"));
    }

    /**
     * The identity comes back even when the capped selection matches nothing -
     * `archive_meta` is the driving side of the join, so the no-match row still
     * carries it. An empty answer still has to say which state it was empty at.
     */
    @Test public void q7ReportsAnIdentityForAnEmptyTagContext() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

        JSONObject tagContext = repository.tagContextPage(12, 256 * 1024);
        assertEquals(0, tagContext.getInt("itemCount"));
        assertFalse("an empty Q7 published no generation", tagContext.isNull("archiveGeneration"));
        assertEquals(seqOf(repository), tagContext.getLong("canonicalSeq"));
    }

    /**
     * Withdrawing the opt-out restores Q1's guard to unconditional, which is the
     * shape Codex accepted.
     */
    @Test public void q1SnapshotGuardIsUnconditional() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        populate(repository.coordinator(), 200);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

        DriveSenseTripArchiveRepository.setPageAssemblySeamForTests(
            () -> commitOneOrdinaryTrip(repository, "unconditional", 1_900_000_500_000L));
        JSONObject request = new JSONObject();
        request.put("maxItems", PAGE);
        request.put("maxBytes", 256 * 1024);
        request.put("status", "completed");
        // The old flag is gone, so no request shape can switch the guard off.
        request.put("publishesSnapshot", false);
        try {
            repository.queryHistoryPage(request);
            fail("a request flag disabled the snapshot guard");
        } catch (IllegalStateException expected) {
            assertEquals("SNAPSHOT_MOVED_DURING_PAGE", expected.getMessage());
        }
    }

    /** The archive's committed sequence, read the way production reads it. */
    private static long seqOf(DriveSenseTripArchiveRepository repository) throws Exception {
        return repository.coordinator().read(
            db -> DriveSenseArchiveIntegrity.readMetaLong(db, "last_committed_seq"));
    }

    /**
     * One ordinary commit, advancing `last_committed_seq` in the same
     * transaction as the row it publishes - exactly as `commitCatalog` does.
     */
    private static void commitOneOrdinaryTrip(DriveSenseTripArchiveRepository repository,
        String tripId, long startMs) {
        try {
            repository.coordinator().write(db -> {
                db.beginTransaction();
                try {
                    // `populate` fabricates revision sequences without writing
                    // `archive_events`, so the event table's AUTOINCREMENT still
                    // starts at 1 while the fixture's meta already reads N. Align
                    // them once, so the commit below advances the sequence the way
                    // a real commit does instead of moving it backwards.
                    long meta = DriveSenseArchiveIntegrity.readMetaLong(db, "last_committed_seq");
                    db.execSQL("INSERT INTO sqlite_sequence(name,seq) SELECT 'archive_events',?"
                        + " WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='archive_events')",
                        new Object[]{meta});
                    db.execSQL("UPDATE sqlite_sequence SET seq=? WHERE name='archive_events' AND seq<?",
                        new Object[]{meta, meta});
                    byte[] hash = new byte[32];
                    long seq = DriveSenseArchiveIntegrity.appendEventInTransaction(db, "COMMIT",
                        tripId, 1, null, hash, hash, "canonical_commit", "interleaving_test",
                        null, null, null, System.currentTimeMillis());
                    // `trip_current` references `trip_revisions`, so the revision
                    // row is published first, exactly as `commitCatalog` does.
                    ContentValues revision = new ContentValues();
                    revision.put("trip_id", tripId); revision.put("revision", 1);
                    revision.put("operation_id", "interleave-" + tripId);
                    revision.put("commit_state", "COMMITTED"); revision.put("seq", seq);
                    revision.put("start_time_ms", startMs);
                    revision.put("end_time_ms", startMs + 900_000L);
                    revision.put("status", "completed"); revision.put("point_count", 2);
                    revision.put("distance", 5d); revision.put("duration", 900d);
                    revision.put("score", 80d); revision.put("needs_rescore", 0);
                    revision.put("plaintext_bytes", 1); revision.put("ciphertext_bytes", 1);
                    revision.put("payload_hash", hash); revision.put("metadata_hash", hash);
                    revision.put("chunk_count", 1);
                    revision.put("wrapped_dek", new byte[48]); revision.put("wrap_nonce", new byte[12]);
                    revision.put("wrap_algorithm_version", 1); revision.put("kek_version", 1);
                    revision.put("schema_version", 1); revision.put("committed_at_ms", startMs);
                    db.insertOrThrow("trip_revisions", null, revision);
                    ContentValues current = new ContentValues();
                    current.put("trip_id", tripId); current.put("revision", 1);
                    current.put("seq", seq); current.put("last_mutation_seq", seq);
                    current.put("start_time_ms", startMs);
                    current.put("end_time_ms", startMs + 900_000L);
                    current.put("status", "completed"); current.put("point_count", 2);
                    current.put("distance", 5d); current.put("duration", 900d); current.put("score", 80d);
                    current.put("needs_rescore", 0); current.put("payload_available", 1);
                    current.put("overview_available", 0); current.put("vehicle_id", "car-a");
                    db.insertWithOnConflict("trip_current", null, current, SQLiteDatabase.CONFLICT_REPLACE);
                    db.execSQL("UPDATE archive_meta SET live_count=live_count+1 WHERE id=1");
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                return null;
            });
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    private long pageRowWorkAt(int count) throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        populate(repository.coordinator(), count);
        DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());
        return rowsProduced(repository.coordinator(),
            "SELECT trip_id FROM trip_current WHERE status=? "
                + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT " + (PAGE + 1),
            new String[]{"completed"});
    }

    /** The flattened `EXPLAIN QUERY PLAN` detail for one statement. */
    private static String plan(DriveSenseStorageCoordinator coordinator, String sql, String[] args)
        throws Exception {
        return coordinator.read(db -> {
            StringBuilder detail = new StringBuilder();
            try (Cursor cursor = db.rawQuery(sql, args)) {
                while (cursor.moveToNext()) detail.append(cursor.getString(3)).append(' ');
            }
            return detail.toString();
        });
    }

    /** How many rows SQLite actually produced — the observable row work. */
    private static long rowsProduced(DriveSenseStorageCoordinator coordinator, String sql, String[] args)
        throws Exception {
        return coordinator.read(db -> {
            long rows = 0L;
            try (Cursor cursor = db.rawQuery(sql, args)) {
                while (cursor.moveToNext()) rows += 1L;
            }
            return rows;
        });
    }

    private static void populate(DriveSenseStorageCoordinator coordinator, int count) throws Exception {
        coordinator.write(db -> {
            db.beginTransaction();
            try {
                byte[] hash = new byte[32];
                byte[] wrapped = new byte[48];
                byte[] nonce = new byte[12];
                for (int index = 0; index < count; index++) {
                    // Ids run opposite to chronology, so an answer ordered by
                    // the primary key rather than by the requested sort would
                    // be visibly wrong rather than coincidentally right.
                    String id = String.format("p7-%06d", count - index);
                    long start = 1_700_000_000_000L + index * 86_400_000L;
                    String status = index % 23 == 0 ? "draft" : "completed";
                    String vehicle = index % 2 == 0 ? "car-a" : "car-b";

                    ContentValues revision = new ContentValues();
                    revision.put("trip_id", id); revision.put("revision", 1);
                    revision.put("operation_id", "p7-fixture-" + index);
                    revision.put("commit_state", "COMMITTED"); revision.put("seq", index + 2L);
                    revision.put("start_time_ms", start); revision.put("end_time_ms", start + 900_000L);
                    revision.put("status", status); revision.put("point_count", 2);
                    revision.put("distance", 5d); revision.put("duration", 900d); revision.put("score", 80d);
                    revision.put("needs_rescore", 0); revision.put("plaintext_bytes", 1);
                    revision.put("ciphertext_bytes", 1); revision.put("payload_hash", hash);
                    revision.put("metadata_hash", hash); revision.put("chunk_count", 1);
                    revision.put("wrapped_dek", wrapped); revision.put("wrap_nonce", nonce);
                    revision.put("wrap_algorithm_version", 1); revision.put("kek_version", 1);
                    revision.put("schema_version", 1); revision.put("committed_at_ms", start);
                    db.insertOrThrow("trip_revisions", null, revision);

                    ContentValues current = new ContentValues();
                    current.put("trip_id", id); current.put("revision", 1); current.put("seq", index + 2L);
                    current.put("last_mutation_seq", index + 2L);
                    current.put("start_time_ms", start); current.put("end_time_ms", start + 900_000L);
                    current.put("status", status); current.put("point_count", 2);
                    current.put("distance", 5d); current.put("duration", 900d); current.put("score", 80d);
                    current.put("needs_rescore", 0); current.put("payload_available", 1);
                    current.put("overview_available", 0); current.put("vehicle_id", vehicle);
                    db.insertOrThrow("trip_current", null, current);

                    long day = (start / 86_400_000L) * 86_400_000L;
                    db.execSQL("INSERT INTO trip_aggregate_buckets"
                        + "(day_start_ms,vehicle_id,status,trip_count,total_distance,total_duration,score_sum,score_count,through_seq) "
                        + "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(day_start_ms,vehicle_id,status) DO UPDATE SET "
                        + "trip_count=trip_count+excluded.trip_count,total_distance=total_distance+excluded.total_distance,"
                        + "total_duration=total_duration+excluded.total_duration,score_sum=score_sum+excluded.score_sum,"
                        + "score_count=score_count+excluded.score_count,through_seq=excluded.through_seq",
                        new Object[]{day, vehicle, status, 1, 5d, 900d, 80d, 1, index + 2L});
                }
                db.execSQL("UPDATE archive_meta SET live_count=?,last_committed_seq=?,updated_at_ms=? WHERE id=1",
                    new Object[]{count, count + 1L, System.currentTimeMillis()});
                db.execSQL("UPDATE trip_aggregate_totals SET live_count=?,total_distance=?,total_duration=?,"
                    + "score_sum=?,score_count=?,through_seq=? WHERE id=1",
                    new Object[]{count, count * 5d, count * 900d, count * 80d, count, count + 1L});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return null;
        });
    }
}
