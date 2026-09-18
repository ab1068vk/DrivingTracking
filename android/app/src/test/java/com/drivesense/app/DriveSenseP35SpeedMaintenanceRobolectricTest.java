package com.drivesense.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.util.Base64;

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

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35SpeedMaintenanceRobolectricTest {
    private Context context;
    private DriveSenseSpeedArchiveRepository speed;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x61);
        DriveSenseEnvelopeCrypto.installTestKek(1, key); Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024 * 1024 * 1024);
        speed = new DriveSenseSpeedArchiveRepository(context);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void pruneIsBoundedCheckpointedAndResumes() throws Exception {
        for (int index = 0; index < 12; index++) writeBucket(bucket(index), true);
        DriveSenseSpeedMaintenanceJob first = new DriveSenseSpeedMaintenanceJob(speed);
        JSONObject begun = first.begin("PRUNE", 30);
        JSONObject step = first.step(begun.getString("jobId"), 3);
        assertEquals("RUNNING", step.getString("state"));
        assertEquals(3, step.getInt("processedBuckets"));

        DriveSenseSpeedMaintenanceJob recreated = new DriveSenseSpeedMaintenanceJob(speed);
        JSONObject status = step;
        while ("RUNNING".equals(status.getString("state"))) {
            status = recreated.step(status.getString("jobId"), 8);
        }
        assertEquals("COMPLETED", status.getString("state"));
        assertEquals(12, status.getInt("processedBuckets"));
        assertEquals(12, status.getInt("removedItems"));
        for (int index = 0; index < 12; index++) {
            assertEquals(0, speed.readBucketJson(bucket(index)).getJSONObject("cells").length());
        }
    }

    /**
     * P4-C-F08. The renderer used to hold the only pointer to a durable RUNNING
     * job, so a process death between two bounded steps started a second one and
     * stranded the first checkpoint. The native table now owns that identity.
     */
    @Test public void beginOrResumeReturnsTheDurableRunningJobAfterRendererDeath() throws Exception {
        for (int index = 0; index < 12; index++) writeBucket(bucket(index), true);
        DriveSenseSpeedMaintenanceJob first = new DriveSenseSpeedMaintenanceJob(speed);
        JSONObject begun = first.beginOrResume("PRUNE", 30);
        JSONObject step = first.step(begun.getString("jobId"), 3);
        assertEquals("RUNNING", step.getString("state"));
        assertEquals(3, step.getInt("processedBuckets"));

        // A fresh renderer: nothing in JS remembers the job id.
        DriveSenseSpeedMaintenanceJob recreated = new DriveSenseSpeedMaintenanceJob(speed);
        JSONObject resumed = recreated.beginOrResume("PRUNE", 30);

        assertEquals(begun.getString("jobId"), resumed.getString("jobId"));
        assertEquals("RUNNING", resumed.getString("state"));
        assertEquals(3, resumed.getInt("processedBuckets"));
        assertEquals(step.getString("cursor"), resumed.getString("cursor"));
        assertEquals(1, runningJobCount());

        JSONObject status = resumed;
        while ("RUNNING".equals(status.getString("state"))) {
            status = recreated.step(status.getString("jobId"), 8);
        }
        assertEquals("COMPLETED", status.getString("state"));
        assertEquals(begun.getString("jobId"), status.getString("jobId"));
        assertEquals(12, status.getInt("processedBuckets"));
        assertEquals(0, runningJobCount());
    }

    @Test public void cancellationDoesNotMutateUnvisitedBuckets() throws Exception {
        for (int index = 0; index < 10; index++) writeBucket(bucket(index), true);
        DriveSenseSpeedMaintenanceJob job = new DriveSenseSpeedMaintenanceJob(speed);
        JSONObject begun = job.begin("PRUNE", 30);
        JSONObject first = job.step(begun.getString("jobId"), 2);
        JSONObject cancelled = job.cancel(first.getString("jobId"));
        assertEquals("CANCELLED", cancelled.getString("state"));
        int remaining = 0;
        for (int index = 0; index < 10; index++) {
            remaining += speed.readBucketJson(bucket(index)).getJSONObject("cells").length();
        }
        assertEquals(8, remaining);
    }

    private int runningJobCount() throws Exception {
        return speed.coordinator()
            .read(db -> {
                try (android.database.Cursor cursor = db.rawQuery(
                    "SELECT COUNT(*) FROM speed_maintenance_jobs WHERE state='RUNNING'", null)) {
                    cursor.moveToFirst();
                    return cursor.getInt(0);
                }
            });
    }

    private void writeBucket(String id, boolean stale) throws Exception {
        JSONObject document = new JSONObject()
            .put("bucketId", id)
            .put("cells", new JSONObject().put(id + "00", new JSONObject()
                .put("lastUpdatedAt", stale ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z")))
            .put("corrections", new JSONArray())
            .put("excludedSections", new JSONArray())
            .put("roadMemory", new JSONObject().put("candidates", new JSONArray()));
        byte[] bytes = document.toString().getBytes(StandardCharsets.UTF_8);
        JSONObject descriptor = new JSONObject()
            .put("bucketId", id).put("expectedBytes", bytes.length).put("cellCount", 1)
            .put("payloadHash", DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        String batch = speed.begin(new JSONArray().put(descriptor)).getString("batchId");
        speed.append(batch, id, 0, Base64.encodeToString(bytes, Base64.NO_WRAP));
        speed.finish(batch);
        Arrays.fill(bytes, (byte) 0);
    }

    private static String bucket(int index) {
        String alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
        char[] out = new char[4];
        for (int position = 3; position >= 0; position--) { out[position] = alphabet.charAt(index & 31); index >>>= 5; }
        return new String(out);
    }
}
