package com.drivesense.app;

import static org.junit.Assert.*;

import android.content.ContentValues;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

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

import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35SpeedScaleRobolectricTest {
    private Context context;
    private DriveSenseStorageCoordinator coordinator;
    private DriveSenseSpeedArchiveRepository repository;
    private String generation;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        coordinator = DriveSenseStorageCoordinator.get(context);
        repository = new DriveSenseSpeedArchiveRepository(context);
        generation = repository.state().getString("speedGeneration");
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void exactLocalLookupWorkDoesNotGrowWithUnrelatedGeography() throws Exception {
        int[] samples = {1, 100, 1_000, 10_000};
        int inserted = 0;
        for (int target : samples) {
            final int from = inserted;
            coordinator.write(db -> {
                db.beginTransaction();
                try {
                    for (int index = from; index < target; index++) insertBucket(db, bucket(index), index + 1L);
                    db.execSQL("UPDATE speed_state SET bucket_count=?,total_item_count=?,total_payload_bytes=? WHERE id=1",
                        new Object[]{target, target, target * 128L});
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                return null;
            });
            inserted = target;
            JSONObject result = repository.metadata(new JSONArray().put(bucket(0)));
            assertEquals(1, result.getInt("requestedCount"));
            assertEquals(1, result.getInt("examinedBucketIds"));
            assertEquals(1, result.getInt("itemCount"));
            assertEquals(bucket(0), result.getJSONArray("items").getJSONObject(0).getString("bucketId"));
        }
        assertEquals(10_000L, repository.state().getLong("bucketCount"));
    }

    private void insertBucket(SQLiteDatabase db, String bucket, long seq) {
        byte[] hash = new byte[32]; Arrays.fill(hash, (byte) (seq & 0xff));
        ContentValues revision = new ContentValues();
        revision.put("bucket_id", bucket); revision.put("speed_generation", generation); revision.put("revision", 1);
        revision.put("operation_id", "scale"); revision.put("commit_state", "COMMITTED"); revision.put("cell_count", 1);
        revision.put("payload_bytes", 128); revision.put("payload_hash", hash); revision.put("chunk_count", 0);
        revision.put("wrapped_dek", new byte[]{1}); revision.put("wrap_nonce", new byte[]{1}); revision.put("kek_version", 1);
        revision.put("updated_seq", seq); revision.put("updated_at_ms", 1L);
        db.insertOrThrow("speed_buckets", null, revision);
        ContentValues current = new ContentValues();
        current.put("bucket_id", bucket); current.put("speed_generation", generation); current.put("revision", 1);
        current.put("updated_seq", seq); current.put("cell_count", 1); current.put("payload_bytes", 128);
        current.put("payload_hash", hash); current.put("updated_at_ms", 1L);
        db.insertOrThrow("speed_current", null, current);
    }

    private static String bucket(int index) {
        String alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
        char[] out = new char[4];
        for (int position = 3; position >= 0; position--) { out[position] = alphabet.charAt(index & 31); index >>>= 5; }
        return new String(out);
    }
}
