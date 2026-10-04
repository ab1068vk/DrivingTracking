package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class DriveSenseCheckpointWriteGateTest {
    @Test public void queuedPeriodicWriteCannotRecreateClearedCheckpoint() {
        DriveSenseCheckpointWriteGate gate = new DriveSenseCheckpointWriteGate();
        long queuedGeneration = gate.generation();
        AtomicInteger writes = new AtomicInteger();
        gate.invalidatePending();
        gate.clearAfterDurable(() -> { });
        assertNull(gate.saveIfCurrent(queuedGeneration, () -> {
            writes.incrementAndGet();
            return true;
        }));
        assertEquals(0, writes.get());
    }

    @Test public void durableClearWaitsForAlreadyRunningPeriodicWrite() throws Exception {
        DriveSenseCheckpointWriteGate gate = new DriveSenseCheckpointWriteGate();
        long generation = gate.generation();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger order = new AtomicInteger();
        Thread writer = new Thread(() -> gate.saveIfCurrent(generation, () -> {
            entered.countDown();
            try { release.await(5, TimeUnit.SECONDS); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            order.compareAndSet(0, 1);
            return true;
        }));
        writer.start();
        org.junit.Assert.assertEquals(true, entered.await(5, TimeUnit.SECONDS));
        Thread clearer = new Thread(() -> gate.clearAfterDurable(() -> order.compareAndSet(1, 2)));
        clearer.start();
        release.countDown();
        writer.join(5_000L);
        clearer.join(5_000L);
        assertEquals(2, order.get());
        assertNull(gate.saveIfCurrent(generation, () -> true));
    }
}
