package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35ScaleRobolectricTest {
    private Context context;

    @Before public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x62);
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

    @Test public void nativeQueriesRemainIndexPageAndCounterBoundedThroughTenThousandTrips() throws Exception {
        int[] samples = {0, 1, 100, 500, 1_000, 10_000};
        long largestFirstPageMs = 0L;
        for (int count : samples) {
            DriveSenseStorageCoordinator.resetForTests();
            context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
            populate(repository.coordinator(), count);
            DriveSenseArchiveSentinelStore.writeFromCatalog(repository.coordinator());

            JSONObject request = new JSONObject(); request.put("maxItems", 50); request.put("maxBytes", 256 * 1024);
            long started = System.nanoTime();
            JSONObject first = repository.queryHistoryPage(request);
            long firstPageMs = (System.nanoTime() - started) / 1_000_000L;
            largestFirstPageMs = Math.max(largestFirstPageMs, firstPageMs);
            assertEquals(Math.min(50, count), first.getInt("itemCount"));
            assertTrue(first.getInt("responseBytes") <= 512 * 1024);
            if (count > 50) {
                request.put("cursor", first.getString("nextCursor"));
                JSONObject next = repository.queryHistoryPage(request);
                assertEquals(50, next.getInt("itemCount"));
            }
            if (count > 0) assertNotNull(repository.getMetadata("scale-" + (count - 1)));
            assertEquals(count, repository.aggregates(new JSONObject()).getLong("liveCount"));
            JSONObject health = DriveSenseArchiveHealth.inventory(repository.coordinator());
            assertTrue(health.getBoolean("sentinelMatches"));

            repository.coordinator().read(db -> {
                try (Cursor plan = db.rawQuery(
                    "EXPLAIN QUERY PLAN SELECT trip_id FROM trip_current ORDER BY start_time_ms DESC,trip_id DESC LIMIT 51",
                    null)) {
                    StringBuilder detail = new StringBuilder();
                    while (plan.moveToNext()) detail.append(plan.getString(3));
                    assertTrue(detail.toString(), detail.toString().contains("trip_current_start_idx"));
                }
                return null;
            });
        }
        // A broad regression guard only; index-plan assertions carry the scaling proof.
        assertTrue("first-page latency exceeded fixed local budget: " + largestFirstPageMs,
            largestFirstPageMs < 5_000L);
    }

    @Test public void localSpeedMetadataWorkIsIndependentOfUnrelatedGeography() throws Exception {
        int[] samples = {0, 1, 100, 500, 1_000, 10_000};
        for (int count : samples) {
            DriveSenseStorageCoordinator.resetForTests(); context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
            DriveSenseSpeedArchiveRepository repository = new DriveSenseSpeedArchiveRepository(context);
            DriveSenseStorageCoordinator speedCoordinator = DriveSenseStorageCoordinator.get(context);
            populateSpeed(speedCoordinator, count);
            JSONArray requested = new JSONArray();
            if (count > 0) requested.put(speedId(count - 1));
            JSONObject metadata = count > 0 ? repository.metadata(requested) : repository.page("", 2);
            assertEquals(count > 0 ? 1 : 0, metadata.getInt("itemCount"));
            JSONObject first = repository.page("", 2);
            assertEquals(Math.min(2, count), first.getInt("itemCount"));
            speedCoordinator.read(db -> {
                try (Cursor plan = db.rawQuery("EXPLAIN QUERY PLAN SELECT bucket_id FROM speed_current WHERE bucket_id IN (?)", new String[]{count > 0 ? speedId(count - 1) : "0000"})) {
                    StringBuilder detail = new StringBuilder(); while (plan.moveToNext()) detail.append(plan.getString(3));
                    assertTrue(detail.toString(), detail.toString().contains("sqlite_autoindex_speed_current_1"));
                }
                return null;
            });
        }
    }

    private static void populate(DriveSenseStorageCoordinator coordinator, int count) throws Exception {
        coordinator.write(db -> {
            db.beginTransaction();
            try {
                byte[] hash = new byte[32];
                byte[] wrapped = new byte[48];
                byte[] nonce = new byte[12];
                for (int index = 0; index < count; index++) {
                    String id = "scale-" + index;
                    long start = 1_700_000_000_000L + index * 60_000L;
                    ContentValues revision = new ContentValues();
                    revision.put("trip_id", id); revision.put("revision", 1); revision.put("operation_id", "fixture-" + index);
                    revision.put("commit_state", "COMMITTED"); revision.put("seq", index + 2L);
                    revision.put("start_time_ms", start); revision.put("end_time_ms", start + 30_000L);
                    revision.put("status", "completed"); revision.put("point_count", 2);
                    revision.put("distance", 1d); revision.put("duration", 30d); revision.put("score", 90d);
                    revision.put("needs_rescore", 0); revision.put("plaintext_bytes", 1); revision.put("ciphertext_bytes", 1);
                    revision.put("payload_hash", hash); revision.put("metadata_hash", hash); revision.put("chunk_count", 1);
                    revision.put("wrapped_dek", wrapped); revision.put("wrap_nonce", nonce); revision.put("wrap_algorithm_version", 1);
                    revision.put("kek_version", 1); revision.put("schema_version", 1); revision.put("committed_at_ms", start);
                    db.insertOrThrow("trip_revisions", null, revision);
                    ContentValues current = new ContentValues();
                    current.put("trip_id", id); current.put("revision", 1); current.put("seq", index + 2L);
                    current.put("last_mutation_seq", index + 2L); current.put("start_time_ms", start); current.put("end_time_ms", start + 30_000L);
                    current.put("status", "completed"); current.put("point_count", 2); current.put("distance", 1d);
                    current.put("duration", 30d); current.put("score", 90d); current.put("needs_rescore", 0);
                    current.put("payload_available", 1); current.put("overview_available", 0);
                    db.insertOrThrow("trip_current", null, current);
                }
                db.execSQL("UPDATE archive_meta SET live_count=?,last_committed_seq=?,updated_at_ms=? WHERE id=1",
                    new Object[]{count, count + 1L, System.currentTimeMillis()});
                db.execSQL("UPDATE trip_aggregate_totals SET live_count=?,total_distance=?,total_duration=?,score_sum=?,score_count=?,through_seq=? WHERE id=1",
                    new Object[]{count, (double) count, count * 30d, count * 90d, count, count + 1L});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return null;
        });
    }

    private static void populateSpeed(DriveSenseStorageCoordinator coordinator,int count)throws Exception{
        coordinator.write(db->{db.beginTransaction();try{String generation;try(Cursor c=db.rawQuery("SELECT speed_generation FROM speed_state WHERE id=1",null)){c.moveToFirst();generation=c.getString(0);}byte[]hash=new byte[32];for(int index=0;index<count;index++){String id=speedId(index);ContentValues bucket=new ContentValues();bucket.put("bucket_id",id);bucket.put("speed_generation",generation);bucket.put("revision",1);bucket.put("operation_id","speed-scale");bucket.put("commit_state","COMMITTED");bucket.put("cell_count",1);bucket.put("payload_bytes",1);bucket.put("payload_hash",hash);bucket.put("chunk_count",1);bucket.put("wrapped_dek",new byte[48]);bucket.put("wrap_nonce",new byte[12]);bucket.put("kek_version",1);bucket.put("updated_seq",index+1L);bucket.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("speed_buckets",null,bucket);ContentValues current=new ContentValues();current.put("bucket_id",id);current.put("speed_generation",generation);current.put("revision",1);current.put("updated_seq",index+1L);current.put("cell_count",1);current.put("payload_bytes",1);current.put("payload_hash",hash);current.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("speed_current",null,current);}db.execSQL("UPDATE speed_state SET bucket_count=?,last_seq=? WHERE id=1",new Object[]{count,count});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
    }
    private static String speedId(int value){String alphabet="0123456789bcdefghjkmnpqrstuvwxyz";char[]out=new char[4];for(int i=3;i>=0;i--){out[i]=alphabet.charAt(value&31);value>>>=5;}return new String(out);}
}
