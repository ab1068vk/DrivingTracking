package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.security.MessageDigest;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

final class DriveSenseArchiveIntegrity {
    private static final byte[] ZERO_HASH = new byte[32];
    private static final int CHECKPOINT_WINDOWS = 12;
    private static volatile String testFaultPoint;

    private DriveSenseArchiveIntegrity() {}

    static long appendEventInTransaction(
        SQLiteDatabase db,
        String eventType,
        String tripId,
        Integer revision,
        Integer priorRevision,
        byte[] payloadHash,
        byte[] metadataHash,
        String reasonCode,
        String actor,
        Long throughSeq,
        Long checkpointLiveCount,
        byte[] liveSetRoot,
        long createdAtMs
    ) throws Exception {
        byte[] previous = ZERO_HASH;
        try (Cursor cursor = db.rawQuery("SELECT tip_chain_hash FROM archive_meta WHERE id=1", null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("archive_meta is missing");
            byte[] stored = cursor.getBlob(0);
            if (stored != null && stored.length == 32) previous = stored;
        }

        ContentValues values = new ContentValues();
        values.put("event_type", eventType);
        if (tripId == null) values.putNull("trip_id"); else values.put("trip_id", tripId);
        if (revision == null) values.putNull("revision"); else values.put("revision", revision);
        if (priorRevision == null) values.putNull("prior_revision"); else values.put("prior_revision", priorRevision);
        if (payloadHash == null) values.putNull("payload_hash"); else values.put("payload_hash", payloadHash);
        if (metadataHash == null) values.putNull("metadata_hash"); else values.put("metadata_hash", metadataHash);
        values.put("reason_code", reasonCode == null ? "" : reasonCode);
        values.put("actor", actor == null ? "system" : actor);
        values.put("previous_chain_hash", previous);
        values.put("chain_hash", ZERO_HASH);
        values.put("created_at_ms", createdAtMs);
        if (throughSeq == null) values.putNull("through_seq"); else values.put("through_seq", throughSeq);
        if (checkpointLiveCount == null) values.putNull("checkpoint_live_count"); else values.put("checkpoint_live_count", checkpointLiveCount);
        if (liveSetRoot == null) values.putNull("live_set_root"); else values.put("live_set_root", liveSetRoot);
        long seq = db.insertOrThrow("archive_events", null, values);
        byte[] chain = eventHash(previous, seq, eventType, tripId, revision, payloadHash, metadataHash,
            reasonCode, actor, createdAtMs, throughSeq, checkpointLiveCount, liveSetRoot);
        ContentValues eventUpdate = new ContentValues();
        eventUpdate.put("chain_hash", chain);
        db.update("archive_events", eventUpdate, "seq=?", new String[]{Long.toString(seq)});
        ContentValues meta = new ContentValues();
        meta.put("last_committed_seq", seq);
        meta.put("tip_chain_hash", chain);
        meta.put("projection_required_seq", seq);
        meta.put("updated_at_ms", createdAtMs);
        db.update("archive_meta", meta, "id=1", null);
        return seq;
    }

    static boolean reconcileCount(DriveSenseStorageCoordinator coordinator) throws Exception {
        long[] counts = coordinator.read(db -> {
            long expected;
            long actual;
            try (Cursor cursor = db.rawQuery("SELECT live_count FROM archive_meta WHERE id=1", null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("archive_meta missing");
                expected = cursor.getLong(0);
            }
            try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM trip_current", null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("COUNT failed");
                actual = cursor.getLong(0);
            }
            if (expected != actual) {
                return new long[]{expected, actual};
            }
            return new long[]{expected, actual};
        });
        if (counts[0] == counts[1]) return true;
        coordinator.write(db -> {
            ContentValues blocked = new ContentValues();
            blocked.put("recovery_state", "RECOVERY_REQUIRED");
            blocked.put("updated_at_ms", System.currentTimeMillis());
            db.update("archive_meta", blocked, "id=1", null);
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        DriveSenseDurabilityJournal.record(coordinator.context(), "CRITICAL", "LIVE_COUNT_MISMATCH", null,
            counts[0], counts[1], 0L, "RECOVERY_REQUIRED");
        return false;
    }

    static CheckpointResult createCheckpoint(DriveSenseStorageCoordinator coordinator) throws Exception {
        String jobId = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        coordinator.write(db -> {
            ContentValues job = new ContentValues();
            job.put("job_id", jobId);
            job.put("state", "PENDING");
            job.put("through_seq", readMetaLong(db, "last_committed_seq"));
            job.put("created_at_ms", now);
            job.put("updated_at_ms", now);
            db.insertOrThrow("integrity_checkpoint_jobs", null, job);
            return null;
        });
        injectFault("BEFORE_CHECKPOINT_SCAN");

        Snapshot snapshot = coordinator.read(db -> {
            db.beginTransactionNonExclusive();
            try {
                long throughSeq = readMetaLong(db, "last_committed_seq");
                long expected = readMetaLong(db, "live_count");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                digest.update("roadsage.archive.live.v1".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                long count = 0L;
                try (Cursor cursor = db.rawQuery(
                    "SELECT c.trip_id,c.revision,r.payload_hash FROM trip_current c JOIN trip_revisions r ON r.trip_id=c.trip_id AND r.revision=c.revision ORDER BY c.trip_id ASC",
                    null
                )) {
                    while (cursor.moveToNext()) {
                        updateLengthPrefixed(digest, cursor.getString(0));
                        updateInt(digest, cursor.getInt(1));
                        updateBytes(digest, cursor.getBlob(2));
                        count++;
                        if(count==1L)injectFault("DURING_CHECKPOINT_SCAN");
                    }
                }
                db.setTransactionSuccessful();
                return new Snapshot(throughSeq, expected, count, digest.digest());
            } finally {
                db.endTransaction();
            }
        });
        if (snapshot.expectedCount != snapshot.actualCount) {
            coordinator.write(db -> {
                ContentValues update = new ContentValues();
                update.put("state", "FAILED_COUNT_MISMATCH");
                update.put("live_count", snapshot.actualCount);
                update.put("live_set_root", snapshot.root);
                update.put("updated_at_ms", System.currentTimeMillis());
                db.update("integrity_checkpoint_jobs", update, "job_id=?", new String[]{jobId});
                ContentValues meta = new ContentValues();
                meta.put("recovery_state", "RECOVERY_REQUIRED");
                db.update("archive_meta", meta, "id=1", null);
                return null;
            });
            DriveSenseDurabilityJournal.record(coordinator.context(), "CRITICAL", "CHECKPOINT_COUNT_MISMATCH",
                null, snapshot.expectedCount, snapshot.actualCount, snapshot.throughSeq, null);
            return new CheckpointResult(false, snapshot.throughSeq, snapshot.actualCount, snapshot.root);
        }

        injectFault("AFTER_SCAN_BEFORE_CHECKPOINT_EVENT");

        coordinator.write(db -> {
            db.beginTransaction();
            try {
                long currentCount = readMetaLong(db, "live_count");
                if (currentCount != snapshot.actualCount) {
                    throw new IllegalStateException("Archive changed during checkpoint finalization");
                }
                appendEventInTransaction(db, "CHECKPOINT", null, null, null, null, null,
                    "periodic_integrity", "maintenance", snapshot.throughSeq, snapshot.actualCount,
                    snapshot.root, System.currentTimeMillis());
                ContentValues update = new ContentValues();
                update.put("state", "COMMITTED");
                update.put("through_seq", snapshot.throughSeq);
                update.put("live_count", snapshot.actualCount);
                update.put("live_set_root", snapshot.root);
                update.put("updated_at_ms", System.currentTimeMillis());
                db.update("integrity_checkpoint_jobs", update, "job_id=?", new String[]{jobId});
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            return null;
        });
        injectFault("AFTER_CHECKPOINT_EVENT_BEFORE_SENTINEL");
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        injectFault("BEFORE_CHECKPOINT_COMPACTION");
        compactAfterVerifiedCheckpoint(coordinator);
        return new CheckpointResult(true, snapshot.throughSeq, snapshot.actualCount, snapshot.root);
    }

    /** One durable P5 integrity phase; no transaction or digest state spans a turn. */
    static org.json.JSONObject stepBoundedCheckpoint(DriveSenseStorageCoordinator coordinator) throws Exception {
        String jobId=coordinator.write(db->{
            try(Cursor c=db.rawQuery("SELECT job_id FROM integrity_checkpoint_jobs WHERE state='P5_ACTIVE' ORDER BY created_at_ms LIMIT 1",null)){
                if(c.moveToFirst())return c.getString(0);
            }
            long lastSeq=readMetaLong(db,"last_committed_seq"),checkpointSeq=0L;
            try(Cursor c=db.rawQuery("SELECT COALESCE(MAX(checkpoint_event_seq),0) FROM integrity_checkpoint_jobs WHERE state='COMMITTED'",null)){if(c.moveToFirst())checkpointSeq=c.getLong(0);}
            if(checkpointSeq>=lastSeq)return null;
            db.beginTransaction();
            try{
                String id=UUID.randomUUID().toString();long now=System.currentTimeMillis();String generation;
                long through,expected;
                try(Cursor c=db.rawQuery("SELECT archive_generation,last_committed_seq,live_count FROM archive_meta WHERE id=1 AND authority_state='NATIVE' AND recovery_state='HEALTHY'",null)){
                    if(!c.moveToFirst())throw new IllegalStateException("P5_INTEGRITY_NOT_ADMITTED");
                    generation=c.getString(0);through=c.getLong(1);expected=c.getLong(2);
                }
                DriveSenseSha256State sha=new DriveSenseSha256State();sha.update("roadsage.archive.live.v1".getBytes(StandardCharsets.UTF_8));
                ContentValues row=new ContentValues();row.put("job_id",id);row.put("state","P5_ACTIVE");row.put("phase","SCAN");
                row.put("archive_generation",generation);row.put("through_seq",through);row.put("live_count",expected);row.put("observed_count",0);
                row.put("sha_state",sha.chainingState());row.put("sha_byte_count",sha.byteCount());row.put("sha_partial",sha.partialBlock());
                row.put("root_stream_version",1);row.put("state_format_version",DriveSenseSha256State.FORMAT_VERSION);
                row.put("created_at_ms",now);row.put("updated_at_ms",now);db.insertOrThrow("integrity_checkpoint_jobs",null,row);
                db.setTransactionSuccessful();return id;
            }finally{db.endTransaction();}
        });
        if(jobId==null)return turn("NOT_DUE",0,0,0,false);
        Job job=readJob(coordinator,jobId);
        try {
            ensureBinding(coordinator,job);
            if("SCAN".equals(job.phase))return scanCheckpointPage(coordinator,job);
            if("FINALIZE".equals(job.phase))return finalizeCheckpoint(coordinator,job);
        } catch (IllegalArgumentException | IllegalStateException invalidState) {
            if (!isRestartableBindingFailure(invalidState)) throw invalidState;
            coordinator.write(db->{db.execSQL("UPDATE integrity_checkpoint_jobs SET state='OBSOLETE',updated_at_ms=? WHERE job_id=? AND state='P5_ACTIVE'",new Object[]{System.currentTimeMillis(),job.id});return null;});
            return turn("RESTART_REQUIRED",0,0,0,true);
        }
        if("SENTINEL".equals(job.phase)){
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            coordinator.write(db->{db.execSQL("UPDATE integrity_checkpoint_jobs SET phase='COMPACT',updated_at_ms=? WHERE job_id=? AND state='P5_ACTIVE'",new Object[]{System.currentTimeMillis(),job.id});return null;});
            return turn("SENTINEL",0,0,0,false);
        }
        if("COMPACT".equals(job.phase))return compactCheckpointPage(coordinator,job);
        throw new IllegalStateException("Unknown integrity phase");
    }

    private static boolean isRestartableBindingFailure(RuntimeException error) {
        String message=error.getMessage();
        return error instanceof IllegalArgumentException ||
            "INTEGRITY_JOB_OBSOLETE".equals(message) ||
            "INTEGRITY_STATE_VERSION_MISMATCH".equals(message);
    }

    private static org.json.JSONObject scanCheckpointPage(DriveSenseStorageCoordinator coordinator,Job job)throws Exception{
        ensureBinding(coordinator,job);
        DriveSenseSha256State sha=DriveSenseSha256State.restore(job.shaState,job.shaByteCount,job.shaPartial);
        final int[] count={0};final long[] bytes={0};final boolean[] more={false};final String[] lastId={job.cursorTripId};final int[] lastRevision={job.cursorRevision};
        coordinator.read(db->{
            String cursor=job.cursorTripId==null?"":job.cursorTripId;
            try(Cursor c=db.rawQuery("SELECT trip_id,revision,payload_hash FROM trip_revisions WHERE seq IS NOT NULL AND seq<=? AND commit_state<>'PENDING' AND (retired_seq IS NULL OR retired_seq>?) AND (trip_id>? OR (trip_id=? AND revision>?)) ORDER BY trip_id,revision LIMIT 257",
                new String[]{Long.toString(job.throughSeq),Long.toString(job.throughSeq),cursor,cursor,Integer.toString(job.cursorRevision)})){
                while(c.moveToNext()){
                    String id=c.getString(0);int revision=c.getInt(1);byte[] hash=c.getBlob(2);
                    byte[] idBytes=id.getBytes(StandardCharsets.UTF_8);byte[] row=ByteBuffer.allocate(4+idBytes.length+4+4+hash.length).putInt(idBytes.length).put(idBytes).putInt(revision).putInt(hash.length).put(hash).array();
                    if(row.length>128*1024)throw new IllegalStateException("INTEGRITY_ROW_TOO_LARGE");
                    if(count[0]>=256||bytes[0]+row.length>512L*1024L){more[0]=true;break;}
                    sha.update(row);bytes[0]+=row.length;count[0]++;lastId[0]=id;lastRevision[0]=revision;
                }
            }return null;
        });
        coordinator.write(db->{ensureJobBinding(db,job);ContentValues update=new ContentValues();update.put("cursor_trip_id",lastId[0]);update.put("cursor_revision",lastRevision[0]);update.put("observed_count",job.observedCount+count[0]);update.put("sha_state",sha.chainingState());update.put("sha_byte_count",sha.byteCount());update.put("sha_partial",sha.partialBlock());if(!more[0])update.put("phase","FINALIZE");update.put("updated_at_ms",System.currentTimeMillis());db.update("integrity_checkpoint_jobs",update,"job_id=? AND state='P5_ACTIVE'",new String[]{job.id});return null;});
        return turn(more[0]?"SCAN":"FINALIZE_READY",count[0],count[0],bytes[0],more[0]);
    }

    private static org.json.JSONObject finalizeCheckpoint(DriveSenseStorageCoordinator coordinator,Job job)throws Exception{
        ensureBinding(coordinator,job);DriveSenseSha256State sha=DriveSenseSha256State.restore(job.shaState,job.shaByteCount,job.shaPartial);byte[] root=sha.digest();
        if(job.observedCount!=job.expectedCount){
            coordinator.write(db->{ContentValues failed=new ContentValues();failed.put("state","FAILED_COUNT_MISMATCH");failed.put("live_set_root",root);failed.put("updated_at_ms",System.currentTimeMillis());db.update("integrity_checkpoint_jobs",failed,"job_id=?",new String[]{job.id});db.execSQL("UPDATE archive_meta SET recovery_state='RECOVERY_REQUIRED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});return null;});
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);return turn("FAILED_COUNT_MISMATCH",0,0,0,false);
        }
        coordinator.write(db->{db.beginTransaction();try{ensureJobBinding(db,job);long checkpointSeq=appendEventInTransaction(db,"CHECKPOINT",null,null,null,null,null,"periodic_integrity","maintenance",job.throughSeq,job.expectedCount,root,System.currentTimeMillis());ContentValues update=new ContentValues();update.put("phase","SENTINEL");update.put("checkpoint_event_seq",checkpointSeq);update.put("live_set_root",root);update.put("updated_at_ms",System.currentTimeMillis());db.update("integrity_checkpoint_jobs",update,"job_id=? AND state='P5_ACTIVE'",new String[]{job.id});db.setTransactionSuccessful();}finally{db.endTransaction();}return null;});
        return turn("SENTINEL_READY",0,0,0,true);
    }

    private static org.json.JSONObject compactCheckpointPage(DriveSenseStorageCoordinator coordinator,Job job)throws Exception{
        final int[] deleted={0};
        coordinator.write(db->{long anchor=-1;try(Cursor c=db.rawQuery("SELECT seq FROM archive_events WHERE event_type='CHECKPOINT' ORDER BY seq DESC LIMIT 1 OFFSET ?",new String[]{Integer.toString(CHECKPOINT_WINDOWS-1)})){if(c.moveToFirst())anchor=c.getLong(0);}if(anchor>0){db.execSQL("DELETE FROM archive_events WHERE seq IN (SELECT seq FROM archive_events WHERE seq<? ORDER BY seq LIMIT 256)",new Object[]{anchor});try(Cursor c=db.rawQuery("SELECT changes()",null)){if(c.moveToFirst())deleted[0]=c.getInt(0);}}if(deleted[0]<256)db.execSQL("UPDATE integrity_checkpoint_jobs SET state='COMMITTED',phase='DONE',updated_at_ms=? WHERE job_id=?",new Object[]{System.currentTimeMillis(),job.id});return null;});
        return turn(deleted[0]<256?"COMPLETE":"COMPACT",deleted[0],deleted[0],deleted[0]*64L,deleted[0]==256);
    }

    private static Job readJob(DriveSenseStorageCoordinator coordinator,String id)throws Exception{return coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT job_id,archive_generation,through_seq,live_count,observed_count,phase,cursor_trip_id,COALESCE(cursor_revision,-1),sha_state,sha_byte_count,sha_partial,root_stream_version,state_format_version FROM integrity_checkpoint_jobs WHERE job_id=?",new String[]{id})){if(!c.moveToFirst())throw new IllegalStateException("Integrity job missing");return new Job(c.getString(0),c.getString(1),c.getLong(2),c.getLong(3),c.getLong(4),c.getString(5),c.getString(6),c.getInt(7),c.getBlob(8),c.getLong(9),c.getBlob(10),c.getInt(11),c.getInt(12));}});}
    private static void ensureBinding(DriveSenseStorageCoordinator coordinator,Job job)throws Exception{coordinator.read(db->{ensureJobBinding(db,job);return null;});}
    private static void ensureJobBinding(SQLiteDatabase db,Job job){try(Cursor c=db.rawQuery("SELECT archive_generation,recovery_state,authority_state FROM archive_meta WHERE id=1",null)){if(!c.moveToFirst()||!job.generation.equals(c.getString(0))||!"HEALTHY".equals(c.getString(1))||!"NATIVE".equals(c.getString(2)))throw new IllegalStateException("INTEGRITY_JOB_OBSOLETE");}if(job.rootVersion!=1||job.stateVersion!=DriveSenseSha256State.FORMAT_VERSION)throw new IllegalStateException("INTEGRITY_STATE_VERSION_MISMATCH");}
    private static org.json.JSONObject turn(String state,int items,int changed,long bytes,boolean more)throws Exception{org.json.JSONObject out=new org.json.JSONObject();out.put("state",state);out.put("itemsWorked",items);out.put("changedItems",changed);out.put("bytesWorked",bytes);out.put("hasMore",more);return out;}

    private static final class Job{final String id,generation,phase,cursorTripId;final long throughSeq,expectedCount,observedCount,shaByteCount;final int cursorRevision,rootVersion,stateVersion;final byte[]shaState,shaPartial;Job(String i,String g,long t,long e,long o,String p,String c,int r,byte[]s,long b,byte[]q,int rv,int sv){id=i;generation=g;throughSeq=t;expectedCount=e;observedCount=o;phase=p;cursorTripId=c;cursorRevision=r;shaState=s;shaByteCount=b;shaPartial=q;rootVersion=rv;stateVersion=sv;}}

    private static void compactAfterVerifiedCheckpoint(DriveSenseStorageCoordinator coordinator) throws Exception {
        coordinator.write(db -> {
            db.beginTransaction();
            try {
                long anchor = -1L;
                try (Cursor cursor = db.rawQuery(
                    "SELECT seq FROM archive_events WHERE event_type='CHECKPOINT' ORDER BY seq DESC LIMIT 1 OFFSET ?",
                    new String[]{Integer.toString(CHECKPOINT_WINDOWS - 1)}
                )) {
                    if (cursor.moveToFirst()) anchor = cursor.getLong(0);
                }
                if (anchor > 0L) db.delete("archive_events", "seq < ?", new String[]{Long.toString(anchor)});
                injectFault("DURING_CHECKPOINT_COMPACTION");
                db.delete("integrity_checkpoint_jobs", "state='COMMITTED' AND through_seq < ?", new String[]{Long.toString(Math.max(0L, anchor))});
                db.setTransactionSuccessful();
                return null;
            } finally { db.endTransaction(); }
        });
    }

    /** Complete only a checkpoint whose event and job were committed together. */
    static void recoverInterruptedCheckpoints(DriveSenseStorageCoordinator coordinator) throws Exception {
        boolean committed=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM integrity_checkpoint_jobs j JOIN archive_events e ON e.event_type='CHECKPOINT' AND e.through_seq=j.through_seq AND e.checkpoint_live_count=j.live_count AND e.live_set_root=j.live_set_root WHERE j.state='COMMITTED' LIMIT 1",null)){return c.moveToFirst();}});
        coordinator.write(db->{db.execSQL("UPDATE integrity_checkpoint_jobs SET state='INTERRUPTED' WHERE state='PENDING'");return null;});
        if(committed){
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            compactAfterVerifiedCheckpoint(coordinator);
        }
    }

    static void setFaultPointForTests(String point){testFaultPoint=point;}
    private static void injectFault(String point){if(point.equals(testFaultPoint)){testFaultPoint=null;throw new IllegalStateException("TEST_FAULT_"+point);}}

    static byte[] eventHash(byte[] previous, long seq, String type, String tripId, Integer revision,
                            byte[] payloadHash, byte[] metadataHash, String reason, String actor,
                            long at, Long throughSeq, Long checkpointCount, byte[] liveRoot) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bytes);
        writeString(out, "roadsage.archive.evt.v1");
        writeBytes(out, previous);
        out.writeLong(seq);
        writeString(out, type);
        writeString(out, tripId);
        out.writeInt(revision == null ? -1 : revision);
        writeBytes(out, payloadHash);
        writeBytes(out, metadataHash);
        writeString(out, reason);
        writeString(out, actor);
        out.writeLong(at);
        out.writeLong(throughSeq == null ? -1L : throughSeq);
        out.writeLong(checkpointCount == null ? -1L : checkpointCount);
        writeBytes(out, liveRoot);
        out.flush();
        return MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());
    }

    static long readMetaLong(SQLiteDatabase db, String column) {
        if (!column.matches("[a-z_]+")) throw new IllegalArgumentException("Invalid meta column");
        try (Cursor cursor = db.rawQuery("SELECT " + column + " FROM archive_meta WHERE id=1", null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("archive_meta missing");
            return cursor.getLong(0);
        }
    }

    private static void writeString(DataOutputStream out, String value) throws Exception {
        writeBytes(out, value == null ? null : value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void writeBytes(DataOutputStream out, byte[] value) throws Exception {
        if (value == null) { out.writeInt(-1); return; }
        out.writeInt(value.length);
        out.write(value);
    }

    private static void updateLengthPrefixed(MessageDigest digest, String value) {
        updateBytes(digest, value == null ? null : value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static void updateInt(MessageDigest digest, int value) {
        digest.update(new byte[]{(byte)(value >>> 24),(byte)(value >>> 16),(byte)(value >>> 8),(byte)value});
    }

    private static void updateBytes(MessageDigest digest, byte[] value) {
        int length = value == null ? -1 : value.length;
        updateInt(digest, length);
        if (value != null) digest.update(value);
    }

    static final class CheckpointResult {
        final boolean verified;
        final long throughSeq;
        final long liveCount;
        final byte[] root;
        CheckpointResult(boolean verified, long throughSeq, long liveCount, byte[] root) {
            this.verified = verified; this.throughSeq = throughSeq; this.liveCount = liveCount; this.root = root;
        }
    }

    private static final class Snapshot {
        final long throughSeq;
        final long expectedCount;
        final long actualCount;
        final byte[] root;
        Snapshot(long throughSeq, long expectedCount, long actualCount, byte[] root) {
            this.throughSeq=throughSeq; this.expectedCount=expectedCount; this.actualCount=actualCount; this.root=root;
        }
    }
}
