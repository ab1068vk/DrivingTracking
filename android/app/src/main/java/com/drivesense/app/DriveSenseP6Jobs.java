package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Bounded native P6 entry points registered through the existing P4 coordinator. */
final class DriveSenseP6Jobs {
    private static volatile String testFaultPoint;
    private DriveSenseP6Jobs(){}

    static void setFaultPointForTests(String point){testFaultPoint=point;}
    private static void injectFault(String point){
        if(point.equals(testFaultPoint)){
            testFaultPoint=null;
            throw new IllegalStateException("TEST_FAULT:"+point);
        }
    }

    static JSONObject stepTripDerived(DriveSenseTripArchiveRepository repository)throws Exception{
        try{return stepTripDerivedInternal(repository);}
        catch(DriveSenseP6DerivedState.DerivedStorageBlockedException blocked){
            return storageBlocked(repository,new String[]{"D1_ANALYTICS","D2_GEOMETRY","D3_SPATIAL_SELECTION",
                "D4_ROAD_LEARNING_SPEED_LOOKUP"},blocked);
        }
    }

    private static JSONObject stepTripDerivedInternal(DriveSenseTripArchiveRepository repository)throws Exception{
        Work work=firstWork(repository);
        if(work==null){
            JSONObject discovery=stepAnalyticsSettingsRediscovery(repository);
            if(!"IDLE".equals(discovery.optString("state")))return discovery;
            return finalizeIncrementalTripDomains(repository);
        }
        if("TOMBSTONE".equals(work.disposition))return cleanupTombstone(repository,work);
        if("DIRTY".equals(work.state))return initialize(repository,work);
        if(work.cursor!=null&&!work.cursor.isEmpty()
            &&"PREVIEW".equals(new JSONObject(work.cursor).optString("phase")))
            return previewTurn(repository,work,new JSONObject(work.cursor));
        return extractPage(repository,work);
    }

    /** Invalidate D1 for a new exact settings/vehicle fingerprint. History
     * discovery remains bounded and is resumed by the ordinary J1 owner. */
    static JSONObject invalidateAnalyticsForSettings(DriveSenseTripArchiveRepository repository,
                                                      String settingsVersion,String reason)throws Exception{
        if(settingsVersion==null||settingsVersion.isEmpty())
            throw new IllegalArgumentException("P6_SETTINGS_VERSION_REQUIRED");
        return repository.coordinator().write(db->{
            long now=System.currentTimeMillis();
            db.execSQL("UPDATE p6_control SET settings_version=?,state='REBUILD_REQUIRED',complete=0,"+
                "cursor='',storage_outcome=?,updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",
                new Object[]{settingsVersion,"ANALYTICS_SETTINGS_CHANGED:"+(reason==null?"":reason),now});
            db.execSQL("UPDATE p6_manifests SET state='DIRTY',complete=0,updated_at_ms=? "+
                "WHERE domain_id='D1_ANALYTICS'",new Object[]{now});
            JSONObject out=result("REBUILD_REQUIRED",2,settingsVersion.length(),true);
            out.put("settingsVersion",settingsVersion);return out;
        });
    }

    private static JSONObject stepAnalyticsSettingsRediscovery(
            DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String cursor=null,storageOutcome=null;
                try(Cursor control=db.rawQuery("SELECT cursor,storage_outcome FROM p6_control "+
                    "WHERE domain_id='D1_ANALYTICS' AND state='REBUILD_REQUIRED'",null)){
                    if(!control.moveToFirst())return result("IDLE",0,0,false);
                    cursor=control.getString(0);storageOutcome=control.getString(1);
                }
                if(storageOutcome==null||!storageOutcome.startsWith("ANALYTICS_SETTINGS_CHANGED:"))
                    return result("IDLE",0,0,false);
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                java.util.List<Work> rows=new java.util.ArrayList<>();
                try(Cursor source=db.rawQuery("SELECT t.trip_id,t.revision,t.seq,r.payload_hash FROM trip_current t "+
                    "JOIN trip_revisions r ON r.trip_id=t.trip_id AND r.revision=t.revision "+
                    "WHERE t.trip_id>? AND r.commit_state='COMMITTED' ORDER BY t.trip_id LIMIT 33",
                    new String[]{cursor==null?"":cursor})){
                    while(source.moveToNext())rows.add(new Work(source.getString(0),generation,source.getInt(1),
                        source.getLong(2),"UPSERT","DIRTY",null,source.getBlob(3)));
                }
                int count=Math.min(32,rows.size());long bytes=0,now=System.currentTimeMillis();
                for(int index=0;index<count;index++){
                    Work row=rows.get(index);ContentValues value=new ContentValues();
                    value.put("trip_id",row.tripId);value.put("archive_generation",row.generation);
                    value.put("desired_revision",row.revision);value.put("source_hash",row.sourceHash);
                    value.put("desired_seq",row.desiredSeq);value.put("disposition","UPSERT");
                    value.put("dirty_domains","D1_ANALYTICS");value.put("state","DIRTY");
                    value.putNull("cursor");value.put("updated_at_ms",now);
                    db.insertWithOnConflict("p6_trip_work",null,value,SQLiteDatabase.CONFLICT_REPLACE);
                    bytes+=row.sourceHash==null?0:row.sourceHash.length;
                }
                boolean more=rows.size()>32;
                if(more)db.execSQL("UPDATE p6_control SET cursor=?,updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",
                    new Object[]{rows.get(count-1).tripId,now});
                else db.execSQL("UPDATE p6_control SET state='DIRTY',cursor=NULL,"+
                    "storage_outcome='SETTINGS_REDISCOVERY_COMPLETE',updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",
                    new Object[]{now});
                db.setTransactionSuccessful();
                return result(more?"SETTINGS_REDISCOVERY":"SETTINGS_REDISCOVERY_COMPLETE",count+1,bytes,true);
            }finally{db.endTransaction();}
        });
    }

    /** A normal source mutation dirties heads and queues its exact revision in
     * one canonical transaction. Once that queue drains, re-verify only those
     * dirty heads; an untouched upgrade-time REBUILD_REQUIRED head is excluded. */
    private static JSONObject finalizeIncrementalTripDomains(
            DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                long pending=scalarLong(db,"SELECT COUNT(*) FROM p6_trip_work WHERE state IN "+
                    "('DIRTY','BUILDING','TOMBSTONE_CLEANUP')");
                if(pending!=0)return result("IDLE",0,0,false);
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                long required=scalarLong(db,"SELECT last_committed_seq FROM archive_meta WHERE id=1");
                long now=System.currentTimeMillis(),verified=0;
                for(String domain:new String[]{"D1_ANALYTICS","D2_GEOMETRY","D3_SPATIAL_SELECTION"}){
                    String state=null,outcome=null,settings=null;
                    try(Cursor control=db.rawQuery("SELECT state,storage_outcome,settings_version FROM p6_control WHERE domain_id=?",
                        new String[]{domain})){if(control.moveToFirst()){
                            state=control.getString(0);outcome=control.getString(1);settings=control.getString(2);
                        }}
                    boolean eligible="DIRTY".equals(state)||"PARTIAL".equals(state);
                    if("D1_ANALYTICS".equals(domain)&&outcome!=null&&outcome.startsWith("PRIOR_CONTRIBUTION_MISSING"))
                        eligible=false;
                    if(!eligible)continue;
                    String settingsClause="";
                    String[]args=new String[]{generation,domain};
                    if("D1_ANALYTICS".equals(domain)){
                        if(settings==null)settingsClause=" AND a.settings_version IS NULL";
                        else{
                            settingsClause=" AND a.settings_version=?";
                            args=new String[]{generation,domain,settings};
                        }
                    }
                    String sql="SELECT COUNT(*) FROM trip_current t WHERE NOT EXISTS (SELECT 1 FROM p6_source_applied a "+
                        "WHERE a.archive_generation=? AND a.trip_id=t.trip_id AND a.source_revision=t.revision "+
                        "AND a.source_hash=(SELECT payload_hash FROM trip_revisions r WHERE r.trip_id=t.trip_id "+
                        "AND r.revision=t.revision) AND a.domain_id=?"+settingsClause+")";
                    long uncovered=count(db,sql,args);
                    if(uncovered==0){
                        db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,applied_version=?,"+
                            "state='VERIFIED',complete=1,writers_enabled=1,cursor=NULL,storage_outcome=NULL,"+
                            "updated_at_ms=? WHERE domain_id=?",new Object[]{generation,required,required,now,domain});
                        verified++;
                    }
                }
                db.setTransactionSuccessful();
                return result(verified>0?"VERIFIED":"IDLE",verified,0,false);
            }finally{db.endTransaction();}
        });
    }

    /** Queue one bounded explicit-history page from native canonical authority. */
    static JSONObject queueExplicitTripSubjects(DriveSenseTripArchiveRepository repository,
                                                JSONArray tripIds,boolean includeRoad)throws Exception{
        if(tripIds==null||tripIds.length()>64)
            throw new IllegalArgumentException("P6_EXPLICIT_SUBJECT_PAGE_OUT_OF_RANGE");
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                String analyticsSettings=null;
                try(Cursor control=db.rawQuery("SELECT settings_version FROM p6_control WHERE domain_id='D1_ANALYTICS'",null)){
                    if(control.moveToFirst())analyticsSettings=control.getString(0);
                }
                long queued=0,bytes=0,now=System.currentTimeMillis();
                String speedGeneration=includeRoad
                    ?scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1"):null;
                for(int index=0;index<tripIds.length();index++){
                    String tripId=tripIds.optString(index,"");
                    if(tripId.isEmpty())continue;
                    try(Cursor c=db.rawQuery("SELECT t.revision,t.seq,r.payload_hash FROM trip_current t "+
                        "JOIN trip_revisions r ON r.trip_id=t.trip_id AND r.revision=t.revision "+
                        "WHERE t.trip_id=? AND r.commit_state='COMMITTED'",new String[]{tripId})){
                        if(!c.moveToFirst())continue;
                        int revision=c.getInt(0);long seq=c.getLong(1);byte[]hash=c.getBlob(2);
                        boolean current=false;
                        try(Cursor applied=db.rawQuery("SELECT 1 FROM p6_source_applied WHERE archive_generation=? "+
                            "AND trip_id=? AND source_revision=? AND hex(source_hash)=? AND domain_id IN "+
                            "('D1_ANALYTICS','D2_GEOMETRY','D3_SPATIAL_SELECTION') GROUP BY trip_id HAVING COUNT(*)=3",
                            new String[]{generation,tripId,Integer.toString(revision),
                                DriveSenseEnvelopeCrypto.hex(hash).toUpperCase(java.util.Locale.ROOT)})){
                            current=applied.moveToFirst();
                        }catch(Exception ignored){ current=false; }
                        if(current)try(Cursor analytics=db.rawQuery("SELECT 1 FROM p6_source_applied WHERE "+
                            "archive_generation=? AND trip_id=? AND domain_id='D1_ANALYTICS' AND settings_version IS ?",
                            new String[]{generation,tripId,analyticsSettings})){
                            current=analytics.moveToFirst();
                        }
                        if(current&&includeRoad)try(Cursor road=db.rawQuery("SELECT 1 FROM p6_source_applied WHERE "+
                            "archive_generation=? AND trip_id=? AND source_revision=? AND hex(source_hash)=? "+
                            "AND domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND settings_version=?",
                            new String[]{generation,tripId,Integer.toString(revision),
                                DriveSenseEnvelopeCrypto.hex(hash).toUpperCase(java.util.Locale.ROOT),speedGeneration})){
                            current=road.moveToFirst();
                        }
                        if(current)continue;
                        ContentValues row=new ContentValues();row.put("trip_id",tripId);
                        row.put("archive_generation",generation);row.put("desired_revision",revision);
                        row.put("source_hash",hash);row.put("desired_seq",seq);row.put("disposition","UPSERT");
                        row.put("dirty_domains","D1_ANALYTICS,D2_GEOMETRY,D3_SPATIAL_SELECTION,D4_ROAD_LEARNING_SPEED_LOOKUP");
                        row.put("state","DIRTY");row.putNull("cursor");row.put("updated_at_ms",now);
                        db.insertWithOnConflict("p6_trip_work",null,row,SQLiteDatabase.CONFLICT_REPLACE);
                        if(includeRoad){
                            int retired=db.delete("p6_observation_applied",
                                "trip_generation=? AND trip_id=? AND bucket_id LIKE 'CAPACITY_BLOCKED:%'",
                                new String[]{generation,tripId});
                            // Explicit E2 is the deliberate retry authority. Retiring a
                            // target's blocked receipts must retire the disposition those
                            // receipts produced, or the re-evaluated target could never
                            // publish. A trip with no blocked receipt changes nothing.
                            if(retired>0){
                                db.execSQL("UPDATE p6_control SET state='DIRTY',complete=0,updated_at_ms=? "+
                                    "WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND state='CAPACITY_BLOCKED'",
                                    new Object[]{now});
                                db.execSQL("UPDATE p6_manifests SET state='DIRTY',complete=0,updated_at_ms=? "+
                                    "WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND subject_id=? "+
                                    "AND state='CAPACITY_BLOCKED'",new Object[]{now,tripId});
                            }
                        }
                        queued++;bytes+=hash==null?0:hash.length;
                    }
                }
                db.setTransactionSuccessful();
                JSONObject out=result("QUEUED",queued+tripIds.length(),bytes,queued>0);
                out.put("queued",queued);return out;
            }finally{db.endTransaction();}
        });
    }

    /** Activate only after a database proof covers every live current revision. */
    static JSONObject resetAnalyticsDerived(DriveSenseTripArchiveRepository repository,
                                             String phase)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String current=phase==null||phase.isEmpty()?"CONTRIBUTIONS":phase;
                long items=0,bytes=0;String next=current;
                if("CONTRIBUTIONS".equals(current)){
                    java.util.List<String>ids=new java.util.ArrayList<>();
                    try(Cursor c=db.rawQuery("SELECT trip_id,length(payload),key_version FROM p6_trip_contributions ORDER BY trip_id LIMIT 128",null)){
                        while(c.moveToNext()){ids.add(c.getString(0));bytes+=c.getLong(1);
                            if(!c.isNull(2))DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",c.getInt(2),-1);
                        }
                    }
                    for(String id:ids){
                        db.delete("p6_trip_contributions","trip_id=?",new String[]{id});
                        db.delete("p6_recent_order","trip_id=?",new String[]{id});
                        db.delete("p6_source_applied","trip_id=? AND domain_id='D1_ANALYTICS'",new String[]{id});
                        db.delete("p6_manifests","subject_id=? AND domain_id='D1_ANALYTICS'",new String[]{id});
                    }
                    items=ids.size();next=ids.size()==128?"CONTRIBUTIONS":"BUCKETS";
                }else if("BUCKETS".equals(current)){
                    long count=scalarLong(db,"SELECT COUNT(*) FROM (SELECT rowid FROM p6_analytics_buckets LIMIT 128)");
                    bytes=scalarLong(db,"SELECT COALESCE(SUM(length(payload)),0) FROM (SELECT payload FROM p6_analytics_buckets LIMIT 128)");
                    try(Cursor refs=db.rawQuery("SELECT key_version,COUNT(*) FROM (SELECT key_version FROM p6_analytics_buckets LIMIT 128) GROUP BY key_version",null)){
                        while(refs.moveToNext()&&!refs.isNull(0))
                            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",refs.getInt(0),-refs.getLong(1));
                    }
                    db.execSQL("DELETE FROM p6_analytics_buckets WHERE rowid IN (SELECT rowid FROM p6_analytics_buckets LIMIT 128)");
                    items=count;next=count==128?"BUCKETS":"CONTROL";
                }else{
                    long now=System.currentTimeMillis();
                    db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,cursor=NULL,storage_outcome='E1_EXACT_REBUILD',updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",new Object[]{now});
                    db.delete("p6_manifests","domain_id='D1_ANALYTICS'",null);
                    items=2;next="COMPLETE";
                }
                db.setTransactionSuccessful();
                JSONObject out=result("COMPLETE".equals(next)?"RESET_COMPLETE":"RESETTING",items,bytes,!"COMPLETE".equals(next));
                out.put("phase",next);return out;
            }finally{db.endTransaction();}
        });
    }

    /** Activate only after a database proof covers every live current revision. */
    static JSONObject finalizeExplicitTripBuild(DriveSenseTripArchiveRepository repository,
                                                boolean includeRoad)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                String speedGeneration=scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1");
                String analyticsSettings=null;
                try(Cursor control=db.rawQuery("SELECT settings_version FROM p6_control WHERE domain_id='D1_ANALYTICS'",null)){
                    if(control.moveToFirst())analyticsSettings=control.getString(0);
                }
                long required=scalarLong(db,"SELECT last_committed_seq FROM archive_meta WHERE id=1");
                long pending=scalarLong(db,includeRoad
                    ?"SELECT COUNT(*) FROM p6_trip_work WHERE state!='ROAD_COMPLETE'"
                    :"SELECT COUNT(*) FROM p6_trip_work WHERE state NOT IN ('COMPLETE','ROAD_COMPLETE')");
                long uncovered=scalarLong(db,"SELECT COUNT(*) FROM trip_current t WHERE NOT EXISTS ("+
                    "SELECT 1 FROM p6_source_applied a WHERE a.archive_generation='"+sqlLiteral(generation)+"' "+
                    "AND a.trip_id=t.trip_id AND a.source_revision=t.revision AND a.source_hash=("+
                    "SELECT payload_hash FROM trip_revisions r WHERE r.trip_id=t.trip_id AND r.revision=t.revision) "+
                    "AND a.domain_id='D1_ANALYTICS' AND a.settings_version IS "+sqlNullableLiteral(analyticsSettings)+") OR NOT EXISTS (SELECT 1 FROM p6_source_applied a "+
                    "WHERE a.archive_generation='"+sqlLiteral(generation)+"' AND a.trip_id=t.trip_id "+
                    "AND a.source_revision=t.revision AND a.source_hash=(SELECT payload_hash FROM trip_revisions r "+
                    "WHERE r.trip_id=t.trip_id AND r.revision=t.revision) AND a.domain_id='D2_GEOMETRY')");
                long spatialUncovered=includeRoad?scalarLong(db,"SELECT COUNT(*) FROM trip_current t WHERE NOT EXISTS ("+
                    "SELECT 1 FROM p6_source_applied a WHERE a.archive_generation='"+sqlLiteral(generation)+"' "+
                    "AND a.trip_id=t.trip_id AND a.source_revision=t.revision AND a.source_hash=(SELECT payload_hash "+
                    "FROM trip_revisions r WHERE r.trip_id=t.trip_id AND r.revision=t.revision) "+
                    "AND a.domain_id='D3_SPATIAL_SELECTION')"):0;
                long roadUncovered=includeRoad?scalarLong(db,"SELECT COUNT(*) FROM trip_current t WHERE NOT EXISTS ("+
                    "SELECT 1 FROM p6_source_applied a WHERE a.archive_generation='"+sqlLiteral(generation)+"' "+
                    "AND a.trip_id=t.trip_id AND a.source_revision=t.revision AND a.domain_id="+
                    "'D4_ROAD_LEARNING_SPEED_LOOKUP' AND a.settings_version='"+sqlLiteral(speedGeneration)+"')"):0;
                boolean ready=pending==0&&uncovered==0&&spatialUncovered==0&&roadUncovered==0;
                long now=System.currentTimeMillis();
                if(ready){
                    String[]domains=includeRoad
                        ?new String[]{"D1_ANALYTICS","D2_GEOMETRY","D3_SPATIAL_SELECTION"}
                        :new String[]{"D1_ANALYTICS","D2_GEOMETRY"};
                    for(String domain:domains)
                        db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,applied_version=?,"+
                            "state='VERIFIED',complete=1,writers_enabled=1,cursor=NULL,updated_at_ms=? WHERE domain_id=?",
                            new Object[]{generation,required,required,now,domain});
                    if(includeRoad)db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,"+
                        "applied_version=?,state='VERIFIED',complete=1,writers_enabled=1,cursor=NULL,updated_at_ms=? "+
                        "WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",
                        new Object[]{generation,required,required,now});
                }
                db.setTransactionSuccessful();
                JSONObject out=result(ready?"VERIFIED":"PARTIAL",3,0,!ready);
                out.put("complete",ready);out.put("pending",pending);out.put("uncovered",uncovered);
                out.put("spatialUncovered",spatialUncovered);out.put("roadUncovered",roadUncovered);
                return out;
            }finally{db.endTransaction();}
        });
    }

    static JSONObject stepRoadMemory(DriveSenseTripArchiveRepository repository)throws Exception{
        try{return stepRoadMemoryInternal(repository);}
        catch(DriveSenseP6DerivedState.DerivedStorageBlockedException blocked){
            return storageBlocked(repository,new String[]{"D4_ROAD_LEARNING_SPEED_LOOKUP"},blocked);
        }
    }

    private static JSONObject stepRoadMemoryInternal(DriveSenseTripArchiveRepository repository)throws Exception{
        Work work=firstRoadWork(repository);
        if(work==null)return finalizeIncrementalRoadDomain(repository);
        JSONObject cursor=work.cursor==null||work.cursor.isEmpty()?new JSONObject():new JSONObject(work.cursor);
        String phase=cursor.optString("phase","ROAD_SCAN");
        if("ROAD_SCAN".equals(phase))return roadScanTurn(repository,work,cursor);
        if("ROAD_SELECT".equals(phase))return roadSelectTurn(repository,work,cursor);
        if("ROAD_GEOMETRY".equals(phase))return roadGeometryTurn(repository,work,cursor);
        if("ROAD_FINALIZE_ACK".equals(phase))return roadFinalizePage(repository,work,cursor);
        if("ROAD_APPLY".equals(phase))return roadApplyPage(repository,work,cursor);
        if("ROAD_APPLY_ACK".equals(phase))return roadApplyPage(repository,work,cursor);
        throw new IllegalStateException("P6_ROAD_CURSOR_INVALID");
    }

    private static JSONObject finalizeIncrementalRoadDomain(
            DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                long pending=scalarLong(db,"SELECT COUNT(*) FROM p6_trip_work WHERE state!='ROAD_COMPLETE'");
                String state=null;try(Cursor control=db.rawQuery("SELECT state FROM p6_control "+
                    "WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",null)){
                    if(control.moveToFirst())state=control.getString(0);
                }
                boolean eligible="DIRTY".equals(state)||"PARTIAL".equals(state);
                if(pending!=0||!eligible)return result("IDLE",0,0,false);
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                String speedGeneration=scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1");
                long uncovered=count(db,"SELECT COUNT(*) FROM trip_current t WHERE NOT EXISTS (SELECT 1 "+
                    "FROM p6_source_applied a WHERE a.archive_generation=? AND a.trip_id=t.trip_id "+
                    "AND a.source_revision=t.revision AND a.source_hash=(SELECT payload_hash FROM trip_revisions r "+
                    "WHERE r.trip_id=t.trip_id AND r.revision=t.revision) AND "+
                    "a.domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP' AND a.settings_version=?)",
                    new String[]{generation,speedGeneration});
                if(uncovered!=0)return result("IDLE",0,0,false);
                long required=scalarLong(db,"SELECT last_committed_seq FROM archive_meta WHERE id=1");
                db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,applied_version=?,"+
                    "state='VERIFIED',complete=1,writers_enabled=1,cursor=NULL,storage_outcome=NULL,"+
                    "updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",
                    new Object[]{generation,required,required,System.currentTimeMillis()});
                db.setTransactionSuccessful();return result("VERIFIED",1,0,false);
            }finally{db.endTransaction();}
        });
    }

    static JSONObject acknowledgeRoadMemory(DriveSenseTripArchiveRepository repository,
                                             String tripId,JSONObject input)throws Exception{
        Work work=roadWorkById(repository,tripId);
        if(work==null)throw new IllegalStateException("P6_ROAD_ACK_STALE");
        JSONObject cursor=work.cursor==null||work.cursor.isEmpty()?new JSONObject():new JSONObject(work.cursor);
        String phase=cursor.optString("phase","");
        if("ROAD_FINALIZE_ACK".equals(phase)){
            int ordinal=cursor.optInt("windowOrdinal",0);
            JSONObject observation=input.optJSONObject("observation");
            if(observation!=null){writeRoadObservationLedger(repository,work,ordinal,observation);writeRoadState(repository,work,"OUTPUT",ordinal,"READY",
                new JSONObject().put("observation",observation));}
            cursor=new JSONObject().put("phase","ROAD_SELECT").put("windowOrdinal",ordinal+1)
                .put("bit",0).put("sourceOrdinal",0);
            updateRoadCursor(repository,work,cursor);
            return result("WINDOW_FINALIZED",observation==null?2:3,
                observation==null?0:observation.toString().getBytes(StandardCharsets.UTF_8).length,true);
        }
        if("ROAD_APPLY_ACK".equals(phase)){
            int ordinal=cursor.optInt("outputOrdinal",0);
            if("CAPACITY_BLOCKED".equals(input.optString("disposition",""))){
                JSONObject blocked=input.optJSONObject("blockedTarget");
                if(blocked==null)blocked=new JSONObject();
                final JSONObject durableBlocked=blocked;
                String targetId=blocked.optString("targetId",work.tripId+":"+work.revision+":"+ordinal);
                String speedGeneration=repository.coordinator().read(db->scalarText(db,
                    "SELECT speed_generation FROM speed_state WHERE id=1"));
                repository.coordinator().write(db->{db.beginTransaction();try{
                    db.execSQL("INSERT OR REPLACE INTO p6_observation_applied(speed_generation,trip_generation,"+
                        "trip_id,source_revision,observation_ordinal,bucket_id,bucket_revision,updated_at_ms) "+
                        "VALUES(?,?,?,?,?,?,0,?)",new Object[]{speedGeneration,work.generation,work.tripId,
                        work.revision,ordinal,"CAPACITY_BLOCKED:"+targetId,System.currentTimeMillis()});
                    db.execSQL("UPDATE p6_control SET state='CAPACITY_BLOCKED',complete=0,storage_outcome=?,updated_at_ms=? "+
                        "WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",
                        new Object[]{durableBlocked.toString(),System.currentTimeMillis()});
                    manifest(db,"D4_ROAD_LEARNING_SPEED_LOOKUP",work,work.revision+":road-v1",
                        "CAPACITY_BLOCKED",false,System.currentTimeMillis());
                    db.setTransactionSuccessful();
                }finally{db.endTransaction();}return null;});
                updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_APPLY").put("outputOrdinal",ordinal+1));
                JSONObject out=result("CAPACITY_BLOCKED",1,blocked.optLong("encodedBytes",0),false);
                out.put("blockedTarget",blocked);return out;
            }
            String speedGeneration=input.optString("speedGeneration","");
            String bucketId=input.optString("bucketId","scoped");
            int bucketRevision=input.optInt("bucketRevision",0);
            if(speedGeneration.isEmpty())throw new IllegalArgumentException("P6_SPEED_GENERATION_REQUIRED");
            injectFault("BEFORE_SPEED_RECEIPT");
            repository.coordinator().write(db->{
                String currentSpeedGeneration=scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1");
                if(!speedGeneration.equals(currentSpeedGeneration))throw new IllegalStateException("P6_SPEED_GENERATION_CHANGED");
                db.execSQL("INSERT OR IGNORE INTO p6_observation_applied(speed_generation,trip_generation,"+
                    "trip_id,source_revision,observation_ordinal,bucket_id,bucket_revision,updated_at_ms) "+
                    "VALUES(?,?,?,?,?,?,?,?)",new Object[]{speedGeneration,work.generation,work.tripId,
                    work.revision,ordinal,bucketId,bucketRevision,System.currentTimeMillis()});return null;
            });
            injectFault("AFTER_SPEED_RECEIPT_BEFORE_CURSOR");
            cursor=new JSONObject().put("phase","ROAD_APPLY").put("outputOrdinal",ordinal+1);
            updateRoadCursor(repository,work,cursor);
            return result("OBSERVATION_APPLIED",2,0,true);
        }
        throw new IllegalStateException("P6_ROAD_ACK_NOT_EXPECTED");
    }

    private static void writeRoadObservationLedger(DriveSenseTripArchiveRepository repository,Work work,
                                                     int ordinal,JSONObject observation)throws Exception{
        JSONObject envelope=new JSONObject().put("observation",observation);byte[]plain=envelope.toString().getBytes(StandardCharsets.UTF_8);
        int storageOrdinal=1_000_000+ordinal;DriveSenseP6DerivedBlobStore.Prepared prepared=
            DriveSenseP6DerivedBlobStore.prepare(repository,work.generation,"trip_derived",work.tripId,
                work.revision,work.revision+":road-observation-v1",storageOrdinal,plain);
        try{repository.coordinator().write(db->{db.beginTransaction();try{if(!current(db,work))return null;
            replaceInlineDerived(db,work,storageOrdinal,"OBSERVATION",prepared);
            db.execSQL("UPDATE p6_road_observations SET commit_state='COMMITTED',point_start_ordinal=?,point_count=1 "+
                "WHERE archive_generation=? AND trip_id=? AND source_revision=? AND ordinal=?",new Object[]{ordinal,
                    work.generation,work.tripId,work.revision,storageOrdinal});db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});}finally{Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);}
    }

    private static Work firstRoadWork(DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT trip_id,archive_generation,desired_revision,desired_seq,"+
                "disposition,state,cursor,source_hash FROM p6_trip_work WHERE state='COMPLETE' "+
                "ORDER BY desired_seq,trip_id LIMIT 1",null)){return c.moveToFirst()?new Work(c.getString(0),
                    c.getString(1),c.getInt(2),c.getLong(3),c.getString(4),c.getString(5),c.getString(6),c.getBlob(7)):null;}
        });
    }

    private static Work roadWorkById(DriveSenseTripArchiveRepository repository,String tripId)throws Exception{
        return repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT trip_id,archive_generation,"+
            "desired_revision,desired_seq,disposition,state,cursor,source_hash FROM p6_trip_work "+
            "WHERE trip_id=? AND state='COMPLETE'",new String[]{tripId})){return c.moveToFirst()?new Work(
                c.getString(0),c.getString(1),c.getInt(2),c.getLong(3),c.getString(4),c.getString(5),
                c.getString(6),c.getBlob(7)):null;}});
    }

    private static JSONObject roadScanTurn(DriveSenseTripArchiveRepository repository,Work work,
                                           JSONObject cursor)throws Exception{
        int sourceOrdinal=cursor.optInt("sourceOrdinal",0);
        JSONObject reducer=readRoadState(repository,work,"REDUCER",-1);
        if(reducer==null)reducer=new JSONObject().put("summary",emptyRoadSummary()).put("windowOrdinal",0);
        JSONObject summary=reducer.optJSONObject("summary");if(summary==null)summary=emptyRoadSummary();
        int windowOrdinal=reducer.optInt("windowOrdinal",0);
        JSONObject source=readRoadSource(repository,work,sourceOrdinal);
        JSONArray windows=new JSONArray();long bytes=0;int pointCount=0;
        if(source!=null){
            JSONArray points=DriveSenseP6PointBlock.pointsOf(source);
            int pointStart=source.optInt("pointStartOrdinal",0);pointCount=points.length();bytes=source.toString().length();
            for(int index=0;index<points.length();index++){
                JSONObject point=points.optJSONObject(index);if(!roadUsable(point))continue;
                JSONObject last=summary.optJSONObject("lastPoint");
                if(last!=null&&roadDistance(last,point)>250d&&summary.optInt("usableCount",0)>0){
                    windows.put(new JSONObject().put("ordinal",windowOrdinal++).put("summary",summary));
                    summary=emptyRoadSummary();
                }
                addRoadPoint(summary,point,pointStart+index);
                if(summary.optDouble("distanceM",0)>=220d){
                    windows.put(new JSONObject().put("ordinal",windowOrdinal++).put("summary",summary));
                    summary=emptyRoadSummary();
                }
            }
            writeRoadState(repository,work,"REDUCER",-1,"ACCUMULATOR",
                new JSONObject().put("summary",summary).put("windowOrdinal",windowOrdinal));
            for(int i=0;i<windows.length();i++){
                JSONObject window=windows.getJSONObject(i);
                writeRoadState(repository,work,"WINDOW",window.getInt("ordinal"),"SELECT",
                    new JSONObject().put("summary",window.getJSONObject("summary")));
            }
            cursor=new JSONObject().put("phase","ROAD_SCAN").put("sourceOrdinal",sourceOrdinal+1);
            updateRoadCursor(repository,work,cursor);
            return result("WINDOW_SCAN",pointCount+windows.length()+2,bytes,true);
        }
        if(summary.optInt("usableCount",0)>0){
            writeRoadState(repository,work,"WINDOW",windowOrdinal,"SELECT",
                new JSONObject().put("summary",summary));windowOrdinal++;
        }
        writeRoadState(repository,work,"REDUCER",-1,"SCANNED",
            new JSONObject().put("summary",emptyRoadSummary()).put("windowOrdinal",windowOrdinal));
        updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_SELECT")
            .put("windowOrdinal",0).put("bit",0).put("sourceOrdinal",0));
        return result("WINDOW_SCAN_COMPLETE",2,0,true);
    }

    private static JSONObject roadSelectTurn(DriveSenseTripArchiveRepository repository,Work work,
                                             JSONObject cursor)throws Exception{
        int ordinal=cursor.optInt("windowOrdinal",0);
        JSONObject window=readRoadState(repository,work,"WINDOW",ordinal);
        if(window==null){
            updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_APPLY").put("outputOrdinal",0));
            return result("ORDER_STATS_COMPLETE",1,0,true);
        }
        JSONObject summary=window.getJSONObject("summary");
        if(roadRejected(summary)){
            updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_SELECT")
                .put("windowOrdinal",ordinal+1).put("bit",0).put("sourceOrdinal",0));
            return result("WINDOW_REJECTED",2,0,true);
        }
        JSONArray targets=cursor.optJSONArray("targets");if(targets==null)targets=roadTargets(summary);
        int bit=cursor.optInt("bit",0),sourceOrdinal=cursor.optInt("sourceOrdinal",0);
        if(bit<64){
            JSONObject source=readRoadSource(repository,work,sourceOrdinal);
            if(source!=null){
                JSONArray points=DriveSenseP6PointBlock.pointsOf(source);
                int start=source.optInt("pointStartOrdinal",0);
                for(int t=0;t<targets.length();t++){
                    JSONObject target=targets.getJSONObject(t);long zero=target.optLong("zeroCount",0);
                    String prefix=target.optString("prefix","");String field=target.getString("field");
                    for(int i=0;i<points.length();i++){
                        int global=start+i;if(global<summary.getInt("startOrdinal")||global>summary.getInt("endOrdinal"))continue;
                        JSONObject point=points.optJSONObject(i);if(!roadUsable(point))continue;
                        double value=roadValue(point,field);if(!Double.isFinite(value))continue;
                        long bits=Double.doubleToRawLongBits(value);if(prefixMatches(bits,prefix)&&bitAt(bits,bit)==0)zero++;
                    }
                    target.put("zeroCount",zero);
                }
                JSONObject next=new JSONObject().put("phase","ROAD_SELECT").put("windowOrdinal",ordinal)
                    .put("bit",bit).put("sourceOrdinal",sourceOrdinal+1).put("targets",targets);
                updateRoadCursor(repository,work,next);
                return result("ORDER_STATS_SCAN",points.length()+targets.length(),source.toString().length(),true);
            }
            for(int t=0;t<targets.length();t++){
                JSONObject target=targets.getJSONObject(t);long zero=target.optLong("zeroCount",0);
                long rank=target.optLong("remainingRank",0);boolean chooseZero=rank<zero;
                target.put("prefix",target.optString("prefix","")+(chooseZero?"0":"1"));
                target.put("remainingRank",chooseZero?rank:rank-zero);target.put("zeroCount",0);
            }
            updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_SELECT")
                .put("windowOrdinal",ordinal).put("bit",bit+1).put("sourceOrdinal",0).put("targets",targets));
            return result("ORDER_STATS_BIT_COMPLETE",targets.length()+1,0,true);
        }
        JSONObject stats=roadStatistics(summary,targets);window.put("statistics",stats);
        window.put("sectionPoints",new JSONArray());writeRoadState(repository,work,"WINDOW",ordinal,"GEOMETRY",window);
        updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_GEOMETRY")
            .put("windowOrdinal",ordinal).put("sourceOrdinal",0).put("usableOrdinal",0));
        return result("ORDER_STATS_EXACT",targets.length()+1,stats.toString().length(),true);
    }

    private static JSONObject roadGeometryTurn(DriveSenseTripArchiveRepository repository,Work work,
                                               JSONObject cursor)throws Exception{
        int ordinal=cursor.optInt("windowOrdinal",0),sourceOrdinal=cursor.optInt("sourceOrdinal",0);
        int usableOrdinal=cursor.optInt("usableOrdinal",0);
        JSONObject window=readRoadState(repository,work,"WINDOW",ordinal);
        if(window==null)return stale(repository,work);
        JSONObject summary=window.getJSONObject("summary");JSONArray selected=window.optJSONArray("sectionPoints");
        if(selected==null)selected=new JSONArray();JSONObject source=readRoadSource(repository,work,sourceOrdinal);
        if(source!=null){
            JSONArray points=DriveSenseP6PointBlock.pointsOf(source);
            int start=source.optInt("pointStartOrdinal",0),count=summary.optInt("usableCount",0);
            for(int i=0;i<points.length();i++){
                int global=start+i;if(global<summary.getInt("startOrdinal")||global>summary.getInt("endOrdinal"))continue;
                JSONObject point=points.optJSONObject(i);if(!roadUsable(point))continue;
                if(roadGeometryTarget(usableOrdinal,count))selected.put(new JSONObject()
                    .put("lat",point.getDouble("lat")).put("lng",point.getDouble("lng")));
                usableOrdinal++;
            }
            window.put("sectionPoints",selected);writeRoadState(repository,work,"WINDOW",ordinal,"GEOMETRY",window);
            updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_GEOMETRY")
                .put("windowOrdinal",ordinal).put("sourceOrdinal",sourceOrdinal+1).put("usableOrdinal",usableOrdinal));
            return result("WINDOW_GEOMETRY_SCAN",points.length()+1,source.toString().length(),true);
        }
        updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_FINALIZE_ACK").put("windowOrdinal",ordinal));
        return roadFinalizePage(repository,work,new JSONObject().put("windowOrdinal",ordinal));
    }

    private static JSONObject roadFinalizePage(DriveSenseTripArchiveRepository repository,Work work,
                                               JSONObject cursor)throws Exception{
        int ordinal=cursor.optInt("windowOrdinal",0);JSONObject window=readRoadState(repository,work,"WINDOW",ordinal);
        if(window==null)throw new IllegalStateException("P6_ROAD_WINDOW_MISSING");
        JSONObject out=result("FINALIZE_PAGE",window.optJSONArray("sectionPoints")!=null
            ?window.optJSONArray("sectionPoints").length()+2:2,window.toString().length(),true);
        out.put("tripId",work.tripId);out.put("summary",window.getJSONObject("summary"));
        out.put("statistics",window.getJSONObject("statistics"));out.put("sectionPoints",
            window.optJSONArray("sectionPoints")!=null?window.optJSONArray("sectionPoints"):new JSONArray());return out;
    }

    private static JSONObject roadApplyPage(DriveSenseTripArchiveRepository repository,Work work,
                                            JSONObject cursor)throws Exception{
        int ordinal=cursor.optInt("outputOrdinal",0);JSONObject output=readRoadState(repository,work,"OUTPUT",ordinal);
        if(output==null){
            boolean capacityBlocked=repository.coordinator().read(db->{try(Cursor c=db.rawQuery(
                "SELECT state FROM p6_control WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",null)){
                return c.moveToFirst()&&"CAPACITY_BLOCKED".equals(c.getString(0));
            }});
            long now=System.currentTimeMillis();repository.coordinator().write(db->{
                db.beginTransaction();try{
                    String speedGeneration=scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1");
                    if(!capacityBlocked){
                        db.execSQL("INSERT OR REPLACE INTO p6_source_applied(archive_generation,trip_id,domain_id,"+
                            "source_revision,source_hash,algorithm_version,settings_version,published_content_version,"+
                            "updated_at_ms) VALUES(?,?,?,?,?,1,?,?,?)",new Object[]{work.generation,work.tripId,
                            "D4_ROAD_LEARNING_SPEED_LOOKUP",work.revision,work.sourceHash,speedGeneration,
                            work.revision+":road-v1",now});
                        manifest(db,"D4_ROAD_LEARNING_SPEED_LOOKUP",work,work.revision+":road-v1","VERIFIED",true,now);
                    }
                    decrementInlineRefs(db,"p6_road_windows","archive_generation=? AND trip_id=? AND source_revision=?",
                        new String[]{work.generation,work.tripId,Integer.toString(work.revision)});
                    db.delete("p6_road_windows","archive_generation=? AND trip_id=? AND source_revision=?",
                        new String[]{work.generation,work.tripId,Integer.toString(work.revision)});
                    decrementInlineRefs(db,"p6_road_observations","archive_generation=? AND trip_id=? "+
                        "AND source_revision=? AND record_kind='SOURCE_POINT_SPILL'",new String[]{work.generation,
                            work.tripId,Integer.toString(work.revision)});
                    db.delete("p6_road_observations","archive_generation=? AND trip_id=? AND source_revision=? "+
                        "AND record_kind='SOURCE_POINT_SPILL'",new String[]{work.generation,work.tripId,
                            Integer.toString(work.revision)});
                    db.execSQL("UPDATE p6_trip_work SET state='ROAD_COMPLETE',cursor=NULL,updated_at_ms=? WHERE trip_id=?",
                        new Object[]{now,work.tripId});db.setTransactionSuccessful();
                }finally{db.endTransaction();}return null;});
            return result(capacityBlocked?"CAPACITY_BLOCKED":"COMPLETE",2,0,!capacityBlocked);
        }
        String receiptBucket=repository.coordinator().read(db->{
            String speedGeneration=scalarText(db,"SELECT speed_generation FROM speed_state WHERE id=1");
            try(Cursor c=db.rawQuery(
                "SELECT bucket_id FROM p6_observation_applied WHERE speed_generation=? AND trip_generation=? "+
                "AND trip_id=? AND source_revision=? AND observation_ordinal=?",new String[]{speedGeneration,
                    work.generation,work.tripId,Integer.toString(work.revision),Integer.toString(ordinal)})){
                return c.moveToFirst()?c.getString(0):null;
            }
        });
        if(receiptBucket!=null){updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_APPLY")
            .put("outputOrdinal",ordinal+1));return result(receiptBucket.startsWith("CAPACITY_BLOCKED:")
                ?"CAPACITY_BLOCKED":"RECEIPT_REUSED",2,0,!receiptBucket.startsWith("CAPACITY_BLOCKED:"));}
        updateRoadCursor(repository,work,new JSONObject().put("phase","ROAD_APPLY_ACK").put("outputOrdinal",ordinal));
        JSONObject out=result("APPLY_PAGE",3,output.toString().length(),true);out.put("tripId",work.tripId);
        out.put("sourceRevision",work.revision);
        out.put("observationOrdinal",ordinal);
        out.put("observation",output.getJSONObject("observation"));return out;
    }

    private static JSONObject readRoadSource(DriveSenseTripArchiveRepository repository,Work work,
                                             int ordinal)throws Exception{
        DriveSenseP6DerivedBlobStore.Prepared prepared=inlineDerived(repository,work,ordinal,
            "SOURCE_POINT_SPILL",work.revision+":road-source-v1");
        if(prepared==null)return null;byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(prepared,prepared.ciphertext);
        try{return new JSONObject(new String(plain,StandardCharsets.UTF_8))
            .put("pointStartOrdinal",roadSourceStart(repository,work,ordinal));}
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static int roadSourceStart(DriveSenseTripArchiveRepository repository,Work work,int ordinal)throws Exception{
        return repository.coordinator().read(db->{try(Cursor c=db.rawQuery("SELECT point_start_ordinal FROM "+
            "p6_road_observations WHERE archive_generation=? AND trip_id=? AND source_revision=? AND ordinal=? "+
            "AND record_kind='SOURCE_POINT_SPILL' AND commit_state='COMMITTED'",new String[]{work.generation,
                work.tripId,Integer.toString(work.revision),Integer.toString(ordinal)})){return c.moveToFirst()?c.getInt(0):0;}});
    }

    private static JSONObject readRoadState(DriveSenseTripArchiveRepository repository,Work work,
                                            String kind,int ordinal)throws Exception{
        DriveSenseP6DerivedBlobStore.Prepared value=repository.coordinator().read(db->{try(Cursor c=db.rawQuery(
            "SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,key_version FROM p6_road_windows "+
            "WHERE archive_generation=? AND trip_id=? AND source_revision=? AND record_kind=? AND ordinal=?",
            new String[]{work.generation,work.tripId,Integer.toString(work.revision),kind,Integer.toString(ordinal)})){
            if(!c.moveToFirst())return null;byte[]cipher=c.getBlob(0);return new DriveSenseP6DerivedBlobStore.Prepared(
                work.generation,"trip_derived",work.tripId,work.revision,roadStateVersion(work,kind),ordinal,
                cipher.length-16,cipher,c.getBlob(1),c.getBlob(2),c.getBlob(3),c.getBlob(4),c.getInt(5),"","");}});
        if(value==null)return null;byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(value,value.ciphertext);
        try{return new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static void writeRoadState(DriveSenseTripArchiveRepository repository,Work work,String kind,
                                       int ordinal,String state,JSONObject value)throws Exception{
        byte[]plain=value.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(repository,
            work.generation,"trip_derived",work.tripId,work.revision,roadStateVersion(work,kind),ordinal,plain);
        try{repository.coordinator().write(db->{db.beginTransaction();try{
            if(!current(db,work))return null;Integer oldKey=null;
            try(Cursor c=db.rawQuery("SELECT key_version FROM p6_road_windows WHERE archive_generation=? "+
                "AND trip_id=? AND source_revision=? AND record_kind=? AND ordinal=?",new String[]{work.generation,
                work.tripId,Integer.toString(work.revision),kind,Integer.toString(ordinal)})){
                if(c.moveToFirst())oldKey=c.getInt(0);
            }
            ContentValues row=new ContentValues();row.put("archive_generation",work.generation);
            row.put("trip_id",work.tripId);row.put("source_revision",work.revision);row.put("ordinal",ordinal);
            row.put("record_kind",kind);row.put("state",state);row.put("payload",prepared.ciphertext);
            row.put("payload_nonce",prepared.payloadNonce);row.put("payload_hash",prepared.payloadHash);
            row.put("wrapped_dek",prepared.wrappedDek);row.put("wrap_nonce",prepared.wrapNonce);
            row.put("key_version",prepared.keyVersion);row.put("updated_at_ms",System.currentTimeMillis());
            db.insertWithOnConflict("p6_road_windows",null,row,SQLiteDatabase.CONFLICT_REPLACE);
            if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
            db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});}
        finally{Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);}
    }

    private static String roadStateVersion(Work work,String kind){return work.revision+":road-"+kind.toLowerCase(java.util.Locale.ROOT)+"-v1";}

    private static void decrementInlineRefs(SQLiteDatabase db,String table,String where,String[]args){
        try(Cursor refs=db.rawQuery("SELECT key_version,COUNT(*) FROM "+table+" WHERE "+where+
            " GROUP BY key_version",args)){while(refs.moveToNext()&&!refs.isNull(0))
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",refs.getInt(0),-refs.getLong(1));}
    }

    private static void updateRoadCursor(DriveSenseTripArchiveRepository repository,Work work,
                                         JSONObject cursor)throws Exception{
        repository.coordinator().write(db->{if(current(db,work))db.execSQL("UPDATE p6_trip_work SET cursor=?,"+
            "updated_at_ms=? WHERE trip_id=? AND desired_revision=? AND state='COMPLETE'",new Object[]{
                cursor.toString(),System.currentTimeMillis(),work.tripId,work.revision});return null;});
    }

    private static JSONObject emptyRoadSummary()throws Exception{return new JSONObject()
        .put("startOrdinal",JSONObject.NULL).put("endOrdinal",JSONObject.NULL).put("usableCount",0)
        .put("speedCount",0).put("speedSum",0d).put("speedSquareSum",0d).put("rawSpeedCount",0)
        .put("stopCount",0).put("lowSpeedCount",0).put("accuracyCount",0).put("distanceM",0d)
        .put("largestTimestampGapMs",0L).put("headingChangeDeg",0d).put("lastPoint",JSONObject.NULL)
        .put("lastBearing",JSONObject.NULL).put("recordedAt",JSONObject.NULL)
        .put("utcOffsetMinutes",JSONObject.NULL).put("timezoneId","").put("estimatedLimitCounts",new JSONObject());}

    private static boolean roadUsable(JSONObject point){
        if(point==null)return false;double lat=point.optDouble("lat",Double.NaN),lng=point.optDouble("lng",Double.NaN);
        double accuracy=point.optDouble("accuracy",Double.NaN);return Double.isFinite(lat)&&Double.isFinite(lng)
            &&Math.abs(lat)<=90&&Math.abs(lng)<=180&&!(Math.abs(lat)<.001&&Math.abs(lng)<.001)
            &&(!Double.isFinite(accuracy)||accuracy<=50);
    }

    private static void addRoadPoint(JSONObject summary,JSONObject point,int ordinal)throws Exception{
        JSONObject last=summary.optJSONObject("lastPoint");if(last!=null){
            summary.put("distanceM",summary.optDouble("distanceM",0)+roadDistance(last,point));
            long before=roadTime(last),after=roadTime(point);if(before>=0&&after>=0)
                summary.put("largestTimestampGapMs",Math.max(summary.optLong("largestTimestampGapMs",0),Math.max(0,after-before)));
            double next=roadBearing(last,point),prior=summary.optDouble("lastBearing",Double.NaN);
            if(Double.isFinite(next)&&Double.isFinite(prior))summary.put("headingChangeDeg",
                summary.optDouble("headingChangeDeg",0)+angleDifference(prior,next));
            if(Double.isFinite(next))summary.put("lastBearing",next);
        }
        if(summary.isNull("startOrdinal"))summary.put("startOrdinal",ordinal);summary.put("endOrdinal",ordinal);
        summary.put("usableCount",summary.optInt("usableCount",0)+1);
        double speed=point.optDouble("speedKmh",point.optDouble("speed_kmh",Double.NaN));
        if(Double.isFinite(speed)){
            summary.put("rawSpeedCount",summary.optInt("rawSpeedCount",0)+1);
            if(speed<5)summary.put("stopCount",summary.optInt("stopCount",0)+1);
            if(speed<12)summary.put("lowSpeedCount",summary.optInt("lowSpeedCount",0)+1);
            if(speed>=5&&speed<=180){summary.put("speedCount",summary.optInt("speedCount",0)+1);
                summary.put("speedSum",summary.optDouble("speedSum",0)+speed);
                summary.put("speedSquareSum",summary.optDouble("speedSquareSum",0)+speed*speed);}
        }
        double accuracy=point.optDouble("accuracy",Double.NaN);if(Double.isFinite(accuracy)&&accuracy>=0)
            summary.put("accuracyCount",summary.optInt("accuracyCount",0)+1);
        String source=point.optString("limitSource",point.optString("speed_limit_source",""));
        double limit=point.optDouble("limitKmh",point.optDouble("speed_limit_kmh",Double.NaN));
        if(("inferred".equals(source)||"region_default_estimate".equals(source))&&Double.isFinite(limit)&&limit>0){
            String rung=Integer.toString((int)Math.round(limit/10d)*10);JSONObject counts=summary.getJSONObject("estimatedLimitCounts");
            counts.put(rung,counts.optInt(rung,0)+1);
        }
        Object recorded=point.opt("timestamp");if(recorded==null)recorded=point.opt("timestampMs");
        if(recorded==null)recorded=point.opt("recorded_at");if(recorded!=null)summary.put("recordedAt",recorded);
        if(point.has("utcOffsetMinutes"))summary.put("utcOffsetMinutes",point.opt("utcOffsetMinutes"));
        if(point.has("timezoneId"))summary.put("timezoneId",point.optString("timezoneId",""));
        summary.put("lastPoint",point);
    }

    private static double roadValue(JSONObject point,String field){
        double value="accuracy".equals(field)?point.optDouble("accuracy",Double.NaN):
            point.optDouble("speedKmh",point.optDouble("speed_kmh",Double.NaN));
        if("speed".equals(field)&&(!Double.isFinite(value)||value<5||value>180))return Double.NaN;
        if("accuracy".equals(field)&&(!Double.isFinite(value)||value<0))return Double.NaN;return value;
    }

    private static JSONArray roadTargets(JSONObject summary)throws Exception{
        JSONArray out=new JSONArray();addTargets(out,"p85","speed",summary.optInt("speedCount",0),.85);
        addTargets(out,"median","speed",summary.optInt("speedCount",0),.5);
        addTargets(out,"accuracy","accuracy",summary.optInt("accuracyCount",0),.5);return out;
    }

    private static void addTargets(JSONArray out,String id,String field,int count,double ratio)throws Exception{
        if(count<=0)return;double index=(count-1d)*ratio;long low=(long)Math.floor(index),high=(long)Math.ceil(index);
        out.put(new JSONObject().put("id",id+"_0").put("field",field).put("rank",low)
            .put("remainingRank",low).put("prefix","").put("zeroCount",0));
        out.put(new JSONObject().put("id",id+"_1").put("field",field).put("rank",high)
            .put("remainingRank",high).put("prefix","").put("zeroCount",0));
    }

    private static JSONObject roadStatistics(JSONObject summary,JSONArray targets)throws Exception{
        JSONObject selected=new JSONObject();for(int i=0;i<targets.length();i++){
            JSONObject target=targets.getJSONObject(i);selected.put(target.getString("id"),bitsValue(target.getString("prefix")));
        }
        int count=summary.optInt("speedCount",0),accuracies=summary.optInt("accuracyCount",0);
        double p=(count-1d)*.85,m=(count-1d)*.5,a=(accuracies-1d)*.5;
        JSONObject stats=new JSONObject();stats.put("p85Kmh",interpolate(selected,"p85",p));
        stats.put("medianKmh",interpolate(selected,"median",m));
        if(accuracies>0)stats.put("medianAccuracyM",interpolate(selected,"accuracy",a));else stats.put("medianAccuracyM",JSONObject.NULL);
        JSONObject counts=summary.optJSONObject("estimatedLimitCounts");String best=null;int bestCount=-1,bestValue=Integer.MAX_VALUE;
        if(counts!=null){java.util.Iterator<String>keys=counts.keys();while(keys.hasNext()){
            String key=keys.next();int n=counts.optInt(key,0),v=Integer.parseInt(key);
            if(n>bestCount||(n==bestCount&&v<bestValue)){best=key;bestCount=n;bestValue=v;}
        }}
        if(best==null)stats.put("explicitEstimatedLimit",JSONObject.NULL);else stats.put("explicitEstimatedLimit",Double.parseDouble(best));return stats;
    }

    private static double interpolate(JSONObject selected,String id,double index){double low=selected.optDouble(id+"_0",Double.NaN);
        double high=selected.optDouble(id+"_1",Double.NaN);return low+(high-low)*(index-Math.floor(index));}
    private static boolean prefixMatches(long bits,String prefix){for(int i=0;i<prefix.length();i++)
        if(bitAt(bits,i)!=(prefix.charAt(i)=='1'?1:0))return false;return true;}
    private static int bitAt(long bits,int bit){return (int)((bits>>>(63-bit))&1L);}
    private static double bitsValue(String bits){long value=0;for(int i=0;i<bits.length();i++)value=(value<<1)|(bits.charAt(i)=='1'?1:0);
        return Double.longBitsToDouble(value);}
    private static boolean roadRejected(JSONObject s){return s.optDouble("distanceM",0)<90||s.optInt("speedCount",0)<4
        ||s.optInt("stopCount",0)/(double)Math.max(1,s.optInt("rawSpeedCount",0))>.20
        ||s.optInt("lowSpeedCount",0)/(double)Math.max(1,s.optInt("rawSpeedCount",0))>.32
        ||s.optLong("largestTimestampGapMs",0)>15000||s.optDouble("headingChangeDeg",0)>105;}
    private static boolean roadGeometryTarget(int ordinal,int count){if(count<=24)return ordinal<count;
        for(int i=0;i<24;i++)if(Math.round(i*(count-1d)/23d)==ordinal)return true;return false;}
    private static double roadDistance(JSONObject a,JSONObject b){double lat1=Math.toRadians(a.optDouble("lat"));
        double lat2=Math.toRadians(b.optDouble("lat")),dLat=lat2-lat1,dLng=Math.toRadians(b.optDouble("lng")-a.optDouble("lng"));
        double x=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)*Math.sin(dLng/2);
        return 6371000d*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));}
    private static double roadBearing(JSONObject a,JSONObject b){double lat1=Math.toRadians(a.optDouble("lat"));
        double lat2=Math.toRadians(b.optDouble("lat")),dLng=Math.toRadians(b.optDouble("lng")-a.optDouble("lng"));
        return (Math.toDegrees(Math.atan2(Math.sin(dLng)*Math.cos(lat2),Math.cos(lat1)*Math.sin(lat2)-
            Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng)))+360)%360;}
    private static double angleDifference(double a,double b){return Math.abs((((a-b)+540)%360)-180);}
    private static long roadTime(JSONObject point){Object raw=point.opt("timestamp");if(raw==null)raw=point.opt("timestampMs");
        if(raw==null)raw=point.opt("recorded_at");if(raw instanceof Number){double n=((Number)raw).doubleValue();return (long)(n<1e12?n*1000:n);}
        if(raw==null)return -1;try{return java.time.Instant.parse(String.valueOf(raw)).toEpochMilli();}catch(Exception ignored){return -1;}}

    static double selectRoadRankForTest(double[]values,int rank){
        if(values==null||rank<0||rank>=values.length)throw new IllegalArgumentException("P6_TEST_RANK_INVALID");
        String prefix="";long remaining=rank;
        for(int bit=0;bit<64;bit++){
            long zero=0;for(double value:values){long bits=Double.doubleToRawLongBits(value);
                if(prefixMatches(bits,prefix)&&bitAt(bits,bit)==0)zero++;}
            boolean chooseZero=remaining<zero;prefix+=chooseZero?"0":"1";
            if(!chooseZero)remaining-=zero;
        }
        return bitsValue(prefix);
    }

    static JSONObject stepAffectedSelection(DriveSenseTripArchiveRepository repository)throws Exception{
        Selection request=firstSelection(repository);
        if(request==null)return result("IDLE",0,0,false);
        JSONObject detail=decryptSelection(request);
        JSONArray tokens=detail.optJSONArray("tokens");
        if(tokens==null)tokens=new JSONArray();
        JSONObject cursor=request.cursor==null||request.cursor.isEmpty()
            ?new JSONObject():new JSONObject(request.cursor);
        if(cursor.optBoolean("awaitingAck",false))
            return selectionGeometryPage(repository,request,detail,cursor);
        String candidateTrip=cursor.optString("candidateTripId","");
        if(!candidateTrip.isEmpty())return selectionGeometryPage(repository,request,detail,cursor);
        int tokenIndex=cursor.optInt("tokenIndex",0);
        if(tokenIndex>=tokens.length())return finishSelection(repository,request);
        String token=tokens.optString(tokenIndex,"");
        String afterTrip=cursor.optString("afterTripId","");
        int afterRevision=cursor.optInt("afterRevision",-1);
        int afterBlock=cursor.optInt("afterBlock",-1);
        Posting posting=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery(
                "SELECT p.trip_id,p.source_revision,p.content_version,p.block_ordinal,p.point_ordinal "+
                    "FROM p6_trip_spatial_postings p JOIN p6_manifests m "+
                    "ON m.domain_id='D3_SPATIAL_SELECTION' AND m.subject_id=p.trip_id "+
                    "AND m.source_binding=p.archive_generation AND m.applied_version=p.source_revision "+
                    "AND m.content_version=p.content_version AND m.state='VERIFIED' AND m.complete=1 "+
                    "WHERE p.archive_generation=? AND p.cell_token=? AND "+
                    "(p.trip_id>? OR (p.trip_id=? AND p.source_revision>?) OR "+
                    "(p.trip_id=? AND p.source_revision=? AND p.block_ordinal>?)) "+
                    "ORDER BY p.trip_id,p.source_revision,p.block_ordinal LIMIT 1",
                new String[]{request.generation,token,afterTrip,afterTrip,Integer.toString(afterRevision),
                    afterTrip,Integer.toString(afterRevision),Integer.toString(afterBlock)})){
                return c.moveToFirst()?new Posting(c.getString(0),c.getInt(1),c.getString(2),
                    c.getInt(3),c.getInt(4)):null;
            }
        });
        if(posting==null){
            cursor.put("tokenIndex",tokenIndex+1);cursor.remove("afterTripId");
            cursor.remove("afterRevision");cursor.remove("afterBlock");
            updateSelectionCursor(repository,request,cursor);
            return result("POSTING_CELL_COMPLETE",1,token.length(),true);
        }
        String postingCorruption=spatialPostingCorruption(repository,request.generation,token,posting);
        if(postingCorruption!=null){
            demoteSpatialAuthority(repository,request.generation,postingCorruption,false);
            JSONObject unavailable=result("REBUILD_REQUIRED",1,token.length(),false);
            unavailable.put("accepted",false);unavailable.put("reason",postingCorruption);
            return unavailable;
        }
        cursor.put("afterTripId",posting.tripId);cursor.put("afterRevision",posting.revision);
        cursor.put("afterBlock",posting.blockOrdinal);
        boolean admitted=repository.coordinator().write(db->{
            ContentValues value=new ContentValues();value.put("request_id",request.requestId);
            value.put("trip_id",posting.tripId);value.put("content_version",posting.contentVersion);
            value.put("state","PENDING");value.put("cursor_ordinal",0);
            return db.insertWithOnConflict("p6_selection_candidates",null,value,
                SQLiteDatabase.CONFLICT_IGNORE)!=-1;
        });
        if(admitted){
            cursor.put("candidateTripId",posting.tripId);
            cursor.put("candidateContentVersion",posting.contentVersion);
            cursor.put("candidateOrdinal",0);
        }
        updateSelectionCursor(repository,request,cursor);
        return result(admitted?"CANDIDATE_SELECTED":"DUPLICATE_POSTING",2,token.length(),true);
    }

    static JSONObject createAffectedSelection(DriveSenseTripArchiveRepository repository,
                                              JSONObject input)throws Exception{
        JSONArray cells=input.optJSONArray("cells");
        if(cells==null||cells.length()<1||cells.length()>4096)
            throw new IllegalArgumentException("P6_SELECTION_CELL_COUNT_OUT_OF_RANGE");
        String readiness=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT state FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION' AND complete=1",null)){
                return c.moveToFirst()?c.getString(0):"REBUILD_REQUIRED";
            }
        });
        if(!"VERIFIED".equals(readiness)){
            JSONObject unavailable=new JSONObject();unavailable.put("accepted",false);
            unavailable.put("state",readiness);return unavailable;
        }
        String generation=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1 AND authority_state='NATIVE' AND recovery_state='HEALTHY'",null)){
                return c.moveToFirst()?c.getString(0):null;
            }
        });
        if(generation==null)throw new IllegalStateException("RECOVERY_REQUIRED");
        String requestedId=input.optString("requestId","").trim();
        if(!requestedId.isEmpty()&&!requestedId.matches("[A-Za-z0-9._:-]{1,160}"))
            throw new IllegalArgumentException("P6_SELECTION_REQUEST_ID_INVALID");
        if(!requestedId.isEmpty()){
            Boolean existing=repository.coordinator().read(db->{
                try(Cursor c=db.rawQuery("SELECT 1 FROM p6_selection_requests WHERE request_id=? "+
                    "AND archive_generation=?",new String[]{requestedId,generation})){return c.moveToFirst();}
            });
            if(Boolean.TRUE.equals(existing)){
                JSONObject out=new JSONObject();out.put("accepted",true);out.put("state","READY");
                out.put("requestId",requestedId);out.put("tokenCount",cells.length());return out;
            }
        }
        byte[]secret;
        try{secret=spatialSecret(repository,generation);}
        catch(SpatialAuthorityCorruptException corrupt){
            JSONObject unavailable=new JSONObject();unavailable.put("accepted",false);
            unavailable.put("state","REBUILD_REQUIRED");unavailable.put("reason",corrupt.getMessage());
            return unavailable;
        }
        JSONArray tokens=new JSONArray();
        try{
            for(int i=0;i<cells.length();i++){
                String cell=cells.optString(i,"");
                if(!cell.matches("-?[0-9]+:-?[0-9]+"))throw new IllegalArgumentException("P6_SELECTION_CELL_INVALID");
                tokens.put(cellToken(secret,cell));
            }
        }finally{Arrays.fill(secret,(byte)0);}
        String requestId=requestedId.isEmpty()?UUID.randomUUID().toString():requestedId;
        JSONObject detail=new JSONObject();detail.put("tokens",tokens);
        detail.put("descriptors",input.optJSONArray("descriptors")!=null?input.optJSONArray("descriptors"):new JSONArray());
        detail.put("reason",input.optString("reason","speed_knowledge_rules_changed"));
        detail.put("knowledgeMetadata",input.optJSONObject("knowledgeMetadata")!=null
            ?input.optJSONObject("knowledgeMetadata"):new JSONObject());
        byte[]plain=detail.toString().getBytes(StandardCharsets.UTF_8);
        if(plain.length>512*1024)throw new IllegalArgumentException("P6_SELECTION_REQUEST_TOO_LARGE");
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(
            repository,generation,"trip_derived",requestId,1,"selection-v1",0,plain);
        repository.coordinator().write(db->{
            ContentValues row=new ContentValues();row.put("request_id",requestId);
            row.put("archive_generation",generation);row.put("state","READY");
            row.put("payload",prepared.ciphertext);row.put("payload_nonce",prepared.payloadNonce);
            row.put("payload_hash",prepared.payloadHash);row.put("wrapped_dek",prepared.wrappedDek);
            row.put("wrap_nonce",prepared.wrapNonce);row.put("key_version",prepared.keyVersion);
            row.put("cursor",new JSONObject().put("tokenIndex",0).toString());
            row.put("created_at_ms",System.currentTimeMillis());row.put("updated_at_ms",System.currentTimeMillis());
            db.insertOrThrow("p6_selection_requests",null,row);
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
            return null;
        });
        Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);
        JSONObject out=new JSONObject();out.put("accepted",true);out.put("state","READY");
        out.put("requestId",requestId);out.put("tokenCount",tokens.length());return out;
    }

    static JSONObject queryGeometryPreviewPage(DriveSenseTripArchiveRepository repository,
                                               String afterTripId,int maxItems)throws Exception{
        int limit=Math.max(1,Math.min(80,maxItems));
        boolean ready=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT 1 FROM p6_control WHERE domain_id='D2_GEOMETRY' "+
                "AND state='VERIFIED' AND complete=1",null)){return c.moveToFirst();}
        });
        JSONObject out=new JSONObject();out.put("state",ready?"VERIFIED":"REBUILD_REQUIRED");
        out.put("available",ready);out.put("bounded",true);JSONArray items=new JSONArray();
        if(!ready){out.put("items",items);out.put("nextCursor",JSONObject.NULL);return out;}
        JSONArray heads=repository.coordinator().read(db->{
            JSONArray rows=new JSONArray();
            try(Cursor c=db.rawQuery("SELECT subject_id,content_version,applied_version FROM p6_manifests "+
                "WHERE domain_id='D2_GEOMETRY' AND subject_id>? AND state='VERIFIED' AND complete=1 "+
                "ORDER BY subject_id LIMIT ?",new String[]{afterTripId==null?"":afterTripId,
                    Integer.toString(limit+1)})){
                while(c.moveToNext()){
                    JSONObject row=new JSONObject();row.put("tripId",c.getString(0));
                    row.put("contentVersion",c.getString(1));row.put("revision",c.getInt(2));rows.put(row);
                }
            }return rows;
        });
        for(int index=0;index<Math.min(limit,heads.length());index++){
            JSONObject head=heads.getJSONObject(index);String tripId=head.getString("tripId");
            String version=head.getString("contentVersion");int revision=head.getInt("revision");
            DriveSenseP6DerivedBlobStore.Prepared prepared=repository.coordinator().read(db->{
                try(Cursor c=db.rawQuery("SELECT relative_path,plaintext_bytes,payload_nonce,payload_hash,"+
                    "wrapped_dek,wrap_nonce,key_version FROM p6_geometry_chunks WHERE archive_generation="+
                    "(SELECT source_binding FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id=?) "+
                    "AND trip_id=? AND content_version=? AND ordinal=-1 AND commit_state='COMMITTED'",
                    new String[]{tripId,tripId,version})){
                    return c.moveToFirst()?new DriveSenseP6DerivedBlobStore.Prepared("","trip_derived",tripId,
                        revision,version,-1,c.getInt(1),new byte[0],c.getBlob(2),c.getBlob(3),c.getBlob(4),
                        c.getBlob(5),c.getInt(6),c.getString(0),""):null;
                }
            });
            if(prepared==null){
                demoteCorruptGeometryHead(repository,tripId,version,revision,"DERIVED_GEOMETRY_MISSING");
                out.put("state","REBUILD_REQUIRED");out.put("available",false);
                out.put("reason","DERIVED_GEOMETRY_MISSING");out.put("items",new JSONArray());
                out.put("nextCursor",JSONObject.NULL);return out;
            }
            // Recover the source binding used in AAD from the verified head.
            String generation=repository.coordinator().read(db->{try(Cursor c=db.rawQuery(
                "SELECT source_binding FROM p6_manifests WHERE domain_id='D2_GEOMETRY' AND subject_id=?",
                new String[]{tripId})){return c.moveToFirst()?c.getString(0):"";}});
            prepared=new DriveSenseP6DerivedBlobStore.Prepared(generation,"trip_derived",tripId,revision,
                version,-1,prepared.plaintextBytes,new byte[0],prepared.payloadNonce,prepared.payloadHash,
                prepared.wrappedDek,prepared.wrapNonce,prepared.keyVersion,prepared.relativePath,"");
            byte[]plain;
            try{plain=DriveSenseP6DerivedBlobStore.readFile(repository.coordinator().context(),prepared);}
            catch(Exception corrupt){
                demoteCorruptGeometryHead(repository,tripId,version,revision,
                    "DERIVED_GEOMETRY_CORRUPT:"+corrupt.getClass().getSimpleName());
                out.put("state","REBUILD_REQUIRED");out.put("available",false);
                out.put("reason","DERIVED_GEOMETRY_CORRUPT");out.put("items",new JSONArray());
                out.put("nextCursor",JSONObject.NULL);return out;
            }
            try{
                JSONObject page=new JSONObject(new String(plain,StandardCharsets.UTF_8));
                JSONArray points=DriveSenseP6PointBlock.pointsOf(page);if(points.length()<2)continue;
                JSONObject item=new JSONObject();item.put("id",tripId);item.put("status","completed");
                item.put("route_points",points);item.put("geometry_indexed",true);
                item.put("p6ContentVersion",version);items.put(item);
            }finally{Arrays.fill(plain,(byte)0);}
        }
        out.put("items",items);out.put("nextCursor",heads.length()>limit
            ?heads.getJSONObject(limit-1).getString("tripId"):JSONObject.NULL);return out;
    }

    static JSONObject queryAchievementStats(DriveSenseTripArchiveRepository repository,long now)throws Exception{
        try{return queryAchievementStatsInternal(repository,now);}
        catch(Exception corrupt){
            repository.coordinator().write(db->{
                long changed=db.update("p6_control",derivedUnavailableValues(
                    "ANALYTICS_CORRUPT_REBUILD_REQUIRED"),"domain_id='D1_ANALYTICS'",null);
                if(changed==1)db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,"+
                    "updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",new Object[]{System.currentTimeMillis()});
                return null;
            });
            JSONObject unavailable=new JSONObject();unavailable.put("available",false);
            unavailable.put("state","REBUILD_REQUIRED");unavailable.put("reason","ANALYTICS_CORRUPT");
            return unavailable;
        }
    }

    private static ContentValues derivedUnavailableValues(String reason){
        ContentValues values=new ContentValues();values.put("state","REBUILD_REQUIRED");
        values.put("complete",0);values.put("storage_outcome",reason);
        values.put("updated_at_ms",System.currentTimeMillis());return values;
    }

    private static JSONObject queryAchievementStatsInternal(
            DriveSenseTripArchiveRepository repository,long now)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor gate=db.rawQuery("SELECT 1 FROM p6_control WHERE domain_id='D1_ANALYTICS' "+
                "AND state='VERIFIED' AND complete=1",null)){if(!gate.moveToFirst()){
                    JSONObject unavailable=new JSONObject();unavailable.put("available",false);
                    unavailable.put("state","REBUILD_REQUIRED");return unavailable;
                }}
            JSONObject out=new JSONObject();out.put("available",true);out.put("state","VERIFIED");
            try(Cursor global=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,"+
                "key_version,plaintext_bytes,source_binding,metric_schema_version FROM p6_analytics_buckets "+
                "WHERE bucket_key='global'",null)){
                if(!global.moveToFirst()){out.put("available",false);out.put("state","REBUILD_REQUIRED");return out;}
                JSONObject totals=decryptAnalyticsPayload(global,global.getString(7),
                    analyticsBucketSubject("global"),global.getInt(8),"analytics-bucket-v2",0);
                java.util.Iterator<String>keys=totals.keys();while(keys.hasNext()){
                    String key=keys.next();out.put(key,totals.opt(key));
                }
            }
            long cutoff=now-7L*86400000L;long weekTrips=0,weekHarsh=0;
            try(Cursor rows=db.rawQuery("SELECT c.payload,c.payload_nonce,c.payload_hash,c.wrapped_dek,"+
                "c.wrap_nonce,c.key_version,c.plaintext_bytes,c.trip_id,c.source_revision,c.archive_generation "+
                "FROM p6_recent_order o JOIN p6_trip_contributions c "+
                "ON c.archive_generation=o.archive_generation AND c.trip_id=o.trip_id AND c.source_revision=o.source_revision "+
                "WHERE o.order_time_ms>=? AND o.eligible=1",new String[]{Long.toString(cutoff)})){
                while(rows.moveToNext()){JSONObject value=decryptAnalyticsPayload(rows,rows.getString(9),
                    analyticsContributionSubject(rows.getString(7)),rows.getInt(8),"analytics-v2",0);
                    weekTrips+=value.optLong("completedCount",0);weekHarsh+=value.optLong("harshBrakesCount",0);}
            }
            JSONArray recent=new JSONArray();try(Cursor rows=db.rawQuery("SELECT c.payload,c.payload_nonce,"+
                "c.payload_hash,c.wrapped_dek,c.wrap_nonce,c.key_version,c.plaintext_bytes,c.trip_id,"+
                "c.source_revision,c.archive_generation FROM p6_recent_order o "+
                "JOIN p6_trip_contributions c ON c.archive_generation=o.archive_generation AND c.trip_id=o.trip_id "+
                "AND c.source_revision=o.source_revision WHERE o.eligible=1 ORDER BY o.order_time_ms DESC,o.trip_id DESC LIMIT 10",null)){
                while(rows.moveToNext())recent.put(decryptAnalyticsPayload(rows,rows.getString(9),
                    analyticsContributionSubject(rows.getString(7)),rows.getInt(8),"analytics-v2",0));
            }
            double product=0,weight=0;for(int i=0;i<Math.min(5,recent.length());i++){
                JSONObject value=recent.getJSONObject(i);product+=value.optDouble("scoreDistanceProduct",0);
                weight+=value.optDouble("scoreDistanceWeight",0);
            }
            int defensive=0;for(int i=0;i<recent.length();i++)if("defensive".equals(recent.getJSONObject(i)
                .optString("_defensiveGrade"))||"exemplary".equals(recent.getJSONObject(i)
                .optString("_defensiveGrade")))defensive++;
            out.put("weekTripCount",weekTrips);out.put("weekHarshBrakes",weekHarsh);
            out.put("recentFiveCount",Math.min(5,recent.length()));out.put("recentFiveAvg",weight>0?product/weight:0);
            out.put("avgScore",out.optDouble("scoreDistanceWeight",0)>0?
                out.optDouble("scoreDistanceProduct",0)/out.optDouble("scoreDistanceWeight",0):0);
            out.put("defensiveStreak",recent.length()>=10&&defensive==recent.length());
            out.put("defensiveRecentCount",defensive);return out;
        });
    }

    static JSONObject acknowledgeAffectedSelection(DriveSenseTripArchiveRepository repository,
                                                    String requestId,boolean matched)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String cursorText;
                try(Cursor c=db.rawQuery("SELECT cursor FROM p6_selection_requests WHERE request_id=? AND state='BUILDING'",
                    new String[]{requestId})){
                    if(!c.moveToFirst())throw new IllegalStateException("P6_SELECTION_ACK_STALE");
                    cursorText=c.getString(0);
                }
                JSONObject cursor=new JSONObject(cursorText);if(!cursor.optBoolean("awaitingAck",false))
                    throw new IllegalStateException("P6_SELECTION_ACK_NOT_EXPECTED");
                String tripId=cursor.optString("candidateTripId","");
                int ordinal=cursor.optInt("candidateOrdinal",0);
                if(matched){
                    db.execSQL("UPDATE p6_selection_candidates SET state='QUEUED',cursor_ordinal=? WHERE request_id=? AND trip_id=?",
                        new Object[]{ordinal,requestId,tripId});
                    cursor.remove("candidateTripId");cursor.remove("candidateContentVersion");
                    cursor.remove("candidateOrdinal");
                }else cursor.put("candidateOrdinal",ordinal+1);
                cursor.put("awaitingAck",false);
                db.execSQL("UPDATE p6_selection_requests SET cursor=?,updated_at_ms=? WHERE request_id=?",
                    new Object[]{cursor.toString(),System.currentTimeMillis(),requestId});
                db.setTransactionSuccessful();
                JSONObject out=result(matched?"QUEUE_ACKNOWLEDGED":"PRECISE_PAGE_MISS",2,0,true);
                out.put("requestId",requestId);out.put("tripId",tripId);return out;
            }finally{db.endTransaction();}
        });
    }

    private static Selection firstSelection(DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT request_id,archive_generation,payload,payload_nonce,payload_hash,"+
                "wrapped_dek,wrap_nonce,key_version,cursor FROM p6_selection_requests "+
                "WHERE state IN ('READY','BUILDING') ORDER BY created_at_ms,request_id LIMIT 1",null)){
                return c.moveToFirst()?new Selection(c.getString(0),c.getString(1),c.getBlob(2),
                    c.getBlob(3),c.getBlob(4),c.getBlob(5),c.getBlob(6),c.getInt(7),c.getString(8)):null;
            }
        });
    }

    private static JSONObject decryptSelection(Selection request)throws Exception{
        // The authenticated AAD includes the exact plaintext length. It is not
        // stored separately for request rows, but GCM ciphertext adds 16 bytes.
        DriveSenseP6DerivedBlobStore.Prepared prepared=new DriveSenseP6DerivedBlobStore.Prepared(request.generation,"trip_derived",
            request.requestId,1,"selection-v1",0,request.payload.length-16,request.payload,
            request.payloadNonce,request.payloadHash,request.wrappedDek,request.wrapNonce,
            request.keyVersion,"",request.requestId);
        byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(prepared,request.payload);
        try{return new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static JSONObject selectionGeometryPage(DriveSenseTripArchiveRepository repository,
            Selection request,JSONObject detail,JSONObject cursor)throws Exception{
        String tripId=cursor.optString("candidateTripId","");
        String contentVersion=cursor.optString("candidateContentVersion","");
        int ordinal=cursor.optInt("candidateOrdinal",0);
        if(tripId.isEmpty()||contentVersion.isEmpty()){
            cursor.remove("candidateTripId");cursor.remove("candidateContentVersion");
            cursor.remove("candidateOrdinal");cursor.put("awaitingAck",false);
            updateSelectionCursor(repository,request,cursor);
            return result("STALE_CANDIDATE",1,0,true);
        }
        DriveSenseP6DerivedBlobStore.Prepared page=repository.coordinator().read(db->{
            try(Cursor manifest=db.rawQuery("SELECT 1 FROM p6_manifests WHERE domain_id='D2_GEOMETRY' "+
                "AND subject_id=? AND source_binding=? AND content_version=? AND state='VERIFIED' AND complete=1",
                new String[]{tripId,request.generation,contentVersion})){
                if(!manifest.moveToFirst())return null;
            }
            try(Cursor c=db.rawQuery("SELECT relative_path,plaintext_bytes,payload_nonce,payload_hash,"+
                "wrapped_dek,wrap_nonce,key_version,(SELECT applied_version FROM p6_manifests "+
                "WHERE domain_id='D2_GEOMETRY' AND subject_id=?) FROM p6_geometry_chunks "+
                "WHERE archive_generation=? AND trip_id=? AND content_version=? AND ordinal=? "+
                "AND commit_state='COMMITTED'",new String[]{tripId,request.generation,tripId,contentVersion,
                    Integer.toString(ordinal)})){
                return c.moveToFirst()?new DriveSenseP6DerivedBlobStore.Prepared(request.generation,
                    "trip_derived",tripId,c.getInt(7),contentVersion,ordinal,c.getInt(1),new byte[0],
                    c.getBlob(2),c.getBlob(3),c.getBlob(4),c.getBlob(5),c.getInt(6),c.getString(0),""):null;
            }
        });
        if(page==null){
            repository.coordinator().write(db->{
                db.execSQL("UPDATE p6_selection_candidates SET state='MISS',cursor_ordinal=? "+
                    "WHERE request_id=? AND trip_id=?",new Object[]{ordinal,request.requestId,tripId});
                return null;
            });
            cursor.remove("candidateTripId");cursor.remove("candidateContentVersion");
            cursor.remove("candidateOrdinal");cursor.put("awaitingAck",false);
            updateSelectionCursor(repository,request,cursor);
            return result("CANDIDATE_COMPLETE",2,0,true);
        }
        byte[]plain=DriveSenseP6DerivedBlobStore.readFile(repository.coordinator().context(),page);
        JSONObject decoded;
        try{decoded=new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
        cursor.put("awaitingAck",true);updateSelectionCursor(repository,request,cursor);
        JSONArray precisePoints=DriveSenseP6PointBlock.pointsOf(decoded);
        JSONObject out=result("PRECISE_PAGE",precisePoints.length()+2,page.plaintextBytes,true);
        out.put("requestId",request.requestId);out.put("tripId",tripId);
        out.put("points",precisePoints);
        out.put("descriptors",detail.optJSONArray("descriptors")!=null?detail.optJSONArray("descriptors"):new JSONArray());
        out.put("reason",detail.optString("reason","speed_knowledge_rules_changed"));
        out.put("knowledgeMetadata",detail.optJSONObject("knowledgeMetadata")!=null
            ?detail.optJSONObject("knowledgeMetadata"):new JSONObject());
        return out;
    }

    private static void demoteCorruptGeometryHead(DriveSenseTripArchiveRepository repository,
            String tripId,String contentVersion,int revision,String reason)throws Exception{
        repository.coordinator().write(db->{
            db.beginTransaction();try{
                long now=System.currentTimeMillis();
                String generation=scalarText(db,"SELECT archive_generation FROM archive_meta WHERE id=1");
                db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,updated_at_ms=? "+
                    "WHERE domain_id IN ('D2_GEOMETRY','D3_SPATIAL_SELECTION','D4_ROAD_LEARNING_SPEED_LOOKUP') "+
                    "AND subject_id=? AND content_version=?",new Object[]{now,tripId,contentVersion});
                db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,storage_outcome=?,"+
                    "updated_at_ms=? WHERE domain_id IN ('D2_GEOMETRY','D3_SPATIAL_SELECTION',"+
                    "'D4_ROAD_LEARNING_SPEED_LOOKUP')",new Object[]{reason,now});
                db.execSQL("UPDATE p6_geometry_chunks SET commit_state='REBUILD_REQUIRED',updated_at_ms=? "+
                    "WHERE archive_generation=? AND trip_id=? AND content_version=?",
                    new Object[]{now,generation,tripId,contentVersion});
                db.execSQL("UPDATE p6_road_observations SET commit_state='REBUILD_REQUIRED',updated_at_ms=? "+
                    "WHERE archive_generation=? AND trip_id=? AND source_revision=?",
                    new Object[]{now,generation,tripId,revision});
                db.execSQL("UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? WHERE "+
                    "trip_id=? AND archive_generation=? AND desired_revision=?",
                    new Object[]{now,tripId,generation,revision});
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
    }

    private static void updateSelectionCursor(DriveSenseTripArchiveRepository repository,
                                              Selection request,JSONObject cursor)throws Exception{
        repository.coordinator().write(db->{
            db.execSQL("UPDATE p6_selection_requests SET state='BUILDING',cursor=?,updated_at_ms=? "+
                "WHERE request_id=? AND archive_generation=?",
                new Object[]{cursor.toString(),System.currentTimeMillis(),request.requestId,request.generation});
            return null;
        });
    }

    private static JSONObject finishSelection(DriveSenseTripArchiveRepository repository,
                                              Selection request)throws Exception{
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                db.delete("p6_selection_candidates","request_id=?",new String[]{request.requestId});
                db.delete("p6_selection_requests","request_id=?",new String[]{request.requestId});
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",request.keyVersion,-1);
                db.setTransactionSuccessful();return result("COMPLETE",3,0,true);
            }finally{db.endTransaction();}
        });
    }

    private static Work firstWork(DriveSenseTripArchiveRepository repository)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery(
                "SELECT trip_id,archive_generation,desired_revision,desired_seq,disposition,state,cursor,source_hash "+
                    "FROM p6_trip_work WHERE state IN ('DIRTY','BUILDING','TOMBSTONE_CLEANUP') "+
                    "ORDER BY desired_seq,trip_id LIMIT 1",null)){
                return c.moveToFirst()?new Work(
                    c.getString(0),c.getString(1),c.getInt(2),c.getLong(3),
                    c.getString(4),c.getString(5),c.getString(6),c.getBlob(7)):null;
            }
        });
    }

    private static JSONObject initialize(DriveSenseTripArchiveRepository repository,Work work)throws Exception{
        JSONObject abandoned=cleanupOneAbandonedStage(repository,work);
        if(abandoned!=null)return abandoned;
        JSONObject metadata=repository.getMetadata(work.tripId);
        if(metadata==null){
            repository.coordinator().write(db->{
                db.execSQL("UPDATE p6_trip_work SET disposition='TOMBSTONE',state='DIRTY',updated_at_ms=? WHERE trip_id=? AND desired_revision=?",
                    new Object[]{System.currentTimeMillis(),work.tripId,work.revision});
                return null;
            });
            return result("SOURCE_ABSENT",1,0,true);
        }
        JSONObject cursor=new JSONObject();
        cursor.put("chunkIndex",0);cursor.put("byteOffset",0);cursor.put("pointOrdinal",0);
        cursor.put("outputOrdinal",0);cursor.put("parser",new JSONObject());
        repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                if(!current(db,work))return null;
                db.execSQL("UPDATE p6_trip_work SET state='BUILDING',cursor=?,updated_at_ms=? WHERE trip_id=? AND desired_revision=?",
                    new Object[]{cursor.toString(),System.currentTimeMillis(),work.tripId,work.revision});
                db.execSQL("UPDATE p6_control SET source_binding=?,required_version=MAX(required_version,?),state='PARTIAL',complete=0,cursor=?,updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",
                    new Object[]{work.generation,work.desiredSeq,work.tripId,System.currentTimeMillis()});
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
        return result("BUILDING",2,0,true);
    }

    /** A canonical mutation replaces the durable work row atomically. Any
     * unpublished payload left by the replaced target is then unreachable, but
     * still owns storage and a KEK reference. Retire one such unit per normal
     * J1 turn before initializing the new target. Published heads are excluded. */
    private static JSONObject cleanupOneAbandonedStage(
            DriveSenseTripArchiveRepository repository,Work work)throws Exception{
        final String[]geometry=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT relative_path,key_version,content_version,ordinal FROM "+
                "p6_geometry_chunks WHERE archive_generation=? AND trip_id=? AND commit_state<>'COMMITTED' "+
                "ORDER BY updated_at_ms,content_version,ordinal LIMIT 1",
                new String[]{work.generation,work.tripId})){
                return c.moveToFirst()?new String[]{c.getString(0),Integer.toString(c.getInt(1)),
                    c.getString(2),Integer.toString(c.getInt(3))}:null;
            }
        });
        if(geometry!=null){
            DriveSenseP6DerivedBlobStore.deleteFile(repository.coordinator().context(),geometry[0]);
            long removed=repository.coordinator().write(db->{
                db.beginTransaction();try{
                    int count=db.delete("p6_geometry_chunks","archive_generation=? AND trip_id=? AND "+
                        "content_version=? AND ordinal=? AND commit_state<>'COMMITTED'",
                        new String[]{work.generation,work.tripId,geometry[2],geometry[3]});
                    if(count==1)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",
                        Integer.parseInt(geometry[1]),-1);
                    db.delete("p6_trip_spatial_postings","archive_generation=? AND trip_id=? AND "+
                        "content_version=? AND block_ordinal=?",new String[]{work.generation,work.tripId,
                        geometry[2],geometry[3]});
                    db.setTransactionSuccessful();return (long)count;
                }finally{db.endTransaction();}
            });
            JSONObject out=result("ABANDONED_STAGE_CLEANUP",removed+1L,0,true);
            out.put("kind","GEOMETRY");return out;
        }
        final String[]observation=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT source_revision,ordinal,key_version,record_kind,content_version "+
                "FROM p6_road_observations WHERE archive_generation=? AND trip_id=? AND "+
                "commit_state<>'COMMITTED' ORDER BY updated_at_ms,source_revision,ordinal LIMIT 1",
                new String[]{work.generation,work.tripId})){
                return c.moveToFirst()?new String[]{Integer.toString(c.getInt(0)),Integer.toString(c.getInt(1)),
                    c.isNull(2)?null:Integer.toString(c.getInt(2)),c.getString(3),c.getString(4)}:null;
            }
        });
        if(observation!=null){
            long removed=repository.coordinator().write(db->{
                db.beginTransaction();try{
                    int count=db.delete("p6_road_observations","archive_generation=? AND trip_id=? AND "+
                        "source_revision=? AND ordinal=? AND commit_state<>'COMMITTED'",
                        new String[]{work.generation,work.tripId,observation[0],observation[1]});
                    if(count==1&&observation[2]!=null)DriveSenseKeyReferenceCounts.adjust(db,
                        "trip_derived",Integer.parseInt(observation[2]),-1);
                    if("SOURCE_POINT_SPILL".equals(observation[3]))db.delete("p6_trip_spatial_postings",
                        "archive_generation=? AND trip_id=? AND source_revision=? AND block_ordinal=?",
                        new String[]{work.generation,work.tripId,observation[0],observation[1]});
                    db.setTransactionSuccessful();return (long)count;
                }finally{db.endTransaction();}
            });
            JSONObject out=result("ABANDONED_STAGE_CLEANUP",removed+1L,0,true);
            out.put("kind",observation[3]);return out;
        }
        return null;
    }

    private static JSONObject extractPage(DriveSenseTripArchiveRepository repository,Work work)throws Exception{
        JSONObject cursor=work.cursor==null||work.cursor.isEmpty()?new JSONObject():new JSONObject(work.cursor);
        int chunkIndex=cursor.optInt("chunkIndex",0),byteOffset=cursor.optInt("byteOffset",0);
        int pointOrdinal=cursor.optInt("pointOrdinal",0),outputOrdinal=cursor.optInt("outputOrdinal",0);
        try(DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=
                repository.descriptor(work.tripId,work.revision)){
            if(descriptor==null||!descriptor.generation.equals(work.generation)
                ||descriptor.revision!=work.revision
                ||!Arrays.equals(descriptor.payloadHash,work.sourceHash)){
                return stale(repository,work);
            }
            if(chunkIndex>=descriptor.chunkCount)return cursor.optInt("pointOrdinal",0)>0
                ?beginPreview(repository,work,cursor):finishNoMoreSource(repository,work,cursor,false);
            byte[]plain=repository.readPayloadChunk(descriptor,chunkIndex);
            int chunkLength=plain.length;
            DriveSenseP6RoutePointParser.Result parsed;
            try{parsed=DriveSenseP6RoutePointParser.consume(plain,byteOffset,readParserState(repository,work));}
            finally{Arrays.fill(plain,(byte)0);}
            JSONArray compact=compactPoints(parsed.points);
            int examined=parsed.points.length();
            if(compact.length()>0){
                publishDerivedPage(repository,work,compact,pointOrdinal,outputOrdinal);
                pointOrdinal+=compact.length();outputOrdinal++;
            }
            boolean chunkDone=parsed.nextOffset>=chunkLength;
            if(chunkDone){chunkIndex++;byteOffset=0;}else byteOffset=parsed.nextOffset;
            cursor.put("chunkIndex",chunkIndex);cursor.put("byteOffset",byteOffset);
            cursor.put("pointOrdinal",pointOrdinal);cursor.put("outputOrdinal",outputOrdinal);
            cursor.remove("parser");
            persistParserStateAndCursor(repository,work,parsed.parserState,cursor);
            return result("BUILDING",examined+2,chunkLength,true);
        }
    }

    private static void publishDerivedPage(DriveSenseTripArchiveRepository repository,Work work,
                                           JSONArray points,int pointStart,int outputOrdinal)throws Exception{
        String contentVersion=work.revision+":geometry-v1";
        JSONObject page=DriveSenseP6PointBlock.page(points);
        byte[]plaintext=page.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared geometry=DriveSenseP6DerivedBlobStore.prepare(
            repository,work.generation,"trip_derived",work.tripId,work.revision,
            contentVersion,outputOrdinal,plaintext);
        DriveSenseP6DerivedBlobStore.Prepared spill=DriveSenseP6DerivedBlobStore.prepare(
            repository,work.generation,"trip_derived",work.tripId,work.revision,
            work.revision+":road-source-v1",outputOrdinal,plaintext);
        byte[]secret=spatialSecret(repository,work.generation);
        String[]tokens=new String[points.length()];
        try{for(int i=0;i<points.length();i++)tokens[i]=cellToken(secret,points.getJSONObject(i));}
        finally{Arrays.fill(secret,(byte)0);}
        boolean admitted=repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                if(!current(db,work))return false;
                cleanupPendingGeometry(db,repository,work,contentVersion,outputOrdinal);
                cleanupPendingRoadSource(db,work,outputOrdinal);
                ContentValues row=geometryRow(work,geometry,"PENDING");
                db.insertOrThrow("p6_geometry_chunks",null,row);
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",geometry.keyVersion,1);
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return true;
        });
        if(!admitted){
            Arrays.fill(plaintext,(byte)0);Arrays.fill(geometry.ciphertext,(byte)0);
            Arrays.fill(spill.ciphertext,(byte)0);return;
        }
        injectFault("AFTER_GEOMETRY_PENDING_BEFORE_FILE");
        DriveSenseP6DerivedBlobStore.publishFile(repository.coordinator().context(),geometry);
        injectFault("AFTER_GEOMETRY_FILE_BEFORE_STAGE");
        repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                if(!current(db,work))return null;
                db.execSQL("UPDATE p6_geometry_chunks SET commit_state='STAGED',updated_at_ms=? "+
                    "WHERE archive_generation=? AND trip_id=? AND content_version=? AND ordinal=? AND operation_id=?",
                    new Object[]{System.currentTimeMillis(),work.generation,work.tripId,contentVersion,
                        outputOrdinal,geometry.operationId});
                ContentValues observation=new ContentValues();
                observation.put("archive_generation",work.generation);observation.put("trip_id",work.tripId);
                observation.put("source_revision",work.revision);observation.put("ordinal",outputOrdinal);
                observation.put("content_version",work.revision+":road-source-v1");
                observation.put("commit_state","STAGED");observation.put("payload",spill.ciphertext);
                observation.put("payload_nonce",spill.payloadNonce);observation.put("payload_hash",spill.payloadHash);
                observation.put("wrapped_dek",spill.wrappedDek);observation.put("wrap_nonce",spill.wrapNonce);
                observation.put("key_version",spill.keyVersion);observation.put("record_kind","SOURCE_POINT_SPILL");
                observation.put("point_start_ordinal",pointStart);observation.put("point_count",points.length());
                observation.put("updated_at_ms",System.currentTimeMillis());
                db.insertOrThrow("p6_road_observations",null,observation);
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",spill.keyVersion,1);
                // D3 asks only whether a trip revision touched a cell, and every
                // reader resolves a posting to (trip, content version, block) before
                // rereading the block. Consecutive points inside one cell therefore
                // share a single posting: one row per point multiplied this table and
                // its index by the sampling rate for no extra selection power, which
                // the frozen per-point envelope cannot pay for.
                java.util.HashSet<String> seenCells=new java.util.HashSet<>();
                for(int i=0;i<tokens.length;i++){
                    if(!seenCells.add(tokens[i]))continue;
                    db.execSQL("INSERT OR IGNORE INTO p6_trip_spatial_postings("+
                        "archive_generation,cell_token,trip_id,source_revision,content_version,block_ordinal,point_ordinal) "+
                        "VALUES(?,?,?,?,?,?,?)",new Object[]{work.generation,tokens[i],work.tripId,
                            work.revision,contentVersion,outputOrdinal,pointStart+i});
                }
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
        injectFault("AFTER_GEOMETRY_STAGE_BEFORE_CURSOR");
        Arrays.fill(plaintext,(byte)0);Arrays.fill(geometry.ciphertext,(byte)0);Arrays.fill(spill.ciphertext,(byte)0);
    }

    private static JSONObject beginPreview(DriveSenseTripArchiveRepository repository,Work work,
                                           JSONObject sourceCursor)throws Exception{
        JSONObject cursor=new JSONObject();cursor.put("phase","PREVIEW");
        cursor.put("pointOrdinal",sourceCursor.optInt("pointOrdinal",0));
        cursor.put("outputOrdinal",sourceCursor.optInt("outputOrdinal",0));
        cursor.put("previewSourceOrdinal",0);cursor.put("previewSeen",0);
        repository.coordinator().write(db->{
            if(current(db,work))db.execSQL("UPDATE p6_trip_work SET cursor=?,updated_at_ms=? "+
                "WHERE trip_id=? AND desired_revision=?",
                new Object[]{cursor.toString(),System.currentTimeMillis(),work.tripId,work.revision});
            return null;
        });
        return result("PREVIEW_BUILD",2,0,true);
    }

    private static JSONObject previewTurn(DriveSenseTripArchiveRepository repository,Work work,
                                          JSONObject cursor)throws Exception{
        int sourceOrdinal=cursor.optInt("previewSourceOrdinal",0);
        int sourceCount=cursor.optInt("outputOrdinal",0);
        int totalPoints=cursor.optInt("pointOrdinal",0);
        JSONArray preview=readPreviewAccumulator(repository,work);
        if(sourceOrdinal>=sourceCount){
            publishPreview(repository,work,preview);
            return finishNoMoreSource(repository,work,cursor,true);
        }
        DriveSenseP6DerivedBlobStore.Prepared prepared=geometryPage(repository,work,
            work.revision+":geometry-v1",sourceOrdinal,"STAGED");
        if(prepared==null)return stale(repository,work);
        byte[]plain=DriveSenseP6DerivedBlobStore.readFile(repository.coordinator().context(),prepared);
        JSONObject page;
        try{page=new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
        JSONArray points=DriveSenseP6PointBlock.pointsOf(page);
        int seen=cursor.optInt("previewSeen",0);
        int previewCount=Math.min(160,totalPoints);
        for(int local=0;local<points.length();local++){
            int global=seen+local;
            boolean selected=totalPoints<=160;
            if(!selected)for(int target=preview.length();target<previewCount;target++){
                int targetOrdinal=previewTargetOrdinal(totalPoints,previewCount,target);
                if(targetOrdinal==global){selected=true;break;}
                if(targetOrdinal>global)break;
            }
            if(selected&&preview.length()<previewCount)preview.put(points.getJSONObject(local));
        }
        cursor.put("previewSeen",seen+points.length());
        cursor.put("previewSourceOrdinal",sourceOrdinal+1);
        persistPreviewAccumulatorAndCursor(repository,work,preview,cursor);
        return result("PREVIEW_BUILD",points.length()+2,prepared.plaintextBytes,true);
    }

    private static DriveSenseP6DerivedBlobStore.Prepared geometryPage(
            DriveSenseTripArchiveRepository repository,Work work,String contentVersion,
            int ordinal,String commitState)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT relative_path,plaintext_bytes,payload_nonce,payload_hash,"+
                "wrapped_dek,wrap_nonce,key_version FROM p6_geometry_chunks WHERE archive_generation=? "+
                "AND trip_id=? AND content_version=? AND ordinal=? AND commit_state=?",
                new String[]{work.generation,work.tripId,contentVersion,Integer.toString(ordinal),commitState})){
                return c.moveToFirst()?new DriveSenseP6DerivedBlobStore.Prepared(work.generation,"trip_derived",
                    work.tripId,work.revision,contentVersion,ordinal,c.getInt(1),new byte[0],c.getBlob(2),
                    c.getBlob(3),c.getBlob(4),c.getBlob(5),c.getInt(6),c.getString(0),""):null;
            }
        });
    }

    static int previewTargetOrdinal(int totalPoints,int previewCount,int targetIndex){
        if(totalPoints<=0||previewCount<=0||targetIndex<0||targetIndex>=previewCount)
            throw new IllegalArgumentException("P6_PREVIEW_TARGET_OUT_OF_RANGE");
        if(previewCount==1)return 0;
        return (int)Math.round(targetIndex*(totalPoints-1d)/(previewCount-1d));
    }

    private static JSONArray readPreviewAccumulator(DriveSenseTripArchiveRepository repository,
                                                    Work work)throws Exception{
        DriveSenseP6DerivedBlobStore.Prepared prepared=inlineDerived(repository,work,-2,"PREVIEW_ACCUMULATOR",
            work.revision+":preview-accumulator-v1");
        if(prepared==null)return new JSONArray();
        byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(prepared,prepared.ciphertext);
        try{
            return DriveSenseP6PointBlock.pointsOf(
                new JSONObject(new String(plain,StandardCharsets.UTF_8)));
        }
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static DriveSenseP6DerivedBlobStore.Prepared inlineDerived(
            DriveSenseTripArchiveRepository repository,Work work,int ordinal,String kind,
            String contentVersion)throws Exception{
        return repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,key_version "+
                "FROM p6_road_observations WHERE archive_generation=? AND trip_id=? AND source_revision=? "+
                "AND ordinal=? AND record_kind=?",new String[]{work.generation,work.tripId,
                    Integer.toString(work.revision),Integer.toString(ordinal),kind})){
                if(!c.moveToFirst())return null;byte[]cipher=c.getBlob(0);
                return new DriveSenseP6DerivedBlobStore.Prepared(work.generation,"trip_derived",work.tripId,
                    work.revision,contentVersion,ordinal,cipher.length-16,cipher,c.getBlob(1),c.getBlob(2),
                    c.getBlob(3),c.getBlob(4),c.getInt(5),"","");
            }
        });
    }

    private static void persistPreviewAccumulatorAndCursor(DriveSenseTripArchiveRepository repository,
            Work work,JSONArray preview,JSONObject cursor)throws Exception{
        JSONObject value=DriveSenseP6PointBlock.page(preview);
        byte[]plain=value.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(repository,
            work.generation,"trip_derived",work.tripId,work.revision,
            work.revision+":preview-accumulator-v1",-2,plain);
        try{
            repository.coordinator().write(db->{
                db.beginTransaction();
                try{
                    if(!current(db,work))return null;
                    replaceInlineDerived(db,work,-2,"PREVIEW_ACCUMULATOR",prepared);
                    db.execSQL("UPDATE p6_trip_work SET cursor=?,updated_at_ms=? WHERE trip_id=? AND desired_revision=?",
                        new Object[]{cursor.toString(),System.currentTimeMillis(),work.tripId,work.revision});
                    db.setTransactionSuccessful();
                }finally{db.endTransaction();}
                return null;
            });
        }finally{Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);}
    }

    private static void replaceInlineDerived(SQLiteDatabase db,Work work,int ordinal,String kind,
                                             DriveSenseP6DerivedBlobStore.Prepared prepared){
        Integer oldKey=null;
        try(Cursor old=db.rawQuery("SELECT key_version FROM p6_road_observations WHERE archive_generation=? "+
            "AND trip_id=? AND source_revision=? AND ordinal=?",new String[]{work.generation,work.tripId,
                Integer.toString(work.revision),Integer.toString(ordinal)})){
            if(old.moveToFirst()&&!old.isNull(0))oldKey=old.getInt(0);
        }
        ContentValues row=new ContentValues();row.put("archive_generation",work.generation);
        row.put("trip_id",work.tripId);row.put("source_revision",work.revision);row.put("ordinal",ordinal);
        row.put("content_version",prepared.contentVersion);row.put("commit_state","STAGED");
        row.put("payload",prepared.ciphertext);row.put("payload_nonce",prepared.payloadNonce);
        row.put("payload_hash",prepared.payloadHash);row.put("wrapped_dek",prepared.wrappedDek);
        row.put("wrap_nonce",prepared.wrapNonce);row.put("key_version",prepared.keyVersion);
        row.put("record_kind",kind);row.put("point_start_ordinal",0);row.put("point_count",0);
        row.put("updated_at_ms",System.currentTimeMillis());
        db.insertWithOnConflict("p6_road_observations",null,row,SQLiteDatabase.CONFLICT_REPLACE);
        if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
        DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
    }

    private static void publishPreview(DriveSenseTripArchiveRepository repository,Work work,
                                       JSONArray preview)throws Exception{
        JSONObject value=DriveSenseP6PointBlock.page(preview);
        byte[]plain=value.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(repository,
            work.generation,"trip_derived",work.tripId,work.revision,work.revision+":geometry-v1",-1,plain);
        try{
            repository.coordinator().write(db->{
                db.beginTransaction();
                try{
                    if(!current(db,work))return null;
                    cleanupPendingGeometry(db,repository,work,prepared.contentVersion,-1);
                    ContentValues row=geometryRow(work,prepared,"PENDING");
                    db.insertOrThrow("p6_geometry_chunks",null,row);
                    DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
                    db.setTransactionSuccessful();
                }finally{db.endTransaction();}
                return null;
            });
            injectFault("AFTER_PREVIEW_PENDING_BEFORE_FILE");
            DriveSenseP6DerivedBlobStore.publishFile(repository.coordinator().context(),prepared);
            injectFault("AFTER_PREVIEW_FILE_BEFORE_STAGE");
            repository.coordinator().write(db->{
                db.execSQL("UPDATE p6_geometry_chunks SET commit_state='STAGED',updated_at_ms=? WHERE "+
                    "archive_generation=? AND trip_id=? AND content_version=? AND ordinal=-1 AND operation_id=?",
                    new Object[]{System.currentTimeMillis(),work.generation,work.tripId,prepared.contentVersion,
                    prepared.operationId});return null;
            });
            injectFault("AFTER_PREVIEW_STAGE_BEFORE_CURSOR");
        }finally{Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);}
    }

    private static JSONObject finishNoMoreSource(DriveSenseTripArchiveRepository repository,Work work,
                                                  JSONObject cursor,boolean routeFound)throws Exception{
        int points=cursor.optInt("pointOrdinal",0),chunks=cursor.optInt("outputOrdinal",0);
        String contentVersion=work.revision+":geometry-v1";
        JSONObject indexed=repository.getMetadata(work.tripId);if(indexed==null)return stale(repository,work);
        JSONObject parserState=readParserState(repository,work);JSONObject extracted=parserState.optJSONObject("metadata");
        if(extracted!=null){java.util.Iterator<String>keys=extracted.keys();while(keys.hasNext()){
            String key=keys.next();indexed.put(key,extracted.opt(key));
        }}
        JSONObject contribution=contribution(indexed);
        contribution.put("_dayStartMs",(indexed.optLong("start_time_ms",0)/86400000L)*86400000L);
        contribution.put("_orderTimeMs",indexed.optLong("start_time_ms",0));
        byte[]contributionPayload=contribution.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedState.requireDerivedAdmission(repository.coordinator().context(),
            contributionPayload.length*8L+65536L);
        int analyticsKeyVersion=DriveSenseEnvelopeCrypto.activeKekVersion(repository.coordinator());
        boolean[]analyticsCorrupt={false};
        injectFault("BEFORE_DERIVED_HEAD_SWAP");
        repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                if(!current(db,work))return null;
                long now=System.currentTimeMillis();
                JSONObject previous=null;
                try(Cursor old=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,"+
                    "key_version,plaintext_bytes,source_revision FROM p6_trip_contributions WHERE archive_generation=? "+
                    "AND trip_id=? AND metric_schema_version=2",new String[]{work.generation,work.tripId})){
                    if(old.moveToFirst())try{
                        previous=decryptAnalyticsPayload(old,work.generation,
                            analyticsContributionSubject(work.tripId),old.getInt(7),"analytics-v2",0);
                    }catch(Exception corrupt){analyticsCorrupt[0]=true;}
                }
                boolean priorApplied;
                try(Cursor applied=db.rawQuery("SELECT 1 FROM p6_source_applied WHERE archive_generation=? AND trip_id=? AND domain_id='D1_ANALYTICS' LIMIT 1",new String[]{work.generation,work.tripId})){
                    priorApplied=applied.moveToFirst();
                }
                analyticsCorrupt[0]=analyticsCorrupt[0]||(priorApplied&&previous==null);
                if(!analyticsCorrupt[0]){
                    String analyticsSettingsVersion=null;
                    try(Cursor control=db.rawQuery("SELECT settings_version FROM p6_control WHERE domain_id='D1_ANALYTICS'",null)){
                        if(control.moveToFirst())analyticsSettingsVersion=control.getString(0);
                    }
                    applyAnalyticsDelta(db,work,previous,contribution,analyticsKeyVersion);
                    DriveSenseP6DerivedBlobStore.Prepared encryptedContribution=
                        DriveSenseP6DerivedBlobStore.prepareWithKey(work.generation,"trip_derived",
                            analyticsContributionSubject(work.tripId),work.revision,"analytics-v2",0,
                            contributionPayload,analyticsKeyVersion);
                    Integer oldKey=null;try(Cursor old=db.rawQuery("SELECT key_version FROM p6_trip_contributions "+
                        "WHERE archive_generation=? AND trip_id=? AND metric_schema_version=2",
                        new String[]{work.generation,work.tripId})){
                        if(old.moveToFirst()&&!old.isNull(0))oldKey=old.getInt(0);
                    }
                    ContentValues contributionRow=new ContentValues();contributionRow.put("archive_generation",work.generation);
                    contributionRow.put("trip_id",work.tripId);contributionRow.put("metric_schema_version",2);
                    contributionRow.put("source_revision",work.revision);contributionRow.put("source_hash",work.sourceHash);
                    putEncryptedPayload(contributionRow,encryptedContribution);contributionRow.put("updated_at_ms",now);
                    db.insertWithOnConflict("p6_trip_contributions",null,contributionRow,SQLiteDatabase.CONFLICT_REPLACE);
                    if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
                    DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",analyticsKeyVersion,1);
                    Arrays.fill(encryptedContribution.ciphertext,(byte)0);
                    db.execSQL("INSERT OR REPLACE INTO p6_source_applied(archive_generation,trip_id,domain_id,"+
                        "source_revision,source_hash,algorithm_version,settings_version,published_content_version,"+
                        "updated_at_ms) VALUES(?,?,?,?,?,2,?,?,?)",new Object[]{work.generation,work.tripId,
                        "D1_ANALYTICS",work.revision,work.sourceHash,analyticsSettingsVersion,
                        work.revision+":analytics-v2",now});
                    db.delete("p6_recent_order","archive_generation=? AND trip_id=?",
                        new String[]{work.generation,work.tripId});
                    db.execSQL("INSERT INTO p6_recent_order(archive_generation,order_time_ms,trip_id,"+
                        "source_revision,eligible) VALUES(?,?,?,?,?)",new Object[]{work.generation,
                        contribution.optLong("_orderTimeMs",0),work.tripId,work.revision,
                        contribution.optInt("completedCount",0)>0?1:0});
                }else{
                    db.execSQL("UPDATE p6_control SET state='DIRTY',complete=0,storage_outcome='PRIOR_CONTRIBUTION_MISSING',updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",new Object[]{now});
                    db.execSQL("UPDATE p6_manifests SET state='DIRTY',complete=0,updated_at_ms=? WHERE domain_id='D1_ANALYTICS' AND subject_id=?",new Object[]{now,work.tripId});
                }
                manifest(db,"D2_GEOMETRY",work,contentVersion,
                    routeFound&&points>0?"VERIFIED":"NO_PUBLIC_GEOMETRY",true,now);
                manifest(db,"D3_SPATIAL_SELECTION",work,contentVersion,
                    routeFound&&points>0?"VERIFIED":"NO_PUBLIC_GEOMETRY",true,now);
                manifest(db,"D4_ROAD_LEARNING_SPEED_LOOKUP",work,contentVersion,
                    routeFound&&points>0?"PARTIAL":"VERIFIED",!routeFound||points==0,now);
                db.execSQL("UPDATE p6_geometry_chunks SET commit_state='COMMITTED',updated_at_ms=? "+
                    "WHERE archive_generation=? AND trip_id=? AND content_version=? AND commit_state='STAGED'",
                    new Object[]{now,work.generation,work.tripId,contentVersion});
                db.execSQL("UPDATE p6_road_observations SET commit_state='COMMITTED',updated_at_ms=? "+
                    "WHERE archive_generation=? AND trip_id=? AND source_revision=? AND commit_state='STAGED'",
                    new Object[]{now,work.generation,work.tripId,work.revision});
                try(Cursor parser=db.rawQuery("SELECT key_version,COUNT(*) FROM p6_road_observations WHERE "+
                    "archive_generation=? AND trip_id=? AND source_revision=? AND ordinal IN (-1,-2) "+
                    "AND record_kind IN ('PARSER_CURSOR','PREVIEW_ACCUMULATOR') GROUP BY key_version",
                    new String[]{work.generation,work.tripId,Integer.toString(work.revision)})){
                    while(parser.moveToNext()&&!parser.isNull(0))
                        DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",parser.getInt(0),-parser.getLong(1));
                }
                db.delete("p6_road_observations","archive_generation=? AND trip_id=? AND source_revision=? "+
                    "AND ordinal IN (-1,-2) AND record_kind IN ('PARSER_CURSOR','PREVIEW_ACCUMULATOR')",
                    new String[]{work.generation,work.tripId,Integer.toString(work.revision)});
                db.execSQL("INSERT OR REPLACE INTO p6_source_applied("+
                    "archive_generation,trip_id,domain_id,source_revision,source_hash,algorithm_version,"+
                    "settings_version,published_content_version,updated_at_ms) VALUES(?,?,?,?,?,1,NULL,?,?)",
                    new Object[]{work.generation,work.tripId,"D2_GEOMETRY",work.revision,
                        work.sourceHash,contentVersion,now});
                db.execSQL("INSERT OR REPLACE INTO p6_source_applied("+
                    "archive_generation,trip_id,domain_id,source_revision,source_hash,algorithm_version,"+
                    "settings_version,published_content_version,updated_at_ms) VALUES(?,?,?,?,?,1,NULL,?,?)",
                    new Object[]{work.generation,work.tripId,"D3_SPATIAL_SELECTION",work.revision,
                        work.sourceHash,contentVersion,now});
                db.execSQL("UPDATE p6_trip_work SET state=?,cursor=NULL,updated_at_ms=? "+
                    "WHERE trip_id=? AND desired_revision=?",
                    new Object[]{routeFound&&points>0?"COMPLETE":"ROAD_COMPLETE",now,work.tripId,work.revision});
                db.execSQL("UPDATE p6_control SET source_binding=?,applied_version=MAX(applied_version,?),"+
                    "state='PARTIAL',complete=0,cursor=?,updated_at_ms=? WHERE domain_id IN "+
                    "('D2_GEOMETRY','D3_SPATIAL_SELECTION','D4_ROAD_LEARNING_SPEED_LOOKUP')",
                    new Object[]{work.generation,work.desiredSeq,work.tripId,now});
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
        injectFault("AFTER_DERIVED_HEAD_SWAP");
        Arrays.fill(contributionPayload,(byte)0);
        if(analyticsCorrupt[0])return result("DIRTY_PRIOR_CONTRIBUTION_MISSING",chunks+3,0,true);
        return result(routeFound&&points>0?"PUBLISHED":"NO_PUBLIC_GEOMETRY",chunks+3,0,true);
    }

    private static JSONObject stale(DriveSenseTripArchiveRepository repository,Work work)throws Exception{
        repository.coordinator().write(db->{
            if(current(db,work))db.execSQL(
                "UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? WHERE trip_id=?",
                new Object[]{System.currentTimeMillis(),work.tripId});
            return null;
        });
        return result("STALE_SOURCE",1,0,true);
    }

    private static JSONObject cleanupTombstone(DriveSenseTripArchiveRepository repository,Work work)throws Exception{
        DriveSenseP6DerivedState.requireDerivedAdmission(repository.coordinator().context(),128L*1024L);
        int analyticsKeyVersion=DriveSenseEnvelopeCrypto.activeKekVersion(repository.coordinator());
        return repository.coordinator().write(db->{
            db.beginTransaction();
            try{
                String phase=work.cursor==null||work.cursor.isEmpty()?"CONTRIBUTION":work.cursor;
                if("CONTRIBUTION".equals(phase)){
                    JSONObject previous=null;Integer oldKey=null;boolean analyticsCorrupt=false;
                    try(Cursor old=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,"+
                        "wrap_nonce,key_version,plaintext_bytes,source_revision FROM p6_trip_contributions WHERE "+
                        "archive_generation=? AND trip_id=? AND metric_schema_version=2",
                        new String[]{work.generation,work.tripId})){
                        if(old.moveToFirst()){
                            if(!old.isNull(5))oldKey=old.getInt(5);
                            try{previous=decryptAnalyticsPayload(old,work.generation,
                                analyticsContributionSubject(work.tripId),old.getInt(7),"analytics-v2",0);}
                            catch(Exception corrupt){analyticsCorrupt=true;}
                        }
                    }
                    if(previous!=null&&!analyticsCorrupt)try{
                        adjustAnalyticsBucket(db,"global",work,previous,-1,analyticsKeyVersion);
                        adjustAnalyticsBucket(db,"utc-day:"+previous.optLong("_dayStartMs",0),
                            work,previous,-1,analyticsKeyVersion);
                    }catch(Exception corrupt){analyticsCorrupt=true;}
                    if(analyticsCorrupt)db.execSQL("UPDATE p6_control SET state='DIRTY',complete=0,"+
                        "storage_outcome='PRIOR_CONTRIBUTION_MISSING',updated_at_ms=? "+
                        "WHERE domain_id='D1_ANALYTICS'",new Object[]{System.currentTimeMillis()});
                    if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
                    db.delete("p6_trip_contributions","archive_generation=? AND trip_id=?",
                        new String[]{work.generation,work.tripId});
                    db.delete("p6_recent_order","archive_generation=? AND trip_id=?",
                        new String[]{work.generation,work.tripId});
                    db.delete("p6_source_applied","archive_generation=? AND trip_id=?",
                        new String[]{work.generation,work.tripId});
                    db.execSQL("UPDATE p6_trip_work SET state='TOMBSTONE_CLEANUP',cursor='GEOMETRY',updated_at_ms=? WHERE trip_id=?",
                        new Object[]{System.currentTimeMillis(),work.tripId});
                    db.setTransactionSuccessful();return result("TOMBSTONE_CLEANUP",4,0,true);
                }
                JSONObject result=cleanupTombstonePage(db,repository,work,phase);
                db.setTransactionSuccessful();return result;
            }finally{db.endTransaction();}
        });
    }

    private static JSONObject cleanupTombstonePage(SQLiteDatabase db,
            DriveSenseTripArchiveRepository repository,Work work,String phase)throws Exception{
        String table,where="archive_generation=? AND trip_id=?",next;
        if("GEOMETRY".equals(phase)){table="p6_geometry_chunks";next="POSTINGS";}
        else if("POSTINGS".equals(phase)){table="p6_trip_spatial_postings";next="OBSERVATIONS";}
        else if("OBSERVATIONS".equals(phase)){table="p6_road_observations";next="WINDOWS";}
        else if("WINDOWS".equals(phase)){table="p6_road_windows";next="MANIFEST";}
        else{
            db.delete("p6_manifests","subject_id=?",new String[]{work.tripId});
            manifest(db,"D2_GEOMETRY",work,null,"NO_PUBLIC_GEOMETRY",true,System.currentTimeMillis());
            db.execSQL("UPDATE p6_trip_work SET state='ROAD_COMPLETE',cursor=NULL,updated_at_ms=? WHERE trip_id=?",
                new Object[]{System.currentTimeMillis(),work.tripId});
            return result("TOMBSTONE_COMPLETE",2,0,true);
        }
        String[]args={work.generation,work.tripId};int removed;
        java.util.List<String[]>postingKeys=null;
        if("p6_trip_spatial_postings".equals(table)){
            postingKeys=new java.util.ArrayList<>();
            try(Cursor rows=db.rawQuery("SELECT cell_token,source_revision,content_version,block_ordinal,"+
                "point_ordinal FROM p6_trip_spatial_postings WHERE "+where+
                " ORDER BY cell_token,source_revision,content_version,block_ordinal,point_ordinal LIMIT 128",args)){
                while(rows.moveToNext())postingKeys.add(new String[]{rows.getString(0),rows.getString(1),
                    rows.getString(2),rows.getString(3),rows.getString(4)});
            }
            removed=postingKeys.size();
        }else try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM (SELECT rowid FROM "+table+
            " WHERE "+where+" LIMIT 128)",args)){removed=count.moveToFirst()?count.getInt(0):0;}
        if("p6_geometry_chunks".equals(table)){
            try(Cursor rows=db.rawQuery("SELECT relative_path,key_version FROM p6_geometry_chunks WHERE "+
                where+" LIMIT 128",args)){
                while(rows.moveToNext()){
                    DriveSenseP6DerivedBlobStore.deleteFile(repository.coordinator().context(),rows.getString(0));
                    DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",rows.getInt(1),-1);
                }
            }
        }else if("p6_road_observations".equals(table)||"p6_road_windows".equals(table)){
            try(Cursor rows=db.rawQuery("SELECT key_version,COUNT(*) FROM (SELECT key_version FROM "+
                table+" WHERE "+where+" LIMIT 128) GROUP BY key_version",args)){
                while(rows.moveToNext()&&!rows.isNull(0))
                    DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",rows.getInt(0),-rows.getLong(1));
            }
        }
        if(postingKeys!=null)for(String[]key:postingKeys)db.delete("p6_trip_spatial_postings",
            "archive_generation=? AND trip_id=? AND cell_token=? AND source_revision=? AND "+
                "content_version=? AND block_ordinal=? AND point_ordinal=?",
            new String[]{work.generation,work.tripId,key[0],key[1],key[2],key[3],key[4]});
        else db.execSQL("DELETE FROM "+table+" WHERE rowid IN (SELECT rowid FROM "+table+
            " WHERE "+where+" LIMIT 128)",args);
        boolean more;
        try(Cursor check=db.rawQuery("SELECT 1 FROM "+table+" WHERE "+where+" LIMIT 1",args)){
            more=check.moveToFirst();
        }
        db.execSQL("UPDATE p6_trip_work SET cursor=?,updated_at_ms=? WHERE trip_id=?",
            new Object[]{more?phase:next,System.currentTimeMillis(),work.tripId});
        return result("TOMBSTONE_CLEANUP",removed+1L,0,true);
    }

    private static void cleanupPendingGeometry(SQLiteDatabase db,
            DriveSenseTripArchiveRepository repository,Work work,String contentVersion,int ordinal){
        try(Cursor c=db.rawQuery("SELECT relative_path,key_version FROM p6_geometry_chunks WHERE "+
            "archive_generation=? AND trip_id=? AND content_version=? AND ordinal=? AND commit_state<>'COMMITTED'",
            new String[]{work.generation,work.tripId,contentVersion,Integer.toString(ordinal)})){
            while(c.moveToNext()){
                DriveSenseP6DerivedBlobStore.deleteFile(repository.coordinator().context(),c.getString(0));
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",c.getInt(1),-1);
            }
        }
        db.delete("p6_geometry_chunks","archive_generation=? AND trip_id=? AND content_version=? "+
            "AND ordinal=? AND commit_state<>'COMMITTED'",new String[]{work.generation,work.tripId,
                contentVersion,Integer.toString(ordinal)});
    }

    private static void cleanupPendingRoadSource(SQLiteDatabase db,Work work,int ordinal){
        try(Cursor c=db.rawQuery("SELECT key_version FROM p6_road_observations WHERE archive_generation=? "+
            "AND trip_id=? AND source_revision=? AND ordinal=? AND record_kind='SOURCE_POINT_SPILL' "+
            "AND commit_state<>'COMMITTED'",new String[]{work.generation,work.tripId,
                Integer.toString(work.revision),Integer.toString(ordinal)})){
            while(c.moveToNext()&&!c.isNull(0))
                DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",c.getInt(0),-1);
        }
        db.delete("p6_road_observations","archive_generation=? AND trip_id=? AND source_revision=? "+
            "AND ordinal=? AND record_kind='SOURCE_POINT_SPILL' AND commit_state<>'COMMITTED'",
            new String[]{work.generation,work.tripId,Integer.toString(work.revision),Integer.toString(ordinal)});
    }

    private static ContentValues geometryRow(Work work,
            DriveSenseP6DerivedBlobStore.Prepared value,String state){
        ContentValues row=new ContentValues();row.put("archive_generation",work.generation);
        row.put("trip_id",work.tripId);row.put("content_version",value.contentVersion);
        row.put("ordinal",value.ordinal);row.put("commit_state",state);
        row.put("relative_path",value.relativePath);row.put("plaintext_bytes",value.plaintextBytes);
        row.put("ciphertext_bytes",value.ciphertext.length);row.put("key_version",value.keyVersion);
        row.put("payload_nonce",value.payloadNonce);row.put("payload_hash",value.payloadHash);
        row.put("wrapped_dek",value.wrappedDek);row.put("wrap_nonce",value.wrapNonce);
        row.put("operation_id",value.operationId);row.put("updated_at_ms",System.currentTimeMillis());
        return row;
    }

    private static JSONObject readParserState(DriveSenseTripArchiveRepository repository,
                                              Work work)throws Exception{
        DriveSenseP6DerivedBlobStore.Prepared value=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,key_version "+
                "FROM p6_road_observations WHERE archive_generation=? AND trip_id=? AND source_revision=? "+
                "AND ordinal=-1 AND record_kind='PARSER_CURSOR'",
                new String[]{work.generation,work.tripId,Integer.toString(work.revision)})){
                if(!c.moveToFirst())return null;
                byte[]cipher=c.getBlob(0);
                return new DriveSenseP6DerivedBlobStore.Prepared(work.generation,"trip_derived",work.tripId,
                    work.revision,work.revision+":parser-v1",-1,cipher.length-16,cipher,c.getBlob(1),
                    c.getBlob(2),c.getBlob(3),c.getBlob(4),c.getInt(5),"","");
            }
        });
        if(value==null)return new JSONObject();
        byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(value,value.ciphertext);
        try{return new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static void persistParserStateAndCursor(DriveSenseTripArchiveRepository repository,
            Work work,JSONObject parserState,JSONObject cursor)throws Exception{
        byte[]plain=parserState.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(
            repository,work.generation,"trip_derived",work.tripId,work.revision,
            work.revision+":parser-v1",-1,plain);
        try{
            repository.coordinator().write(db->{
                db.beginTransaction();
                try{
                    if(!current(db,work))return null;
                    Integer oldKey=null;
                    try(Cursor old=db.rawQuery("SELECT key_version FROM p6_road_observations WHERE "+
                        "archive_generation=? AND trip_id=? AND source_revision=? AND ordinal=-1",
                        new String[]{work.generation,work.tripId,Integer.toString(work.revision)})){
                        if(old.moveToFirst()&&!old.isNull(0))oldKey=old.getInt(0);
                    }
                    ContentValues row=new ContentValues();row.put("archive_generation",work.generation);
                    row.put("trip_id",work.tripId);row.put("source_revision",work.revision);row.put("ordinal",-1);
                    row.put("content_version",work.revision+":parser-v1");row.put("commit_state","STAGED");
                    row.put("payload",prepared.ciphertext);row.put("payload_nonce",prepared.payloadNonce);
                    row.put("payload_hash",prepared.payloadHash);row.put("wrapped_dek",prepared.wrappedDek);
                    row.put("wrap_nonce",prepared.wrapNonce);row.put("key_version",prepared.keyVersion);
                    row.put("record_kind","PARSER_CURSOR");row.put("point_start_ordinal",0);
                    row.put("point_count",0);row.put("updated_at_ms",System.currentTimeMillis());
                    db.insertWithOnConflict("p6_road_observations",null,row,SQLiteDatabase.CONFLICT_REPLACE);
                    if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
                    DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
                    db.execSQL("UPDATE p6_trip_work SET state='BUILDING',cursor=?,updated_at_ms=? "+
                        "WHERE trip_id=? AND desired_revision=?",
                        new Object[]{cursor.toString(),System.currentTimeMillis(),work.tripId,work.revision});
                    db.setTransactionSuccessful();
                }finally{db.endTransaction();}
                return null;
            });
        }finally{Arrays.fill(plain,(byte)0);Arrays.fill(prepared.ciphertext,(byte)0);}
    }

    private static byte[] spatialSecret(DriveSenseTripArchiveRepository repository,
                                        String generation)throws Exception{
        DriveSenseP6DerivedBlobStore.Prepared existing=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT wrapped_dek,wrap_nonce,key_version,payload,payload_nonce,"+
                "payload_hash FROM p6_spatial_secrets WHERE secret_id='spatial-v1' AND archive_generation=?",
                new String[]{generation})){
                return c.moveToFirst()?new DriveSenseP6DerivedBlobStore.Prepared(
                    generation,"trip_derived","spatial-v1",1,"secret-v1",0,32,
                    c.getBlob(3),c.getBlob(4),c.getBlob(5),c.getBlob(0),c.getBlob(1),
                    c.getInt(2),"",""):null;
            }
        });
        if(existing!=null)try{
            return DriveSenseP6DerivedBlobStore.decrypt(existing,existing.ciphertext);
        }catch(Exception corrupt){
            demoteSpatialAuthority(repository,generation,"DERIVED_SPATIAL_HMAC_CORRUPT",true);
            throw new SpatialAuthorityCorruptException("DERIVED_SPATIAL_HMAC_CORRUPT",corrupt);
        }
        boolean publishedIndex=repository.coordinator().read(db->
            count(db,"SELECT COUNT(*) FROM p6_trip_spatial_postings WHERE archive_generation=?",
                new String[]{generation})>0||
            count(db,"SELECT COUNT(*) FROM p6_source_applied WHERE archive_generation=? "+
                "AND domain_id='D3_SPATIAL_SELECTION'",new String[]{generation})>0||
            count(db,"SELECT COUNT(*) FROM p6_control WHERE domain_id='D3_SPATIAL_SELECTION' "+
                "AND state='VERIFIED' AND complete=1",null)>0);
        if(publishedIndex){
            demoteSpatialAuthority(repository,generation,"DERIVED_SPATIAL_HMAC_MISSING",true);
            throw new SpatialAuthorityCorruptException("DERIVED_SPATIAL_HMAC_MISSING",null);
        }
        byte[]secret=DriveSenseEnvelopeCrypto.newDek();
        DriveSenseP6DerivedBlobStore.Prepared prepared=DriveSenseP6DerivedBlobStore.prepare(
            repository,generation,"trip_derived","spatial-v1",1,"secret-v1",0,secret);
        repository.coordinator().write(db->{
            ContentValues row=new ContentValues();row.put("secret_id","spatial-v1");
            row.put("archive_generation",generation);row.put("wrapped_dek",prepared.wrappedDek);
            row.put("wrap_nonce",prepared.wrapNonce);row.put("key_version",prepared.keyVersion);
            row.put("payload",prepared.ciphertext);row.put("payload_nonce",prepared.payloadNonce);
            row.put("payload_hash",prepared.payloadHash);row.put("updated_at_ms",System.currentTimeMillis());
            db.insertOrThrow("p6_spatial_secrets",null,row);
            DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",prepared.keyVersion,1);
            return null;
        });
        Arrays.fill(prepared.ciphertext,(byte)0);
        return secret;
    }

    /** Validate only the posting reached by the bounded cell cursor. Global
     * history scans are forbidden on E3/J3; later postings are validated on
     * their own turns before any candidate can be emitted. */
    private static String spatialPostingCorruption(DriveSenseTripArchiveRepository repository,
            String generation,String token,Posting posting)throws Exception{
        if(token==null||!token.matches("[A-Za-z0-9_-]{22}")||posting.blockOrdinal<0
                ||posting.pointOrdinal<0)return "DERIVED_SPATIAL_INDEX_CORRUPT";
        boolean receipt=repository.coordinator().read(db->{
            try(Cursor c=db.rawQuery("SELECT 1 FROM p6_source_applied a "+
                "JOIN trip_current t ON t.trip_id=a.trip_id AND t.revision=a.source_revision "+
                "JOIN trip_revisions r ON r.trip_id=t.trip_id AND r.revision=t.revision "+
                "WHERE a.archive_generation=? AND a.trip_id=? "+
                "AND a.domain_id='D3_SPATIAL_SELECTION' AND a.source_revision=? "+
                "AND a.source_hash=r.payload_hash AND r.commit_state='COMMITTED' "+
                "AND a.published_content_version=? LIMIT 1",new String[]{generation,posting.tripId,
                    Integer.toString(posting.revision),posting.contentVersion})){
                return c.moveToFirst();
            }
        });
        return receipt?null:"DERIVED_SPATIAL_APPLIED_RECEIPT_CORRUPT";
    }

    private static void demoteSpatialAuthority(DriveSenseTripArchiveRepository repository,
                                               String generation,String reason,
                                               boolean retireSecret)throws Exception{
        repository.coordinator().write(db->{
            db.beginTransaction();try{
                long now=System.currentTimeMillis();
                if(retireSecret){
                    try(Cursor refs=db.rawQuery("SELECT key_version,COUNT(*) FROM p6_spatial_secrets "+
                        "WHERE archive_generation=? GROUP BY key_version",new String[]{generation})){
                        while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(
                            db,"trip_derived",refs.getInt(0),-refs.getLong(1));
                    }
                    db.delete("p6_spatial_secrets","archive_generation=?",new String[]{generation});
                }
                try(Cursor refs=db.rawQuery("SELECT key_version,COUNT(*) FROM p6_selection_requests "+
                    "WHERE archive_generation=? GROUP BY key_version",new String[]{generation})){
                    while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(
                        db,"trip_derived",refs.getInt(0),-refs.getLong(1));
                }
                db.delete("p6_selection_requests","archive_generation=?",new String[]{generation});
                db.delete("p6_trip_spatial_postings","archive_generation=?",new String[]{generation});
                db.delete("p6_source_applied","archive_generation=? AND domain_id='D3_SPATIAL_SELECTION'",
                    new String[]{generation});
                db.execSQL("UPDATE p6_manifests SET state='REBUILD_REQUIRED',complete=0,updated_at_ms=? "+
                    "WHERE domain_id='D3_SPATIAL_SELECTION' AND source_binding=?",new Object[]{now,generation});
                db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,storage_outcome=?,"+
                    "updated_at_ms=? WHERE domain_id='D3_SPATIAL_SELECTION'",new Object[]{reason,now});
                db.execSQL("UPDATE p6_trip_work SET state='DIRTY',cursor=NULL,updated_at_ms=? "+
                    "WHERE archive_generation=?",new Object[]{now,generation});
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return null;
        });
    }

    private static final class SpatialAuthorityCorruptException extends Exception{
        SpatialAuthorityCorruptException(String code,Throwable cause){super(code,cause);}
    }

    private static String cellToken(byte[]secret,JSONObject point)throws Exception{
        double size=.00135d,lat=point.optDouble("lat"),lng=point.optDouble("lng");
        String cell=(long)Math.floor((lat+90d)/size)+":"+(long)Math.floor((lng+180d)/size);
        return cellToken(secret,cell);
    }

    private static String cellToken(byte[]secret,String cell)throws Exception{
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret,"HmacSHA256"));
        // Persist a 128-bit opaque lookup token derived from HMAC-SHA-256. The
        // full digest has no additional lookup value and is duplicated in both
        // spatial B-trees; 128 bits keeps collision probability negligible at
        // the frozen multi-million-point scale while honoring the footprint law.
        byte[]digest=mac.doFinal(cell.getBytes(StandardCharsets.UTF_8));
        try{return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
            Arrays.copyOf(digest,16));}
        finally{Arrays.fill(digest,(byte)0);}
    }

    private static JSONArray compactPoints(JSONArray source)throws Exception{
        JSONArray out=new JSONArray();
        for(int i=0;i<source.length();i++){
            JSONObject point=source.optJSONObject(i);if(point==null)continue;
            double lat=point.optDouble("lat",Double.NaN),lng=point.optDouble("lng",Double.NaN);
            if(!Double.isFinite(lat)||!Double.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)continue;
            if(point.optBoolean("privacy_export_placeholder")||point.optBoolean("privacy_masked")
                ||point.optBoolean("masked_for_privacy")||point.optBoolean("privacy_gap")
                ||point.optBoolean("privacy_live_redacted"))continue;
            JSONObject value=new JSONObject();value.put("lat",lat);value.put("lng",lng);
            copy(point,value,"timestamp","timestampMs","recorded_at");
            copy(point,value,"speed_kmh","speedKmh");copy(point,value,"heading","bearing");
            copy(point,value,"accuracy");copy(point,value,"speed_limit_kmh","limitKmh");
            copy(point,value,"speed_limit_source","limitSource");
            copy(point,value,"utc_offset_minutes","utcOffsetMinutes");
            copy(point,value,"timezone_id","timezoneId");out.put(value);
        }
        return out;
    }

    private static void copy(JSONObject source,JSONObject target,String...keys)throws Exception{
        for(String key:keys)if(source.has(key)&&!source.isNull(key)){target.put(key,source.opt(key));return;}
    }

    private static JSONObject contribution(JSONObject trip)throws Exception{
        JSONObject out=new JSONObject();boolean complete="completed".equals(trip.optString("status"));
        double distance=trip.optDouble("distance_km",trip.optDouble("distance",0));
        double score=trip.has("score_overall")&&!trip.isNull("score_overall")
            ?trip.optDouble("score_overall"):Double.NaN;
        boolean clean=trip.optInt("harsh_brakes_count",0)==0&&trip.optInt("rapid_accel_count",0)==0
            &&trip.optInt("sharp_turns_count",0)==0&&trip.optInt("speeding_events_count",0)==0;
        out.put("completedCount",complete?1:0);out.put("totalKm",complete?distance:0);
        out.put("nightCount",complete&&trip.optBoolean("night_driving")?1:0);
        out.put("cleanTripCount",complete&&clean?1:0);
        out.put("noHarshTrips",complete&&trip.optInt("harsh_brakes_count",0)==0?1:0);
        out.put("noRapidTrips",complete&&trip.optInt("rapid_accel_count",0)==0?1:0);
        out.put("noSharpTrips",complete&&trip.optInt("sharp_turns_count",0)==0?1:0);
        out.put("noSpeedingTrips",complete&&trip.optInt("speeding_events_count",0)==0?1:0);
        out.put("routeReplayTrips",complete&&trip.optBoolean("route_replay_available")?1:0);
        double duration=trip.optDouble("duration_seconds",trip.optDouble("duration",0));
        out.put("longTrips",complete&&duration>=3600?1:0);
        out.put("cleanLongTrips",complete&&clean&&duration>=3600?1:0);
        out.put("cleanNightTrips",complete&&clean&&trip.optBoolean("night_driving")?1:0);
        out.put("highScoreTrips",complete&&Double.isFinite(score)&&score>=90?1:0);
        out.put("excellentScoreTrips",complete&&Double.isFinite(score)&&score>=95?1:0);
        out.put("cleanExcellentTrips",complete&&clean&&Double.isFinite(score)&&score>=95?1:0);
        out.put("smoothBrakeTrips",complete&&trip.optDouble("smooth_braking_ratio")==100?1:0);
        out.put("distractionFreeTrips",complete&&trip.optBoolean("phone_use_score_available")
            &&"none".equals(trip.optString("phone_use_risk"))?1:0);
        out.put("cruiseMasterTrips",complete&&"excellent cruise".equals(trip.optString("band_label"))?1:0);
        out.put("manoeuvreAlertFreeTrips",complete&&trip.optInt("close_proximity_count",0)==0?1:0);
        out.put("scoreDistanceProduct",complete&&distance>0&&Double.isFinite(score)?score*distance:0);
        out.put("scoreDistanceWeight",complete&&distance>0&&Double.isFinite(score)?distance:0);
        double carbon=trip.optDouble("estimated_co2_saved_kg",Double.NaN);
        out.put("carbonCo2SavedKg",complete&&Double.isFinite(carbon)?carbon:0);
        out.put("carbonEligibleTripCount",complete&&Double.isFinite(carbon)?1:0);
        out.put("harshBrakesCount",complete?Math.max(0,trip.optInt("harsh_brakes_count",0)):0);
        out.put("_defensiveGrade",trip.optString("defensive_grade",""));
        return out;
    }

    private static void applyAnalyticsDelta(SQLiteDatabase db,Work work,JSONObject previous,
                                            JSONObject next,int keyVersion)throws Exception{
        adjustAnalyticsBucket(db,"global",work,previous,-1,keyVersion);
        adjustAnalyticsBucket(db,"global",work,next,1,keyVersion);
        if(previous!=null)adjustAnalyticsBucket(db,"utc-day:"+previous.optLong("_dayStartMs",0),work,previous,-1,keyVersion);
        adjustAnalyticsBucket(db,"utc-day:"+next.optLong("_dayStartMs",0),work,next,1,keyVersion);
    }

    private static void adjustAnalyticsBucket(SQLiteDatabase db,String key,Work work,
                                              JSONObject contribution,int sign,int keyVersion)throws Exception{
        if(contribution==null)return;
        JSONObject total=new JSONObject();
        Integer oldKey=null;
        try(Cursor c=db.rawQuery("SELECT payload,payload_nonce,payload_hash,wrapped_dek,wrap_nonce,"+
            "key_version,plaintext_bytes,metric_schema_version FROM p6_analytics_buckets WHERE bucket_key=?",
            new String[]{key})){
            if(c.moveToFirst()){
                total=decryptAnalyticsPayload(c,work.generation,analyticsBucketSubject(key),
                    c.getInt(7),"analytics-bucket-v2",0);
                if(!c.isNull(5))oldKey=c.getInt(5);
            }
        }
        java.util.Iterator<String>keys=contribution.keys();
        while(keys.hasNext()){
            String metric=keys.next();if(metric.startsWith("_"))continue;
            Object raw=contribution.opt(metric);if(!(raw instanceof Number))continue;
            double value=((Number)raw).doubleValue();
            double updated=total.optDouble(metric,0)+sign*value;
            if(Math.rint(updated)==updated)total.put(metric,(long)updated);else total.put(metric,updated);
        }
        byte[]payload=total.toString().getBytes(StandardCharsets.UTF_8);
        DriveSenseP6DerivedBlobStore.Prepared encrypted=DriveSenseP6DerivedBlobStore.prepareWithKey(
            work.generation,"trip_derived",analyticsBucketSubject(key),2,"analytics-bucket-v2",0,
            payload,keyVersion);
        ContentValues row=new ContentValues();row.put("bucket_key",key);
        row.put("source_binding",work.generation);row.put("metric_schema_version",2);
        putEncryptedPayload(row,encrypted);row.put("through_seq",work.desiredSeq);
        row.put("updated_at_ms",System.currentTimeMillis());
        db.insertWithOnConflict("p6_analytics_buckets",null,row,SQLiteDatabase.CONFLICT_REPLACE);
        if(oldKey!=null)DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",oldKey,-1);
        DriveSenseKeyReferenceCounts.adjust(db,"trip_derived",keyVersion,1);
        Arrays.fill(payload,(byte)0);Arrays.fill(encrypted.ciphertext,(byte)0);
    }

    private static String analyticsContributionSubject(String tripId){return "analytics-contribution:"+tripId;}
    private static String analyticsBucketSubject(String key){return "analytics-bucket:"+key;}

    private static void putEncryptedPayload(ContentValues row,DriveSenseP6DerivedBlobStore.Prepared value){
        row.put("payload",value.ciphertext);row.put("payload_nonce",value.payloadNonce);
        row.put("payload_hash",value.payloadHash);row.put("wrapped_dek",value.wrappedDek);
        row.put("wrap_nonce",value.wrapNonce);row.put("key_version",value.keyVersion);
        row.put("plaintext_bytes",value.plaintextBytes);
    }

    /** Cursor columns are payload, nonce, hash, wrapped DEK, wrap nonce, key
     * version, plaintext bytes, followed by caller-specific metadata. */
    private static JSONObject decryptAnalyticsPayload(Cursor row,String generation,String subject,
                                                       int revision,String contentVersion,int ordinal)throws Exception{
        if(row.isNull(1)||row.isNull(2)||row.isNull(3)||row.isNull(4)||row.isNull(5)||row.isNull(6))
            throw new SecurityException("P6_ANALYTICS_PLAINTEXT_LEGACY_ROW");
        DriveSenseP6DerivedBlobStore.Prepared value=new DriveSenseP6DerivedBlobStore.Prepared(
            generation,"trip_derived",subject,revision,contentVersion,ordinal,row.getInt(6),row.getBlob(0),
            row.getBlob(1),row.getBlob(2),row.getBlob(3),row.getBlob(4),row.getInt(5),"","");
        byte[]plain=DriveSenseP6DerivedBlobStore.decrypt(value,value.ciphertext);
        try{return new JSONObject(new String(plain,StandardCharsets.UTF_8));}
        finally{Arrays.fill(plain,(byte)0);}
    }

    private static void manifest(SQLiteDatabase db,String domain,Work work,String contentVersion,
                                 String state,boolean complete,long now){
        db.execSQL("INSERT OR REPLACE INTO p6_manifests(domain_id,subject_id,source_binding,"+
            "required_version,applied_version,content_version,state,complete,updated_at_ms) "+
            "VALUES(?,?,?,?,?,?,?,?,?)",new Object[]{domain,work.tripId,work.generation,work.revision,
                work.revision,contentVersion,state,complete?1:0,now});
    }

    private static boolean current(SQLiteDatabase db,Work work){
        try(Cursor c=db.rawQuery("SELECT archive_generation,desired_revision,source_hash FROM p6_trip_work WHERE trip_id=?",
            new String[]{work.tripId})){
            return c.moveToFirst()&&work.generation.equals(c.getString(0))&&work.revision==c.getInt(1)
                &&Arrays.equals(work.sourceHash,c.getBlob(2));
        }
    }

    private static JSONObject result(String state,long items,long bytes,boolean more)throws Exception{
        JSONObject out=new JSONObject();out.put("state",state);out.put("itemsWorked",items);
        out.put("bytesWorked",bytes);out.put("hasMore",more);return out;
    }

    private static JSONObject storageBlocked(DriveSenseTripArchiveRepository repository,String[]domains,
                                             DriveSenseP6DerivedState.DerivedStorageBlockedException blocked)throws Exception{
        repository.coordinator().write(db->{for(String domain:domains)db.execSQL("UPDATE p6_control SET "+
            "state='DERIVED_STORAGE_BLOCKED',complete=0,storage_outcome=?,updated_at_ms=? WHERE domain_id=?",
            new Object[]{"available="+blocked.availableBytes+",proposed="+blocked.proposedBytes+
                ",reserve="+blocked.reserveBytes,System.currentTimeMillis(),domain});return null;});
        JSONObject out=result("DERIVED_STORAGE_BLOCKED",1,blocked.proposedBytes,false);
        out.put("availableBytes",blocked.availableBytes);out.put("reserveBytes",blocked.reserveBytes);return out;
    }

    private static String scalarText(SQLiteDatabase db,String sql){
        try(Cursor c=db.rawQuery(sql,null)){
            if(!c.moveToFirst())throw new IllegalStateException("P6_OWNER_STATE_MISSING");
            return c.getString(0);
        }
    }

    private static long scalarLong(SQLiteDatabase db,String sql){
        try(Cursor c=db.rawQuery(sql,null)){
            if(!c.moveToFirst())throw new IllegalStateException("P6_OWNER_STATE_MISSING");
            return c.getLong(0);
        }
    }

    private static long count(SQLiteDatabase db,String sql,String[]args){
        try(Cursor c=db.rawQuery(sql,args)){
            if(!c.moveToFirst())throw new IllegalStateException("P6_OWNER_STATE_MISSING");
            return c.getLong(0);
        }
    }

    private static String sqlLiteral(String value){return value.replace("'","''");}
    private static String sqlNullableLiteral(String value){return value==null?"NULL":"'"+sqlLiteral(value)+"'";}

    private static final class Work{
        final String tripId,generation,disposition,state,cursor;final int revision;
        final long desiredSeq;final byte[]sourceHash;
        Work(String tripId,String generation,int revision,long desiredSeq,String disposition,
             String state,String cursor,byte[]sourceHash){
            this.tripId=tripId;this.generation=generation;this.revision=revision;
            this.desiredSeq=desiredSeq;this.disposition=disposition;this.state=state;
            this.cursor=cursor;this.sourceHash=sourceHash;
        }
    }
    private static final class Posting{
        final String tripId,contentVersion;final int revision,blockOrdinal,pointOrdinal;
        Posting(String tripId,int revision,String contentVersion,int blockOrdinal,int pointOrdinal){
            this.tripId=tripId;this.revision=revision;this.contentVersion=contentVersion;
            this.blockOrdinal=blockOrdinal;this.pointOrdinal=pointOrdinal;
        }
    }
    private static final class Selection{
        final String requestId,generation,cursor;final byte[]payload,payloadNonce,payloadHash,wrappedDek,wrapNonce;
        final int keyVersion;
        Selection(String requestId,String generation,byte[]payload,byte[]payloadNonce,byte[]payloadHash,
                  byte[]wrappedDek,byte[]wrapNonce,int keyVersion,String cursor){
            this.requestId=requestId;this.generation=generation;this.payload=payload;
            this.payloadNonce=payloadNonce;this.payloadHash=payloadHash;this.wrappedDek=wrappedDek;
            this.wrapNonce=wrapNonce;this.keyVersion=keyVersion;this.cursor=cursor;
        }
    }
}
