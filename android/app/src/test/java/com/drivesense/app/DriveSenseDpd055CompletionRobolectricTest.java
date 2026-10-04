package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.os.Looper;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@LooperMode(LooperMode.Mode.PAUSED)
public class DriveSenseDpd055CompletionRobolectricTest {
    @Test public void durableWorkRunsOffMainAndPublishesOnlyAfterItFinishes() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean published = new AtomicBoolean(false);
        AtomicBoolean writerOnMain = new AtomicBoolean(true);
        String id = "dpd055-worker-owner";

        assertTrue(DriveSenseCompletionPersistence.submit(id, () -> {
            writerOnMain.set(Looper.myLooper() == Looper.getMainLooper());
            entered.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) return false;
            return true;
        }, published::set));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertFalse(writerOnMain.get());
        assertFalse(published.get());
        assertTrue(DriveSenseCompletionPersistence.isInFlight(id));
        release.countDown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!published.get() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle();
            Thread.yield();
        }
        assertTrue(published.get());
    }

    @Test public void duplicateSubmissionDoesNotStartASecondWriter() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger writes = new AtomicInteger();
        String id = "dpd055-duplicate";
        assertTrue(DriveSenseCompletionPersistence.submit(id, () -> {
            writes.incrementAndGet();
            entered.countDown();
            return release.await(5, TimeUnit.SECONDS);
        }, saved -> { }));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertFalse(DriveSenseCompletionPersistence.submit(id, () -> {
            writes.incrementAndGet();
            return true;
        }, saved -> { }));
        release.countDown();
        assertEquals(1, writes.get());
    }

    @Test public void replacementServiceCanObserveExistingWriteWithoutPolling() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger observed = new AtomicInteger();
        String id = "dpd055-replacement";
        assertTrue(DriveSenseCompletionPersistence.submit(id, () -> {
            entered.countDown();
            return release.await(5, TimeUnit.SECONDS);
        }, saved -> { }));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertTrue(DriveSenseCompletionPersistence.observeInFlight(id, saved -> {
            if (saved) observed.incrementAndGet();
        }));
        release.countDown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (observed.get() == 0 && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle();
            Thread.yield();
        }
        assertEquals(1, observed.get());
        assertFalse(DriveSenseCompletionPersistence.observeInFlight(id, saved -> { }));
    }

    @Test public void erasureSuppressesLateDurablePublication() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean published = new AtomicBoolean(true);
        String id = "dpd055-erasure-race";
        assertTrue(DriveSenseCompletionPersistence.submit(id, () -> {
            entered.countDown();
            return release.await(5, TimeUnit.SECONDS);
        }, published::set));
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        DriveSenseCompletionPersistence.cancelAllForDataErasure();
        release.countDown();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (DriveSenseCompletionPersistence.isInFlight(id) && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle();
            Thread.yield();
        }
        assertFalse(published.get());
    }
}
