package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class SecureBatchDispatcherTest {
    @Test
    public void preservesDenseOrderAndContinuesAfterAClassifiedFailure() {
        List<SecureBatchDispatcher.Result<String>> results = SecureBatchDispatcher.run(
            Arrays.asList("first", "corrupt", "third"),
            value -> {
                if ("corrupt".equals(value)) throw new IllegalArgumentException("secret detail");
                return value.toUpperCase();
            },
            ignored -> "INVALID_INPUT"
        );

        assertEquals(3, results.size());
        assertEquals(0, results.get(0).ordinal);
        assertTrue(results.get(0).succeeded());
        assertEquals("FIRST", results.get(0).value);
        assertEquals(1, results.get(1).ordinal);
        assertFalse(results.get(1).succeeded());
        assertEquals("INVALID_INPUT", results.get(1).errorCode);
        assertNull(results.get(1).value);
        assertEquals(2, results.get(2).ordinal);
        assertEquals("THIRD", results.get(2).value);
    }

    @Test
    public void callerValidationCanRejectBeforeAnyOperationRuns() {
        AtomicInteger invocations = new AtomicInteger();
        boolean valid = SecureBatchContract.validCount(9);
        if (valid) {
            SecureBatchDispatcher.run(
                Arrays.asList(1, 2, 3),
                item -> {
                    invocations.incrementAndGet();
                    return item;
                },
                ignored -> "CRYPTO_FAILED"
            );
        }
        assertFalse(valid);
        assertEquals(0, invocations.get());
    }
}
