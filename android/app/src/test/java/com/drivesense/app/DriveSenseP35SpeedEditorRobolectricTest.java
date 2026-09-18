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
public class DriveSenseP35SpeedEditorRobolectricTest {
    private Context context;
    private DriveSenseSpeedArchiveRepository speed;
    private DriveSenseSpeedEditorRepository editor;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) 0x5a);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        speed = new DriveSenseSpeedArchiveRepository(context);
        editor = new DriveSenseSpeedEditorRepository(context, speed);
    }

    @After public void tearDown() {
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
    }

    @Test public void editorListsAreByteAndItemBoundedWithAuthenticatedContinuation() throws Exception {
        writeBucket("bcde", document("bcde", 7, "alpha"));
        writeBucket("bcdf", document("bcdf", 3, "beta"));

        JSONObject request = new JSONObject()
            .put("kind", "correction")
            .put("maxItems", 3)
            .put("maxBytes", 16 * 1024);
        JSONObject first = editor.query(request);
        assertEquals(3, first.getJSONArray("items").length());
        assertTrue(first.getBoolean("bounded"));
        assertTrue(first.getInt("encodedItemBytes") <= 16 * 1024);
        assertTrue(first.getInt("scannedBucketCount") <= DriveSenseSpeedEditorRepository.MAX_SCANNED_BUCKETS);
        String cursor = first.getString("nextCursor");

        JSONObject second = editor.query(new JSONObject(request.toString()).put("cursor", cursor));
        assertEquals("correction-3", second.getJSONArray("items").getJSONObject(0).getString("id"));
        assertEquals("bcde", second.getJSONArray("items").getJSONObject(0).getString("_bucketId"));

        try {
            editor.query(new JSONObject(request.toString()).put("cursor", cursor).put("filter", "beta"));
            fail("query-bound cursor must reject changed filters");
        } catch (IllegalStateException expected) {
            assertEquals("SPEED_EDITOR_CURSOR_STALE", expected.getMessage());
        }
    }

    @Test public void editorCursorBecomesStaleAfterSpeedGenerationRollover() throws Exception {
        writeBucket("bcde", document("bcde", 4, "alpha"));
        JSONObject first = editor.query(new JSONObject().put("kind", "candidate").put("maxItems", 1));
        String cursor = first.getString("nextCursor");
        speed.rolloverGeneration("test");
        try {
            editor.query(new JSONObject().put("kind", "candidate").put("maxItems", 1).put("cursor", cursor));
            fail("generation-bound cursor must be rejected");
        } catch (IllegalStateException expected) {
            assertEquals("SPEED_EDITOR_CURSOR_STALE", expected.getMessage());
        }
    }

    @Test public void oneRequestScansAtMostEightBuckets() throws Exception {
        for (int index = 0; index < 12; index++) writeBucket(bucket(index), document(bucket(index), 0, "none"));
        JSONObject result = editor.query(new JSONObject().put("kind", "correction").put("filter", "missing"));
        assertEquals(0, result.getInt("itemCount"));
        assertEquals(DriveSenseSpeedEditorRepository.MAX_SCANNED_BUCKETS, result.getInt("scannedBucketCount"));
        assertFalse(result.isNull("nextCursor"));
    }

    @Test public void exactIdentityLookupDoesNotScanUnrelatedGeography() throws Exception {
        for (int index = 0; index < 12; index++) {
            String bucket = bucket(index);
            JSONObject value = document(bucket, 1, "region-" + index);
            value.getJSONArray("corrections").getJSONObject(0)
                .put("id", "correction-" + index)
                .put("ruleId", "rule-" + index);
            writeBucket(bucket, value);
        }
        JSONObject result = editor.getExact(new JSONObject()
            .put("kind", "correction")
            .put("id", "correction-11"));
        assertTrue(result.getBoolean("indexed"));
        assertEquals(bucket(11), result.getJSONObject("item").getString("_bucketId"));
        assertEquals("region-11", result.getJSONObject("item").getString("label"));

        JSONObject alias = editor.getExact(new JSONObject()
            .put("kind", "correction")
            .put("id", "rule-11"));
        assertEquals("correction-11", alias.getJSONObject("item").getString("id"));

        JSONObject missing = editor.getExact(new JSONObject()
            .put("kind", "correction")
            .put("id", "does-not-exist"));
        assertTrue(missing.isNull("item"));
    }

    private JSONObject document(String bucketId, int count, String label) throws Exception {
        JSONArray corrections = new JSONArray();
        JSONArray candidates = new JSONArray();
        for (int index = 0; index < count; index++) {
            corrections.put(new JSONObject()
                .put("id", "correction-" + index)
                .put("geohash", bucketId + "00")
                .put("label", label));
            candidates.put(new JSONObject()
                .put("id", "candidate-" + index)
                .put("geohash", bucketId + "00")
                .put("label", label));
        }
        return new JSONObject()
            .put("bucketId", bucketId)
            .put("schemaVersion", 1)
            .put("cells", new JSONObject())
            .put("corrections", corrections)
            .put("excludedSections", new JSONArray())
            .put("roadMemory", new JSONObject().put("candidates", candidates));
    }

    private void writeBucket(String bucketId, JSONObject document) throws Exception {
        byte[] bytes = document.toString().getBytes(StandardCharsets.UTF_8);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        JSONObject descriptor = new JSONObject()
            .put("bucketId", bucketId)
            .put("expectedBytes", bytes.length)
            .put("cellCount", document.getJSONArray("corrections").length())
            .put("payloadHash", DriveSenseEnvelopeCrypto.hex(digest));
        String batch = speed.begin(new JSONArray().put(descriptor)).getString("batchId");
        speed.append(batch, bucketId, 0, Base64.encodeToString(bytes, Base64.NO_WRAP));
        speed.finish(batch);
    }

    private static String bucket(int index) {
        String alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
        char[] out = new char[4];
        for (int position = 3; position >= 0; position--) {
            out[position] = alphabet.charAt(index & 31);
            index >>>= 5;
        }
        return new String(out);
    }
}
