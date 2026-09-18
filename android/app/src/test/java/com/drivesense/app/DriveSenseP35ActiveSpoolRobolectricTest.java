package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35ActiveSpoolRobolectricTest {
    private Context context;
    private ServiceController<DriveSenseAutoTrackingService> controller;
    private DriveSenseAutoTrackingService service;

    @Before public void setUp() {
        ShadowLog.stream = System.err;
        context = ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "completed_trip_journal_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_meta"));
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x5a);
        DriveSenseEnvelopeCrypto.installTestKek(1, key);
        DriveSensePayloadCrypto.installTestKey(0, key);
        Arrays.fill(key, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        controller = Robolectric.buildService(DriveSenseAutoTrackingService.class).create();
        service = controller.get();
    }

    @After public void tearDown() {
        if (controller != null) controller.destroy();
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSensePayloadCrypto.clearTestKeys();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseTripArchiveRepository.setFaultPointForTests(null);
        DriveSenseActiveTripSpool.setFaultPointForTests(null);
        DriveSenseEnvelopeKeyRotation.setFaultPointForTests(null);
    }

    @Test public void actualNativeProducerIsBoundedAndCompletesThroughCanonicalArchive() throws Exception {
        final String tripId = "rsas-producer-large";
        final long start = 1_777_000_000_000L;
        final String padding = "p".repeat(960);
        final long targetBytes = 52L * 1024L * 1024L;
        long generatedBytes = 0L;
        int points = 0;
        long firstQuarterNanos = 0L;
        long lastQuarterNanos = 0L;

        assertTrue(service.beginActiveRouteForTests(tripId, start));
        while (generatedBytes < targetBytes) {
            JSONObject point = point(points, start, padding);
            int pointBytes = point.toString().getBytes(StandardCharsets.UTF_8).length + 1;
            long before = System.nanoTime();
            assertTrue(service.appendActivePointForTests(point));
            long elapsed = System.nanoTime() - before;
            if (generatedBytes < targetBytes / 4L) firstQuarterNanos += elapsed;
            if (generatedBytes >= targetBytes * 3L / 4L) lastQuarterNanos += elapsed;
            generatedBytes += pointBytes;
            points++;
        }

        JSONObject active = service.activeRouteStatusForTests();
        assertNotNull(active);
        assertEquals(points, active.getLong("point_count"));
        assertTrue(active.getJSONArray("recent_points").length() <= DriveSenseActiveTripSpool.RECENT_POINT_LIMIT);
        assertTrue(active.getJSONArray("route_preview").length() <= DriveSenseActiveTripSpool.OVERVIEW_POINT_LIMIT);
        assertTrue(active.getInt("open_segment_bytes") <= DriveSenseActiveTripSpool.SEGMENT_PLAINTEXT_BYTES);
        assertTrue(active.getInt("sealed_segment_count") > 100);
        // A linear scan on every point would make the last quarter dominate.
        assertTrue("per-point work grew with accumulated route", lastQuarterNanos < firstQuarterNanos * 8L);

        JSONObject completion = new JSONObject();
        completion.put("id", tripId);
        completion.put("start_time", start);
        completion.put("end_time", start + points * 1000L);
        completion.put("status", "completed");
        completion.put("distance_km", active.optDouble("distance_km", 0d));
        completion.put("duration_seconds", points);
        assertTrue(service.sealActiveRouteToJournalForTests(completion));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());

        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject ingested = repository.ingestCompletedJournal(1, 32L * 1024L * 1024L);
        assertEquals(ingested.toString(), "COMMITTED_ACKNOWLEDGED",
            ingested.getJSONArray("receipts").getJSONObject(0).getString("status"));
        JSONObject receipt = ingested.getJSONArray("receipts").getJSONObject(0);
        assertTrue(receipt.getInt("maxCanonicalStreamBufferBytes") <= DriveSenseTripChunkStore.CHUNK_BYTES);
        assertTrue("peak disk amplification exceeded 2.2x: " + receipt,
            receipt.getLong("peakRouteDiskBytes") <= Math.round(receipt.getLong("canonicalDiskBytes") * 2.2d));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        JSONObject metadata = repository.getMetadata(tripId);
        assertNotNull(metadata);
        assertEquals(metadata.toString(), points, metadata.getInt("point_count"));
        assertTrue(repository.overview(tripId, 900).length > 0);

        long streamed = 0L;
        try (DriveSenseTripArchiveRepository.PayloadDescriptor descriptor = repository.descriptor(tripId, null)) {
            assertNotNull(descriptor);
            assertTrue(descriptor.plaintextBytes > 50L * 1024L * 1024L);
            for (int index = 0; index < descriptor.chunkCount; index++) {
                byte[] chunk = repository.readPayloadChunk(descriptor, index);
                assertTrue(chunk.length <= DriveSenseTripChunkStore.CHUNK_BYTES);
                streamed += chunk.length;
                Arrays.fill(chunk, (byte) 0);
            }
            assertEquals(descriptor.plaintextBytes, streamed);
        }
    }

    @Test public void ownerAndLowSpaceFailuresPreserveSealedBytes() throws Exception {
        long start = 1_777_100_000_000L;
        DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.create(
            context, "owner-trip", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            spool.append(point(index, start, ""));
        }
        long sealedBytes = spool.sealedPlaintextBytes();
        assertTrue(sealedBytes > 0L);
        try {
            DriveSenseActiveTripSpool.reopen(context, spool.sessionId(), DriveSenseActiveTripSpool.OWNER_NATIVE, "wrong-token");
            throw new AssertionError("second producer must be rejected");
        } catch (IllegalStateException expected) {
            assertEquals(DriveSenseActiveTripSpool.ERROR_NOT_OWNER, expected.getMessage());
        }
        DriveSenseStorageAdmission.setAvailableBytesForTests(DriveSenseActiveTripSpool.SPACE_RESERVE_BYTES);
        assertTrue(!service.beginActiveRouteForTests("low-space-trip", start));
        assertEquals(sealedBytes, spool.sealedPlaintextBytes());
        spool.close();
    }

    @Test public void durableSegmentAheadOfManifestIsAuthenticatedAndRecovered() throws Exception {
        long start = 1_777_150_000_000L;
        DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.create(
            context, "tail-recovery", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        String session = spool.sessionId(), token = spool.ownerToken();
        DriveSenseActiveTripSpool.setFaultPointForTests("AFTER_SEGMENT_DIRECTORY_FSYNC_BEFORE_MANIFEST");
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT - 1; index++) {
            spool.append(point(index, start, ""));
        }
        try {
            spool.append(point(DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT - 1, start, ""));
            throw new AssertionError("fault boundary was not reached");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().startsWith("TEST_FAULT_"));
        }
        spool.close();
        DriveSenseActiveTripSpool.setFaultPointForTests(null);

        DriveSenseActiveTripSpool recovered = DriveSenseActiveTripSpool.reopen(
            context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, token
        );
        assertEquals(1, recovered.sealedSegmentCount());
        assertEquals(DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT, recovered.pointCount());
        assertTrue(recovered.sealedPlaintextBytes() > 0L);
        recovered.close();
    }

    @Test public void unsealedTailMayBeLostButManifestNeverFabricatesIt() throws Exception {
        long start = 1_777_160_000_000L;
        DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.create(
            context, "open-tail", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        String session = spool.sessionId(), token = spool.ownerToken();
        for (int index = 0; index < 12; index++) spool.append(point(index, start, ""));
        assertEquals(12, spool.pointCount());
        spool.close();

        DriveSenseActiveTripSpool recovered = DriveSenseActiveTripSpool.reopen(
            context, session, DriveSenseActiveTripSpool.OWNER_NATIVE, token
        );
        assertEquals(0, recovered.pointCount());
        assertEquals(0, recovered.sealedSegmentCount());
        recovered.close();
    }

    @Test public void missingOrCorruptSealedSegmentFailsWithoutInventingHistory() throws Exception {
        long start = 1_777_170_000_000L;
        DriveSenseActiveTripSpool missing = DriveSenseActiveTripSpool.create(
            context, "missing-segment", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            missing.append(point(index, start, ""));
        }
        String missingSession = missing.sessionId(), missingToken = missing.ownerToken();
        File missingFile = new File(missing.directory(), "00000000.rstc");
        assertTrue(missingFile.delete());
        // Robolectric's Windows AtomicFile shadow cannot replace an existing
        // target. Recreate the already-updated manifest once so this fixture
        // represents the production manifest-ahead crash state exactly.
        File missingManifest = new File(missing.directory(), "manifest.enc");
        assertTrue(missingManifest.delete());
        java.lang.reflect.Method persist = DriveSenseActiveTripSpool.class.getDeclaredMethod("persistManifest");
        persist.setAccessible(true);
        persist.invoke(missing);
        missing.close();
        try {
            DriveSenseActiveTripSpool.reopen(context, missingSession, DriveSenseActiveTripSpool.OWNER_NATIVE, missingToken);
            throw new AssertionError("manifest shortfall must fail closed");
        } catch (SecurityException expected) {
            assertEquals("ACTIVE_SPOOL_MANIFEST_AHEAD_OF_SEGMENTS", expected.getMessage());
        }

        DriveSenseActiveTripSpool corrupt = DriveSenseActiveTripSpool.create(
            context, "corrupt-segment", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        for (int index = 0; index < DriveSenseActiveTripSpool.SEGMENT_POINT_LIMIT; index++) {
            corrupt.append(point(index, start, ""));
        }
        String corruptSession = corrupt.sessionId(), corruptToken = corrupt.ownerToken();
        File corruptFile = new File(corrupt.directory(), "00000000.rstc");
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(corruptFile, "rw")) {
            long offset = file.length() - 1L;
            file.seek(offset);
            int prior = file.read();
            file.seek(offset);
            file.write(prior ^ 0x01);
        }
        corrupt.close();
        try {
            DriveSenseActiveTripSpool.reopen(context, corruptSession, DriveSenseActiveTripSpool.OWNER_NATIVE, corruptToken);
            throw new AssertionError("corrupt segment must fail closed");
        } catch (Exception expected) {
            assertNotNull(expected.getMessage());
        }
    }

    @Test public void rollingStatisticsMatchLegacyBatchCorpus() throws Exception {
        final long start = 1_777_200_000_000L;
        final long end = start + 9L * 60_000L;
        JSONArray corpus = new JSONArray();
        assertTrue(service.beginActiveRouteForTests("stats-equivalence", start));
        for (int index = 0; index < 480; index++) {
            long timestamp = start + index * 1000L + (index > 240 ? 90_000L : 0L);
            JSONObject point = new JSONObject();
            point.put("lat", 43.1d + index * 0.00001d);
            point.put("lng", -79.1d - index * 0.00001d);
            point.put("timestamp", java.time.Instant.ofEpochMilli(timestamp).toString());
            point.put("speed_kmh", index % 37 < 5 ? 0.5d : 48d);
            point.put("accuracy", 4d + (index % 3));
            corpus.put(point);
            assertTrue(service.appendActivePointForTests(point));
        }
        JSONObject rolling = service.activeRollingStatsForTests(end);
        JSONObject batch = service.legacyBatchStatsForTests(corpus, start, end);
        assertEquals(batch.getDouble("distance_km"), rolling.getDouble("distance_km"), 1e-9d);
        assertEquals(batch.getDouble("avg_speed_kmh"), rolling.getDouble("avg_speed_kmh"), 1e-9d);
        assertEquals(batch.getDouble("avg_running_speed_kmh"), rolling.getDouble("avg_running_speed_kmh"), 1e-9d);
        assertEquals(batch.getDouble("max_speed_kmh"), rolling.getDouble("max_speed_kmh"), 1e-9d);
        assertEquals(batch.getLong("moving_seconds"), rolling.getLong("moving_seconds"));
        assertEquals(batch.getLong("idle_seconds"), rolling.getLong("idle_seconds"));
        assertEquals(batch.getLong("gap_seconds"), rolling.getLong("gap_seconds"));
        assertEquals(batch.getInt("gap_count"), rolling.getInt("gap_count"));
        assertEquals(batch.getLong("duration_seconds"), rolling.getLong("duration_seconds"));
        assertEquals(batch.getBoolean("night_driving"), rolling.getBoolean("night_driving"));
    }

    @Test public void canonicalFaultRetainsJournalAndRetryCompletesExactlyOnce() throws Exception {
        long start = 1_777_300_000_000L;
        assertTrue(service.beginActiveRouteForTests("retry-trip", start));
        for (int index = 0; index < 700; index++) assertTrue(service.appendActivePointForTests(point(index, start, "")));
        JSONObject completion = new JSONObject(); completion.put("id", "retry-trip");
        completion.put("start_time", start); completion.put("end_time", start + 700_000L); completion.put("status", "completed");
        assertTrue(service.sealActiveRouteToJournalForTests(completion));
        DriveSenseTripArchiveRepository.setFaultPointForTests("AFTER_PENDING");
        DriveSenseTripArchiveRepository repository = new DriveSenseTripArchiveRepository(context);
        JSONObject failed = repository.ingestCompletedJournal(1, 8L * 1024L * 1024L);
        assertEquals("RETRY_REQUIRED", failed.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(1, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());

        DriveSenseStorageCoordinator.resetForTests();
        DriveSenseTripArchiveRepository recovered = new DriveSenseTripArchiveRepository(context);
        JSONObject retried = recovered.ingestCompletedJournal(1, 8L * 1024L * 1024L);
        assertEquals(retried.toString(), "COMMITTED_ACKNOWLEDGED",
            retried.getJSONArray("receipts").getJSONObject(0).getString("status"));
        assertEquals(0, DriveSenseCompletedTripJournal.pendingTripIds(context, 10).length());
        assertEquals(1L, recovered.aggregates(new JSONObject()).getLong("liveCount"));
    }

    @Test public void checkpointStatusPreservesInvalidOrExpiredBytes() throws Exception {
        JSONObject invalid = new JSONObject(); invalid.put("version", DriveSenseActiveTripCheckpointStore.VERSION);
        invalid.put("updated_at_ms", 1L); invalid.put("start_time_ms", 1L); invalid.put("trip_id", "old-trip");
        invalid.put("route_points", new JSONArray().put(point(0, 1L, "")).put(point(1, 1L, "")));
        assertTrue(DriveSenseActiveTripCheckpointStore.save(context, invalid));
        File checkpoint = new File(context.getNoBackupFilesDir(), "active_trip_checkpoint.enc");
        long before = checkpoint.length(); assertTrue(before > 0L);
        JSONObject status = DriveSenseActiveTripCheckpointStore.getStatus(context, System.currentTimeMillis());
        assertEquals("invalid_preserved", status.getString("state"));
        assertTrue(status.getBoolean("present"));
        assertTrue(checkpoint.isFile()); assertEquals(before, checkpoint.length());
    }

    @Test public void activeSpoolBlocksOldKekRetirementUntilOwnedRetirement() throws Exception {
        long start = 1_777_400_000_000L;
        DriveSenseActiveTripSpool spool = DriveSenseActiveTripSpool.create(
            context, "rotation-active", start, DriveSenseActiveTripSpool.OWNER_NATIVE
        );
        spool.append(point(0, start, "")); spool.append(point(1, start, ""));
        byte[] second = new byte[32]; Arrays.fill(second, (byte) 0x6b);
        DriveSenseEnvelopeCrypto.installTestKek(2, second); Arrays.fill(second, (byte) 0);
        DriveSenseStorageCoordinator coordinator = DriveSenseStorageCoordinator.get(context);
        coordinator.helper().getWritableDatabase();
        JSONObject blocked = new DriveSenseEnvelopeKeyRotation(coordinator).rotateBatch(2, 10);
        assertTrue(!blocked.getBoolean("complete"));
        assertEquals(1, blocked.getInt("activeSpoolReferences"));
        byte[] probe = DriveSenseEnvelopeCrypto.newDek();
        DriveSenseEnvelopeCrypto.WrappedDek wrapped = DriveSenseEnvelopeCrypto.wrapDek(
            probe, 1, DriveSenseEnvelopeCrypto.encode("test", "still-present")
        );
        assertTrue(wrapped.ciphertext.length > 0); Arrays.fill(probe, (byte) 0);

        spool.seal(); spool.retireOwned(spool.ownerToken());
        JSONObject complete = new DriveSenseEnvelopeKeyRotation(coordinator).rotateBatch(2, 10);
        assertTrue(complete.getBoolean("complete"));
        try {
            byte[] missing = DriveSenseEnvelopeCrypto.newDek();
            try { DriveSenseEnvelopeCrypto.wrapDek(missing, 1, DriveSenseEnvelopeCrypto.encode("test", "deleted")); }
            finally { Arrays.fill(missing, (byte) 0); }
            throw new AssertionError("retired zero-reference KEK remained usable");
        } catch (Exception expected) {
            assertTrue(expected.getMessage() != null);
        }
    }

    private static JSONObject point(int index, long start, String padding) throws Exception {
        JSONObject point = new JSONObject();
        point.put("lat", 43.0d + (index % 10_000) * 0.000001d);
        point.put("lng", -79.0d - (index % 10_000) * 0.000001d);
        point.put("timestamp", start + index * 1000L);
        point.put("speed_kmh", 42d);
        point.put("accuracy", 5d);
        if (!padding.isEmpty()) point.put("source_padding", padding);
        return point;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
