package com.drivesense.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

/** Exact KEK reference deltas and crash-visible file-owner dirty fencing. */
final class DriveSenseKeyReferenceCounts {
    private DriveSenseKeyReferenceCounts() {}

    static void adjust(SQLiteDatabase db,String domain,int version,long delta) {
        if (version < 1 || delta == 0) return;
        long now=System.currentTimeMillis();
        db.execSQL("INSERT INTO key_reference_counts(domain_id,key_version,reference_count,updated_at_ms) VALUES(?,?,MAX(0,?),?) ON CONFLICT(domain_id,key_version) DO UPDATE SET reference_count=reference_count+?,updated_at_ms=excluded.updated_at_ms",
            new Object[]{domain,version,delta,now,delta});
        try(Cursor c=db.rawQuery("SELECT reference_count FROM key_reference_counts WHERE domain_id=? AND key_version=?",new String[]{domain,Integer.toString(version)})){
            if(!c.moveToFirst()||c.getLong(0)<0)throw new IllegalStateException("KEK_REFERENCE_COUNT_UNDERFLOW");
        }
    }

    static boolean beginFileMutation(Context context) throws Exception {
        DriveSenseStorageCoordinator coordinator=DriveSenseStorageCoordinator.get(context);
        return coordinator.write(db->{boolean verified=isVerified(db);markDirty(db);return verified;});
    }

    static void completeFileReference(Context context,String domain,String entry,int version,boolean restoreVerified)throws Exception{
        DriveSenseStorageCoordinator.get(context).write(db->{db.beginTransaction();try{
            db.execSQL("INSERT INTO encrypted_file_key_registry(domain_id,entry_id,key_version,state,updated_at_ms) VALUES(?,?,?,'VERIFIED',?) ON CONFLICT(domain_id,entry_id) DO UPDATE SET key_version=excluded.key_version,state='VERIFIED',updated_at_ms=excluded.updated_at_ms",
                new Object[]{domain,entry,version,System.currentTimeMillis()});
            if(restoreVerified)markVerified(db);db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
    }

    static void removeFileReference(Context context,String domain,String entry,boolean restoreVerified)throws Exception{
        DriveSenseStorageCoordinator.get(context).write(db->{db.beginTransaction();try{
            db.delete("encrypted_file_key_registry","domain_id=? AND entry_id=?",new String[]{domain,entry});
            if(restoreVerified)markVerified(db);db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
    }

    static void moveFileReference(Context context,String from,String to,String entry,int version)throws Exception{
        moveFileReference(context,from,entry,to,entry,version);
    }

    static void moveFileReference(Context context,String from,String fromEntry,String to,String toEntry,int version)throws Exception{
        boolean verified=beginFileMutation(context);
        DriveSenseStorageCoordinator.get(context).write(db->{db.beginTransaction();try{
            db.delete("encrypted_file_key_registry","domain_id=? AND entry_id=?",new String[]{from,fromEntry});
            db.execSQL("INSERT INTO encrypted_file_key_registry(domain_id,entry_id,key_version,state,updated_at_ms) VALUES(?,?,?,'VERIFIED',?) ON CONFLICT(domain_id,entry_id) DO UPDATE SET key_version=excluded.key_version,state='VERIFIED',updated_at_ms=excluded.updated_at_ms",
                new Object[]{to,toEntry,version,System.currentTimeMillis()});
            if(verified)markVerified(db);db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
    }

    static void clearFileDomain(Context context,String domain)throws Exception{
        boolean verified=beginFileMutation(context);
        DriveSenseStorageCoordinator.get(context).write(db->{db.delete("encrypted_file_key_registry","domain_id=?",new String[]{domain});if(verified)markVerified(db);return null;});
    }

    static void markDirty(SQLiteDatabase db){
        db.execSQL("UPDATE p5_control_state SET kek_count_state='DIRTY',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
        db.execSQL("UPDATE rotation_state SET count_state='DIRTY',zero_proof=0,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
    }

    static boolean isVerified(SQLiteDatabase db){
        try(Cursor c=db.rawQuery("SELECT kek_count_state FROM p5_control_state WHERE id=1",null)){return c.moveToFirst()&&"VERIFIED".equals(c.getString(0));}
    }

    static void markVerified(SQLiteDatabase db){
        db.execSQL("UPDATE p5_control_state SET kek_count_state='VERIFIED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
        db.execSQL("UPDATE rotation_state SET count_state='VERIFIED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
    }
}
