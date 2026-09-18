package com.drivesense.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/** Journal-owned, rebuildable manifest/file registry. Intake manifests remain authority. */
final class DriveSenseJournalControlPlane {
    private static final AtomicBoolean BOOTSTRAP_CANCEL_REQUESTED = new AtomicBoolean(false);
    static final int MAX_EXAMINED = 32;
    static final long MAX_MANIFEST_BYTES = 2L * 1024L * 1024L;
    static final long MAX_WORK_BYTES = 5L * 1024L * 1024L;
    private static final String MANIFEST_SUFFIX = ".manifest.enc";
    private static final String CHUNK_SUFFIX = ".chunk.enc";

    private DriveSenseJournalControlPlane() {}

    static boolean enabled(Context context) {
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context);
             Cursor c = helper.getReadableDatabase().rawQuery(
                 "SELECT writers_enabled FROM p5_control_state WHERE id=1", null)) {
            return c.moveToFirst() && c.getInt(0) == 1;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** O(1) namespace probe; it never materializes the directory. */
    static void ensureProbed(Context context) {
        if (!enabled(context)) return;
        synchronized (DriveSenseCompletedTripJournal.LOCK) {
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                String state;
                try (Cursor c = db.rawQuery("SELECT state FROM journal_bootstrap_state WHERE id=1", null)) {
                    state = c.moveToFirst() ? c.getString(0) : "UNPROBED";
                }
                if (!"UNPROBED".equals(state)) return;
                boolean legacy = hasLegacyPreference(context);
                boolean nonEmpty = DriveSenseDirectoryStream.hasRelevantEntry(
                    DriveSenseCompletedTripJournal.directory(context), path -> true);
                long now = System.currentTimeMillis();
                db.beginTransaction();
                try {
                    if (legacy || nonEmpty) {
                        db.execSQL("UPDATE journal_bootstrap_state SET state='BOOTSTRAP_REQUIRED',attempt_id=NULL,updated_at_ms=? WHERE id=1", new Object[]{now});
                        db.execSQL("UPDATE journal_summary SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{now});
                        db.execSQL("UPDATE p5_control_state SET journal_state='BOOTSTRAP_REQUIRED',journal_legacy_presence=?,updated_at_ms=? WHERE id=1", new Object[]{legacy ? "PRESENT" : "ABSENT", now});
                    } else {
                        db.delete("journal_manifest_index", null, null);
                        db.delete("journal_file_registry", null, null);
                        db.execSQL("UPDATE journal_bootstrap_state SET state='COMPLETE',attempt_id=NULL,examined=0,files_seen=0,encoded_bytes=0,updated_at_ms=? WHERE id=1", new Object[]{now});
                        publishSummary(db, "ABSENT", true);
                    }
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
            } catch (Exception error) {
                markDirty(context, "UNKNOWN");
            }
        }
    }

    static void markDirty(Context context, String legacyPresence) {
        if (!enabled(context)) return;
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            SQLiteDatabase db = helper.getWritableDatabase();
            long now = System.currentTimeMillis();
            db.execSQL("UPDATE journal_summary SET state='DIRTY',updated_at_ms=? WHERE id=1", new Object[]{now});
            db.execSQL("UPDATE journal_repair_state SET state='DIRTY',cursor='',updated_at_ms=? WHERE id=1", new Object[]{now});
            db.execSQL("UPDATE p5_control_state SET journal_state='DIRTY',journal_legacy_presence=?,updated_at_ms=? WHERE id=1", new Object[]{legacyPresence == null ? "UNKNOWN" : legacyPresence, now});
        } catch (Exception ignored) {
            // Per-entry manifests remain authority; UNKNOWN is fail-closed.
        }
    }

    /** Durable direct-stem intent written before an authoritative file mutation. */
    static void beginEntryMutation(Context context,String tripId){
        if(!enabled(context))return;
        ensureProbed(context);
        try(DriveSenseArchiveOpenHelper helper=new DriveSenseArchiveOpenHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();String key=stem(tripId);long now=System.currentTimeMillis();db.beginTransaction();
            try{
                long exists=scalar(db,"SELECT COUNT(*) FROM journal_manifest_index WHERE entry_key='"+key+"'");
                if(exists==0){ContentValues intent=new ContentValues();intent.put("entry_key",key);intent.put("trip_id",tripId);intent.put("created_at_ms",0);intent.put("updated_at_ms",now);intent.put("encrypted_bytes",0);intent.put("largest_file_bytes",0);intent.put("readable",-1);intent.put("manifest_bytes",0);intent.put("chunk_count",0);intent.put("mutation_version",now);db.insertOrThrow("journal_manifest_index",null,intent);}
                else db.execSQL("UPDATE journal_manifest_index SET mutation_version=mutation_version+1,updated_at_ms=? WHERE entry_key=?",new Object[]{now,key});
                String summary="DIRTY",repair="DIRTY";try(Cursor c=db.rawQuery("SELECT s.state,r.state FROM journal_summary s JOIN journal_repair_state r ON r.id=1 WHERE s.id=1",null)){if(c.moveToFirst()){summary=c.getString(0);repair=c.getString(1);}}
                boolean isolated="VERIFIED".equals(summary)&&"CLEAN".equals(repair);
                db.execSQL("UPDATE journal_summary SET state='DIRTY',updated_at_ms=? WHERE id=1",new Object[]{now});
                db.execSQL("UPDATE journal_repair_state SET state=?,cursor=?,updated_at_ms=? WHERE id=1",new Object[]{isolated?"MUTATION_DIRTY":"DIRTY",isolated?key:"",now});
                db.execSQL("UPDATE p5_control_state SET journal_state='DIRTY',journal_legacy_presence='ABSENT',updated_at_ms=? WHERE id=1",new Object[]{now});
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
        }catch(Exception error){markDirty(context,"UNKNOWN");}
    }

    static void recordEntry(Context context, String tripId) {
        if (!enabled(context)) return;
        ensureProbed(context);
        try {
            String key = stem(tripId);
            File dir = DriveSenseCompletedTripJournal.directory(context);
            File file = DriveSenseCompletedTripJournal.manifestFile(dir, key);
            JSONObject manifest = DriveSenseCompletedTripJournal.readManifest(file, key);
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                db.beginTransaction();
                try {
                    EntryStats before=entryStats(db,key);
                    removeRegistryEntry(db, key);
                    if (manifest == null) insertUnreadable(db, key, Math.max(0L, file.length()), null);
                    else recordManifest(context, db, dir, key, manifest, null);
                    applyMutationSummary(db,context,key,before,entryStats(db,key));
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
            }
            if(manifest!=null&&manifest.optInt("version",0)==2){
                String session=manifest.optString("rsas_session_id","");
                int version=journalKeyVersion(context,dir,manifest);
                if(!session.isEmpty()&&version>0)DriveSenseKeyReferenceCounts.moveFileReference(
                    context,"active_trip_spool",session,"completed_trip_journal",key,version);
            }
        } catch (Exception error) {
            markDirty(context, "UNKNOWN");
        }
    }

    /**
     * Resolves the direct-stem mutation intent after a writer reports failure.
     * A committed manifest remains authoritative and is indexed exactly; when
     * no manifest exists, the uncommitted intent is removed. This is bounded
     * to the one attempted entry and never scans the journal directory.
     */
    static void finishFailedEntryMutation(Context context, String tripId) {
        if (!enabled(context)) return;
        try {
            String key = stem(tripId);
            File dir = DriveSenseCompletedTripJournal.directory(context);
            File file = DriveSenseCompletedTripJournal.manifestFile(dir, key);
            JSONObject manifest = DriveSenseCompletedTripJournal.readManifest(file, key);
            if (manifest != null) {
                recordEntry(context, tripId);
                return;
            }
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                db.beginTransaction();
                try {
                    EntryStats before = entryStats(db, key);
                    removeRegistryEntry(db, key);
                    applyMutationSummary(db, context, key, before, EntryStats.ZERO);
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
            }
        } catch (Exception error) {
            markDirty(context, "UNKNOWN");
        }
    }

    static void removeEntry(Context context, String tripId) {
        if (!enabled(context)) return;
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                String key=stem(tripId);
                EntryStats before=entryStats(db,key);
                removeRegistryEntry(db, key);
                applyMutationSummary(db,context,key,before,EntryStats.ZERO);
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            boolean restore=DriveSenseKeyReferenceCounts.beginFileMutation(context);
            DriveSenseKeyReferenceCounts.removeFileReference(context,"completed_trip_journal",stem(tripId),restore);
        } catch (Exception error) {
            markDirty(context, "UNKNOWN");
        }
    }

    static long entryBytes(Context context, String entryKey) {
        if (!enabled(context)) return -1L;
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context);
             Cursor c = helper.getReadableDatabase().rawQuery(
                 "SELECT COALESCE(SUM(encoded_bytes),0) FROM journal_file_registry WHERE entry_key=? AND state<>'REMOVED'",
                 new String[]{entryKey})) {
            return c.moveToFirst() ? c.getLong(0) : 0L;
        } catch (Exception error) { return -1L; }
    }

    static List<String> registeredPaths(Context context, String entryKey) throws Exception {
        ArrayList<String> paths = new ArrayList<>();
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context);
             Cursor c = helper.getReadableDatabase().rawQuery(
                 "SELECT relative_path FROM journal_file_registry WHERE entry_key=? AND state<>'REMOVED' ORDER BY file_kind,generation,ordinal,relative_path",
                 new String[]{entryKey})) {
            while (c.moveToNext()) paths.add(c.getString(0));
        }
        return paths;
    }

    static List<String> supersededChunkPaths(Context context, String entryKey, String keepGeneration)
        throws Exception {
        ArrayList<String> paths = new ArrayList<>();
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context);
             Cursor c = helper.getReadableDatabase().rawQuery(
                 "SELECT relative_path FROM journal_file_registry WHERE entry_key=? AND file_kind='CHUNK' AND generation<>? ORDER BY generation,ordinal",
                 new String[]{entryKey, keepGeneration})) {
            while (c.moveToNext()) paths.add(c.getString(0));
        }
        return paths;
    }

    static void removePaths(Context context, List<String> paths) {
        if (!enabled(context) || paths == null || paths.isEmpty()) return;
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            SQLiteDatabase db = helper.getWritableDatabase();
            db.beginTransaction();
            try {
                Map<String,EntryStats> before=new LinkedHashMap<>();
                for(String path:paths)try(Cursor c=db.rawQuery("SELECT entry_key FROM journal_file_registry WHERE relative_path=?",new String[]{path})){if(c.moveToFirst()){String key=c.getString(0);before.putIfAbsent(key,entryStats(db,key));}}
                for (String path : paths) db.delete("journal_file_registry", "relative_path=?", new String[]{path});
                for(Map.Entry<String,EntryStats> entry:before.entrySet()){refreshEntryBytes(db,entry.getKey(),System.currentTimeMillis());applyMutationSummary(db,context,entry.getKey(),entry.getValue(),entryStats(db,entry.getKey()));}
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        } catch (Exception error) { markDirty(context, "UNKNOWN"); }
    }

    static void clearRegistry(Context context){
        if(!enabled(context))return;
        try(DriveSenseArchiveOpenHelper helper=new DriveSenseArchiveOpenHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();db.beginTransaction();try{db.delete("journal_manifest_index",null,null);db.delete("journal_file_registry",null,null);db.execSQL("UPDATE journal_bootstrap_state SET state='COMPLETE',attempt_id=NULL,examined=0,files_seen=0,encoded_bytes=0,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});publishSummary(db,"ABSENT",true);db.setTransactionSuccessful();}finally{db.endTransaction();}
        }catch(Exception error){markDirty(context,"UNKNOWN");}
    }

    static JSONObject status(Context context) throws Exception {
        ensureProbed(context);
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context);
             Cursor c = helper.getReadableDatabase().rawQuery(
                 "SELECT state,pending_count,unreadable_count,encrypted_bytes,largest_file_bytes,oldest_pending_at_ms,last_verified_save_at_ms FROM journal_summary WHERE id=1", null)) {
            if (!c.moveToFirst()) throw new IllegalStateException("Journal summary unavailable");
            JSONObject out = new JSONObject();
            String state = c.getString(0);
            out.put("summaryState", state);
            out.put("queueReadable", "VERIFIED".equals(state) && c.getInt(2) == 0);
            out.put("pendingCount", c.getLong(1));
            out.put("unreadableCount", c.getLong(2));
            out.put("encryptedBytes", c.getLong(3));
            out.put("largestFileBytes", c.getLong(4));
            out.put("oldestPendingAtMs", c.isNull(5) ? JSONObject.NULL : c.getLong(5));
            out.put("lastVerifiedSaveAtMs", c.isNull(6) ? JSONObject.NULL : c.getLong(6));
            return out;
        }
    }

    static JSONArray oldest(Context context, int maxItems) throws Exception {
        JSONArray rows = oldestPage(context, maxItems, null).optJSONArray("rows");
        JSONArray ids = new JSONArray();
        for (int index = 0; rows != null && index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row != null) ids.put(row.optString("trip_id", ""));
        }
        return ids;
    }

    /**
     * AUD-005. The same bounded query, plus a KEYSET CONTINUATION.
     *
     * The emergency-acknowledgement workflow drove several turns against `oldest()` and
     * got the same capped prefix every time: acknowledging a crash prompt does not remove
     * a journal entry, so nothing about the answer changed between turns and every later
     * pending workflow was unreachable while the call reported success.
     *
     * The continuation is a keyset over the SAME `(created_at_ms, entry_key)` ordering the
     * page already uses, so a page can never repeat or skip, and each row carries the
     * cursor that resumes AFTER it — the caller takes the cursor of the last row it
     * actually accepted, not of the last row this query happened to read.
     */
    static JSONObject oldestPage(Context context, int maxItems, String cursor) throws Exception {
        ensureProbed(context);
        int limit = Math.max(1, Math.min(8, maxItems));
        long afterCreatedAtMs = -1L;
        String afterEntryKey = "";
        if (cursor != null && !cursor.isEmpty()) {
            int split = cursor.indexOf('|');
            if (split > 0) {
                try {
                    afterCreatedAtMs = Long.parseLong(cursor.substring(0, split));
                } catch (NumberFormatException ignored) {
                    afterCreatedAtMs = -1L;
                }
                afterEntryKey = cursor.substring(split + 1);
            }
        }
        JSONArray rows = new JSONArray();
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            SQLiteDatabase db = helper.getReadableDatabase();
            try (Cursor state = db.rawQuery("SELECT state FROM journal_summary WHERE id=1", null)) {
                if (!state.moveToFirst() || !"VERIFIED".equals(state.getString(0))) throw new IllegalStateException("JOURNAL_INDEX_DIRTY");
            }
            String sql = afterCreatedAtMs < 0
                ? "SELECT trip_id,created_at_ms,entry_key FROM journal_manifest_index WHERE readable=1 ORDER BY created_at_ms,entry_key LIMIT ?"
                : "SELECT trip_id,created_at_ms,entry_key FROM journal_manifest_index WHERE readable=1 AND (created_at_ms > ? OR (created_at_ms = ? AND entry_key > ?)) ORDER BY created_at_ms,entry_key LIMIT ?";
            String[] args = afterCreatedAtMs < 0
                ? new String[]{Integer.toString(limit)}
                : new String[]{Long.toString(afterCreatedAtMs), Long.toString(afterCreatedAtMs), afterEntryKey, Integer.toString(limit)};
            try (Cursor c = db.rawQuery(sql, args)) {
                while (c.moveToNext()) {
                    JSONObject row = new JSONObject();
                    row.put("trip_id", c.getString(0));
                    row.put("cursor", c.getLong(1) + "|" + c.getString(2));
                    rows.put(row);
                }
            }
        }
        JSONObject out = new JSONObject();
        out.put("rows", rows);
        // AUD-005: the caller must know the cap this query actually applied. It asks for
        // `limit + 1` to detect more work, but this query clamps to 8, so comparing the
        // row count with the REQUESTED size reported "nothing more" whenever the caller
        // wanted more than eight - which is exactly the emergency-acknowledgement budget.
        out.put("limit", limit);
        return out;
    }

    /** AUD-005 restart discovery: the authoritative answer, in three states. */
    static final int EMERGENCY_NONE = 0;
    static final int EMERGENCY_PENDING = 1;
    static final int EMERGENCY_UNKNOWN = -1;

    /**
     * Does unresolved emergency workflow still exist, according to the DURABLE journal?
     *
     * AUD-005. Startup discovery used to consult preferences only, so the very failure
     * that put the continuation at risk — a `commit()` that returned false or threw —
     * also erased the only record that work existed. A process death straight afterwards
     * turned unresolved work into silence.
     *
     * The journal is the authority; preferences stay an acceleration hint. This is one
     * indexed row lookup with `LIMIT 1`, so it costs the same whether the journal holds
     * one entry or a hundred thousand — no scan, no listing, nothing history-proportional.
     *
     * @return EMERGENCY_PENDING, EMERGENCY_NONE, or EMERGENCY_UNKNOWN. UNKNOWN is not
     *         "no": a caller must retain and retry on it.
     */
    static int emergencyWorkflowState(Context context) {
        if (!enabled(context)) return EMERGENCY_UNKNOWN;
        try {
            ensureProbed(context);
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getReadableDatabase();
                try (Cursor state = db.rawQuery("SELECT state FROM journal_summary WHERE id=1", null)) {
                    // A dirty index cannot answer authoritatively, and guessing "none"
                    // here is exactly the silence this correction exists to remove.
                    if (!state.moveToFirst() || !"VERIFIED".equals(state.getString(0))) return EMERGENCY_UNKNOWN;
                }
                try (Cursor c = db.rawQuery(
                    "SELECT emergency_pending FROM journal_manifest_index WHERE emergency_pending<>0 LIMIT 1", null)) {
                    if (!c.moveToFirst()) return EMERGENCY_NONE;
                    return c.getInt(0) == 1 ? EMERGENCY_PENDING : EMERGENCY_UNKNOWN;
                }
            }
        } catch (Exception error) {
            android.util.Log.w("JournalControlPlane", "Could not determine durable emergency workflow state", error);
            return EMERGENCY_UNKNOWN;
        }
    }

    /** Explicit, fixed-memory pre-P5 compatibility operation. Never lifecycle-admitted. */
    static JSONObject bootstrap(Context context) throws Exception {
        if (!enabled(context)) throw new IllegalStateException("P5_IMPLEMENTATION_NOT_ENABLED");
        synchronized (DriveSenseCompletedTripJournal.LOCK) {
            BOOTSTRAP_CANCEL_REQUESTED.set(false);
            ensureProbed(context);
            final String attempt = UUID.randomUUID().toString();
            final long[] counters = new long[3];
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                db.execSQL("UPDATE journal_bootstrap_state SET state='BOOTSTRAP_REQUIRED',attempt_id=?,examined=0,files_seen=0,encoded_bytes=0,updated_at_ms=? WHERE id=1", new Object[]{attempt, System.currentTimeMillis()});
                db.execSQL("UPDATE journal_summary SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
            }
            File directory = DriveSenseCompletedTripJournal.directory(context);
            boolean eof = DriveSenseDirectoryStream.visit(directory,
                path -> !BOOTSTRAP_CANCEL_REQUESTED.get(), path -> {
                counters[1]++;
                if (Files.isRegularFile(path) && path.getFileName().toString().endsWith(MANIFEST_SUFFIX)) {
                    String key = keyFromManifestName(path.getFileName().toString());
                    File file = path.toFile();
                    JSONObject manifest = DriveSenseCompletedTripJournal.readManifest(file, key);
                    try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                        SQLiteDatabase db = helper.getWritableDatabase();
                        db.beginTransaction();
                        try {
                            db.delete("journal_manifest_index", "entry_key=?", new String[]{key});
                            if (manifest == null) insertUnreadable(db, key, Math.max(0L, file.length()), attempt);
                            else recordManifest(context, db, directory, key, manifest, attempt);
                            db.setTransactionSuccessful();
                        } finally { db.endTransaction(); }
                    }
                    counters[0]++;
                } else if (Files.isRegularFile(path)) {
                    String relative = validateRelative(directory, path.toFile());
                    String key = keyFromAnyName(path.getFileName().toString());
                    try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                        upsertFile(helper.getWritableDatabase(), relative, key, "RESIDUE", null, null,
                            Math.max(0L, Files.size(path)), "DISCOVERED", attempt);
                    }
                }
                counters[2] += Files.isRegularFile(path) ? Math.max(0L, Files.size(path)) : 0L;
                return !BOOTSTRAP_CANCEL_REQUESTED.get();
            });
            if (!eof) {
                markBootstrapRequiredAfterCancellation(context);
                throw new IllegalStateException("JOURNAL_BOOTSTRAP_CANCELLED");
            }
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                db.beginTransaction();
                try {
                    db.delete("journal_manifest_index", "bootstrap_attempt_id IS NULL OR bootstrap_attempt_id<>?", new String[]{attempt});
                    db.delete("journal_file_registry", "attempt_id IS NOT NULL AND attempt_id<>?", new String[]{attempt});
                    long now = System.currentTimeMillis();
                    db.execSQL("UPDATE journal_bootstrap_state SET state='COMPLETE',attempt_id=NULL,examined=?,files_seen=?,encoded_bytes=?,updated_at_ms=? WHERE id=1", new Object[]{counters[0], counters[1], counters[2], now});
                    publishSummary(db, hasLegacyPreference(context) ? "PRESENT" : "ABSENT", true);
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
            }
            JSONObject out = new JSONObject();
            out.put("state", "COMPLETE"); out.put("itemsWorked", counters[0]);
            out.put("filesWorked", counters[1]); out.put("bytesWorked", counters[2]);
            out.put("hasMore", false);
            return out;
        }
    }

    static JSONObject cancelBootstrap() throws Exception {
        BOOTSTRAP_CANCEL_REQUESTED.set(true);
        JSONObject out = new JSONObject();
        out.put("cancelRequested", true);
        out.put("state", "CANCEL_REQUESTED");
        return out;
    }

    private static void markBootstrapRequiredAfterCancellation(Context context) {
        try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
            SQLiteDatabase db = helper.getWritableDatabase();
            long now = System.currentTimeMillis();
            db.beginTransaction();
            try {
                db.execSQL("UPDATE journal_bootstrap_state SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{now});
                db.execSQL("UPDATE journal_summary SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{now});
                db.execSQL("UPDATE p5_control_state SET journal_state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{now});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
        } catch (Exception ignored) {
            // The per-entry manifests remain authoritative and the previous
            // BOOTSTRAP_REQUIRED state is already fail-closed.
        }
    }

    /** Bounded steady-state repair over registry-described manifests only. */
    static JSONObject reconcile(Context context) throws Exception {
        if (!enabled(context)) throw new IllegalStateException("P5_IMPLEMENTATION_NOT_ENABLED");
        synchronized (DriveSenseCompletedTripJournal.LOCK) {
            ensureProbed(context);
            try (DriveSenseArchiveOpenHelper helper = new DriveSenseArchiveOpenHelper(context)) {
                SQLiteDatabase db = helper.getWritableDatabase();
                String bootstrap;
                try (Cursor c = db.rawQuery("SELECT state FROM journal_bootstrap_state WHERE id=1", null)) {
                    bootstrap = c.moveToFirst() ? c.getString(0) : "BOOTSTRAP_REQUIRED";
                }
                if (!"COMPLETE".equals(bootstrap)) return deferredBootstrap();
                String state; String cursor; String entryKey; int fileOrdinal;
                try (Cursor c = db.rawQuery("SELECT state,cursor,entry_key,file_ordinal FROM journal_repair_state WHERE id=1", null)) {
                    if (!c.moveToFirst()) throw new IllegalStateException("JOURNAL_REPAIR_STATE_MISSING");
                    state = c.getString(0); cursor = c.getString(1);entryKey=c.getString(2);fileOrdinal=c.getInt(3);
                }
                if (!"REPAIRING".equals(state)) {
                    cursor = "";entryKey="";fileOrdinal=-1;
                    db.execSQL("UPDATE journal_repair_state SET state='REPAIRING',cursor='',entry_key='',file_ordinal=-1,examined=0,updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
                }
                int examined = 0; long bytes = 0L;
                File directory = DriveSenseCompletedTripJournal.directory(context);
                while(examined<MAX_EXAMINED){
                    JSONObject manifest=null;File manifestFile;
                    if(entryKey.isEmpty()){
                        try(Cursor c=db.rawQuery("SELECT entry_key FROM journal_manifest_index WHERE entry_key>? ORDER BY entry_key LIMIT 1",new String[]{cursor})){if(!c.moveToFirst())break;entryKey=c.getString(0);}
                        manifestFile=DriveSenseCompletedTripJournal.manifestFile(directory,entryKey);long manifestLength=Math.max(0L,manifestFile.length());
                        if(examined>0&&manifestLength<=MAX_MANIFEST_BYTES&&bytes+manifestLength>MAX_MANIFEST_BYTES)break;
                        boolean oversize=manifestLength>MAX_MANIFEST_BYTES;
                        if(!oversize)manifest=DriveSenseCompletedTripJournal.readManifest(manifestFile,entryKey);
                        db.beginTransaction();try{
                            EntryStats before=entryStats(db,entryKey);removeRegistryEntry(db,entryKey);
                            // A missing authoritative manifest is a completed ACK or an
                            // unpublished mutation intent, not corrupt journal intake.
                            if(manifest==null){if(manifestFile.exists())insertUnreadable(db,entryKey,manifestLength,null);}else recordManifestHeader(context,db,directory,entryKey,manifest,null);
                            applyRepairSummaryDelta(db,before,entryStats(db,entryKey));
                            int first=manifest!=null&&manifest.optInt("version",0)==2?-1:0;
                            boolean complete=manifest==null||(manifest.optInt("version",0)==1&&manifest.optInt("chunk_count",0)==0);
                            if(complete){cursor=entryKey;entryKey="";fileOrdinal=-1;}else fileOrdinal=first;
                            db.execSQL("UPDATE journal_repair_state SET cursor=?,entry_key=?,file_ordinal=?,updated_at_ms=? WHERE id=1",new Object[]{cursor,entryKey,fileOrdinal,System.currentTimeMillis()});
                            db.setTransactionSuccessful();
                        }finally{db.endTransaction();}
                        examined++;bytes+=oversize?8L:manifestLength;
                        if(entryKey.isEmpty())continue;
                    }
                    manifestFile=DriveSenseCompletedTripJournal.manifestFile(directory,entryKey);
                    manifest=DriveSenseCompletedTripJournal.readManifest(manifestFile,entryKey);
                    if(manifest==null){
                        db.beginTransaction();try{EntryStats before=entryStats(db,entryKey);removeRegistryEntry(db,entryKey);if(manifestFile.exists())insertUnreadable(db,entryKey,Math.max(0L,manifestFile.length()),null);applyRepairSummaryDelta(db,before,entryStats(db,entryKey));cursor=entryKey;entryKey="";fileOrdinal=-1;db.execSQL("UPDATE journal_repair_state SET cursor=?,entry_key='',file_ordinal=-1,updated_at_ms=? WHERE id=1",new Object[]{cursor,System.currentTimeMillis()});db.setTransactionSuccessful();}finally{db.endTransaction();}examined++;continue;
                    }
                    int version=manifest.optInt("version",0),count=Math.max(0,manifest.optInt("chunk_count",0));
                    db.beginTransaction();try{
                        EntryStats before=entryStats(db,entryKey);
                        while(examined<MAX_EXAMINED){
                            if(version==1&&fileOrdinal>=count)break;
                            if(version==2&&fileOrdinal>=count)break;
                            recordManifestFile(context,db,directory,entryKey,manifest,fileOrdinal,null);examined++;bytes+=8L;fileOrdinal++;
                        }
                        refreshEntryBytes(db,entryKey,System.currentTimeMillis());applyRepairSummaryDelta(db,before,entryStats(db,entryKey));
                        boolean complete=fileOrdinal>=count;
                        if(complete){cursor=entryKey;entryKey="";fileOrdinal=-1;}
                        db.execSQL("UPDATE journal_repair_state SET cursor=?,entry_key=?,file_ordinal=?,updated_at_ms=? WHERE id=1",new Object[]{cursor,entryKey,fileOrdinal,System.currentTimeMillis()});
                        db.setTransactionSuccessful();
                    }finally{db.endTransaction();}
                }
                boolean more;
                if(!entryKey.isEmpty())more=true;else try (Cursor c = db.rawQuery("SELECT 1 FROM journal_manifest_index WHERE entry_key>? LIMIT 1", new String[]{cursor})) { more = c.moveToFirst(); }
                if (more) {
                    db.execSQL("UPDATE journal_repair_state SET examined=examined+?,updated_at_ms=? WHERE id=1", new Object[]{examined, System.currentTimeMillis()});
                } else {
                    db.beginTransaction();
                    try {
                        finalizeIncrementalRepair(db, context, examined);
                        db.setTransactionSuccessful();
                    } finally { db.endTransaction(); }
                }
                JSONObject out = new JSONObject();
                out.put("state", more ? "MORE" : "COMPLETE"); out.put("itemsWorked", examined);
                out.put("changedItems", examined); out.put("bytesWorked", Math.min(MAX_WORK_BYTES, bytes));
                out.put("hasMore", more);
                try (Cursor summary = db.rawQuery("SELECT state FROM journal_summary WHERE id=1", null)) {
                    out.put("summaryState", summary.moveToFirst() ? summary.getString(0) : "UNKNOWN");
                }
                return out;
            }
        }
    }

    private static JSONObject deferredBootstrap() throws Exception {
        JSONObject out = new JSONObject(); out.put("state", "BOOTSTRAP_REQUIRED");
        out.put("itemsWorked", 0); out.put("changedItems", 0); out.put("bytesWorked", 0);
        out.put("hasMore", false); out.put("deferred", true); return out;
    }

    private static void recordManifest(Context context, SQLiteDatabase db, File directory, String key,
                                       JSONObject manifest, String attempt) throws Exception {
        recordManifestHeader(context,db,directory,key,manifest,attempt);
        int version=manifest.optInt("version",0),count=manifest.optInt("chunk_count",0);
        if(version==2)recordManifestFile(context,db,directory,key,manifest,-1,attempt);
        for(int index=0;index<count;index++)recordManifestFile(context,db,directory,key,manifest,index,attempt);
        refreshEntryBytes(db,key,System.currentTimeMillis());
    }

    private static void recordManifestHeader(Context context,SQLiteDatabase db,File directory,String key,
                                             JSONObject manifest,String attempt)throws Exception{
        long now = System.currentTimeMillis();
        int version = manifest.optInt("version", 0);
        String source = version == 2 ? "RSAS_V1" : "JOURNAL_V1";
        String generation = version == 1 ? manifest.optString("generation", "") : null;
        String session = version == 2 ? manifest.optString("rsas_session_id", "") : null;
        int count = manifest.optInt("chunk_count", 0);
        long manifestBytes = Math.max(0L, DriveSenseCompletedTripJournal.manifestFile(directory, key).length());
        ContentValues row = new ContentValues();
        row.put("entry_key", key); row.put("trip_id", manifest.optString("trip_id", ""));
        row.put("created_at_ms", manifest.optLong("created_at_ms", 0));
        row.put("updated_at_ms", manifest.optLong("updated_at_ms", 0));
        row.put("encrypted_bytes", 0); row.put("largest_file_bytes", 0);
        int fileKek=journalKeyVersion(context,directory,manifest);
        if (fileKek>0) row.put("kek_version",fileKek);
        row.put("readable", 1); row.put("manifest_bytes", manifestBytes);
        // AUD-005: -1 (UNKNOWN) when the manifest predates the field, so a legacy entry is
        // never mistaken for one with no outstanding emergency work.
        row.put("emergency_pending", manifest.has("emergency_pending")
            ? (manifest.optInt("emergency_pending", 0) != 0 ? 1 : 0) : -1);
        row.put("source_format", source); if (generation != null) row.put("generation", generation);
        if (session != null) row.put("rsas_session_id", session); row.put("chunk_count", count);
        row.put("mutation_version", attempt == null ? 0 : attemptVersionLong(attempt));
        if (attempt != null) row.put("bootstrap_attempt_id", attempt); else row.putNull("bootstrap_attempt_id");
        db.insertWithOnConflict("journal_manifest_index", null, row, SQLiteDatabase.CONFLICT_REPLACE);
        upsertFile(db, validateRelative(directory, DriveSenseCompletedTripJournal.manifestFile(directory, key)),
            key, "MANIFEST", generation, null, manifestBytes, "PRESENT", attempt);
    }

    private static long recordManifestFile(Context context,SQLiteDatabase db,File directory,String key,JSONObject manifest,
                                           int ordinal,String attempt)throws Exception{
        int version=manifest.optInt("version",0);File file,physicalFile;String kind,generation=null;
        if(version==1){generation=manifest.optString("generation","");file=new File(directory,key+"."+generation+"."+ordinal+CHUNK_SUFFIX);kind="CHUNK";}
        else{String session=manifest.optString("rsas_session_id","");File sessionDirectory=new File(new File(directory,"rsas_v1"),session);if(ordinal<0){file=new File(sessionDirectory,"manifest.enc");kind="RSAS_MANIFEST";}else{file=new File(sessionDirectory,String.format(Locale.US,"%08d.rstc",ordinal));kind="RSAS_SEGMENT";}}
        physicalFile=file;
        if(version==2){String session=manifest.optString("rsas_session_id","");File physicalDirectory=DriveSenseActiveTripSpool.locateJournalSession(context,directory,session);physicalFile=ordinal<0?new File(physicalDirectory,"manifest.enc"):new File(physicalDirectory,String.format(Locale.US,"%08d.rstc",ordinal));}
        long size=Math.max(0L,physicalFile.length());upsertFile(db,validateRelative(directory,file),key,kind,generation,ordinal<0?null:ordinal,size,physicalFile.isFile()?"PRESENT":"MISSING",attempt);return size;
    }

    private static void insertUnreadable(SQLiteDatabase db, String key, long bytes, String attempt) {
        ContentValues row = new ContentValues(); row.put("entry_key", key); row.put("trip_id", "");
        row.put("created_at_ms", 0); row.put("updated_at_ms", 0); row.put("encrypted_bytes", bytes);
        row.put("largest_file_bytes", bytes); row.put("readable", 0); row.put("manifest_bytes", bytes);
        row.put("chunk_count", 0); row.put("mutation_version", attempt == null ? 0 : attemptVersionLong(attempt));
        if (attempt != null) row.put("bootstrap_attempt_id", attempt); else row.putNull("bootstrap_attempt_id");
        db.insertWithOnConflict("journal_manifest_index", null, row, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static void upsertFile(SQLiteDatabase db, String relative, String key, String kind,
                                   String generation, Integer ordinal, long bytes, String state,
                                   String attempt) {
        ContentValues row = new ContentValues(); row.put("relative_path", relative); row.put("entry_key", key);
        row.put("file_kind", kind); if (generation != null) row.put("generation", generation);
        if (ordinal != null) row.put("ordinal", ordinal); row.put("encoded_bytes", Math.max(0L, bytes));
        row.put("state", state); if (attempt != null) row.put("attempt_id", attempt); else row.putNull("attempt_id");
        row.put("updated_at_ms", System.currentTimeMillis());
        db.insertWithOnConflict("journal_file_registry", null, row, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static void removeRegistryEntry(SQLiteDatabase db, String key) {
        db.delete("journal_file_registry", "entry_key=?", new String[]{key});
        db.delete("journal_manifest_index", "entry_key=?", new String[]{key});
    }

    private static void refreshEntryBytes(SQLiteDatabase db, String key, long now) {
        db.execSQL("UPDATE journal_manifest_index SET encrypted_bytes=COALESCE((SELECT SUM(encoded_bytes) FROM journal_file_registry WHERE entry_key=? AND state<>'REMOVED'),0),largest_file_bytes=COALESCE((SELECT MAX(encoded_bytes) FROM journal_file_registry WHERE entry_key=? AND state<>'REMOVED'),0),updated_at_ms=MAX(updated_at_ms,?) WHERE entry_key=?",
            new Object[]{key, key, now, key});
    }

    private static void publishIfComplete(SQLiteDatabase db, Context context) {
        String bootstrap = "BOOTSTRAP_REQUIRED";
        try (Cursor c = db.rawQuery("SELECT state FROM journal_bootstrap_state WHERE id=1", null)) { if (c.moveToFirst()) bootstrap = c.getString(0); }
        if ("COMPLETE".equals(bootstrap)) publishSummary(db, hasLegacyPreference(context) ? "PRESENT" : "ABSENT", true);
        else db.execSQL("UPDATE journal_summary SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
    }

    private static EntryStats entryStats(SQLiteDatabase db,String key){
        long readable=0,unreadable=0,bytes=0;
        try(Cursor c=db.rawQuery("SELECT readable FROM journal_manifest_index WHERE entry_key=?",new String[]{key})){if(c.moveToFirst()){int state=c.getInt(0);if(state==1)readable=1;else if(state==0)unreadable=1;}}
        try(Cursor c=db.rawQuery("SELECT COALESCE(SUM(encoded_bytes),0),COALESCE(SUM(CASE WHEN state='MISSING' THEN 1 ELSE 0 END),0) FROM journal_file_registry WHERE entry_key=? AND state<>'REMOVED'",new String[]{key})){if(c.moveToFirst()){bytes=c.getLong(0);unreadable+=c.getLong(1);}}
        return new EntryStats(readable,unreadable,bytes);
    }

    private static void applyMutationSummary(SQLiteDatabase db,Context context,String key,EntryStats before,EntryStats after){
        String bootstrap="BOOTSTRAP_REQUIRED";try(Cursor c=db.rawQuery("SELECT state FROM journal_bootstrap_state WHERE id=1",null)){if(c.moveToFirst())bootstrap=c.getString(0);}if(!"COMPLETE".equals(bootstrap)){db.execSQL("UPDATE journal_summary SET state='BOOTSTRAP_REQUIRED',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});return;}
        long now=System.currentTimeMillis();applySummaryDelta(db,before,after,now);
        ContentValues summary=summaryExtrema(db);
        String repairState="DIRTY",repairKey="";long unreadable=1;try(Cursor c=db.rawQuery("SELECT r.state,r.cursor,s.unreadable_count FROM journal_repair_state r JOIN journal_summary s ON s.id=1 WHERE r.id=1",null)){if(c.moveToFirst()){repairState=c.getString(0);repairKey=c.getString(1);unreadable=c.getLong(2);}}
        boolean legacy=hasLegacyPreference(context),clean="MUTATION_DIRTY".equals(repairState)&&key.equals(repairKey)&&!legacy&&unreadable==0;summary.put("state",clean?"VERIFIED":"DIRTY");db.update("journal_summary",summary,"id=1",null);if(clean)db.execSQL("UPDATE journal_repair_state SET state='CLEAN',cursor='',updated_at_ms=? WHERE id=1",new Object[]{now});db.execSQL("UPDATE p5_control_state SET journal_state=?,journal_legacy_presence=?,updated_at_ms=? WHERE id=1",new Object[]{clean?"VERIFIED":"DIRTY",legacy?"PRESENT":"ABSENT",now});
    }

    private static void applyRepairSummaryDelta(SQLiteDatabase db,EntryStats before,EntryStats after){
        long now=System.currentTimeMillis();applySummaryDelta(db,before,after,now);
        ContentValues summary=summaryExtrema(db);summary.put("state","DIRTY");summary.put("updated_at_ms",now);
        db.update("journal_summary",summary,"id=1",null);
        db.execSQL("UPDATE p5_control_state SET journal_state='DIRTY',updated_at_ms=? WHERE id=1",new Object[]{now});
    }

    private static void applySummaryDelta(SQLiteDatabase db,EntryStats before,EntryStats after,long now){
        db.execSQL("UPDATE journal_summary SET pending_count=MAX(0,pending_count+?),unreadable_count=MAX(0,unreadable_count+?),encrypted_bytes=MAX(0,encrypted_bytes+?),updated_at_ms=? WHERE id=1",new Object[]{after.readable-before.readable,after.unreadable-before.unreadable,after.bytes-before.bytes,now});
    }

    /** All three lookups use journal_manifest_* indexes and never enumerate J/F. */
    private static ContentValues summaryExtrema(SQLiteDatabase db){
        Long largest=nullableScalar(db,"SELECT largest_file_bytes FROM journal_manifest_index ORDER BY largest_file_bytes DESC,entry_key LIMIT 1");
        Long oldest=nullableScalar(db,"SELECT created_at_ms FROM journal_manifest_index WHERE readable=1 AND created_at_ms>0 ORDER BY created_at_ms,entry_key LIMIT 1");
        Long verified=nullableScalar(db,"SELECT updated_at_ms FROM journal_manifest_index WHERE readable=1 ORDER BY updated_at_ms DESC,entry_key LIMIT 1");
        ContentValues summary=new ContentValues();summary.put("largest_file_bytes",largest==null?0L:largest);
        if(oldest==null)summary.putNull("oldest_pending_at_ms");else summary.put("oldest_pending_at_ms",oldest);
        if(verified==null)summary.putNull("last_verified_save_at_ms");else summary.put("last_verified_save_at_ms",verified);
        return summary;
    }

    private static void finalizeIncrementalRepair(SQLiteDatabase db,Context context,int examined){
        long now=System.currentTimeMillis();String legacy=hasLegacyPreference(context)?"PRESENT":"ABSENT";
        long unreadable=scalar(db,"SELECT unreadable_count FROM journal_summary WHERE id=1");boolean verified=unreadable==0&&"ABSENT".equals(legacy);
        String generation=null;try(Cursor c=db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1",null)){if(c.moveToFirst())generation=c.getString(0);}
        ContentValues summary=summaryExtrema(db);summary.put("state",verified?"VERIFIED":"DIRTY");if(generation==null)summary.putNull("archive_generation");else summary.put("archive_generation",generation);summary.put("updated_at_ms",now);db.update("journal_summary",summary,"id=1",null);
        db.execSQL("UPDATE journal_repair_state SET state=?,cursor='',examined=examined+?,updated_at_ms=? WHERE id=1",new Object[]{verified?"CLEAN":"DIRTY",examined,now});
        db.execSQL("UPDATE p5_control_state SET journal_state=?,journal_legacy_presence=?,updated_at_ms=? WHERE id=1",new Object[]{verified?"VERIFIED":"DIRTY",legacy,now});
    }

    private static void publishSummary(SQLiteDatabase db, String legacyPresence, boolean cleanRepair) {
        long now = System.currentTimeMillis();
        long pending = scalar(db, "SELECT COUNT(*) FROM journal_manifest_index WHERE readable=1");
        long unreadable = scalar(db, "SELECT COUNT(*) FROM journal_manifest_index WHERE readable=0") + scalar(db, "SELECT COUNT(*) FROM journal_file_registry WHERE state='MISSING'");
        long bytes = scalar(db, "SELECT COALESCE(SUM(encoded_bytes),0) FROM journal_file_registry WHERE state<>'REMOVED'");
        long largest = scalar(db, "SELECT COALESCE(MAX(encoded_bytes),0) FROM journal_file_registry WHERE state<>'REMOVED'");
        Long oldest = nullableScalar(db, "SELECT MIN(created_at_ms) FROM journal_manifest_index WHERE readable=1 AND created_at_ms>0");
        Long verifiedAt = nullableScalar(db, "SELECT MAX(updated_at_ms) FROM journal_manifest_index WHERE readable=1");
        String generation = null;
        try (Cursor c = db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1", null)) { if (c.moveToFirst()) generation = c.getString(0); }
        boolean verified = unreadable == 0 && "ABSENT".equals(legacyPresence);
        ContentValues values = new ContentValues(); values.put("state", verified ? "VERIFIED" : "DIRTY");
        values.put("pending_count", pending); values.put("unreadable_count", unreadable);
        values.put("encrypted_bytes", bytes); values.put("largest_file_bytes", largest);
        if (oldest == null) values.putNull("oldest_pending_at_ms"); else values.put("oldest_pending_at_ms", oldest);
        if (verifiedAt == null) values.putNull("last_verified_save_at_ms"); else values.put("last_verified_save_at_ms", verifiedAt);
        if (generation == null) values.putNull("archive_generation"); else values.put("archive_generation", generation);
        values.put("updated_at_ms", now); db.update("journal_summary", values, "id=1", null);
        db.execSQL("UPDATE p5_control_state SET journal_state=?,journal_legacy_presence=?,updated_at_ms=? WHERE id=1", new Object[]{verified ? "VERIFIED" : "DIRTY", legacyPresence, now});
        if (cleanRepair) db.execSQL("UPDATE journal_repair_state SET state=?,cursor='',updated_at_ms=? WHERE id=1", new Object[]{verified ? "CLEAN" : "DIRTY", now});
    }

    private static long scalar(SQLiteDatabase db, String sql) {
        try (Cursor c = db.rawQuery(sql, null)) { return c.moveToFirst() ? c.getLong(0) : 0L; }
    }

    private static Long nullableScalar(SQLiteDatabase db, String sql) {
        try (Cursor c = db.rawQuery(sql, null)) { return c.moveToFirst() && !c.isNull(0) ? c.getLong(0) : null; }
    }

    private static boolean hasLegacyPreference(Context context) {
        return DriveSenseNativeTripStore.prefs(context).getString(DriveSenseNativeTripStore.KEY_COMPLETED_TRIPS, null) != null;
    }

    private static String validateRelative(File root, File file) throws Exception {
        String rootPath = root.getCanonicalPath(); String filePath = file.getCanonicalPath();
        if (!filePath.startsWith(rootPath + File.separator)) throw new SecurityException("JOURNAL_PATH_ESCAPE");
        String relative = root.toPath().toAbsolutePath().normalize().relativize(file.toPath().toAbsolutePath().normalize())
            .toString().replace(File.separatorChar, '/');
        if (relative.isEmpty() || relative.startsWith("/") || relative.contains("../") || relative.contains("\\")) throw new SecurityException("JOURNAL_PATH_INVALID");
        return relative;
    }

    private static String keyFromManifestName(String name) {
        String key = name.substring(0, name.length() - MANIFEST_SUFFIX.length());
        if (!key.matches("[0-9a-f]{32}")) throw new SecurityException("JOURNAL_ENTRY_KEY_INVALID"); return key;
    }

    private static String keyFromAnyName(String name) {
        int dot = name.indexOf('.'); String key = dot < 0 ? name : name.substring(0, dot);
        return key.matches("[0-9a-f]{32}") ? key : "__unowned__";
    }

    private static String stem(String tripId) throws Exception {
        return DriveSenseEnvelopeCrypto.hex(java.security.MessageDigest.getInstance("SHA-256")
            .digest(tripId.getBytes(java.nio.charset.StandardCharsets.UTF_8))).substring(0, 32);
    }

    private static long attemptVersionLong(String attempt) { return attempt.hashCode() & 0x7fffffffL; }

    private static int journalKeyVersion(Context context,File directory,JSONObject manifest){
        if(manifest==null||manifest.optInt("version",0)!=2)return manifest==null?-1:manifest.optInt("kek_version",-1);
        try{
            String session=manifest.optString("rsas_session_id","");
            File adopted=DriveSenseActiveTripSpool.locateJournalSession(context,directory,session);
            return DriveSenseActiveTripSpool.readManifestForStatus(context,adopted).optInt("kek_version",-1);
        }catch(Exception ignored){return -1;}
    }

    private static final class EntryStats{static final EntryStats ZERO=new EntryStats(0,0,0);final long readable,unreadable,bytes;EntryStats(long r,long u,long b){readable=r;unreadable=u;bytes=b;}}
}
