package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Domain-owned, identity-free physical cleanup obligations. */
final class DriveSenseArchiveUnlinkDebt {
    static final int MAX_EXAMINED=32,MAX_UNLINKS=16;
    static final long MAX_UNLINK_BYTES=1024L*1024L,MAX_WORK_BYTES=2L*1024L*1024L;
    private DriveSenseArchiveUnlinkDebt() {}

    static void record(SQLiteDatabase db,String opaquePath,long bytes,String reason){
        if(!valid(opaquePath))throw new IllegalArgumentException("Invalid opaque archive path");
        ContentValues row=new ContentValues();row.put("debt_id",UUID.randomUUID().toString());row.put("opaque_path",opaquePath);
        row.put("encoded_bytes",Math.max(0L,bytes));row.put("state","PENDING");row.put("reason_code",safeReason(reason));
        long now=System.currentTimeMillis();row.put("created_at_ms",now);row.put("updated_at_ms",now);
        db.insertWithOnConflict("archive_unlink_debt",null,row,SQLiteDatabase.CONFLICT_IGNORE);
    }

    static JSONObject step(DriveSenseStorageCoordinator coordinator,DriveSenseTripChunkStore chunks)throws Exception{
        JSONObject health=DriveSenseArchiveHealth.inventory(coordinator);
        if(!"NATIVE".equals(health.optString("authorityState"))||!"HEALTHY".equals(health.optString("recoveryState"))||!health.optBoolean("sentinelMatches",false)||health.optLong("pendingCount")>0)
            return result("BLOCKED_RECOVERY",0,0,0L,true);
        String liveness=coordinator.read(db->{
            try(Cursor lease=db.rawQuery("SELECT 1 FROM export_leases WHERE state='ACTIVE' LIMIT 1",null)){if(lease.moveToFirst())return "BLOCKED_EXPORT_LEASE";}
            // A durable abandoned-ingress marker is recovery proof, not a live
            // destructive-work fence. Every other operation/state still blocks.
            try(Cursor operation=db.rawQuery("SELECT 1 FROM open_operations WHERE NOT "
                + "(operation_type IN ('LEGACY_IMPORT','DIRECT_COMMIT') AND state=?) LIMIT 1",
                new String[]{DriveSenseArchiveRecovery.RELEASED_INGRESS})){if(operation.moveToFirst())return "BLOCKED_NATIVE_OPERATION";}
            return null;
        });
        if(liveness!=null)return result(liveness,0,0,0L,true);
        List<Debt> rows=coordinator.read(db->{List<Debt>out=new ArrayList<>();try(Cursor c=db.rawQuery(
            "SELECT debt_id,opaque_path,encoded_bytes FROM archive_unlink_debt WHERE state='PENDING' ORDER BY created_at_ms,debt_id LIMIT ?",
            new String[]{Integer.toString(MAX_EXAMINED)})){while(c.moveToNext())out.add(new Debt(c.getString(0),c.getString(1),c.getLong(2)));}return out;});
        int examined=0,unlinked=0;long bytes=0;
        DriveSenseRetentionStage retentionStage=new DriveSenseRetentionStage(coordinator.context());
        for(Debt debt:rows){
            examined++;
            if(unlinked>=MAX_UNLINKS||bytes+debt.bytes>MAX_UNLINK_BYTES)break;
            if(!valid(debt.path))throw new SecurityException("Invalid stored unlink debt");
            boolean retention=debt.path.startsWith("rstg:");File file=retention?null:chunks.relativeFile(debt.path);long actual=retention?retentionStage.debtBytes(debt.path):(file.isFile()?Math.max(0L,file.length()):0L);
            if(bytes+actual>MAX_UNLINK_BYTES)break;
            boolean absent;if(retention)absent=retentionStage.deleteDebt(debt.path);else{chunks.deleteRelative(debt.path);absent=!chunks.relativeFile(debt.path).exists();}
            if(!absent)continue;
            coordinator.write(db->{db.delete("archive_unlink_debt","debt_id=?",new String[]{debt.id});return null;});
            unlinked++;bytes+=actual;
        }
        boolean more=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM archive_unlink_debt WHERE state='PENDING' LIMIT 1",null)){return c.moveToFirst();}});
        return result(more?"MORE":"COMPLETE",examined,unlinked,Math.min(MAX_WORK_BYTES,bytes),more);
    }
    static void completeIfAbsent(DriveSenseStorageCoordinator coordinator,DriveSenseTripChunkStore chunks,String path)throws Exception{if(valid(path)&&!chunks.relativeFile(path).exists())coordinator.write(db->{db.delete("archive_unlink_debt","opaque_path=?",new String[]{path});return null;});}

    private static JSONObject result(String state,int examined,int changed,long bytes,boolean more)throws Exception{
        JSONObject out=new JSONObject();out.put("state",state);out.put("itemsWorked",examined);out.put("changedItems",changed);
        out.put("bytesWorked",bytes);out.put("hasMore",more);return out;
    }
    private static boolean valid(String path){return path!=null&&!path.isEmpty()&&path.length()<=200&&!path.contains("..")&&!path.contains("/")&&!path.contains("\\");}
    private static String safeReason(String reason){String value=reason==null?"catalog_retire":reason.replaceAll("[^A-Za-z0-9_.:-]","_");return value.substring(0,Math.min(64,value.length()));}
    private static final class Debt{final String id,path;final long bytes;Debt(String i,String p,long b){id=i;path=p;bytes=b;}}
}
