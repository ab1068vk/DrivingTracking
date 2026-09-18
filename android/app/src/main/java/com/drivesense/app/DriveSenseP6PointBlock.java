package com.drivesense.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * P6 public-point block codec, native half of {@code src/lib/p6PointBlockCodec.js}.
 *
 * The frozen §12.4 envelope {@code E(N,P,S) = 32 MiB + 24 KiB*N + 224 B*P + 512 B*S}
 * budgets 224 bytes per permitted public point for the point block, its spatial
 * posting, index overhead and encrypted framing together. Writing an array of
 * ten-named-field JSON objects spends more than that on property names alone,
 * and P6 stores each page twice: once as the D2 geometry chunk and once as the
 * shared D4 source spill. Blocks are therefore columnar - one array per field,
 * integer coordinates in 1e-7 degrees (about 1.1 cm, finer than any GPS fix this
 * app records), deltas for the monotonic columns, string dictionaries, and
 * all-null columns omitted entirely.
 *
 * The encoder is key-agnostic: it carries whatever field names the compacting
 * step produced, so the decoded objects are the same objects every existing
 * reducer, predicate and adapter already reads. A page written before this codec
 * is a plain {@code points} array and decodes unchanged.
 */
final class DriveSenseP6PointBlock {
    private static final double COORDINATE_SCALE = 1e7d;
    private static final int VERSION = 2;

    private DriveSenseP6PointBlock() {}

    private static boolean present(Object value) {
        return value != null && value != JSONObject.NULL;
    }

    private static boolean timeKey(String key) {
        return "timestamp".equals(key) || "timestampMs".equals(key) || "recorded_at".equals(key);
    }

    private static boolean scaledKey(String key) {
        return "lat".equals(key) || "lng".equals(key);
    }

    /** Encodes compacted points into the columnar block stored inside the envelope. */
    static JSONObject encode(JSONArray points) throws Exception {
        JSONArray rows = points == null ? new JSONArray() : points;
        JSONObject block = new JSONObject().put("v", VERSION).put("n", rows.length());
        if (rows.length() == 0) return block;
        LinkedHashSet<String> keys = new LinkedHashSet<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            for (java.util.Iterator<String> it = row.keys(); it.hasNext(); ) keys.add(it.next());
        }
        JSONObject columns = new JSONObject();
        for (String key : keys) {
            List<Object> values = new ArrayList<>(rows.length());
            boolean allNull = true, allNumber = true, allString = true;
            for (int index = 0; index < rows.length(); index++) {
                JSONObject row = rows.optJSONObject(index);
                Object value = row == null ? null : row.opt(key);
                if (!present(value)) { values.add(null); continue; }
                allNull = false;
                if (!(value instanceof Number)) allNumber = false;
                if (!(value instanceof String)) allString = false;
                values.add(value);
            }
            if (allNull) continue;
            if (allNumber && scaledKey(key)) {
                columns.put(key, new JSONObject().put("e", "sd").put("a", deltas(values, COORDINATE_SCALE)));
            } else if (allNumber && timeKey(key)) {
                columns.put(key, new JSONObject().put("e", "d").put("a", deltas(values, 1d)));
            } else if (allString) {
                columns.put(key, dictionary(values));
            } else {
                columns.put(key, raw(values));
            }
        }
        return block.put("c", columns);
    }

    /** Restores the exact point objects a block carries. */
    static JSONArray decode(Object value) throws Exception {
        if (value instanceof JSONArray) return (JSONArray) value;
        if (!(value instanceof JSONObject)) return new JSONArray();
        JSONObject block = (JSONObject) value;
        int count = Math.max(0, block.optInt("n", 0));
        JSONObject columns = block.optJSONObject("c");
        JSONArray out = new JSONArray();
        if (count == 0 || columns == null) return out;
        LinkedHashMap<String, Object[]> decoded = new LinkedHashMap<>();
        for (java.util.Iterator<String> it = columns.keys(); it.hasNext(); ) {
            String key = it.next();
            decoded.put(key, column(columns.opt(key), count, scaledKey(key) ? COORDINATE_SCALE : 1d));
        }
        for (int index = 0; index < count; index++) {
            JSONObject point = new JSONObject();
            for (LinkedHashMap.Entry<String, Object[]> entry : decoded.entrySet()) {
                Object item = entry.getValue()[index];
                if (item != null) point.put(entry.getKey(), item);
            }
            out.put(point);
        }
        return out;
    }

    /** Reads a stored page whichever way it was written. */
    static JSONArray pointsOf(JSONObject container) throws Exception {
        if (container == null) return new JSONArray();
        JSONArray legacy = container.optJSONArray("points");
        if (legacy != null) return legacy;
        return decode(container.opt("pointBlock"));
    }

    /** Wraps points for storage. */
    static JSONObject page(JSONArray points) throws Exception {
        return new JSONObject().put("pointBlock", encode(points));
    }

    private static JSONArray deltas(List<Object> values, double scale) throws Exception {
        JSONArray out = new JSONArray();
        long previous = 0L;
        for (Object value : values) {
            if (value == null) { out.put(JSONObject.NULL); continue; }
            long scaled = Math.round(((Number) value).doubleValue() * scale);
            out.put(scaled - previous);
            previous = scaled;
        }
        return out;
    }

    private static JSONArray raw(List<Object> values) throws Exception {
        JSONArray out = new JSONArray();
        for (Object value : values) out.put(value == null ? JSONObject.NULL : value);
        return out;
    }

    private static JSONObject dictionary(List<Object> values) throws Exception {
        List<String> terms = new ArrayList<>();
        JSONArray indexes = new JSONArray();
        for (Object value : values) {
            if (value == null) { indexes.put(-1); continue; }
            String text = (String) value;
            int position = terms.indexOf(text);
            if (position < 0) { position = terms.size(); terms.add(text); }
            indexes.put(position);
        }
        JSONArray dictionary = new JSONArray();
        for (String term : terms) dictionary.put(term);
        return new JSONObject().put("e", "s").put("d", dictionary).put("i", indexes);
    }

    private static Object[] column(Object encoded, int count, double scale) {
        Object[] out = new Object[count];
        if (encoded instanceof JSONArray) {
            JSONArray array = (JSONArray) encoded;
            for (int index = 0; index < count; index++) {
                Object value = array.opt(index);
                out[index] = present(value) ? value : null;
            }
            return out;
        }
        if (!(encoded instanceof JSONObject)) return out;
        JSONObject column = (JSONObject) encoded;
        String kind = column.optString("e", "");
        if ("s".equals(kind)) {
            JSONArray dictionary = column.optJSONArray("d");
            JSONArray indexes = column.optJSONArray("i");
            for (int index = 0; index < count; index++) {
                int position = indexes == null ? -1 : indexes.optInt(index, -1);
                out[index] = position < 0 || dictionary == null ? null : dictionary.opt(position);
            }
            return out;
        }
        JSONArray array = column.optJSONArray("a");
        long previous = 0L;
        for (int index = 0; index < count; index++) {
            Object value = array == null ? null : array.opt(index);
            if (!present(value) || !(value instanceof Number)) { out[index] = null; continue; }
            previous += ((Number) value).longValue();
            out[index] = "sd".equals(kind) ? (Object) (previous / scale) : (Object) previous;
        }
        return out;
    }
}
