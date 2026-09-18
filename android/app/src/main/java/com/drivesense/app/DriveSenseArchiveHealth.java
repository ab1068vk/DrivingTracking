package com.drivesense.app;

import android.database.Cursor;
import org.json.JSONObject;

final class DriveSenseArchiveHealth {
    private DriveSenseArchiveHealth() {}

    static JSONObject inventory(DriveSenseStorageCoordinator coordinator) throws Exception {
        JSONObject catalog = coordinator.read(db -> {
            try (Cursor cursor = db.rawQuery("SELECT archive_generation,authority_state,recovery_state,last_committed_seq,live_count,tip_chain_hash,pending_count,projection_required_seq,updated_at_ms FROM archive_meta WHERE id=1", null)) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("CANONICAL_MISSING: archive_meta unavailable");
                JSONObject result = new JSONObject();
                result.put("archiveGeneration", cursor.getString(0));
                result.put("authorityState", cursor.getString(1));
                result.put("recoveryState", cursor.getString(2));
                result.put("lastCommittedSeq", cursor.getLong(3));
                result.put("liveCount", cursor.getLong(4));
                result.put("tipChainHash", android.util.Base64.encodeToString(cursor.getBlob(5), android.util.Base64.NO_WRAP));
                result.put("pendingCount", cursor.getLong(6));
                result.put("projectionRequiredSeq", cursor.getLong(7));
                result.put("updatedAtMs", cursor.getLong(8));
                return result;
            }
        });
        JSONObject sentinel = DriveSenseArchiveSentinelStore.read(coordinator);
        boolean sentinelPresent = sentinel != null;
        boolean match = sentinelPresent &&
            catalog.optString("archiveGeneration").equals(sentinel.optString("archiveGeneration")) &&
            catalog.optLong("lastCommittedSeq") == sentinel.optLong("lastCommittedSeq") &&
            catalog.optLong("liveCount") == sentinel.optLong("liveCount") &&
            catalog.optString("tipChainHash").equals(sentinel.optString("tipChainHash"));
        catalog.put("sentinelPresent", sentinelPresent);
        catalog.put("sentinelMatches", match);
        // This process-local signal lets an explicitly gated Physical H web
        // bundle rebuild its disposable projection without changing the
        // persisted authority_state. Production never enables this override.
        catalog.put("testAuthorityEnabled", DriveSenseP35Flags.testAuthorityEnabled());
        catalog.put("fastHealthOnly", true);
        catalog.put("fullSetVerifiedOnThisRead", false);
        JSONObject integrity = coordinator.read(db -> {
            long checkpointThrough=0L,checkpointEventSeq=0L;boolean active=false;
            try(Cursor cursor=db.rawQuery("SELECT COALESCE(MAX(through_seq),0),COALESCE(MAX(checkpoint_event_seq),0) FROM integrity_checkpoint_jobs WHERE state IN ('COMMITTED','P5_ACTIVE')",null)){if(cursor.moveToFirst()){checkpointThrough=cursor.getLong(0);checkpointEventSeq=cursor.getLong(1);}}
            try(Cursor cursor=db.rawQuery("SELECT 1 FROM integrity_checkpoint_jobs WHERE state='P5_ACTIVE' LIMIT 1",null)){active=cursor.moveToFirst();}
            JSONObject value=new JSONObject();value.put("active",active);value.put("checkpointThroughSeq",checkpointThrough);value.put("checkpointEventSeq",checkpointEventSeq);return value;
        });
        boolean integrityDue=integrity.optBoolean("active")||integrity.optLong("checkpointEventSeq")<catalog.optLong("lastCommittedSeq");
        integrity.put("due",integrityDue);integrity.put("suspicion",!"HEALTHY".equals(catalog.optString("recoveryState"))||!match);
        catalog.put("integrity",integrity);catalog.put("integrityDue",integrityDue);catalog.put("integritySuspicion",integrity.optBoolean("suspicion"));
        JSONObject speed = coordinator.read(db -> { try (Cursor cursor = db.rawQuery("SELECT speed_generation,last_seq,bucket_count,integrity_tip,recovery_state FROM speed_state WHERE id=1", null)) { if(!cursor.moveToFirst()) throw new IllegalStateException("SPEED_CANONICAL_MISSING"); JSONObject value=new JSONObject();value.put("speedGeneration",cursor.getString(0));value.put("speedLastSeq",cursor.getLong(1));value.put("speedBucketCount",cursor.getLong(2));value.put("speedIntegrityTip",android.util.Base64.encodeToString(cursor.getBlob(3),android.util.Base64.NO_WRAP));value.put("speedRecoveryState",cursor.getString(4));return value; } });
        boolean speedMatch=sentinelPresent&&speed.optString("speedGeneration").equals(sentinel.optString("speedGeneration"))&&speed.optLong("speedLastSeq")==sentinel.optLong("speedLastSeq")&&speed.optLong("speedBucketCount")==sentinel.optLong("speedBucketCount")&&speed.optString("speedIntegrityTip").equals(sentinel.optString("speedIntegrityTip"));
        catalog.put("speed",speed);catalog.put("speedSentinelMatches",speedMatch);
        if (!sentinelPresent && catalog.optLong("lastCommittedSeq") <= 1L && catalog.optLong("liveCount") == 0L) {
            DriveSenseArchiveSentinelStore.writeFromCatalog(coordinator);
            catalog.put("sentinelPresent", true);
            catalog.put("sentinelMatches", true);
        } else if (!match || !speedMatch) {
            catalog.put("recoveryState", "RECOVERY_REQUIRED");
            catalog.put("healthCode", !match ? "SENTINEL_CATALOG_DIVERGENCE" : "SPEED_SENTINEL_CATALOG_DIVERGENCE");
        } else {
            catalog.put("healthCode", "FAST_HEALTHY");
        }
        return catalog;
    }
}
