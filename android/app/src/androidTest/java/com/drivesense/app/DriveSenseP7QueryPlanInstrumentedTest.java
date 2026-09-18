package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * P7 Stage 2 — the native query-plan evidence.
 *
 * The growth law is not satisfied by a bounded-looking API: it has to hold at
 * the SQL level. These tests read SQLite's own plan for the two shapes P7
 * touches on the native authority, so a future change that turns a seek into a
 * table scan fails here rather than at 5,000 trips on a device.
 *
 * The `vehicleId` filter P7 adds to `queryHistoryPage` is a parameter over the
 * already-existing `trip_current_vehicle_status_idx(vehicle_id, status,
 * start_time_ms DESC, trip_id DESC)`. It requires no schema change, and it
 * licenses no trip-count-proportional aggregate: Annex C C6 keeps the filtered
 * `trip_current` COUNT/SUM forbidden as a bounded Q4 implementation.
 */
@RunWith(AndroidJUnit4.class)
public class DriveSenseP7QueryPlanInstrumentedTest {
    private DriveSenseTripArchiveRepository repository;

    @Before
    public void setUp() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        repository = new DriveSenseTripArchiveRepository(context);
    }

    /** Every line SQLite reports for a statement's plan, lower-cased. */
    private List<String> queryPlan(final String sql, final String[] args) throws Exception {
        return repository.coordinator().read(db -> {
            List<String> plan = new ArrayList<>();
            try (Cursor c = db.rawQuery("EXPLAIN QUERY PLAN " + sql, args)) {
                while (c.moveToNext()) {
                    StringBuilder line = new StringBuilder();
                    for (int column = 0; column < c.getColumnCount(); column += 1) {
                        line.append(c.getString(column)).append(' ');
                    }
                    plan.add(line.toString().toLowerCase(Locale.US));
                }
            }
            return plan;
        });
    }

    private static boolean anyLineContains(List<String> plan, String needle) {
        for (String line : plan) {
            if (line.contains(needle)) return true;
        }
        return false;
    }

    @Test
    public void vehicleFilteredHistoryPageIsIndexServed() throws Exception {
        // Exactly the statement `queryHistoryPage` builds for a vehicle-filtered,
        // cursor-positioned page.
        String sql = "SELECT trip_id,start_time_ms FROM trip_current "
                + "WHERE 1=1 AND vehicle_id=? AND status=? "
                + "AND (start_time_ms < ? OR (start_time_ms=? AND trip_id < ?)) "
                + "ORDER BY start_time_ms DESC,trip_id DESC LIMIT ?";
        List<String> plan = queryPlan(sql, new String[]{"veh-1", "completed", "0", "0", "", "51"});

        assertFalse("query plan was empty", plan.isEmpty());
        // The leading column of trip_current_vehicle_status_idx is vehicle_id, so
        // a vehicle-filtered page is a seek on that index.
        assertTrue("vehicle-filtered history page must use an index: " + plan,
                anyLineContains(plan, "using index") || anyLineContains(plan, "using covering index"));
        // A full table scan here would make a fixed page request proportional to
        // retained history, which is the defect P7 exists to remove.
        assertFalse("vehicle-filtered history page must not scan trip_current: " + plan,
                anyLineContains(plan, "scan trip_current") && !anyLineContains(plan, "using index"));
    }

    @Test
    public void unfilteredHistoryPageKeepsItsExistingPlan() throws Exception {
        String sql = "SELECT trip_id,start_time_ms FROM trip_current "
                + "WHERE 1=1 ORDER BY start_time_ms DESC,trip_id DESC LIMIT ?";
        List<String> plan = queryPlan(sql, new String[]{"51"});

        assertFalse("query plan was empty", plan.isEmpty());
        // Adding the parameter must not change the plan of a page that does not
        // use it: an unfiltered request is still ordered by the existing index.
        assertTrue("unfiltered history page must still be index-ordered: " + plan,
                anyLineContains(plan, "using index"));
    }

    @Test
    public void chartBucketRangeIsBucketBounded() throws Exception {
        // Annex C C6: a filtered or ranged native aggregate must read the
        // pre-aggregated bucket rows, whose count is bounded by the requested
        // range, rather than COUNT/SUM over trip_current.
        String sql = "SELECT day_start_ms,SUM(trip_count) FROM trip_aggregate_buckets "
                + "WHERE day_start_ms>=? AND day_start_ms<? AND status=? "
                + "GROUP BY day_start_ms ORDER BY day_start_ms LIMIT ?";
        List<String> plan = queryPlan(sql, new String[]{"0", "1", "completed", "31"});

        assertFalse("query plan was empty", plan.isEmpty());
        assertTrue("bucket range must be index-served: " + plan,
                anyLineContains(plan, "using index") || anyLineContains(plan, "using covering index"));
        assertFalse("a bucket range must never read trip_current: " + plan,
                anyLineContains(plan, "trip_current"));
    }

    @Test
    public void vehicleFilterIsBoundIntoTheCursorIdentity() throws Exception {
        // A cursor minted for one vehicle must not be accepted for another, or a
        // page would silently mix two row sets.
        JSONObject first = new JSONObject();
        first.put("maxItems", 1);
        first.put("vehicleId", "veh-1");
        JSONObject page = repository.queryHistoryPage(first);
        assertNotNull(page);

        Object cursor = page.opt("nextCursor");
        if (cursor == null || cursor == JSONObject.NULL) return; // no second page to test with

        JSONObject crossed = new JSONObject();
        crossed.put("maxItems", 1);
        crossed.put("vehicleId", "veh-2");
        crossed.put("cursor", cursor);
        try {
            repository.queryHistoryPage(crossed);
            throw new AssertionError("a cursor bound to one vehicle was accepted for another");
        } catch (IllegalArgumentException expected) {
            assertEquals("CURSOR_QUERY_MISMATCH", expected.getMessage());
        }
    }

    @Test
    public void historyPageStaysWithinItsDeclaredItemBound() throws Exception {
        JSONObject request = new JSONObject();
        request.put("maxItems", 5);
        JSONObject page = repository.queryHistoryPage(request);

        JSONArray items = page.optJSONArray("items");
        assertNotNull(items);
        // One row past the page proves `hasMore` without returning it.
        assertTrue("page returned more than its declared bound", items.length() <= 5);
    }
}
