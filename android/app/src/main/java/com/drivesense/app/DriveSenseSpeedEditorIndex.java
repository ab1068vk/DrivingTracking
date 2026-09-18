package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/** Exact identity-to-bucket index. It stores no saved-road payload or coordinates. */
final class DriveSenseSpeedEditorIndex {
    private DriveSenseSpeedEditorIndex() {}

    static byte[] identityHash(String kind, String identity) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(
            ("roadsage.speed.editor.id.v1\n" + kind + "\n" + identity)
                .getBytes(StandardCharsets.UTF_8));
    }

    static List<Entry> collect(String bucketId, JSONObject document) throws Exception {
        List<Entry> entries = new ArrayList<>();
        collectArray(entries, "correction", bucketId, document.optJSONArray("corrections"));
        collectArray(entries, "exclusion", bucketId, document.optJSONArray("excludedSections"));
        JSONObject memory = document.optJSONObject("roadMemory");
        collectArray(entries, "candidate", bucketId,
            memory == null ? null : memory.optJSONArray("candidates"));
        collectEvidence(entries,bucketId,memory==null?null:memory.optJSONArray("candidates"));
        JSONObject cells = document.optJSONObject("cells");
        JSONArray names = cells == null ? null : cells.names();
        for (int index = 0; names != null && index < names.length(); index++) {
            String geohash = names.optString(index, "");
            JSONObject cell = cells.optJSONObject(geohash);
            if (cell != null && cell.optBoolean("conflict", false)) {
                entries.add(new Entry("conflict", geohash, bucketId));
            }
        }
        return entries;
    }

    private static void collectEvidence(List<Entry> out,String bucketId,JSONArray candidates){
        for(int index=0;candidates!=null&&index<candidates.length();index++){
            JSONObject candidate=candidates.optJSONObject(index);JSONObject evidence=candidate==null?null:
                candidate.optJSONObject("p6AutomaticEvidence");JSONArray receipts=evidence==null?null:
                evidence.optJSONArray("receiptedEvidence");
            for(int r=0;receipts!=null&&r<receipts.length();r++){
                String identity=receipts.optJSONObject(r)==null?"":receipts.optJSONObject(r)
                    .optString("sourceIdentity","").trim();
                if(!identity.isEmpty())out.add(new Entry("evidence",identity,bucketId));
            }
        }
    }

    private static void collectArray(List<Entry> out, String kind, String bucketId,
                                     JSONArray values) {
        for (int index = 0; values != null && index < values.length(); index++) {
            JSONObject item = values.optJSONObject(index);
            for (String identity : stableIdentities(kind, item)) {
                out.add(new Entry(kind, identity, bucketId));
            }
        }
    }

    static String stableIdentity(String kind, JSONObject item) {
        List<String> values = stableIdentities(kind, item);
        return values.isEmpty() ? "" : values.get(0);
    }

    static List<String> stableIdentities(String kind, JSONObject item) {
        List<String> identities = new ArrayList<>();
        if (item == null) return identities;
        String[] keys = "exclusion".equals(kind)
            ? new String[]{"exclusionId", "exclusionKey", "id", "sectionKey", "geohash"}
            : "candidate".equals(kind)
                ? new String[]{"id", "candidateId", "sectionKey", "geohash"}
                : "evidence".equals(kind)
                    ? evidenceIdentities(item)
                : new String[]{"id", "ruleId", "correctionId", "sectionKey", "geohash"};
        for (String key : keys) {
            String value = item.optString(key, "").trim();
            if (!value.isEmpty() && !identities.contains(value)) identities.add(value);
        }
        return identities;
    }

    private static String[] evidenceIdentities(JSONObject item){
        List<String> values=new ArrayList<>();JSONObject evidence=item==null?null:item.optJSONObject("p6AutomaticEvidence");
        JSONArray receipts=evidence==null?null:evidence.optJSONArray("receiptedEvidence");
        for(int index=0;receipts!=null&&index<receipts.length();index++){
            JSONObject receipt=receipts.optJSONObject(index);String identity=receipt==null?"":receipt.optString("sourceIdentity","").trim();
            if(!identity.isEmpty()&&!values.contains(identity))values.add(identity);
        }
        return values.toArray(new String[0]);
    }

    static void replaceBucket(SQLiteDatabase db, String bucketId, String generation,
                              int revision, long updatedSeq, List<Entry> entries) throws Exception {
        // Canonical publication replaces only the formerly committed set. P6
        // stages for another operation/revision remain isolated and invisible.
        db.delete("speed_editor_index", "bucket_id=? AND commit_state='COMMITTED'",
            new String[]{bucketId});
        for (Entry entry : entries) {
            ContentValues row = new ContentValues();
            row.put("kind", entry.kind);
            row.put("item_id_hash", hex(identityHash(entry.kind, entry.identity)));
            row.put("bucket_id", bucketId);
            row.put("speed_generation", generation);
            row.put("revision", revision);
            row.put("updated_seq", updatedSeq);
            row.put("publication_version", revision);
            row.put("partition_ordinal", 0);
            row.put("commit_state", "COMMITTED");
            row.put("stage_operation_id", "");
            db.insertWithOnConflict("speed_editor_index", null, row, SQLiteDatabase.CONFLICT_REPLACE);
        }
    }

    static void stageBucket(SQLiteDatabase db, String operationId, String bucketId, String generation,
                            int revision, int publicationVersion, int partitionOrdinal,
                            long updatedSeq, List<Entry> entries) throws Exception {
        db.delete("speed_editor_index", "stage_operation_id=? AND bucket_id=? AND partition_ordinal=?",
            new String[]{operationId, bucketId, Integer.toString(partitionOrdinal)});
        for (Entry entry : entries) {
            ContentValues row = new ContentValues();
            row.put("kind", entry.kind);
            row.put("item_id_hash", hex(identityHash(entry.kind, entry.identity)));
            row.put("bucket_id", bucketId);
            row.put("speed_generation", generation);
            row.put("revision", revision);
            row.put("updated_seq", updatedSeq);
            row.put("publication_version", publicationVersion);
            row.put("partition_ordinal", partitionOrdinal);
            row.put("commit_state", "STAGED");
            row.put("stage_operation_id", operationId);
            db.insertOrThrow("speed_editor_index", null, row);
        }
    }

    static void obsoleteStage(SQLiteDatabase db, String operationId) {
        db.delete("speed_editor_index", "stage_operation_id=? AND commit_state='STAGED'",
            new String[]{operationId});
    }

    static String lookupBucket(SQLiteDatabase db, String generation, String kind,
                               String identity) throws Exception {
        try (Cursor cursor = db.rawQuery(
            "SELECT i.bucket_id FROM speed_editor_index i JOIN speed_current c "
                + "ON c.bucket_id=i.bucket_id AND c.speed_generation=i.speed_generation AND c.revision=i.revision "
                + "WHERE i.kind=? AND i.item_id_hash=? AND i.speed_generation=? "
                + "AND i.commit_state='COMMITTED' LIMIT 1",
            new String[]{kind, hex(identityHash(kind, identity)), generation})) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    private static String hex(byte[] value) {
        StringBuilder out = new StringBuilder(value.length * 2);
        for (byte item : value) out.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return out.toString();
    }

    static final class Entry {
        final String kind;
        final String identity;
        final String bucketId;
        Entry(String kind, String identity, String bucketId) {
            this.kind = kind;
            this.identity = identity;
            this.bucketId = bucketId;
        }
    }
}
