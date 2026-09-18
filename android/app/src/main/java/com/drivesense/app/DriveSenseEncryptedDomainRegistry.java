package com.drivesense.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Authoritative encrypted-domain inventory and key-retirement proof router. */
final class DriveSenseEncryptedDomainRegistry {
    static final String ENVELOPE_KEK = "ENVELOPE_KEK";
    static final String LEGACY_PAYLOAD_KEY = "LEGACY_PAYLOAD_KEY";
    static final String MIXED = "ENVELOPE_KEK_AND_LEGACY_PAYLOAD_KEY";

    static final class Domain {
        final String id, storage, aadVersion, rotation, portability, keyFamily, proofStrategy;
        Domain(String id, String storage, String aadVersion, String rotation, String portability,
               String keyFamily, String proofStrategy) {
            this.id = id;
            this.storage = storage;
            this.aadVersion = aadVersion;
            this.rotation = rotation;
            this.portability = portability;
            this.keyFamily = keyFamily;
            this.proofStrategy = proofStrategy;
        }
    }

    private static Domain envelope(String id, String storage, String aad, String rotation, String portability) {
        return new Domain(id, storage, aad, rotation, portability, ENVELOPE_KEK, "REFERENCE_SCANNER");
    }

    private static Domain legacy(String id, String storage, String aad, String rotation, String portability) {
        return new Domain(id, storage, aad, rotation, portability, LEGACY_PAYLOAD_KEY, "SEPARATE_KEY_FAMILY_RETIREMENT_BLOCKED");
    }

    private static final List<Domain> DOMAINS = Collections.unmodifiableList(Arrays.asList(
        envelope("trip_archive", "native_catalog_chunks", "roadsage.trip.*.v1", "DEK_REWRAP", "PORTABLE_REENCRYPT"),
        envelope("speed_buckets", "native_speed_buckets", "roadsage.speed.bucket.v1", "DEK_REWRAP", "PORTABLE_REENCRYPT"),
        envelope("trip_derived", "native_p6_trip_derived", "roadsage.p6.trip.derived.v1", "DEK_REWRAP", "REBUILDABLE_EXCLUDED"),
        envelope("speed_derived", "native_p6_speed_derived", "roadsage.p6.speed.derived.v1", "DEK_REWRAP", "REBUILDABLE_EXCLUDED"),
        new Domain("completed_trip_journal", "completed_trip_journal_v1", "native:completed_trip_*",
            "DEK_REWRAP_BLOCKED_WHILE_PENDING", "NOT_PORTABLE", MIXED, "REFERENCE_SCANNER"),
        envelope("active_trip_spool", "roadsage_trip_archive_v1/active_spools", "roadsage.trip.chunk.v1:trip_stream",
            "DEK_REWRAP_BLOCKED_WHILE_ACTIVE", "NOT_PORTABLE"),
        envelope("retention_stage", "roadsage_trip_archive_v1/p5_retention", "roadsage.retention.stage.v1",
            "DEK_REWRAP_BLOCKED_WHILE_STAGED", "NOT_PORTABLE"),
        legacy("active_trip_checkpoint", "active_trip_checkpoint.enc", "native:active_trip_checkpoint", "LEGACY_REENCRYPT", "NOT_PORTABLE"),
        legacy("privacy_cell", "CapacitorStorage:drivesense_privacy_cell_key_v1", "storage:drivesense_privacy_cell_key_v1", "LEGACY_REENCRYPT", "POLICY_ONLY"),
        legacy("rotation_log", "CapacitorStorage:drivesense_key_rotation_log_v1", "storage:drivesense_key_rotation_log_v1", "LEGACY_REENCRYPT", "NOT_PORTABLE"),
        legacy("speed_legacy_family", "Preferences/IDB speed legacy/write_ahead/mirror", "storage:speed_knowledge_*", "LEGACY_REENCRYPT", "MIGRATION_SOURCE"),
        legacy("trip_fallback", "CapacitorStorage:drivesense_trips", "storage:drivesense_trips", "LEGACY_REENCRYPT", "MIGRATION_SOURCE"),
        legacy("speed_sign_review_images", "native/preferences", "native:speed_sign_review_image:*", "LEGACY_REENCRYPT", "OPTIONAL_EXPORT"),
        legacy("parking_photos", "native_files", "native:parking_photo:*", "LEGACY_REENCRYPT", "OPTIONAL_EXPORT"),
        legacy("road_data_queue", "native_files", "native:road_data_queue:*", "LEGACY_REENCRYPT", "NOT_PORTABLE")
    ));

    private DriveSenseEncryptedDomainRegistry() {}

    static List<Domain> all() { return DOMAINS; }
    static boolean contains(String id) { for (Domain domain : DOMAINS) if (domain.id.equals(id)) return true; return false; }

    /**
     * Fresh proof for the native archive envelope-KEK family.  Domains using
     * DriveSensePayloadCrypto are included explicitly as separate-key-family
     * proofs; their old Android payload aliases remain retirement blockers in
     * the separate legacy rotation path.
     */
    static ReferenceProof proveEnvelopeKek(
        Context context,
        SQLiteDatabase database,
        int version,
        boolean otherThan
    ) {
        List<DomainProof> proofs = new ArrayList<>(DOMAINS.size());
        for (Domain domain : DOMAINS) {
            switch (domain.id) {
                case "trip_archive":
                    proofs.add(countProof(database, domain, "trip_archive", version, otherThan));
                    break;
                case "speed_buckets":
                    proofs.add(countProof(database, domain, "speed_archive", version, otherThan));
                    break;
                case "trip_derived":
                    proofs.add(countProof(database, domain, "trip_derived", version, otherThan));
                    break;
                case "speed_derived":
                    proofs.add(countProof(database, domain, "speed_derived", version, otherThan));
                    break;
                case "active_trip_spool": {
                    proofs.add(fileCountProof(database,domain,"active_trip_spool",version,otherThan));
                    break;
                }
                case "completed_trip_journal": {
                    proofs.add(fileCountProof(database,domain,"completed_trip_journal",version,otherThan));
                    break;
                }
                case "retention_stage": {
                    proofs.add(fileCountProof(database,domain,"retention_stage",version,otherThan));
                    break;
                }
                default:
                    if (!LEGACY_PAYLOAD_KEY.equals(domain.keyFamily)) {
                        proofs.add(new DomainProof(domain, 0, 0, true, "UNHANDLED_DOMAIN"));
                    } else {
                        proofs.add(new DomainProof(domain, 0, 0, false, "SEPARATE_KEY_FAMILY"));
                    }
                    break;
            }
        }
        return new ReferenceProof(version, otherThan, proofs);
    }

    private static DomainProof countProof(SQLiteDatabase db,Domain domain,String countDomain,int version,boolean otherThan){
        if(!DriveSenseKeyReferenceCounts.isVerified(db))return new DomainProof(domain,0,1,false,"COUNT_STATE_DIRTY");
        String sql="SELECT COALESCE(SUM(reference_count),0) FROM key_reference_counts WHERE domain_id=? AND key_version"+(otherThan?"<>?":"=?");
        try(Cursor cursor=db.rawQuery(sql,new String[]{countDomain,Integer.toString(version)})){
            if(!cursor.moveToFirst()||cursor.getLong(0)<0)return new DomainProof(domain,0,1,false,"EXACT_COUNT_MISSING");
            return new DomainProof(domain,cursor.getInt(0),0,false,otherThan?"EXACT_OTHER_VERSION_COUNT":"EXACT_VERSION_COUNT");
        } catch (Exception error) {
            return new DomainProof(domain,0,1,false,"EXACT_COUNT_FAILED");
        }
    }

    private static DomainProof fileCountProof(SQLiteDatabase db,Domain domain,String fileDomain,int version,boolean otherThan){
        if(!DriveSenseKeyReferenceCounts.isVerified(db))return new DomainProof(domain,0,1,false,"COUNT_STATE_DIRTY");
        try{
            int refs=0,unreadable=0;
            try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM encrypted_file_key_registry WHERE domain_id=? AND key_version"+(otherThan?"<>?":"=?"),new String[]{fileDomain,Integer.toString(version)})){if(!c.moveToFirst())unreadable++;else refs=c.getInt(0);}
            try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM encrypted_file_key_registry WHERE domain_id=? AND state<>'VERIFIED'",new String[]{fileDomain})){if(!c.moveToFirst())unreadable++;else unreadable+=c.getInt(0);}
            return new DomainProof(domain,refs,unreadable,false,"AUTHENTICATED_OWNER_REGISTRY");
        }catch(Exception error){return new DomainProof(domain,0,1,false,"OWNER_REGISTRY_FAILED");}
    }

    static final class DomainProof {
        final Domain domain;
        final int references, unreadable;
        final boolean retirementBlocker;
        final String evidence;
        DomainProof(Domain domain, int references, int unreadable, boolean retirementBlocker, String evidence) {
            this.domain = domain;
            this.references = references;
            this.unreadable = unreadable;
            this.retirementBlocker = retirementBlocker;
            this.evidence = evidence;
        }
        boolean provesZero() { return references == 0 && unreadable == 0 && !retirementBlocker; }
        JSONObject json() throws Exception {
            JSONObject out = new JSONObject();
            out.put("domain", domain.id);
            out.put("keyFamily", domain.keyFamily);
            out.put("strategy", domain.proofStrategy);
            out.put("evidence", evidence);
            out.put("references", references);
            out.put("unreadable", unreadable);
            out.put("retirementBlocker", retirementBlocker);
            return out;
        }
    }

    static final class ReferenceProof {
        final int keyVersion;
        final boolean otherThan;
        final List<DomainProof> domains;
        final long observedAtMs = System.currentTimeMillis();
        ReferenceProof(int keyVersion, boolean otherThan, List<DomainProof> domains) {
            this.keyVersion = keyVersion;
            this.otherThan = otherThan;
            this.domains = Collections.unmodifiableList(new ArrayList<>(domains));
        }
        int references() { int count = 0; for (DomainProof proof : domains) count += proof.references; return count; }
        int unreadable() { int count = 0; for (DomainProof proof : domains) count += proof.unreadable; return count; }
        int referencesFor(String domainId) {
            for (DomainProof proof : domains) if (proof.domain.id.equals(domainId)) return proof.references;
            return 0;
        }
        int unreadableFor(String domainId) {
            for (DomainProof proof : domains) if (proof.domain.id.equals(domainId)) return proof.unreadable;
            return 0;
        }
        boolean provesZero() {
            if (domains.size() != DOMAINS.size()) return false;
            for (DomainProof proof : domains) if (!proof.provesZero()) return false;
            return true;
        }
        JSONObject json() throws Exception {
            JSONObject out = new JSONObject();
            out.put("keyVersion", keyVersion);
            out.put("otherThan", otherThan);
            out.put("observedAtMs", observedAtMs);
            out.put("references", references());
            out.put("unreadable", unreadable());
            out.put("complete", provesZero());
            JSONArray rows = new JSONArray();
            for (DomainProof proof : domains) rows.put(proof.json());
            out.put("domains", rows);
            return out;
        }
    }
}
