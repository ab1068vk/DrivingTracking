package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.ContentValues;
import android.database.Cursor;
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

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP6DerivedStateRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository trips;
    private DriveSenseSpeedArchiveRepository speeds;

    @Before public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_speed_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(), "roadsage_stream_backups_v2"));
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0x31);
        DriveSenseEnvelopeCrypto.installTestKek(1, key); Arrays.fill(key, (byte) 0);
        byte[] portable = new byte[32]; Arrays.fill(portable, (byte) 0x52);
        DriveSenseStreamBackupManager.installPortableKeyForTests(portable); Arrays.fill(portable, (byte) 0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L * 1024L * 1024L * 1024L);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        trips = new DriveSenseTripArchiveRepository(context);
        speeds = new DriveSenseSpeedArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        trips.coordinator().write(db->{
            db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY' WHERE id=1");
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(trips.coordinator());
    }

    @After public void tearDown() {
        DriveSenseP6Jobs.setFaultPointForTests(null);
        DriveSenseStreamBackupManager.resetForTests();
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseStorageCoordinator.resetForTests();
    }

    @Test public void derivedReserveBlocksOnlyDerivedWhileCanonicalAndExportOwnersRemainAdmissible() throws Exception {
        long proposed = 4097L;
        DriveSenseStorageAdmission.setAvailableBytesForTests(
            DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES + proposed);
        DriveSenseP6DerivedState.requireDerivedAdmission(context, proposed);

        DriveSenseStorageAdmission.setAvailableBytesForTests(
            DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES + proposed - 1L);
        try {
            DriveSenseP6DerivedState.requireDerivedAdmission(context, proposed);
            org.junit.Assert.fail("derived construction must preserve the entire 280 MiB reserve");
        } catch (DriveSenseP6DerivedState.DerivedStorageBlockedException blocked) {
            assertEquals("DERIVED_STORAGE_BLOCKED", blocked.getMessage());
            assertEquals(proposed, blocked.proposedBytes);
            assertEquals(DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES, blocked.reserveBytes);
        }

        long canonicalBoundary = DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES - 1L;
        DriveSenseStorageAdmission.setAvailableBytesForTests(canonicalBoundary);
        commitP6Trip("reserve-canonical-trip", 1_781_000_000_000L);

        JSONObject manual = new JSONObject()
            .put("bucketId", "dpz8").put("schemaVersion", 1)
            .put("cells", new JSONObject())
            .put("corrections", new JSONArray().put(new JSONObject()
                .put("id", "manual-reserve-correction").put("geohash", "dpz800")
                .put("speedKmh", 40).put("source", "manual")))
            .put("excludedSections", new JSONArray())
            .put("roadMemory", new JSONObject().put("candidates", new JSONArray())
                .put("frozenBaseline", new JSONObject().put("sampleCount", 19)));
        writeSpeedBucket("dpz8", manual);
        assertEquals("manual-reserve-correction",
            speeds.readBucketJson("dpz8").getJSONArray("corrections").getJSONObject(0).getString("id"));

        DriveSenseStreamBackupManager manager=DriveSenseStreamBackupManager.get(context,trips,speeds);
        JSONObject backup=awaitBackup(manager,manager.begin("p6-derived-reserve", "correct horse battery staple")
            .getString("operationId"));
        assertTrue(backup.getBoolean("verified"));

        JSONObject blocked=null;
        for(int turn=0;turn<16;turn++){
            blocked=DriveSenseP6Jobs.stepTripDerived(trips);
            if("DERIVED_STORAGE_BLOCKED".equals(blocked.optString("state")))break;
        }
        assertEquals("DERIVED_STORAGE_BLOCKED",blocked.getString("state"));
        assertEquals(canonicalBoundary,blocked.getLong("availableBytes"));
        assertEquals(DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES,blocked.getLong("reserveBytes"));
        assertEquals("DERIVED_STORAGE_BLOCKED",
            scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM trip_current WHERE trip_id='reserve-canonical-trip'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM speed_current WHERE bucket_id='dpz8'"));
        assertEquals("19",Integer.toString(speeds.readBucketJson("dpz8")
            .getJSONObject("roadMemory").getJSONObject("frozenBaseline").getInt("sampleCount")));
    }

    @Test public void publishedDerivedReclamationDemotesBeforeUnlinkAndCleansExactReferenceOnReopen() throws Exception {
        commitP6Trip("reclaim-preview",1_782_000_000_000L);
        String generation=scalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        byte[] plaintext="{\"route_points\":[{\"lat\":43.7,\"lng\":-79.3}]}".getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(
            trips,generation,"trip_derived","reclaim-preview",1,"1:geometry-v1",-1,plaintext);
        DriveSenseP6DerivedBlobStore.publishFile(context,prepared);
        trips.coordinator().write(db->{
            long now=System.currentTimeMillis();
            ContentValues row=new ContentValues();row.put("archive_generation",generation);
            row.put("trip_id","reclaim-preview");row.put("content_version","1:geometry-v1");
            row.put("ordinal",-1);row.put("commit_state","COMMITTED");row.put("relative_path",prepared.relativePath);
            row.put("plaintext_bytes",prepared.plaintextBytes);row.put("ciphertext_bytes",prepared.ciphertext.length);
            row.put("key_version",prepared.keyVersion);row.put("payload_nonce",prepared.payloadNonce);
            row.put("payload_hash",prepared.payloadHash);row.put("wrapped_dek",prepared.wrappedDek);
            row.put("wrap_nonce",prepared.wrapNonce);row.put("operation_id",prepared.operationId);row.put("updated_at_ms",now);
            db.insertOrThrow("p6_geometry_chunks",null,row);
            db.execSQL("INSERT OR REPLACE INTO p6_manifests(domain_id,subject_id,source_binding,required_version,applied_version,content_version,state,complete,updated_at_ms) VALUES('D2_GEOMETRY','reclaim-preview',?,1,1,'1:geometry-v1','VERIFIED',1,?)",new Object[]{generation,now});
            db.execSQL("UPDATE p6_control SET source_binding=?,required_version=1,applied_version=1,state='VERIFIED',complete=1,storage_outcome=NULL,updated_at_ms=? WHERE domain_id='D2_GEOMETRY'",new Object[]{generation,now});
            db.execSQL("UPDATE p6_trip_work SET state='COMPLETE',cursor=NULL,updated_at_ms=? WHERE trip_id='reclaim-preview'",new Object[]{now});
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
            return null;
        });
        assertEquals("1",scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1"));
        assertTrue(new File(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1/p6_derived"),prepared.relativePath).isFile());

        DriveSenseStorageCoordinator.resetForTests();
        trips=new DriveSenseTripArchiveRepository(context);
        speeds=new DriveSenseSpeedArchiveRepository(context);
        DriveSenseStorageAdmission.setAvailableBytesForTests(DriveSenseP6DerivedState.DERIVED_RESERVE_BYTES-1L);
        try {
            DriveSenseP6DerivedState.requireDerivedAdmission(context,1L);
            org.junit.Assert.fail("fixed low-space observer must remain blocked after reclamation");
        } catch (DriveSenseP6DerivedState.DerivedStorageBlockedException blocked) {
            assertEquals("DERIVED_STORAGE_BLOCKED",blocked.getMessage());
        }

        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='reclaim-preview'"));
        assertEquals("0",scalar("SELECT complete FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='reclaim-preview'"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("DERIVED_RECLAIMED",scalar("SELECT storage_outcome FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("DIRTY",scalar("SELECT state FROM p6_trip_work WHERE trip_id='reclaim-preview'"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='reclaim-preview'"));
        assertEquals("0",scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1"));
        assertFalse(new File(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1/p6_derived"),prepared.relativePath).exists());
        assertEquals("1",scalar("SELECT COUNT(*) FROM trip_current WHERE trip_id='reclaim-preview'"));
    }

    @Test public void durableTwoRoundFrontierEscalatesOnLateExpansion() throws Exception {
        JSONObject began = DriveSenseP6DerivedState.beginRepair(trips, new JSONArray().put("a"));
        String operation = began.getString("repairOperationId");
        JSONObject first = DriveSenseP6DerivedState.stepRepair(trips);
        assertEquals("REPAIR_PAGE", first.getString("state"));
        assertEquals(0, first.getInt("round"));
        DriveSenseP6DerivedState.acknowledgeRepair(trips, operation, "a", 0,
            new JSONArray().put("b"));
        assertEquals("ROUND_COMPLETE", DriveSenseP6DerivedState.stepRepair(trips).getString("state"));
        JSONObject second = DriveSenseP6DerivedState.stepRepair(trips);
        assertEquals("b", second.getString("candidateId"));
        JSONObject escalated = DriveSenseP6DerivedState.acknowledgeRepair(trips, operation, "b", 1,
            new JSONArray().put("c"));
        assertEquals("REPAIR_ESCALATED", escalated.getString("state"));
        assertEquals("REPAIR_ESCALATED", repairState(operation));
    }

    @Test public void explicitFinalizerTreatsUnreadableWorkAsOutstandingAndKeepsDomainOwnership() throws Exception {
        String generation=scalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        trips.coordinator().write(db->{
            db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,writers_enabled=0");
            ContentValues work=new ContentValues();work.put("trip_id","unreadable-only");
            work.put("archive_generation",generation);
            work.put("desired_revision",1);work.put("desired_seq",1);work.put("disposition","UPSERT");
            work.put("dirty_domains","D1_ANALYTICS,D2_GEOMETRY,D3_SPATIAL_SELECTION");
            work.put("state","SOURCE_UNREADABLE");work.put("updated_at_ms",System.currentTimeMillis());
            db.insertOrThrow("p6_trip_work",null,work);return null;
        });

        JSONObject blocked=DriveSenseP6Jobs.finalizeExplicitTripBuild(trips,false);
        assertEquals("PARTIAL",blocked.getString("state"));assertFalse(blocked.getBoolean("complete"));
        assertEquals(1L,blocked.getLong("pending"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));

        trips.coordinator().write(db->{db.delete("p6_trip_work","trip_id=?",new String[]{"unreadable-only"});return null;});
        JSONObject repaired=DriveSenseP6Jobs.finalizeExplicitTripBuild(trips,false);
        assertEquals("VERIFIED",repaired.getString("state"));assertTrue(repaired.getBoolean("complete"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));
    }

    @Test public void largeNonlinearLateImportFrontierSurvivesEveryProcessDeathBoundary() throws Exception {
        JSONArray component = new JSONArray();
        for (int index = 0; index < 128; index++) {
            component.put(String.format(java.util.Locale.ROOT, "component-%03d", index));
        }

        JSONObject began = DriveSenseP6DerivedState.beginRepair(trips, new JSONArray().put("root"));
        String operation = began.getString("repairOperationId");
        assertEquals("1", scalar("SELECT COUNT(*) FROM p6_component_frontier WHERE repair_operation_id='" + operation + "'"));

        // Death after frontier creation must retain the exact first page.
        reopenRepositories();
        JSONObject rootPage = DriveSenseP6DerivedState.stepRepair(trips);
        assertEquals("root", rootPage.getString("candidateId"));
        assertEquals(0, rootPage.getInt("round"));

        // Death after page delivery but before ACK must redeliver, not skip it.
        reopenRepositories();
        JSONObject rootReplay = DriveSenseP6DerivedState.stepRepair(trips);
        assertEquals("root", rootReplay.getString("candidateId"));
        assertEquals(0, rootReplay.getInt("round"));
        DriveSenseP6DerivedState.acknowledgeRepair(trips, operation, "root", 0, component);
        assertEquals("129", scalar("SELECT COUNT(*) FROM p6_component_frontier WHERE repair_operation_id='" + operation + "'"));

        // Death after ACK and again after the durable round transition must not
        // repopulate round zero or lose any of the maximum-sized fanout.
        reopenRepositories();
        JSONObject roundComplete = DriveSenseP6DerivedState.stepRepair(trips);
        assertEquals("ROUND_COMPLETE", roundComplete.getString("state"));
        assertEquals(1, roundComplete.getInt("round"));
        reopenRepositories();

        for (int index = 0; index < component.length(); index++) {
            String candidate = component.getString(index);
            JSONObject page = DriveSenseP6DerivedState.stepRepair(trips);
            assertEquals("REPAIR_PAGE", page.getString("state"));
            assertEquals(candidate, page.getString("candidateId"));
            assertEquals(1, page.getInt("round"));

            if (index == 0 || index == 63) {
                // Death at both the first and middle unacknowledged page
                // boundaries must redeliver the same durable candidate.
                reopenRepositories();
                JSONObject replay = DriveSenseP6DerivedState.stepRepair(trips);
                assertEquals(candidate, replay.getString("candidateId"));
                assertEquals(1, replay.getInt("round"));
            }

            JSONArray discovered;
            if (index == component.length() - 1) {
                // A genuinely late import expands the already-large component
                // in round two. The automatic owner must stop here rather than
                // creating an unbounded third round.
                discovered = new JSONArray().put("late-import");
            } else {
                // Cyclic/nonlinear rediscovery of already-known neighbours is
                // legal and must not create duplicate frontier work.
                discovered = new JSONArray()
                    .put(component.getString((index + 1) % component.length()))
                    .put(component.getString((index + component.length() - 1) % component.length()));
            }
            JSONObject acknowledged = DriveSenseP6DerivedState.acknowledgeRepair(
                trips, operation, candidate, 1, discovered);
            if (index == component.length() - 1) {
                assertEquals("REPAIR_ESCALATED", acknowledged.getString("state"));
            } else {
                assertEquals("ACKNOWLEDGED", acknowledged.getString("state"));
            }

            if (index == 0 || index == 63) reopenRepositories();
        }

        // Final death preserves escalation, the exactly-once frontier and all
        // ACKs; the late candidate is intentionally not admitted to round 3.
        reopenRepositories();
        assertEquals("REPAIR_ESCALATED", repairState(operation));
        assertEquals("129", scalar("SELECT COUNT(*) FROM p6_component_frontier WHERE repair_operation_id='" + operation + "'"));
        assertEquals("129", scalar("SELECT COUNT(*) FROM p6_component_frontier WHERE repair_operation_id='" + operation + "' AND state='PROCESSED'"));
        assertEquals("0", scalar("SELECT COUNT(*) FROM p6_component_frontier WHERE repair_operation_id='" + operation + "' AND candidate_id='late-import'"));
        assertEquals("IDLE", DriveSenseP6DerivedState.stepRepair(trips).getString("state"));
    }

    @Test public void speedGenerationRolloverAtomicallyRevokesD4Coverage() throws Exception {
        String prior = speeds.state().getString("speedGeneration");
        trips.coordinator().write(db -> {
            long now = System.currentTimeMillis();
            db.execSQL("UPDATE p6_control SET state='VERIFIED',complete=1,storage_outcome=NULL,updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'", new Object[]{now});
            db.execSQL("INSERT OR REPLACE INTO p6_trip_work(trip_id,archive_generation,desired_revision,source_hash,desired_seq,disposition,dirty_domains,state,cursor,updated_at_ms) VALUES('trip-a',(SELECT archive_generation FROM archive_meta WHERE id=1),1,X'01',1,'UPSERT','D4_ROAD_LEARNING_SPEED_LOOKUP','ROAD_COMPLETE',NULL,?)", new Object[]{now});
            return null;
        });
        JSONObject result = speeds.rolloverGeneration("test");
        assertNotEquals(prior, result.getString("speedGeneration"));
        assertEquals("REBUILD_REQUIRED", scalar("SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'"));
        assertEquals("0", scalar("SELECT complete FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'"));
        assertEquals("DIRTY", scalar("SELECT state FROM p6_trip_work WHERE trip_id='trip-a'"));
    }

    @Test public void settingsInvalidationUsesBoundedDiscoveryBeforeD1Reverification() throws Exception {
        JSONObject invalidated = DriveSenseP6Jobs.invalidateAnalyticsForSettings(
            trips, "settings-v2", "VEHICLES_CHANGED");
        assertEquals("REBUILD_REQUIRED", invalidated.getString("state"));
        assertEquals("settings-v2", scalar("SELECT settings_version FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("REBUILD_REQUIRED", scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));

        JSONObject discovered = DriveSenseP6Jobs.stepTripDerived(trips);
        assertEquals("SETTINGS_REDISCOVERY_COMPLETE", discovered.getString("state"));
        assertEquals("DIRTY", scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));

        JSONObject verified = DriveSenseP6Jobs.stepTripDerived(trips);
        assertEquals("VERIFIED", verified.getString("state"));
        assertEquals("VERIFIED", scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("1", scalar("SELECT complete FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("REBUILD_REQUIRED", scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
    }

    @Test public void derivedAnalyticsEnvelopeParticipatesInKekRotation() throws Exception {
        String generation=scalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        byte[]plain="{\"completedCount\":1}".getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepareWithKey(
            generation,"trip_derived","analytics-contribution:rotation-trip",1,"analytics-v2",0,plain,1);
        trips.coordinator().write(db->{
            ContentValues row=new ContentValues();row.put("archive_generation",generation);
            row.put("trip_id","rotation-trip");row.put("metric_schema_version",2);
            row.put("source_revision",1);row.put("source_hash",new byte[]{1});row.put("payload",prepared.ciphertext);
            row.put("payload_nonce",prepared.payloadNonce);row.put("payload_hash",prepared.payloadHash);
            row.put("wrapped_dek",prepared.wrappedDek);row.put("wrap_nonce",prepared.wrapNonce);
            row.put("key_version",prepared.keyVersion);row.put("plaintext_bytes",prepared.plaintextBytes);
            row.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("p6_trip_contributions",null,row);
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",1,1);return null;
        });
        byte[]nextKey=new byte[32];Arrays.fill(nextKey,(byte)0x42);
        DriveSenseEnvelopeCrypto.installTestKek(2,nextKey);Arrays.fill(nextKey,(byte)0);
        DriveSenseEnvelopeKeyRotation rotation=new DriveSenseEnvelopeKeyRotation(trips.coordinator());
        JSONObject first=rotation.rotateBatch(2,100);
        assertEquals("trip_derived:p6_trip_contributions",first.getString("domain"));
        assertEquals(1,first.getInt("rewrapped"));
        while(!rotation.rotateBatch(2,100).getBoolean("complete")) { /* bounded domain progression */ }
        DriveSenseP6DerivedBlobStore.Prepared rotated=trips.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,"+
                "key_version,plaintext_bytes FROM p6_trip_contributions WHERE trip_id='rotation-trip'",null)){
                c.moveToFirst();return new DriveSenseP6DerivedBlobStore.Prepared(generation,"trip_derived",
                    "analytics-contribution:rotation-trip",1,"analytics-v2",0,c.getInt(6),c.getBlob(0),
                    c.getBlob(1),c.getBlob(2),c.getBlob(3),c.getBlob(4),c.getInt(5),"","");
            }
        });
        assertEquals(2,rotated.keyVersion);
        assertEquals("{\"completedCount\":1}",new String(
            DriveSenseP6DerivedBlobStore.decrypt(rotated,rotated.ciphertext),StandardCharsets.UTF_8));
    }

    @Test public void nativeJ1PublishesEncryptedAnalyticsGeometryAndExactSpatialSelection() throws Exception {
        long start=1_780_000_000_000L;
        commitP6Trip("p6-end-to-end",start);

        JSONObject turn=null;
        for(int index=0;index<80;index++){
            turn=DriveSenseP6Jobs.stepTripDerived(trips);
            assertTrue(turn.getLong("itemsWorked")<=256);
            assertTrue(turn.getLong("bytesWorked")<=4L*1024L*1024L);
            if("VERIFIED".equals(turn.optString("state")))break;
        }
        assertEquals("VERIFIED",turn.getString("state"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_trip_contributions WHERE trip_id='p6-end-to-end'"));
        assertEquals("0",scalar("SELECT instr(CAST(payload AS TEXT),'completedCount') FROM p6_trip_contributions WHERE trip_id='p6-end-to-end'"));

        JSONObject stats=DriveSenseP6Jobs.queryAchievementStats(trips,start+60_000L);
        assertTrue(stats.getBoolean("available"));
        assertEquals(1,stats.getInt("completedCount"));
        assertEquals(2,stats.getInt("harshBrakesCount"));

        JSONObject previews=DriveSenseP6Jobs.queryGeometryPreviewPage(trips,"",10);
        assertTrue(previews.getBoolean("available"));
        assertEquals(1,previews.getJSONArray("items").length());
        JSONArray points=previews.getJSONArray("items").getJSONObject(0).getJSONArray("route_points");
        assertEquals(8,points.length());

        boolean finalizedRoadWindow=false,appliedRoadObservation=false;
        for(int index=0;index<240;index++){
            JSONObject road=DriveSenseP6Jobs.stepRoadMemory(trips);
            assertTrue(road.getLong("itemsWorked")<=256);
            assertTrue(road.getLong("bytesWorked")<=4L*1024L*1024L);
            if("FINALIZE_PAGE".equals(road.optString("state"))){
                finalizedRoadWindow=true;
                JSONObject statistics=road.getJSONObject("statistics");
                JSONObject observation=new JSONObject()
                    .put("limitKmh",Math.round(statistics.getDouble("p85Kmh")/10d)*10d)
                    .put("p85Kmh",statistics.getDouble("p85Kmh"))
                    .put("sampleCount",road.getJSONObject("summary").getInt("speedCount"))
                    .put("sectionPoints",road.getJSONArray("sectionPoints"));
                DriveSenseP6Jobs.acknowledgeRoadMemory(trips,road.getString("tripId"),
                    new JSONObject().put("observation",observation));
            }else if("APPLY_PAGE".equals(road.optString("state"))){
                appliedRoadObservation=true;
                DriveSenseP6Jobs.acknowledgeRoadMemory(trips,road.getString("tripId"),
                    new JSONObject().put("speedGeneration",scalar("SELECT speed_generation FROM speed_state WHERE id=1"))
                        .put("bucketId","scoped").put("bucketRevision",1));
            }else if("VERIFIED".equals(road.optString("state")))break;
        }
        assertTrue(finalizedRoadWindow);
        assertTrue(appliedRoadObservation);
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='p6-end-to-end'"));

        String cell=(long)Math.floor((43.6500d+90d)/.00135d)+":"+
            (long)Math.floor((-79.3800d+180d)/.00135d);
        JSONObject descriptor=new JSONObject().put("kind","correction")
            .put("lat",43.6500d).put("lng",-79.3800d).put("matchRadiusM",120d);
        JSONObject selectionInput=new JSONObject().put("requestId","selection-page-idempotent")
            .put("cells",new JSONArray().put(cell))
            .put("descriptors",new JSONArray().put(descriptor));
        JSONObject created=DriveSenseP6Jobs.createAffectedSelection(trips,selectionInput);
        assertTrue(created.getBoolean("accepted"));
        String requestId=created.getString("requestId");
        JSONObject replayed=DriveSenseP6Jobs.createAffectedSelection(trips,selectionInput);
        assertEquals(requestId,replayed.getString("requestId"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_selection_requests WHERE request_id='selection-page-idempotent'"));
        boolean sawPrecisePage=false;
        for(int index=0;index<20;index++){
            JSONObject selected=DriveSenseP6Jobs.stepAffectedSelection(trips);
            assertTrue(selected.getLong("itemsWorked")<=256);
            assertTrue(selected.getLong("bytesWorked")<=4L*1024L*1024L);
            if("PRECISE_PAGE".equals(selected.optString("state"))){
                sawPrecisePage=true;
                assertEquals("p6-end-to-end",selected.getString("tripId"));
                assertFalse(selected.getJSONArray("points").length()==0);
                DriveSenseP6Jobs.acknowledgeAffectedSelection(trips,requestId,true);
            }
            if("COMPLETE".equals(selected.optString("state")))break;
        }
        assertTrue(sawPrecisePage);
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_selection_requests"));
    }

    @Test public void extractionAndPreviewResumeAcrossProcessDeathWithoutRestartingHistory() throws Exception {
        int pointCount=1200;
        long start=1_783_000_000_000L;
        commitP6Trip("restartable-extraction",start,pointCount,180);
        assertTrue(Integer.parseInt(scalar("SELECT chunk_count FROM trip_revisions WHERE trip_id='restartable-extraction' AND commit_state='COMMITTED'"))>1);

        JSONObject turn=null;
        int priorPointOrdinal=0, priorPreviewOrdinal=0;
        boolean sawCanonicalChunkBoundary=false,sawPreview=false;
        for(int index=0;index<160;index++){
            turn=DriveSenseP6Jobs.stepTripDerived(trips);
            assertTrue(turn.getLong("itemsWorked")<=256);
            assertTrue(turn.getLong("bytesWorked")<=4L*1024L*1024L);
            String cursor=scalarNullable("SELECT cursor FROM p6_trip_work WHERE trip_id='restartable-extraction'");
            if(cursor!=null){
                JSONObject durable=new JSONObject(cursor);
                int points=durable.optInt("pointOrdinal",priorPointOrdinal);
                int preview=durable.optInt("previewSourceOrdinal",priorPreviewOrdinal);
                assertTrue(points>=priorPointOrdinal);
                assertTrue(preview>=priorPreviewOrdinal);
                if(durable.optInt("chunkIndex",0)>0)sawCanonicalChunkBoundary=true;
                if("PREVIEW".equals(durable.optString("phase")))sawPreview=true;
                priorPointOrdinal=points;priorPreviewOrdinal=preview;
            }
            DriveSenseStorageCoordinator.resetForTests();
            trips=new DriveSenseTripArchiveRepository(context);
            speeds=new DriveSenseSpeedArchiveRepository(context);
            if("VERIFIED".equals(turn.optString("state")))break;
        }
        assertEquals("VERIFIED",turn.getString("state"));
        assertTrue(sawCanonicalChunkBoundary);assertTrue(sawPreview);
        // One posting per distinct cell per published block, not one per point:
        // D3 resolves a posting to a trip revision and block and then rereads the
        // block, so duplicate rows for the same cell bought no selection power and
        // the frozen per-point envelope cannot pay for them. Coverage is what
        // matters, so every committed block must still be reachable and no cell may
        // appear twice inside one block.
        long postings=Long.parseLong(scalar("SELECT COUNT(*) FROM p6_trip_spatial_postings "+
            "WHERE trip_id='restartable-extraction' AND source_revision=1"));
        assertTrue("postings="+postings,postings>0&&postings<pointCount);
        assertEquals(Long.toString(postings),scalar("SELECT COUNT(*) FROM (SELECT DISTINCT cell_token,"+
            "block_ordinal FROM p6_trip_spatial_postings WHERE trip_id='restartable-extraction' "+
            "AND source_revision=1)"));
        assertEquals(scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='restartable-extraction' "+
            "AND ordinal>=0 AND commit_state='COMMITTED'"),
            scalar("SELECT COUNT(DISTINCT block_ordinal) FROM p6_trip_spatial_postings "+
            "WHERE trip_id='restartable-extraction' AND source_revision=1"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='restartable-extraction' AND commit_state<>'COMMITTED'"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_road_observations WHERE trip_id='restartable-extraction' AND record_kind IN ('PARSER_CURSOR','PREVIEW_ACCUMULATOR')"));

        JSONObject previewPage=DriveSenseP6Jobs.queryGeometryPreviewPage(trips,"",10);
        JSONArray previews=previewPage.getJSONArray("items");
        JSONObject item=null;
        for(int index=0;index<previews.length();index++)if("restartable-extraction".equals(previews.getJSONObject(index).getString("id")))item=previews.getJSONObject(index);
        assertTrue(item!=null);
        JSONArray sampled=item.getJSONArray("route_points");assertEquals(160,sampled.length());
        for(int index=0;index<sampled.length();index++){
            int expected=DriveSenseP6Jobs.previewTargetOrdinal(pointCount,160,index);
            assertEquals(43.6500d+expected*.0002d,sampled.getJSONObject(index).getDouble("lat"),0.00000001d);
        }
    }

    @Test public void everyDerivedPublicationBoundaryReplaysWithoutVisibleStageOrReferenceLeak() throws Exception {
        String[] faults={
            "AFTER_GEOMETRY_PENDING_BEFORE_FILE","AFTER_GEOMETRY_FILE_BEFORE_STAGE",
            "AFTER_GEOMETRY_STAGE_BEFORE_CURSOR","AFTER_PREVIEW_PENDING_BEFORE_FILE",
            "AFTER_PREVIEW_FILE_BEFORE_STAGE","AFTER_PREVIEW_STAGE_BEFORE_CURSOR",
            "BEFORE_DERIVED_HEAD_SWAP","AFTER_DERIVED_HEAD_SWAP"
        };
        long start=1_784_000_000_000L;
        for(int fixture=0;fixture<faults.length;fixture++){
            String id="fault-"+fixture;
            commitP6Trip(id,start+fixture*100_000L);
            DriveSenseP6Jobs.setFaultPointForTests(faults[fixture]);
            boolean injected=false;
            for(int turn=0;turn<80;turn++)try{
                DriveSenseP6Jobs.stepTripDerived(trips);
            }catch(IllegalStateException expected){
                if(expected.getMessage().equals("TEST_FAULT:"+faults[fixture])){injected=true;break;}
                throw expected;
            }
            assertTrue("fault did not reach production boundary "+faults[fixture],injected);
            DriveSenseStorageCoordinator.resetForTests();
            trips=new DriveSenseTripArchiveRepository(context);
            speeds=new DriveSenseSpeedArchiveRepository(context);
            JSONObject completed=null;
            for(int turn=0;turn<100;turn++){
                completed=DriveSenseP6Jobs.stepTripDerived(trips);
                if("VERIFIED".equals(completed.optString("state")))break;
            }
            assertEquals("VERIFIED",completed.getString("state"));
            assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='"+id+"' AND commit_state<>'COMMITTED'"));
            assertEquals("0",scalar("SELECT COUNT(*) FROM p6_road_observations WHERE trip_id='"+id+"' AND commit_state<>'COMMITTED'"));
            assertEquals("VERIFIED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='"+id+"'"));
        }
        assertEquals(derivedReferenceRows(),Long.parseLong(scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1")));
    }

    @Test public void supersedingSourceDuringStagingPublishesOnlyTheNewRevisionAndCleansOldStage() throws Exception {
        String id="superseded-stage";
        long start=1_785_000_000_000L;
        commitP6Trip(id,start,300,32);
        assertEquals("BUILDING",DriveSenseP6Jobs.stepTripDerived(trips).getString("state"));
        assertEquals("BUILDING",DriveSenseP6Jobs.stepTripDerived(trips).getString("state"));
        assertTrue(Long.parseLong(scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='superseded-stage' AND content_version='1:geometry-v1'"))>0L);

        commitP6Trip(id,start+10_000L,19,0);
        assertEquals("2",scalar("SELECT revision FROM trip_current WHERE trip_id='superseded-stage'"));
        JSONObject completed=null;
        for(int turn=0;turn<100;turn++){
            completed=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(completed.optString("state")))break;
        }
        assertEquals("VERIFIED",completed.getString("state"));
        assertEquals("2:geometry-v1",scalar("SELECT content_version FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='superseded-stage'"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='superseded-stage' AND content_version='1:geometry-v1'"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_road_observations WHERE trip_id='superseded-stage' AND source_revision=1"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_trip_spatial_postings WHERE trip_id='superseded-stage' AND source_revision=1"));
        assertEquals(derivedReferenceRows(),Long.parseLong(scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1")));
    }

    @Test public void corruptPublishedPreviewIsDemotedBeforeReadAndRebuildsFromCanonicalSource() throws Exception {
        String id="corrupt-preview";commitP6Trip(id,1_786_000_000_000L,260,12);
        JSONObject completed=null;
        for(int turn=0;turn<100;turn++){
            completed=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(completed.optString("state")))break;
        }
        assertEquals("VERIFIED",completed.getString("state"));
        String relative=scalar("SELECT relative_path FROM p6_geometry_chunks WHERE trip_id='corrupt-preview' AND ordinal=-1 AND commit_state='COMMITTED'");
        File file=new File(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1/p6_derived"),relative);
        try(FileOutputStream out=new FileOutputStream(file,false)){out.write(new byte[]{1,2,3,4});out.getFD().sync();}

        JSONObject refused=DriveSenseP6Jobs.queryGeometryPreviewPage(trips,"",20);
        assertFalse(refused.getBoolean("available"));
        assertEquals("REBUILD_REQUIRED",refused.getString("state"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='corrupt-preview'"));
        assertEquals("0",scalar("SELECT complete FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='corrupt-preview'"));
        assertEquals("DIRTY",scalar("SELECT state FROM p6_trip_work WHERE trip_id='corrupt-preview'"));

        DriveSenseStorageCoordinator.resetForTests();trips=new DriveSenseTripArchiveRepository(context);
        speeds=new DriveSenseSpeedArchiveRepository(context);
        for(int turn=0;turn<160;turn++){
            completed=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(completed.optString("state")))break;
        }
        assertEquals("VERIFIED",completed.getString("state"));
        JSONObject repaired=DriveSenseP6Jobs.queryGeometryPreviewPage(trips,"",20);
        assertTrue(repaired.getBoolean("available"));
        boolean found=false;for(int index=0;index<repaired.getJSONArray("items").length();index++)
            if(id.equals(repaired.getJSONArray("items").getJSONObject(index).getString("id")))found=true;
        assertTrue(found);
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='corrupt-preview' AND commit_state<>'COMMITTED'"));
        assertEquals(derivedReferenceRows(),Long.parseLong(scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1")));
    }

    @Test public void corruptSpatialHmacKeyDemotesOnlyDerivedIndexAndCleansExactReference() throws Exception {
        String id="corrupt-spatial-hmac";prepareSpatialCorruptionFixture(id,1_786_100_000_000L);
        trips.coordinator().write(db->{
            db.execSQL("UPDATE p6_spatial_secrets SET payload=X'01020304' WHERE secret_id='spatial-v1'");
            return null;
        });

        assertSpatialCorruptionRefused(id,"DERIVED_SPATIAL_HMAC_CORRUPT");
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_spatial_secrets"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_trip_spatial_postings"));
    }

    @Test public void corruptSpatialIndexCannotRemainVerifiedAndPreservesCanonicalOwners() throws Exception {
        String id="corrupt-spatial-index";prepareSpatialCorruptionFixture(id,1_786_200_000_000L);
        trips.coordinator().write(db->{
            try(Cursor row=db.rawQuery("SELECT archive_generation,cell_token,trip_id,source_revision,"+
                "content_version,block_ordinal,point_ordinal FROM p6_trip_spatial_postings "+
                "WHERE trip_id=? AND point_ordinal=0 LIMIT 1",
                new String[]{id})){
                assertTrue(row.moveToFirst());
                db.execSQL("UPDATE p6_trip_spatial_postings SET point_ordinal=-1 WHERE "+
                    "archive_generation=? AND cell_token=? AND trip_id=? AND source_revision=? "+
                    "AND content_version=? AND block_ordinal=? AND point_ordinal=?",
                    new Object[]{row.getString(0),row.getString(1),row.getString(2),row.getInt(3),
                        row.getString(4),row.getInt(5),row.getInt(6)});
            }
            return null;
        });

        assertSpatialCorruptionRefused(id,"DERIVED_SPATIAL_INDEX_CORRUPT");
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_spatial_secrets"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_trip_spatial_postings"));
    }

    @Test public void corruptAppliedReceiptCannotLeaveSpatialDomainVerified() throws Exception {
        String id="corrupt-spatial-receipt";prepareSpatialCorruptionFixture(id,1_786_300_000_000L);
        trips.coordinator().write(db->{
            db.execSQL("UPDATE p6_source_applied SET source_hash=X'00' WHERE trip_id=? AND domain_id='D3_SPATIAL_SELECTION'",
                new Object[]{id});
            return null;
        });

        assertSpatialCorruptionRefused(id,"DERIVED_SPATIAL_APPLIED_RECEIPT_CORRUPT");
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_spatial_secrets"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_source_applied WHERE trip_id='corrupt-spatial-receipt' AND domain_id='D3_SPATIAL_SELECTION'"));
    }

    @Test public void summaryOnlyTripPublishesExplicitNoGeometryWithoutAFalsePreview() throws Exception {
        String id="summary-only";commitP6Trip(id,1_787_000_000_000L,0,0);
        JSONObject completed=null;
        for(int turn=0;turn<40;turn++){
            completed=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(completed.optString("state")))break;
        }
        assertEquals("VERIFIED",completed.getString("state"));
        assertEquals("NO_PUBLIC_GEOMETRY",scalar("SELECT state FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id='summary-only'"));
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_geometry_chunks WHERE trip_id='summary-only'"));
        JSONObject page=DriveSenseP6Jobs.queryGeometryPreviewPage(trips,"",20);
        for(int index=0;index<page.getJSONArray("items").length();index++)
            assertFalse(id.equals(page.getJSONArray("items").getJSONObject(index).getString("id")));
    }

    @Test public void randomizedAnalyticsReplacementDeletionAndRollingWindowsMatchIndependentFold() throws Exception {
        long now=1_790_000_000_000L,day=86_400_000L;
        Map<String,JSONObject> model=new HashMap<>();
        for(int index=0;index<14;index++){
            String id=String.format(java.util.Locale.US,"analytics-%02d",index);
            JSONObject row=analyticsModel(now-index*day,1.25d+index*.5d,
                index==4?Double.NaN:61d+index*2d,index%4,index%3==0?"defensive":"ordinary");
            model.put(id,row);commitAnalyticsTrip(id,row);
        }
        drainTripDerived(500);
        for(int index:new int[]{1,5,8,12}){
            String id=String.format(java.util.Locale.US,"analytics-%02d",index);
            JSONObject row=analyticsModel(now-(index-1)*day,.75d+index,
                97d-index,index%2,"exemplary");
            model.put(id,row);commitAnalyticsTrip(id,row);
        }
        for(int index:new int[]{2,7,13}){
            String id=String.format(java.util.Locale.US,"analytics-%02d",index);
            trips.tombstone(id,"p6_analytics_fixture",false);model.remove(id);
        }
        drainTripDerived(600);

        JSONObject actual=DriveSenseP6Jobs.queryAchievementStats(trips,now);
        assertTrue(actual.getBoolean("available"));assertEquals(model.size(),actual.getInt("completedCount"));
        double totalKm=0,product=0,weight=0;long harsh=0,weekTrips=0,weekHarsh=0;
        List<JSONObject> ordered=new ArrayList<>(model.values());
        ordered.sort(Comparator.comparingLong((JSONObject value)->value.optLong("start")).reversed());
        for(JSONObject value:model.values()){
            double distance=value.optDouble("distance");totalKm+=distance;harsh+=value.optInt("harsh");
            if(value.has("score")){product+=value.optDouble("score")*distance;weight+=distance;}
            if(value.optLong("start")>=now-7L*day){weekTrips++;weekHarsh+=value.optInt("harsh");}
        }
        double recentProduct=0,recentWeight=0;int defensive=0;
        for(int index=0;index<Math.min(10,ordered.size());index++){
            JSONObject value=ordered.get(index);
            if(index<5&&value.has("score")){recentProduct+=value.optDouble("score")*value.optDouble("distance");recentWeight+=value.optDouble("distance");}
            if("defensive".equals(value.optString("grade"))||"exemplary".equals(value.optString("grade")))defensive++;
        }
        assertEquals(totalKm,actual.getDouble("totalKm"),0.0000001d);
        assertEquals(product/weight,actual.getDouble("avgScore"),0.0000001d);
        assertEquals(harsh,actual.getLong("harshBrakesCount"));
        assertEquals(weekTrips,actual.getLong("weekTripCount"));assertEquals(weekHarsh,actual.getLong("weekHarshBrakes"));
        assertEquals(recentProduct/recentWeight,actual.getDouble("recentFiveAvg"),0.0000001d);
        assertEquals(Math.min(5,ordered.size()),actual.getInt("recentFiveCount"));
        assertEquals(defensive,actual.getInt("defensiveRecentCount"));
        assertEquals(ordered.size()>=10&&defensive==10,actual.getBoolean("defensiveStreak"));
    }

    @Test public void corruptAnalyticsBucketCannotRemainVerifiedOrReturnFalseTotals() throws Exception {
        commitP6Trip("analytics-corrupt",1_788_000_000_000L);drainTripDerived(100);
        trips.coordinator().write(db->{db.execSQL("UPDATE p6_analytics_buckets SET payload=X'01020304' WHERE bucket_key='global'");return null;});
        JSONObject result=DriveSenseP6Jobs.queryAchievementStats(trips,1_788_100_000_000L);
        assertFalse(result.getBoolean("available"));assertEquals("REBUILD_REQUIRED",result.getString("state"));
        assertEquals("ANALYTICS_CORRUPT",result.getString("reason"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("0",scalar("SELECT complete FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM trip_current WHERE trip_id='analytics-corrupt'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
    }

    @Test public void manualCanonicalRevisionInvalidatesAutomaticStageAtEveryNativeBoundary() throws Exception {
        String[] faults={"BEFORE_PENDING","AFTER_PENDING","AFTER_FIRST_BUCKET_PUBLISHED",
            "AFTER_ALL_BUCKETS_PUBLISHED","INSIDE_FINAL_TRANSACTION",
            "AFTER_COMMIT_BEFORE_SENTINEL","AFTER_SENTINEL_BEFORE_CLEANUP"};
        writeSpeedBucket("dpz8",speedDocument("baseline",30));
        for(int index=0;index<faults.length;index++){
            String batch=stageSpeedBucket("dpz8",speedDocument("automatic-x-"+index,40),true);
            DriveSenseSpeedArchiveRepository.setFaultPointForTests(faults[index]);
            try{speeds.finish(batch);org.junit.Assert.fail("fault must interrupt "+faults[index]);}
            catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("TEST_FAULT_"));}

            if(index<5)assertFalse(speeds.readBucketJson("dpz8").toString().contains("automatic-x-"+index));
            writeSpeedBucket("dpz8",speedDocument("manual-y-"+index,50+index));
            assertEquals("manual-y-"+index,speeds.readBucketJson("dpz8")
                .getJSONArray("corrections").getJSONObject(0).getString("id"));
            assertEquals("OBSOLETE",scalar("SELECT state FROM p6_speed_stages WHERE operation_id='"+batch+"' AND bucket_id='dpz8'"));

            DriveSenseStorageCoordinator.resetForTests();
            trips=new DriveSenseTripArchiveRepository(context);
            speeds=new DriveSenseSpeedArchiveRepository(context);
            assertEquals("0",scalar("SELECT COUNT(*) FROM p6_speed_stages WHERE operation_id='"+batch+"'"));
            assertEquals("0",scalar("SELECT COUNT(*) FROM speed_ingress_batches WHERE batch_id='"+batch+"'"));
            assertEquals("0",scalar("SELECT COUNT(*) FROM speed_buckets WHERE operation_id='"+batch+"' AND commit_state='PENDING'"));
            assertEquals("manual-y-"+index,speeds.readBucketJson("dpz8")
                .getJSONArray("corrections").getJSONObject(0).getString("id"));
            assertEquals(scalar("SELECT COUNT(*) FROM speed_buckets WHERE wrapped_dek<>X''"),
                scalar("SELECT reference_count FROM key_reference_counts WHERE domain_id='speed_archive' AND key_version=1"));
            try{speeds.finish(batch);org.junit.Assert.fail("obsolete stage must be gone");}
            catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("Speed batch unavailable"));}
        }
    }

    @Test public void speedReceiptKillBeforeAndAfterInsertReplaysExactlyOnce() throws Exception {
        String[] faults={"BEFORE_SPEED_RECEIPT","AFTER_SPEED_RECEIPT_BEFORE_CURSOR"};
        for(int fixture=0;fixture<faults.length;fixture++){
            String id="speed-receipt-kill-"+fixture;
            commitP6Trip(id,1_789_000_000_000L+fixture*100_000L,32,0);
            drainTripDerived(180);
            trips.coordinator().write(db->{db.execSQL("UPDATE p6_trip_work SET state='COMPLETE',cursor=? WHERE trip_id=?",
                new Object[]{new JSONObject().put("phase","ROAD_APPLY_ACK").put("outputOrdinal",0).toString(),id});return null;});
            JSONObject receipt=new JSONObject()
                .put("speedGeneration",scalar("SELECT speed_generation FROM speed_state WHERE id=1"))
                .put("bucketId","dpz8").put("bucketRevision",fixture+1);
            DriveSenseP6Jobs.setFaultPointForTests(faults[fixture]);
            try{DriveSenseP6Jobs.acknowledgeRoadMemory(trips,id,receipt);org.junit.Assert.fail("fault expected");}
            catch(IllegalStateException expected){assertEquals("TEST_FAULT:"+faults[fixture],expected.getMessage());}
            assertEquals(fixture==0?"0":"1",scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+"'"));

            DriveSenseStorageCoordinator.resetForTests();trips=new DriveSenseTripArchiveRepository(context);
            speeds=new DriveSenseSpeedArchiveRepository(context);
            DriveSenseP6Jobs.acknowledgeRoadMemory(trips,id,receipt);
            assertEquals("1",scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+"'"));
            assertTrue(scalar("SELECT cursor FROM p6_trip_work WHERE trip_id='"+id+"'").contains("ROAD_APPLY"));
        }
    }

    @Test public void capacityBlockedIsDurableTargetDispositionAtNativeJ2Boundary() throws Exception {
        String id="native-capacity-blocked";
        commitP6Trip(id,1_789_100_000_000L,32,0);
        drainTripDerived(180);
        trips.coordinator().write(db->{db.execSQL("UPDATE p6_trip_work SET state='COMPLETE',cursor=? WHERE trip_id=?",
            new Object[]{new JSONObject().put("phase","ROAD_APPLY_ACK").put("outputOrdinal",0).toString(),id});return null;});
        JSONObject target=new JSONObject().put("targetId",id+":1:0").put("tripId",id)
            .put("sourceRevision",1).put("observationOrdinal",0).put("bucketId","dpz8")
            .put("partitionKind","AUTOMATIC").put("encodedBytes",8L*1024L*1024L);
        JSONObject blocked=DriveSenseP6Jobs.acknowledgeRoadMemory(trips,id,new JSONObject()
            .put("disposition","CAPACITY_BLOCKED").put("blockedTarget",target));
        assertEquals("CAPACITY_BLOCKED",blocked.getString("state"));
        assertFalse(blocked.getBoolean("hasMore"));
        assertEquals("CAPACITY_BLOCKED",scalar("SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'"));
        assertEquals("CAPACITY_BLOCKED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND subject_id='"+id+"'"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+"' AND bucket_id='CAPACITY_BLOCKED:"+id+":1:0'"));
        assertTrue(scalar("SELECT cursor FROM p6_trip_work WHERE trip_id='"+id+"'").contains("\"outputOrdinal\":1"));

        // A later fitting target still receives its normal receipt; the blocked
        // target does not stop the rest of J2.
        trips.coordinator().write(db->{db.execSQL("UPDATE p6_trip_work SET cursor=? WHERE trip_id=?",
            new Object[]{new JSONObject().put("phase","ROAD_APPLY_ACK").put("outputOrdinal",1).toString(),id});return null;});
        JSONObject fitting=DriveSenseP6Jobs.acknowledgeRoadMemory(trips,id,new JSONObject()
            .put("speedGeneration",scalar("SELECT speed_generation FROM speed_state WHERE id=1"))
            .put("bucketId","f2m2").put("bucketRevision",2));
        assertEquals("OBSERVATION_APPLIED",fitting.getString("state"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+"' AND bucket_id='f2m2'"));
    }

    /** F03 criterion 5 on the native owner: a canonical revision change and an
     * explicit E2 request are the only two authorities that retire a terminal
     * capacity disposition, and neither ordinary J2 nor a restart retries one. */
    @Test public void capacityBlockedTargetIsRetiredOnlyByCanonicalChangeOrExplicitE2() throws Exception {
        String id="native-capacity-criterion5";
        String control="SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'";
        String blockedCount="SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+
            "' AND bucket_id LIKE 'CAPACITY_BLOCKED:%'";
        commitP6Trip(id,1_789_200_000_000L);
        // Explicit E2 matches D1 on the exact settings fingerprint, so the fixture
        // installs one the way the production settings owner does.
        DriveSenseP6Jobs.invalidateAnalyticsForSettings(trips,"criterion5-settings","fixture");
        drainTripDerived(240);

        // Revision 1 cannot fit, reported through the real native apply page.
        assertEquals("CAPACITY_BLOCKED",driveRoadMemory(900,"dpz8"));
        assertEquals("CAPACITY_BLOCKED",scalar(control));
        assertEquals("1",scalar(blockedCount));
        String blockedOne=scalar("SELECT bucket_id FROM p6_observation_applied WHERE trip_id='"+id+
            "' AND source_revision=1 AND bucket_id LIKE 'CAPACITY_BLOCKED:%'");

        // Ordinary J2 does not retry the unchanged target, and neither does a
        // restart: the job idles instead of re-encoding it.
        assertEquals("IDLE",driveRoadMemory(20,null));
        reopenRepositories();
        assertEquals("IDLE",driveRoadMemory(20,null));
        assertEquals("CAPACITY_BLOCKED",scalar(control));
        assertEquals("1",scalar(blockedCount));

        // A canonical revision change is a different durable target. The commit
        // retires the disposition that described the revision it replaced, and
        // revision 1's terminal receipt does not suppress revision 2.
        commitP6Trip(id,1_789_200_100_000L);
        assertEquals("2",scalar("SELECT revision FROM trip_current WHERE trip_id='"+id+"'"));
        assertNotEquals("CAPACITY_BLOCKED",scalar(control));
        assertEquals("1",scalar(blockedCount));
        drainTripDerived(240);
        assertEquals("VERIFIED",driveRoadMemory(900,null));
        assertEquals("VERIFIED",scalar(control));
        assertTrue(Long.parseLong(scalar("SELECT COUNT(*) FROM p6_observation_applied WHERE trip_id='"+id+
            "' AND source_revision=2 AND bucket_id='scoped'"))>0L);

        // Revision 3 blocks again and stays terminal for its own target.
        commitP6Trip(id,1_789_200_200_000L);
        drainTripDerived(240);
        assertEquals("CAPACITY_BLOCKED",driveRoadMemory(900,"gcpv"));
        assertNotEquals(blockedOne,scalar("SELECT bucket_id FROM p6_observation_applied WHERE trip_id='"+id+
            "' AND source_revision=3 AND bucket_id LIKE 'CAPACITY_BLOCKED:%'"));
        assertEquals("2",scalar(blockedCount));
        assertEquals("IDLE",driveRoadMemory(20,null));
        assertEquals("CAPACITY_BLOCKED",scalar(control));

        // Only the explicit E2 request retires it, and the re-evaluated target
        // then publishes and replaces the disposition.
        DriveSenseP6Jobs.queueExplicitTripSubjects(trips,new JSONArray().put(id),true);
        assertEquals("0",scalar(blockedCount));
        assertNotEquals("CAPACITY_BLOCKED",scalar(control));
        // E2's DRAIN_TRIPS leg owns D1-D3; criterion 5 is about the road leg it
        // drives afterwards, so the fixture hands J2 the same admitted subject.
        trips.coordinator().write(db->{db.execSQL(
            "UPDATE p6_trip_work SET state='COMPLETE',cursor=NULL,updated_at_ms=? WHERE trip_id=?",
            new Object[]{System.currentTimeMillis(),id});return null;});
        assertEquals("VERIFIED",driveRoadMemory(900,null));
        assertEquals("VERIFIED",scalar(control));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND subject_id='"+id+"'"));
        assertEquals("0",scalar(blockedCount));
    }

    /** Drive the real native J2 loop to its terminal state, answering each page.
     * A non-null blockBucket reports capacity exhaustion for the first apply. */
    private String driveRoadMemory(int maxTurns,String blockBucket)throws Exception{
        String state="";boolean blocked=false;
        for(int index=0;index<maxTurns;index++){
            JSONObject road=DriveSenseP6Jobs.stepRoadMemory(trips);
            state=road.optString("state");
            if("FINALIZE_PAGE".equals(state)){
                JSONObject statistics=road.getJSONObject("statistics");
                DriveSenseP6Jobs.acknowledgeRoadMemory(trips,road.getString("tripId"),
                    new JSONObject().put("observation",new JSONObject()
                        .put("limitKmh",Math.round(statistics.getDouble("p85Kmh")/10d)*10d)
                        .put("p85Kmh",statistics.getDouble("p85Kmh"))
                        .put("sampleCount",road.getJSONObject("summary").getInt("speedCount"))
                        .put("sectionPoints",road.getJSONArray("sectionPoints"))));
            }else if("APPLY_PAGE".equals(state)){
                String tripId=road.getString("tripId");
                if(blockBucket!=null&&!blocked){
                    blocked=true;
                    int revision=road.getInt("sourceRevision"),ordinal=road.getInt("observationOrdinal");
                    DriveSenseP6Jobs.acknowledgeRoadMemory(trips,tripId,new JSONObject()
                        .put("disposition","CAPACITY_BLOCKED").put("blockedTarget",new JSONObject()
                            .put("targetId",tripId+":"+revision+":"+ordinal).put("tripId",tripId)
                            .put("sourceRevision",revision).put("observationOrdinal",ordinal)
                            .put("bucketId",blockBucket).put("partitionKind","AUTOMATIC")
                            .put("encodedBytes",8L*1024L*1024L)));
                }else{
                    DriveSenseP6Jobs.acknowledgeRoadMemory(trips,tripId,new JSONObject()
                        .put("speedGeneration",scalar("SELECT speed_generation FROM speed_state WHERE id=1"))
                        .put("bucketId","scoped").put("bucketRevision",1));
                }
            }else if("VERIFIED".equals(state)||"IDLE".equals(state)
                ||"CAPACITY_BLOCKED".equals(state))return state;
        }
        throw new AssertionError("P6 native road memory did not converge: "+state);
    }

    private void commitP6Trip(String id,long start)throws Exception{
        commitP6Trip(id,start,8,0);
    }

    private void commitP6Trip(String id,long start,int pointCount,int padding)throws Exception{
        JSONArray points=new JSONArray();
        String pad=padding<=0?"":"x".repeat(padding);
        for(int index=0;index<pointCount;index++)points.put(new JSONObject()
            .put("lat",43.6500d+index*.0002d).put("lng",-79.3800d)
            .put("speedKmh",50+index).put("accuracy",4+index*.1d)
            .put("timestamp",start+index*1000L).put("padding",pad));
        JSONObject payload=new JSONObject().put("id",id).put("status","completed")
            .put("start_time",start).put("end_time",start+60_000L)
            .put("distance_km",2.5d).put("duration_seconds",60)
            .put("score",88d).put("harsh_brakes_count",2)
            .put("defensive_grade","defensive").put("route_points",points);
        File source=new File(context.getCacheDir(),id+".json");
        try(FileOutputStream output=new FileOutputStream(source,false)){
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        try{trips.commitSpool(source,id,"p6_fixture");}finally{source.delete();}
    }

    private void writeSpeedBucket(String bucketId,JSONObject document)throws Exception{
        String batch=stageSpeedBucket(bucketId,document,false);
        speeds.finish(batch);
    }

    private String stageSpeedBucket(String bucketId,JSONObject document,boolean p6Automatic)throws Exception{
        byte[] bytes=document.toString().getBytes(StandardCharsets.UTF_8);
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);
        JSONObject descriptor=new JSONObject().put("bucketId",bucketId)
            .put("expectedBytes",bytes.length)
            .put("cellCount",document.optJSONArray("corrections")==null?0:document.getJSONArray("corrections").length())
            .put("payloadHash",DriveSenseEnvelopeCrypto.hex(digest));
        String batch=speeds.beginPlan(1,p6Automatic).getString("batchId");
        speeds.addDescriptors(batch,new JSONArray().put(descriptor));speeds.sealPlan(batch);
        speeds.append(batch,bucketId,0,Base64.encodeToString(bytes,Base64.NO_WRAP));
        return batch;
    }

    private static JSONObject speedDocument(String id,int speed)throws Exception{return new JSONObject()
        .put("bucketId","dpz8").put("schemaVersion",2).put("cells",new JSONObject())
        .put("corrections",new JSONArray().put(new JSONObject().put("id",id)
            .put("geohash","dpz800").put("speedKmh",speed).put("source","manual")))
        .put("excludedSections",new JSONArray())
        .put("roadMemory",new JSONObject().put("candidates",new JSONArray()));}

    private void prepareSpatialCorruptionFixture(String id,long start)throws Exception{
        commitP6Trip(id,start,32,4);
        JSONObject manual=new JSONObject().put("bucketId","dpz8").put("schemaVersion",1)
            .put("cells",new JSONObject()).put("corrections",new JSONArray().put(new JSONObject()
                .put("id","manual-"+id).put("geohash","dpz800").put("speedKmh",45)
                .put("source","manual"))).put("excludedSections",new JSONArray())
            .put("roadMemory",new JSONObject().put("candidates",new JSONArray()));
        writeSpeedBucket("dpz8",manual);drainTripDerived(160);
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));
        assertTrue(Long.parseLong(scalar("SELECT COUNT(*) FROM p6_trip_spatial_postings WHERE trip_id='"+id+"'"))>0L);
    }

    private void assertSpatialCorruptionRefused(String id,String reason)throws Exception{
        String cell=(long)Math.floor((43.6500d+90d)/.00135d)+":"+
            (long)Math.floor((-79.3800d+180d)/.00135d);
        JSONObject refused=DriveSenseP6Jobs.createAffectedSelection(trips,new JSONObject()
            .put("cells",new JSONArray().put(cell)).put("descriptors",new JSONArray()));
        for(int turn=0;turn<8&&refused.optBoolean("accepted",false);turn++)
            refused=DriveSenseP6Jobs.stepAffectedSelection(trips);
        assertFalse(refused.optBoolean("accepted",false));assertEquals("REBUILD_REQUIRED",refused.getString("state"));
        assertEquals(reason,refused.getString("reason"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));
        assertEquals("0",scalar("SELECT complete FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION'"));
        assertEquals("REBUILD_REQUIRED",scalar("SELECT state FROM p6_manifests WHERE domain_id='D3_SPATIAL_SELECTION' AND subject_id='"+id+"'"));
        assertEquals("DIRTY",scalar("SELECT state FROM p6_trip_work WHERE trip_id='"+id+"'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D1_ANALYTICS'"));
        assertEquals("VERIFIED",scalar("SELECT state FROM p6_control WHERE domain_id='D2_GEOMETRY'"));
        assertEquals("NATIVE",scalar("SELECT authority_state FROM archive_meta WHERE id=1"));
        assertEquals("HEALTHY",scalar("SELECT recovery_state FROM archive_meta WHERE id=1"));
        assertEquals("1",scalar("SELECT COUNT(*) FROM trip_current WHERE trip_id='"+id+"'"));
        assertEquals("manual-"+id,speeds.readBucketJson("dpz8").getJSONArray("corrections").getJSONObject(0).getString("id"));
        assertEquals(derivedReferenceRows(),Long.parseLong(scalar("SELECT COALESCE((SELECT reference_count FROM key_reference_counts WHERE domain_id='trip_derived' AND key_version=1),0)")));
    }

    private static JSONObject analyticsModel(long start,double distance,double score,int harsh,String grade)throws Exception{
        JSONObject value=new JSONObject().put("start",start).put("distance",distance)
            .put("harsh",harsh).put("grade",grade);
        if(Double.isFinite(score))value.put("score",score);return value;
    }

    private void commitAnalyticsTrip(String id,JSONObject model)throws Exception{
        long start=model.getLong("start");JSONArray points=new JSONArray()
            .put(new JSONObject().put("lat",43.6).put("lng",-79.3).put("timestamp",start))
            .put(new JSONObject().put("lat",43.61).put("lng",-79.31).put("timestamp",start+1000));
        JSONObject payload=new JSONObject().put("id",id).put("status","completed")
            .put("start_time",start).put("end_time",start+60_000L)
            .put("distance_km",model.getDouble("distance")).put("duration_seconds",60)
            .put("harsh_brakes_count",model.getInt("harsh"))
            .put("defensive_grade",model.getString("grade")).put("route_points",points);
        if(model.has("score"))payload.put("score",model.getDouble("score"));
        File source=new File(context.getCacheDir(),id+"-analytics.json");
        try(FileOutputStream output=new FileOutputStream(source,false)){
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));output.getFD().sync();
        }
        try{trips.commitSpool(source,id,"p6_analytics_fixture");}finally{source.delete();}
    }

    private JSONObject drainTripDerived(int maxTurns)throws Exception{
        JSONObject turn=null;
        for(int index=0;index<maxTurns;index++){
            turn=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(turn.optString("state")))return turn;
        }
        throw new AssertionError("P6 trip-derived work did not converge: "+turn);
    }

    private static JSONObject awaitBackup(DriveSenseStreamBackupManager manager,String operation)throws Exception{
        for(int attempt=0;attempt<400;attempt++){
            JSONObject status=manager.status(operation);
            if(status.getBoolean("done"))return status;
            Thread.sleep(25L);
        }
        throw new AssertionError("Portable backup did not finish");
    }

    private String repairState(String operation) throws Exception {
        return trips.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT state FROM p6_component_repairs WHERE repair_operation_id=?", new String[]{operation})) {
                cursor.moveToFirst(); return cursor.getString(0);
            }
        });
    }

    private void reopenRepositories() throws Exception {
        DriveSenseStorageCoordinator.resetForTests();
        trips = new DriveSenseTripArchiveRepository(context);
        speeds = new DriveSenseSpeedArchiveRepository(context);
    }

    private String scalar(String sql) throws Exception {
        return trips.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery(sql, null)) {
                cursor.moveToFirst(); return cursor.getString(0);
            }
        });
    }

    private String scalarNullable(String sql) throws Exception {
        return trips.coordinator().read(db -> {
            try (Cursor cursor = db.rawQuery(sql, null)) {
                if(!cursor.moveToFirst()||cursor.isNull(0))return null;
                return cursor.getString(0);
            }
        });
    }

    private long derivedReferenceRows() throws Exception {
        return Long.parseLong(scalar("SELECT "+
            "(SELECT COUNT(*) FROM p6_geometry_chunks WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_road_observations WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_road_windows WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_spatial_secrets WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_selection_requests WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_trip_contributions WHERE key_version=1)+"+
            "(SELECT COUNT(*) FROM p6_analytics_buckets WHERE key_version=1)"));
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
