package com.drivesense.app;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.UUID;

final class DriveSenseArchiveOpenHelper extends SQLiteOpenHelper {
    static final String DATABASE_NAME = "roadsage_native_archive_v1.db";
    static final int DATABASE_VERSION = 8;

    DriveSenseArchiveOpenHelper(Context context) {
        super(context.getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
        applyPragma(db, "PRAGMA synchronous=FULL");
        applyPragma(db, "PRAGMA secure_delete=ON");
        applyPragma(db, "PRAGMA busy_timeout=5000");
        applyPragma(db, "PRAGMA wal_autocheckpoint=256");
    }

    private static void applyPragma(SQLiteDatabase db, String pragma) {
        try (android.database.Cursor ignored = db.rawQuery(pragma, null)) {
            if (ignored.moveToFirst()) ignored.getString(0);
        }
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE archive_meta (" +
            "id INTEGER PRIMARY KEY CHECK(id=1)," +
            "schema_version INTEGER NOT NULL," +
            "archive_generation TEXT NOT NULL," +
            "authority_state TEXT NOT NULL," +
            "recovery_state TEXT NOT NULL," +
            "last_committed_seq INTEGER NOT NULL DEFAULT 0," +
            "live_count INTEGER NOT NULL DEFAULT 0," +
            "tip_chain_hash BLOB NOT NULL," +
            "pending_count INTEGER NOT NULL DEFAULT 0," +
            "projection_required_seq INTEGER NOT NULL DEFAULT 0," +
            "updated_at_ms INTEGER NOT NULL)");

        db.execSQL("CREATE TABLE trip_revisions (" +
            "trip_id TEXT NOT NULL," +
            "revision INTEGER NOT NULL," +
            "operation_id TEXT NOT NULL," +
            "commit_state TEXT NOT NULL," +
            "seq INTEGER," +
            "retired_seq INTEGER," +
            "start_time_ms INTEGER NOT NULL DEFAULT 0," +
            "end_time_ms INTEGER NOT NULL DEFAULT 0," +
            "status TEXT NOT NULL," +
            "vehicle_id TEXT," +
            "point_count INTEGER NOT NULL DEFAULT 0," +
            "distance REAL NOT NULL DEFAULT 0," +
            "duration REAL NOT NULL DEFAULT 0," +
            "score REAL," +
            "score_safety REAL," +
            "score_smoothness REAL," +
            "score_status TEXT," +
            "needs_rescore INTEGER NOT NULL DEFAULT 0," +
            "plaintext_bytes INTEGER NOT NULL," +
            "ciphertext_bytes INTEGER NOT NULL DEFAULT 0," +
            "payload_hash BLOB NOT NULL," +
            "metadata_hash BLOB NOT NULL," +
            "chunk_count INTEGER NOT NULL," +
            "wrapped_dek BLOB NOT NULL," +
            "wrap_nonce BLOB NOT NULL," +
            "wrap_algorithm_version INTEGER NOT NULL," +
            "kek_version INTEGER NOT NULL," +
            "schema_version INTEGER NOT NULL," +
            "supersedes_revision INTEGER," +
            "expires_at_ms INTEGER," +
            "raw_gps_expires_at_ms INTEGER," +
            "committed_at_ms INTEGER," +
            "display_metadata_ciphertext BLOB," +
            "overview_path TEXT," +
            "overview_hash BLOB," +
            "overview_nonce BLOB," +
            "overview_plaintext_bytes INTEGER NOT NULL DEFAULT 0," +
            "overview_point_count INTEGER NOT NULL DEFAULT 0," +
            "PRIMARY KEY(trip_id, revision))");
        db.execSQL("CREATE INDEX trip_revisions_operation_idx ON trip_revisions(commit_state, operation_id)");
        db.execSQL("CREATE INDEX trip_revisions_kek_idx ON trip_revisions(kek_version, commit_state, trip_id, revision)");
        db.execSQL("CREATE INDEX trip_revisions_expiry_idx ON trip_revisions(expires_at_ms, trip_id)");
        db.execSQL("CREATE INDEX trip_revisions_raw_expiry_idx ON trip_revisions(raw_gps_expires_at_ms, trip_id)");
        db.execSQL("CREATE UNIQUE INDEX trip_revisions_seq_idx ON trip_revisions(seq) WHERE seq IS NOT NULL");

        db.execSQL("CREATE TABLE trip_current (" +
            "trip_id TEXT PRIMARY KEY," +
            "revision INTEGER NOT NULL," +
            "seq INTEGER NOT NULL," +
            "last_mutation_seq INTEGER NOT NULL," +
            "start_time_ms INTEGER NOT NULL," +
            "end_time_ms INTEGER NOT NULL," +
            "status TEXT NOT NULL," +
            "vehicle_id TEXT," +
            "point_count INTEGER NOT NULL DEFAULT 0," +
            "distance REAL NOT NULL DEFAULT 0," +
            "duration REAL NOT NULL DEFAULT 0," +
            "score REAL," +
            "score_safety REAL," +
            "score_smoothness REAL," +
            "score_status TEXT," +
            "needs_rescore INTEGER NOT NULL DEFAULT 0," +
            "payload_available INTEGER NOT NULL DEFAULT 1," +
            "overview_available INTEGER NOT NULL DEFAULT 0," +
            "nickname TEXT," +
            "region TEXT," +
            "FOREIGN KEY(trip_id,revision) REFERENCES trip_revisions(trip_id,revision))");
        db.execSQL("CREATE INDEX trip_current_start_idx ON trip_current(start_time_ms DESC, trip_id DESC)");
        db.execSQL("CREATE INDEX trip_current_status_start_idx ON trip_current(status, start_time_ms DESC, trip_id DESC)");
        db.execSQL("CREATE INDEX trip_current_vehicle_status_idx ON trip_current(vehicle_id, status, start_time_ms DESC, trip_id DESC)");

        db.execSQL("CREATE TABLE trip_chunks (" +
            "trip_id TEXT NOT NULL," +
            "revision INTEGER NOT NULL," +
            "chunk_index INTEGER NOT NULL," +
            "operation_id TEXT NOT NULL," +
            "relative_path TEXT NOT NULL," +
            "plaintext_bytes INTEGER NOT NULL," +
            "ciphertext_bytes INTEGER NOT NULL DEFAULT 0," +
            "nonce BLOB NOT NULL," +
            "ciphertext_hash BLOB NOT NULL," +
            "format_version INTEGER NOT NULL," +
            "PRIMARY KEY(trip_id,revision,chunk_index)," +
            "FOREIGN KEY(trip_id,revision) REFERENCES trip_revisions(trip_id,revision))");

        db.execSQL("CREATE TABLE archive_events (" +
            "seq INTEGER PRIMARY KEY AUTOINCREMENT," +
            "event_type TEXT NOT NULL," +
            "trip_id TEXT," +
            "revision INTEGER," +
            "prior_revision INTEGER," +
            "payload_hash BLOB," +
            "metadata_hash BLOB," +
            "reason_code TEXT," +
            "actor TEXT NOT NULL," +
            "previous_chain_hash BLOB NOT NULL," +
            "chain_hash BLOB NOT NULL," +
            "created_at_ms INTEGER NOT NULL," +
            "through_seq INTEGER," +
            "checkpoint_live_count INTEGER," +
            "live_set_root BLOB)");

        db.execSQL("CREATE TABLE integrity_checkpoint_jobs (job_id TEXT PRIMARY KEY,state TEXT NOT NULL,through_seq INTEGER NOT NULL,cursor_trip_id TEXT,live_count INTEGER NOT NULL DEFAULT 0,live_set_root BLOB,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE migration_state (id INTEGER PRIMARY KEY CHECK(id=1),phase TEXT NOT NULL,source_generation TEXT,source_name TEXT,source_version INTEGER,cursor TEXT,visited_count INTEGER NOT NULL DEFAULT 0,migrated_count INTEGER NOT NULL DEFAULT 0,quarantine_count INTEGER NOT NULL DEFAULT 0,source_bytes INTEGER NOT NULL DEFAULT 0,migrated_bytes INTEGER NOT NULL DEFAULT 0,expected_manifest BLOB,rolling_manifest BLOB,admission_state TEXT,last_checkpoint_ms INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE migration_quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT,source_locator TEXT NOT NULL,source_hash BLOB,key_version INTEGER,error_class TEXT NOT NULL,error_detail TEXT,retry_count INTEGER NOT NULL DEFAULT 0,known_metadata TEXT,preserved_artifact TEXT,created_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE migration_shortfall (id INTEGER PRIMARY KEY CHECK(id=1),manifest_hash BLOB NOT NULL,expected_count INTEGER,visited_count INTEGER NOT NULL,migrated_count INTEGER NOT NULL,quarantine_count INTEGER NOT NULL,source_preserved INTEGER NOT NULL,created_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE migration_ingress (operation_id TEXT PRIMARY KEY,trip_id TEXT NOT NULL,source_hash BLOB NOT NULL,expected_bytes INTEGER NOT NULL,received_bytes INTEGER NOT NULL DEFAULT 0,next_chunk_index INTEGER NOT NULL DEFAULT 0,temp_path TEXT NOT NULL,state TEXT NOT NULL,migration_mode INTEGER NOT NULL DEFAULT 1,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE migration_records (trip_id TEXT NOT NULL,source_hash BLOB NOT NULL,canonical_revision INTEGER,canonical_seq INTEGER,state TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(trip_id,source_hash))");
        db.execSQL("CREATE TABLE key_reference_counts (domain_id TEXT NOT NULL,key_version INTEGER NOT NULL,reference_count INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(domain_id,key_version))");
        db.execSQL("CREATE TABLE rotation_state (id INTEGER PRIMARY KEY CHECK(id=1),target_kek_version INTEGER NOT NULL,phase TEXT NOT NULL,domain_id TEXT,cursor TEXT,last_batch_count INTEGER NOT NULL DEFAULT 0,zero_proof INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE open_operations (operation_id TEXT PRIMARY KEY,operation_type TEXT NOT NULL,state TEXT NOT NULL,owner_token TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE export_leases (lease_id TEXT PRIMARY KEY,archive_generation TEXT NOT NULL,through_seq INTEGER NOT NULL,speed_generation TEXT,speed_through_seq INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,owner_token TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");

        createP5ControlTables(db);
        createP6Tables(db);

        db.execSQL("CREATE TABLE trip_aggregate_totals (id INTEGER PRIMARY KEY CHECK(id=1),live_count INTEGER NOT NULL DEFAULT 0,total_distance REAL NOT NULL DEFAULT 0,total_duration REAL NOT NULL DEFAULT 0,score_sum REAL NOT NULL DEFAULT 0,score_count INTEGER NOT NULL DEFAULT 0,through_seq INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE trip_aggregate_buckets (day_start_ms INTEGER NOT NULL,vehicle_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '',trip_count INTEGER NOT NULL DEFAULT 0,total_distance REAL NOT NULL DEFAULT 0,total_duration REAL NOT NULL DEFAULT 0,score_sum REAL NOT NULL DEFAULT 0,score_count INTEGER NOT NULL DEFAULT 0,through_seq INTEGER NOT NULL,PRIMARY KEY(day_start_ms,vehicle_id,status))");
        db.execSQL("CREATE INDEX trip_aggregate_bucket_range_idx ON trip_aggregate_buckets(day_start_ms,vehicle_id,status)");

        db.execSQL("CREATE TABLE speed_state (id INTEGER PRIMARY KEY CHECK(id=1),speed_generation TEXT NOT NULL,last_seq INTEGER NOT NULL DEFAULT 0,integrity_tip BLOB NOT NULL,bucket_count INTEGER NOT NULL DEFAULT 0,total_item_count INTEGER NOT NULL DEFAULT 0,total_payload_bytes INTEGER NOT NULL DEFAULT 0,recovery_state TEXT NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE speed_buckets (bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,revision INTEGER NOT NULL,operation_id TEXT NOT NULL,commit_state TEXT NOT NULL,cell_count INTEGER NOT NULL,payload_bytes INTEGER NOT NULL,payload_hash BLOB NOT NULL,inline_payload BLOB,inline_nonce BLOB,chunk_manifest TEXT,chunk_count INTEGER NOT NULL DEFAULT 0,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,kek_version INTEGER NOT NULL,updated_seq INTEGER,retired_seq INTEGER,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(bucket_id,speed_generation,revision))");
        db.execSQL("CREATE INDEX speed_buckets_current_idx ON speed_buckets(speed_generation,bucket_id,commit_state)");
        db.execSQL("CREATE INDEX speed_buckets_kek_idx ON speed_buckets(kek_version,commit_state,bucket_id)");
        db.execSQL("CREATE TABLE speed_chunks (bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,revision INTEGER NOT NULL,chunk_index INTEGER NOT NULL,relative_path TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext_hash BLOB NOT NULL,plaintext_bytes INTEGER NOT NULL,ciphertext_bytes INTEGER NOT NULL,PRIMARY KEY(bucket_id,speed_generation,revision,chunk_index))");
        db.execSQL("CREATE TABLE speed_current (bucket_id TEXT PRIMARY KEY,speed_generation TEXT NOT NULL,revision INTEGER NOT NULL,updated_seq INTEGER NOT NULL,cell_count INTEGER NOT NULL,payload_bytes INTEGER NOT NULL,payload_hash BLOB NOT NULL,updated_at_ms INTEGER NOT NULL,FOREIGN KEY(bucket_id,speed_generation,revision) REFERENCES speed_buckets(bucket_id,speed_generation,revision))");
        createSpeedEditorTables(db);
        db.execSQL("CREATE TABLE speed_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,batch_id TEXT NOT NULL,bucket_digest BLOB NOT NULL,previous_chain_hash BLOB NOT NULL,chain_hash BLOB NOT NULL,created_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE speed_ingress_batches (batch_id TEXT PRIMARY KEY,state TEXT NOT NULL,bucket_count INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE speed_ingress_buckets (batch_id TEXT NOT NULL,bucket_id TEXT NOT NULL,expected_bytes INTEGER NOT NULL,received_bytes INTEGER NOT NULL DEFAULT 0,next_chunk_index INTEGER NOT NULL DEFAULT 0,payload_hash BLOB NOT NULL,cell_count INTEGER NOT NULL,temp_path TEXT NOT NULL,PRIMARY KEY(batch_id,bucket_id),FOREIGN KEY(batch_id) REFERENCES speed_ingress_batches(batch_id) ON DELETE CASCADE)");

        long now = System.currentTimeMillis();
        String generation = UUID.randomUUID().toString();
        byte[] zero = new byte[32];
        db.execSQL("INSERT INTO archive_meta(id,schema_version,archive_generation,authority_state,recovery_state,last_committed_seq,live_count,tip_chain_hash,pending_count,projection_required_seq,updated_at_ms) VALUES(1,?,?,?,?,0,0,?,0,0,?)", new Object[]{DATABASE_VERSION,generation,"LEGACY","HEALTHY",zero,now});
        db.execSQL("INSERT INTO trip_aggregate_totals(id) VALUES(1)");
        db.execSQL("INSERT INTO speed_state(id,speed_generation,integrity_tip,recovery_state,updated_at_ms) VALUES(1,?,?,?,?)", new Object[]{UUID.randomUUID().toString(),zero,"HEALTHY",now});
        // P5 is a compatible extension of the canonical owner. Fresh state has
        // no derived backfill debt, so bounded writers can be enabled directly.
        db.execSQL("UPDATE p5_control_state SET writers_enabled=1,retention_index_state='VERIFIED',kek_count_state='VERIFIED',blob_inventory_state='VERIFIED',updated_at_ms=? WHERE id=1",new Object[]{now});
        try {
            DriveSenseArchiveIntegrity.appendEventInTransaction(db,"GENERATION_INIT",null,null,null,null,null,"schema_create","system",null,null,null,now);
        } catch (Exception error) {
            throw new android.database.sqlite.SQLiteException("Could not initialize archive integrity chain", error);
        }
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.beginTransaction();
        try {
            int version = oldVersion;
            if (version == 1) {
                createSpeedEditorTables(db);
                // A pre-v2 dark archive can contain buckets without the new
                // identity index. It must not become speed authority until an
                // explicit bounded rebuild/migration has repopulated it.
                db.execSQL("UPDATE speed_state SET recovery_state=CASE WHEN bucket_count>0 THEN 'EDITOR_INDEX_REBUILD_REQUIRED' ELSE recovery_state END,updated_at_ms=? WHERE id=1", new Object[]{System.currentTimeMillis()});
                version = 2;
            }
            if (version == 2) {
                createP5ControlTables(db);
                // All P5 derived state starts dirty.  Its bounded domain owner,
                // never SQLiteOpenHelper startup, performs history backfill.
                long now = System.currentTimeMillis();
                db.execSQL("INSERT OR REPLACE INTO p5_control_state(id,format_version,writers_enabled,journal_state,journal_legacy_presence,retention_index_state,kek_count_state,blob_inventory_state,updated_at_ms) VALUES(1,1,1,'DIRTY','UNKNOWN','BACKFILL_REQUIRED','DIRTY','BACKFILL_REQUIRED',?)", new Object[]{now});
                db.execSQL("UPDATE integrity_checkpoint_jobs SET state='OBSOLETE' WHERE state NOT IN ('COMMITTED','FAILED_COUNT_MISMATCH')");
                version = 3;
            }
            if (version == 3) {
                migrateSpeedEditorIndexForP6(db);
                createP6Tables(db);
                version = 4;
            }
            if (version == 4) {
                migrateP6EncryptedPayloadMetadata(db);
                createP6PayloadTables(db);
                version = 5;
            }
            if (version == 5) {
                // P6 reducer state is additive and constant-time to create.
                // Existing v5 development databases must not be mistaken for
                // having the encrypted road-window owner table.
                createP6Tables(db);
                version = 6;
            }
            if(version==6){createP5ControlTables(db);version=7;}
            if(version==7){
                addColumn(db,"p6_control","settings_version TEXT");
                addColumn(db,"p6_trip_contributions","payload_nonce BLOB");
                addColumn(db,"p6_trip_contributions","payload_hash BLOB");
                addColumn(db,"p6_trip_contributions","wrapped_dek BLOB");
                addColumn(db,"p6_trip_contributions","wrap_nonce BLOB");
                addColumn(db,"p6_trip_contributions","key_version INTEGER");
                addColumn(db,"p6_trip_contributions","plaintext_bytes INTEGER");
                addColumn(db,"p6_analytics_buckets","payload_nonce BLOB");
                addColumn(db,"p6_analytics_buckets","payload_hash BLOB");
                addColumn(db,"p6_analytics_buckets","wrapped_dek BLOB");
                addColumn(db,"p6_analytics_buckets","wrap_nonce BLOB");
                addColumn(db,"p6_analytics_buckets","key_version INTEGER");
                addColumn(db,"p6_analytics_buckets","plaintext_bytes INTEGER");
                db.execSQL("UPDATE p6_control SET state='REBUILD_REQUIRED',complete=0,storage_outcome='ENCRYPTED_ANALYTICS_REBUILD_REQUIRED',updated_at_ms=? WHERE domain_id='D1_ANALYTICS'",new Object[]{System.currentTimeMillis()});
                version=8;
            }
            if (version != newVersion) {
                throw new IllegalStateException("Unimplemented native archive upgrade " + oldVersion + " -> " + newVersion);
            }
            db.execSQL("UPDATE archive_meta SET schema_version=?,updated_at_ms=? WHERE id=1", new Object[]{newVersion,System.currentTimeMillis()});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    @Override
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Native archive downgrade is forbidden");
    }

    private static void createSpeedEditorTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS speed_editor_index (" +
            "kind TEXT NOT NULL," +
            "item_id_hash TEXT NOT NULL," +
            "bucket_id TEXT NOT NULL," +
            "speed_generation TEXT NOT NULL," +
            "revision INTEGER NOT NULL," +
            "updated_seq INTEGER NOT NULL," +
            "publication_version INTEGER NOT NULL DEFAULT 0," +
            "partition_ordinal INTEGER NOT NULL DEFAULT 0," +
            "commit_state TEXT NOT NULL DEFAULT 'COMMITTED'," +
            "stage_operation_id TEXT NOT NULL DEFAULT ''," +
            "PRIMARY KEY(kind,item_id_hash,bucket_id,speed_generation,revision,publication_version,partition_ordinal,commit_state,stage_operation_id)," +
            "FOREIGN KEY(bucket_id) REFERENCES speed_current(bucket_id) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX IF NOT EXISTS speed_editor_bucket_idx ON speed_editor_index(bucket_id,kind,commit_state,revision)");
        db.execSQL("CREATE INDEX IF NOT EXISTS speed_editor_stage_idx ON speed_editor_index(stage_operation_id,commit_state,bucket_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS speed_maintenance_jobs (" +
            "job_id TEXT PRIMARY KEY," +
            "job_type TEXT NOT NULL," +
            "state TEXT NOT NULL," +
            "cursor_bucket TEXT NOT NULL DEFAULT ''," +
            "processed_buckets INTEGER NOT NULL DEFAULT 0," +
            "changed_buckets INTEGER NOT NULL DEFAULT 0," +
            "removed_items INTEGER NOT NULL DEFAULT 0," +
            "max_age_days INTEGER NOT NULL DEFAULT 180," +
            "speed_generation TEXT NOT NULL," +
            "created_at_ms INTEGER NOT NULL," +
            "updated_at_ms INTEGER NOT NULL)");
    }

    private static void migrateSpeedEditorIndexForP6(SQLiteDatabase db) {
        if (hasColumn(db,"speed_editor_index","commit_state")) return;
        db.execSQL("CREATE TABLE speed_editor_index_p6 (" +
            "kind TEXT NOT NULL,item_id_hash TEXT NOT NULL,bucket_id TEXT NOT NULL," +
            "speed_generation TEXT NOT NULL,revision INTEGER NOT NULL,updated_seq INTEGER NOT NULL," +
            "publication_version INTEGER NOT NULL DEFAULT 0,partition_ordinal INTEGER NOT NULL DEFAULT 0," +
            "commit_state TEXT NOT NULL DEFAULT 'COMMITTED',stage_operation_id TEXT NOT NULL DEFAULT ''," +
            "PRIMARY KEY(kind,item_id_hash,bucket_id,speed_generation,revision,publication_version,partition_ordinal,commit_state,stage_operation_id)," +
            "FOREIGN KEY(bucket_id) REFERENCES speed_current(bucket_id) ON DELETE CASCADE)");
        db.execSQL("INSERT INTO speed_editor_index_p6(kind,item_id_hash,bucket_id,speed_generation,revision,updated_seq,publication_version,partition_ordinal,commit_state,stage_operation_id) " +
            "SELECT kind,item_id_hash,bucket_id,speed_generation,revision,updated_seq,revision,0,'COMMITTED','' FROM speed_editor_index");
        db.execSQL("DROP TABLE speed_editor_index");
        db.execSQL("ALTER TABLE speed_editor_index_p6 RENAME TO speed_editor_index");
        db.execSQL("CREATE INDEX speed_editor_bucket_idx ON speed_editor_index(bucket_id,kind,commit_state,revision)");
        db.execSQL("CREATE INDEX speed_editor_stage_idx ON speed_editor_index(stage_operation_id,commit_state,bucket_id)");
    }

    /** P6 additive owner state. Upgrade performs no history scan or payload decode. */
    private static void createP6Tables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_control (domain_id TEXT PRIMARY KEY,source_binding TEXT,required_version INTEGER NOT NULL DEFAULT 0,applied_version INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'REBUILD_REQUIRED',complete INTEGER NOT NULL DEFAULT 0,cursor TEXT,storage_outcome TEXT,capacity_outcome TEXT,writers_enabled INTEGER NOT NULL DEFAULT 0,settings_version TEXT,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_trip_work (trip_id TEXT PRIMARY KEY,archive_generation TEXT NOT NULL,desired_revision INTEGER,source_hash BLOB,desired_seq INTEGER NOT NULL,disposition TEXT NOT NULL DEFAULT 'UPSERT',dirty_domains TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'DIRTY',cursor TEXT,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_trip_work_state_idx ON p6_trip_work(state,desired_seq,trip_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_source_applied (archive_generation TEXT NOT NULL,trip_id TEXT NOT NULL,domain_id TEXT NOT NULL,source_revision INTEGER,source_hash BLOB,algorithm_version INTEGER NOT NULL,settings_version TEXT,published_content_version TEXT,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(archive_generation,trip_id,domain_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_trip_contributions (archive_generation TEXT NOT NULL,trip_id TEXT NOT NULL,metric_schema_version INTEGER NOT NULL,source_revision INTEGER NOT NULL,source_hash BLOB NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,plaintext_bytes INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(archive_generation,trip_id,metric_schema_version))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_analytics_buckets (bucket_key TEXT PRIMARY KEY,source_binding TEXT NOT NULL,metric_schema_version INTEGER NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,plaintext_bytes INTEGER NOT NULL,through_seq INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_recent_order (archive_generation TEXT NOT NULL,order_time_ms INTEGER NOT NULL,trip_id TEXT NOT NULL,source_revision INTEGER NOT NULL,eligible INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(archive_generation,order_time_ms,trip_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_geometry_chunks (archive_generation TEXT NOT NULL,trip_id TEXT NOT NULL,content_version TEXT NOT NULL,ordinal INTEGER NOT NULL,commit_state TEXT NOT NULL,relative_path TEXT NOT NULL,plaintext_bytes INTEGER NOT NULL,ciphertext_bytes INTEGER NOT NULL,key_version INTEGER NOT NULL,payload_nonce BLOB,payload_hash BLOB,wrapped_dek BLOB,wrap_nonce BLOB,operation_id TEXT,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(archive_generation,trip_id,content_version,ordinal))");
        // This is the dominant P6 scale table. WITHOUT ROWID avoids storing the
        // seven-column identity once in the table and again in an automatic PK
        // index. content_version participates in identity so a staged rebuild
        // cannot alias the currently published revision.
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_trip_spatial_postings (archive_generation TEXT NOT NULL,cell_token TEXT NOT NULL,trip_id TEXT NOT NULL,source_revision INTEGER NOT NULL,content_version TEXT NOT NULL,block_ordinal INTEGER NOT NULL,point_ordinal INTEGER NOT NULL,PRIMARY KEY(archive_generation,cell_token,trip_id,source_revision,content_version,block_ordinal,point_ordinal)) WITHOUT ROWID");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_trip_posting_trip_idx ON p6_trip_spatial_postings(archive_generation,trip_id,content_version,block_ordinal)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_road_observations (archive_generation TEXT NOT NULL,trip_id TEXT NOT NULL,source_revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,content_version TEXT NOT NULL,commit_state TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB,payload_hash BLOB,wrapped_dek BLOB,wrap_nonce BLOB,key_version INTEGER,record_kind TEXT NOT NULL DEFAULT 'OBSERVATION',point_start_ordinal INTEGER NOT NULL DEFAULT 0,point_count INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(archive_generation,trip_id,source_revision,ordinal))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_road_windows (archive_generation TEXT NOT NULL,trip_id TEXT NOT NULL,source_revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,record_kind TEXT NOT NULL,state TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(archive_generation,trip_id,source_revision,record_kind,ordinal))");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_road_windows_state_idx ON p6_road_windows(archive_generation,trip_id,source_revision,record_kind,state,ordinal)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_manifests (domain_id TEXT NOT NULL,subject_id TEXT NOT NULL,source_binding TEXT,required_version INTEGER NOT NULL DEFAULT 0,applied_version INTEGER NOT NULL DEFAULT 0,content_version TEXT,state TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(domain_id,subject_id))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_speed_work (work_id TEXT PRIMARY KEY,bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,expected_revision INTEGER NOT NULL,state TEXT NOT NULL,cursor TEXT,capacity_outcome TEXT,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_speed_work_state_idx ON p6_speed_work(state,updated_at_ms,work_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_speed_lookup (speed_generation TEXT NOT NULL,cell_token TEXT NOT NULL,candidate_id_hash TEXT NOT NULL,bucket_id TEXT NOT NULL,publication_version INTEGER NOT NULL,PRIMARY KEY(speed_generation,cell_token,candidate_id_hash,publication_version))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_calibration_counts (speed_generation TEXT NOT NULL,context_key TEXT NOT NULL,feedback_count INTEGER NOT NULL DEFAULT 0,shadow_count INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(speed_generation,context_key))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_observation_applied (speed_generation TEXT NOT NULL,trip_generation TEXT NOT NULL,trip_id TEXT NOT NULL,source_revision INTEGER NOT NULL,observation_ordinal INTEGER NOT NULL,bucket_id TEXT NOT NULL,bucket_revision INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(speed_generation,trip_generation,trip_id,source_revision,observation_ordinal))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_component_repairs (repair_operation_id TEXT PRIMARY KEY,trip_generation TEXT NOT NULL,speed_generation TEXT NOT NULL,algorithm_version INTEGER NOT NULL,component_content_version TEXT NOT NULL,round INTEGER NOT NULL,state TEXT NOT NULL,observation_cursor TEXT,publication_target TEXT NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_component_frontier (repair_operation_id TEXT NOT NULL,round INTEGER NOT NULL,candidate_id TEXT NOT NULL,state TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(repair_operation_id,round,candidate_id),FOREIGN KEY(repair_operation_id) REFERENCES p6_component_repairs(repair_operation_id) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_component_frontier_state_idx ON p6_component_frontier(repair_operation_id,round,state,candidate_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_speed_partition_manifests (bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,revision INTEGER NOT NULL,publication_version INTEGER NOT NULL,partition_ordinal INTEGER NOT NULL,partition_class TEXT NOT NULL,commit_state TEXT NOT NULL,encoded_bytes INTEGER NOT NULL,payload_hash BLOB,operation_id TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(bucket_id,speed_generation,revision,publication_version,partition_ordinal))");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_speed_stages (operation_id TEXT NOT NULL,bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,expected_revision INTEGER NOT NULL,publication_version INTEGER NOT NULL,state TEXT NOT NULL,key_version INTEGER,encoded_bytes INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(operation_id,bucket_id))");
        createP6PayloadTables(db);
        long now=System.currentTimeMillis();
        db.execSQL("INSERT OR IGNORE INTO p6_control(domain_id,state,complete,writers_enabled,updated_at_ms) VALUES('D1_ANALYTICS','REBUILD_REQUIRED',0,0,?)",new Object[]{now});
        db.execSQL("INSERT OR IGNORE INTO p6_control(domain_id,state,complete,writers_enabled,updated_at_ms) VALUES('D2_GEOMETRY','REBUILD_REQUIRED',0,0,?)",new Object[]{now});
        db.execSQL("INSERT OR IGNORE INTO p6_control(domain_id,state,complete,writers_enabled,updated_at_ms) VALUES('D3_SPATIAL_SELECTION','REBUILD_REQUIRED',0,0,?)",new Object[]{now});
        db.execSQL("INSERT OR IGNORE INTO p6_control(domain_id,state,complete,writers_enabled,updated_at_ms) VALUES('D4_ROAD_LEARNING_SPEED_LOOKUP','REBUILD_REQUIRED',0,0,?)",new Object[]{now});
    }

    private static void createP6PayloadTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_spatial_secrets (secret_id TEXT PRIMARY KEY,archive_generation TEXT NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_selection_requests (request_id TEXT PRIMARY KEY,archive_generation TEXT NOT NULL,state TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,cursor TEXT,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_selection_candidates (request_id TEXT NOT NULL,trip_id TEXT NOT NULL,content_version TEXT NOT NULL,state TEXT NOT NULL,cursor_ordinal INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request_id,trip_id),FOREIGN KEY(request_id) REFERENCES p6_selection_requests(request_id) ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE IF NOT EXISTS p6_speed_partitions (operation_id TEXT NOT NULL,bucket_id TEXT NOT NULL,speed_generation TEXT NOT NULL,expected_revision INTEGER NOT NULL,publication_version INTEGER NOT NULL,partition_ordinal INTEGER NOT NULL,commit_state TEXT NOT NULL,payload BLOB NOT NULL,payload_nonce BLOB NOT NULL,payload_hash BLOB NOT NULL,wrapped_dek BLOB NOT NULL,wrap_nonce BLOB NOT NULL,key_version INTEGER NOT NULL,plaintext_bytes INTEGER NOT NULL,ciphertext_bytes INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(operation_id,bucket_id,partition_ordinal))");
        db.execSQL("CREATE INDEX IF NOT EXISTS p6_speed_partitions_visible_idx ON p6_speed_partitions(bucket_id,speed_generation,publication_version,commit_state,partition_ordinal)");
    }

    private static void migrateP6EncryptedPayloadMetadata(SQLiteDatabase db) {
        addColumn(db,"p6_geometry_chunks","payload_nonce BLOB");
        addColumn(db,"p6_geometry_chunks","payload_hash BLOB");
        addColumn(db,"p6_geometry_chunks","wrapped_dek BLOB");
        addColumn(db,"p6_geometry_chunks","wrap_nonce BLOB");
        addColumn(db,"p6_geometry_chunks","operation_id TEXT");
        addColumn(db,"p6_road_observations","payload_nonce BLOB");
        addColumn(db,"p6_road_observations","payload_hash BLOB");
        addColumn(db,"p6_road_observations","wrapped_dek BLOB");
        addColumn(db,"p6_road_observations","wrap_nonce BLOB");
        addColumn(db,"p6_road_observations","key_version INTEGER");
        addColumn(db,"p6_road_observations","record_kind TEXT NOT NULL DEFAULT 'OBSERVATION'");
        addColumn(db,"p6_road_observations","point_start_ordinal INTEGER NOT NULL DEFAULT 0");
        addColumn(db,"p6_road_observations","point_count INTEGER NOT NULL DEFAULT 0");
    }

    private static void addColumn(SQLiteDatabase db,String table,String declaration) {
        String column=declaration.substring(0,declaration.indexOf(' '));
        if(!hasColumn(db,table,column))db.execSQL("ALTER TABLE "+table+" ADD COLUMN "+declaration);
    }

    private static boolean hasColumn(SQLiteDatabase db,String table,String column) {
        try (android.database.Cursor cursor=db.rawQuery("PRAGMA table_info("+table+")",null)) {
            while(cursor.moveToNext()) if(column.equals(cursor.getString(1))) return true;
        }
        return false;
    }

    /**
     * P5 control state is additive and contains no route/trip payload.  Every
     * table is empty or constant-sized at creation so upgrading never walks N.
     */
    private static void createP5ControlTables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS p5_control_state (" +
            "id INTEGER PRIMARY KEY CHECK(id=1),format_version INTEGER NOT NULL," +
            "writers_enabled INTEGER NOT NULL DEFAULT 1," +
            "journal_state TEXT NOT NULL DEFAULT 'DIRTY'," +
            "journal_legacy_presence TEXT NOT NULL DEFAULT 'UNKNOWN'," +
            "retention_index_state TEXT NOT NULL DEFAULT 'BACKFILL_REQUIRED'," +
            "retention_policy_version TEXT," +
            "retention_raw_days INTEGER NOT NULL DEFAULT 0," +
            "retention_motion_days INTEGER NOT NULL DEFAULT 0," +
            "kek_count_state TEXT NOT NULL DEFAULT 'DIRTY'," +
            "blob_inventory_state TEXT NOT NULL DEFAULT 'BACKFILL_REQUIRED'," +
            "updated_at_ms INTEGER NOT NULL)");
        db.execSQL("INSERT OR IGNORE INTO p5_control_state(id,format_version,writers_enabled,updated_at_ms) VALUES(1,1,1,0)");
        addColumnIfMissing(db,"p5_control_state","retention_policy_version","TEXT");
        addColumnIfMissing(db,"p5_control_state","retention_raw_days","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"p5_control_state","retention_motion_days","INTEGER NOT NULL DEFAULT 0");

        // Version 3 has never been production-enabled.  Discard only its
        // disabled draft retention control tables when their policy column has
        // the pre-freeze INTEGER type; canonical trip data is never touched.
        if (columnHasType(db,"trip_retention_jobs","policy_version","INTEGER") ||
            columnHasType(db,"trip_retention_due","policy_version","INTEGER")) {
            db.execSQL("DROP TABLE IF EXISTS trip_retention_due");
            db.execSQL("DROP TABLE IF EXISTS trip_retention_jobs");
        }
        db.execSQL("CREATE TABLE IF NOT EXISTS trip_retention_jobs (" +
            "job_id TEXT PRIMARY KEY,archive_generation TEXT NOT NULL,erasure_token TEXT NOT NULL," +
            "policy_version TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL," +
            "cursor_expires_at_ms INTEGER,cursor_trip_id TEXT NOT NULL DEFAULT ''," +
            "source_trip_id TEXT,source_revision INTEGER,source_payload_hash BLOB," +
            "operation_id TEXT,items_examined INTEGER NOT NULL DEFAULT 0,bytes_worked INTEGER NOT NULL DEFAULT 0," +
            "created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        addColumnIfMissing(db,"trip_retention_jobs","source_chunk_index","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","source_chunk_offset","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","stage_next_index","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","stage_plaintext_bytes","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","stage_chunk_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","tokenizer_state","BLOB");
        addColumnIfMissing(db,"trip_retention_jobs","output_sha_state","BLOB");
        addColumnIfMissing(db,"trip_retention_jobs","output_sha_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","output_sha_partial","BLOB");
        addColumnIfMissing(db,"trip_retention_jobs","stage_wrapped_dek","BLOB");
        addColumnIfMissing(db,"trip_retention_jobs","stage_wrap_nonce","BLOB");
        addColumnIfMissing(db,"trip_retention_jobs","stage_kek_version","INTEGER");
        addColumnIfMissing(db,"trip_retention_jobs","raw_due","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","motion_due","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","retention_days","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","motion_days","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","retention_now_ms","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","publish_chunk_index","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","publish_revision","INTEGER");
        addColumnIfMissing(db,"trip_retention_jobs","publish_operation_id","TEXT");
        addColumnIfMissing(db,"trip_retention_jobs","catalog_metadata","TEXT");
        addColumnIfMissing(db,"trip_retention_jobs","purged_point_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","purged_motion_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","source_retire_cursor","INTEGER NOT NULL DEFAULT -1");
        addColumnIfMissing(db,"trip_retention_jobs","source_retirement_state","TEXT NOT NULL DEFAULT 'NOT_READY'");
        addColumnIfMissing(db,"trip_retention_jobs","stage_cleanup_index","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","publish_plan_index","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","published_ciphertext_bytes","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"trip_retention_jobs","p6_freeze_state","TEXT NOT NULL DEFAULT 'PENDING'");
        addColumnIfMissing(db,"trip_retention_jobs","p6_freeze_cursor","TEXT");
        db.execSQL("CREATE INDEX IF NOT EXISTS trip_retention_job_run_idx ON trip_retention_jobs(archive_generation,policy_version,phase,created_at_ms,job_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS retention_stage_chunks ("+
            "job_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,plaintext_bytes INTEGER NOT NULL,"+
            "encoded_bytes INTEGER NOT NULL,PRIMARY KEY(job_id,chunk_index))");
        db.execSQL("CREATE TABLE IF NOT EXISTS trip_retention_due (" +
            "trip_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,raw_due_at_ms INTEGER,motion_due_at_ms INTEGER," +
            "next_due_at_ms INTEGER,policy_version TEXT NOT NULL,archive_generation TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'DUE')");
        db.execSQL("CREATE INDEX IF NOT EXISTS trip_retention_due_idx ON trip_retention_due(state,next_due_at_ms,trip_id)");

        db.execSQL("CREATE TABLE IF NOT EXISTS journal_manifest_index (" +
            "entry_key TEXT PRIMARY KEY,trip_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL," +
            "updated_at_ms INTEGER NOT NULL,encrypted_bytes INTEGER NOT NULL,largest_file_bytes INTEGER NOT NULL," +
            "kek_version INTEGER,readable INTEGER NOT NULL,descriptor BLOB,manifest_bytes INTEGER NOT NULL," +
            "source_format TEXT,generation TEXT,rsas_session_id TEXT,chunk_count INTEGER NOT NULL DEFAULT 0," +
            "mutation_version INTEGER NOT NULL DEFAULT 0,bootstrap_attempt_id TEXT)");
        addColumnIfMissing(db,"journal_manifest_index","source_format","TEXT");
        addColumnIfMissing(db,"journal_manifest_index","generation","TEXT");
        addColumnIfMissing(db,"journal_manifest_index","rsas_session_id","TEXT");
        addColumnIfMissing(db,"journal_manifest_index","chunk_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"journal_manifest_index","mutation_version","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"journal_manifest_index","bootstrap_attempt_id","TEXT");
        // AUD-005 restart discovery. -1 means UNKNOWN: rows indexed before this column
        // existed cannot be assumed free of emergency work, and unknown must retain.
        addColumnIfMissing(db,"journal_manifest_index","emergency_pending","INTEGER NOT NULL DEFAULT -1");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_manifest_emergency_idx ON journal_manifest_index(emergency_pending,entry_key)");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_manifest_oldest_idx ON journal_manifest_index(readable,created_at_ms,entry_key)");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_manifest_largest_idx ON journal_manifest_index(largest_file_bytes DESC,entry_key)");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_manifest_updated_idx ON journal_manifest_index(readable,updated_at_ms DESC,entry_key)");
        db.execSQL("CREATE TABLE IF NOT EXISTS journal_file_registry (" +
            "relative_path TEXT PRIMARY KEY,entry_key TEXT NOT NULL,file_kind TEXT NOT NULL," +
            "generation TEXT,ordinal INTEGER,encoded_bytes INTEGER NOT NULL,state TEXT NOT NULL," +
            "attempt_id TEXT,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_file_entry_idx ON journal_file_registry(entry_key,file_kind,generation,ordinal)");
        db.execSQL("CREATE INDEX IF NOT EXISTS journal_file_size_idx ON journal_file_registry(encoded_bytes DESC,relative_path)");
        db.execSQL("CREATE TABLE IF NOT EXISTS journal_summary (" +
            "id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,pending_count INTEGER NOT NULL DEFAULT 0," +
            "unreadable_count INTEGER NOT NULL DEFAULT 0,encrypted_bytes INTEGER NOT NULL DEFAULT 0," +
            "largest_file_bytes INTEGER NOT NULL DEFAULT 0,oldest_pending_at_ms INTEGER,last_verified_save_at_ms INTEGER," +
            "archive_generation TEXT,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("INSERT OR IGNORE INTO journal_summary(id,state,updated_at_ms) VALUES(1,'DIRTY',0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS journal_repair_state (" +
            "id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT ''," +
            "generation TEXT,examined INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("INSERT OR IGNORE INTO journal_repair_state(id,state,updated_at_ms) VALUES(1,'DIRTY',0)");
        addColumnIfMissing(db,"journal_repair_state","entry_key","TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db,"journal_repair_state","file_ordinal","INTEGER NOT NULL DEFAULT -1");
        db.execSQL("CREATE TABLE IF NOT EXISTS journal_bootstrap_state (" +
            "id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,attempt_id TEXT," +
            "examined INTEGER NOT NULL DEFAULT 0,files_seen INTEGER NOT NULL DEFAULT 0," +
            "encoded_bytes INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL)");
        db.execSQL("INSERT OR IGNORE INTO journal_bootstrap_state(id,state,updated_at_ms) VALUES(1,'UNPROBED',0)");

        addColumnIfMissing(db,"integrity_checkpoint_jobs","archive_generation","TEXT");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","phase","TEXT NOT NULL DEFAULT 'SCAN'");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","cursor_revision","INTEGER");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","observed_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","sha_state","BLOB");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","sha_byte_count","INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","sha_partial","BLOB");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","root_stream_version","INTEGER NOT NULL DEFAULT 1");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","state_format_version","INTEGER NOT NULL DEFAULT 1");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","checkpoint_event_seq","INTEGER");
        addColumnIfMissing(db,"integrity_checkpoint_jobs","compaction_cursor_seq","INTEGER");

        db.execSQL("CREATE TABLE IF NOT EXISTS archive_blob_inventory (" +
            "opaque_path TEXT PRIMARY KEY,archive_generation TEXT,encoded_bytes INTEGER NOT NULL," +
            "catalog_state TEXT NOT NULL,audit_attempt_id TEXT,authoritative INTEGER NOT NULL DEFAULT 0," +
            "updated_at_ms INTEGER NOT NULL)");
        addColumnIfMissing(db,"archive_blob_inventory","audit_attempt_id","TEXT");
        addColumnIfMissing(db,"archive_blob_inventory","authoritative","INTEGER NOT NULL DEFAULT 0");
        db.execSQL("CREATE TABLE IF NOT EXISTS archive_unlink_debt (" +
            "debt_id TEXT PRIMARY KEY,opaque_path TEXT NOT NULL UNIQUE,encoded_bytes INTEGER NOT NULL," +
            "state TEXT NOT NULL DEFAULT 'PENDING',reason_code TEXT NOT NULL,created_at_ms INTEGER NOT NULL," +
            "updated_at_ms INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS archive_unlink_debt_state_idx ON archive_unlink_debt(state,created_at_ms,debt_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS archive_deep_audit_jobs (" +
            "job_id TEXT PRIMARY KEY,state TEXT NOT NULL,directory_shard TEXT NOT NULL DEFAULT ''," +
            "cursor_name TEXT NOT NULL DEFAULT '',examined INTEGER NOT NULL DEFAULT 0,anomalies INTEGER NOT NULL DEFAULT 0," +
            "attempt_id TEXT,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        addColumnIfMissing(db,"archive_deep_audit_jobs","attempt_id","TEXT");

        addColumnIfMissing(db,"rotation_state","cursor_kek_version","INTEGER");
        addColumnIfMissing(db,"rotation_state","cursor_commit_state","TEXT");
        addColumnIfMissing(db,"rotation_state","cursor_item_id","TEXT");
        addColumnIfMissing(db,"rotation_state","cursor_revision","INTEGER");
        addColumnIfMissing(db,"rotation_state","count_state","TEXT NOT NULL DEFAULT 'DIRTY'");
        addColumnIfMissing(db,"rotation_state","repair_domain","TEXT NOT NULL DEFAULT 'trip_archive'");
        addColumnIfMissing(db,"rotation_state","repair_cursor_kek","INTEGER NOT NULL DEFAULT -1");
        addColumnIfMissing(db,"rotation_state","repair_cursor_state","TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db,"rotation_state","repair_cursor_id","TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(db,"rotation_state","repair_cursor_revision","INTEGER NOT NULL DEFAULT -1");
        db.execSQL("CREATE TABLE IF NOT EXISTS kek_reference_repair_counts (" +
            "domain_id TEXT NOT NULL,key_version INTEGER NOT NULL,reference_count INTEGER NOT NULL," +
            "PRIMARY KEY(domain_id,key_version))");

        db.execSQL("CREATE TABLE IF NOT EXISTS privacy_receipt_debt (" +
            "operation_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,reason_code TEXT NOT NULL," +
            "trip_count INTEGER NOT NULL DEFAULT 0,point_count INTEGER NOT NULL DEFAULT 0," +
            "state TEXT NOT NULL DEFAULT 'PENDING',created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL)");
        addColumnIfMissing(db,"privacy_receipt_debt","motion_sample_count","INTEGER NOT NULL DEFAULT 0");
        db.execSQL("CREATE TABLE IF NOT EXISTS encrypted_file_key_registry (" +
            "domain_id TEXT NOT NULL,entry_id TEXT NOT NULL,key_version INTEGER NOT NULL," +
            "state TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,PRIMARY KEY(domain_id,entry_id))");
        db.execSQL("CREATE INDEX IF NOT EXISTS encrypted_file_key_version_idx ON encrypted_file_key_registry(domain_id,key_version,entry_id)");
    }

    private static void addColumnIfMissing(SQLiteDatabase db, String table, String column, String declaration) {
        try (android.database.Cursor cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            while (cursor.moveToNext()) if (column.equals(cursor.getString(1))) return;
        }
        db.execSQL("ALTER TABLE " + table + " ADD COLUMN " + column + " " + declaration);
    }

    private static boolean columnHasType(SQLiteDatabase db,String table,String column,String type) {
        try (android.database.Cursor cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(1))) return type.equalsIgnoreCase(cursor.getString(2));
            }
        }
        return false;
    }
}
