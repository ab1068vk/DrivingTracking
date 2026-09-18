package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

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
import java.util.Arrays;

/** P6-V22: independent SQLite/filesystem/crypto observers over the frozen scale envelope. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP6ScaleRobolectricTest {
    private Context context;
    private DriveSenseTripArchiveRepository trips;
    private String tripGeneration;
    private long basePages;
    private long pageSize;

    @Before public void setUp() throws Exception {
        context=ApplicationProvider.getApplicationContext();
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_speed_archive_v1"));
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        byte[]key=new byte[32];Arrays.fill(key,(byte)0x31);
        DriveSenseEnvelopeCrypto.installTestKek(1,key);Arrays.fill(key,(byte)0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L*1024L*1024L*1024L);
        DriveSenseP35Flags.setNativeAuthorityForTests(true);
        trips=new DriveSenseTripArchiveRepository(context);
        DriveSenseArchiveHealth.inventory(trips.coordinator());
        trips.coordinator().write(db->{
            db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY' WHERE id=1");
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(trips.coordinator());
        tripGeneration=scalar("SELECT archive_generation FROM archive_meta WHERE id=1");
        basePages=pragma("page_count");pageSize=pragma("page_size");
    }

    @After public void tearDown(){
        DriveSenseEnvelopeCrypto.clearTestKeks();
        DriveSenseStorageAdmission.setAvailableBytesForTests(null);
        DriveSenseP35Flags.setNativeAuthorityForTests(null);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);
        DriveSenseStorageCoordinator.resetForTests();
    }

    @Test public void deterministicScaleMatrixFitsMeasuredDurableEnvelope() throws Exception {
        int prior=0;
        assertEnvelope(0,0,0);
        for(int tier:new int[]{100,500,1000,3000,5000}){
            insertTripDerivedRows(prior,tier);
            prior=tier;
            assertEquals(tier,number("SELECT COUNT(*) FROM p6_trip_work"));
            assertEquals(2L*tier,number("SELECT COUNT(*) FROM p6_trip_spatial_postings"));
            assertEnvelope(tier,2L*tier,0);
        }

        // The main tier carries the requested real cardinalities in the actual
        // P6 tables: three million posting rows and 25,000 speed lookup rows.
        insertPointPostings(10_000L,3_000_000L,5_000);
        insertSpeedLookupRows(25_000);
        insertAuthenticatedGeometryFiles(25,4*1024*1024);
        assertEquals(3_000_000L,number("SELECT COUNT(*) FROM p6_trip_spatial_postings"));
        assertEquals(25_000L,number("SELECT COUNT(*) FROM p6_speed_lookup"));
        assertEquals(25L,number("SELECT COUNT(*) FROM p6_geometry_chunks"));
        assertEquals(25L,number("SELECT reference_count FROM key_reference_counts "+
            "WHERE domain_id='trip_derived' AND key_version=1"));
        assertEnvelope(5_000,3_000_000L,25_000);

        // Stretch N=10,000 is additive and retains the main P/S fixture.
        insertTripDerivedRows(5_000,10_000);
        assertEquals(10_000L,number("SELECT COUNT(*) FROM p6_trip_work"));
        assertEquals(3_010_000L,number("SELECT COUNT(*) FROM p6_trip_spatial_postings"));
        assertEnvelope(10_000,3_010_000L,25_000);
    }

    @Test public void moreDurableDebtAddsTurnsWithoutGrowingOneLifecycleTurn() throws Exception {
        insertTombstoneDebt(0,25);
        long smallTurns=drainDebt();
        insertTombstoneDebt(25,125);
        long largeTurns=drainDebt();
        assertTrue(smallTurns>0);assertTrue(largeTurns>smallTurns);
        assertEquals("0",scalar("SELECT COUNT(*) FROM p6_trip_work WHERE state<>'ROAD_COMPLETE'"));
    }

    /**
     * P6-V22 marginal arm. The deterministic matrix above seeds rows directly,
     * which proves the shape of a full store but lets the 32 MiB base term of
     * `E(N,P,S)` absorb any per-point overrun. This publishes real trips through
     * the production J1 pipeline instead and charges the result against the
     * marginal terms alone, so the 24 KiB per trip and 224 bytes per permitted
     * public point are what the measurement actually has to fit.
     */
    @Test public void productionPublishedDerivedRowsFitTheMarginalPerPointEnvelope() throws Exception {
        int tripCount=8,pointCount=600;
        for(int index=0;index<tripCount;index++){
            commitP6Trip("prod-scale-"+index,1_756_000_000_000L+index*86_400_000L,pointCount);
            assertTrue("no P6 debt after commit "+index,number("SELECT COUNT(*) FROM p6_trip_work")>index);
        }
        // The baseline is taken after canonical commit and before the first J1
        // turn, so the delta charges exactly what P6 publishes. Canonical trip
        // rows are not derived state and the envelope does not cover them; the
        // eight debt rows the commit hook created sit at the baseline and are
        // immaterial against the marginal terms asserted below.
        long baseline=measuredBytes();
        drainTripDerived(64_000);
        assertEquals(tripCount,(int)number("SELECT COUNT(*) FROM p6_manifests WHERE "+
            "domain_id='D2_GEOMETRY' AND state='VERIFIED' AND subject_id LIKE 'prod-scale-%'"));
        assertTrue(number("SELECT COUNT(*) FROM p6_geometry_chunks")>=tripCount);
        assertTrue(number("SELECT COUNT(*) FROM p6_trip_spatial_postings")>0);
        long measured=measuredBytes()-baseline;
        long envelope=24L*1024L*tripCount+224L*tripCount*pointCount;
        assertTrue("measured="+measured+" envelope="+envelope+" N="+tripCount+
            " P="+(long)tripCount*pointCount+" "+derivedBreakdown(),measured<=envelope);
    }

    private void commitP6Trip(String id,long start,int pointCount)throws Exception{
        JSONArray points=new JSONArray();
        double lat=43.6500d,lng=-79.3800d,heading=42d;
        for(int index=0;index<pointCount;index++){
            double speed=34+46*Math.abs(Math.sin(index/55d));
            heading=(heading+Math.sin(index/23d)*4+360)%360;
            double metres=speed/3.6d;
            lat+=(metres*Math.cos(Math.toRadians(heading)))/111_320d;
            lng+=(metres*Math.sin(Math.toRadians(heading)))/(111_320d*Math.cos(Math.toRadians(lat)));
            points.put(new JSONObject().put("lat",lat).put("lng",lng)
                .put("speed_kmh",Math.round(speed*100)/100d).put("heading",Math.round(heading*100)/100d)
                .put("accuracy",6).put("speed_limit_kmh",60).put("speed_limit_source","osm")
                .put("utc_offset_minutes",-240).put("timezone_id","America/Toronto")
                .put("timestamp",start+index*1000L));
        }
        JSONObject payload=new JSONObject().put("id",id).put("status","completed")
            .put("start_time",start).put("end_time",start+pointCount*1000L)
            .put("distance_km",9d).put("duration_seconds",pointCount)
            .put("score",88d).put("harsh_brakes_count",0)
            .put("defensive_grade","defensive").put("route_points",points);
        File source=new File(context.getCacheDir(),id+".json");
        try(FileOutputStream output=new FileOutputStream(source,false)){
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        try{trips.commitSpool(source,id,"p6_scale_fixture");}finally{source.delete();}
    }

    private void drainTripDerived(int maxTurns)throws Exception{
        JSONObject turn=null;
        for(int index=0;index<maxTurns;index++){
            turn=DriveSenseP6Jobs.stepTripDerived(trips);
            if("VERIFIED".equals(turn.optString("state")))return;
        }
        throw new AssertionError("P6 trip-derived work did not converge: "+turn);
    }

    /** Independent SQL/filesystem breakdown, reported when the envelope fails. */
    private String derivedBreakdown()throws Exception{
        return "files="+directoryBytes(new File(context.getNoBackupFilesDir(),
                "roadsage_trip_archive_v1/p6_derived"))
            +" chunks="+number("SELECT COUNT(*) FROM p6_geometry_chunks")
            +" postings="+number("SELECT COUNT(*) FROM p6_trip_spatial_postings")
            +" observations="+number("SELECT COUNT(*) FROM p6_road_observations")
            +"/"+number("SELECT COALESCE(SUM(LENGTH(payload)),0) FROM p6_road_observations")
            +" windows="+number("SELECT COUNT(*) FROM p6_road_windows")
            +"/"+number("SELECT COALESCE(SUM(LENGTH(payload)),0) FROM p6_road_windows")
            +" contributions="+number("SELECT COALESCE(SUM(LENGTH(payload)),0) FROM p6_trip_contributions")
            +" manifests="+number("SELECT COUNT(*) FROM p6_manifests")
            +" pages="+(pragma("page_count")*pageSize);
    }

    private long measuredBytes()throws Exception{
        return pragma("page_count")*pageSize
            +directoryBytes(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1/p6_derived"));
    }

    private void insertTripDerivedRows(int from,int to)throws Exception{
        trips.coordinator().write(db->{
            db.beginTransaction();try{
                byte[]hash=new byte[32],nonce=new byte[12],wrapped=new byte[48],payload=new byte[256];
                for(int index=from;index<to;index++){
                    String id="p6-scale-"+index;long now=1_700_000_000_000L+index;
                    db.execSQL("INSERT INTO p6_trip_work(trip_id,archive_generation,desired_revision,source_hash,"+
                        "desired_seq,disposition,dirty_domains,state,cursor,updated_at_ms) VALUES(?,?,1,?,?,'UPSERT',"+
                        "'D1_ANALYTICS,D2_GEOMETRY,D3_SPATIAL_SELECTION','COMPLETE',NULL,?)",
                        new Object[]{id,tripGeneration,hash,index+1L,now});
                    db.execSQL("INSERT INTO p6_trip_contributions(archive_generation,trip_id,metric_schema_version,"+
                        "source_revision,source_hash,payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,"+
                        "key_version,plaintext_bytes,updated_at_ms) VALUES(?,?,2,1,?,?,?,?,?,?,1,240,?)",
                        new Object[]{tripGeneration,id,hash,payload,nonce,hash,wrapped,nonce,now});
                    db.execSQL("INSERT INTO p6_recent_order(archive_generation,order_time_ms,trip_id,source_revision,eligible) "+
                        "VALUES(?,?,?,1,1)",new Object[]{tripGeneration,now,id});
                    for(String domain:new String[]{"D1_ANALYTICS","D2_GEOMETRY","D3_SPATIAL_SELECTION"}){
                        db.execSQL("INSERT INTO p6_source_applied(archive_generation,trip_id,domain_id,source_revision,"+
                            "source_hash,algorithm_version,settings_version,published_content_version,updated_at_ms) "+
                            "VALUES(?,?,?,1,?,1,NULL,'1:geometry-v1',?)",
                            new Object[]{tripGeneration,id,domain,hash,now});
                        db.execSQL("INSERT INTO p6_manifests(domain_id,subject_id,source_binding,required_version,"+
                            "applied_version,content_version,state,complete,updated_at_ms) "+
                            "VALUES(?,?,?,1,1,'1:geometry-v1','VERIFIED',1,?)",
                            new Object[]{domain,id,tripGeneration,now});
                    }
                    insertPosting(db,id,0,index*2L);insertPosting(db,id,1,index*2L+1L);
                }
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
    }

    private void insertPointPostings(long from,long to,int tripsCount)throws Exception{
        trips.coordinator().write(db->{
            db.beginTransaction();
            SQLiteStatement statement=db.compileStatement("INSERT INTO p6_trip_spatial_postings("+
                "archive_generation,cell_token,trip_id,source_revision,content_version,block_ordinal,point_ordinal) "+
                "VALUES(?,?,?,1,'1:geometry-v1',?,?)");
            try{
                for(long ordinal=from;ordinal<to;ordinal++){
                    int trip=(int)(ordinal%tripsCount);long point=2L+(ordinal-from)/tripsCount;
                    statement.clearBindings();statement.bindString(1,tripGeneration);
                    statement.bindString(2,postingToken((ordinal&4095L)+1L));
                    statement.bindString(3,"p6-scale-"+trip);statement.bindLong(4,point/128L);
                    statement.bindLong(5,point);statement.executeInsert();
                }
                db.setTransactionSuccessful();
            }finally{statement.close();db.endTransaction();}
            return null;
        });
    }

    private void insertPosting(SQLiteDatabase db,String id,long point,long tokenSeed){
        db.execSQL("INSERT INTO p6_trip_spatial_postings(archive_generation,cell_token,trip_id,source_revision,"+
            "content_version,block_ordinal,point_ordinal) VALUES(?,?,?,1,'1:geometry-v1',0,?)",
            new Object[]{tripGeneration,postingToken(tokenSeed+1L),id,point});
    }

    private void insertSpeedLookupRows(int count)throws Exception{
        trips.coordinator().write(db->{
            String speed=scalar(db,"SELECT speed_generation FROM speed_state WHERE id=1");
            db.beginTransaction();SQLiteStatement statement=db.compileStatement("INSERT INTO p6_speed_lookup("+
                "speed_generation,cell_token,candidate_id_hash,bucket_id,publication_version) VALUES(?,?,?,?,1)");
            try{for(int index=0;index<count;index++){
                statement.clearBindings();statement.bindString(1,speed);
                statement.bindString(2,String.format(java.util.Locale.US,"%064x",index%4096+1));
                statement.bindString(3,String.format(java.util.Locale.US,"%064x",index+1));
                statement.bindString(4,String.format(java.util.Locale.US,"b%07d",index/128));
                statement.executeInsert();
            }db.setTransactionSuccessful();}finally{statement.close();db.endTransaction();}
            return null;
        });
    }

    private void insertAuthenticatedGeometryFiles(int count,int plaintextBytes)throws Exception{
        byte[]plain=new byte[plaintextBytes];Arrays.fill(plain,(byte)0x45);
        for(int index=0;index<count;index++){
            String id="p6-scale-long-"+index;
            DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(
                trips,tripGeneration,"trip_derived",id,1,"scale-geometry-v1",0,plain);
            assertEquals(plaintextBytes+16,prepared.ciphertext.length);
            assertEquals(32,prepared.payloadHash.length);assertEquals(12,prepared.payloadNonce.length);
            assertEquals(48,prepared.wrappedDek.length);assertEquals(12,prepared.wrapNonce.length);
            DriveSenseP6DerivedBlobStore.publishFile(context,prepared);
            trips.coordinator().write(db->{
                db.execSQL("INSERT INTO p6_geometry_chunks(archive_generation,trip_id,content_version,ordinal,"+
                    "commit_state,relative_path,plaintext_bytes,ciphertext_bytes,key_version,payload_nonce,payload_hash,"+
                    "wrapped_dek,wrap_nonce,operation_id,updated_at_ms) VALUES(?,?,?,0,'COMMITTED',?,?,?,?,?,?,?,?,?,?)",
                    new Object[]{tripGeneration,id,"scale-geometry-v1",prepared.relativePath,prepared.plaintextBytes,
                        prepared.ciphertext.length,prepared.keyVersion,prepared.payloadNonce,prepared.payloadHash,
                        prepared.wrappedDek,prepared.wrapNonce,prepared.operationId,System.currentTimeMillis()});
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);return null;
            });
            Arrays.fill(prepared.ciphertext,(byte)0);
        }
        Arrays.fill(plain,(byte)0);
    }

    private void insertTombstoneDebt(int from,int to)throws Exception{
        trips.coordinator().write(db->{db.beginTransaction();try{
            for(int index=from;index<to;index++)db.execSQL("INSERT INTO p6_trip_work(trip_id,archive_generation,"+
                "desired_revision,source_hash,desired_seq,disposition,dirty_domains,state,cursor,updated_at_ms) "+
                "VALUES(?,?,1,X'00',?,'TOMBSTONE','D1_ANALYTICS,D2_GEOMETRY,D3_SPATIAL_SELECTION',"+
                "'DIRTY',NULL,?)",new Object[]{"debt-"+index,tripGeneration,index+1L,System.currentTimeMillis()});
            db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
    }

    private long drainDebt()throws Exception{
        long turns=0;
        while(number("SELECT COUNT(*) FROM p6_trip_work WHERE state<>'ROAD_COMPLETE'")>0){
            JSONObject result=DriveSenseP6Jobs.stepTripDerived(trips);turns++;
            assertTrue(result.getLong("itemsWorked")<=256L);
            assertTrue(result.getLong("bytesWorked")<=4L*1024L*1024L);
            assertTrue(turns<10_000L);
        }
        return turns;
    }

    private void assertEnvelope(long n,long p,long s)throws Exception{
        long measured=(pragma("page_count")-basePages)*pageSize+
            directoryBytes(new File(context.getNoBackupFilesDir(),"roadsage_trip_archive_v1/p6_derived"));
        long envelope=32L*1024L*1024L+24L*1024L*n+224L*p+512L*s;
        assertTrue("measured="+measured+" envelope="+envelope+" N="+n+" P="+p+" S="+s,
            measured<=envelope);
    }

    private static String postingToken(long value){
        return String.format(java.util.Locale.US,"%022d",value);
    }

    private long pragma(String name)throws Exception{return number("PRAGMA "+name);}
    private long number(String sql)throws Exception{return Long.parseLong(scalar(sql));}
    private String scalar(String sql)throws Exception{return trips.coordinator().read(db->scalar(db,sql));}
    private static String scalar(SQLiteDatabase db,String sql){try(Cursor c=db.rawQuery(sql,null)){
        if(!c.moveToFirst())throw new IllegalStateException("P6_SCALE_SCALAR_MISSING");return c.getString(0);}}
    private static long directoryBytes(File file){if(file==null||!file.exists())return 0L;
        if(file.isFile())return file.length();long total=0;File[]children=file.listFiles();
        if(children!=null)for(File child:children)total+=directoryBytes(child);return total;}
    private static void deleteTree(File file){if(file==null||!file.exists())return;File[]children=file.listFiles();
        if(children!=null)for(File child:children)deleteTree(child);file.delete();}
}
