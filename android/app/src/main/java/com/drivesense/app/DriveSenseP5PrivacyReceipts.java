package com.drivesense.app;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

/** Existing native delivery-debt owner; point-addressable, no second receipt log. */
final class DriveSenseP5PrivacyReceipts {
    private static final String COLUMNS = "operation_id,event_type,reason_code,trip_count,point_count,motion_sample_count,created_at_ms,state";
    private DriveSenseP5PrivacyReceipts() {}

    private static final class Work {
        int items; long bytes;
        void probe() { items++; }
        void row(Cursor c) {
            for (int i = 0; i < c.getColumnCount(); i++) {
                if (c.isNull(i)) continue;
                bytes += 2L * (c.getType(i) == Cursor.FIELD_TYPE_STRING ? c.getString(i).getBytes(StandardCharsets.UTF_8).length : 8);
            }
        }
        JSONObject finish(JSONObject value) throws Exception {
            return value.put("itemsWorked", items).put("bytesWorked", bytes);
        }
    }

    private static JSONObject receipt(Cursor c) throws Exception {
        if (!"PENDING".equals(c.getString(7))) throw new IllegalStateException("PRIVACY_RECEIPT_STATE_INVALID");
        return new JSONObject().put("operationId", c.getString(0)).put("eventType", c.getString(1))
                .put("reason", c.getString(2)).put("tripCount", c.getLong(3)).put("pointCount", c.getLong(4))
                .put("motionSampleCount", c.getLong(5)).put("createdAtMs", c.getLong(6));
    }

    static JSONObject pending(DriveSenseStorageCoordinator coordinator) throws Exception {
        Work work = new Work(); JSONObject out = new JSONObject(); JSONArray receipts = new JSONArray();
        try {
            coordinator.read(db -> {
                work.probe();
                // ACK deletes rows: inspect the first primary-key row and validate
                // state, never scan an unindexed created_at or filtered prefix.
                try (Cursor c = db.rawQuery("SELECT " + COLUMNS + " FROM privacy_receipt_debt ORDER BY operation_id LIMIT 1", null)) {
                    if (c.moveToFirst()) { work.row(c); receipts.put(receipt(c)); }
                }
                return null;
            });
            out.put("state", "READY").put("receipts", receipts).put("itemCount", receipts.length())
                    .put("privacyReceiptPending", receipts.length() != 0);
        } catch (Exception error) { out.put("state", "PRIVACY_RECEIPT_FAILED").put("error", error.getMessage()); }
        return work.finish(out);
    }

    private static boolean exists(SQLiteDatabase db, Work work) {
        work.probe();
        try (Cursor c = db.rawQuery("SELECT operation_id,state FROM privacy_receipt_debt ORDER BY operation_id LIMIT 1", null)) {
            if (!c.moveToFirst()) return false;
            work.row(c);
            if (!"PENDING".equals(c.getString(1))) throw new IllegalStateException("PRIVACY_RECEIPT_STATE_INVALID");
            return true;
        }
    }

    static JSONObject acknowledge(DriveSenseStorageCoordinator coordinator, String operationId) throws Exception {
        Work work = new Work(); JSONObject out = new JSONObject().put("operationId", operationId);
        if (operationId == null || !operationId.matches("[A-Za-z0-9-]{1,64}"))
            return work.finish(out.put("state", "PRIVACY_RECEIPT_FAILED").put("error", "Invalid receipt operation"));
        try {
            coordinator.write(db -> {
                db.beginTransaction();
                try {
                    work.probe(); boolean present;
                    try (Cursor c = db.rawQuery("SELECT " + COLUMNS + " FROM privacy_receipt_debt WHERE operation_id=?", new String[]{operationId})) {
                        present = c.moveToFirst();
                        if (present) { work.row(c); receipt(c); }
                    }
                    if (present) {
                        // Delete predicate bytes; row material is counted above.
                        work.bytes += operationId.getBytes(StandardCharsets.UTF_8).length;
                        db.delete("privacy_receipt_debt", "operation_id=?", new String[]{operationId});
                    }
                    boolean more = exists(db, work);
                    out.put("state", "READY").put("acknowledged", present).put("removed", present)
                            .put("hasMore", more).put("privacyReceiptPending", more);
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                return null;
            });
        } catch (Exception error) {
            out.put("state", "PRIVACY_RECEIPT_FAILED").put("acknowledged", false).put("error", error.getMessage());
        }
        return work.finish(out);
    }
}
