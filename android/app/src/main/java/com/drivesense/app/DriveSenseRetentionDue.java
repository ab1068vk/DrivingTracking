package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Native retention policy identity and derived due/backfill owner. */
final class DriveSenseRetentionDue {
    static final int BACKFILL_LIMIT=16;
    private static final long DAY_MS=86_400_000L;

    private DriveSenseRetentionDue() {}

    static String identity(int rawDays,int motionDays){
        if(rawDays<0||motionDays<0)throw new IllegalArgumentException("Retention days must be non-negative");
        return "roadsage.retention.policy.v1|rawDays="+rawDays+"|motionDays="+motionDays;
    }

    static Policy configure(DriveSenseStorageCoordinator coordinator,int rawDays,int motionDays,long now)throws Exception{
        String identity=identity(rawDays,motionDays);
        return coordinator.write(db->{db.beginTransaction();try{
            String existing=null,state="BACKFILL_REQUIRED",generation;
            try(Cursor c=db.rawQuery("SELECT retention_policy_version,retention_index_state FROM p5_control_state WHERE id=1",null)){if(c.moveToFirst()){existing=c.getString(0);state=c.getString(1);}}
            try(Cursor c=db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1",null)){if(!c.moveToFirst())throw new IllegalStateException("archive_meta missing");generation=c.getString(0);}
            if(!identity.equals(existing)){
                db.execSQL("UPDATE p5_control_state SET retention_policy_version=?,retention_raw_days=?,retention_motion_days=?,retention_index_state='BACKFILL_REQUIRED',updated_at_ms=? WHERE id=1",new Object[]{identity,rawDays,motionDays,now});
                db.execSQL("UPDATE trip_retention_jobs SET state='OBSOLETE',updated_at_ms=? WHERE state IN ('ACTIVE','COMMITTED') AND phase<>'DONE'",new Object[]{now});
                String job=UUID.randomUUID().toString();ContentValues row=new ContentValues();row.put("job_id",job);row.put("archive_generation",generation);row.put("erasure_token",generation);row.put("policy_version",identity);row.put("state","ACTIVE");row.put("phase","BACKFILL");row.put("cursor_trip_id","");row.put("created_at_ms",now);row.put("updated_at_ms",now);db.insertOrThrow("trip_retention_jobs",null,row);state="BACKFILL_REQUIRED";
            }
            db.setTransactionSuccessful();return new Policy(identity,rawDays,motionDays,state,generation);
        }finally{db.endTransaction();}});
    }

    static JSONObject backfillTurn(DriveSenseStorageCoordinator coordinator,Policy policy)throws Exception{
        return coordinator.write(db->{db.beginTransaction();try{
            String cursor="",jobId=null;
            try(Cursor c=db.rawQuery("SELECT job_id,cursor_trip_id FROM trip_retention_jobs WHERE archive_generation=? AND policy_version=? AND state='ACTIVE' AND phase='BACKFILL' ORDER BY created_at_ms LIMIT 1",new String[]{policy.generation,policy.identity})){if(c.moveToFirst()){jobId=c.getString(0);cursor=c.getString(1);}}
            if(jobId==null)throw new IllegalStateException("RETENTION_BACKFILL_JOB_MISSING");
            List<Row> rows=new ArrayList<>();
            try(Cursor c=db.rawQuery("SELECT c.trip_id,c.revision,c.start_time_ms,c.end_time_ms FROM trip_current c WHERE c.status='completed' AND c.trip_id>? ORDER BY c.trip_id LIMIT ?",new String[]{cursor,Integer.toString(BACKFILL_LIMIT)})){while(c.moveToNext())rows.add(new Row(c.getString(0),c.getInt(1),c.getLong(2),c.getLong(3)));}
            for(Row row:rows)maintain(db,row.id,row.revision,row.start,row.end,policy);
            String last=rows.isEmpty()?cursor:rows.get(rows.size()-1).id;boolean more;
            try(Cursor c=db.rawQuery("SELECT 1 FROM trip_current WHERE status='completed' AND trip_id>? LIMIT 1",new String[]{last})){more=c.moveToFirst();}
            if(more)db.execSQL("UPDATE trip_retention_jobs SET cursor_trip_id=?,items_examined=items_examined+?,updated_at_ms=? WHERE job_id=?",new Object[]{last,rows.size(),System.currentTimeMillis(),jobId});
            else{db.execSQL("UPDATE trip_retention_jobs SET state='COMPLETE',phase='DONE',cursor_trip_id=?,items_examined=items_examined+?,updated_at_ms=? WHERE job_id=?",new Object[]{last,rows.size(),System.currentTimeMillis(),jobId});db.execSQL("DELETE FROM trip_retention_due WHERE policy_version<>? OR archive_generation<>?",new Object[]{policy.identity,policy.generation});db.execSQL("UPDATE p5_control_state SET retention_index_state='VERIFIED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});}
            db.setTransactionSuccessful();JSONObject out=new JSONObject();out.put("state",more?"BACKFILL":"BACKFILL_COMPLETE");out.put("itemsWorked",rows.size());out.put("changedItems",rows.size());out.put("bytesWorked",rows.size()*64L);out.put("hasMore",more);out.put("jobId",jobId);return out;
        }finally{db.endTransaction();}});
    }

    static void maintainCurrent(SQLiteDatabase db,String id,int revision,long start,long end){
        try(Cursor c=db.rawQuery("SELECT retention_policy_version,retention_raw_days,retention_motion_days,retention_index_state FROM p5_control_state WHERE id=1",null)){
            if(!c.moveToFirst()||c.isNull(0))return;
            String generation;try(Cursor g=db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1",null)){if(!g.moveToFirst())return;generation=g.getString(0);}
            maintain(db,id,revision,start,end,new Policy(c.getString(0),c.getInt(1),c.getInt(2),c.getString(3),generation));
        }
    }

    static void remove(SQLiteDatabase db,String id){db.delete("trip_retention_due","trip_id=?",new String[]{id});}

    private static void maintain(SQLiteDatabase db,String id,int revision,long start,long end,Policy policy){
        long clock=end>0?end:(start>0?start:-1L);
        if(clock<=0){remove(db,id);return;}
        Long raw=policy.rawDays>0?safeDue(clock,policy.rawDays):null;
        Long motion=policy.motionDays>0?safeDue(clock,policy.motionDays):null;
        if(raw==null&&motion==null){remove(db,id);return;}
        long next=raw==null?motion:(motion==null?raw:Math.min(raw,motion));
        ContentValues row=new ContentValues();row.put("trip_id",id);row.put("revision",revision);
        if(raw==null)row.putNull("raw_due_at_ms");else row.put("raw_due_at_ms",raw);
        if(motion==null)row.putNull("motion_due_at_ms");else row.put("motion_due_at_ms",motion);
        row.put("next_due_at_ms",next);row.put("policy_version",policy.identity);row.put("archive_generation",policy.generation);row.put("state","DUE");
        db.insertWithOnConflict("trip_retention_due",null,row,SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static long safeDue(long clock,int days){try{return Math.addExact(clock,Math.multiplyExact((long)days,DAY_MS));}catch(ArithmeticException error){return Long.MAX_VALUE;}}

    static final class Policy{final String identity,state,generation;final int rawDays,motionDays;Policy(String i,int r,int m,String s,String g){identity=i;rawDays=r;motionDays=m;state=s;generation=g;}}
    private static final class Row{final String id;final int revision;final long start,end;Row(String i,int r,long s,long e){id=i;revision=r;start=s;end=e;}}
}
