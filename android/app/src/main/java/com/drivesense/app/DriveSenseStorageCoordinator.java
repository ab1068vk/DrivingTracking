package com.drivesense.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.UUID;

final class DriveSenseStorageCoordinator {
    interface DatabaseWork<T> { T run(SQLiteDatabase db) throws Exception; }

    private static volatile DriveSenseStorageCoordinator instance;
    private final Context context;
    private final DriveSenseArchiveOpenHelper helper;
    private final ExecutorService writer = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "roadsage-archive-writer");
        thread.setDaemon(true);
        return thread;
    });
    private final ReentrantReadWriteLock authorityEpoch = new ReentrantReadWriteLock(true);
    private volatile Thread writerThread;
    // This singleton is created once per native process, not once per repository.
    // The token is also persisted on released ingress markers, so retrying an
    // interrupted initialization in this process cannot count as another death.
    private final String processIncarnation = UUID.randomUUID().toString();
    private boolean tripArchiveInitialized;

    static DriveSenseStorageCoordinator get(Context context) {
        DriveSenseStorageCoordinator current = instance;
        if (current != null) return current;
        synchronized (DriveSenseStorageCoordinator.class) {
            if (instance == null) instance = new DriveSenseStorageCoordinator(context);
            return instance;
        }
    }

    static void resetForTests() {
        synchronized (DriveSenseStorageCoordinator.class) {
            if (instance != null) {
                instance.writer.shutdownNow();
                instance.helper.close();
                instance = null;
            }
        }
    }

    private DriveSenseStorageCoordinator(Context context) {
        this.context = context.getApplicationContext();
        this.helper = new DriveSenseArchiveOpenHelper(this.context);
    }

    Context context() { return context; }
    DriveSenseArchiveOpenHelper helper() { return helper; }

    String processIncarnation() { return processIncarnation; }

    /** Admit native startup recovery once, before any trip repository is usable. */
    synchronized void initializeTripArchive(DriveSenseTripChunkStore chunks) throws Exception {
        if (tripArchiveInitialized) return;
        helper.getWritableDatabase();
        DriveSenseArchiveRecovery.recover(this, chunks);
        // A failed initialization remains retryable; durable release tokens make
        // that retry idempotent within this incarnation.
        tripArchiveInitialized = true;
    }

    <T> T read(DatabaseWork<T> work) throws Exception {
        authorityEpoch.readLock().lock();
        try {
            return work.run(helper.getReadableDatabase());
        } finally {
            authorityEpoch.readLock().unlock();
        }
    }

    <T> T write(DatabaseWork<T> work) throws Exception {
        if (Thread.currentThread() == writerThread) return runWrite(work);
        Future<T> future;
        try {
            future = writer.submit(() -> {
                writerThread = Thread.currentThread();
                return runWrite(work);
            });
        } catch (RejectedExecutionException error) {
            throw new IllegalStateException("Native archive writer is unavailable", error);
        }
        try {
            return future.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Native archive write interrupted", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException("Native archive write failed", cause);
        }
    }

    <T> T exclusive(DatabaseWork<T> work) throws Exception {
        if (Thread.currentThread() == writerThread) return runExclusive(work);
        Future<T> future = writer.submit(() -> {
            writerThread = Thread.currentThread();
            return runExclusive(work);
        });
        try {
            return future.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Exclusive native archive work interrupted", error);
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IllegalStateException("Exclusive native archive work failed", cause);
        }
    }

    private <T> T runWrite(DatabaseWork<T> work) throws Exception {
        authorityEpoch.readLock().lock();
        try {
            return work.run(helper.getWritableDatabase());
        } finally {
            authorityEpoch.readLock().unlock();
        }
    }

    private <T> T runExclusive(DatabaseWork<T> work) throws Exception {
        authorityEpoch.writeLock().lock();
        try {
            return work.run(helper.getWritableDatabase());
        } finally {
            authorityEpoch.writeLock().unlock();
        }
    }

    void passiveCheckpoint() {
        try {
            write(db -> { db.rawQuery("PRAGMA wal_checkpoint(PASSIVE)", null).close(); return null; });
        } catch (Exception ignored) {
            // Commit durability does not depend on a passive maintenance checkpoint.
        }
    }
}
