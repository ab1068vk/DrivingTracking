package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;

final class DriveSenseArchiveMigration {
    private static final int MAX_INGRESS_CHUNK=256*1024;
    private final DriveSenseTripArchiveRepository repository;
    private final DriveSenseStorageCoordinator coordinator;
    private final boolean migrationMode;

    DriveSenseArchiveMigration(DriveSenseTripArchiveRepository repository){this(repository,true);}
    DriveSenseArchiveMigration(DriveSenseTripArchiveRepository repository,boolean migrationMode){this.repository=repository;this.coordinator=repository.coordinator();this.migrationMode=migrationMode;}

    JSONObject begin(String tripId,String sourceHashHex,long expectedBytes)throws Exception{
        if(expectedBytes < -1L)throw new IllegalArgumentException("expectedBytes is invalid");
        boolean hashKnown=sourceHashHex!=null&&!sourceHashHex.trim().isEmpty();
        byte[]sourceHash=hashKnown?parseHash(sourceHashHex):new byte[32];String operation=UUID.randomUUID().toString();File directory=directory();File temp=new File(directory,operation+".legacy.tmp");
        if(hashKnown&&alreadyMigrated(tripId,sourceHash)){JSONObject result=new JSONObject();result.put("operationId",operation);result.put("alreadyMigrated",true);return result;}
        coordinator.write(db->{db.beginTransaction();try{ContentValues ingress=new ContentValues();ingress.put("operation_id",operation);ingress.put("trip_id",tripId);ingress.put("source_hash",sourceHash);ingress.put("expected_bytes",expectedBytes);ingress.put("temp_path",temp.getAbsolutePath());ingress.put("state","RECEIVING");ingress.put("migration_mode",migrationMode?1:0);ingress.put("created_at_ms",System.currentTimeMillis());ingress.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("migration_ingress",null,ingress);ContentValues op=new ContentValues();op.put("operation_id",operation);op.put("operation_type",migrationMode?"LEGACY_IMPORT":"DIRECT_COMMIT");op.put("state","RECEIVING");op.put("owner_token",operation);op.put("created_at_ms",System.currentTimeMillis());op.put("updated_at_ms",System.currentTimeMillis());db.insertOrThrow("open_operations",null,op);if(migrationMode){db.execSQL("INSERT OR IGNORE INTO migration_state(id,phase,last_checkpoint_ms) VALUES(1,'MIGRATING',?)",new Object[]{System.currentTimeMillis()});db.execSQL("UPDATE archive_meta SET authority_state='MIGRATING' WHERE id=1");}db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        JSONObject result=new JSONObject();result.put("operationId",operation);result.put("alreadyMigrated",false);result.put("maxChunkBytes",MAX_INGRESS_CHUNK);result.put("expectedBytesRequired",false);return result;
    }

    JSONObject append(String operation,int index,String base64)throws Exception{
        if(base64==null||base64.length()>400000)throw new IllegalArgumentException("Migration chunk too large");byte[]bytes=Base64.decode(base64,Base64.NO_WRAP);if(bytes.length==0||bytes.length>MAX_INGRESS_CHUNK)throw new IllegalArgumentException("Migration chunk out of range");
        Ingress ingress=load(operation);if(!"RECEIVING".equals(ingress.state)||index!=ingress.nextIndex)throw new IllegalStateException("Migration chunk sequence mismatch");if(ingress.expected>0&&ingress.received+bytes.length>ingress.expected)throw new IllegalStateException("Migration byte count exceeded");
        int byteCount=bytes.length;
        File file=new File(ingress.path);try(FileOutputStream output=new FileOutputStream(file,true)){output.write(bytes);output.getFD().sync();}finally{Arrays.fill(bytes,(byte)0);}
        coordinator.write(db->{db.beginTransaction();try{
            db.execSQL("UPDATE migration_ingress SET received_bytes=received_bytes+?,next_chunk_index=next_chunk_index+1,updated_at_ms=? WHERE operation_id=? AND next_chunk_index=? AND state='RECEIVING'",new Object[]{byteCount,System.currentTimeMillis(),operation,index});
            try(Cursor changed=db.rawQuery("SELECT changes()",null)){
                changed.moveToFirst();if(changed.getInt(0)!=1)throw new IllegalStateException("Migration chunk sequence mismatch");
            }
            // Progress and renewed ownership must commit together: a later
            // process must distinguish a resumed ingress from an untouched one.
            refreshIngressOwnership(db,operation);
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
        JSONObject result=new JSONObject();result.put("operationId",operation);result.put("nextChunkIndex",index+1);result.put("receivedBytes",ingress.received+byteCount);return result;
    }

    JSONObject finish(String operation)throws Exception{
        Ingress ingress=load(operation);File file=new File(ingress.path);if((ingress.expected>0&&ingress.received!=ingress.expected)||file.length()!=ingress.received)throw new IllegalStateException("Migration byte count mismatch");
        byte[]actual=sha256File(file);if(!isZeroHash(ingress.sourceHash)&&!Arrays.equals(actual,ingress.sourceHash))throw new SecurityException("Migration source hash mismatch");
        // Finish may be the first resumed operation (all chunks already durable).
        coordinator.write(db->{refreshIngressOwnership(db,operation);return null;});
        try{
            JSONObject committed=repository.commitSpool(file,ingress.tripId,migrationMode?"legacy_migration":"web_app_stream");
            recordFinishedIngress(operation,ingress,actual,committed);
            wipe(file);return committed;
        }catch(Exception error){
            if(error.getMessage()!=null&&error.getMessage().contains("LOW_SPACE"))markLowSpaceBlocked(ingress);
            else quarantine(ingress,error);
            throw error;
        }
    }

    JSONObject abort(String operation)throws Exception{Ingress ingress=load(operation);File file=new File(ingress.path);wipe(file);coordinator.write(db->{db.delete("migration_ingress","operation_id=?",new String[]{operation});db.delete("open_operations","operation_id=?",new String[]{operation});return null;});JSONObject out=new JSONObject();out.put("aborted",true);return out;}

    JSONObject checkpoint(JSONObject value)throws Exception{
        if(!migrationMode)throw new IllegalStateException("Migration checkpoint unavailable for direct ingress");
        JSONObject bounded=value==null?new JSONObject():new JSONObject(value.toString());
        String encoded=bounded.toString();
        if(encoded.getBytes(StandardCharsets.UTF_8).length>16*1024)throw new IllegalArgumentException("Migration checkpoint too large");
        long visited=Math.max(0L,bounded.optLong("visitedCount",0L));
        long quarantined=Math.max(0L,bounded.optLong("quarantineCount",0L));
        String phase=safe(bounded.optString("phase","MIGRATING"));
        coordinator.write(db->{db.execSQL("INSERT OR IGNORE INTO migration_state(id,phase,last_checkpoint_ms) VALUES(1,'MIGRATING',?)",new Object[]{System.currentTimeMillis()});db.execSQL("UPDATE migration_state SET phase=?,cursor=?,visited_count=?,quarantine_count=?,last_checkpoint_ms=? WHERE id=1",new Object[]{phase,encoded,visited,quarantined,System.currentTimeMillis()});return null;});
        JSONObject out=new JSONObject();out.put("saved",true);out.put("checkpoint",bounded);return out;
    }

    JSONObject checkpointStatus()throws Exception{
        return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT phase,cursor,last_checkpoint_ms FROM migration_state WHERE id=1",null)){JSONObject out=new JSONObject();if(!c.moveToFirst()){out.put("phase","NOT_STARTED");out.put("checkpoint",JSONObject.NULL);return out;}out.put("phase",c.getString(0));String raw=c.isNull(1)?"":c.getString(1);out.put("checkpoint",raw.isEmpty()?JSONObject.NULL:new JSONObject(raw));out.put("updatedAtMs",c.getLong(2));return out;}});
    }

    JSONObject quarantineUnopened(String sourceLocator,JSONObject knownMetadata,String errorClass,String errorDetail)throws Exception{
        if(!migrationMode)throw new IllegalStateException("Quarantine unavailable for direct ingress");
        String locator=safe(sourceLocator);if(locator.isEmpty())throw new IllegalArgumentException("sourceLocator required");
        String metadata=knownMetadata==null?"{}":knownMetadata.toString();if(metadata.getBytes(StandardCharsets.UTF_8).length>16*1024)metadata="{\"truncated\":true}";
        String finalMetadata=metadata;
        coordinator.write(db->{ContentValues q=new ContentValues();q.put("source_locator",locator);q.put("source_hash",new byte[32]);q.put("error_class",safe(errorClass));q.put("error_detail",safe(errorDetail));q.put("known_metadata",finalMetadata);q.put("preserved_artifact",locator);q.put("created_at_ms",System.currentTimeMillis());db.insertOrThrow("migration_quarantine",null,q);db.execSQL("INSERT OR IGNORE INTO migration_state(id,phase,last_checkpoint_ms) VALUES(1,'MIGRATING',?)",new Object[]{System.currentTimeMillis()});db.execSQL("UPDATE migration_state SET quarantine_count=quarantine_count+1,last_checkpoint_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});return null;});
        JSONObject out=new JSONObject();out.put("quarantined",true);out.put("sourceLocator",locator);return out;
    }

    JSONObject complete(long expectedCount,long visitedCount,long quarantineCount,String manifestHashHex)throws Exception{
        if(expectedCount<0||visitedCount<0||quarantineCount<0)throw new IllegalArgumentException("Invalid migration counters");long migrated=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM migration_records WHERE state='VERIFIED'",null)){c.moveToFirst();return c.getLong(0);}});
        boolean exact=quarantineCount==0&&visitedCount==expectedCount&&migrated==expectedCount;
        byte[]manifest=parseHash(manifestHashHex);
        coordinator.exclusive(db->{db.beginTransaction();try{ContentValues shortfall=new ContentValues();shortfall.put("id",1);shortfall.put("manifest_hash",manifest);shortfall.put("expected_count",expectedCount);shortfall.put("visited_count",visitedCount);shortfall.put("migrated_count",migrated);shortfall.put("quarantine_count",quarantineCount);shortfall.put("source_preserved",1);shortfall.put("created_at_ms",System.currentTimeMillis());db.insertWithOnConflict("migration_shortfall",null,shortfall,android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE);if(exact){db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY' WHERE id=1");db.execSQL("UPDATE migration_state SET phase='VERIFIED',expected_manifest=?,last_checkpoint_ms=? WHERE id=1",new Object[]{manifest,System.currentTimeMillis()});}else{db.execSQL("UPDATE archive_meta SET authority_state='RECOVERY_REQUIRED',recovery_state='RECOVERY_REQUIRED' WHERE id=1");db.execSQL("UPDATE migration_state SET phase='SHORTFALL',expected_manifest=?,quarantine_count=?,last_checkpoint_ms=? WHERE id=1",new Object[]{manifest,quarantineCount,System.currentTimeMillis()});}db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);JSONObject out=new JSONObject();out.put("verified",exact);out.put("authorityState",exact?"NATIVE":"RECOVERY_REQUIRED");out.put("migratedCount",migrated);out.put("expectedCount",expectedCount);return out;
    }

    private boolean alreadyMigrated(String id,byte[]hash)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT source_hash FROM migration_records WHERE trip_id=? AND state='VERIFIED'",new String[]{id})){while(c.moveToNext())if(Arrays.equals(hash,c.getBlob(0)))return true;return false;}});}
    private static void refreshIngressOwnership(android.database.sqlite.SQLiteDatabase db,String operation){
        db.execSQL("INSERT OR REPLACE INTO open_operations"
            + "(operation_id,operation_type,state,owner_token,created_at_ms,updated_at_ms) "
            + "SELECT operation_id,CASE WHEN migration_mode=1 THEN 'LEGACY_IMPORT' ELSE 'DIRECT_COMMIT' END,"
            + "'RECEIVING',operation_id,created_at_ms,? FROM migration_ingress WHERE operation_id=? AND state='RECEIVING'",
            new Object[]{System.currentTimeMillis(),operation});
    }
    private void recordFinishedIngress(String operation,Ingress ingress,byte[]actual,JSONObject committed)throws Exception{
        coordinator.write(db->{db.beginTransaction();try{
            if(migrationMode){
                boolean prior=false;try(Cursor c=db.rawQuery("SELECT 1 FROM migration_records WHERE trip_id=? AND state='VERIFIED'",new String[]{ingress.tripId})){prior=c.moveToFirst();}
                ContentValues record=new ContentValues();record.put("trip_id",ingress.tripId);record.put("source_hash",actual);record.put("canonical_revision",committed.optInt("revision"));record.put("canonical_seq",committed.optLong("seq"));record.put("state","VERIFIED");record.put("updated_at_ms",System.currentTimeMillis());db.insertWithOnConflict("migration_records",null,record,android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE);
                if(!prior)db.execSQL("UPDATE migration_state SET migrated_count=migrated_count+1,migrated_bytes=migrated_bytes+?,last_checkpoint_ms=? WHERE id=1",new Object[]{ingress.received,System.currentTimeMillis()});
            }
            db.delete("migration_ingress","operation_id=?",new String[]{operation});db.delete("open_operations","operation_id=?",new String[]{operation});db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
    }
    private Ingress load(String operation)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT trip_id,source_hash,expected_bytes,received_bytes,next_chunk_index,temp_path,state FROM migration_ingress WHERE operation_id=?",new String[]{operation})){if(!c.moveToFirst())throw new IllegalStateException("Migration operation unavailable");return new Ingress(c.getString(0),c.getBlob(1),c.getLong(2),c.getLong(3),c.getInt(4),c.getString(5),c.getString(6));}});}
    private void quarantine(Ingress ingress,Exception error){try{coordinator.write(db->{if(migrationMode){ContentValues q=new ContentValues();q.put("source_locator",ingress.path);q.put("source_hash",ingress.sourceHash);q.put("error_class",error.getClass().getSimpleName());q.put("error_detail",safe(error.getMessage()));q.put("preserved_artifact",ingress.path);q.put("created_at_ms",System.currentTimeMillis());db.insertOrThrow("migration_quarantine",null,q);db.execSQL("UPDATE migration_state SET quarantine_count=quarantine_count+1,last_checkpoint_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});}db.execSQL("UPDATE migration_ingress SET state='QUARANTINED',updated_at_ms=? WHERE temp_path=?",new Object[]{System.currentTimeMillis(),ingress.path});return null;});}catch(Exception ignored){}}
    private void markLowSpaceBlocked(Ingress ingress){try{coordinator.write(db->{if(migrationMode)db.execSQL("UPDATE migration_state SET phase='LEGACY_MIGRATION_BLOCKED_SPACE',admission_state='LOW_SPACE_BLOCKED',last_checkpoint_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});db.execSQL("UPDATE migration_ingress SET state='RECEIVING',updated_at_ms=? WHERE temp_path=?",new Object[]{System.currentTimeMillis(),ingress.path});return null;});}catch(Exception ignored){}}
    private File directory(){File d=new File(coordinator.context().getNoBackupFilesDir(),"roadsage_archive_migration_v1");if(!d.exists()&&!d.mkdirs())throw new IllegalStateException("Migration directory unavailable");return d;}
    private static byte[]parseHash(String hex){if(hex==null||!hex.matches("[0-9a-fA-F]{64}"))throw new IllegalArgumentException("source hash must be SHA-256 hex");byte[]out=new byte[32];for(int i=0;i<32;i++)out[i]=(byte)Integer.parseInt(hex.substring(i*2,i*2+2),16);return out;}
    private static boolean isZeroHash(byte[]hash){if(hash==null||hash.length!=32)return false;for(byte value:hash)if(value!=0)return false;return true;}
    private static byte[]sha256File(File file)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");try(FileInputStream in=new FileInputStream(file)){byte[]b=new byte[256*1024];int n;while((n=in.read(b))!=-1)d.update(b,0,n);}return d.digest();}
    private static void wipe(File file){try{SecureDeleteHelper.secureWipeFile(file);}catch(Exception ignored){if(file.exists())file.delete();}}
    private static String safe(String value){String text=value==null?"":value;return text.length()>240?text.substring(0,240):text;}
    private static final class Ingress{final String tripId,path,state;final byte[]sourceHash;final long expected,received;final int nextIndex;Ingress(String i,byte[]h,long e,long r,int n,String p,String s){tripId=i;sourceHash=h;expected=e;received=r;nextIndex=n;path=p;state=s;}}
}
