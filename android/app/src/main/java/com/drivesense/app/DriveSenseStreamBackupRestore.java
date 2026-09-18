package com.drivesense.app;

import android.content.ContentValues;
import android.database.Cursor;
import android.util.Base64;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Two-pass bounded-memory reader for road-sage-stream-backup v2.
 *
 * Pass one authenticates the complete file, record order, record hashes, counts,
 * trailer, and absence of trailing bytes. Only a completely verified file may
 * reach pass two. Pass two decrypts one frame at a time into operation-owned
 * spools and re-encrypts each record under fresh device-bound envelope keys.
 */
final class DriveSenseStreamBackupRestore {
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final long SPACE_RESERVE_BYTES = 256L * 1024L * 1024L;
    private final DriveSenseTripArchiveRepository trips;
    private final DriveSenseSpeedArchiveRepository speed;
    private final DriveSenseStorageCoordinator coordinator;
    private final File operationDirectory;
    interface CancellationCheck { void check() throws Exception; }
    private static final CancellationCheck NEVER_CANCELLED = () -> { };
    private static volatile String faultPointForTests;

    static void setFaultPointForTests(String point) { faultPointForTests = point; }

    private static void injectFaultForTests(String point) {
        if (point.equals(faultPointForTests)) {
            faultPointForTests = null;
            throw new IllegalStateException("FAULT_" + point);
        }
    }

    DriveSenseStreamBackupRestore(DriveSenseTripArchiveRepository trips, DriveSenseSpeedArchiveRepository speed) {
        this.trips = trips;
        this.speed = speed;
        this.coordinator = trips.coordinator();
        this.operationDirectory = new File(coordinator.context().getNoBackupFilesDir(), "roadsage_stream_restore_v2");
        if (!operationDirectory.exists() && !operationDirectory.mkdirs()) {
            throw new IllegalStateException("Restore operation directory unavailable");
        }
    }

    JSONObject restore(File source, char[] passphrase) throws Exception {
        return restore(source, passphrase, NEVER_CANCELLED);
    }

    JSONObject restore(File source, char[] passphrase, CancellationCheck cancellation) throws Exception {
        if (source == null || !source.isFile()) throw new IllegalArgumentException("Portable backup is unavailable");
        if (passphrase == null || passphrase.length < 8 || passphrase.length > 1024) {
            throw new IllegalArgumentException("Portable backup password must contain 8-1024 characters");
        }
        recoverInterruptedRestore();
        ensureEmptyTarget();
        String operationId = UUID.randomUUID().toString();
        byte[] key = null;
        try {
            Header header = readHeader(source, passphrase);
            key = header.key;
            Verified verified = scan(source, header, null, cancellation);
            beginOperation(operationId, verified);
            RestoreSink sink = new RestoreSink(operationId, verified);
            try {
                scan(source, header, sink, cancellation);
                sink.finish();
                if (sink.tripCount != verified.tripCount || sink.speedCount != verified.speedCount || sink.domainCount != verified.domainCount) {
                    throw new SecurityException("Portable backup restore count mismatch");
                }
                finishOperation(operationId, verified);
                JSONObject result = new JSONObject();
                result.put("verified", true);
                result.put("operationId", operationId);
                result.put("tripCount", sink.tripCount);
                result.put("speedBucketCount", sink.speedCount);
                result.put("portableDomainCount", sink.domainCount);
                result.put("boundedFrameBytes", DriveSenseStreamBackupManager.MAX_FRAME);
                result.put("authorityState", "NATIVE");
                return result;
            } catch (Exception error) {
                sink.abort();
                failOperation(operationId, error);
                throw error;
            }
        } finally {
            Arrays.fill(passphrase, '\0');
            if (key != null) Arrays.fill(key, (byte) 0);
        }
    }

    private void recoverInterruptedRestore() throws Exception {
        boolean interrupted=coordinator.read(db->{try(Cursor c=db.rawQuery("SELECT 1 FROM open_operations WHERE operation_type='BACKUP_V2_RESTORE' LIMIT 1",null)){return c.moveToFirst();}});
        if(!interrupted)return;
        trips.rolloverGenerationForIdentityErasure("interrupted_backup_restore_rollback");
        speed.rolloverGeneration("interrupted_backup_restore_rollback");
        DriveSenseDurabilityJournal.record(coordinator.context(),"WARN","BACKUP_V2_RESTORE_ROLLED_BACK",null,0,0,0,"HEALTHY");
    }

    Verified verifyOnly(File source, char[] passphrase) throws Exception {
        Header header = readHeader(source, passphrase);
        try { return scan(source, header, null, NEVER_CANCELLED); }
        finally { Arrays.fill(header.key, (byte) 0); Arrays.fill(passphrase, '\0'); }
    }

    private Header readHeader(File source, char[] passphrase) throws Exception {
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(source)))) {
            byte[] magic = new byte[DriveSenseStreamBackupManager.MAGIC.length];
            input.readFully(magic);
            if (!Arrays.equals(magic, DriveSenseStreamBackupManager.MAGIC)) throw new SecurityException("Backup magic mismatch");
            int length = input.readInt();
            if (length < 2 || length > MAX_HEADER_BYTES) throw new SecurityException("Backup header invalid");
            byte[] encoded = new byte[length];
            input.readFully(encoded);
            JSONObject value = new JSONObject(new String(encoded, StandardCharsets.UTF_8));
            if (!"road-sage-stream-backup".equals(value.optString("format")) || value.optInt("version") != 2 ||
                !"ARGON2ID".equals(value.optString("kdf")) || value.optInt("timeCost") != DriveSenseStreamBackupManager.ARGON2_TIME_COST ||
                value.optInt("memoryKiB") != DriveSenseStreamBackupManager.ARGON2_MEMORY_KIB) {
                throw new SecurityException("Unsupported portable backup header");
            }
            byte[] salt = Base64.decode(value.getString("salt"), Base64.NO_WRAP);
            if (salt.length != 16) throw new SecurityException("Backup salt invalid");
            byte[] key = DriveSenseStreamBackupManager.deriveKey(passphrase, salt);
            return new Header(value, encoded, MessageDigest.getInstance("SHA-256").digest(encoded), key);
        }
    }

    private Verified scan(File source, Header header, RestoreSink sink, CancellationCheck cancellation) throws Exception {
        MessageDigest rolling = MessageDigest.getInstance("SHA-256");
        rolling.update(DriveSenseStreamBackupManager.MAGIC);
        rolling.update(ByteBuffer.allocate(4).putInt(header.encoded.length).array());
        rolling.update(header.encoded);
        byte[] previous = new byte[32];
        long expectedIndex = 0, tripCount = 0, speedCount = 0, domainCount = 0;
        RecordVerifier record = null;
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(source)))) {
            long headerBytes = DriveSenseStreamBackupManager.MAGIC.length + 4L + header.encoded.length;
            byte[] discard = new byte[8192];
            while (headerBytes > 0L) {
                int read = input.read(discard, 0, (int)Math.min(discard.length, headerBytes));
                if (read < 0) throw new EOFException("Truncated backup header");
                headerBytes -= read;
            }
            while (true) {
                cancellation.check();
                int type;
                try { type = input.readInt(); }
                catch (EOFException error) { throw new SecurityException("Backup trailer missing"); }
                long index = input.readLong();
                int nonceLength = input.readInt();
                int cipherLength = input.readInt();
                if (index != expectedIndex++ || nonceLength != 12 || cipherLength < 16 || cipherLength > DriveSenseStreamBackupManager.MAX_FRAME + 16) {
                    throw new SecurityException("Backup frame invalid");
                }
                byte[] nonce = new byte[nonceLength];
                byte[] ciphertext = new byte[cipherLength];
                input.readFully(nonce);
                input.readFully(ciphertext);
                byte[] expectedNonce = ByteBuffer.allocate(12).putInt(0).putLong(index).array();
                if (!Arrays.equals(nonce, expectedNonce)) throw new SecurityException("Backup frame nonce mismatch");
                byte[] aad = DriveSenseEnvelopeCrypto.encode(
                    "roadsage.stream.backup.frame.v2", DriveSenseEnvelopeCrypto.hex(header.hash), Integer.toString(type),
                    Long.toString(index), Integer.toString(cipherLength - 16), DriveSenseEnvelopeCrypto.hex(previous)
                );
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(header.key, "AES"), new GCMParameterSpec(128, nonce));
                cipher.updateAAD(aad);
                byte[] plain;
                try { plain = cipher.doFinal(ciphertext); }
                catch (java.security.GeneralSecurityException error) {
                    throw new SecurityException("Backup frame authentication failed", error);
                }
                if (type == 127) {
                    if (record != null) { record.verify(); if (sink != null) sink.endRecord(); record = null; }
                    cancellation.check();
                    JSONObject trailer = verifyTrailer(plain, rolling.digest(), header);
                    if (input.read() != -1) throw new SecurityException("Backup trailing bytes");
                    if (trailer.getLong("tripCount") != tripCount || trailer.getLong("speedBucketCount") != speedCount || trailer.optLong("portableDomainCount",0) != domainCount) {
                        throw new SecurityException("Backup record count mismatch");
                    }
                    Arrays.fill(plain, (byte) 0);
                    return new Verified(header.value, tripCount, speedCount, domainCount);
                }
                byte[] encodedFrame = encodeFrame(type, index, nonce, ciphertext);
                rolling.update(encodedFrame);
                previous = MessageDigest.getInstance("SHA-256").digest(encodedFrame);
                Arrays.fill(encodedFrame, (byte) 0);
                Arrays.fill(ciphertext, (byte) 0);

                if (type == 1 || type == 3 || type == 5) {
                    if (record != null) { record.verify(); if (sink != null) sink.endRecord(); }
                    JSONObject metadata = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                    record = RecordVerifier.begin(type, metadata);
                    if (type == 1) tripCount++; else if(type == 3) speedCount++; else domainCount++;
                    if (sink != null) sink.beginRecord(type, metadata);
                } else if (type == 2 || type == 4 || type == 6) {
                    if (record == null || (type == 2 && record.type != 1) || (type == 4 && record.type != 3) || (type == 6 && record.type != 5)) {
                        throw new SecurityException("Backup frame order invalid");
                    }
                    record.append(plain);
                    if (sink != null) sink.append(plain);
                } else {
                    throw new SecurityException("Unknown backup frame type");
                }
                Arrays.fill(plain, (byte) 0);
            }
        } catch (EOFException error) {
            throw new SecurityException("Backup frame truncated", error);
        }
    }

    private JSONObject verifyTrailer(byte[] encoded, byte[] rollingHash, Header header) throws Exception {
        JSONObject trailer = new JSONObject(new String(encoded, StandardCharsets.UTF_8));
        if (!header.value.optString("archiveGeneration").equals(trailer.optString("archiveGeneration")) ||
            header.value.optLong("throughSeq") != trailer.optLong("throughSeq") ||
            !header.value.optString("speedGeneration").equals(trailer.optString("speedGeneration")) ||
            header.value.optLong("speedThroughSeq") != trailer.optLong("speedThroughSeq") ||
            !DriveSenseEnvelopeCrypto.hex(rollingHash).equals(trailer.optString("rollingCiphertextHash")) ||
            trailer.optLong("tripCount", -1) < 0 || trailer.optLong("speedBucketCount", -1) < 0 || trailer.optLong("portableDomainCount", -1) < 0) {
            throw new SecurityException("Backup trailer snapshot mismatch");
        }
        String supplied = trailer.optString("hmac", "");
        trailer.remove("hmac");
        byte[] commitment = trailer.toString().getBytes(StandardCharsets.UTF_8);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(header.key, "HmacSHA256"));
        String expected = DriveSenseEnvelopeCrypto.hex(mac.doFinal(DriveSenseEnvelopeCrypto.encode(
            "roadsage.stream.backup.trailer.v2", DriveSenseEnvelopeCrypto.hex(commitment)
        )));
        Arrays.fill(commitment, (byte) 0);
        if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), supplied.getBytes(StandardCharsets.US_ASCII))) {
            throw new SecurityException("Backup trailer HMAC mismatch");
        }
        trailer.put("hmac", supplied);
        return trailer;
    }

    private void ensureEmptyTarget() throws Exception {
        long[] counts = coordinator.read(db -> {
            try (Cursor trips = db.rawQuery("SELECT live_count FROM archive_meta WHERE id=1", null);
                 Cursor speed = db.rawQuery("SELECT bucket_count FROM speed_state WHERE id=1", null)) {
                trips.moveToFirst(); speed.moveToFirst(); return new long[]{trips.getLong(0), speed.getLong(0)};
            }
        });
        if (counts[0] != 0 || counts[1] != 0) throw new IllegalStateException("RESTORE_REQUIRES_EMPTY_CANONICAL_TARGET");
    }

    private void beginOperation(String id, Verified verified) throws Exception {
        coordinator.exclusive(db -> {
            db.beginTransaction();
            try {
                ContentValues operation = new ContentValues();
                operation.put("operation_id", id); operation.put("operation_type", "BACKUP_V2_RESTORE");
                operation.put("state", "VERIFIED_IMPORTING"); operation.put("owner_token", id);
                operation.put("created_at_ms", System.currentTimeMillis()); operation.put("updated_at_ms", System.currentTimeMillis());
                db.insertOrThrow("open_operations", null, operation);
                db.execSQL("UPDATE archive_meta SET authority_state='MIGRATING',updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return null;
        });
    }

    private void finishOperation(String id, Verified verified) throws Exception {
        coordinator.exclusive(db -> {
            db.beginTransaction();
            try {
                long tripCount, speedCount;
                try (Cursor c = db.rawQuery("SELECT live_count FROM archive_meta WHERE id=1", null)) { c.moveToFirst(); tripCount = c.getLong(0); }
                try (Cursor c = db.rawQuery("SELECT bucket_count FROM speed_state WHERE id=1", null)) { c.moveToFirst(); speedCount = c.getLong(0); }
                if (tripCount != verified.tripCount || speedCount != verified.speedCount) throw new SecurityException("Restored canonical count mismatch");
                // P5 execution/derived state is never imported.  Rebuild it
                // from the verified restored owners in bounded foreground
                // turns; local journal intake and privacy receipts remain
                // with their existing owners.
                try(Cursor stages=db.rawQuery("SELECT j.archive_generation,j.job_id,s.chunk_index,s.encoded_bytes FROM trip_retention_jobs j JOIN retention_stage_chunks s ON s.job_id=j.job_id",null)){
                    while(stages.moveToNext())DriveSenseArchiveUnlinkDebt.record(db,DriveSenseRetentionStage.debtPath(stages.getString(0),stages.getString(1),stages.getInt(2)),stages.getLong(3),"restore_cutover_stage");
                }
                db.delete("retention_stage_chunks",null,null);
                db.delete("trip_retention_jobs",null,null);
                db.delete("trip_retention_due",null,null);
                db.delete("integrity_checkpoint_jobs",null,null);
                db.delete("archive_blob_inventory",null,null);
                db.delete("archive_deep_audit_jobs",null,null);
                db.delete("kek_reference_repair_counts",null,null);
                db.delete("encrypted_file_key_registry","domain_id='retention_stage'",null);
                db.execSQL("UPDATE journal_summary SET state='DIRTY',archive_generation=NULL,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE journal_repair_state SET state='DIRTY',cursor='',generation=NULL,examined=0,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE rotation_state SET count_state='DIRTY',repair_domain='trip_archive',repair_cursor_kek=-1,repair_cursor_state='',repair_cursor_id='',repair_cursor_revision=-1,zero_proof=0,updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE p5_control_state SET retention_policy_version=NULL,retention_raw_days=0,retention_motion_days=0,retention_index_state='BACKFILL_REQUIRED',kek_count_state='DIRTY',blob_inventory_state='BACKFILL_REQUIRED',journal_state='DIRTY',updated_at_ms=? WHERE id=1",new Object[]{System.currentTimeMillis()});
                String restoredTripGeneration;String restoredSpeedGeneration;long restoredThroughSeq;
                try(Cursor c=db.rawQuery("SELECT archive_generation,last_committed_seq FROM archive_meta WHERE id=1",null)){c.moveToFirst();restoredTripGeneration=c.getString(0);restoredThroughSeq=c.getLong(1);}
                try(Cursor c=db.rawQuery("SELECT speed_generation FROM speed_state WHERE id=1",null)){c.moveToFirst();restoredSpeedGeneration=c.getString(0);}
                long p6Now=System.currentTimeMillis();
                db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,applied_version=0,state='REBUILD_REQUIRED',complete=0,writers_enabled=0,cursor=NULL,storage_outcome='RESTORE_CUTOVER',updated_at_ms=? WHERE domain_id IN ('D1_ANALYTICS','D2_GEOMETRY','D3_SPATIAL_SELECTION')",
                    new Object[]{restoredTripGeneration,restoredThroughSeq,p6Now});
                db.execSQL("UPDATE p6_control SET source_binding=?,required_version=?,applied_version=0,state='REBUILD_REQUIRED',complete=0,writers_enabled=0,cursor=NULL,storage_outcome=?,updated_at_ms=? WHERE domain_id='D4_ROAD_LEARNING_SPEED_LOOKUP'",
                    new Object[]{restoredTripGeneration,restoredThroughSeq,"RESTORE_CUTOVER:"+restoredSpeedGeneration,p6Now});
                db.execSQL("UPDATE archive_meta SET authority_state='NATIVE',recovery_state='HEALTHY',updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
                db.delete("open_operations", "operation_id=?", new String[]{id});
                db.setTransactionSuccessful();
            } finally { db.endTransaction(); }
            return null;
        });
        DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
    }

    private void failOperation(String id, Exception error) {
        try {
            coordinator.exclusive(db -> {
                db.execSQL("UPDATE archive_meta SET authority_state='RECOVERY_REQUIRED',recovery_state='RECOVERY_REQUIRED',updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
                db.execSQL("UPDATE open_operations SET state='FAILED',updated_at_ms=? WHERE operation_id=?", new Object[]{System.currentTimeMillis(), id});
                return null;
            });
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
        } catch (Exception ignored) { }
        DriveSenseDurabilityJournal.record(coordinator.context(), "CRITICAL", "BACKUP_V2_RESTORE_FAILED", id, 0, 0, 0, "RECOVERY_REQUIRED");
    }

    private static byte[] encodeFrame(int type, long index, byte[] nonce, byte[] ciphertext) throws Exception {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(ciphertext.length + 32);
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(type); output.writeLong(index); output.writeInt(nonce.length); output.writeInt(ciphertext.length);
            output.write(nonce); output.write(ciphertext);
        }
        return bytes.toByteArray();
    }

    private static byte[] parseHash(String value) {
        if (value == null || !value.matches("[0-9a-fA-F]{64}")) throw new IllegalArgumentException("Portable record hash invalid");
        byte[] out = new byte[32];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static final class Header {
        final JSONObject value; final byte[] encoded, hash, key;
        Header(JSONObject value, byte[] encoded, byte[] hash, byte[] key) { this.value=value; this.encoded=encoded; this.hash=hash; this.key=key; }
    }

    static final class Verified {
        final JSONObject header; final long tripCount, speedCount, domainCount;
        Verified(JSONObject header, long tripCount, long speedCount, long domainCount) { this.header=header; this.tripCount=tripCount; this.speedCount=speedCount; this.domainCount=domainCount; }
    }

    static final class RecordVerifier {
        final int type, expectedChunks; final long expectedBytes; final byte[] expectedHash; final String identityFingerprint;
        final MessageDigest digest; long bytes; int chunks;
        static RecordVerifier begin(int type, JSONObject metadata) throws Exception {
            String identity = type == 1 ? metadata.optString("tripId") : type == 3 ? metadata.optString("bucketId") : metadata.optString("domainId");
            if (identity.isEmpty()) throw new SecurityException("Backup record identity missing");
            long bytes = metadata.optLong("payloadBytes", -1); int chunks = metadata.optInt("chunkCount", -1);
            if (bytes < 1 || chunks < 1) throw new SecurityException("Backup record manifest invalid");
            return new RecordVerifier(type, bytes, chunks, parseHash(metadata.optString("payloadHash")),
                DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8))).substring(0,16));
        }
        RecordVerifier(int type,long expectedBytes,int expectedChunks,byte[] expectedHash,String identityFingerprint)throws Exception{this.type=type;this.expectedBytes=expectedBytes;this.expectedChunks=expectedChunks;this.expectedHash=expectedHash;this.identityFingerprint=identityFingerprint;this.digest=MessageDigest.getInstance("SHA-256");}
        void append(byte[] value){bytes+=value.length;chunks++;digest.update(value);if(bytes>expectedBytes||chunks>expectedChunks)throw new SecurityException("Backup record exceeded manifest");}
        void verify(){byte[]actual=digest.digest();boolean hashMatches=MessageDigest.isEqual(actual,expectedHash);if(bytes!=expectedBytes||chunks!=expectedChunks||!hashMatches)throw new SecurityException("Backup record manifest mismatch:type="+type+",id="+identityFingerprint+",bytes="+bytes+"/"+expectedBytes+",chunks="+chunks+"/"+expectedChunks+",hash="+hashMatches);}
    }

    private final class RestoreSink {
        final String operationId; final Verified verified; File spool; FileOutputStream output; JSONObject metadata; int type;
        final List<DriveSensePortableBackupDomains.Record> domains=new ArrayList<>();
        long tripCount, speedCount, domainCount;
        RestoreSink(String operationId, Verified verified){this.operationId=operationId;this.verified=verified;}
        void beginRecord(int type,JSONObject metadata)throws Exception{
            this.type=type;this.metadata=metadata;this.spool=new File(operationDirectory,operationId+"."+(tripCount+speedCount+domainCount)+".spool");
            long expected=metadata.getLong("payloadBytes");long available=DriveSenseStorageAdmission.availableBytes(coordinator.context());
            if(available-expected<SPACE_RESERVE_BYTES)throw new IllegalStateException("LOW_SPACE_BLOCKED");
            this.output=new FileOutputStream(spool,false);
        }
        void append(byte[] plain)throws Exception{output.write(plain);}
        void endRecord()throws Exception{
            if(output==null)return;output.flush();output.getFD().sync();output.close();output=null;
            byte[] expected=parseHash(metadata.getString("payloadHash"));
            try{
                if(type==1){trips.commitSpool(spool,metadata.getString("tripId"),"backup_v2_restore");tripCount++;injectFaultForTests("AFTER_FIRST_RESTORED_RECORD");}
                else if(type==3){speed.restoreSpool(spool,metadata.getString("bucketId"),metadata.optInt("cellCount",0),expected);speedCount++;injectFaultForTests("AFTER_FIRST_RESTORED_RECORD");}
                else{
                    if(spool.length()>DriveSensePortableBackupDomains.MAX_DOMAIN_BYTES)throw new SecurityException("Portable domain exceeded byte ceiling");
                    byte[] bytes=new byte[(int)spool.length()];try(FileInputStream input=new FileInputStream(spool)){int offset=0,read;while(offset<bytes.length&&(read=input.read(bytes,offset,bytes.length-offset))!=-1)offset+=read;if(offset!=bytes.length)throw new EOFException("Portable domain truncated");}
                    domains.add(new DriveSensePortableBackupDomains.Record(metadata.getString("domainId"),bytes));domainCount++;
                }
            }finally{try{SecureDeleteHelper.secureWipeFile(spool);}catch(Exception ignored){if(spool.exists())spool.delete();}spool=null;metadata=null;}
        }
        void finish()throws Exception{endRecord();new DriveSensePortableBackupDomains(coordinator.context()).applyVerified(domains);for(DriveSensePortableBackupDomains.Record record:domains)record.clear();domains.clear();}
        void abort(){try{if(output!=null)output.close();}catch(Exception ignored){}if(spool!=null){try{SecureDeleteHelper.secureWipeFile(spool);}catch(Exception ignored){spool.delete();}}for(DriveSensePortableBackupDomains.Record record:domains)record.clear();domains.clear();}
    }
}
