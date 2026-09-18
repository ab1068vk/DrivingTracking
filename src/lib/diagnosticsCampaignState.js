import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { getP4WorkCoordinator } from '@/lib/appLifecycleWork';
import { getActiveEncryptionKeyVersion } from '@/lib/securePayloadCrypto';
import { loadRotationLog } from '@/lib/keyRotationManager';
import { P6_DOMAIN_KEYS } from '@/lib/p6Contracts';
import { readP6TripDomainReadiness } from '@/lib/p6TripDerivedState';
import { readNativeProjectionState } from '@/lib/localTripRepository';

const token = (value, fallback = 'unknown') => String(value ?? fallback)
  .replace(/[^a-zA-Z0-9._:-]/g, '_')
  .slice(0, 120);
const count = (value) => value != null && Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : null;
const boolean = (value) => typeof value === 'boolean' ? value : null;
const generation = (value) => String(value ?? '').slice(0, 180) || null;

const settledValue = (result) => result?.status === 'fulfilled' ? result.value : null;

const readinessSnapshot = (value, domain) => ({
  domain,
  state: token(value?.state),
  complete: boolean(value?.complete),
  pending: count(value?.pending),
  has_more: boolean(value?.hasMore),
  required_version: count(value?.required_version),
  applied_version: count(value?.applied_version),
});

export function sanitizeCampaignState(raw = {}) {
  const health = raw.archiveHealth || {};
  const migration = raw.migration || {};
  const coordinator = raw.coordinator || {};
  const key = raw.key || {};
  const speed = raw.speed || {};
  const active = raw.activeCapture || {};
  const projection = raw.projection;
  const projectionComparable = projection != null && raw.archiveHealth?.archiveGeneration != null
    && raw.archiveHealth?.projectionRequiredSeq != null;
  const projectionMatches = projectionComparable
    && projection.generation === raw.archiveHealth.archiveGeneration;
  const projectionComplete = projectionMatches && projection.mode === 'catchup'
    && Number(projection.afterSeq) >= Number(raw.archiveHealth.projectionRequiredSeq);
  return {
    collection: { state: 'available' },
    authority: {
      trip: token(raw.authority),
      generation: generation(raw.sourceSnapshot?.generation),
      revision: count(raw.sourceSnapshot?.revision),
      snapshot_state: raw.sourceSnapshot ? 'available' : 'unavailable',
    },
    archive_recovery: raw.authority === 'native' ? {
      state: token(health.recoveryState),
      authority_state: token(health.authorityState),
      sentinel_matches: boolean(health.sentinelMatches),
      live_record_count: count(health.liveCount),
      pending_count: count(health.pendingCount),
      integrity_due: boolean(health.integrity?.due),
    } : { state: raw.authority === 'browser' ? 'not_applicable_browser_authority' : 'unavailable' },
    migration: raw.authority === 'native' ? {
      state: token(migration.state || migration.phase || (raw.migrationAvailable ? 'idle' : 'unavailable')),
      items_processed: count(migration.itemsProcessed ?? migration.migratedCount),
      items_pending: count(migration.itemsPending ?? migration.pendingCount),
    } : { state: raw.authority === 'browser' ? 'not_applicable_browser_authority' : 'unavailable' },
    active_capture: {
      state: active.recordingActive === true ? 'recording' : active.available !== true ? 'unavailable' : active.serviceEnabled === true ? 'armed_idle' : 'inactive',
      service_enabled: boolean(active.serviceEnabled),
      checkpoint_state: token(active.checkpointState || 'unavailable'),
      completed_journal_count: count(active.completedJournalCount),
    },
    backup_restore: {
      state: 'not_exposed_by_bounded_owner',
      detail: 'operation_events_retained_separately',
    },
    key_rotation: {
      state: token(key.state),
      active_key_version: count(key.activeKeyVersion),
      native_phase: token(key.nativePhase),
      pending_count: count(key.pendingCount),
      recorded_error_count: count(key.errorCount),
    },
    derived_readiness: Object.fromEntries(Object.entries(raw.readiness || {}).map(([name, value]) => [
      token(name), readinessSnapshot(value, token(value?.domain || name)),
    ])),
    coordinator: {
      registered_jobs: count(coordinator.registeredJobs),
      active_instances: count(coordinator.activeInstances),
      sleeping_instances: count(coordinator.sleepingInstances),
      backlog: count(coordinator.backlog),
      runnable_backlog: count(coordinator.runnableBacklog),
      lifecycle_epoch: count(coordinator.lifecycleEpoch),
      foreground: coordinator.effectiveForeground === true,
      telemetry_count: count(coordinator.telemetry?.count),
      telemetry_dropped: count(coordinator.telemetry?.dropped),
    },
    road_speed: raw.authority === 'native' ? {
      state: token(speed.recoveryState || (raw.speedAvailable ? 'available' : 'unavailable')),
      generation: generation(speed.speedGeneration),
      revision: count(speed.lastSeq),
      bucket_count: count(speed.bucketCount),
      item_count: count(speed.totalItemCount),
    } : { state: raw.authority === 'browser' ? 'bounded_browser_status_not_exposed' : 'unavailable' },
    projection_detail: {
      state: raw.authority !== 'native' ? 'bounded_browser_query_only'
        : !projectionComparable ? 'unavailable' : !projectionMatches ? 'generation_mismatch'
          : projectionComplete ? 'converged' : token(projection.mode || 'pending'),
      complete: raw.authority === 'native' && projectionComparable ? projectionComplete : null,
      detail_representation: 'not_inspected',
      after_revision: count(projection?.afterSeq),
      required_revision: count(health.projectionRequiredSeq),
    },
    background_enrichment: {
      state: !raw.coordinator ? 'unavailable' : coordinator.backlog > 0 || coordinator.sleepingInstances > 0 ? 'pending' : 'idle_or_converged',
      backlog: count(coordinator.backlog),
    },
  };
}

export async function collectDiagnosticsCampaignState({
  authority = 'unknown',
  sourceSnapshot = null,
  activeCapture = {},
} = {}) {
  const domains = Object.entries(P6_DOMAIN_KEYS);
  const nativeReadiness = authority === 'native'
    ? await nativeTripArchive.diagnosticsReadiness().catch(() => ({})) : null;
  const readinessResults = await Promise.allSettled(domains.map(([, domain]) => (
    authority === 'native' ? Promise.resolve(nativeReadiness?.[domain])
      : authority === 'browser' ? readP6TripDomainReadiness(domain, 'all') : Promise.resolve(null)
  )));
  const readiness = Object.fromEntries(domains.map(([name, domain], index) => [
    name.toLowerCase(),
    settledValue(readinessResults[index]) || { domain, state: 'unavailable' },
  ]));
  const coordinator = getP4WorkCoordinator().getCoordinatorSnapshot();
  const [activeKeyResult, rotationLogResult] = await Promise.allSettled([
    getActiveEncryptionKeyVersion(),
    loadRotationLog(),
  ]);
  const rotationLog = settledValue(rotationLogResult) || [];
  const raw = {
    authority,
    sourceSnapshot,
    activeCapture,
    readiness,
    coordinator,
    key: {
      state: activeKeyResult.status === 'fulfilled' ? 'available' : 'unavailable',
      activeKeyVersion: settledValue(activeKeyResult),
      errorCount: rotationLog.filter((entry) => entry?.status === 'error').length,
    },
  };
  if (authority === 'native') {
    const [healthResult, migrationResult, speedResult, keyResult, projectionResult] = await Promise.allSettled([
      nativeTripArchive.diagnosticsHealth(),
      nativeTripArchive.migrationCheckpoint(),
      nativeTripArchive.speedState(),
      nativeTripArchive.envelopeKekRotationStatus(),
      readNativeProjectionState(),
    ]);
    raw.archiveHealth = settledValue(healthResult);
    raw.projection = settledValue(projectionResult);
    raw.migration = settledValue(migrationResult);
    raw.migrationAvailable = migrationResult.status === 'fulfilled';
    raw.speed = settledValue(speedResult);
    raw.speedAvailable = speedResult.status === 'fulfilled';
    const nativeKey = settledValue(keyResult) || {};
    raw.key.nativePhase = nativeKey.phase;
    raw.key.pendingCount = nativeKey.pendingCount ?? nativeKey.remainingCount;
    if (keyResult.status === 'rejected') raw.key.state = 'unavailable';
  }
  return sanitizeCampaignState(raw);
}
