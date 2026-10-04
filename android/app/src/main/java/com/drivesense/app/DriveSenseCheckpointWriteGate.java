package com.drivesense.app;

import java.util.function.BooleanSupplier;

/** Orders periodic active-trip checkpoint writes before a durable completion clear. */
final class DriveSenseCheckpointWriteGate {
    private final Object lock = new Object();
    private long generation;

    synchronized long generation() { return generation; }

    synchronized void invalidatePending() { generation++; }

    /** Null means a queued write belonged to an older active-trip generation. */
    Boolean saveIfCurrent(long expectedGeneration, BooleanSupplier save) {
        synchronized (lock) {
            if (generation() != expectedGeneration) return null;
            return save.getAsBoolean();
        }
    }

    /** Called off the main thread after the completed-trip journal is durable. */
    void clearAfterDurable(Runnable clear) {
        invalidatePending();
        synchronized (lock) { clear.run(); }
    }
}
