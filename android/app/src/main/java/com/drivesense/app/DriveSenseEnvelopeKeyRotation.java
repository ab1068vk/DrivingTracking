package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Metadata-only DEK rewrap. Route/speed payload bytes are never rewritten. */
final class DriveSenseEnvelopeKeyRotation {
    private static volatile String testFaultPoint;
    private static final String[] ROTATION_DOMAINS={
        "trip_archive","speed_archive",
        "trip_derived:p6_geometry_chunks","trip_derived:p6_road_observations",
        "trip_derived:p6_road_windows","trip_derived:p6_spatial_secrets",
        "trip_derived:p6_selection_requests","trip_derived:p6_trip_contributions",
        "trip_derived:p6_analytics_buckets"
    };
    private final DriveSenseStorageCoordinator coordinator;

    DriveSenseEnvelopeKeyRotation(DriveSenseStorageCoordinator coordinator) { this.coordinator = coordinator; }

    JSONObject rotateBatch(int target, int maxItems) throws Exception {
        if (target < 1 || target > 1_000_000) throw new IllegalArgumentException("Invalid KEK version");
        int limit = Math.max(1, Math.min(100, maxItems));
        if (!coordinator.read(DriveSenseKeyReferenceCounts::isVerified)) {
            JSONObject repair=repairCountsTurn();
            repair.put("targetKekVersion",target);
            repair.put("complete",false);
            repair.put("hasMore",true);
            repair.put("payloadBytesRewritten",0);
            return repair;
        }
        Selection selection=null;List<Update>updates=java.util.Collections.emptyList();
        String domain=ROTATION_DOMAINS[0];
        for(String candidate:ROTATION_DOMAINS){
            selection=load(candidate,target,limit);updates=selection.updates;domain=candidate;
            if(!updates.isEmpty()||!selection.exhausted)break;
        }

        injectFault("BEFORE_REWRAP");
        for (Update update : updates) {
            byte[] dek = DriveSenseEnvelopeCrypto.unwrapDek(
                update.wrapped,
                update.nonce,
                update.oldVersion,
                DriveSenseEnvelopeCrypto.wrapAad(
                    update.generation, update.domainAad, update.id, update.revision,
                    update.payloadHash, update.oldVersion
                )
            );
            try {
                DriveSenseEnvelopeCrypto.WrappedDek next = DriveSenseEnvelopeCrypto.wrapDek(
                    dek,
                    target,
                    DriveSenseEnvelopeCrypto.wrapAad(
                        update.generation, update.domainAad, update.id, update.revision,
                        update.payloadHash, target
                    )
                );
                update.nextWrapped = next.ciphertext;
                update.nextNonce = next.nonce;
            } finally {
                Arrays.fill(dek, (byte) 0);
            }
        }
        injectFault("AFTER_REWRAP_BEFORE_TRANSACTION");

        final String selectedDomain = domain;
        final List<Update> selectedUpdates = updates;
        final Selection selectedSelection = selection;
        coordinator.write(db -> {
            db.beginTransaction();
            try {
                int updated = 0;
                for (Update update : selectedUpdates) {
                    String table,where;String[]args;
                    if("trip_archive".equals(update.domain)){
                        table="trip_revisions";where="trip_id=? AND revision=? AND kek_version=?";
                        args=new String[]{update.id,Integer.toString(update.revision),Integer.toString(update.oldVersion)};
                    }else if("speed_archive".equals(update.domain)){
                        table="speed_buckets";where="bucket_id=? AND speed_generation=? AND revision=? AND kek_version=?";
                        args=new String[]{update.id,update.generation,Integer.toString(update.revision),Integer.toString(update.oldVersion)};
                    }else{
                        table=update.table;where="rowid=? AND key_version=?";
                        args=new String[]{Long.toString(update.rowId),Integer.toString(update.oldVersion)};
                    }
                    ContentValues values = new ContentValues();
                    values.put("wrapped_dek", update.nextWrapped);
                    values.put("wrap_nonce", update.nextNonce);
                    values.put(update.domain.endsWith("_archive")?"kek_version":"key_version", target);
                    if (db.update(table, values, where, args) != 1) {
                        throw new IllegalStateException("Concurrent KEK rotation conflict");
                    }
                    DriveSenseKeyReferenceCounts.adjust(db, update.domain, update.oldVersion, -1);
                    DriveSenseKeyReferenceCounts.adjust(db, update.domain, target, 1);
                    if (++updated == 1) injectFault("DURING_REWRAP_TRANSACTION");
                }
                ContentValues state = new ContentValues();
                state.put("id", 1);
                state.put("target_kek_version", target);
                state.put("phase", selectedUpdates.isEmpty() ? "ZERO_PROOF" : "REWRAPPING");
                state.put("domain_id", selectedDomain);
                state.put("last_batch_count", selectedUpdates.size());
                state.put("cursor", selectedSelection.cursor);
                state.put("cursor_kek_version",selectedSelection.cursorKek);
                state.put("cursor_commit_state",selectedSelection.cursorState);
                state.put("cursor_item_id",selectedSelection.cursorId);
                state.put("cursor_revision",selectedSelection.cursorRevision);
                state.put("count_state",DriveSenseKeyReferenceCounts.isVerified(db)?"VERIFIED":"DIRTY");
                state.put("zero_proof", 0);
                state.put("updated_at_ms", System.currentTimeMillis());
                db.insertWithOnConflict("rotation_state", null, state, SQLiteDatabase.CONFLICT_REPLACE);
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            return null;
        });
        injectFault("AFTER_REWRAP_TRANSACTION");

        DriveSenseEncryptedDomainRegistry.ReferenceProof remainingProof = coordinator.exclusive(db ->
            DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(coordinator.context(), db, target, true)
        );
        boolean scanComplete = updates.isEmpty() && selection.exhausted
            && ROTATION_DOMAINS[ROTATION_DOMAINS.length-1].equals(selectedDomain);
        boolean done = scanComplete && remainingProof.provesZero();
        if (done) {
            injectFault("BEFORE_ZERO_PROOF");
            coordinator.write(db -> {
                db.execSQL(
                    "UPDATE rotation_state SET phase='COMPLETE',zero_proof=1,updated_at_ms=? WHERE id=1",
                    new Object[] { System.currentTimeMillis() }
                );
                return null;
            });
            injectFault("AFTER_ZERO_PROOF_BEFORE_RETIREMENT");
            for (int version = 1; version < target; version++) retireAfterFreshProof(version);
        } else if (updates.isEmpty()) {
            coordinator.write(db -> {
                db.execSQL(
                    "UPDATE rotation_state SET phase='BLOCKED_REFERENCES',zero_proof=0,domain_id='encrypted_domain_registry',updated_at_ms=? WHERE id=1",
                    new Object[] { System.currentTimeMillis() }
                );
                return null;
            });
        }

        int remaining = remainingProof.references() + remainingProof.unreadable();
        DriveSenseDurabilityJournal.record(
            coordinator.context(), "WARN", "KEK_REWRAP_BATCH", null,
            updates.size(), remaining, target, done ? "HEALTHY" : "ROTATING"
        );
        JSONObject out = new JSONObject();
        out.put("targetKekVersion", target);
        out.put("domain", selectedDomain);
        out.put("rewrapped", updates.size());
        out.put("recordsExamined",selection.examined);
        out.put("remaining", remaining);
        out.put("activeSpoolReferences", remainingProof.referencesFor("active_trip_spool"));
        out.put("unreadableActiveSpoolManifests", remainingProof.unreadableFor("active_trip_spool"));
        out.put("registryProof", remainingProof.json());
        out.put("complete", done);
        out.put("hasMore",!done);
        out.put("payloadBytesRewritten", 0);
        return out;
    }

    /**
     * Rebuilds exact reference counts without an ordinary whole-domain scan.
     * The scratch aggregate is rotation-owned derived state.  It becomes
     * authoritative only in the same transaction that replaces the old
     * counts after the final indexed page has been examined.
     */
    private JSONObject repairCountsTurn() throws Exception {
        final int catalogLimit=100,fileLimit=32;
        RepairCursor cursor=coordinator.read(db->loadRepairCursor(db));
        if ("START".equals(cursor.domain)) {
            coordinator.write(db->{db.beginTransaction();try{
                db.delete("kek_reference_repair_counts",null,null);
                setRepairCursor(db,"trip_archive",-1,"","",-1);
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}return null;});
            cursor=new RepairCursor("trip_archive",-1,"","",-1);
        }
        final RepairCursor current=cursor;
        RepairPage page=coordinator.read(db->readRepairPage(db,current,catalogLimit,fileLimit));
        coordinator.write(db->{db.beginTransaction();try{
            for(CountDelta count:page.counts)db.execSQL(
                "INSERT INTO kek_reference_repair_counts(domain_id,key_version,reference_count) VALUES(?,?,?) " +
                    "ON CONFLICT(domain_id,key_version) DO UPDATE SET reference_count=reference_count+excluded.reference_count",
                new Object[]{count.domain,count.version,count.count});
            if(page.finishedAll){
                db.delete("key_reference_counts",null,null);
                db.execSQL("INSERT INTO key_reference_counts(domain_id,key_version,reference_count,updated_at_ms) " +
                    "SELECT domain_id,key_version,reference_count,? FROM kek_reference_repair_counts",new Object[]{System.currentTimeMillis()});
                db.delete("kek_reference_repair_counts",null,null);
                setRepairCursor(db,"COMPLETE",-1,"","",-1);
                DriveSenseKeyReferenceCounts.markVerified(db);
            }else setRepairCursor(db,page.next.domain,page.next.kek,page.next.state,page.next.id,page.next.revision);
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}return null;});
        JSONObject out=new JSONObject();out.put("phase",page.finishedAll?"COUNT_REPAIR_COMPLETE":"COUNT_REPAIR");
        out.put("domain",current.domain);out.put("recordsExamined",page.examined);out.put("rewrapped",0);
        out.put("remaining",0);out.put("countState",page.finishedAll?"VERIFIED":"DIRTY");
        return out;
    }

    private RepairCursor loadRepairCursor(SQLiteDatabase db){
        try(Cursor c=db.rawQuery("SELECT repair_domain,repair_cursor_kek,repair_cursor_state,repair_cursor_id,repair_cursor_revision FROM rotation_state WHERE id=1",null)){
            if(c.moveToFirst()){
                String domain=c.getString(0);
                if("COMPLETE".equals(domain))return new RepairCursor("START",-1,"","",-1);
                return new RepairCursor(domain,c.getInt(1),c.getString(2),c.getString(3),c.getInt(4));
            }
        }
        return new RepairCursor("START",-1,"","",-1);
    }

    private void setRepairCursor(SQLiteDatabase db,String domain,int kek,String state,String id,int revision){
        db.execSQL("INSERT OR IGNORE INTO rotation_state(id,target_kek_version,phase,last_batch_count,zero_proof,updated_at_ms) VALUES(1,1,'COUNT_REPAIR',0,0,?)",new Object[]{System.currentTimeMillis()});
        ContentValues values=new ContentValues();values.put("id",1);values.put("repair_domain",domain);
        values.put("repair_cursor_kek",kek);values.put("repair_cursor_state",state);values.put("repair_cursor_id",id);
        values.put("repair_cursor_revision",revision);values.put("count_state","DIRTY");values.put("zero_proof",0);
        values.put("updated_at_ms",System.currentTimeMillis());
        db.update("rotation_state",values,"id=1",null);
    }

    private RepairPage readRepairPage(SQLiteDatabase db,RepairCursor cursor,int catalogLimit,int fileLimit){
        if("trip_archive".equals(cursor.domain)||"speed_archive".equals(cursor.domain)){
            boolean trip="trip_archive".equals(cursor.domain);
            String table=trip?"trip_revisions":"speed_buckets",id=trip?"trip_id":"bucket_id";
            String sql="SELECT kek_version,commit_state,"+id+","+(trip?"revision":"rowid")+" FROM "+table+
                " WHERE wrapped_dek IS NOT NULL AND wrapped_dek<>X'' AND (kek_version>? OR (kek_version=? AND commit_state>?) OR " +
                "(kek_version=? AND commit_state=? AND "+id+">?) OR (kek_version=? AND commit_state=? AND "+id+"=? AND "+(trip?"revision":"rowid")+">?)) " +
                "ORDER BY kek_version,commit_state,"+id+","+(trip?"revision":"rowid")+" LIMIT ?";
            List<CountDelta> counts=new ArrayList<>();int examined=0,k=cursor.kek,r=cursor.revision;String s=cursor.state,i=cursor.id;
            try(Cursor c=db.rawQuery(sql,new String[]{Integer.toString(k),Integer.toString(k),s,Integer.toString(k),s,i,Integer.toString(k),s,i,Integer.toString(r),Integer.toString(catalogLimit)})){
                while(c.moveToNext()){examined++;k=c.getInt(0);s=c.getString(1);i=c.getString(2);r=c.getInt(3);merge(counts,cursor.domain,k);}
            }
            if(examined==catalogLimit)return new RepairPage(counts,examined,new RepairCursor(cursor.domain,k,s,i,r),false);
            return new RepairPage(counts,examined,new RepairCursor(trip?"speed_archive":ROTATION_DOMAINS[2],-1,"","",-1),false);
        }
        if(cursor.domain.startsWith("trip_derived:")){
            String table=cursor.domain.substring("trip_derived:".length());long after=Math.max(-1,cursor.revision);
            List<CountDelta> counts=new ArrayList<>();int examined=0;long rowId=after;
            try(Cursor c=db.rawQuery("SELECT rowid,key_version FROM "+table+
                " WHERE key_version IS NOT NULL AND rowid>? ORDER BY rowid LIMIT ?",
                new String[]{Long.toString(after),Integer.toString(catalogLimit)})){
                while(c.moveToNext()){examined++;rowId=c.getLong(0);merge(counts,"trip_derived",c.getInt(1));}
            }
            if(examined==catalogLimit)return new RepairPage(counts,examined,
                new RepairCursor(cursor.domain,-1,"","",(int)rowId),false);
            return new RepairPage(counts,examined,new RepairCursor(nextRotationDomain(cursor.domain),-1,"","",-1),false);
        }
        List<CountDelta> counts=new ArrayList<>();int examined=0,k=cursor.kek;String id=cursor.id;
        String fileDomain=cursor.state;
        try(Cursor c=db.rawQuery("SELECT domain_id,entry_id,key_version FROM encrypted_file_key_registry WHERE state='VERIFIED' AND (domain_id>? OR (domain_id=? AND key_version>?) OR (domain_id=? AND key_version=? AND entry_id>?)) ORDER BY domain_id,key_version,entry_id LIMIT ?",new String[]{fileDomain,fileDomain,Integer.toString(k),fileDomain,Integer.toString(k),id,Integer.toString(fileLimit)})){
            while(c.moveToNext()){examined++;fileDomain=c.getString(0);id=c.getString(1);k=c.getInt(2);merge(counts,fileDomain,k);}
        }
        return new RepairPage(counts,examined,new RepairCursor("encrypted_files",k,fileDomain,id,-1),examined<fileLimit);
    }

    private static void merge(List<CountDelta> counts,String domain,int version){
        for(CountDelta value:counts)if(value.domain.equals(domain)&&value.version==version){value.count++;return;}
        counts.add(new CountDelta(domain,version,1));
    }

    private void retireAfterFreshProof(int version) throws Exception {
        coordinator.exclusive(db -> DriveSenseEnvelopeCrypto.withRetirementFence(() -> {
            DriveSenseEncryptedDomainRegistry.ReferenceProof fresh =
                DriveSenseEncryptedDomainRegistry.proveEnvelopeKek(coordinator.context(), db, version, false);
            if (!fresh.provesZero()) return false;
            injectFault("BEFORE_OLD_KEK_RETIREMENT");
            return DriveSenseEnvelopeCrypto.deleteKekInsideRetirementFence(version);
        }));
    }

    JSONObject status() throws Exception {
        return coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery(
                "SELECT target_kek_version,phase,domain_id,last_batch_count,zero_proof,updated_at_ms FROM rotation_state WHERE id=1",
                null
            )) {
                JSONObject out = new JSONObject();
                if (!cursor.moveToFirst()) {
                    out.put("phase", "IDLE");
                    return out;
                }
                out.put("targetKekVersion", cursor.getInt(0));
                out.put("phase", cursor.getString(1));
                out.put("domain", cursor.getString(2));
                out.put("lastBatchCount", cursor.getInt(3));
                out.put("zeroProof", cursor.getInt(4) != 0);
                out.put("updatedAtMs", cursor.getLong(5));
                return out;
            }
        });
    }

    private Selection load(String domain, int target, int limit) throws Exception {
        if(domain.startsWith("trip_derived:"))return loadTripDerived(domain,target,limit);
        return coordinator.read(db -> {
            List<Update> out = new ArrayList<>();
            int cursorKek=Integer.MIN_VALUE,cursorRevision=-1;String cursorState="",cursorId="";
            try(Cursor state=db.rawQuery("SELECT target_kek_version,domain_id,cursor_kek_version,cursor_commit_state,cursor_item_id,cursor_revision FROM rotation_state WHERE id=1",null)){
                if(state.moveToFirst()&&state.getInt(0)==target&&domain.equals(state.getString(1))&&!state.isNull(2)){cursorKek=state.getInt(2);cursorState=state.getString(3);cursorId=state.getString(4);cursorRevision=state.getInt(5);}
            }
            String sql = "trip_archive".equals(domain)
                ? "SELECT r.trip_id,r.revision,r.payload_hash,r.wrapped_dek,r.wrap_nonce,r.kek_version,m.archive_generation,r.commit_state,r.revision FROM trip_revisions r JOIN archive_meta m ON m.id=1 WHERE r.kek_version<? AND (r.kek_version>? OR (r.kek_version=? AND r.commit_state>?) OR (r.kek_version=? AND r.commit_state=? AND r.trip_id>?) OR (r.kek_version=? AND r.commit_state=? AND r.trip_id=? AND r.revision>?)) ORDER BY r.kek_version,r.commit_state,r.trip_id,r.revision LIMIT ?"
                : "SELECT b.bucket_id,b.revision,b.payload_hash,b.wrapped_dek,b.wrap_nonce,b.kek_version,b.speed_generation,b.commit_state,b.rowid FROM speed_buckets b WHERE b.kek_version<? AND (b.kek_version>? OR (b.kek_version=? AND b.commit_state>?) OR (b.kek_version=? AND b.commit_state=? AND b.bucket_id>?) OR (b.kek_version=? AND b.commit_state=? AND b.bucket_id=? AND b.rowid>?)) ORDER BY b.kek_version,b.commit_state,b.bucket_id,b.rowid LIMIT ?";
            String k=Integer.toString(cursorKek),r=Integer.toString(cursorRevision);
            int examined=0,lastKek=cursorKek,lastRevision=cursorRevision;String lastState=cursorState,lastId=cursorId;
            try (Cursor cursor = db.rawQuery(sql, new String[] { Integer.toString(target),k,k,cursorState,k,cursorState,cursorId,k,cursorState,cursorId,r,Integer.toString(limit) })) {
                while (cursor.moveToNext()) {
                    examined++;lastId=cursor.getString(0);lastRevision=cursor.getInt(8);lastKek=cursor.getInt(5);lastState=cursor.getString(7);
                    byte[]wrapped=cursor.getBlob(3);if(wrapped==null||wrapped.length==0)continue;
                    out.add(new Update(domain,lastId,cursor.getInt(1),cursor.getBlob(2),wrapped,cursor.getBlob(4),lastKek,cursor.getString(6),"trip_archive".equals(domain)?"trip_payload":"speed_bucket"));
                }
            }
            JSONObject encoded=new JSONObject();encoded.put("kek",lastKek);encoded.put("state",lastState);encoded.put("id",lastId);encoded.put("revision",lastRevision);
            return new Selection(out,examined,examined<limit,encoded.toString(),lastKek,lastState,lastId,lastRevision);
        });
    }

    private Selection loadTripDerived(String rotationDomain,int target,int limit)throws Exception{
        return coordinator.read(db->{
            String table=rotationDomain.substring("trip_derived:".length());String generation,subject,revision,version,ordinal;
            switch(table){
                case "p6_geometry_chunks": generation="archive_generation";subject="trip_id";
                    revision="CAST(substr(content_version,1,instr(content_version,':')-1) AS INTEGER)";
                    version="content_version";ordinal="ordinal";break;
                case "p6_road_observations": generation="archive_generation";subject="trip_id";
                    revision="source_revision";version="content_version";ordinal="ordinal";break;
                case "p6_road_windows": generation="archive_generation";subject="trip_id";
                    revision="source_revision";version="source_revision||':road-'||lower(record_kind)||'-v1'";
                    ordinal="ordinal";break;
                case "p6_spatial_secrets": generation="archive_generation";subject="'spatial-v1'";
                    revision="1";version="'secret-v1'";ordinal="0";break;
                case "p6_selection_requests": generation="archive_generation";subject="request_id";
                    revision="1";version="'selection-v1'";ordinal="0";break;
                case "p6_trip_contributions": generation="archive_generation";
                    subject="'analytics-contribution:'||trip_id";revision="source_revision";
                    version="'analytics-v2'";ordinal="0";break;
                case "p6_analytics_buckets": generation="source_binding";
                    subject="'analytics-bucket:'||bucket_key";revision="metric_schema_version";
                    version="'analytics-bucket-v2'";ordinal="0";break;
                default: throw new IllegalStateException("Unknown derived rotation domain "+rotationDomain);
            }
            long after=-1;try(Cursor state=db.rawQuery("SELECT target_kek_version,domain_id,cursor_revision "+
                "FROM rotation_state WHERE id=1",null)){if(state.moveToFirst()&&state.getInt(0)==target
                    &&rotationDomain.equals(state.getString(1)))after=state.getLong(2);}
            String sql="SELECT rowid,"+generation+","+subject+","+revision+","+version+","+ordinal+
                ",payload_hash,wrapped_dek,wrap_nonce,key_version FROM "+table+
                " WHERE key_version<? AND rowid>? AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' "+
                "ORDER BY rowid LIMIT ?";
            List<Update>out=new ArrayList<>();int examined=0;long last=after;
            try(Cursor c=db.rawQuery(sql,new String[]{Integer.toString(target),Long.toString(after),Integer.toString(limit)})){
                while(c.moveToNext()){
                    examined++;last=c.getLong(0);String itemSubject=c.getString(2),content=c.getString(4);
                    out.add(new Update("trip_derived",itemSubject+"|"+content+"|"+c.getInt(5),c.getInt(3),
                        c.getBlob(6),c.getBlob(7),c.getBlob(8),c.getInt(9),c.getString(1),"trip_derived",
                        table,c.getLong(0)));
                }
            }
            JSONObject encoded=new JSONObject().put("rowId",last);
            return new Selection(out,examined,examined<limit,encoded.toString(),-1,"","",(int)last);
        });
    }

    private static String nextRotationDomain(String domain){
        for(int index=0;index<ROTATION_DOMAINS.length-1;index++)if(ROTATION_DOMAINS[index].equals(domain))
            return ROTATION_DOMAINS[index+1];
        return "encrypted_files";
    }

    static void setFaultPointForTests(String point) { testFaultPoint = point; }
    private static void injectFault(String point) {
        if (point.equals(testFaultPoint)) {
            testFaultPoint = null;
            throw new IllegalStateException("TEST_FAULT_" + point);
        }
    }

    private static final class Update {
        final String domain, id, generation, domainAad,table;
        final long rowId;
        final int revision, oldVersion;
        final byte[] payloadHash, wrapped, nonce;
        byte[] nextWrapped, nextNonce;
        Update(String domain, String id, int revision, byte[] payloadHash, byte[] wrapped, byte[] nonce,
               int oldVersion, String generation, String domainAad) {
            this.domain = domain;
            this.id = id;
            this.revision = revision;
            this.payloadHash = payloadHash;
            this.wrapped = wrapped;
            this.nonce = nonce;
            this.oldVersion = oldVersion;
            this.generation = generation;
            this.domainAad = domainAad;
            this.table=null;this.rowId=-1;
        }
        Update(String domain,String id,int revision,byte[]payloadHash,byte[]wrapped,byte[]nonce,
               int oldVersion,String generation,String domainAad,String table,long rowId){
            this.domain=domain;this.id=id;this.revision=revision;this.payloadHash=payloadHash;
            this.wrapped=wrapped;this.nonce=nonce;this.oldVersion=oldVersion;this.generation=generation;
            this.domainAad=domainAad;this.table=table;this.rowId=rowId;
        }
    }
    private static final class Selection {final List<Update>updates;final int examined;final boolean exhausted;final String cursor,cursorState,cursorId;final int cursorKek,cursorRevision;Selection(List<Update>u,int e,boolean x,String c,int k,String s,String i,int r){updates=u;examined=e;exhausted=x;cursor=c;cursorKek=k;cursorState=s;cursorId=i;cursorRevision=r;}}
    private static final class RepairCursor {final String domain,state,id;final int kek,revision;RepairCursor(String d,int k,String s,String i,int r){domain=d;kek=k;state=s;id=i;revision=r;}}
    private static final class CountDelta {final String domain;final int version;long count;CountDelta(String d,int v,long c){domain=d;version=v;count=c;}}
    private static final class RepairPage {final List<CountDelta>counts;final int examined;final RepairCursor next;final boolean finishedAll;RepairPage(List<CountDelta>c,int e,RepairCursor n,boolean f){counts=c;examined=e;next=n;finishedAll=f;}}
}
