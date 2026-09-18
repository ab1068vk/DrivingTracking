package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.Test;

public class SecureBatchContractTest {
    private static String ciphertextForPlaintextBytes(int plaintextBytes) {
        return Base64.getEncoder().encodeToString(new byte[plaintextBytes + SecureBatchContract.AT_REST_OVERHEAD_BYTES]);
    }

    @Test
    public void constantsPinApprovedBridgeBounds() {
        assertEquals(8, SecureBatchContract.MAX_RECORDS);
        assertEquals(245_760, SecureBatchContract.MAX_LOGICAL_BYTES);
        assertEquals(524_288, SecureBatchContract.MAX_METHOD_JSON_BYTES);
        assertEquals(524_304, SecureBatchContract.MAX_BRIDGE_CIPHERTEXT_BYTES);
        assertEquals(699_072, SecureBatchContract.MAX_BRIDGE_BASE64_CHARS);
        assertEquals(512, SecureBatchContract.MAX_CONTEXT_BYTES);
        assertEquals(6 * 1024 * 1024, SecureBatchContract.MAX_STRUCTURAL_BYTES);
    }

    @Test
    public void countsOrdinalsAndUtf8ContextsAreBounded() {
        assertFalse(SecureBatchContract.validCount(0));
        assertTrue(SecureBatchContract.validCount(8));
        assertFalse(SecureBatchContract.validCount(9));
        assertTrue(SecureBatchContract.validVersion(1));
        assertFalse(SecureBatchContract.validVersion("1"));
        assertTrue(SecureBatchContract.validOrdinal(7, 7));
        assertFalse(SecureBatchContract.validOrdinal(7, 8));
        assertFalse(SecureBatchContract.validOrdinal("7", 7));
        assertTrue(SecureBatchContract.validKeyVersion(1, true));
        assertFalse(SecureBatchContract.validKeyVersion(0, true));
        assertTrue(SecureBatchContract.validKeyVersion(0, false));
        assertFalse(SecureBatchContract.validKeyVersion(1.5, false));
        assertTrue(SecureBatchContract.validContext("東".repeat(170)));
        assertFalse(SecureBatchContract.validContext("東".repeat(171)));
    }

    @Test
    public void decryptLengthInferenceIsConservativeAndStrict() {
        String ciphertext = ciphertextForPlaintextBytes(80_000);
        assertEquals(80_000, SecureBatchContract.conservativePlaintextBytes(ciphertext));
        assertEquals(-1, SecureBatchContract.conservativePlaintextBytes("not base64"));
        assertEquals(-1, SecureBatchContract.conservativePlaintextBytes("AA=="));
    }

    @Test
    public void compactJsonStressInputsUseExactUtf8Size() {
        String value = "{\"quotes\":\"" + "\\\"".repeat(10_000)
            + "\",\"slashes\":\"" + "\\\\".repeat(10_000)
            + "\",\"emoji\":\"" + "🚗".repeat(10_000) + "\"}";
        assertEquals(value.getBytes(StandardCharsets.UTF_8).length, SecureBatchContract.utf8Bytes(value));
        assertTrue(SecureBatchContract.withinMethodJsonLimit(value));
        assertTrue(SecureBatchContract.withinMethodJsonLimit("x".repeat(SecureBatchContract.MAX_METHOD_JSON_BYTES)));
        assertFalse(SecureBatchContract.withinMethodJsonLimit("x".repeat(SecureBatchContract.MAX_METHOD_JSON_BYTES + 1)));
    }
}
