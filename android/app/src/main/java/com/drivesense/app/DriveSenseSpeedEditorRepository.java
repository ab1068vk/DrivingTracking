package com.drivesense.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * Bounded read surface for saved-road editor data.
 *
 * Bucket payloads remain the encrypted authority.  One request decrypts at most
 * MAX_SCANNED_BUCKETS structurally-bounded prefix-4 buckets and never builds a
 * complete speed model or bucket collection.
 */
final class DriveSenseSpeedEditorRepository {
    static final int MAX_ITEMS = 100;
    static final int MAX_BYTES = 256 * 1024;
    static final int MAX_SCANNED_BUCKETS = 8;

    private final DriveSenseSpeedArchiveRepository speed;
    private final DriveSenseArchiveCursorCodec cursors;

    DriveSenseSpeedEditorRepository(Context context, DriveSenseSpeedArchiveRepository speed) throws Exception {
        this.speed = speed;
        this.cursors = new DriveSenseArchiveCursorCodec(context);
    }

    JSONObject getExact(JSONObject request) throws Exception {
        String requestedKind = kind(request.optString("kind", ""));
        String identity = request.optString("id", "").trim();
        if (identity.isEmpty() || identity.length() > 256) {
            throw new IllegalArgumentException("SPEED_EDITOR_ID_INVALID");
        }
        JSONObject state = speed.state();
        String generation = state.getString("speedGeneration");
        String bucketId = speed.coordinator().read(db ->
            DriveSenseSpeedEditorIndex.lookupBucket(db, generation, requestedKind, identity));
        JSONObject result = new JSONObject();
        result.put("speedGeneration", generation);
        result.put("bounded", true);
        result.put("indexed", true);
        if (bucketId == null) {
            result.put("item", JSONObject.NULL);
            return result;
        }
        JSONObject document = speed.readBucketJson(bucketId);
        JSONObject match = findInBucket(document, requestedKind, identity);
        if (match == null) {
            // An index/payload disagreement is canonical damage, not a normal
            // not-found result and must fail closed before any mutation.
            throw new IllegalStateException("SPEED_EDITOR_INDEX_DIVERGENCE");
        }
        match.put("_bucketId", bucketId);
        result.put("item", match);
        return result;
    }

    JSONObject query(JSONObject request) throws Exception {
        String kind = kind(request.optString("kind", ""));
        int maxItems = Math.max(1, Math.min(MAX_ITEMS, request.optInt("maxItems", 50)));
        int maxBytes = Math.max(1024, Math.min(MAX_BYTES, request.optInt("maxBytes", 128 * 1024)));
        String filter = request.optString("filter", "").trim().toLowerCase(Locale.ROOT);
        if (filter.length() > 96) throw new IllegalArgumentException("SPEED_EDITOR_FILTER_TOO_LARGE");
        boolean activeOnly = request.optBoolean("activeOnly", false);

        JSONObject state = speed.state();
        String generation = state.getString("speedGeneration");
        String queryHash = hash(kind + "\n" + filter + "\n" + activeOnly);
        String afterBucket = "";
        String currentBucket = "";
        int offset = 0;
        JSONObject decoded = cursors.decode(request.optString("cursor", ""));
        if (decoded != null) {
            if (!generation.equals(decoded.optString("generation")) ||
                !kind.equals(decoded.optString("kind")) ||
                !queryHash.equals(decoded.optString("queryHash"))) {
                throw new IllegalStateException("SPEED_EDITOR_CURSOR_STALE");
            }
            afterBucket = decoded.optString("afterBucket", "");
            currentBucket = decoded.optString("currentBucket", "");
            offset = Math.max(0, decoded.optInt("offset", 0));
        }

        JSONArray out = new JSONArray();
        int encodedBytes = 2;
        int scanned = 0;
        String lastCompletedBucket = afterBucket;
        String nextCurrentBucket = "";
        int nextOffset = 0;
        boolean more = false;

        if (!currentBucket.isEmpty()) {
            PageSlice slice = appendBucket(kind, currentBucket, offset, filter, activeOnly, out, maxItems, maxBytes, encodedBytes);
            encodedBytes = slice.encodedBytes;
            scanned += 1;
            if (!slice.complete) {
                nextCurrentBucket = currentBucket;
                nextOffset = slice.nextOffset;
                more = true;
            } else {
                lastCompletedBucket = currentBucket;
            }
        }

        while (!more && out.length() < maxItems && scanned < MAX_SCANNED_BUCKETS) {
            JSONArray buckets = speed.page(lastCompletedBucket, 1).optJSONArray("items");
            if (buckets == null || buckets.length() == 0) break;
            String bucketId = buckets.getJSONObject(0).getString("bucketId");
            PageSlice slice = appendBucket(kind, bucketId, 0, filter, activeOnly,
                out, maxItems, maxBytes, encodedBytes);
            encodedBytes = slice.encodedBytes;
            scanned += 1;
            if (!slice.complete) {
                nextCurrentBucket = bucketId;
                nextOffset = slice.nextOffset;
                more = true;
            } else {
                lastCompletedBucket = bucketId;
                if (out.length() >= maxItems) more = hasBucketAfter(lastCompletedBucket);
            }
        }
        if (!more && scanned >= MAX_SCANNED_BUCKETS) more = hasBucketAfter(lastCompletedBucket);

        String nextCursor = null;
        if (more) {
            JSONObject token = new JSONObject();
            token.put("generation", generation);
            token.put("kind", kind);
            token.put("queryHash", queryHash);
            token.put("afterBucket", nextCurrentBucket.isEmpty() ? lastCompletedBucket : "");
            token.put("currentBucket", nextCurrentBucket);
            token.put("offset", nextOffset);
            nextCursor = cursors.encode(token);
        }

        JSONObject result = new JSONObject();
        result.put("items", out);
        result.put("itemCount", out.length());
        result.put("encodedItemBytes", encodedBytes);
        result.put("scannedBucketCount", scanned);
        result.put("speedGeneration", generation);
        result.put("nextCursor", nextCursor == null ? JSONObject.NULL : nextCursor);
        result.put("bounded", true);
        return result;
    }

    private PageSlice appendBucket(String kind, String bucketId, int offset, String filter,
                                   boolean activeOnly, JSONArray output, int maxItems,
                                   int maxBytes, int encodedBytes) throws Exception {
        JSONObject document = speed.readBucketJson(bucketId);
        if (document == null) return new PageSlice(true, 0, encodedBytes);
        List<JSONObject> items = items(document, kind, bucketId, filter, activeOnly);
        int index = Math.min(offset, items.size());
        while (index < items.size() && output.length() < maxItems) {
            JSONObject item = items.get(index);
            int bytes = item.toString().getBytes(StandardCharsets.UTF_8).length + (output.length() == 0 ? 0 : 1);
            if (bytes > maxBytes) throw new IllegalStateException("SPEED_EDITOR_ITEM_TOO_LARGE");
            if (encodedBytes + bytes > maxBytes) return new PageSlice(false, index, encodedBytes);
            output.put(item);
            encodedBytes += bytes;
            index += 1;
        }
        return new PageSlice(index >= items.size(), index, encodedBytes);
    }

    private List<JSONObject> items(JSONObject document, String kind, String bucketId,
                                   String filter, boolean activeOnly) throws Exception {
        List<JSONObject> result = new ArrayList<>();
        if ("conflict".equals(kind)) {
            JSONObject cells = document.optJSONObject("cells");
            if (cells != null) {
                JSONArray names = cells.names();
                for (int index = 0; names != null && index < names.length(); index++) {
                    String geohash = names.getString(index);
                    JSONObject cell = cells.optJSONObject(geohash);
                    if (cell == null || !cell.optBoolean("conflict", false)) continue;
                    JSONObject item = new JSONObject(cell.toString());
                    item.put("geohash", geohash);
                    add(result, item, bucketId, filter, false);
                }
            }
        } else {
            JSONArray source = "correction".equals(kind)
                ? document.optJSONArray("corrections")
                : "exclusion".equals(kind)
                    ? document.optJSONArray("excludedSections")
                    : document.optJSONObject("roadMemory") == null
                        ? null
                        : document.optJSONObject("roadMemory").optJSONArray("candidates");
            for (int index = 0; source != null && index < source.length(); index++) {
                JSONObject item = source.optJSONObject(index);
                if (item == null || (activeOnly && !item.optBoolean("active", false))) continue;
                add(result, new JSONObject(item.toString()), bucketId, filter, activeOnly);
            }
        }
        result.sort(Comparator.comparing(DriveSenseSpeedEditorRepository::stableKey));
        return result;
    }

    private static void add(List<JSONObject> result, JSONObject item, String bucketId,
                            String filter, boolean ignored) throws Exception {
        item.put("_bucketId", bucketId);
        if (!filter.isEmpty() && !item.toString().toLowerCase(Locale.ROOT).contains(filter)) return;
        result.add(item);
    }

    private boolean hasBucketAfter(String bucketId) throws Exception {
        return speed.page(bucketId, 1).optJSONArray("items").length() > 0;
    }

    private static String stableKey(JSONObject item) {
        for (String key : new String[]{"id", "ruleId", "exclusionId", "exclusionKey", "geohash"}) {
            String value = item.optString(key, "");
            if (!value.isEmpty()) return value;
        }
        return item.toString();
    }

    private static JSONObject findInBucket(JSONObject document, String kind, String identity) throws Exception {
        if (document == null) return null;
        if ("conflict".equals(kind)) {
            JSONObject cell = document.optJSONObject("cells") == null
                ? null : document.optJSONObject("cells").optJSONObject(identity);
            if (cell == null || !cell.optBoolean("conflict", false)) return null;
            JSONObject copy = new JSONObject(cell.toString());
            copy.put("geohash", identity);
            return copy;
        }
        JSONArray source = "correction".equals(kind)
            ? document.optJSONArray("corrections")
            : "exclusion".equals(kind)
                ? document.optJSONArray("excludedSections")
                : document.optJSONObject("roadMemory") == null
                    ? null : document.optJSONObject("roadMemory").optJSONArray("candidates");
        for (int index = 0; source != null && index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (DriveSenseSpeedEditorIndex.stableIdentities(kind, item).contains(identity)) {
                return new JSONObject(item.toString());
            }
        }
        return null;
    }

    private static String kind(String value) {
        String kind = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!kind.equals("correction") && !kind.equals("exclusion") &&
            !kind.equals("candidate") && !kind.equals("conflict") && !kind.equals("evidence")) {
            throw new IllegalArgumentException("SPEED_EDITOR_KIND_INVALID");
        }
        return kind;
    }

    private static String hash(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        return DriveSenseEnvelopeCrypto.hex(digest);
    }

    private static final class PageSlice {
        final boolean complete;
        final int nextOffset;
        final int encodedBytes;
        PageSlice(boolean complete, int nextOffset, int encodedBytes) {
            this.complete = complete;
            this.nextOffset = nextOffset;
            this.encodedBytes = encodedBytes;
        }
    }
}
