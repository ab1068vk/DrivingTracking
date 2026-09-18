package com.drivesense.app;

import android.database.Cursor;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Catalog-driven crash recovery for commits that never reached COMMITTED, and
 * for migration/direct ingress that never reached either.
 *
 * The intake journal or the durable ingress spool remains the retry authority.
 * PENDING catalog rows are never aged out: they are reconciled immediately and
 * only files referenced by those exact rows are removed. COMMITTED rows and
 * export-leased revisions are never touched.
 *
 * HPR-016. Ingress identity has always been durable: {@code begin()} writes a
 * {@code migration_ingress} row carrying the operation id, trip id, source hash
 * and temp path, plus an {@code open_operations} row typed LEGACY_IMPORT or
 * DIRECT_COMMIT. What was missing is a consumer. This recovery reconciled only
 * {@code TRIP_COMMIT}/{@code PENDING}, so a process death mid-ingress left the
 * operation row, its ingress row and its {@code .legacy.tmp} behind forever —
 * and {@link DriveSenseArchiveUnlinkDebt#step} refuses to run while <em>any</em>
 * {@code open_operations} row exists, so one dead ingress blocked unrelated
 * archive cleanup indefinitely.
 *
 * WHY A SURVIVING INGRESS ROW IS NOT SIMPLY DELETED. P3.5 froze a resume
 * contract: an ingress is resumable by durable chunk index across a restart, and
 * {@code append()} validates {@code migration_ingress}. Deleting that row on the
 * next startup would break it. Native resume remains authoritative even though
 * the current JavaScript streaming helper holds its operation id only locally.
 *
 * Reclamation is admitted once by the process-wide storage bootstrap, never by
 * counting repository objects. Normal completed-trip admission constructs more
 * repositories in the same process.
 *
 *   First replacement process — active ownership becomes an explicit durable
 *     ABANDONED_INGRESS marker bearing this process incarnation. It does not
 *     block unlink debt; the ingress and spool remain resumable.
 *
 *   A later process — only a marker released by a DIFFERENT incarnation is
 *     reclaimable. Successful append atomically changes it back to RECEIVING
 *     with durable chunk progress; finish also reacquires active ownership.
 *     Thus resumed work gets another resumable release, not final deletion.
 *
 * A missing operation row alone is not proof of abandonment: it is conservatively
 * staged first. No elapsed-age heuristic or second migration journal is used.
 */
final class DriveSenseArchiveRecovery {
    /** Operation classes whose owner is an ingress stream, not a commit. */
    private static final String INGRESS_OPERATION_TYPES = "'LEGACY_IMPORT','DIRECT_COMMIT'";
    static final String RELEASED_INGRESS = "ABANDONED_INGRESS";

    private DriveSenseArchiveRecovery() {}

    static void recover(DriveSenseStorageCoordinator coordinator,
                        DriveSenseTripChunkStore chunks) throws Exception {
        // Before the PENDING-commit pass, and unconditionally: a store with no
        // pending commits can still hold a stranded ingress, and the early
        // return below would otherwise skip it.
        reconcileAbandonedIngress(coordinator);
        recoverPendingCommits(coordinator, chunks);
    }

    /**
     * Release, then reclaim, ingress left behind by a dead process.
     *
     * Ordering inside stage two is deliberate and idempotent. The spool is
     * unlinked FIRST, outside any transaction; only an operation whose bytes are
     * gone has its durable row removed. Deleting the row first would strand the
     * bytes with nothing pointing at them, so a failed unlink leaves the row and
     * the next startup tries again. A spool that is already absent is success,
     * which is what makes a rerun a no-op.
     *
     * Cost is O(K) in surviving ingress operations plus the entries of the
     * bounded migration spool directory. It reads no trip, enumerates no archive
     * and materialises no route.
     */
    private static void reconcileAbandonedIngress(DriveSenseStorageCoordinator coordinator) throws Exception {
        List<Abandoned> rows = coordinator.read(db -> {
            List<Abandoned> out = new ArrayList<>();
            try (Cursor cursor = db.rawQuery(
                "SELECT i.operation_id,i.temp_path,o.state,o.owner_token "
                    + "FROM migration_ingress i LEFT JOIN open_operations o ON o.operation_id=i.operation_id"
                    + " AND o.operation_type IN (" + INGRESS_OPERATION_TYPES + ")", null)) {
                while (cursor.moveToNext()) {
                    out.add(new Abandoned(cursor.getString(0), cursor.getString(1),
                        cursor.getString(2), cursor.getString(3)));
                }
            }
            return out;
        });

        File directory = migrationDirectory(coordinator);
        Set<String> retained = new HashSet<>();
        int released = 0;
        int reclaimed = 0;
        for (Abandoned row : rows) {
            File temp = safeTemp(directory, row.tempPath);
            if (!RELEASED_INGRESS.equals(row.state)) {
                // Stage one. Persist affirmative abandonment staging, not mere
                // absence of a blocking row. Keep exact identity/chunk evidence.
                final String operation = row.operationId;
                coordinator.write(db -> {
                    db.execSQL("INSERT OR REPLACE INTO open_operations"
                        + "(operation_id,operation_type,state,owner_token,created_at_ms,updated_at_ms) "
                        + "SELECT operation_id,CASE WHEN migration_mode=1 THEN 'LEGACY_IMPORT' ELSE 'DIRECT_COMMIT' END,"
                        + "?,?,created_at_ms,? FROM migration_ingress WHERE operation_id=?",
                        new Object[]{RELEASED_INGRESS, coordinator.processIncarnation(), System.currentTimeMillis(), operation});
                    return null;
                });
                if (temp != null) retained.add(temp.getName());
                released++;
                continue;
            }
            if (coordinator.processIncarnation().equals(row.releasedBy)) {
                // Same-process retry is not another startup/lifetime.
                if (temp != null) retained.add(temp.getName());
                continue;
            }
            // Stage two needs a durable release from a prior process, with no
            // resumed append having restored RECEIVING ownership since then.
            if (temp != null && temp.exists()) {
                wipe(temp);
                if (temp.exists()) {
                    // Keep the row: bytes with no owner record are worse than a
                    // retryable obligation, and the next startup repeats this.
                    retained.add(temp.getName());
                    continue;
                }
            }
            final String operation = row.operationId;
            coordinator.write(db -> {
                db.beginTransaction();
                try {
                    db.delete("migration_ingress", "operation_id=?", new String[]{operation});
                    db.delete("open_operations", "operation_id=? AND state=?",
                        new String[]{operation, RELEASED_INGRESS});
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                return null;
            });
            reclaimed++;
        }

        // An ingress-class operation row whose ingress row is already gone owns
        // no bytes and no owner. It would still block unlink debt forever.
        int orphanOperations = coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery(
                "SELECT COUNT(*) FROM open_operations WHERE operation_type IN ("
                    + INGRESS_OPERATION_TYPES + ") AND operation_id NOT IN (SELECT operation_id FROM migration_ingress)",
                null)) {
                cursor.moveToFirst();
                return cursor.getInt(0);
            }
        });
        if (orphanOperations > 0) {
            coordinator.write(db -> {
                db.execSQL("DELETE FROM open_operations WHERE operation_type IN ("
                    + INGRESS_OPERATION_TYPES + ") AND operation_id NOT IN (SELECT operation_id FROM migration_ingress)");
                return null;
            });
        }

        // `finish()` deletes the ingress rows and then wipes the spool, so a
        // death between the two leaves a spool nothing references at all.
        int orphanTemps = sweepOrphanTemps(directory, retained);

        if (released > 0 || reclaimed > 0 || orphanOperations > 0 || orphanTemps > 0) {
            DriveSenseDurabilityJournal.record(coordinator.context(), "WARN",
                "MIGRATION_INGRESS_RECONCILED", null, released, reclaimed,
                orphanOperations + orphanTemps, "HEALTHY");
        }
    }

    private static File migrationDirectory(DriveSenseStorageCoordinator coordinator) {
        return new File(coordinator.context().getNoBackupFilesDir(), "roadsage_archive_migration_v1");
    }

    /** The stored path, but only when it really is a file this directory owns. */
    private static File safeTemp(File directory, String storedPath) {
        if (storedPath == null || storedPath.isEmpty()) return null;
        try {
            File candidate = new File(storedPath).getCanonicalFile();
            File root = directory.getCanonicalFile();
            File parent = candidate.getParentFile();
            if (parent == null || !parent.equals(root)) return null;
            return candidate.getName().endsWith(".legacy.tmp") ? candidate : null;
        } catch (Exception unreadable) {
            return null;
        }
    }

    private static int sweepOrphanTemps(File directory, Set<String> known) {
        File[] entries = directory.listFiles();
        if (entries == null) return 0;
        int removed = 0;
        for (File entry : entries) {
            if (!entry.isFile() || !entry.getName().endsWith(".legacy.tmp")) continue;
            if (known.contains(entry.getName())) continue;
            wipe(entry);
            if (!entry.exists()) removed++;
        }
        return removed;
    }

    private static void wipe(File file) {
        try {
            SecureDeleteHelper.secureWipeFile(file);
        } catch (Exception ignored) {
            if (file.exists()) file.delete();
        }
    }

    private static void recoverPendingCommits(DriveSenseStorageCoordinator coordinator,
                                              DriveSenseTripChunkStore chunks) throws Exception {
        List<Pending> pending = coordinator.read(db -> {
            List<Pending> rows = new ArrayList<>();
            try (Cursor cursor = db.rawQuery(
                "SELECT r.trip_id,r.revision,r.operation_id,c.relative_path,r.overview_path " +
                    "FROM trip_revisions r LEFT JOIN trip_chunks c " +
                    "ON c.trip_id=r.trip_id AND c.revision=r.revision " +
                    "WHERE r.commit_state='PENDING' ORDER BY r.trip_id,r.revision,c.chunk_index",
                null)) {
                while (cursor.moveToNext()) {
                    rows.add(new Pending(cursor.getString(0), cursor.getInt(1),
                        cursor.getString(2), cursor.getString(3), cursor.getString(4)));
                }
            }
            return rows;
        });
        if (pending.isEmpty()) return;

        // Files use fresh-nonce content hashes, so a PENDING revision owns its
        // referenced immutable names. Delete outside the SQLite transaction;
        // a crash here simply makes the same reconciliation repeatable.
        for (Pending item : pending) {
            deleteRelative(chunks, item.chunkPath);
            deleteRelative(chunks, item.overviewPath);
            chunks.deleteOwnedTemp(item.operationId);
        }

        coordinator.exclusive(db -> {
            db.beginTransaction();
            try {
                db.execSQL("DELETE FROM trip_chunks WHERE EXISTS (SELECT 1 FROM trip_revisions r WHERE r.trip_id=trip_chunks.trip_id AND r.revision=trip_chunks.revision AND r.commit_state='PENDING')");
                try(Cursor refs=db.rawQuery("SELECT kek_version,COUNT(*) FROM trip_revisions WHERE commit_state='PENDING' AND wrapped_dek IS NOT NULL AND wrapped_dek<>X'' GROUP BY kek_version",null)){
                    while(refs.moveToNext())DriveSenseKeyReferenceCounts.adjust(db,"trip_archive",refs.getInt(0),-refs.getLong(1));
                }
                db.execSQL("DELETE FROM trip_revisions WHERE commit_state='PENDING'");
                db.execSQL("DELETE FROM open_operations WHERE operation_type='TRIP_COMMIT' AND state='PENDING'");
                db.execSQL("UPDATE archive_meta SET pending_count=(SELECT COUNT(*) FROM trip_revisions WHERE commit_state='PENDING'),updated_at_ms=? WHERE id=1",
                    new Object[]{System.currentTimeMillis()});
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            return null;
        });
        DriveSenseDurabilityJournal.record(coordinator.context(), "WARN",
            "PENDING_COMMIT_RECONCILED", null, pending.size(), 0, 0, "HEALTHY");
    }

    private static void deleteRelative(DriveSenseTripChunkStore chunks, String relative) {
        if (relative == null || relative.isEmpty()) return;
        File file = chunks.relativeFile(relative);
        if (file.isFile()) file.delete();
    }

    private static final class Abandoned {
        final String operationId;
        final String tempPath;
        final String state;
        final String releasedBy;

        Abandoned(String operationId, String tempPath, String state, String releasedBy) {
            this.operationId = operationId;
            this.tempPath = tempPath;
            this.state = state;
            this.releasedBy = releasedBy;
        }
    }

    private static final class Pending {
        final String tripId;
        final int revision;
        final String operationId;
        final String chunkPath;
        final String overviewPath;

        Pending(String tripId, int revision, String operationId,
                String chunkPath, String overviewPath) {
            this.tripId = tripId;
            this.revision = revision;
            this.operationId = operationId;
            this.chunkPath = chunkPath;
            this.overviewPath = overviewPath;
        }
    }
}
