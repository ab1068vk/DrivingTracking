package com.drivesense.app;

import android.content.Context;
import android.database.Cursor;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.UUID;

/**
 * RSAS v1: bounded, encrypted, append-only active-trip point storage.
 *
 * Segment files use the same RSTC envelope framing as canonical trip chunks.
 * The authenticated domain is deliberately stable (trip_stream); lifecycle
 * phase is authenticated in the separately encrypted manifest so journal
 * admission can transfer ownership without re-encrypting route bytes.
 */
final class DriveSenseActiveTripSpool implements AutoCloseable {
    static final int VERSION = 1;
    static final int SEGMENT_PLAINTEXT_BYTES = 64 * 1024;
    static final int SEGMENT_POINT_LIMIT = 256;
    static final long SEGMENT_AGE_MS = 10_000L;
    static final int RECENT_POINT_LIMIT = 300;
    static final int OVERVIEW_POINT_LIMIT = 1500;
    static final int OVERVIEW_BYTE_LIMIT = 360 * 1024;
    static final int MANIFEST_ENCRYPTED_BYTES = 512 * 1024;
    static final long SPACE_RESERVE_BYTES = 256L * 1024L * 1024L;
    static final String DOMAIN = "trip_stream";
    static final String OWNER_NATIVE = "native_service";
    static final String ERROR_NOT_OWNER = "ACTIVE_PRODUCER_NOT_OWNER";
    static final String ERROR_LIVE_OWNER = "ACTIVE_PRODUCER_LIVE_OWNER";

    private static final String TAG = "ActiveTripSpool";
    private static final String ROOT = "roadsage_trip_archive_v1";
    private static final String ACTIVE = "active_spools";
    private static final String MANIFEST = "manifest.enc";
    private static final int MAGIC = 0x52535443; // RSTC
    private static final int FORMAT_VERSION = 1;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static volatile String testFaultPoint;
    /** Positive process-incarnation proof. Time/heartbeat age is never owner-death proof. */
    private static volatile String processIncarnation = randomToken();

    private final Context context;
    private final File directory;
    private final String archiveGeneration;
    private final String tripId;
    private final String sessionId;
    private String ownerKind;
    private String ownerToken;
    private String ownerProcessIncarnation;
    private final long acquiredAt;
    private final int kekVersion;
    private final byte[] wrappedDek;
    private final byte[] wrapNonce;
    private byte[] dek;
    private final ByteArrayOutputStream openSegment = new ByteArrayOutputStream(SEGMENT_PLAINTEXT_BYTES);
    private int openSegmentPoints;
    private long openSegmentStartedAt;
    private int sealedSegments;
    private long sealedPlaintextBytes;
    private long pointCount;
    private int stablePointCount;
    private double distanceKm;
    private double maxSpeedKmh;
    private double movingSeconds;
    private double idleSeconds;
    private double gapSeconds;
    private int gapCount;
    private long startTimeMs;
    private long lastPointTimeMs;
    private JSONObject previousPoint;
    private JSONObject latestPoint;
    private final Deque<JSONObject> recentPoints = new ArrayDeque<>(RECENT_POINT_LIMIT);
    private final ArrayList<JSONObject> overview = new ArrayList<>(OVERVIEW_POINT_LIMIT);
    private long overviewEligible;
    private int overviewStride = 1;
    private String state = "ACTIVE";
    private boolean closed;

    static DriveSenseActiveTripSpool create(
        Context context,
        String tripId,
        long startTimeMs,
        String ownerKind
    ) throws Exception {
        DriveSenseStorageCoordinator coordinator = DriveSenseStorageCoordinator.get(context);
        return coordinator.write(database -> DriveSenseEnvelopeCrypto.withReferenceCreationFence(
            () -> createInsideReferenceFence(context, tripId, startTimeMs, ownerKind)
        )
        );
    }

    private static DriveSenseActiveTripSpool createInsideReferenceFence(
        Context context,
        String tripId,
        long startTimeMs,
        String ownerKind
    ) throws Exception {
        admit(context, SEGMENT_PLAINTEXT_BYTES + MANIFEST_ENCRYPTED_BYTES);
        String safeTrip = requireId(tripId);
        String session = UUID.randomUUID().toString();
        String owner = ownerKind == null || ownerKind.trim().isEmpty() ? OWNER_NATIVE : ownerKind.trim();
        String token = randomToken();
        String generation = archiveGeneration(context);
        File directory = new File(activeRoot(context), session);
        if (!directory.mkdirs()) throw new IllegalStateException("ACTIVE_SPOOL_DIRECTORY_UNAVAILABLE");
        byte[] dek = DriveSenseEnvelopeCrypto.newDek();
        int kekVersion = DriveSenseEnvelopeCrypto.activeKekVersion(DriveSenseStorageCoordinator.get(context));
        byte[] wrapAad = wrapAad(generation, safeTrip, session, kekVersion);
        DriveSenseEnvelopeCrypto.WrappedDek wrapped = DriveSenseEnvelopeCrypto.wrapDek(dek, kekVersion, wrapAad);
        DriveSenseActiveTripSpool spool = new DriveSenseActiveTripSpool(
            context, directory, generation, safeTrip, session, owner, token, processIncarnation,
            System.currentTimeMillis(), kekVersion, wrapped.ciphertext, wrapped.nonce, dek
        );
        spool.startTimeMs = startTimeMs;
        spool.persistManifest();
        return spool;
    }

    static DriveSenseActiveTripSpool reopen(Context context, String sessionId, String ownerKind, String ownerToken) throws Exception {
        File directory = new File(activeRoot(context), requireSession(sessionId));
        return reopenDirectory(context, directory, ownerKind, ownerToken, true);
    }

    /**
     * Reclaim an ACTIVE native spool only when its authenticated manifest proves
     * it belongs to a different process incarnation. A delayed heartbeat in the
     * current process is deliberately irrelevant and can never authorize theft.
     */
    static DriveSenseActiveTripSpool reclaimFormerNativeProcess(Context context,String sessionId) throws Exception {
        File directory=new File(activeRoot(context),requireSession(sessionId));
        DriveSenseActiveTripSpool spool=reopenDirectory(context,directory,null,null,false);
        try{
            if(!OWNER_NATIVE.equals(spool.ownerKind))throw new IllegalStateException(ERROR_NOT_OWNER);
            if(!"ACTIVE".equals(spool.state))throw new IllegalStateException("ACTIVE_SPOOL_NOT_RECLAIMABLE");
            if(processIncarnation.equals(spool.ownerProcessIncarnation))throw new IllegalStateException(ERROR_LIVE_OWNER);
            maybeFault("BEFORE_RECLAIM_MANIFEST");
            spool.ownerToken=randomToken();
            spool.ownerProcessIncarnation=processIncarnation;
            spool.persistManifest();
            maybeFault("AFTER_RECLAIM_MANIFEST");
            return spool;
        }catch(Exception error){spool.close();throw error;}
    }

    static DriveSenseActiveTripSpool reopenAdopted(Context context, File directory) throws Exception {
        return reopenDirectory(context, directory, null, null, false);
    }

    /** Resolve a journal-owned session across the crash-safe adoption seam. */
    static File locateJournalSession(Context context, File journalDirectory, String sessionId) {
        String safeSession = requireSession(sessionId);
        File adopted = new File(new File(journalDirectory, "rsas_v1"), safeSession);
        if (adopted.isDirectory()) return adopted;
        File prepared = new File(activeRoot(context), safeSession);
        return prepared.isDirectory() ? prepared : adopted;
    }

    private static DriveSenseActiveTripSpool reopenDirectory(
        Context context,
        File directory,
        String requestedOwner,
        String requestedToken,
        boolean enforceOwner
    ) throws Exception {
        JSONObject manifest = readManifest(context, directory);
        if (manifest.optInt("version", 0) != VERSION) throw new SecurityException("ACTIVE_SPOOL_VERSION_INVALID");
        String generation = manifest.getString("archive_generation");
        String tripId = requireId(manifest.getString("trip_id"));
        String sessionId = requireSession(manifest.getString("session_id"));
        String ownerKind = manifest.getString("owner_kind");
        String ownerToken = manifest.getString("owner_token");
        String ownerProcess = manifest.optString("owner_process_incarnation", "");
        // A checkpoint can legitimately retain the previous token when a
        // reclaimed service process dies before its next periodic checkpoint.
        // Process incarnation is positive owner-death evidence; heartbeat age
        // is not.  Surface the prior-process condition before comparing that
        // stale token so the independently authenticated reclaim path can run.
        if(enforceOwner&&OWNER_NATIVE.equals(ownerKind)&&!processIncarnation.equals(ownerProcess)){
            throw new IllegalStateException("ACTIVE_PRODUCER_PRIOR_PROCESS");
        }
        if (enforceOwner && (!ownerKind.equals(requestedOwner) || !ownerToken.equals(requestedToken))) {
            throw new IllegalStateException(ERROR_NOT_OWNER);
        }
        int kekVersion = manifest.getInt("kek_version");
        byte[] wrapped = Base64.decode(manifest.getString("wrapped_dek"), Base64.NO_WRAP);
        byte[] wrapNonce = Base64.decode(manifest.getString("wrap_nonce"), Base64.NO_WRAP);
        byte[] dek = DriveSenseEnvelopeCrypto.unwrapDek(
            wrapped, wrapNonce, kekVersion, wrapAad(generation, tripId, sessionId, kekVersion)
        );
        DriveSenseActiveTripSpool spool = new DriveSenseActiveTripSpool(
            context, directory, generation, tripId, sessionId, ownerKind, ownerToken, ownerProcess,
            manifest.getLong("acquired_at"), kekVersion, wrapped, wrapNonce, dek
        );
        spool.restore(manifest);
        spool.reconcileTail();
        return spool;
    }

    private DriveSenseActiveTripSpool(
        Context context,
        File directory,
        String archiveGeneration,
        String tripId,
        String sessionId,
        String ownerKind,
        String ownerToken,
        String ownerProcessIncarnation,
        long acquiredAt,
        int kekVersion,
        byte[] wrappedDek,
        byte[] wrapNonce,
        byte[] dek
    ) {
        this.context = context.getApplicationContext();
        this.directory = directory;
        this.archiveGeneration = archiveGeneration;
        this.tripId = tripId;
        this.sessionId = sessionId;
        this.ownerKind = ownerKind;
        this.ownerToken = ownerToken;
        this.ownerProcessIncarnation=ownerProcessIncarnation;
        this.acquiredAt = acquiredAt;
        this.kekVersion = kekVersion;
        this.wrappedDek = Arrays.copyOf(wrappedDek, wrappedDek.length);
        this.wrapNonce = Arrays.copyOf(wrapNonce, wrapNonce.length);
        this.dek = dek;
    }

    synchronized void append(JSONObject rawPoint) throws Exception {
        requireActiveOwner();
        if (rawPoint == null) return;
        JSONObject point = privacyMaskedPoint(context, rawPoint);
        byte[] encoded = canonicalPoint(point);
        if (encoded.length + 1 > SEGMENT_PLAINTEXT_BYTES) throw new IllegalArgumentException("ACTIVE_POINT_TOO_LARGE");
        long pointTime = pointTimeMs(point);
        long now = System.currentTimeMillis();
        if (openSegmentPoints > 0 && (
            openSegment.size() + encoded.length + 1 > SEGMENT_PLAINTEXT_BYTES ||
            openSegmentPoints >= SEGMENT_POINT_LIMIT ||
            now - openSegmentStartedAt >= SEGMENT_AGE_MS
        )) sealOpenSegment();
        if (openSegmentPoints == 0) openSegmentStartedAt = now;
        openSegment.write(encoded);
        openSegment.write('\n');
        openSegmentPoints += 1;
        updateRolling(point, pointTime);
        JSONObject uiPoint = boundedUiPoint(point);
        latestPoint = uiPoint;
        recentPoints.addLast(uiPoint);
        while (recentPoints.size() > RECENT_POINT_LIMIT) recentPoints.removeFirst();
        acceptOverview(uiPoint);
        if (
            openSegment.size() >= SEGMENT_PLAINTEXT_BYTES ||
            openSegmentPoints >= SEGMENT_POINT_LIMIT ||
            now - openSegmentStartedAt >= SEGMENT_AGE_MS
        ) sealOpenSegment();
    }

    synchronized void heartbeat(String token) throws Exception {
        requireToken(token);
        persistManifest();
    }

    synchronized void seal() throws Exception {
        requireOpen();
        if ("SEALED".equals(state) || "JOURNAL".equals(state) || "CANONICAL".equals(state)) return;
        requireActiveOwner();
        sealOpenSegment();
        state = "SEALED";
        persistManifest();
    }

    synchronized void markJournalOwned() throws Exception {
        requireOpen();
        if (!"SEALED".equals(state) && !"JOURNAL".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_NOT_SEALED");
        state = "JOURNAL";
        persistManifest();
    }

    /**
     * A journal admission that fails before its manifest exists has not transferred
     * durable ownership. Return the sealed evidence to its former active owner so a
     * replacement service process can reclaim and retry it. Once a journal manifest
     * exists this rollback is forbidden: the journal is then the durable owner.
     */
    synchronized void resumeActiveAfterFailedJournalAdmission() throws Exception {
        requireOpen();
        if (!"JOURNAL".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_NOT_JOURNAL_PREPARED");
        state = "ACTIVE";
        persistManifest();
    }

    synchronized void streamCompletedTrip(JSONObject metadata, OutputStream output) throws Exception {
        streamCompletedTrip(metadata, output, false);
    }

    synchronized void streamJournalOwnedTrip(JSONObject metadata, OutputStream output) throws Exception {
        streamCompletedTrip(metadata, output, true);
    }

    private void streamCompletedTrip(JSONObject metadata, OutputStream output, boolean journalOwnershipProven) throws Exception {
        requireOpen();
        boolean preparedRecovery = journalOwnershipProven && "ACTIVE".equals(state) &&
            openSegmentPoints == 0 && sealedSegments > 0;
        if (!preparedRecovery && !"SEALED".equals(state) && !"JOURNAL".equals(state) && !"CANONICAL".equals(state)) {
            throw new IllegalStateException("ACTIVE_SPOOL_NOT_SEALED");
        }
        JSONObject bounded = metadata == null ? new JSONObject() : metadata;
        output.write('{');
        List<String> keys = new ArrayList<>();
        java.util.Iterator<String> iterator = bounded.keys();
        while (iterator.hasNext()) {
            String key = iterator.next();
            if (!"route_points".equals(key)) keys.add(key);
        }
        java.util.Collections.sort(keys);
        boolean firstField = true;
        for (String key : keys) {
            if (!firstField) output.write(',');
            firstField = false;
            output.write(JSONObject.quote(key).getBytes(StandardCharsets.UTF_8));
            output.write(':');
            writeJsonValue(bounded.opt(key), output);
        }
        if (!firstField) output.write(',');
        output.write("\"route_points\":[".getBytes(StandardCharsets.UTF_8));
        boolean firstPoint = true;
        for (int index = 0; index < sealedSegments; index++) {
            byte[] plaintext = readSegment(index);
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new java.io.ByteArrayInputStream(plaintext), StandardCharsets.UTF_8), 16 * 1024
            )) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isEmpty()) continue;
                    if (!firstPoint) output.write(',');
                    firstPoint = false;
                    output.write(line.getBytes(StandardCharsets.UTF_8));
                }
            } finally {
                Arrays.fill(plaintext, (byte) 0);
            }
        }
        output.write(']');
        output.write('}');
    }

    synchronized JSONObject boundedView(long nowMs) throws Exception {
        JSONObject view = new JSONObject();
        view.put("id", tripId);
        view.put("session_id", sessionId);
        view.put("owner_kind", ownerKind);
        view.put("state", state);
        view.put("start_time_ms", startTimeMs);
        view.put("point_count", pointCount);
        view.put("distance_km", distanceKm);
        view.put("duration_seconds", durationSeconds(nowMs));
        view.put("moving_seconds", Math.round(movingSeconds));
        view.put("idle_seconds", Math.round(idleSeconds));
        view.put("gap_seconds", Math.round(gapSeconds));
        view.put("route_gap_count", gapCount);
        view.put("max_speed_kmh", maxSpeedKmh);
        view.put("avg_speed_kmh", averageSpeed(nowMs));
        view.put("recent_points", jsonArray(recentPoints));
        view.put("route_preview", jsonArray(overview));
        view.put("latest_point", latestPoint == null ? JSONObject.NULL : latestPoint);
        view.put("sealed_segment_count", sealedSegments);
        view.put("sealed_plaintext_bytes", sealedPlaintextBytes);
        view.put("open_segment_bytes", openSegment.size());
        view.put("recent_point_count", recentPoints.size());
        view.put("overview_point_count", overview.size());
        view.put("maximumBufferedBytes", SEGMENT_PLAINTEXT_BYTES);
        view.put("maximumBufferedPoints", SEGMENT_POINT_LIMIT);
        view.put("maximum_resident_route_points", RECENT_POINT_LIMIT + OVERVIEW_POINT_LIMIT + SEGMENT_POINT_LIMIT);
        view.put("process_incarnation", processIncarnation);
        return view;
    }

    synchronized JSONObject rollingStats(long endMs) throws Exception {
        JSONObject result = new JSONObject();
        long wall = Math.max(0L, (endMs - startTimeMs) / 1000L);
        long gap = Math.round(gapSeconds);
        long duration = Math.max(0L, wall - gap);
        long moving = Math.round(movingSeconds);
        long idle = Math.round(idleSeconds);
        if (latestPoint != null && lastPointTimeMs > 0L && latestPoint.optDouble("speed_kmh", 0d) < DetectionConstants.STATIONARY_SPEED_KMH) {
            idle += Math.min(Math.max(0L, (endMs - lastPointTimeMs) / 1000L), DetectionConstants.MAX_TERMINAL_IDLE_SECONDS);
        }
        result.put("wall_clock_duration_seconds", wall);
        result.put("duration_seconds", duration);
        result.put("distance_km", distanceKm);
        result.put("moving_seconds", moving);
        result.put("idle_seconds", idle);
        result.put("gap_seconds", gap);
        result.put("gap_count", gapCount);
        result.put("max_speed_kmh", maxSpeedKmh);
        result.put("avg_speed_kmh", duration > 0 && distanceKm > 0 ? distanceKm / (duration / 3600d) : 0d);
        result.put("avg_running_speed_kmh", moving > 0 && distanceKm > 0 ? distanceKm / (moving / 3600d) : 0d);
        result.put("point_count", pointCount);
        result.put("stable_point_count", stablePointCount);
        return result;
    }

    synchronized JSONArray recentPoints() { return jsonArray(recentPoints); }
    synchronized JSONArray overviewPoints() { return jsonArray(overview); }
    synchronized JSONObject latestPoint() { return latestPoint; }
    String tripId() { return tripId; }
    String sessionId() { return sessionId; }
    String ownerToken() { return ownerToken; }
    String state() { return state; }
    File directory() { return directory; }
    synchronized long pointCount() { return pointCount; }
    synchronized int stablePointCount() { return stablePointCount; }
    synchronized long sealedPlaintextBytes() { return sealedPlaintextBytes; }
    synchronized int sealedSegmentCount() { return sealedSegments; }
    synchronized long diskBytes() { return directoryBytes(directory); }

    synchronized void transferDirectoryTo(File target) throws Exception {
        requireOpen();
        if (!"SEALED".equals(state) && !"JOURNAL".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_NOT_SEALED");
        if (target.exists()) throw new IllegalStateException("ACTIVE_SPOOL_TARGET_EXISTS");
        File parent = target.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IllegalStateException("ACTIVE_SPOOL_TARGET_DIRECTORY_UNAVAILABLE");
        // Ownership transfer is a rename, so a crash lands on exactly one side
        // of it. Both sides are recoverable: the journal manifest resolves the
        // session from either the prepared or the adopted location.
        maybeFault("BEFORE_OWNERSHIP_RENAME");
        if (!directory.renameTo(target)) throw new IllegalStateException("ACTIVE_SPOOL_TRANSFER_FAILED");
        maybeFault("AFTER_OWNERSHIP_RENAME_BEFORE_FSYNC");
        DriveSenseArchiveSentinelStore.fsyncDirectory(parent);
        closed = true;
        clearDek();
    }

    synchronized void retireOwned(String token) throws Exception {
        requireToken(token);
        if (!"SEALED".equals(state) && !"CANONICAL".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_RETIRE_STATE_INVALID");
        // Cleanup runs after the canonical commit. A crash here leaves spool
        // bytes behind, which is safe: the canonical trip already exists and
        // the leftover directory is reclaimed, never replayed as a new trip.
        maybeFault("BEFORE_SPOOL_RETIRE");
        boolean restoreKekProof=DriveSenseKeyReferenceCounts.beginFileMutation(context);
        closed = true;
        clearDek();
        deleteTree(directory);
        DriveSenseArchiveSentinelStore.fsyncDirectory(directory.getParentFile());
        DriveSenseKeyReferenceCounts.removeFileReference(context,"active_trip_spool",sessionId,restoreKekProof);
    }

    synchronized void abandonOwned(String token, String reason) throws Exception {
        requireToken(token);
        if (!"ACTIVE".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_ABANDON_STATE_INVALID");
        state = "ABANDONED";
        persistManifest();
        boolean restoreKekProof=DriveSenseKeyReferenceCounts.beginFileMutation(context);
        closed = true;
        clearDek();
        deleteTree(directory);
        DriveSenseArchiveSentinelStore.fsyncDirectory(directory.getParentFile());
        DriveSenseKeyReferenceCounts.removeFileReference(context,"active_trip_spool",sessionId,restoreKekProof);
    }

    @Override public synchronized void close() {
        closed = true;
        clearDek();
    }

    static JSONObject readManifestForStatus(Context context, File directory) throws Exception {
        return readManifest(context, directory);
    }

    /** Metadata-only inventory used to prevent retirement of a KEK still
     * referenced by an ACTIVE/SEALED/JOURNAL spool. Any unreadable manifest is
     * fail-closed because its key version cannot be proven absent. */
    static KeyReferenceInventory keyReferences(Context context, int kekVersion) {
        return combine(
            keyReferencesActive(context, kekVersion, false),
            keyReferencesJournal(context, kekVersion, false)
        );
    }

    static KeyReferenceInventory keyReferencesOtherThan(Context context, int kekVersion) {
        return combine(
            keyReferencesActive(context, kekVersion, true),
            keyReferencesJournal(context, kekVersion, true)
        );
    }

    static KeyReferenceInventory keyReferencesActive(Context context, int kekVersion, boolean otherThan) {
        File root = new File(context.getApplicationContext().getNoBackupFilesDir(), "roadsage_trip_archive_v1/active_spools");
        return keyReferencesInRoot(context, root, kekVersion, otherThan);
    }

    static KeyReferenceInventory keyReferencesJournal(Context context, int kekVersion, boolean otherThan) {
        File root = new File(context.getApplicationContext().getNoBackupFilesDir(), "completed_trip_journal_v1/rsas_v1");
        return keyReferencesInRoot(context, root, kekVersion, otherThan);
    }

    private static KeyReferenceInventory keyReferencesInRoot(Context context, File root, int kekVersion, boolean otherThan) {
        int references = 0, unreadable = 0;
        File[] sessions = root.listFiles(File::isDirectory);
        if (sessions == null) return new KeyReferenceInventory(0, 0);
        for (File session : sessions) {
            try {
                JSONObject manifest = readManifest(context, session);
                int manifestVersion = manifest.optInt("kek_version", -1);
                if ((otherThan && manifestVersion != kekVersion) || (!otherThan && manifestVersion == kekVersion)) references += 1;
            } catch (Exception error) {
                unreadable += 1;
            }
        }
        return new KeyReferenceInventory(references, unreadable);
    }

    private static KeyReferenceInventory combine(KeyReferenceInventory first, KeyReferenceInventory second) {
        return new KeyReferenceInventory(first.references + second.references, first.unreadable + second.unreadable);
    }

    static void deleteAdoptedTree(File directory) {
        deleteTree(directory);
        try { DriveSenseArchiveSentinelStore.fsyncDirectory(directory.getParentFile()); }
        catch (Exception error) { Log.w(TAG, "Could not fsync journal directory after spool cleanup", error); }
    }

    static void eraseAllForDataRights(Context context) throws Exception {
        boolean restoreKekProof=DriveSenseKeyReferenceCounts.beginFileMutation(context);
        File root = new File(
            context.getApplicationContext().getNoBackupFilesDir(),
            "roadsage_trip_archive_v1/active_spools"
        );
        File[] sessions = root.listFiles(File::isDirectory);
        if (sessions != null) {
            for (File session : sessions) deleteTree(session);
        }
        if (root.exists()) DriveSenseArchiveSentinelStore.fsyncDirectory(root);
        DriveSenseKeyReferenceCounts.clearFileDomain(context,"active_trip_spool");
        if(restoreKekProof)DriveSenseStorageCoordinator.get(context).write(db->{DriveSenseKeyReferenceCounts.markVerified(db);return null;});
    }

    static final class KeyReferenceInventory {
        final int references, unreadable;
        KeyReferenceInventory(int refs, int failures) { references=refs; unreadable=failures; }
        boolean provesZero() { return references == 0 && unreadable == 0; }
    }

    private synchronized void sealOpenSegment() throws Exception {
        if (openSegmentPoints == 0) return;
        byte[] plaintext = openSegment.toByteArray();
        byte[] ciphertext = null, encoded = null;
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(plaintext);
            byte[] nonce = monotonicNonce(sealedSegments);
            byte[] aad = segmentAad(
                archiveGeneration, tripId, sessionId, sealedSegments, plaintext.length, hash
            );
            ciphertext = DriveSenseEnvelopeCrypto.encrypt(plaintext, dek, nonce, aad).ciphertext;
            encoded = encodeSegment(nonce, hash, ciphertext);
            admit(context, encoded.length + MANIFEST_ENCRYPTED_BYTES);
            File temporary = new File(directory, segmentName(sealedSegments) + ".tmp");
            File target = new File(directory, segmentName(sealedSegments));
            try (FileOutputStream output = new FileOutputStream(temporary, false)) {
                output.write(encoded);
                output.getFD().sync();
            }
            if (!temporary.renameTo(target)) throw new IllegalStateException("ACTIVE_SEGMENT_RENAME_FAILED");
            DriveSenseArchiveSentinelStore.fsyncDirectory(directory);
            maybeFault("AFTER_SEGMENT_DIRECTORY_FSYNC_BEFORE_MANIFEST");
            sealedSegments += 1;
            sealedPlaintextBytes += plaintext.length;
            openSegment.reset();
            openSegmentPoints = 0;
            openSegmentStartedAt = 0L;
            persistManifest();
        } finally {
            Arrays.fill(plaintext, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
            if (encoded != null) Arrays.fill(encoded, (byte) 0);
        }
    }

    private byte[] readSegment(int index) throws Exception {
        File file = new File(directory, segmentName(index));
        if (!file.isFile() || file.length() > SEGMENT_PLAINTEXT_BYTES + 256L) {
            throw new IllegalStateException("ACTIVE_SEGMENT_MISSING_OR_OVERSIZED");
        }
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            if (input.readInt() != MAGIC || input.readInt() != FORMAT_VERSION) throw new SecurityException("ACTIVE_SEGMENT_HEADER_INVALID");
            int nonceLength = input.readInt();
            if (nonceLength != 12) throw new SecurityException("ACTIVE_SEGMENT_NONCE_INVALID");
            byte[] nonce = new byte[nonceLength]; input.readFully(nonce);
            int hashLength = input.readInt();
            if (hashLength != 32) throw new SecurityException("ACTIVE_SEGMENT_HASH_INVALID");
            byte[] hash = new byte[hashLength]; input.readFully(hash);
            int plaintextLength = input.readInt();
            int ciphertextLength = input.readInt();
            if (plaintextLength <= 0 || plaintextLength > SEGMENT_PLAINTEXT_BYTES || ciphertextLength != plaintextLength + 16) {
                throw new SecurityException("ACTIVE_SEGMENT_LENGTH_INVALID");
            }
            byte[] ciphertext = new byte[ciphertextLength]; input.readFully(ciphertext);
            if (input.read() != -1) throw new SecurityException("ACTIVE_SEGMENT_TRAILING_BYTES");
            byte[] expectedNonce = monotonicNonce(index);
            if (!Arrays.equals(nonce, expectedNonce)) throw new SecurityException("ACTIVE_SEGMENT_INDEX_NONCE_MISMATCH");
            byte[] plain = DriveSenseEnvelopeCrypto.decrypt(
                ciphertext, dek, nonce,
                segmentAad(archiveGeneration, tripId, sessionId, index, plaintextLength, hash)
            );
            if (!Arrays.equals(hash, MessageDigest.getInstance("SHA-256").digest(plain))) {
                Arrays.fill(plain, (byte) 0);
                throw new SecurityException("ACTIVE_SEGMENT_PLAINTEXT_HASH_MISMATCH");
            }
            return plain;
        }
    }

    private void reconcileTail() throws Exception {
        int contiguous = 0;
        while (new File(directory, segmentName(contiguous)).isFile()) {
            byte[] verified = readSegment(contiguous);
            Arrays.fill(verified, (byte) 0);
            contiguous += 1;
        }
        if (contiguous < sealedSegments) {
            state = "SHORTFALL";
            persistManifest();
            throw new SecurityException("ACTIVE_SPOOL_MANIFEST_AHEAD_OF_SEGMENTS");
        }
        if (contiguous > sealedSegments) {
            for (int index = sealedSegments; index < contiguous; index++) {
                byte[] recovered = readSegment(index);
                try {
                    sealedPlaintextBytes += recovered.length;
                    try (BufferedReader lines = new BufferedReader(new InputStreamReader(
                        new ByteArrayInputStream(recovered), StandardCharsets.UTF_8
                    ))) {
                        String line;
                        while ((line = lines.readLine()) != null) {
                            if (line.isEmpty()) continue;
                            JSONObject point = new JSONObject(line);
                            updateRolling(point, pointTimeMs(point));
                            JSONObject uiPoint = boundedUiPoint(point);
                            latestPoint = uiPoint;
                            recentPoints.addLast(uiPoint);
                            while (recentPoints.size() > RECENT_POINT_LIMIT) recentPoints.removeFirst();
                            acceptOverview(uiPoint);
                        }
                    }
                } finally {
                    Arrays.fill(recovered, (byte) 0);
                }
            }
            sealedSegments = contiguous;
            persistManifest();
        }
    }

    static void setFaultPointForTests(String point) { testFaultPoint = point; }
    static String processIncarnationForTests(){return processIncarnation;}
    static void setProcessIncarnationForTests(String value){processIncarnation=value==null||value.isEmpty()?randomToken():value;}

    private static void maybeFault(String point) {
        if (point.equals(testFaultPoint)) throw new IllegalStateException("TEST_FAULT_" + point);
    }

    private void updateRolling(JSONObject point, long timeMs) {
        pointCount += 1L;
        if (point.optDouble("accuracy", 100d) <= 100d) stablePointCount += 1;
        if (previousPoint != null) {
            long priorMs = pointTimeMs(previousPoint);
            double dt = (timeMs - priorMs) / 1000d;
            double distance = haversineKm(
                previousPoint.optDouble("lat", Double.NaN), previousPoint.optDouble("lng", Double.NaN),
                point.optDouble("lat", Double.NaN), point.optDouble("lng", Double.NaN)
            );
            if (dt > 0d && Double.isFinite(distance)) {
                double implied = distance / (dt / 3600d);
                double reported = point.optDouble("speed_kmh", implied);
                if (dt > DetectionConstants.STATS_MAX_SAMPLE_GAP_SECONDS) { gapSeconds += dt; gapCount += 1; }
                else if (implied <= DetectionConstants.MAX_SPEED_KMH && reported <= DetectionConstants.MAX_SPEED_KMH) {
                    double previousAccuracy = previousPoint.optDouble("accuracy", 0d);
                    double currentAccuracy = point.optDouble("accuracy", 0d);
                    double floor = Math.max(DetectionConstants.MIN_POINT_DISTANCE_M, Math.min(25d, Math.max(previousAccuracy, currentAccuracy) * 0.6d));
                    double distanceM = distance * 1000d;
                    boolean reportedMovement = reported >= DetectionConstants.MIN_TRUSTED_SPEED_KMH &&
                        distanceM >= 2d && Math.abs(reported - implied) <= 12d;
                    boolean tiny = distanceM < floor && !reportedMovement;
                    boolean displacementStill = implied < DetectionConstants.STATIONARY_SPEED_KMH && distanceM < floor * 1.5d;
                    boolean disagreement = reported < DetectionConstants.MIN_TRUSTED_SPEED_KMH && displacementStill;
                    if (tiny || disagreement) {
                        previousPoint = boundedUiPoint(point);
                        lastPointTimeMs = timeMs;
                        return;
                    }
                    boolean close = Math.abs(reported - implied) <= 12d;
                    boolean reportedTooLow = reported < DetectionConstants.MIN_TRUSTED_SPEED_KMH &&
                        implied >= DetectionConstants.MIN_TRUSTED_SPEED_KMH && !close;
                    boolean stationaryWhileMoving = reported < DetectionConstants.STATIONARY_SPEED_KMH &&
                        implied >= DetectionConstants.MIN_TRUSTED_SPEED_KMH;
                    double speed = Math.max(0d, (reportedTooLow || stationaryWhileMoving) ? implied : reported);
                    distanceKm += distance;
                    maxSpeedKmh = Math.max(maxSpeedKmh, speed);
                    if (speed >= DetectionConstants.STATIONARY_SPEED_KMH) movingSeconds += dt; else idleSeconds += dt;
                }
            }
        }
        previousPoint = boundedUiPoint(point);
        lastPointTimeMs = timeMs;
    }

    private void acceptOverview(JSONObject point) {
        double lat = point.optDouble("lat", Double.NaN), lng = point.optDouble("lng", Double.NaN);
        if (!Double.isFinite(lat) || !Double.isFinite(lng)) return;
        long index = overviewEligible++;
        if (index % overviewStride != 0) return;
        overview.add(point);
        if (overview.size() >= OVERVIEW_POINT_LIMIT || jsonArray(overview).toString().getBytes(StandardCharsets.UTF_8).length > OVERVIEW_BYTE_LIMIT) {
            compactOverview();
        }
    }

    private void compactOverview() {
        ArrayList<JSONObject> compacted = new ArrayList<>((overview.size() + 1) / 2);
        for (int index = 0; index < overview.size(); index += 2) compacted.add(overview.get(index));
        overview.clear(); overview.addAll(compacted);
        overviewStride = Math.min(Integer.MAX_VALUE / 2, overviewStride * 2);
    }

    private void persistManifest() throws Exception {
        boolean restoreKekProof=DriveSenseKeyReferenceCounts.beginFileMutation(context);
        JSONObject manifest = new JSONObject();
        manifest.put("version", VERSION);
        manifest.put("archive_generation", archiveGeneration);
        manifest.put("domain", DOMAIN);
        manifest.put("trip_id", tripId);
        manifest.put("session_id", sessionId);
        manifest.put("state", state);
        manifest.put("owner_kind", ownerKind);
        manifest.put("owner_token", ownerToken);
        manifest.put("owner_process_incarnation", ownerProcessIncarnation);
        manifest.put("acquired_at", acquiredAt);
        manifest.put("heartbeat_at", System.currentTimeMillis());
        manifest.put("kek_version", kekVersion);
        manifest.put("wrapped_dek", Base64.encodeToString(wrappedDek, Base64.NO_WRAP));
        manifest.put("wrap_nonce", Base64.encodeToString(wrapNonce, Base64.NO_WRAP));
        manifest.put("start_time_ms", startTimeMs);
        manifest.put("last_point_time_ms", lastPointTimeMs);
        manifest.put("sealed_segment_count", sealedSegments);
        manifest.put("sealed_plaintext_bytes", sealedPlaintextBytes);
        manifest.put("point_count", pointCount);
        manifest.put("stable_point_count", stablePointCount);
        manifest.put("distance_km", distanceKm);
        manifest.put("max_speed_kmh", maxSpeedKmh);
        manifest.put("moving_seconds", movingSeconds);
        manifest.put("idle_seconds", idleSeconds);
        manifest.put("gap_seconds", gapSeconds);
        manifest.put("gap_count", gapCount);
        manifest.put("overview_stride", overviewStride);
        manifest.put("overview_eligible", overviewEligible);
        manifest.put("recent_points", jsonArray(recentPoints));
        manifest.put("overview", jsonArray(overview));
        manifest.put("previous_point", previousPoint == null ? JSONObject.NULL : previousPoint);
        manifest.put("latest_point", latestPoint == null ? JSONObject.NULL : latestPoint);
        byte[] encrypted = DriveSensePayloadCrypto.encryptForStorage(
            manifest.toString(), manifestContext(sessionId)
        ).getBytes(StandardCharsets.UTF_8);
        if (encrypted.length > MANIFEST_ENCRYPTED_BYTES) throw new IllegalStateException("ACTIVE_SPOOL_MANIFEST_TOO_LARGE");
        File target = new File(directory, MANIFEST);
        File temp = new File(directory, MANIFEST + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temp, false)) {
                output.write(encrypted);
                output.getFD().sync();
            }
            try {
                Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            DriveSenseArchiveSentinelStore.fsyncDirectory(directory);
            DriveSenseKeyReferenceCounts.completeFileReference(
                context,"active_trip_spool",sessionId,kekVersion,restoreKekProof);
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw error;
        }
    }

    private void restore(JSONObject manifest) {
        state = manifest.optString("state", "ACTIVE");
        startTimeMs = manifest.optLong("start_time_ms", 0L);
        lastPointTimeMs = manifest.optLong("last_point_time_ms", 0L);
        sealedSegments = manifest.optInt("sealed_segment_count", 0);
        sealedPlaintextBytes = manifest.optLong("sealed_plaintext_bytes", 0L);
        pointCount = manifest.optLong("point_count", 0L);
        stablePointCount = manifest.optInt("stable_point_count", 0);
        distanceKm = manifest.optDouble("distance_km", 0d);
        maxSpeedKmh = manifest.optDouble("max_speed_kmh", 0d);
        movingSeconds = manifest.optDouble("moving_seconds", 0d);
        idleSeconds = manifest.optDouble("idle_seconds", 0d);
        gapSeconds = manifest.optDouble("gap_seconds", 0d);
        gapCount = manifest.optInt("gap_count", 0);
        overviewStride = Math.max(1, manifest.optInt("overview_stride", 1));
        overviewEligible = manifest.optLong("overview_eligible", 0L);
        JSONArray recent = manifest.optJSONArray("recent_points");
        if (recent != null) for (int index = Math.max(0, recent.length() - RECENT_POINT_LIMIT); index < recent.length(); index++) {
            JSONObject point = recent.optJSONObject(index); if (point != null) recentPoints.addLast(point);
        }
        JSONArray preview = manifest.optJSONArray("overview");
        if (preview != null) for (int index = 0; index < Math.min(preview.length(), OVERVIEW_POINT_LIMIT); index++) {
            JSONObject point = preview.optJSONObject(index); if (point != null) overview.add(point);
        }
        previousPoint = manifest.optJSONObject("previous_point");
        latestPoint = manifest.optJSONObject("latest_point");
    }

    private static JSONObject readManifest(Context context, File directory) throws Exception {
        File file = new File(directory, MANIFEST);
        if (!file.isFile() || file.length() > MANIFEST_ENCRYPTED_BYTES) throw new IllegalStateException("ACTIVE_SPOOL_MANIFEST_UNAVAILABLE");
        byte[] bytes = readBounded(file, MANIFEST_ENCRYPTED_BYTES);
        String sessionId = requireSession(directory.getName());
        String raw = DriveSensePayloadCrypto.decryptStoredValue(
            new String(bytes, StandardCharsets.UTF_8), manifestContext(sessionId)
        );
        return new JSONObject(raw);
    }

    private static JSONObject privacyMaskedPoint(Context context, JSONObject point) {
        JSONArray one = new JSONArray(); one.put(point);
        JSONArray redacted = PrivacyZoneChecker.redactRoutePoints(context, one);
        JSONObject result = redacted.optJSONObject(0);
        return result == null ? new JSONObject() : result;
    }

    private static byte[] canonicalPoint(JSONObject point) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(1024);
        DriveSenseTripArchiveSerializer.write(point, output);
        return output.toByteArray();
    }

    /** Only fixed-schema route fields may enter the bounded UI/checkpoint view. */
    private static JSONObject boundedUiPoint(JSONObject source) {
        JSONObject point = new JSONObject();
        String[] fields = new String[] {
            "lat", "lng", "timestamp", "speed", "speed_kmh", "accuracy",
            "heading", "bearing", "altitude", "masked_for_privacy",
            "privacy_gap", "privacy_live_redacted", "privacy_zone_id",
            "resolved_speed_limit_kmh", "resolved_speed_tier"
        };
        for (String field : fields) {
            if (!source.has(field)) continue;
            try { point.put(field, source.opt(field)); } catch (Exception ignored) {}
        }
        return point;
    }

    private static void writeJsonValue(Object value, OutputStream output) throws Exception {
        if (value instanceof JSONObject) DriveSenseTripArchiveSerializer.write((JSONObject) value, output);
        else if (value instanceof JSONArray) {
            output.write(value.toString().getBytes(StandardCharsets.UTF_8));
        } else if (value == null || value == JSONObject.NULL) output.write("null".getBytes(StandardCharsets.UTF_8));
        else if (value instanceof Boolean || value instanceof Number) output.write(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
        else output.write(JSONObject.quote(String.valueOf(value)).getBytes(StandardCharsets.UTF_8));
    }

    private static byte[] encodeSegment(byte[] nonce, byte[] hash, byte[] ciphertext) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(ciphertext.length + 80);
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(MAGIC); output.writeInt(FORMAT_VERSION);
            output.writeInt(nonce.length); output.write(nonce);
            output.writeInt(hash.length); output.write(hash);
            output.writeInt(ciphertext.length - 16); output.writeInt(ciphertext.length); output.write(ciphertext);
        }
        return bytes.toByteArray();
    }

    private static byte[] segmentAad(String generation, String tripId, String sessionId, int index, int length, byte[] hash) {
        return DriveSenseEnvelopeCrypto.encode(
            "roadsage.trip.chunk.v1", generation, DOMAIN, Integer.toString(VERSION),
            tripId, sessionId, Integer.toString(index), Integer.toString(length), DriveSenseEnvelopeCrypto.hex(hash)
        );
    }

    private static byte[] wrapAad(String generation, String tripId, String sessionId, int kekVersion) {
        return DriveSenseEnvelopeCrypto.encode(
            "roadsage.active.dek.wrap.v1", generation, DOMAIN, tripId, sessionId, Integer.toString(kekVersion)
        );
    }

    private static byte[] monotonicNonce(int index) {
        ByteBuffer buffer = ByteBuffer.allocate(12);
        buffer.putInt(0); buffer.putLong(index & 0xffffffffL);
        return buffer.array();
    }

    private static String archiveGeneration(Context context) throws Exception {
        return DriveSenseStorageCoordinator.get(context).read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT archive_generation FROM archive_meta WHERE id=1", null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("archive_meta missing");
                return cursor.getString(0);
            }
        });
    }

    private static File activeRoot(Context context) {
        File root = new File(new File(context.getNoBackupFilesDir(), ROOT), ACTIVE);
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("ACTIVE_SPOOL_ROOT_UNAVAILABLE");
        return root;
    }

    private static void admit(Context context, long requiredBytes) {
        long available = DriveSenseStorageAdmission.availableBytes(context);
        if (requiredBytes < 0L || available - requiredBytes < SPACE_RESERVE_BYTES) {
            DriveSenseDurabilityJournal.record(
                context, "ERROR", "ACTIVE_SPOOL_SPACE_REFUSAL", null,
                requiredBytes, available, SPACE_RESERVE_BYTES, "LOW_SPACE_BLOCKED"
            );
            throw new IllegalStateException(
                "LOW_SPACE_BLOCKED required=" + requiredBytes + " available=" + available
            );
        }
    }

    private static String manifestContext(String sessionId) { return "native:active_trip_spool_manifest:" + sessionId; }
    private static String segmentName(int index) { return String.format(java.util.Locale.US, "%08d.rstc", index); }
    private static String randomToken() { byte[] value = new byte[24]; RANDOM.nextBytes(value); return Base64.encodeToString(value, Base64.NO_WRAP | Base64.URL_SAFE); }
    private static String requireId(String value) { String id = value == null ? "" : value.trim(); if (id.isEmpty() || id.length() > 128 || !id.matches("[A-Za-z0-9._:-]+")) throw new IllegalArgumentException("Invalid trip id"); return id; }
    private static String requireSession(String value) { String id = value == null ? "" : value.trim(); if (id.isEmpty() || id.length() > 80 || !id.matches("[A-Za-z0-9._-]+")) throw new IllegalArgumentException("Invalid session id"); return id; }
    private void requireOpen() { if (closed || dek == null) throw new IllegalStateException("ACTIVE_SPOOL_CLOSED"); }
    private void requireActiveOwner() { requireOpen(); if (!"ACTIVE".equals(state)) throw new IllegalStateException("ACTIVE_SPOOL_NOT_ACTIVE"); }
    private void requireToken(String token) { requireOpen(); if (token == null || !ownerToken.equals(token)) throw new IllegalStateException(ERROR_NOT_OWNER); }
    private void clearDek() { if (dek != null) { Arrays.fill(dek, (byte) 0); dek = null; } }
    private long durationSeconds(long nowMs) { return Math.max(0L, (nowMs - startTimeMs) / 1000L - Math.round(gapSeconds)); }
    private double averageSpeed(long nowMs) { long duration = durationSeconds(nowMs); return duration > 0 && distanceKm > 0 ? distanceKm / (duration / 3600d) : 0d; }

    private static long pointTimeMs(JSONObject point) {
        Object raw = point == null ? null : point.opt("timestamp");
        if (raw instanceof Number) return ((Number) raw).longValue();
        String value = raw == null ? "" : String.valueOf(raw);
        try { return java.time.Instant.parse(value).toEpochMilli(); }
        catch (Exception ignored) { try { return Long.parseLong(value); } catch (Exception invalid) { return System.currentTimeMillis(); } }
    }

    private static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        if (!Double.isFinite(lat1) || !Double.isFinite(lon1) || !Double.isFinite(lat2) || !Double.isFinite(lon2)) return Double.NaN;
        double radius = 6371d;
        double dLat = Math.toRadians(lat2 - lat1), dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return radius * 2d * Math.atan2(Math.sqrt(a), Math.sqrt(1d - a));
    }

    private static JSONArray jsonArray(Iterable<JSONObject> values) {
        JSONArray result = new JSONArray();
        for (JSONObject value : values) result.put(value);
        return result;
    }

    private static byte[] readBounded(File file, int maximum) throws Exception {
        if (file.length() < 0 || file.length() > maximum) throw new IllegalStateException("Bounded file exceeded");
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[8192]; int read, total = 0;
            while ((read = input.read(buffer)) != -1) { total += read; if (total > maximum) throw new IllegalStateException("Bounded file exceeded"); output.write(buffer, 0, read); }
            return output.toByteArray();
        }
    }

    private static long directoryBytes(File file) {
        if (file == null || !file.exists()) return 0L;
        if (file.isFile()) return Math.max(0L, file.length());
        long total = 0L; File[] children = file.listFiles(); if (children != null) for (File child : children) total += directoryBytes(child); return total;
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete()) Log.w(TAG, "Could not remove owned active spool path: " + file.getName());
    }
}
