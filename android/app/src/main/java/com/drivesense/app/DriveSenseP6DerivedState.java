package com.drivesense.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

/** Owner-compatible P6 derived control plane. Canonical archive data never lives here. */
final class DriveSenseP6DerivedState {
    static final long CANONICAL_RESERVE_BYTES = 256L * 1024L * 1024L;
    static final long LARGEST_DERIVED_STAGE_BYTES = 8L * 1024L * 1024L;
    static final long DERIVED_SAFETY_BYTES = 16L * 1024L * 1024L;
    static final long DERIVED_RESERVE_BYTES = CANONICAL_RESERVE_BYTES
        + LARGEST_DERIVED_STAGE_BYTES + DERIVED_SAFETY_BYTES;
    static final int MAX_AUTOMATIC_REPAIR_ROUNDS = 2;

    private DriveSenseP6DerivedState() {}

    /** Four primary-key status reads only. No manifests, routes or work queues are enumerated. */
    static JSONObject diagnosticsReadiness(DriveSenseStorageCoordinator coordinator) throws Exception {
        return coordinator.read(db -> {
            JSONObject result = new JSONObject();
            String[] domains = {"D1_ANALYTICS", "D2_GEOMETRY", "D3_SPATIAL_SELECTION", "D4_ROAD_LEARNING_SPEED_LOOKUP"};
            for (String domain : domains) {
                JSONObject value = new JSONObject();
                value.put("domain", domain);
                try (Cursor cursor = db.rawQuery("SELECT state,complete,required_version,applied_version FROM p6_control WHERE domain_id=?", new String[]{domain})) {
                    if (cursor.moveToFirst()) {
                        value.put("state", cursor.getString(0));
                        value.put("complete", cursor.getInt(1) != 0);
                        value.put("required_version", cursor.getLong(2));
                        value.put("applied_version", cursor.getLong(3));
                    } else {
                        value.put("state", "unavailable");
                    }
                }
                result.put(domain, value);
            }
            return result;
        });
    }

    static void requireDerivedAdmission(Context context, long proposedBytes) {
        long proposed = Math.max(0L, proposedBytes);
        long available = DriveSenseStorageAdmission.availableBytes(context);
        if(available < proposed || available-proposed < DERIVED_RESERVE_BYTES){
            try{
                DriveSenseStorageCoordinator coordinator=DriveSenseStorageCoordinator.get(context);
                for(int turn=0;turn<64&&(available<proposed||available-proposed<DERIVED_RESERVE_BYTES);turn++){
                    Reclaimed reclaimed=reclaimOne(coordinator);if(reclaimed==null)break;
                    available=DriveSenseStorageAdmission.availableBytes(context);
                }
            }catch(Exception ignored){/* Admission remains fail closed below. */}
        }
        if (available < proposed || available - proposed < DERIVED_RESERVE_BYTES) {
            throw new DerivedStorageBlockedException(available, proposed, DERIVED_RESERVE_BYTES);
        }
    }

    private static Reclaimed reclaimOne(DriveSenseStorageCoordinator coordinator)throws Exception{
        Reclaimed geometry=coordinator.read(db->{
            Reclaimed row=geometryCandidate(db,"commit_state='STAGED'",null);
            if(row==null)row=geometryCandidate(db,"commit_state='COMMITTED' AND NOT EXISTS (SELECT 1 FROM p6_manifests m WHERE m.domain_id='D2_GEOMETRY' AND m.subject_id=p6_geometry_chunks.trip_id AND m.content_version=p6_geometry_chunks.content_version AND m.complete=1)",null);
            if(row==null)row=geometryCandidate(db,"commit_state='COMMITTED' AND ordinal=-1","D2_GEOMETRY");
            return row;
        });
        if(geometry!=null){
            if(geometry.demoteDomain!=null)coordinator.write(db->{db.beginTransaction();try{
                db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,updated_at_ms=? WHERE domain_id=? AND subject_id=?",new Object[]{System.currentTimeMillis(),geometry.demoteDomain,geometry.tripId});
                db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,storage_outcome='DERIVED_RECLAIMED',updated_at_ms=? WHERE domain_id=?",new Object[]{System.currentTimeMillis(),geometry.demoteDomain});
                db.execSQL("UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? WHERE trip_id=?",new Object[]{System.currentTimeMillis(),geometry.tripId});
                db.setTransactionSuccessful();return null;
            }finally{db.endTransaction();}});
            // The wrapped-key reference remains counted until the ciphertext is
            // actually gone. A crash after unlink leaves an over-counted row,
            // which is safe and repairable; it never leaves uncounted bytes.
            if(!DriveSenseP6DerivedBlobStore.deleteFile(coordinator.context(),geometry.relativePath))return null;
            return coordinator.write(db->{db.beginTransaction();try{
                int removed=db.delete("p6_geometry_chunks","relative_path=? AND trip_id=? AND content_version=? AND ordinal=? AND key_version=?",new String[]{geometry.relativePath,geometry.tripId,geometry.contentVersion,Integer.toString(geometry.ordinal),Integer.toString(geometry.keyVersion)});
                if(removed==1)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",geometry.keyVersion,-1);
                db.setTransactionSuccessful();return removed==1?geometry:null;
            }finally{db.endTransaction();}});
        }
        return coordinator.write(db->{db.beginTransaction();try{
            try(Cursor c=db.rawQuery("SELECT archive_generation,trip_id,source_revision,ordinal,key_version FROM p6_road_observations WHERE record_kind='SOURCE_POINT_SPILL' ORDER BY updated_at_ms,trip_id,ordinal LIMIT 1",null)){if(c.moveToFirst()){db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND subject_id=?",new Object[]{System.currentTimeMillis(),c.getString(1)});db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,storage_outcome='DERIVED_RECLAIMED',updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",new Object[]{System.currentTimeMillis()});db.execSQL("UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? WHERE trip_id=?",new Object[]{System.currentTimeMillis(),c.getString(1)});db.delete("p6_road_observations","archive_generation=? AND trip_id=? AND source_revision=? AND ordinal=?",new String[]{c.getString(0),c.getString(1),Integer.toString(c.getInt(2)),Integer.toString(c.getInt(3))});if(!c.isNull(4))DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",c.getInt(4),-1);db.setTransactionSuccessful();return new Reclaimed(null,c.getString(1),"",c.getInt(3),c.isNull(4)?0:c.getInt(4),"D4_ROAD_LEARNING_SPEED_LOOKUP");}}
            db.setTransactionSuccessful();return null;
        }finally{db.endTransaction();}});
    }

    private static Reclaimed geometryCandidate(SQLiteDatabase db,String where,String demote)throws Exception{
        try(Cursor c=db.rawQuery("SELECT relative_path,trip_id,content_version,ordinal,key_version FROM p6_geometry_chunks WHERE "+where+" ORDER BY updated_at_ms,trip_id,ordinal LIMIT 1",null)){return c.moveToFirst()?new Reclaimed(c.getString(0),c.getString(1),c.getString(2),c.getInt(3),c.getInt(4),demote):null;}
    }

    private static final class Reclaimed{final String relativePath,tripId,contentVersion,demoteDomain;final int ordinal,keyVersion;Reclaimed(String path,String trip,String version,int ordinal,int key,String domain){this.relativePath=path;this.tripId=trip;this.contentVersion=version;this.ordinal=ordinal;this.keyVersion=key;this.demoteDomain=domain;}}

    /** Called inside the canonical trip commit transaction. Failure fails that commit. */
    static void markTripDesired(SQLiteDatabase db, String tripId, int revision, byte[] sourceHash,
                                long desiredSeq, String disposition) {
        String generation = scalar(db, "SELECT archive_generation FROM archive_meta WHERE id=1");
        ContentValues row = new ContentValues();
        row.put("trip_id", tripId);
        row.put("archive_generation", generation);
        row.put("desired_revision", revision);
        row.put("source_hash", sourceHash);
        row.put("desired_seq", desiredSeq);
        row.put("disposition", disposition == null ? "UPSERT" : disposition);
        row.put("dirty_domains", "D1_ANALYTICS,D2_GEOMETRY,D3_SPATIAL_SELECTION,D4_ROAD_LEARNING_SPEED_LOOKUP");
        row.put("state", "DIRTY");
        row.putNull("cursor");
        row.put("updated_at_ms", System.currentTimeMillis());
        if (db.insertWithOnConflict("p6_trip_work", null, row, SQLiteDatabase.CONFLICT_REPLACE) < 0) {
            throw new IllegalStateException("P6_TRIP_WORK_MARKER_FAILED");
        }
        dirty(db, "D1_ANALYTICS", generation, desiredSeq, disposition);
        dirty(db, "D2_GEOMETRY", generation, desiredSeq, disposition);
        dirty(db, "D3_SPATIAL_SELECTION", generation, desiredSeq, disposition);
        dirty(db, "D4_ROAD_LEARNING_SPEED_LOOKUP", generation, desiredSeq, disposition);
    }

    static void markTripTombstone(SQLiteDatabase db, String tripId, int priorRevision,
                                  byte[] sourceHash, long desiredSeq) {
        markTripDesired(db, tripId, priorRevision, sourceHash, desiredSeq, "TOMBSTONE");
    }

    /** Generation erasure invalidates and removes every rebuildable identity in one owner transaction. */
    static void eraseTripDerivedForGeneration(SQLiteDatabase db) {
        try (Cursor refs = db.rawQuery(
            "SELECT key_version,COUNT(*) FROM p6_geometry_chunks GROUP BY key_version", null)) {
            while (refs.moveToNext()) {
                DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
            }
        }
        try (Cursor refs = db.rawQuery(
            "SELECT key_version,COUNT(*) FROM p6_road_observations WHERE key_version IS NOT NULL GROUP BY key_version", null)) {
            while (refs.moveToNext()) {
                DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
            }
        }
        try (Cursor refs = db.rawQuery(
            "SELECT key_version,COUNT(*) FROM p6_road_windows GROUP BY key_version", null)) {
            while (refs.moveToNext()) {
                DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
            }
        }
        try (Cursor refs = db.rawQuery(
            "SELECT key_version,COUNT(*) FROM p6_spatial_secrets GROUP BY key_version", null)) {
            while (refs.moveToNext()) {
                DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
            }
        }
        try (Cursor refs = db.rawQuery(
            "SELECT key_version,COUNT(*) FROM p6_selection_requests GROUP BY key_version", null)) {
            while (refs.moveToNext()) {
                DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
            }
        }
        for (String table : new String[]{"p6_trip_contributions", "p6_analytics_buckets"}) {
            try (Cursor refs = db.rawQuery(
                "SELECT key_version,COUNT(*) FROM " + table + " WHERE key_version IS NOT NULL GROUP BY key_version", null)) {
                while (refs.moveToNext()) {
                    DriveSenseKeyReferenceCounts.adjust(db, "trip_derived", refs.getInt(0), -refs.getLong(1));
                }
            }
        }
        for (String table : new String[]{"p6_trip_work", "p6_source_applied", "p6_trip_contributions",
            "p6_analytics_buckets", "p6_recent_order", "p6_geometry_chunks",
            "p6_trip_spatial_postings", "p6_road_observations", "p6_road_windows", "p6_manifests"}) {
            db.delete(table, null, null);
        }
        db.delete("p6_spatial_secrets",null,null);
        db.delete("p6_selection_candidates",null,null);
        db.delete("p6_selection_requests",null,null);
        long now = System.currentTimeMillis();
        db.execSQL("UPDATE p6_control SET source_binding=NULL,required_version=0,applied_version=0,state='REBUILD_REQUIRED',complete=0,cursor=NULL,storage_outcome=NULL,updated_at_ms=? WHERE domain_id IN ('D1_ANALYTICS','D2_GEOMETRY','D3_SPATIAL_SELECTION')",
            new Object[]{now});
        DriveSenseKeyReferenceCounts.markVerified(db);
    }

    static String createRepair(SQLiteDatabase db, String tripGeneration, String speedGeneration,
                               String contentVersion, String publicationTarget) {
        String operation = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        db.execSQL("INSERT INTO p6_component_repairs(repair_operation_id,trip_generation,speed_generation,algorithm_version,component_content_version,round,state,observation_cursor,publication_target,updated_at_ms) VALUES(?,?,?,?,?,0,'READY',NULL,?,?)",
            new Object[]{operation, tripGeneration, speedGeneration, 1, contentVersion, publicationTarget, now});
        return operation;
    }

    /** Adds each candidate at most once per round; the primary key is the replay receipt. */
    static void addRepairFrontier(SQLiteDatabase db, String operation, int round, String candidateId) {
        if (round < 0 || round >= MAX_AUTOMATIC_REPAIR_ROUNDS) {
            db.execSQL("UPDATE p6_component_repairs SET state='REPAIR_ESCALATED',updated_at_ms=? WHERE repair_operation_id=?",
                new Object[]{System.currentTimeMillis(), operation});
            return;
        }
        db.execSQL("INSERT OR IGNORE INTO p6_component_frontier(repair_operation_id,round,candidate_id,state,updated_at_ms) VALUES(?, ?, ?, 'READY', ?)",
            new Object[]{operation, round, candidateId, System.currentTimeMillis()});
    }

    static JSONObject beginRepair(DriveSenseTripArchiveRepository repository,JSONArray candidateIds)throws Exception{
        return repository.coordinator().write(db->{
            String existing=null;try(Cursor c=db.rawQuery("SELECT repair_operation_id FROM p6_component_repairs WHERE state IN ('READY','RUNNING') ORDER BY updated_at_ms LIMIT 1",null)){if(c.moveToFirst())existing=c.getString(0);}
            if(existing==null){String tripGeneration=scalar(db,"SELECT archive_generation FROM archive_meta WHERE id=1");String speedGeneration=scalar(db,"SELECT speed_generation FROM speed_state WHERE id=1");existing=createRepair(db,tripGeneration,speedGeneration,UUID.randomUUID().toString(),"SCOPED_SPEED_OWNER");}
            for(int index=0;candidateIds!=null&&index<Math.min(128,candidateIds.length());index++){String id=candidateIds.optString(index,"").trim();if(!id.isEmpty())addRepairFrontier(db,existing,0,id);}
            JSONObject out=new JSONObject();out.put("state","READY");out.put("repairOperationId",existing);out.put("itemsWorked",candidateIds==null?0:Math.min(128,candidateIds.length()));out.put("bytesWorked",0);out.put("hasMore",true);return out;
        });
    }

    static JSONObject stepRepair(DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().write(db->{
            String operation=null,tripGeneration=null,speedGeneration=null;int round=0;
            try(Cursor c=db.rawQuery("SELECT repair_operation_id,trip_generation,speed_generation,round FROM p6_component_repairs WHERE state IN ('READY','RUNNING') ORDER BY updated_at_ms LIMIT 1",null)){if(c.moveToFirst()){operation=c.getString(0);tripGeneration=c.getString(1);speedGeneration=c.getString(2);round=c.getInt(3);}}
            if(operation==null)return repairResult("IDLE",null,null,0,0,false);
            if(!tripGeneration.equals(scalar(db,"SELECT archive_generation FROM archive_meta WHERE id=1"))||!speedGeneration.equals(scalar(db,"SELECT speed_generation FROM speed_state WHERE id=1"))){db.execSQL("UPDATE p6_component_repairs SET state='REPAIR_ESCALATED',updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("REPAIR_ESCALATED",operation,null,round,1,false);}
            String candidate=null;try(Cursor c=db.rawQuery("SELECT candidate_id FROM p6_component_frontier WHERE repair_operation_id=? AND round=? AND state='READY' ORDER BY candidate_id LIMIT 1",new String[]{operation,Integer.toString(round)})){if(c.moveToFirst())candidate=c.getString(0);}
            if(candidate!=null){db.execSQL("UPDATE p6_component_repairs SET state='RUNNING',updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("REPAIR_PAGE",operation,candidate,round,1,true);}
            if(round==0){db.execSQL("UPDATE p6_component_repairs SET round=1,state='READY',updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("ROUND_COMPLETE",operation,null,1,1,true);}
            db.execSQL("UPDATE p6_component_repairs SET state='COMPLETE',updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("COMPLETE",operation,null,round,1,false);
        });
    }

    static JSONObject acknowledgeRepair(DriveSenseTripArchiveRepository repository,String operation,String candidateId,int round,JSONArray discovered)throws Exception{
        return repository.coordinator().write(db->{
            int changed=db.update("p6_component_frontier",values("state","PROCESSED"),"repair_operation_id=? AND round=? AND candidate_id=? AND state='READY'",new String[]{operation,Integer.toString(round),candidateId});
            if(changed!=1)throw new IllegalStateException("P6_REPAIR_ACK_STALE");boolean expanded=false;
            for(int index=0;discovered!=null&&index<Math.min(128,discovered.length());index++){String id=discovered.optString(index,"").trim();if(id.isEmpty())continue;if(round==0)addRepairFrontier(db,operation,1,id);else{try(Cursor c=db.rawQuery("SELECT 1 FROM p6_component_frontier WHERE repair_operation_id=? AND candidate_id=? LIMIT 1",new String[]{operation,id})){if(!c.moveToFirst())expanded=true;}}}
            if(expanded){db.execSQL("UPDATE p6_component_repairs SET state='REPAIR_ESCALATED',updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("REPAIR_ESCALATED",operation,candidateId,round,changed,false);}
            db.execSQL("UPDATE p6_component_repairs SET updated_at_ms=? WHERE repair_operation_id=?",new Object[]{System.currentTimeMillis(),operation});return repairResult("ACKNOWLEDGED",operation,candidateId,round,changed,true);
        });
    }

    private static ContentValues values(String key,String value){ContentValues out=new ContentValues();out.put(key,value);out.put("updated_at_ms",System.currentTimeMillis());return out;}
    private static JSONObject repairResult(String state,String operation,String candidate,int round,int items,boolean more)throws Exception{JSONObject out=new JSONObject();out.put("state",state);if(operation!=null)out.put("repairOperationId",operation);if(candidate!=null)out.put("candidateId",candidate);out.put("round",round);out.put("itemsWorked",items);out.put("bytesWorked",0);out.put("hasMore",more);return out;}

    private static void dirty(SQLiteDatabase db, String domain, String binding, long required, String reason) {
        db.execSQL("UPDATE p6_control SET source_binding=?,required_version=MAX(required_version,?),state='DIRTY',complete=0,cursor=?,updated_at_ms=? WHERE domain_id=?",
            new Object[]{binding, required, reason, System.currentTimeMillis(), domain});
    }

    private static String scalar(SQLiteDatabase db, String sql) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("P6_SOURCE_BINDING_MISSING");
            return cursor.getString(0);
        }
    }

    static final class DerivedStorageBlockedException extends IllegalStateException {
        final long availableBytes, proposedBytes, reserveBytes;
        DerivedStorageBlockedException(long availableBytes, long proposedBytes, long reserveBytes) {
            super("DERIVED_STORAGE_BLOCKED");
            this.availableBytes = availableBytes;
            this.proposedBytes = proposedBytes;
            this.reserveBytes = reserveBytes;
        }
    }
}
