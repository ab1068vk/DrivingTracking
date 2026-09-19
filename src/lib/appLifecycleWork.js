import { isAndroid } from '@/lib/nativePlatform';
import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { createP5RawGpsRetentionAdapter } from '@/lib/p5RawGpsRetentionAdapter';
import { runNativeProjectionTurn } from '@/lib/nativeProjectionMaintenance';
import { queryClientInstance } from '@/lib/query-client';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
  validateRegistrationSemantics,
} from '@/lib/appWorkCoordinator';
import {
  getLifecycleSnapshot,
  subscribeLifecycleSignals,
} from '@/lib/lifecycleAuthority';
import { P6_JOB_KEYS, P6_TURN_BUDGET } from '@/lib/p6Contracts';

export const APP_WORK_TRIGGER_ORIGINS = Object.freeze({
  BOOTSTRAP: 'bootstrap',
  RESUME: 'resume',
  PAGE_OPEN: 'page-open',
  EXPLICIT_USER: 'explicit-user',
  INTERNAL_CONTINUATION: 'internal-continuation',
  OTHER_REVIEWED: 'other-reviewed-origin',
});

export const APP_WORK_EXTENTS = Object.freeze({
  BOUNDED_TURN: 'bounded-turn',
  FULL_HISTORY: 'full-history',
  DURABILITY_CRITICAL_NATIVE_OWNED: 'durability-critical/native-owned',
  EXPLICIT_USER_OPERATION: 'explicit-user-operation',
});

export const P4_LIFECYCLE_JOB_KEYS = Object.freeze({
  NATIVE_PROJECTION: 'nativeProjection',
  NATIVE_JOURNAL_INGEST: 'nativeJournalIngest',
  ROAD_CONTEXT: 'roadContextContinuation',
  RESCORING: 'rescoringContinuation',
  SPEED_MAINTENANCE: 'speedMaintenance',
  REPOSITORY_MAINTENANCE: 'repositoryMaintenance',
  KEY_ROTATION: 'keyRotationBatches',
  LEGACY_MIGRATION: 'legacyMigration',
  MILESTONE_RECONCILIATION: 'milestoneReconciliation',
});

export const P5_LIFECYCLE_JOB_KEYS = Object.freeze({
  NATIVE_RAW_GPS_RETENTION: 'p5NativeRawGpsRetention',
  JOURNAL_MANIFEST_RECONCILE: 'p5JournalManifestReconcile',
  ARCHIVE_INTEGRITY_CHECKPOINT: 'p5ArchiveIntegrityCheckpoint',
  ARCHIVE_RESIDUE_GC: 'p5ArchiveResidueGc',
});

/**
 * P4-B-F01-3-A. The domain-completion events a registration may declare as a
 * follow-up trigger. A domain follow-up is not a lifecycle trigger and carries
 * no origin, so this is the only vocabulary that authorizes one; it is
 * enumerated here, next to the job keys, so a permitted reason and the caller
 * that raises it can never drift apart into two string literals.
 */
export const P4_DOMAIN_FOLLOW_UP_REASONS = Object.freeze({
  PROGRESSION_MIGRATION_COMPLETE: 'progression_migration_complete',
});

/**
 * M23 reviewed allowlist. Everything a lifecycle trigger can start is either a
 * registered coordinator job above or named here with its ownership reason.
 * Adapting something is never "inconvenient enough" to earn a place here.
 */
export const P4_LIFECYCLE_ALLOWLIST = Object.freeze([
  Object.freeze({
    entryPoint: 'DriveSenseAutoTrackingService / DriveSenseActiveTripSpool',
    reason: 'durability-critical/native-owned: active-trip capture survives renderer death and must never be paused, replayed or reordered by the coordinator (P4-C23, DN11).',
  }),
  Object.freeze({
    entryPoint: 'browserActiveTripSpool writeQueue',
    reason: 'durability-critical: the browser fallback spool is the capture durability boundary and owns its own serialized writes.',
  }),
  Object.freeze({
    entryPoint: 'dataRights export / restore / erasure',
    reason: 'explicit user operation (DN10): user-visible cancellation and atomicity contracts are separate from idle background admission.',
  }),
  Object.freeze({
    entryPoint: 'calibration and privacy archive jobs (Settings)',
    reason: 'explicit user operation (DN10): started from a user action with its own progress and cancellation surface.',
  }),
]);

/**
 * Jobs whose bounded unit is executed by the native canonical archive. Without
 * native authority they have no owner at all, so admitting them would surface a
 * spurious coordinator failure for work nothing can do.
 *
 * P4-C-F02 adds legacy migration: its very first operation is a native journal
 * ingest and every row it moves is a native ingress commit, so on web - or on
 * Android with P3.5 native authority still dark - it must report ownerless
 * rather than call an unavailable plugin.
 */
const NATIVE_AUTHORITY_JOBS = new Set([
  P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION,
  P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST,
  P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION,
  ...Object.values(P5_LIFECYCLE_JOB_KEYS),
]);

const LIFECYCLE_ORIGINS = new Set([
  APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,
  APP_WORK_TRIGGER_ORIGINS.RESUME,
  APP_WORK_TRIGGER_ORIGINS.PAGE_OPEN,
]);
const TRIGGER_ORIGIN_VALUES = new Set(Object.values(APP_WORK_TRIGGER_ORIGINS));
const WORK_EXTENT_VALUES = new Set(Object.values(APP_WORK_EXTENTS));
const DOMAIN_FOLLOW_UP_REASON_VALUES = new Set(Object.values(P4_DOMAIN_FOLLOW_UP_REASONS));
const WORK_CLASS_VALUES = new Set(Object.values(APP_WORK_CLASSES));

/**
 * M24 — the frozen P5–P7 lifecycle registration contract.
 *
 * P4 registers no future-phase job; it freezes the shape any P5–P7 background
 * job must declare, and the guard that enforces it. Compliance is those
 * phases' own exit criterion, not P4's.
 *
 * The contract is fail-closed by construction: `assertP5RegistrationContract`
 * rejects anything missing a required declaration, and the structural rules
 * below make the specific hazards unrepresentable rather than merely
 * discouraged.
 */
export const P5_REGISTRATION_CONTRACT = Object.freeze({
  version: 1,
  required: Object.freeze([
    'jobKey',
    'triggerOrigins',
    'workExtent',
    'workClass',
    'runTurn',
    'budget',
    'newEpochPolicy',
  ]),
  conditional: Object.freeze([
    'admissionGuard',
    'criticalSection',
    'domainStateOwner',
  ]),
  forbidden: Object.freeze([
    'an independent lifecycle scheduler',
    'routine full-history startup/resume/page-open work',
    'a private next-turn requeue that bypasses coordinator admission',
    'duplicate canonical or durable checkpoint state',
    'unbounded payload retained in coordinator state',
    'arbitrary numeric priority ratios',
    'secureBridge or native-writer priority classes',
  ]),
});

/**
 * Fail-closed guard for a future P5–P7 registration. Returns the frozen
 * declaration on success; throws a typed reason on any violation.
 */
export function assertP5RegistrationContract(definition = {}) {
  for (const field of P5_REGISTRATION_CONTRACT.required) {
    if (definition[field] === undefined || definition[field] === null) {
      throw new TypeError(`P5 registration contract: missing required declaration "${field}"`);
    }
  }
  if (typeof definition.runTurn !== 'function') {
    throw new TypeError('P5 registration contract: runTurn must be a bounded-turn callback');
  }
  /**
   * P4-D-F04. `domainStateOwner` is *conditional* - "where relevant" - exactly
   * as `P5_REGISTRATION_CONTRACT.conditional` declares. A genuinely stateless
   * bounded job has no durable domain state whose ownership could be
   * duplicated, so demanding an owner from it would invent a requirement the
   * frozen contract does not make. When one is supplied it must be a real
   * declaration; the prohibition that actually matters - a coordinator-owned
   * duplicate durable checkpoint - is enforced unconditionally below.
   */
  const ownerDeclared = definition.domainStateOwner !== undefined
    && definition.domainStateOwner !== null;
  if (ownerDeclared
    && (typeof definition.domainStateOwner !== 'string' || !definition.domainStateOwner.trim())) {
    throw new TypeError('P5 registration contract: a declared domain state owner must name its owner');
  }
  if (definition.selfSchedules === true) {
    throw new TypeError('P5 registration contract: a job may not schedule its own next coordinated turn');
  }
  if (definition.coordinatorCheckpoint !== undefined) {
    throw new TypeError('P5 registration contract: durable checkpoints stay with the domain owner');
  }
  if (definition.priorityRatio !== undefined || definition.priorityWeight !== undefined) {
    throw new TypeError('P5 registration contract: numeric priority ratios and weights are rejected');
  }
  if (definition.bridgePriority !== undefined || definition.nativeWriterPriority !== undefined) {
    throw new TypeError('P5 registration contract: secureBridge and native-writer priority classes are rejected');
  }
  // Lifecycle/full-history and trigger-origin rules are the same ones production
  // jobs already obey, reused rather than restated so they cannot drift apart.
  const semantics = freezeRegistrationSemantics(definition);
  if (!WORK_CLASS_VALUES.has(definition.workClass)) {
    throw new TypeError('P5 registration contract: unsupported semantic work class');
  }
  if (!definition.budget || typeof definition.budget !== 'object') {
    throw new TypeError('P5 registration contract: a bounded turn must declare its budget dimensions');
  }
  /**
   * P4-D-F05. The guard must fail closed on the *semantics* of the required
   * declarations, not merely on their presence. `newEpochPolicy` and `budget`
   * are validated by the coordinator's own registration validator - the same
   * function `registerJob` calls - so a declaration this guard certifies is by
   * construction one real registration accepts, and neither side can grow a
   * private enum or a private budget law.
   */
  let validated;
  try {
    validated = validateRegistrationSemantics({
      workClass: definition.workClass,
      newEpochPolicy: definition.newEpochPolicy,
      budget: definition.budget,
    });
  } catch (error) {
    throw new TypeError(`P5 registration contract: ${error.message}`);
  }
  return Object.freeze({
    ...semantics,
    workClass: validated.workClass,
    newEpochPolicy: validated.newEpochPolicy,
    budget: validated.budget,
    domainStateOwner: ownerDeclared ? definition.domainStateOwner.trim() : null,
  });
}

const freezeDomainFollowUpReasons = (reasons) => {
  if (reasons === undefined || reasons === null) return Object.freeze([]);
  if (!Array.isArray(reasons) || reasons.length === 0) {
    throw new TypeError('Declared domain follow-up reasons must be a non-empty array of domain event names');
  }
  const declared = [...new Set(reasons)];
  if (declared.some((reason) => !DOMAIN_FOLLOW_UP_REASON_VALUES.has(reason))) {
    throw new TypeError('Lifecycle work registration declared an unsupported domain follow-up reason');
  }
  return Object.freeze(declared);
};

const freezeRegistrationSemantics = ({ jobKey, triggerOrigins, workExtent, domainFollowUpReasons }) => {
  if (typeof jobKey !== 'string' || !jobKey.trim()) {
    throw new TypeError('Lifecycle work registration requires a stable jobKey');
  }
  if (!Array.isArray(triggerOrigins) || triggerOrigins.length === 0) {
    throw new TypeError('Lifecycle work registration requires declared trigger origins');
  }
  const origins = [...new Set(triggerOrigins)];
  if (origins.some((origin) => !TRIGGER_ORIGIN_VALUES.has(origin))) {
    throw new TypeError('Lifecycle work registration contains an unsupported trigger origin');
  }
  if (!WORK_EXTENT_VALUES.has(workExtent)) {
    throw new TypeError('Lifecycle work registration requires a supported work extent');
  }
  if (
    workExtent === APP_WORK_EXTENTS.FULL_HISTORY &&
    origins.some((origin) => LIFECYCLE_ORIGINS.has(origin))
  ) {
    throw new TypeError('Full-history work cannot be registered from lifecycle, startup, resume, or page-open');
  }
  return Object.freeze({
    jobKey: jobKey.trim(),
    triggerOrigins: Object.freeze(origins),
    workExtent,
    // Default deny: a registration that declares nothing here has no domain
    // follow-up entry point at all.
    domainFollowUpReasons: freezeDomainFollowUpReasons(domainFollowUpReasons),
  });
};

/**
 * Structural lifecycle registration boundary. Safety is derived from immutable
 * semantics, never from a callback's symbol name or source text.
 */
export function createLifecycleWorkRegistrationBoundary(coordinator) {
  if (!coordinator || typeof coordinator.registerJob !== 'function') {
    throw new TypeError('Lifecycle work boundary requires an application coordinator');
  }
  const registrations = new Map();

  const register = (definition) => {
    const semantics = freezeRegistrationSemantics(definition || {});
    if (registrations.has(semantics.jobKey)) {
      throw new Error(`Lifecycle work is already registered: ${semantics.jobKey}`);
    }
    const unregister = coordinator.registerJob({
      jobKey: semantics.jobKey,
      workClass: definition.workClass,
      runTurn: definition.runTurn,
      budget: definition.budget,
      newEpochPolicy: definition.newEpochPolicy,
      admissionGuard: definition.admissionGuard || null,
      domainFollowUpReasons: semantics.domainFollowUpReasons.length > 0
        ? semantics.domainFollowUpReasons
        : null,
    });
    const entry = Object.freeze({ ...semantics, workClass: definition.workClass });
    registrations.set(semantics.jobKey, { entry, unregister });
    return entry;
  };

  const admit = (jobKey, { origin, epoch, wake = null } = {}) => {
    const registered = registrations.get(jobKey);
    if (!registered) throw new Error(`Lifecycle work is not registered: ${jobKey}`);
    if (!TRIGGER_ORIGIN_VALUES.has(origin)) throw new TypeError('Lifecycle admission requires a supported trigger origin');
    if (origin === APP_WORK_TRIGGER_ORIGINS.INTERNAL_CONTINUATION) {
      throw new TypeError('Internal continuation is coordinator-owned and cannot be externally admitted');
    }
    if (!registered.entry.triggerOrigins.includes(origin)) {
      throw new TypeError(`Trigger origin ${origin} is not declared for ${jobKey}`);
    }
    if (registered.entry.workExtent === APP_WORK_EXTENTS.FULL_HISTORY && LIFECYCLE_ORIGINS.has(origin)) {
      throw new TypeError('Full-history lifecycle admission is forbidden');
    }
    return coordinator.admit(jobKey, { epoch, trigger: origin, wake });
  };

  const snapshot = () => Object.freeze(
    [...registrations.values()].map(({ entry }) => entry)
  );

  return Object.freeze({ register, admit, snapshot });
}

const authorityTokenFromHealth = (health) => Object.freeze({
  archiveGeneration: String(health.archiveGeneration || ''),
  erasureToken: String(health.erasureBarrierToken || health.archiveGeneration || ''),
});

export function createNativeAuthorityAdmissionGuard({
  nativeAuthorityAvailable,
  readHealth,
} = {}) {
  if (typeof nativeAuthorityAvailable !== 'function' || typeof readHealth !== 'function') {
    throw new TypeError('Native authority guard requires availability and health readers');
  }
  return async () => {
    if (!nativeAuthorityAvailable()) {
      return {
        outcome: APP_WORK_TURN_RESULTS.DEFERRED,
        wake: { type: 'native_authority', key: 'available' },
      };
    }
    let health;
    try {
      health = await readHealth();
    } catch {
      return {
        outcome: APP_WORK_TURN_RESULTS.DEFERRED,
        wake: { type: 'canonical_health', key: 'healthy' },
      };
    }
    const authorityReady = health?.authorityState === 'NATIVE' || health?.testAuthorityEnabled === true;
    if (!authorityReady || health?.recoveryState !== 'HEALTHY' || health?.sentinelMatches !== true) {
      return {
        outcome: APP_WORK_TURN_RESULTS.DEFERRED,
        wake: { type: 'canonical_health', key: 'healthy' },
      };
    }
    const token = authorityTokenFromHealth(health);
    if (!token.archiveGeneration) {
      return {
        outcome: APP_WORK_TURN_RESULTS.DEFERRED,
        wake: { type: 'canonical_health', key: 'healthy' },
      };
    }
    return { outcome: 'ready', token };
  };
}

const consumeResult = (budget, { items = 0, bytes = 0 } = {}) => {
  const accountedItems = Math.max(0, Number(items) || 0);
  const accountedBytes = Math.max(0, Number(bytes) || 0);
  if (accountedItems === 0 && accountedBytes === 0) budget.reportZeroWork();
  else budget.consume({ items: accountedItems, bytes: accountedBytes });
};

const turnOutcomeForProjection = (result) => {
  if (result?.obsolete === true) return APP_WORK_TURN_RESULTS.OBSOLETE;
  // P4-B-F02: a domain condition the *same logical instance* can clear on its
  // own next bounded attempt is a continuation, not a deferral. Sleeping on a
  // typed wake would need a producer to re-admit it; `hasMore` is the
  // coordinator's own automatic tail re-admission, with its yield in between.
  if (result?.retry === true) return APP_WORK_TURN_RESULTS.HAS_MORE;
  // P4-B-F02: the domain spent its own bounded retry allowance. Surfacing this
  // as a non-retryable failure settles the instance terminally with the
  // coordinator's existing needs-attention scalar, instead of parking it on a
  // typed wake nothing currently produces.
  if (result?.failed === true) {
    return { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: false };
  }
  if (result?.deferred === true) {
    return {
      outcome: APP_WORK_TURN_RESULTS.DEFERRED,
      // A domain that knows what it is waiting for names it; canonical health
      // stays the default for the authority conditions that own it.
      wake: result.wake || { type: 'canonical_health', key: 'healthy' },
    };
  }
  return result?.done === true ? APP_WORK_TURN_RESULTS.DONE : APP_WORK_TURN_RESULTS.HAS_MORE;
};

/**
 * A per-logical-instance scheduling cursor. This is coordinator metadata (which
 * bounded unit comes next), never a domain checkpoint: one slot, reset whenever
 * a new logical instance takes over.
 */
const instanceCursor = () => {
  let held = { instanceId: null, value: null };
  return {
    read: (instanceId) => (held.instanceId === instanceId ? held.value : null),
    write: (instanceId, value) => { held = { instanceId, value }; },
  };
};

/**
 * P4-C-F07. The typed condition a rescoring turn waits on when persisted work
 * exists but no worker is registered yet. Its producer is worker registration.
 */
export const RESCORING_WORKER_WAKE = Object.freeze({ type: 'rescoring_worker', key: 'ready' });

const turnResultFor = (hasMore) => (
  hasMore ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE
);

/**
 * P4-C-F09 — the declared item budget is the bounded logical unit the turn
 * actually reads, not the subset of rows it happens to change.
 *
 * Each ceiling below is the domain's own worst-case examined count for one
 * turn. They are declared here so the coordinator does not have to eagerly load
 * every domain module, and `p4cAdapterAccounting.test.js` asserts each one still
 * equals the constant the domain derives it from - a domain that widens its
 * window without widening its ceiling fails that assertion rather than silently
 * over-running its budget.
 */
export const P4_LIFECYCLE_TURN_BUDGET_CEILINGS = Object.freeze({
  // roadContextQueue: ROAD_CONTEXT_PAGE_PROBES (4) x ROAD_CONTEXT_QUEUE_PAGE_SIZE (25).
  [P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT]: 100,
  // rescoringQueue: RESCORING_TURN_MAX_EXAMINED - one CHUNK of trip ids plus the
  // index records a turn may visit to reach them.
  [P4_LIFECYCLE_JOB_KEYS.RESCORING]: 36,
  // localTripRepository: REPOSITORY_MAINTENANCE_MAX_EXAMINED - the widest
  // subpass is one projection verify slice: 256 source + 256 projection rows,
  // plus the 3 independent source re-reads each of up to 8 repaired mismatches
  // costs (classify, rebuild, guarded commit).
  [P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE]: 536,
  // keyRotationManager: one TRIP_KEY_ROTATION_WINDOW of source records plus the
  // same window of summary records.
  [P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION]: 50,
});

export function createP4LifecycleWorkRuntime({
  coordinator = createAppWorkCoordinator(),
  nativeAuthorityAvailable,
  readHealth,
  runProjectionTurn,
  runJournalTurn,
  onJournalItems = () => {},
  onJournalSettled = () => {},
  runMilestoneReconciliationTurn = null,
  runRoadContextTurn = async () => {
    const { stepPendingRoadContextJobs } = await import('@/lib/roadContextQueue');
    const outcome = await stepPendingRoadContextJobs({ maxEntries: 4 });
    // P4-C-F09: every queue entry this turn read, not only the ones it ran. A
    // turn that inspects a page and finds every entry in backoff still consumed
    // those entries. A pre-existing monolithic v1 document is not counted here
    // at all - a lifecycle turn never touches it (P4-C-F06-A).
    const items = Math.max(0, Number(outcome.examined) || 0);
    return { items, result: turnResultFor(outcome.hasMore) };
  },
  /**
   * P4-C-F09: one batch is up to 20 trips, and that is what the turn reports -
   * a batch of 20 used to be accounted as a single item.
   */
  runRescoringTurn = async () => {
    const { stepRescoringQueue, setRescoringCoordinatorOwned } = await import('@/lib/rescoringQueue');
    setRescoringCoordinatorOwned(true);
    const outcome = await stepRescoringQueue();
    if (outcome.awaitingWorker === true) {
      // P4-C-F07: a typed wait whose producer is worker registration, instead
      // of a zero-work `hasMore` the coordinator would re-admit forever.
      return {
        items: 0,
        result: { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: RESCORING_WORKER_WAKE },
      };
    }
    // P4-C-F09: every trip id this batch read plus the index records it visited,
    // including the trips it attempted and failed.
    return { items: Number(outcome.examined) || 0, result: turnResultFor(outcome.hasMore) };
  },
  runSpeedMaintenanceTurn = null,
  runRepositoryMaintenanceTurn = null,
  /**
   * P4-C-F05/F09. One bounded KEK batch per turn on both platforms, accounted
   * with the records that batch actually rewrapped - native envelope records on
   * Android, IndexedDB ciphertext records in the browser - instead of a native
   * counter that is always zero off Android.
   */
  runKeyRotationTurn = async () => {
    const { stepEncryptionKeyRotation } = await import('@/lib/keyRotationManager');
    const outcome = await stepEncryptionKeyRotation();
    // P4-C-F09: every ciphertext record the batch read, not only the ones whose
    // rewrap changed anything, plus the fixed encrypted-JSON key set it checks.
    const examined = Math.max(
      Number(outcome?.recordsExamined) || 0,
      (Number(outcome?.nativeEnvelopeRecordsRewrapped) || 0) +
        (Number(outcome?.indexedDbRecordsRotated) || 0) +
        (Number(outcome?.encryptedJsonValuesRotated) || 0)
    );
    return { items: examined, result: turnResultFor(outcome?.hasMore === true) };
  },
  runMigrationTurnAdapter = async () => {
    const { stepLegacyMigration } = await import('@/lib/p35Migration');
    const turn = await stepLegacyMigration();
    if (turn.outcome === 'backoff') {
      return { items: 0, result: { outcome: APP_WORK_TURN_RESULTS.BACKOFF, wake: { type: 'time', eligibleAt: Date.now() + 60_000 } } };
    }
    if (turn.outcome === 'deferred') {
      return { items: 0, result: { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'canonical_health', key: 'healthy' } } };
    }
    if (turn.outcome === 'failing') return { items: 0, result: APP_WORK_TURN_RESULTS.FAILING };
    // P4-C-F09: the rows this turn visited. The journal unit reports
    // `itemCount`; a scan page reports the rows it visited in this invocation,
    // never the pass-to-date total, and a promotion turn reports zero.
    return { items: Number(turn.itemCount) || 0, result: turnResultFor(turn.outcome === 'hasMore') };
  },
  runP5RawGpsRetentionTurn = async () => ({ state: 'OWNERLESS_OR_BLOCKED', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  runP5JournalReconcileTurn = async () => ({ state: 'COMPLETE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  runP5IntegrityTurn = async () => ({ state: 'COMPLETE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  runP5ResidueGcTurn = async () => ({ state: 'COMPLETE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  enableP5Registrations = true,
  runP6TripDerivedTurn = async () => ({ state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  runP6RoadMemoryTurn = async () => ({ state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  runP6AffectedSelectionTurn = async () => ({ state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false }),
  enableP6Registrations = false,
} = {}) {
  const speedCursor = instanceCursor();
  const repositoryCursor = instanceCursor();
  const milestoneCursor = instanceCursor();
  /**
   * P4-C-F08/F09. The instance cursor caches the native job id for this live
   * instance only - the native domain can always resolve it again - and the
   * turn reports the buckets the native step actually processed. It used to
   * report eight whenever `hasMore` was true, which credited the begin
   * handshake with eight buckets it never touched and credited a final
   * eight-bucket step with none.
   */
  const speedTurn = runSpeedMaintenanceTurn || (async ({ instanceId }) => {
    const { speedKnowledgeRepository } = await import('@/lib/speedKnowledgeRepository');
    const held = speedCursor.read(instanceId) || {};
    const status = await speedKnowledgeRepository.stepMaintenanceTurn('retention', {
      jobId: held.jobId || null,
    });
    const processedTotal = Math.max(0, Number(status?.processedBuckets) || 0);
    const items = Math.max(0, processedTotal - (Number(held.processedBuckets) || 0));
    const hasMore = status?.hasMore === true;
    speedCursor.write(instanceId, hasMore
      ? { jobId: status?.jobId || null, processedBuckets: processedTotal }
      : null);
    return { items, result: turnResultFor(hasMore) };
  });
  /**
   * P4-C-F04/F09. One bounded repository subpass window per turn. The subpass
   * decides which unit comes next - a window that still has records left keeps
   * the sequence on the same unit - and reports how many records it actually
   * touched, so `items` is the domain's own count instead of a fixed 1.
   */
  const repositoryTurn = runRepositoryMaintenanceTurn || (async ({ instanceId }) => {
    const { stepTripRepositoryMaintenance } = await import('@/lib/localTripRepository');
    const unitIndex = Number(repositoryCursor.read(instanceId)) || 0;
    let outcome;
    try { outcome = await stepTripRepositoryMaintenance({ unitIndex }); }
    catch (error) {
      if (error?.code === 'CONVERSION_REQUIRED') return {
        items: Number(error.itemsWorked) || 0,
        bytes: Number(error.bytesWorked) || 0,
        result: { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'compatibility_conversion', key: 'privacy_audit_v1' } },
      };
      if (error?.code?.startsWith('AUDIT_')) return {
        items: Number(error.itemsWorked) || 0, bytes: Number(error.bytesWorked) || 0,
        result: ['AUDIT_BUSY', 'AUDIT_CONFLICT', 'AUDIT_STORAGE_BUSY', 'AUDIT_INITIALIZING'].includes(error.code)
          ? { outcome: APP_WORK_TURN_RESULTS.BACKOFF, wake: { type: 'time', eligibleAt: Date.now() + 1000 } }
          : { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: !['AUDIT_INTEGRITY_FAILED', 'AUDIT_STORAGE_LOST', 'AUDIT_ERASING', 'AUDIT_FORMAT_INVALID', 'AUDIT_LOCK_UNAVAILABLE'].includes(error.code) },
      };
      throw error;
    }
    repositoryCursor.write(instanceId, outcome.hasMore ? outcome.nextUnitIndex : 0);
    // P4-C-F09: the rows the subpass read this invocation. A verification slice
    // that checks 256 rows and repairs none still consumed 256 row units.
    return { items: (Number(outcome.examined) || 0) + (Number(outcome.auditItemsWorked) || 0),
      bytes: Number(outcome.auditBytesWorked) || 0, result: turnResultFor(outcome.hasMore) };
  });
  /**
   * P4-B-F01. One bounded milestone-reconciliation slice per turn, driven
   * through the milestone domain's own step interface. The coordinator holds
   * only the run id - the window, the paging cursor and every notification
   * decision stay with the domain owner, and nothing durable is added.
   */
  const milestoneTurn = runMilestoneReconciliationTurn || (async ({ instanceId }) => {
    const milestones = await import('@/lib/milestoneNotificationCoordinator');
    let runId = milestoneCursor.read(instanceId);
    if (!runId) {
      runId = milestones.beginMilestoneReconciliationRun({});
      milestoneCursor.write(instanceId, runId);
    }
    try {
      const outcome = await milestones.stepMilestoneReconciliationRun(runId);
      const hasMore = outcome?.hasMore === true && outcome?.obsolete !== true;
      if (!hasMore) milestoneCursor.write(instanceId, null);
      return { items: Number(outcome?.items) || 0, result: turnResultFor(hasMore) };
    } catch (error) {
      milestoneCursor.write(instanceId, null);
      // Surfaced through this job's own telemetry. It can no longer rewrite the
      // journal/domain result, which settled correctly before this was admitted.
      logSystemFailure('native_canonical_journal_milestone_sync', error);
      return { items: 0, result: APP_WORK_TURN_RESULTS.FAILING };
    }
  });
  const boundary = createLifecycleWorkRegistrationBoundary(coordinator);
  const admissionGuard = createNativeAuthorityAdmissionGuard({ nativeAuthorityAvailable, readHealth });

  boundary.register({
    jobKey: P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION,
    triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, APP_WORK_TRIGGER_ORIGINS.RESUME],
    workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
    workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 100, bytes: 256 * 1024, turns: 8 },
    admissionGuard,
    runTurn: async ({ admissionToken, budget, criticalSection }) => {
      const result = await criticalSection.run(() => runProjectionTurn({
        expectedGeneration: admissionToken.archiveGeneration,
      }));
      consumeResult(budget, {
        items: (Number(result?.applied) || 0) + (Number(result?.deleted) || 0),
      });
      return turnOutcomeForProjection(result);
    },
  });

  const registerP5 = (definition) => {
    assertP5RegistrationContract(definition);
    return boundary.register(definition);
  };
  const p5Turn = (runDomainTurn) => async ({ budget: turnBudget, criticalSection, instanceId, admissionToken }) => {
    const outcome = await criticalSection.run(() => runDomainTurn({ instanceId, archiveGeneration: admissionToken?.archiveGeneration }));
    consumeResult(turnBudget, {
      items: Math.max(0, Number(outcome?.itemsWorked) || 0),
      bytes: Math.max(0, Number(outcome?.bytesWorked) || 0),
    });
    if (outcome?.state === 'BLOCKED_PRIVACY_LEDGER') {
      return { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: false };
    }
    if (outcome?.state === 'CONVERSION_REQUIRED') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'compatibility_conversion', key: 'privacy_audit_v1' } };
    }
    if (['AUDIT_BUSY', 'AUDIT_CONFLICT', 'AUDIT_STORAGE_BUSY', 'AUDIT_INITIALIZING'].includes(outcome?.state)) {
      return { outcome: APP_WORK_TURN_RESULTS.BACKOFF, wake: { type: 'time', eligibleAt: Date.now() + 1000 } };
    }
    if (outcome?.state?.startsWith('AUDIT_') || outcome?.state === 'PRIVACY_RECEIPT_FAILED') {
      return { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: !['AUDIT_INTEGRITY_FAILED', 'AUDIT_STORAGE_LOST', 'AUDIT_ERASING', 'AUDIT_FORMAT_INVALID', 'AUDIT_LOCK_UNAVAILABLE'].includes(outcome.state) };
    }
    if (outcome?.state === 'BLOCKED_RECOVERY' || outcome?.state === 'OWNERLESS_OR_BLOCKED') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'canonical_health', key: 'healthy' } };
    }
    if (outcome?.state === 'BLOCKED_EXPORT_LEASE') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'export_lease', key: 'closed' } };
    }
    if (outcome?.state === 'BLOCKED_NATIVE_OPERATION') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'native_operation', key: 'idle' } };
    }
    if (outcome?.state === 'BLOCKED_JOURNAL_REPAIR') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'journal_state', key: 'repairable' } };
    }
    return turnResultFor(outcome?.hasMore === true);
  };
  if (enableP5Registrations) registerP5({
    jobKey: P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION,
    triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,APP_WORK_TRIGGER_ORIGINS.RESUME,APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED],
    workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    runTurn:p5Turn(runP5RawGpsRetentionTurn),budget:{items:16,bytes:3*1024*1024,turns:8},
    newEpochPolicy:APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,admissionGuard,
    criticalSection:'native current-pointer publication or audit entry/index/head commit; disjoint turns',
    domainStateOwner:'native archive retention; hashChainLog privacy audit',
  });
  if (enableP5Registrations) registerP5({
    jobKey:P5_LIFECYCLE_JOB_KEYS.JOURNAL_MANIFEST_RECONCILE,
    triggerOrigins:[APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,APP_WORK_TRIGGER_ORIGINS.RESUME,APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED],
    workExtent:APP_WORK_EXTENTS.BOUNDED_TURN,workClass:APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    runTurn:p5Turn(async () => {
      const result = await runP5JournalReconcileTurn();
      if (result?.summaryState === 'VERIFIED') {
        admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, {
          origin: lastLifecycleTrigger,
          epoch: coordinator.getCoordinatorSnapshot().lifecycleEpoch,
          wake: { type: 'journal_state', key: 'repairable' },
        });
      }
      return result;
    }),budget:{items:32,bytes:5*1024*1024,turns:8},
    newEpochPolicy:APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,
    criticalSection:'journal derived summary swap only',domainStateOwner:'completed trip journal',
  });
  if (enableP5Registrations) registerP5({
    jobKey:P5_LIFECYCLE_JOB_KEYS.ARCHIVE_INTEGRITY_CHECKPOINT,
    triggerOrigins:[APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,APP_WORK_TRIGGER_ORIGINS.RESUME,APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED],
    workExtent:APP_WORK_EXTENTS.BOUNDED_TURN,workClass:APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    runTurn:p5Turn(runP5IntegrityTurn),budget:{items:256,bytes:512*1024,turns:8},
    newEpochPolicy:APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,admissionGuard,
    criticalSection:'checkpoint event and existing sentinel publication',domainStateOwner:'native archive integrity',
  });
  if (enableP5Registrations) registerP5({
    jobKey:P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC,
    triggerOrigins:[APP_WORK_TRIGGER_ORIGINS.RESUME,APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED],
    workExtent:APP_WORK_EXTENTS.BOUNDED_TURN,workClass:APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    runTurn:p5Turn(runP5ResidueGcTurn),budget:{items:32,bytes:2*1024*1024,turns:8},
    newEpochPolicy:APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,admissionGuard,
    criticalSection:'unlink debt completion only',domainStateOwner:'native archive unlink debt',
  });

  const p6Turn = (runDomainTurn) => async ({ budget: turnBudget, criticalSection, instanceId }) => {
    const outcome = await criticalSection.run(() => runDomainTurn({ instanceId }));
    consumeResult(turnBudget, {
      items: Math.max(0, Number(outcome?.itemsWorked) || 0),
      bytes: Math.max(0, Number(outcome?.bytesWorked) || 0),
    });
    if (outcome?.state === 'DERIVED_STORAGE_BLOCKED') {
      return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'storage', key: 'derived-capacity' } };
    }
    if (outcome?.state === 'WAITING_FOR_OWNER') {
      return { outcome: APP_WORK_TURN_RESULTS.BACKOFF, wake: { type: 'time', eligibleAt: Date.now() + 1000 } };
    }
    if (outcome?.state === 'REPAIR_ESCALATED') return { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: false };
    return turnResultFor(outcome?.hasMore === true);
  };
  const registerP6 = (definition) => {
    assertP5RegistrationContract(definition);
    return boundary.register(definition);
  };
  if (enableP6Registrations) {
    for (const [jobKey, owner, runDomainTurn, section] of [
      [P6_JOB_KEYS.TRIP_DERIVED_UPDATES, 'tripDerivedState', runP6TripDerivedTurn, 'revision compare and derived manifest publication'],
      [P6_JOB_KEYS.ROAD_MEMORY_UPDATES, 'speedDerivedState', runP6RoadMemoryTurn, 'speed owner scoped publication and observation receipt'],
      [P6_JOB_KEYS.AFFECTED_TRIP_SELECTION, 'speedCorrectionSelection', runP6AffectedSelectionTurn, 'rescore queue receipt publication'],
    ]) registerP6({
      jobKey,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, APP_WORK_TRIGGER_ORIGINS.RESUME, APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED],
      workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      runTurn: p6Turn(runDomainTurn),
      budget: { ...P6_TURN_BUDGET },
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,
      criticalSection: section,
      domainStateOwner: owner,
    });
  }

  boundary.register({
    jobKey: P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST,
    triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, APP_WORK_TRIGGER_ORIGINS.RESUME],
    workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
    workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 8, bytes: 8 * 1024 * 1024, turns: 8 },
    admissionGuard,
    runTurn: async ({ budget, criticalSection, lifecycleEpoch }) => {
      const result = await criticalSection.run(() => runJournalTurn(8, 8 * 1024 * 1024));
      const itemCount = Math.max(0, Number(result?.itemCount) || 0);
      const workBytes = Math.max(0, Number(result?.workBytes ?? result?.processedBytes) || 0);
      consumeResult(budget, { items: itemCount, bytes: workBytes });
      if (result?.state === 'BLOCKED_JOURNAL_REPAIR') {
        const wake = { type: 'journal_state', key: 'repairable' };
        if (enableP5Registrations) admit(P5_LIFECYCLE_JOB_KEYS.JOURNAL_MANIFEST_RECONCILE, {
          origin: APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED, epoch: lifecycleEpoch, wake,
        });
        return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake };
      }
      if (itemCount > 0) await onJournalItems(result);
      const hasMore = result?.hasMore === true;
      // The pre-P4 bootstrap/resume path reconciled milestones once per
      // trigger with `reconcileExisting: true`, even when nothing was
      // imported. The journal instance's last turn is that same once-per
      // bootstrap/resume point, so the notification obligation survives
      // the move onto the coordinator instead of being dropped.
      //
      // P4-B-F01: it survives as an *admission*, not as work done here. This
      // turn neither performs nor awaits any milestone work, so the accounting
      // above is the whole truth about what it consumed, and it can never wait
      // behind the process-local milestone queue. Coordinator admission is also
      // what keeps the cadence exactly once per settled logical instance.
      if (!hasMore) onJournalSettled(result, admitMilestoneReconciliation(lifecycleEpoch));
      return hasMore
        ? APP_WORK_TURN_RESULTS.HAS_MORE
        : APP_WORK_TURN_RESULTS.DONE;
    },
  });

  // Step 12: the remaining lifecycle-owned suspendible entry points. Each is
  // one existing bounded domain unit per turn; none is native-authority gated,
  // so they carry no admission guard and run on web as well as Android.
  const domainTurns = [
    [P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, { items: P4_LIFECYCLE_TURN_BUDGET_CEILINGS[P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT], turns: 8 }, runRoadContextTurn],
    [P4_LIFECYCLE_JOB_KEYS.RESCORING, { items: P4_LIFECYCLE_TURN_BUDGET_CEILINGS[P4_LIFECYCLE_JOB_KEYS.RESCORING], turns: 8 }, runRescoringTurn],
    [P4_LIFECYCLE_JOB_KEYS.SPEED_MAINTENANCE, { items: 8, turns: 8 }, speedTurn],
    // P4-C-F04/F09. The repository turn's real ceiling, not the fiction that one
    // whole subpass is one item: the widest bounded subpass is one projection
    // maintenance slice - 8 backfilled rows + 256 verified rows + 32 cleanup
    // rows - and every other subpass advances at most one 25-record repository
    // window or one 8-trip rescore window. Declared literally so this module's
    // static graph stays where it is; `p4cAdapterAccounting.test.js` asserts no
    // production turn exceeds it.
    [P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE, { items: P4_LIFECYCLE_TURN_BUDGET_CEILINGS[P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE], turns: 8 }, repositoryTurn],
    [P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION, { items: P4_LIFECYCLE_TURN_BUDGET_CEILINGS[P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION], turns: 8 }, runKeyRotationTurn],
    [P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION, { items: 50, turns: 8 }, runMigrationTurnAdapter],
  ];
  for (const [jobKey, budget, runDomainTurn] of domainTurns) {
    boundary.register({
      jobKey,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, APP_WORK_TRIGGER_ORIGINS.RESUME],
      workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      budget,
      runTurn: async ({ budget: turnBudget, criticalSection, instanceId }) => {
        const outcome = await criticalSection.run(() => runDomainTurn({ instanceId }));
        consumeResult(turnBudget, { items: outcome?.items || 0, bytes: outcome?.bytes || 0 });
        return outcome?.result ?? APP_WORK_TURN_RESULTS.DONE;
      },
    });
  }

  // Registered outside `domainTurns` on purpose: it is not admitted with the
  // lifecycle fan-out but at the journal instance's settlement point, which is
  // the historical once-per-bootstrap/resume reconciliation moment.
  boundary.register({
    jobKey: P4_LIFECYCLE_JOB_KEYS.MILESTONE_RECONCILIATION,
    triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, APP_WORK_TRIGGER_ORIGINS.RESUME],
    workExtent: APP_WORK_EXTENTS.BOUNDED_TURN,
    workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    // P4-B-F01-3-A. The only registration that opts into domain follow-up, and
    // only for the one domain event whose completion this job's settled
    // instance can legitimately have deferred on. Every other job - including
    // every other suspendible domain turn above - stays default-deny.
    domainFollowUpReasons: [P4_DOMAIN_FOLLOW_UP_REASONS.PROGRESSION_MIGRATION_COMPLETE],
    // P4-B-F01. The frozen settlement ceiling, derived from the milestone
    // domain's own bounded constants and independent of retained history N:
    // 1 settlement pass + 20 x 100 collected progression summaries + one
    // 500-vehicle page + the 20 x 100 aggregate week scan + one 2,000
    // notification-candidate page + the 200-badge achievement catalog
    // allowance. It is declared literally rather than imported so this module's
    // static graph stays where it is; `milestoneReconciliationTurns.test.js`
    // asserts it equals `MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS`.
    budget: { items: 6701, turns: 8 },
    runTurn: async ({ budget: turnBudget, criticalSection, instanceId }) => {
      const outcome = await criticalSection.run(() => milestoneTurn({ instanceId }));
      consumeResult(turnBudget, { items: outcome?.items || 0 });
      return outcome?.result ?? APP_WORK_TURN_RESULTS.DONE;
    },
  });

  const ownerless = () => nativeAuthorityAvailable()
    ? Object.freeze([])
    : Object.freeze([...NATIVE_AUTHORITY_JOBS].map((jobKey) => Object.freeze({
      jobKey,
      reason: 'native_authority_unavailable',
    })));

  let lastLifecycleTrigger = APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP;

  const admit = (jobKey, { origin, epoch, wake = null } = {}) => {
    if (origin === APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP || origin === APP_WORK_TRIGGER_ORIGINS.RESUME) {
      lastLifecycleTrigger = origin;
    }
    // Only the two native-canonical jobs are ownerless without native
    // authority. The domain turns adopted in step 12 run on web too.
    if (NATIVE_AUTHORITY_JOBS.has(jobKey) && !nativeAuthorityAvailable()) {
      return Object.freeze({ status: 'ownerless', jobKey, epoch, reason: 'native_authority_unavailable' });
    }
    return boundary.admit(jobKey, { origin, epoch, wake });
  };

  /**
   * Admit the reconciliation job for the journal instance's settlement. It goes
   * through the same boundary as every other lifecycle admission, so coordinator
   * coalescing - not a private flag - is what makes it exactly once per settled
   * bootstrap/resume epoch. An admission failure is logged and never allowed to
   * rewrite the journal turn's own result.
   */
  const admitMilestoneReconciliation = (epoch) => {
    try {
      return admit(P4_LIFECYCLE_JOB_KEYS.MILESTONE_RECONCILIATION, {
        origin: lastLifecycleTrigger,
        epoch,
      });
    } catch (error) {
      logSystemFailure('p4_milestone_reconciliation_admission', error);
      return null;
    }
  };

  /**
   * P4-C-F02. Ensure the one coordinator-owned legacy-migration logical
   * instance is admitted and advancing, for a caller that merely *observed*
   * migration state - a read served from the legacy source, or a write refused
   * because the archive is still MIGRATING.
   *
   * It is an admission, not an execution: nothing here calls the migration
   * domain step, so the caller cannot advance migration outside coordinator
   * identity, coalescing, yielding, failure policy and telemetry, and never
   * awaits convergence. Continuation is the coordinator's own `hasMore` tail
   * re-admission, so one ensure is enough - the caller does not have to come
   * back. The epoch is the coordinator's current lifecycle epoch, never an
   * invented one, and when native migration authority is unavailable the
   * ownerless gate answers instead of a native call.
   */
  const ensureMigrationAdvancing = () => {
    try {
      return admit(P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION, {
        origin: lastLifecycleTrigger,
        epoch: coordinator.getCoordinatorSnapshot().lifecycleEpoch,
      });
    } catch (error) {
      logSystemFailure('p4_legacy_migration_admission', error);
      return null;
    }
  };

  /**
   * P4-B-F01-3-A. A domain telling the coordinator that a precondition its
   * already-settled instance deferred on is now satisfied. Not a lifecycle
   * trigger: it carries no origin, invents no epoch and appears in no
   * trigger-origin allowlist, so `latestExternalEpoch` authority is untouched.
   * It is also not a general capability: the coordinator refuses it unless the
   * target's own registration declared this exact domain event, so this
   * function cannot be used to rerun or wake an unrelated job.
   */
  const domainFollowUp = (jobKey, reason = 'domain_followup') => {
    try {
      return coordinator.admitDomainFollowUp(jobKey, { reason });
    } catch (error) {
      logSystemFailure('p4_domain_followup_admission', error, { job_key: jobKey });
      return null;
    }
  };

  /**
   * P4-C-F07. Satisfy the rescoring turn's `rescoring_worker` wake once a
   * worker has actually been registered, so the same logical obligation
   * continues without waiting for the user to resume the app again.
   */
  const admitRescoringWorkerReady = () => {
    try {
      return admit(P4_LIFECYCLE_JOB_KEYS.RESCORING, {
        origin: lastLifecycleTrigger,
        epoch: coordinator.getCoordinatorSnapshot().lifecycleEpoch,
        wake: RESCORING_WORKER_WAKE,
      });
    } catch (error) {
      logSystemFailure('p4_rescoring_worker_ready_admission', error);
      return null;
    }
  };

  const admitAll = ({ origin, epoch }) => Object.freeze([
    admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, { origin, epoch }),
    admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, { origin, epoch }),
    ...domainTurns.map(([jobKey]) => admit(jobKey, { origin, epoch })),
    ...(enableP5Registrations?[
      admit(P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION,{origin,epoch}),
      admit(P5_LIFECYCLE_JOB_KEYS.JOURNAL_MANIFEST_RECONCILE,{origin,epoch}),
      admit(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_INTEGRITY_CHECKPOINT,{origin,epoch}),
      ...(origin===APP_WORK_TRIGGER_ORIGINS.RESUME?[admit(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC,{origin,epoch})]:[]),
    ]:[]),
    ...(enableP6Registrations ? Object.values(P6_JOB_KEYS).map((jobKey) => admit(jobKey, { origin, epoch })) : []),
  ]);

  const invalidateAuthoritySensitiveWork = (reason = 'canonical_authority_changed') => Object.freeze({
    journal: coordinator.invalidateJob(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, { reason }),
    projection: coordinator.invalidateJob(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, { reason }),
  });

  return Object.freeze({
    coordinator,
    boundary,
    admit,
    admitAll,
    domainFollowUp,
    ensureMigrationAdvancing,
    admitRescoringWorkerReady,
    ownerless,
    invalidateAuthoritySensitiveWork,
    p5Enabled: enableP5Registrations,
    p6Enabled: enableP6Registrations,
  });
}

const nativeAuthorityEnabled = import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true';

/**
 * Which P6 derived-state implementation owns this process's trips.
 *
 * P6 must follow the **authority**, not the platform. On Android with browser
 * authority the trips live in IndexedDB, so routing these turns on
 * `isAndroid()` alone drove the native archive stepper against an archive that
 * holds no trips: the IndexedDB work queue never drained, D1-D4 stayed DIRTY,
 * and every owner gated on D1 readiness (the Q4 lifetime aggregate included)
 * stayed permanently unavailable.
 */
const nativeDerivedStateSelected = () => isAndroid() && nativeAuthorityEnabled;
const privacyDebtListeners = new Set();
const productionRetentionTurn = createP5RawGpsRetentionAdapter({
  archive: nativeTripArchive,
  readPolicy: async () => {
    const { localSettings } = await import('@/lib/trackingStore');
    const settings = localSettings.get();
    return { retentionDays: Number(settings.raw_gps_retention_days || 0), motionRetentionDays: Number(settings.motion_sample_retention_days || 0) };
  },
  appendReceipt: async (...args) => (await import('@/lib/hashChainLog')).appendPrivacyEventBounded(...args),
  freezeEvidence: async (request) => {
    const [{ LocalSpeedKnowledge }, { speedKnowledgeStore }, evidence] = await Promise.all([
      import('@/lib/localSpeedKnowledge'), import('@/lib/speedKnowledgeRepository'), import('@/lib/p6RoadEvidence'),
    ]);
    return new LocalSpeedKnowledge(speedKnowledgeStore).applyP6ProvenanceDispositionPage({
      ...request, disposition: evidence.P6_PROVENANCE_DISPOSITIONS.FREEZE,
    });
  },
  onStatus: (status) => { for (const listener of privacyDebtListeners) listener(status); },
});
export const getP5PrivacyReceiptStatus = () => productionRetentionTurn.status();
export const subscribeP5PrivacyReceiptStatus = (listener) => {
  privacyDebtListeners.add(listener); return () => privacyDebtListeners.delete(listener);
};
const productionRuntime = createP4LifecycleWorkRuntime({
  enableP5Registrations: true,
  // Frozen P6 enablement law: production J1-J3 stay disabled until the whole
  // V01-V25 prerequisite matrix is green, the conditional D2/D3/D4 routine
  // legacy paths are retired, and D1-D4 are independently releasable. All
  // three hold, so exactly J1-J3 register here. E1-E4 never do: they remain
  // explicit, user-invoked, non-lifecycle operations.
  enableP6Registrations: true,
  nativeAuthorityAvailable: () => isAndroid() && nativeAuthorityEnabled,
  readHealth: () => nativeTripArchive.health(),
  runProjectionTurn: (options) => runNativeProjectionTurn(options),
  runJournalTurn: (maxItems, maxBytes) => nativeTripArchive.ingestJournal(maxItems, maxBytes),
  // F05 approved path: native publication and one-receipt delivery occupy
  // disjoint turns. Unknown v1 blocks only delivery, never canonical retention.
  runP5RawGpsRetentionTurn: productionRetentionTurn,
  runP5JournalReconcileTurn: () => nativeTripArchive.stepP5JournalReconcile(),
  runP5IntegrityTurn: () => nativeTripArchive.stepP5Integrity(),
  runP5ResidueGcTurn: () => nativeTripArchive.stepP5ResidueGc(),
  runP6TripDerivedTurn: async () => {
    if (nativeDerivedStateSelected()) return nativeTripArchive.stepP6TripDerived();
    const { stepP6BrowserTripDerivedUpdate } = await import('@/lib/p6TripDerivedState');
    return stepP6BrowserTripDerivedUpdate();
  },
  runP6RoadMemoryTurn: async () => {
    const { localSettings } = await import('@/lib/trackingStore');
    if (localSettings.get()?.road_memory_learning_enabled === false) {
      return { state: 'IDLE', itemsWorked: 1, bytesWorked: 0, hasMore: false,
        reason: 'ROAD_MEMORY_LEARNING_DISABLED' };
    }
    const road = await import('@/lib/p6RoadMemoryState');
    const outcome = nativeDerivedStateSelected()
      ? await road.stepP6NativeRoadMemoryUpdate()
      : await road.stepP6RoadMemoryUpdate();
    return outcome?.state === 'IDLE' ? road.stepP6ComponentRepair() : outcome;
  },
  runP6AffectedSelectionTurn: async () => {
    const selection = await import('@/lib/p6TripDerivedState');
    if (nativeDerivedStateSelected()) return selection.stepP6NativeAffectedTripSelection();
    return selection.stepP6AffectedTripSelection();
  },
  onJournalItems: async (result) => {
    queryClientInstance.invalidateQueries({ queryKey: ['trip-summaries'] }).catch(() => {});
    recordSystemEvent('native_canonical_journal_ingested', {
      item_count: Number(result?.itemCount) || 0,
      has_more: result?.hasMore === true,
    }, { category: 'background' });
  },
  onJournalSettled: (result, admission) => {
    // P4-B-F01: no milestone work happens here any more. The reconciliation is
    // its own bounded coordinator job, admitted at this settlement point; all
    // this records is that the hand-off happened.
    recordSystemEvent('native_canonical_journal_settled', {
      item_count: Number(result?.itemCount) || 0,
      milestone_admission: String(admission?.status || 'unavailable'),
    }, { category: 'background' });
  },
});

let stopLifecycleSubscription = null;

export function connectP4LifecycleWorkRuntime(runtime, {
  snapshot = getLifecycleSnapshot,
  subscribe = subscribeLifecycleSignals,
} = {}) {
  if (!runtime || typeof runtime.admitAll !== 'function') {
    throw new TypeError('Lifecycle integration requires a P4 work runtime');
  }
  const initial = snapshot();
  runtime.coordinator.setLifecycleState(initial);
  return subscribe((event) => {
    runtime.coordinator.setLifecycleState(event);
    if (event.effectiveChanged && event.effectiveForeground) {
      runtime.admitAll({ origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: event.epoch });
    }
  });
}

export function startP4LifecycleWorkIntegration() {
  if (stopLifecycleSubscription) return stopLifecycleSubscription;
  // Claim scheduling ownership before any worker registration can run, so the
  // rescoring queue never gets one free private self-scheduled turn at boot.
  void import('@/lib/rescoringQueue')
    .then(({ setRescoringCoordinatorOwned, setRescoringWorkerReadyListener }) => {
      setRescoringCoordinatorOwned(true);
      // P4-C-F07: worker registration is the real producer of the readiness
      // wake a deferred rescoring turn is parked on.
      setRescoringWorkerReadyListener(() => productionRuntime.admitRescoringWorkerReady());
    })
    .catch((error) => logSystemFailure('p4_rescoring_coordinator_ownership', error));
  const unsubscribe = connectP4LifecycleWorkRuntime(productionRuntime);
  stopLifecycleSubscription = () => {
    unsubscribe();
    stopLifecycleSubscription = null;
  };
  return stopLifecycleSubscription;
}

/**
 * Admit one lifecycle-owned job at the current effective epoch.
 *
 * @param {string} jobKey
 * @param {string} [origin] a declared lifecycle trigger origin; bootstrap by default.
 */
export function admitP4BootstrapWork(jobKey, origin = APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP) {
  const lifecycle = getLifecycleSnapshot();
  productionRuntime.coordinator.setLifecycleState(lifecycle);
  return productionRuntime.admit(jobKey, { origin, epoch: lifecycle.epoch });
}

/**
 * P4-B-F01-3-A. Hand an outstanding obligation back to an already-settled
 * bounded job in the current epoch, after the domain precondition it deferred
 * on has been satisfied. Only a job that declared `reason` in its own
 * `domainFollowUpReasons` accepts this; anything else answers
 * `domain_followup_unauthorized` and nothing is scheduled or mutated. Returns
 * the coordinator's real admission result - callers must not assume success.
 */
export function admitP4DomainFollowUp(jobKey, reason = 'domain_followup') {
  return productionRuntime.domainFollowUp(jobKey, reason);
}

/**
 * P4-C-F02. The production migration admission trigger.
 *
 * A LEGACY/MIGRATING read or refused write calls this to guarantee the bounded
 * migration instance exists and is advancing. It returns the coordinator's real
 * admission result - including the `ownerless` record when native migration
 * authority is unavailable - and never awaits migration convergence.
 */
export function ensureP4LegacyMigrationAdvancing() {
  return productionRuntime.ensureMigrationAdvancing();
}

export const notifyP4CanonicalAuthorityChanged = (reason) => (
  productionRuntime.invalidateAuthoritySensitiveWork(reason)
);

export const getP4LifecycleRegistrations = () => productionRuntime.boundary.snapshot();
export const getP4OwnerlessJobs = () => productionRuntime.ownerless();
export const getP4WorkCoordinator = () => productionRuntime.coordinator;

export function admitP5ReviewedWork(jobKey, { wake = null } = {}) {
  if (!productionRuntime.p5Enabled) return Object.freeze({ status: 'disabled', reason: 'P5_IMPLEMENTATION_NOT_ENABLED' });
  const lifecycle=getLifecycleSnapshot();productionRuntime.coordinator.setLifecycleState(lifecycle);
  return productionRuntime.admit(jobKey,{origin:APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED,epoch:lifecycle.epoch,wake});
}

export function admitP6ReviewedWork(jobKey, { wake = null } = {}) {
  if (!productionRuntime.p6Enabled) return Object.freeze({ status: 'disabled', reason: 'P6_IMPLEMENTATION_NOT_ENABLED' });
  if (!Object.values(P6_JOB_KEYS).includes(jobKey)) throw new Error('P6_JOB_KEY_INVALID');
  const lifecycle = getLifecycleSnapshot();
  productionRuntime.coordinator.setLifecycleState(lifecycle);
  return productionRuntime.admit(jobKey, {
    origin: APP_WORK_TRIGGER_ORIGINS.OTHER_REVIEWED,
    epoch: lifecycle.epoch,
    wake,
  });
}

export function notifyPrivacyAuditConversionComplete() {
  const wake = { type: 'compatibility_conversion', key: 'privacy_audit_v1' };
  productionRetentionTurn.reset();
  const native = admitP5ReviewedWork(P5_LIFECYCLE_JOB_KEYS.NATIVE_RAW_GPS_RETENTION, { wake });
  const lifecycle = getLifecycleSnapshot();
  // Reuse repository maintenance's existing lifecycle origin and typed-wake
  // admission. No new domain-follow-up reason or trigger allowlist is added.
  const browser = productionRuntime.admit(P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE,
    { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: lifecycle.epoch, wake });
  return { native, browser };
}
