package com.drivesense.app;

import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/** Pure bounds/shape helpers shared by the real plugin and local JVM tests. */
final class SecureBatchContract {
    static final int VERSION = 1;
    static final int MAX_RECORDS = 8;
    static final int MAX_LOGICAL_BYTES = 245_760;
    static final int MAX_METHOD_JSON_BYTES = 524_288;
    static final int MAX_CONTEXT_BYTES = 512;
    static final int MAX_BRIDGE_CIPHERTEXT_BYTES = 524_304;
    static final int MAX_BRIDGE_BASE64_CHARS = 699_072;
    static final int MAX_STRUCTURAL_BYTES = 6 * 1024 * 1024;
    static final int AT_REST_OVERHEAD_BYTES = 29;

    private static final Pattern BASE64 = Pattern.compile(
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
    );

    private SecureBatchContract() {}

    static int utf8Bytes(String value) {
        return value == null ? -1 : value.getBytes(StandardCharsets.UTF_8).length;
    }

    static boolean validCount(int count) {
        return count > 0 && count <= MAX_RECORDS;
    }

    static boolean validVersion(Object value) {
        return validInteger(value) && ((Number) value).intValue() == VERSION;
    }

    static boolean validOrdinal(Object ordinal, int expected) {
        return validInteger(ordinal) && ((Number) ordinal).intValue() == expected;
    }

    static boolean validKeyVersion(Object value, boolean encrypt) {
        if (!validInteger(value)) return false;
        double numeric = ((Number) value).doubleValue();
        return encrypt ? numeric >= 1 : numeric >= 0;
    }

    private static boolean validInteger(Object value) {
        if (!(value instanceof Number)) return false;
        double numeric = ((Number) value).doubleValue();
        return Double.isFinite(numeric) && numeric == Math.rint(numeric)
            && numeric >= Integer.MIN_VALUE && numeric <= Integer.MAX_VALUE;
    }

    static boolean validContext(String context) {
        int bytes = utf8Bytes(context);
        return bytes >= 0 && bytes <= MAX_CONTEXT_BYTES;
    }

    static int conservativePlaintextBytes(String ciphertext) {
        if (ciphertext == null || !BASE64.matcher(ciphertext).matches()) return -1;
        int padding = ciphertext.endsWith("==") ? 2 : ciphertext.endsWith("=") ? 1 : 0;
        int decoded = (ciphertext.length() / 4) * 3 - padding;
        return decoded < AT_REST_OVERHEAD_BYTES ? -1 : decoded - AT_REST_OVERHEAD_BYTES;
    }

    static boolean withinLogicalLimit(long bytes) {
        return bytes >= 0 && bytes <= MAX_LOGICAL_BYTES;
    }

    static boolean withinMethodJsonLimit(String json) {
        int bytes = utf8Bytes(json);
        return bytes >= 0 && bytes <= MAX_METHOD_JSON_BYTES;
    }
}
