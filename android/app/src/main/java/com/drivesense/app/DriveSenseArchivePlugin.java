package com.drivesense.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(name="DriveSenseArchive")
public class DriveSenseArchivePlugin extends Plugin {
    private static final int MAX_REQUEST_BYTES=512*1024;
    private static final int MAX_CONTROL_REQUEST_BYTES=64*1024;
    private static final int MAX_RESPONSE_BYTES=512*1024;
    private static final int MAX_HANDLES=8;
    private final Map<String,Handle> handles=new LinkedHashMap<>();
    private final Map<String,SpeedHandle> speedHandles=new LinkedHashMap<>();
    private DriveSenseTripArchiveRepository repository;
    private DriveSenseSpeedArchiveRepository speedRepository;
    private DriveSenseSpeedEditorRepository speedEditorRepository;
    private Exception loadError;

    @Override public void load(){try{repository=new DriveSenseTripArchiveRepository(getContext());speedRepository=new DriveSenseSpeedArchiveRepository(getContext());}catch(Exception error){loadError=error;DriveSenseDurabilityJournal.record(getContext(),"CRITICAL","ARCHIVE_PLUGIN_LOAD_FAILED",null,0,0,0,"CANONICAL_MISSING");}}
    @Override protected void handleOnDestroy(){synchronized(handles){for(Handle h:handles.values())h.close();handles.clear();}synchronized(speedHandles){for(SpeedHandle h:speedHandles.values())h.close();speedHandles.clear();}super.handleOnDestroy();}

    @PluginMethod public void getHealth(PluginCall call){execute(call,false,()->DriveSenseArchiveHealth.inventory(required().coordinator()));}
    @PluginMethod public void getDiagnosticsReadiness(PluginCall call){execute(call,false,()->DriveSenseP6DerivedState.diagnosticsReadiness(required().coordinator()));}
    @PluginMethod public void reconcileLiveCount(PluginCall call){execute(call,false,()->{JSONObject o=new JSONObject();o.put("verified",DriveSenseArchiveIntegrity.reconcileCount(required().coordinator()));return o;});}
    @PluginMethod public void createIntegrityCheckpoint(PluginCall call){execute(call,false,()->{DriveSenseArchiveIntegrity.CheckpointResult r=DriveSenseArchiveIntegrity.createCheckpoint(required().coordinator());JSONObject o=new JSONObject();o.put("verified",r.verified);o.put("throughSeq",r.throughSeq);o.put("liveCount",r.liveCount);o.put("liveSetRoot",Base64.encodeToString(r.root,Base64.NO_WRAP));return o;});}
    @PluginMethod public void getDurabilityJournalSummary(PluginCall call){execute(call,false,()->DriveSenseDurabilityJournal.summary(getContext()));}
    @PluginMethod public void stepP5NativeRawGpsRetention(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return new DriveSenseRawGpsRetention(required()).step(call.getInt("retentionDays",0),call.getInt("motionRetentionDays",0),longArg(call,"now",System.currentTimeMillis()),false);});}
    @PluginMethod public void runP5NativeRawGpsRetentionNow(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return new DriveSenseRawGpsRetention(required()).step(call.getInt("retentionDays",0),call.getInt("motionRetentionDays",0),longArg(call,"now",System.currentTimeMillis()),true);});}
    @PluginMethod public void acknowledgeP6RetentionFreeze(PluginCall call){execute(call,false,()->new DriveSenseRawGpsRetention(required()).acknowledgeP6Freeze(call.getString("jobId",""),call.getString("nextCursor",""),Boolean.TRUE.equals(call.getBoolean("complete",false))));}
    @PluginMethod public void stepP5JournalManifestReconcile(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseJournalControlPlane.reconcile(getContext());});}
    @PluginMethod public void stepP5ArchiveIntegrityCheckpoint(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseArchiveIntegrity.stepBoundedCheckpoint(required().coordinator());});}
    @PluginMethod public void stepP5ArchiveResidueGc(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseArchiveUnlinkDebt.step(required().coordinator(),required().chunkStore());});}
    @PluginMethod public void getP5PrivacyReceipts(PluginCall call){execute(call,false,()->DriveSenseP5PrivacyReceipts.pending(required().coordinator()));}
    @PluginMethod public void acknowledgeP5PrivacyReceipt(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseP5PrivacyReceipts.acknowledge(required().coordinator(),call.getString("operationId",""));});}
    @PluginMethod public void runP5BlobDeepAudit(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseArchiveDeepAudit.step(required(),call.getString("jobId",""));});}
    @PluginMethod public void runP5JournalRegistryBootstrap(PluginCall call){execute(call,false,()->{requireP5WritersEnabled();return DriveSenseJournalControlPlane.bootstrap(getContext());});}
    @PluginMethod public void cancelP5JournalRegistryBootstrap(PluginCall call){execute(call,false,DriveSenseJournalControlPlane::cancelBootstrap);}
    @PluginMethod public void stepP6TripDerived(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.stepTripDerived(required()));}
    @PluginMethod public void queueP6ExplicitTripSubjects(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.queueExplicitTripSubjects(
        required(),call.getArray("tripIds"),Boolean.TRUE.equals(call.getBoolean("includeRoad",false))));}
    @PluginMethod public void resetP6AnalyticsDerived(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.resetAnalyticsDerived(
        required(),call.getString("phase","CONTRIBUTIONS")));}
    @PluginMethod public void invalidateP6AnalyticsForSettings(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.invalidateAnalyticsForSettings(
        required(),call.getString("settingsVersion",""),call.getString("reason","SETTINGS_OR_VEHICLE_CHANGED")));}
    @PluginMethod public void finalizeP6ExplicitTripBuild(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.finalizeExplicitTripBuild(
        required(),Boolean.TRUE.equals(call.getBoolean("includeRoad",false))));}
    @PluginMethod public void stepP6RoadMemory(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.stepRoadMemory(required()));}
    @PluginMethod public void acknowledgeP6RoadMemory(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.acknowledgeRoadMemory(
        required(),call.getString("tripId",""),call.getData()));}
    @PluginMethod public void stepP6AffectedSelection(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.stepAffectedSelection(required()));}
    @PluginMethod public void createP6AffectedSelection(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.createAffectedSelection(required(),call.getData()));}
    @PluginMethod public void acknowledgeP6AffectedSelection(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.acknowledgeAffectedSelection(
        required(),call.getString("requestId",""),Boolean.TRUE.equals(call.getBoolean("matched",false))));}
    @PluginMethod public void queryP6GeometryPreviewPage(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.queryGeometryPreviewPage(
        required(),call.getString("cursor",""),call.getInt("maxItems",40)));}
    @PluginMethod public void queryP6AchievementStats(PluginCall call){execute(call,false,()->DriveSenseP6Jobs.queryAchievementStats(
        required(),longArg(call,"now",System.currentTimeMillis())));}
    @PluginMethod public void beginP6ComponentRepair(PluginCall call){execute(call,false,()->DriveSenseP6DerivedState.beginRepair(required(),call.getArray("candidateIds")));}
    @PluginMethod public void stepP6ComponentRepair(PluginCall call){execute(call,false,()->DriveSenseP6DerivedState.stepRepair(required()));}
    @PluginMethod public void acknowledgeP6ComponentRepair(PluginCall call){execute(call,false,()->DriveSenseP6DerivedState.acknowledgeRepair(required(),call.getString("repairOperationId",""),call.getString("candidateId",""),call.getInt("round",0),call.getArray("discoveredCandidateIds")));}

    @PluginMethod public void queryHistoryPage(PluginCall call){execute(call,false,()->required().queryHistoryPage(call.getData()));}
    @PluginMethod public void getProjectionFeed(PluginCall call){execute(call,false,()->required().projectionFeed(longArg(call,"afterSeq",0L),call.getInt("maxItems",100),call.getInt("maxBytes",256*1024)));}
    @PluginMethod public void getTripMetadata(PluginCall call){execute(call,false,()->nullable("item",required().getMetadata(call.getString("tripId",""))));}
    @PluginMethod public void queryAdjacentTrip(PluginCall call){execute(call,false,()->nullable("item",required().adjacent(call.getString("tripId",""),call.getString("direction",""),call.getString("status",""))));}
    @PluginMethod public void getTripAggregates(PluginCall call){execute(call,false,()->required().aggregates(call.getData()));}
    @PluginMethod public void getTripChartBuckets(PluginCall call){execute(call,false,()->required().chartBuckets(call.getData()));}
    @PluginMethod public void getTripTagContext(PluginCall call){execute(call,false,()->{int max=call.getInt("maxRecent",50);JSONObject page=required().tagContextPage(max,256*1024);JSONObject out=new JSONObject();out.put("aggregates",required().aggregates(new JSONObject()));out.put("recent",page.optJSONArray("items"));out.put("archiveGeneration",page.getString("archiveGeneration"));out.put("canonicalSeq",page.getLong("canonicalSeq"));return out;});}
    @PluginMethod public void sampleTripMetadata(PluginCall call){execute(call,false,()->{JSONObject request=new JSONObject();request.put("maxItems",Math.max(1,Math.min(50,call.getInt("maxItems",20))));request.put("maxBytes",Math.min(128*1024,call.getInt("maxBytes",128*1024)));JSONObject out=required().queryHistoryPage(request);out.put("health",DriveSenseArchiveHealth.inventory(required().coordinator()));return out;});}
    @PluginMethod public void getTripOverviewTrack(PluginCall call){execute(call,false,()->{int max=call.getInt("maxPoints",900);byte[]bytes=required().overview(call.getString("tripId",""),max);JSONObject out=new JSONObject();if(bytes==null){out.put("points",new JSONArray());return out;}JSONObject stored=new JSONObject(new String(bytes,StandardCharsets.UTF_8));JSONArray points=stored.optJSONArray("points");out.put("points",decimate(points,max));out.put("tripId",call.getString("tripId",""));out.put("maxPoints",max);return out;});}

    @PluginMethod public void openTripPayload(PluginCall call){execute(call,false,()->{DriveSenseTripArchiveRepository.PayloadDescriptor descriptor=required().descriptor(call.getString("tripId",""),call.getData().has("revision")?call.getInt("revision"):null);if(descriptor==null)throw new IllegalStateException("TRIP_NOT_FOUND");String handle=UUID.randomUUID().toString();synchronized(handles){expireHandles();if(handles.size()>=MAX_HANDLES){descriptor.close();throw new IllegalStateException("PAYLOAD_HANDLE_LIMIT");}handles.put(handle,new Handle(descriptor));}JSONObject out=new JSONObject();out.put("handle",handle);out.put("tripId",descriptor.tripId);out.put("revision",descriptor.revision);out.put("chunkCount",descriptor.chunkCount);out.put("plaintextBytes",descriptor.plaintextBytes);out.put("payloadHash",DriveSenseEnvelopeCrypto.hex(descriptor.payloadHash));out.put("formatVersion",1);return out;});}
    @PluginMethod public void readTripPayloadChunk(PluginCall call){execute(call,true,()->{String token=call.getString("handle","");Handle handle; synchronized(handles){expireHandles();handle=handles.get(token);if(handle!=null)handle.lastUsed=System.currentTimeMillis();}if(handle==null)throw new IllegalStateException("PAYLOAD_HANDLE_INVALID");int index=call.getInt("chunkIndex",-1);byte[]plain=required().readPayloadChunk(handle.descriptor,index);JSONObject out=new JSONObject();out.put("handle",token);out.put("chunkIndex",index);out.put("chunkCount",handle.descriptor.chunkCount);out.put("plaintextBase64",Base64.encodeToString(plain,Base64.NO_WRAP));out.put("plaintextBytes",plain.length);java.util.Arrays.fill(plain,(byte)0);return out;});}
    @PluginMethod public void closeTripPayload(PluginCall call){execute(call,false,()->{Handle removed; synchronized(handles){removed=handles.remove(call.getString("handle",""));}if(removed!=null)removed.close();JSONObject out=new JSONObject();out.put("closed",true);return out;});}
    @PluginMethod public void ingestCompletedJournal(PluginCall call){execute(call,false,()->required().ingestCompletedJournal(call.getInt("maxItems",8),longArg(call,"maxWorkBytes",8L*1024L*1024L)));}
    @PluginMethod public void tombstoneTrip(PluginCall call){execute(call,false,()->required().tombstone(call.getString("tripId",""),call.getString("reason","user_delete"),call.getBoolean("dataRights",false)));}
    @PluginMethod public void eraseTripArchiveGeneration(PluginCall call){execute(call,false,()->required().rolloverGenerationForIdentityErasure(call.getString("reason","data_rights_erasure")));}
    @PluginMethod public void eraseSpeedArchiveGeneration(PluginCall call){execute(call,false,()->speed().rolloverGeneration(call.getString("reason","data_rights_erasure")));}
    @PluginMethod public void reportIndexedDbOpen(PluginCall call){execute(call,false,()->required().reportIndexedDbOpen(call.getString("databaseName",""),longArg(call,"oldVersion",-1L),longArg(call,"newVersion",-1L)));}

    @PluginMethod public void beginMigrationTrip(PluginCall call){execute(call,false,()->migration().begin(call.getString("tripId",""),call.getString("sourceHash",""),longArg(call,"expectedBytes",0L)));}
    @PluginMethod public void appendMigrationTripChunk(PluginCall call){execute(call,true,()->migration().append(call.getString("operationId",""),call.getInt("chunkIndex",-1),call.getString("chunkBase64","")));}
    @PluginMethod public void finishMigrationTrip(PluginCall call){execute(call,false,()->migration().finish(call.getString("operationId","")));}
    @PluginMethod public void abortMigrationTrip(PluginCall call){execute(call,false,()->migration().abort(call.getString("operationId","")));}
    @PluginMethod public void completeMigration(PluginCall call){execute(call,false,()->migration().complete(longArg(call,"expectedCount",-1L),longArg(call,"visitedCount",-1L),longArg(call,"quarantineCount",-1L),call.getString("manifestHash","")));}
    @PluginMethod public void saveMigrationCheckpoint(PluginCall call){execute(call,false,()->migration().checkpoint(call.getObject("checkpoint",new JSObject())));}
    @PluginMethod public void getMigrationCheckpoint(PluginCall call){execute(call,false,()->migration().checkpointStatus());}
    @PluginMethod public void quarantineLegacySource(PluginCall call){execute(call,false,()->migration().quarantineUnopened(call.getString("sourceLocator",""),call.getObject("knownMetadata",new JSObject()),call.getString("errorClass","UnreadableLegacySource"),call.getString("errorDetail","")));}
    @PluginMethod public void beginTripCommit(PluginCall call){execute(call,false,()->directIngress().begin(call.getString("tripId",""),call.getString("sourceHash",""),longArg(call,"expectedBytes",0L)));}
    @PluginMethod public void appendTripCommitChunk(PluginCall call){execute(call,true,()->directIngress().append(call.getString("operationId",""),call.getInt("chunkIndex",-1),call.getString("chunkBase64","")));}
    @PluginMethod public void finishTripCommit(PluginCall call){execute(call,false,()->directIngress().finish(call.getString("operationId","")));}
    @PluginMethod public void abortTripCommit(PluginCall call){execute(call,false,()->directIngress().abort(call.getString("operationId","")));}

    @PluginMethod public void getSpeedState(PluginCall call){execute(call,false,()->speed().state());}
    @PluginMethod public void beginSpeedBucketBatch(PluginCall call){execute(call,false,()->speed().begin(call.getArray("buckets")));}
    @PluginMethod public void beginSpeedBucketBatchPlan(PluginCall call){execute(call,false,()->speed().beginPlan(call.getInt("bucketCount",0),call.getBoolean("p6Automatic",false)));}
    @PluginMethod public void addSpeedBucketDescriptors(PluginCall call){execute(call,false,()->speed().addDescriptors(call.getString("batchId",""),call.getArray("buckets")));}
    @PluginMethod public void sealSpeedBucketBatchPlan(PluginCall call){execute(call,false,()->speed().sealPlan(call.getString("batchId","")));}
    @PluginMethod public void appendSpeedBucketChunk(PluginCall call){execute(call,true,()->speed().append(call.getString("batchId",""),call.getString("bucketId",""),call.getInt("chunkIndex",-1),call.getString("chunkBase64","")));}
    @PluginMethod public void finishSpeedBucketBatch(PluginCall call){execute(call,false,()->speed().finish(call.getString("batchId","")));}
    @PluginMethod public void abortSpeedBucketBatch(PluginCall call){execute(call,false,()->speed().abort(call.getString("batchId","")));}
    @PluginMethod public void querySpeedBucketMetadata(PluginCall call){execute(call,false,()->speed().metadata(call.getArray("bucketIds")));}
    @PluginMethod public void querySpeedBucketPage(PluginCall call){execute(call,false,()->speed().page(call.getString("cursor",""),call.getInt("maxItems",32)));}
    @PluginMethod public void querySpeedEditorItems(PluginCall call){execute(call,false,()->speedEditor().query(call.getData()));}
    @PluginMethod public void getSpeedEditorItem(PluginCall call){execute(call,false,()->speedEditor().getExact(call.getData()));}
    @PluginMethod public void beginSpeedMaintenance(PluginCall call){execute(call,false,()->speedMaintenance().begin(call.getString("type",""),call.getInt("maxAgeDays",180)));}
    @PluginMethod public void beginOrResumeSpeedMaintenance(PluginCall call){execute(call,false,()->speedMaintenance().beginOrResume(call.getString("type",""),call.getInt("maxAgeDays",180)));}
    @PluginMethod public void stepSpeedMaintenance(PluginCall call){execute(call,false,()->speedMaintenance().step(call.getString("jobId",""),call.getInt("maxBuckets",8)));}
    @PluginMethod public void cancelSpeedMaintenance(PluginCall call){execute(call,false,()->speedMaintenance().cancel(call.getString("jobId","")));}
    @PluginMethod public void getSpeedMaintenanceStatus(PluginCall call){execute(call,false,()->speedMaintenance().status(call.getString("jobId","")));}
    @PluginMethod public void tombstoneSpeedBuckets(PluginCall call){execute(call,false,()->speed().tombstone(call.getArray("bucketIds"),call.getString("reason","removed_bucket")));}
    @PluginMethod public void openSpeedBucketPayload(PluginCall call){execute(call,false,()->{DriveSenseSpeedArchiveRepository.Descriptor descriptor=speed().open(call.getString("bucketId",""));if(descriptor==null)throw new IllegalStateException("SPEED_BUCKET_NOT_FOUND");String token=UUID.randomUUID().toString();synchronized(speedHandles){expireSpeedHandles();if(speedHandles.size()>=MAX_HANDLES){descriptor.close();throw new IllegalStateException("PAYLOAD_HANDLE_LIMIT");}speedHandles.put(token,new SpeedHandle(descriptor));}JSONObject out=new JSONObject();out.put("handle",token);out.put("bucketId",descriptor.bucketId);out.put("speedGeneration",descriptor.generation);out.put("revision",descriptor.revision);out.put("chunkCount",descriptor.chunkCount);out.put("payloadBytes",descriptor.payloadBytes);out.put("payloadHash",DriveSenseEnvelopeCrypto.hex(descriptor.payloadHash));return out;});}
    @PluginMethod public void readSpeedBucketChunk(PluginCall call){execute(call,true,()->{String token=call.getString("handle","");SpeedHandle handle;synchronized(speedHandles){expireSpeedHandles();handle=speedHandles.get(token);if(handle!=null)handle.lastUsed=System.currentTimeMillis();}if(handle==null)throw new IllegalStateException("PAYLOAD_HANDLE_INVALID");int index=call.getInt("chunkIndex",-1);byte[]plain=speed().read(handle.descriptor,index);JSONObject out=new JSONObject();out.put("handle",token);out.put("chunkIndex",index);out.put("chunkCount",handle.descriptor.chunkCount);out.put("plaintextBase64",Base64.encodeToString(plain,Base64.NO_WRAP));out.put("plaintextBytes",plain.length);java.util.Arrays.fill(plain,(byte)0);return out;});}
    @PluginMethod public void closeSpeedBucketPayload(PluginCall call){execute(call,false,()->{SpeedHandle removed;synchronized(speedHandles){removed=speedHandles.remove(call.getString("handle",""));}if(removed!=null)removed.close();JSONObject out=new JSONObject();out.put("closed",true);return out;});}
    @PluginMethod public void beginLegacySpeedMigration(PluginCall call){execute(call,false,()->legacySpeedMigration().begin(call.getData()));}
    @PluginMethod public void appendLegacySpeedCiphertext(PluginCall call){execute(call,true,()->legacySpeedMigration().append(call.getString("operationId",""),call.getInt("chunkIndex",-1),call.getString("chunkBase64","")));}
    @PluginMethod public void executeLegacySpeedMigration(PluginCall call){execute(call,false,()->legacySpeedMigration().execute(call.getString("operationId","")));}
    @PluginMethod public void getLegacySpeedMigrationStatus(PluginCall call){execute(call,false,()->legacySpeedMigration().status(call.getString("operationId","")));}
    @PluginMethod public void beginStreamBackup(PluginCall call){execute(call,false,()->backup().begin(call.getString("filename","road-sage-backup"),call.getString("passphrase","")));}
    @PluginMethod public void getStreamBackupStatus(PluginCall call){execute(call,false,()->backup().status(call.getString("operationId","")));}
    @PluginMethod public void cancelStreamBackup(PluginCall call){execute(call,false,()->backup().cancel(call.getString("operationId","")));}
    @PluginMethod public void publishStreamBackup(PluginCall call){execute(call,false,()->backup().publish(call.getString("operationId","")));}
    @PluginMethod public void beginStreamBackupRestore(PluginCall call){execute(call,false,()->backup().beginRestore(call.getString("backupOperationId",""),call.getString("passphrase","")));}
    @PluginMethod public void beginStreamBackupRestoreFromUri(PluginCall call){execute(call,false,()->backup().beginRestoreFromUri(call.getString("uri",""),call.getString("passphrase","")));}
    @PluginMethod public void pickStreamBackupRestoreFile(PluginCall call){
        startActivityForResult(call,DriveSenseBackupRestorePicker.createIntent(),"streamBackupRestoreFilePicked");
    }
    @ActivityCallback private void streamBackupRestoreFilePicked(PluginCall call,ActivityResult result){
        if(call==null)return;
        Intent data=result.getData();
        if(result.getResultCode()!=Activity.RESULT_OK||data==null||data.getData()==null){
            JSObject cancelled=new JSObject();cancelled.put("cancelled",true);call.resolve(cancelled);return;
        }
        Uri uri=data.getData();
        if(!"content".equalsIgnoreCase(uri.getScheme())){call.reject("RESTORE_REQUIRES_REVIEWED_CONTENT_URI");return;}
        int readFlag=data.getFlags()&Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if(readFlag==0){call.reject("RESTORE_CONTENT_URI_READ_PERMISSION_MISSING");return;}
        try{
            getContext().getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }catch(SecurityException error){
            call.reject("RESTORE_CONTENT_URI_PERMISSION_NOT_DURABLE",error);return;
        }
        JSObject selected=new JSObject();selected.put("uri",uri.toString());
        try(Cursor cursor=getContext().getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){
            if(cursor!=null&&cursor.moveToFirst())selected.put("name",cursor.getString(0));
        }catch(Exception ignored){/* The durable URI, not display metadata, is authoritative. */}
        call.resolve(selected);
    }
    @PluginMethod public void rotateEnvelopeKekBatch(PluginCall call){execute(call,false,()->new DriveSenseEnvelopeKeyRotation(required().coordinator()).rotateBatch(call.getInt("targetKekVersion",0),call.getInt("maxItems",50)));}
    @PluginMethod public void getEnvelopeKekRotationStatus(PluginCall call){execute(call,false,()->new DriveSenseEnvelopeKeyRotation(required().coordinator()).status());}

    private DriveSenseTripArchiveRepository required(){if(repository==null)throw new IllegalStateException("CANONICAL_UNAVAILABLE",loadError);return repository;}
    private void requireP5WritersEnabled()throws Exception{boolean enabled=required().coordinator().read(db->{try(android.database.Cursor c=db.rawQuery("SELECT writers_enabled FROM p5_control_state WHERE id=1",null)){return c.moveToFirst()&&c.getInt(0)==1;}});if(!enabled)throw new IllegalStateException("P5_IMPLEMENTATION_NOT_ENABLED");}
    private DriveSenseArchiveMigration migration(){return new DriveSenseArchiveMigration(required());}
    private DriveSenseArchiveMigration directIngress(){return new DriveSenseArchiveMigration(required(),false);}
    private DriveSenseSpeedArchiveRepository speed(){if(speedRepository==null)throw new IllegalStateException("SPEED_CANONICAL_UNAVAILABLE",loadError);return speedRepository;}
    private synchronized DriveSenseSpeedEditorRepository speedEditor()throws Exception{if(speedEditorRepository==null)speedEditorRepository=new DriveSenseSpeedEditorRepository(getContext(),speed());return speedEditorRepository;}
    private DriveSenseSpeedMaintenanceJob speedMaintenance(){return new DriveSenseSpeedMaintenanceJob(speed());}
    private DriveSenseLegacySpeedMigration legacySpeedMigration(){return new DriveSenseLegacySpeedMigration(getContext(),speed());}
    private DriveSenseStreamBackupManager backup(){return DriveSenseStreamBackupManager.get(getContext(),required(),speed());}
    private void execute(PluginCall call,boolean large,Work work){try{int requestBytes=call.getData().toString().getBytes(StandardCharsets.UTF_8).length;if(requestBytes>(large?MAX_REQUEST_BYTES:MAX_CONTROL_REQUEST_BYTES))throw new IllegalArgumentException("REQUEST_TOO_LARGE");JSONObject value=work.run();int responseBytes=value.toString().getBytes(StandardCharsets.UTF_8).length;if(responseBytes>MAX_RESPONSE_BYTES)throw new IllegalStateException("RESPONSE_TOO_LARGE");value.put("responseBytes",responseBytes);value.put("maxBytes",MAX_RESPONSE_BYTES);call.resolve(JSObject.fromJSONObject(value));}catch(Exception error){call.reject(safeMessage(error),error);}}
    private static JSONObject nullable(String key,JSONObject value)throws Exception{JSONObject out=new JSONObject();out.put(key,value==null?JSONObject.NULL:value);return out;}
    private static JSONArray decimate(JSONArray source,int max)throws Exception{JSONArray out=new JSONArray();if(source==null)return out;int limit=Math.max(1,Math.min(DriveSenseTripOverviewBuilder.MAX_POINTS,max));int stride=Math.max(1,(int)Math.ceil(source.length()/(double)limit));for(int i=0;i<source.length()&&out.length()<limit;i+=stride)out.put(source.opt(i));return out;}
    private void expireHandles(){long cutoff=System.currentTimeMillis()-2L*60L*1000L;java.util.Iterator<Map.Entry<String,Handle>>iterator=handles.entrySet().iterator();while(iterator.hasNext()){Map.Entry<String,Handle>entry=iterator.next();if(entry.getValue().lastUsed<cutoff){entry.getValue().close();iterator.remove();}}}
    private void expireSpeedHandles(){long cutoff=System.currentTimeMillis()-2L*60L*1000L;java.util.Iterator<Map.Entry<String,SpeedHandle>>iterator=speedHandles.entrySet().iterator();while(iterator.hasNext()){Map.Entry<String,SpeedHandle>entry=iterator.next();if(entry.getValue().lastUsed<cutoff){entry.getValue().close();iterator.remove();}}}
    /**
     * Capacitor's {@code PluginCall.getLong(name, fallback)} returns the fallback unless the
     * bridged value is exactly a {@code java.lang.Long}, and a JS number below 2^31 arrives from
     * the JSON bridge as an {@code Integer}. Every 64-bit argument on this plugin was therefore
     * silently replaced by its default: {@code getProjectionFeed(afterSeq)} replayed the feed from
     * seq 0 on every turn, {@code beginMigrationTrip} lost the expected-byte accounting, and
     * {@code completeMigration}'s counters arrived as -1 and were rejected as invalid.
     * Read the raw JSON value and coerce it, failing closed on a malformed one.
     */
    static long longArg(PluginCall call,String name,long fallback){
        Object value=call.getData()==null?null:call.getData().opt(name);
        if(value==null||value==JSONObject.NULL)return fallback;
        if(value instanceof Integer||value instanceof Long||value instanceof Short||value instanceof Byte){
            return ((Number)value).longValue();
        }
        if(value instanceof Number){
            double exact=((Number)value).doubleValue();
            if(Double.isNaN(exact)||Double.isInfinite(exact)||exact!=Math.rint(exact)
                ||Math.abs(exact)>9007199254740992d)throw new IllegalArgumentException("ARGUMENT_NOT_INTEGRAL:"+name);
            return (long)exact;
        }
        if(value instanceof String){
            try{return Long.parseLong(((String)value).trim());}
            catch(NumberFormatException invalid){throw new IllegalArgumentException("ARGUMENT_NOT_NUMERIC:"+name);}
        }
        throw new IllegalArgumentException("ARGUMENT_NOT_NUMERIC:"+name);
    }

    private static String safeMessage(Exception error){String message=error.getMessage();if(message==null||message.isEmpty())message=error.getClass().getSimpleName();return message.length()>240?message.substring(0,240):message;}
    private interface Work{JSONObject run()throws Exception;}
    private static final class Handle{final DriveSenseTripArchiveRepository.PayloadDescriptor descriptor;long lastUsed=System.currentTimeMillis();Handle(DriveSenseTripArchiveRepository.PayloadDescriptor d){descriptor=d;}void close(){descriptor.close();}}
    private static final class SpeedHandle{final DriveSenseSpeedArchiveRepository.Descriptor descriptor;long lastUsed=System.currentTimeMillis();SpeedHandle(DriveSenseSpeedArchiveRepository.Descriptor d){descriptor=d;}void close(){descriptor.close();}}
}
