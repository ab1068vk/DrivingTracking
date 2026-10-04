package com.drivesense.app;

import android.os.Handler;
import android.os.Looper;

import java.util.Set;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/** Owns durable completed-trip IO independently of one tracking-service instance. */
final class DriveSenseCompletionPersistence {
    private static final Set<String> IN_FLIGHT = ConcurrentHashMap.newKeySet();
    private static final Object STATE_LOCK = new Object();
    private static final Map<String, List<Consumer<Boolean>>> OBSERVERS = new HashMap<>();
    private static final AtomicLong ERASURE_EPOCH = new AtomicLong();
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "roadsage-completion-journal");
        thread.setPriority(Thread.NORM_PRIORITY - 1);
        return thread;
    });
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private DriveSenseCompletionPersistence() {}

    static boolean isInFlight(String tripId) {
        return tripId != null && IN_FLIGHT.contains(tripId);
    }

    static void cancelAllForDataErasure() { ERASURE_EPOCH.incrementAndGet(); }

    static long erasureEpoch() { return ERASURE_EPOCH.get(); }

    static boolean isErasureEpochCurrent(long epoch) { return ERASURE_EPOCH.get() == epoch; }

    /** Registers a one-shot recovery wake without polling or waiting on journal IO. */
    static boolean observeInFlight(String tripId, Consumer<Boolean> observer) {
        if (tripId == null || tripId.isEmpty() || observer == null) return false;
        synchronized (STATE_LOCK) {
            if (!IN_FLIGHT.contains(tripId)) return false;
            OBSERVERS.computeIfAbsent(tripId, unused -> new ArrayList<>()).add(observer);
            return true;
        }
    }

    static boolean submit(String tripId, Callable<Boolean> durableWrite, Consumer<Boolean> completion) {
        if (tripId == null || tripId.isEmpty() || durableWrite == null || completion == null) return false;
        synchronized (STATE_LOCK) {
            if (!IN_FLIGHT.add(tripId)) return false;
        }
        final long admissionEpoch = ERASURE_EPOCH.get();
        try {
            IO.execute(() -> {
                boolean saved = false;
                try {
                    saved = Boolean.TRUE.equals(durableWrite.call());
                } catch (Exception error) {
                    android.util.Log.e("TripCompletion", "Completed-trip journal write failed", error);
                }
                final boolean durable = saved;
                if (!MAIN.post(() -> {
                    try {
                        completion.accept(durable && isErasureEpochCurrent(admissionEpoch));
                    } catch (RuntimeException error) {
                        android.util.Log.e("TripCompletion", "Completion publication failed; journal remains recoverable", error);
                    } finally {
                        List<Consumer<Boolean>> observers;
                        synchronized (STATE_LOCK) {
                            IN_FLIGHT.remove(tripId);
                            observers = OBSERVERS.remove(tripId);
                        }
                        if (observers != null) for (Consumer<Boolean> observer : observers) {
                            try { observer.accept(durable && isErasureEpochCurrent(admissionEpoch)); }
                            catch (RuntimeException error) {
                                android.util.Log.e("TripCompletion", "Completion observer failed", error);
                            }
                        }
                    }
                })) {
                    synchronized (STATE_LOCK) {
                        IN_FLIGHT.remove(tripId);
                        OBSERVERS.remove(tripId);
                    }
                }
            });
            return true;
        } catch (RuntimeException rejected) {
            synchronized (STATE_LOCK) {
                IN_FLIGHT.remove(tripId);
                OBSERVERS.remove(tripId);
            }
            android.util.Log.e("TripCompletion", "Completed-trip journal executor unavailable", rejected);
            return false;
        }
    }
}
