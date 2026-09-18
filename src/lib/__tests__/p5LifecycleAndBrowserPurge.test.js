import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_WORK_EXTENTS,
  APP_WORK_TRIGGER_ORIGINS,
  P5_LIFECYCLE_JOB_KEYS,
  createP4LifecycleWorkRuntime,
} from '@/lib/appLifecycleWork';
import { createAppWorkCoordinator } from '@/lib/appWorkCoordinator';
import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import {
  DB_NAME,
  localTripRepository,
  runLegacyBrowserRawGpsRetention,
  stepRawGpsRetention,
} from '@/lib/localTripRepository';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import * as repositoryModule from '@/lib/localTripRepository';
import { initializePrivacyAudit, loadPrivacyAuditChain } from '@/lib/hashChainLog';
import { createAuditTestRuntime } from './helpers/privacyAuditRuntime';
import { AUDIT_V2_DB } from '@/lib/hashChainLogV2';
import { activeTripStore } from '@/lib/trackingStore';

const healthy = { authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g-p5' };

describe('P5 frozen lifecycle registrations', () => {
  it('V3 registers exactly J1-J4 through the real boundary with frozen budgets and owners', () => {
    const runtime = createP4LifecycleWorkRuntime({
      coordinator: createAppWorkCoordinator({ autoStart: false }),
      nativeAuthorityAvailable: () => true,
      readHealth: async () => healthy,
      runProjectionTurn: async () => ({ done: true, applied: 0 }),
      runJournalTurn: async () => ({ itemCount: 0, hasMore: false }),
    });
    const rows = runtime.boundary.snapshot().filter(({ jobKey }) => Object.values(P5_LIFECYCLE_JOB_KEYS).includes(jobKey));
    expect(rows.map(({ jobKey }) => jobKey)).toEqual(Object.values(P5_LIFECYCLE_JOB_KEYS));
    expect(rows.every(({ workExtent }) => workExtent === APP_WORK_EXTENTS.BOUNDED_TURN)).toBe(true);
    expect(rows.find(({ jobKey }) => jobKey === P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC).triggerOrigins)
      .toEqual([APP_WORK_TRIGGER_ORIGINS.RESUME, APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED]);
    expect(rows.every(({ triggerOrigins }) => !triggerOrigins.includes(APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN))).toBe(true);
  });

  it('V25 rejects a +1 item report through the existing coordinator budget', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = createP4LifecycleWorkRuntime({
      coordinator,nativeAuthorityAvailable:()=>true,readHealth:async()=>healthy,
      runProjectionTurn:async()=>({done:true,applied:0}),runJournalTurn:async()=>({itemCount:0,hasMore:false}),
      runP5RawGpsRetentionTurn:async()=>({itemsWorked:17,bytesWorked:0,hasMore:false}),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });
    runtime.admit(P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION,{origin:APP_WORK_TRIGGER_ORIGINS.RESUME,epoch:1});
    await coordinator.drain();
    const job=coordinator.getJobSnapshot(P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION);
    expect(job.consecutiveFailures).toBeGreaterThan(0);
  });
});

describe('P5 browser RSAS purge overlay', () => {
  afterEach(async()=>{await browserActiveTripSpool.eraseAllForDataRights();browserActiveTripSpool.resetMemory();vi.unstubAllGlobals();});
  it('V10 persists every purge boundary and resumes 1/100/1000/large segment deletes in fixed turns', async () => {
    const fake = new FakeIndexedDb();
    const values = new Map([['drivesense_settings', JSON.stringify({ settings_defaults_version: 11,
      data_retention_days: 0, raw_gps_retention_days: 1, motion_sample_retention_days: 0, privacy_zones: [] })]]);
    const auditRuntime = createAuditTestRuntime(values);
    vi.stubGlobal('localStorage', auditRuntime.storage);
    vi.stubGlobal('navigator', { locks: auditRuntime.locks });
    vi.stubGlobal('IDBKeyRange', auditRuntime.idb.keyRange);
    // Real spool memory backend plus the repository's IDB backend. No purge or
    // expiry helper is mocked: both production owners execute every transition.
    vi.stubGlobal('indexedDB', { open(name, version) {
      if (name === AUDIT_V2_DB) return auditRuntime.idb.open(name, version);
      if (name !== 'roadsage_active_spool_v1') return fake.open(name, version);
      const request = { result: null, onsuccess: null };
      queueMicrotask(() => request.onsuccess?.()); return request;
    }, deleteDatabase() {
      const request = { onsuccess: null }; queueMicrotask(() => request.onsuccess?.()); return request;
    } });
    await initializePrivacyAudit();
    for(const segmentCount of [1,100,1000,3000]){
      const id=`p5-purge-${segmentCount}`;
      activeTripStore.set({id,status:'active',route_points:[],start_time:'2020-01-01T00:00:00.000Z'});
      activeTripStore.addPoint({lat:43,lng:-79,timestamp:String(segmentCount)});
      const sessionId=activeTripStore.get().rsas_session_id;
      const event = { type: 'brake', lat: 1, lng: 2, latitude: 3, longitude: 4,
        original_lat: 5, original_lng: 6, matched_lat: 7, matched_lng: 8 };
      const arrays = Object.fromEntries(['driving_events', 'phone_proxy_events', 'phone_use_events',
        'native_phone_usage_events', 'native_tracking_timeline'].map((key) => [key, [event]]));
      const metadata=await activeTripStore.completeBrowserCanonical({id,status:'completed',start_time:'2020-01-01T00:00:00.000Z',end_time:'2020-01-01T01:00:00.000Z',start_address:'home',end_address:'work',motion_samples:[{x:1}],...arrays});
      await localTripRepository.create(metadata);await browserActiveTripSpool.flush();
      const expiredAt=Date.parse('2026-08-31T12:00:00.000Z');
      const motionRetentionDays=segmentCount===100?1:0;
      const started=await browserActiveTripSpool.beginCanonicalPurge(sessionId,{retentionDays:30,motionRetentionDays,expiredAt});expect(started.state).toBe('PURGE_PREPARED');await browserActiveTripSpool.seedPurgeSegmentsForTests(sessionId,segmentCount,32);
      const states=new Set([started.state]);await expect(async()=>{for await(const _point of browserActiveTripSpool.readPoints(sessionId)) void _point;}).rejects.toThrow('ROUTE_EXPIRED');
      let outcome;let turns=0;do{browserActiveTripSpool.resetMemory();outcome=await browserActiveTripSpool.stepCanonicalPurge(sessionId);states.add(outcome.state);expect(outcome.itemsWorked).toBeLessThanOrEqual(16);expect(outcome.changedItems).toBeLessThanOrEqual(16);expect(outcome.bytesWorked).toBeLessThanOrEqual(2*1024*1024);turns+=1;expect(turns).toBeLessThan(Math.ceil(segmentCount/16)+5);}while(outcome.state!=='TRIP_METADATA_PENDING');
      const commit=repositoryModule.commitRsasRouteExpiry;
      const crash=vi.spyOn(repositoryModule,'commitRsasRouteExpiry').mockImplementationOnce(async(control)=>{await commit(control);throw new Error('after metadata before DONE');});
      await expect(browserActiveTripSpool.stepCanonicalPurge(sessionId)).rejects.toThrow('after metadata before DONE');crash.mockRestore();
      expect(await browserActiveTripSpool.canonicalPurgeState(sessionId)).toBe('TRIP_METADATA_PENDING');
      browserActiveTripSpool.resetMemory();
      // The repository sweep must resume the pending receipt/DONE even though
      // the raw clock is already satisfied by its committed metadata.
      const settled = await stepRawGpsRetention({force:true,now:expiredAt});
      expect(settled.auditItemsWorked).toBe(8);
      expect(settled.auditBytesWorked).toBeGreaterThan(0);
      expect(await browserActiveTripSpool.canonicalPurgeState(sessionId)).toBe('DONE');states.add('DONE');
      const retained=await localTripRepository.getById(id);
      expect(retained).toMatchObject({route_data_expired_at:new Date(expiredAt).toISOString(),route_data_retention_days:30,
        route_data_expiration_reason:'raw_gps_retention_policy',route_points:[],route_points_raw_count:1,
        route_points_map_count:0,needs_rescore:false,start_address:null,end_address:null});
      for(const key of Object.keys(arrays)) {
        expect(retained[key]).toHaveLength(1);
        for(const value of retained[key]) {
        for(const coordinate of Object.keys(event).filter((key)=>key!=='type')) expect(value).not.toHaveProperty(coordinate);
        }
      }
      const receipts=(await loadPrivacyAuditChain()).filter((event)=>event.operation_id===`rsas-purge-${sessionId}`);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].details).toMatchObject({purged_trip_count:1,purged_point_count:1,purged_motion_sample_count:motionRetentionDays?1:0});
      if(motionRetentionDays) expect(retained.motion_samples).toEqual([]);
      else expect(retained.motion_samples).toEqual([{x:1}]);
      const step=vi.spyOn(browserActiveTripSpool,'stepCanonicalPurge');
      await stepRawGpsRetention({force:true,now:expiredAt});await stepRawGpsRetention({force:true,now:expiredAt});
      expect(step).not.toHaveBeenCalled();step.mockRestore();
      expect(states).toEqual(new Set(['PURGE_PREPARED','READ_RETIRED','SEGMENT_UNLINKING','TRIP_METADATA_PENDING','DONE']));
    }
  });

  it('V10 erasure dominates a queued purge and cannot restore any route point', async () => {
    vi.stubGlobal('indexedDB', undefined);const id='p5-purge-erased';const sessionId=browserActiveTripSpool.begin({id});browserActiveTripSpool.append({lat:43,lng:-79,timestamp:'erase'},{id});await browserActiveTripSpool.complete({id,status:'completed'});await browserActiveTripSpool.flush();expect((await browserActiveTripSpool.beginCanonicalPurge(sessionId)).state).toBe('PURGE_PREPARED');await browserActiveTripSpool.eraseAllForDataRights();browserActiveTripSpool.resetMemory();expect(await browserActiveTripSpool.stepCanonicalPurge(sessionId)).toEqual({state:'DONE',itemsWorked:0,changedItems:0,bytesWorked:0,hasMore:false});await expect(async()=>{for await(const _point of browserActiveTripSpool.readPoints(sessionId)) void _point;}).rejects.toThrow('ACTIVE_SPOOL_NOT_READABLE');
  });
});

describe('P5 browser authority and predecessor compatibility', () => {
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.doUnmock('@/lib/nativePlatform');vi.resetModules();});

  const installBrowser = () => {
    vi.stubGlobal('navigator', { locks: createAuditTestRuntime().locks });
    const indexedDB=new FakeIndexedDb();const values=new Map([['drivesense_settings',JSON.stringify({settings_defaults_version:11,data_retention_days:0,raw_gps_retention_days:1,motion_sample_retention_days:1,privacy_zones:[]})]]);vi.stubGlobal('indexedDB',indexedDB);vi.stubGlobal('localStorage',{getItem:vi.fn((key)=>values.get(key)??null),setItem:vi.fn((key,value)=>values.set(key,value)),removeItem:vi.fn((key)=>values.delete(key))});return indexedDB;
  };

  it('V11 routine lifecycle reports one legacy debt without decrypting its predecessor payload', async()=>{
    const fake=installBrowser();await localTripRepository.create({id:'schema-anchor',status:'draft',start_time:'2026-01-01T00:00:00.000Z'});const store=fake.databases.get(DB_NAME).stores.get('trips');store.records.set('legacy-debt',{id:'legacy-debt',status:'completed',start_time:'2020-01-01T00:00:00.000Z',end_time:'2020-01-01T01:00:00.000Z',rsas_session_id:null,route_data_expired_at:null,motion_samples_expired_at:null,encrypted_payload:{format:'intentionally-not-decryptable'}});const outcome=await stepRawGpsRetention({force:true,now:Date.parse('2026-08-31T12:00:00.000Z')});expect(outcome).toMatchObject({ownerless:true,owner:'explicit-compatibility-maintenance',legacyRawGpsDebt:true,legacyTripId:'legacy-debt',processed:0,hasMore:false});expect(store.records.get('legacy-debt').encrypted_payload).toEqual({format:'intentionally-not-decryptable'});
  });

  it('V11 explicit compatibility admits one record atomically or refuses it without data loss',async()=>{
    installBrowser();const old={id:'legacy-one',status:'completed',start_time:'2020-01-01T00:00:00.000Z',end_time:'2020-01-01T01:00:00.000Z',route_points:[{lat:43.1,lng:-79.1},{lat:43.2,lng:-79.2}],motion_samples:[{x:1}]};await localTripRepository.create(old);const refused=await runLegacyBrowserRawGpsRetention({tripId:'legacy-one',retentionDays:1,motionRetentionDays:1,now:Date.parse('2026-08-31T12:00:00.000Z'),maxEncodedBytes:1});expect(refused).toMatchObject({state:'REFUSED_SIZE',changed:false});expect((await localTripRepository.getById('legacy-one')).route_points).toHaveLength(2);const completed=await runLegacyBrowserRawGpsRetention({tripId:'legacy-one',retentionDays:1,motionRetentionDays:1,now:Date.parse('2026-08-31T12:00:00.000Z')});expect(completed).toMatchObject({state:'COMPLETE',changed:true,purgedTrips:1,purgedPoints:2,purgedMotionSamples:1});const retained=await localTripRepository.getById('legacy-one');expect(retained).toMatchObject({id:'legacy-one',status:'completed',route_points:[],motion_samples:[]});expect(retained.route_data_expired_at).toBeTruthy();expect(retained.motion_samples_expired_at).toBeTruthy();
  });

  it('V12 native authority refuses both browser lifecycle and explicit predecessor mutation',async()=>{
    installBrowser();vi.stubEnv('VITE_P35_NATIVE_AUTHORITY','true');vi.doMock('@/lib/nativePlatform',()=>({isAndroid:()=>true,isNativePlatform:()=>true}));vi.resetModules();const nativeRepository=await import('@/lib/localTripRepository');expect(await nativeRepository.stepRawGpsRetention({force:true})).toMatchObject({enabled:false,delegated:true,owner:'p5NativeRawGpsRetention'});expect(await nativeRepository.runLegacyBrowserRawGpsRetention({tripId:'disposable'})).toMatchObject({state:'REFUSED_NATIVE_AUTHORITY',changed:false,owner:'native'});
  });
});
