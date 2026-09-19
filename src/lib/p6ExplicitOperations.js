import { getJson, setJson } from '@/lib/mobileStorage';
import { isAndroid } from '@/lib/nativePlatform';
import { nativeTripArchive } from '@/lib/nativeTripArchive';

/**
 * Which P6 implementation owns this process's trips.
 *
 * Mirrors the lifecycle turns: the explicit E1-E4 operations must follow the
 * **authority**, not the platform. On Android under browser authority the
 * trips are in IndexedDB, so dispatching on `isAndroid()` alone ran the native
 * repair against an archive holding no trips — which is why the user-facing
 * "Finish lifetime totals" action could run to completion and still leave the
 * lifetime aggregate unavailable.
 */
const nativeDerivedStateSelected = () => isAndroid() && import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true';
import {
  P6_EXPLICIT_OPERATION_STATES,
  P6_EXPLICIT_OPERATION_TYPES,
  P6_DOMAIN_KEYS,
  P6_JOB_KEYS,
} from '@/lib/p6Contracts';

export const P6_EXPLICIT_OPERATION_STATE_KEY = 'drivesense_p6_explicit_operations_v1';
const TYPES = new Set(Object.values(P6_EXPLICIT_OPERATION_TYPES));
const TERMINAL = new Set([
  P6_EXPLICIT_OPERATION_STATES.CANCELLED,
  P6_EXPLICIT_OPERATION_STATES.COMPLETED,
  P6_EXPLICIT_OPERATION_STATES.FAILED,
]);

const operationId = () => globalThis.crypto?.randomUUID?.()
  || `p6-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const load = async () => {
  const value = await getJson(P6_EXPLICIT_OPERATION_STATE_KEY, { operations: {} }).catch(() => ({ operations: {} }));
  return value && typeof value === 'object' && value.operations && typeof value.operations === 'object'
    ? value
    : { operations: {} };
};

const save = (value) => setJson(P6_EXPLICIT_OPERATION_STATE_KEY, value);

const update = async (id, mutator) => {
  const state = await load();
  const current = state.operations[id];
  if (!current) throw new Error('P6_EXPLICIT_OPERATION_NOT_FOUND');
  const next = mutator({ ...current });
  state.operations[id] = { ...next, updatedAt: Date.now() };
  await save(state);
  return state.operations[id];
};

export async function startP6ExplicitOperation(type, { sourceBinding = null, cursor = null, details = null } = {}) {
  if (!TYPES.has(type)) throw new Error('P6_EXPLICIT_OPERATION_TYPE_INVALID');
  const state = await load();
  const active = Object.values(state.operations).find((item) => item.type === type && !TERMINAL.has(item.state));
  if (active) return active;
  const now = Date.now();
  const record = {
    operationId: operationId(),
    type,
    sourceBinding,
    state: P6_EXPLICIT_OPERATION_STATES.READY,
    cursor,
    progress: { itemsWorked: 0, bytesWorked: 0, turns: 0 },
    stageVersion: 1,
    failure: null,
    cancelRequested: false,
    runnerLease: null,
    details,
    createdAt: now,
    updatedAt: now,
  };
  state.operations[record.operationId] = record;
  await save(state);
  return record;
}

const descriptorIdentity = (value) => JSON.stringify(value || {});

/** Durable owner for a named D3 refusal. Repeated corrections merge into the
 * same active E3 operation so restart/recovery cannot lose or duplicate the
 * outstanding descriptor set. */
export async function recordP6AffectedTripRescoreDebt({ descriptors = [], ...details } = {}) {
  const state = await load();
  const active = Object.values(state.operations).find((item) => (
    item.type === P6_EXPLICIT_OPERATION_TYPES.AFFECTED_TRIP_RESCORE && !TERMINAL.has(item.state)
  ));
  if (!active) return startP6ExplicitOperation(P6_EXPLICIT_OPERATION_TYPES.AFFECTED_TRIP_RESCORE, {
    cursor: { phase: 'CREATE_REQUESTS' },
    details: { ...details, descriptors, selectionPending: true },
  });
  const merged = new Map([...(active.details?.descriptors || []), ...descriptors]
    .map((descriptor) => [descriptorIdentity(descriptor), descriptor]));
  state.operations[active.operationId] = {
    ...active,
    state: P6_EXPLICIT_OPERATION_STATES.READY,
    cursor: { phase: 'CREATE_REQUESTS' },
    details: {
      ...(active.details || {}), ...details,
      descriptors: [...merged.values()], selectionPending: true,
    },
    failure: null,
    runnerLease: null,
    updatedAt: Date.now(),
  };
  await save(state);
  return state.operations[active.operationId];
}

/** Start one of the four frozen foreground operations and install its owner fence. */
export async function startKnownP6ExplicitOperation(type, options = {}) {
  if (type === P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION) {
    const { beginP6BrowserSpeedMigration } = await import('@/lib/speedKnowledgeRepository');
    const fence = await beginP6BrowserSpeedMigration();
    return startP6ExplicitOperation(type, { ...options, sourceBinding: fence.sourceFingerprint || null, details: fence });
  }
  if (type === P6_EXPLICIT_OPERATION_TYPES.AFFECTED_TRIP_RESCORE && options?.details?.descriptors) {
    const { createP6AffectedTripSelectionRequest } = await import('@/lib/p6TripDerivedState');
    const request = await createP6AffectedTripSelectionRequest(options.details);
    if (!request.accepted) return recordP6AffectedTripRescoreDebt({
      ...options.details,
      spatialSelectionState: request.state,
      spatialSelectionReason: request.reason || null,
    });
    return startP6ExplicitOperation(type, {
      ...options, cursor: { phase: 'DRAIN_SELECTION' },
      details: { ...options.details, request, selectionPending: false },
    });
  }
  if (type === P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR) {
    return startP6ExplicitOperation(type, {
      ...options,
      cursor: options.cursor || { phase: 'RESET_ANALYTICS', resetPhase: 'CONTRIBUTIONS' },
    });
  }
  return startP6ExplicitOperation(type, options);
}

export async function readP6ExplicitOperation(id) {
  return (await load()).operations[id] || null;
}

export async function listP6ExplicitOperations() {
  return Object.values((await load()).operations);
}

export async function cancelP6ExplicitOperation(id) {
  return update(id, (record) => ({
    ...record,
    cancelRequested: true,
    state: TERMINAL.has(record.state) ? record.state : P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED,
  }));
}

export async function resumeP6ExplicitOperation(id) {
  return update(id, (record) => {
    if (TERMINAL.has(record.state)) throw new Error('P6_EXPLICIT_OPERATION_TERMINAL');
    return { ...record, state: P6_EXPLICIT_OPERATION_STATES.READY, runnerLease: null, failure: null };
  });
}

export async function markP6ExplicitOperationsAfterRestart() {
  const state = await load();
  let changed = false;
  Object.values(state.operations).forEach((record) => {
    if (!TERMINAL.has(record.state) && record.state !== P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED) {
      record.state = P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART;
      record.runnerLease = null;
      record.updatedAt = Date.now();
      changed = true;
    }
  });
  if (changed) await save(state);
  return Object.values(state.operations);
}

/**
 * Execute exactly one foreground-owned turn. The caller decides whether to
 * request another turn; this module has no timer, lifecycle registration or
 * private drain loop.
 */
export async function runP6ExplicitOperationTurn(id, handler, {
  visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  p4Busy = () => false,
  cleanup = async () => {},
} = {}) {
  if (typeof handler !== 'function') throw new TypeError('P6 explicit turn handler required');
  let record = await readP6ExplicitOperation(id);
  if (!record) throw new Error('P6_EXPLICIT_OPERATION_NOT_FOUND');
  if (TERMINAL.has(record.state)) return record;
  if (!visible()) {
    return update(id, (value) => ({ ...value, state: P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN, runnerLease: null }));
  }
  if (record.cancelRequested || record.state === P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED) {
    const cleanupResult = await cleanup(record);
    if (cleanupResult?.done === false) {
      return update(id, (value) => ({
        ...value,
        state: P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED,
        cursor: cleanupResult.cursor ?? value.cursor,
        progress: {
          itemsWorked: value.progress.itemsWorked + Math.max(0, Number(cleanupResult.itemsWorked) || 0),
          bytesWorked: value.progress.bytesWorked + Math.max(0, Number(cleanupResult.bytesWorked) || 0),
          turns: value.progress.turns + 1,
        },
        runnerLease: null,
      }));
    }
    return update(id, (value) => ({
      ...value,
      state: P6_EXPLICIT_OPERATION_STATES.CANCELLED,
      cursor: null,
      runnerLease: null,
    }));
  }
  if (await p4Busy()) {
    return update(id, (value) => ({ ...value, state: P6_EXPLICIT_OPERATION_STATES.WAITING_FOR_OWNER, runnerLease: null }));
  }
  const lease = operationId();
  record = await update(id, (value) => ({ ...value, state: P6_EXPLICIT_OPERATION_STATES.RUNNING, runnerLease: lease }));
  try {
    const result = await handler(record);
    return update(id, (value) => {
      if (value.runnerLease !== lease) throw new Error('P6_EXPLICIT_OPERATION_LEASE_LOST');
      const itemsWorked = Math.max(0, Number(result?.itemsWorked) || 0);
      const bytesWorked = Math.max(0, Number(result?.bytesWorked) || 0);
      const done = result?.done === true;
      return {
        ...value,
        cursor: result?.cursor ?? value.cursor,
        details: result?.details ?? value.details,
        progress: {
          itemsWorked: value.progress.itemsWorked + itemsWorked,
          bytesWorked: value.progress.bytesWorked + bytesWorked,
          turns: value.progress.turns + 1,
        },
        state: done ? P6_EXPLICIT_OPERATION_STATES.COMPLETED : P6_EXPLICIT_OPERATION_STATES.READY,
        runnerLease: null,
      };
    });
  } catch (error) {
    return update(id, (value) => ({
      ...value,
      state: P6_EXPLICIT_OPERATION_STATES.FAILED,
      runnerLease: null,
      failure: { code: String(error?.code || error?.name || 'FAILED'), message: String(error?.message || error) },
    }));
  }
}

const explicitTripBuildTurn = async (record, { includeRoad = false } = {}) => {
  const phase = record.cursor?.phase || 'DISCOVER';
  if (phase === 'RESET_ANALYTICS') {
    let outcome;
    if (nativeDerivedStateSelected()) {
      outcome = await nativeTripArchive.resetP6AnalyticsDerived(record.cursor?.resetPhase || 'CONTRIBUTIONS');
    } else {
      const { resetP6BrowserAnalyticsDerivedTurn } = await import('@/lib/p6TripDerivedState');
      outcome = await resetP6BrowserAnalyticsDerivedTurn(record.cursor?.resetPhase || 'CONTRIBUTIONS');
    }
    return {
      itemsWorked: outcome.itemsWorked,
      bytesWorked: outcome.bytesWorked,
      cursor: outcome.phase === 'COMPLETE'
        ? { phase: 'DISCOVER', historyCursor: null }
        : { phase: 'RESET_ANALYTICS', resetPhase: outcome.phase },
      done: false,
    };
  }
  if (phase === 'DISCOVER') {
    let rows;
    let nextCursor;
    let queued;
    if (nativeDerivedStateSelected()) {
      const page = await nativeTripArchive.queryHistoryPage({
        sort: '-start_time', status: 'completed', maxItems: 32, maxBytes: 256 * 1024,
        ...(record.cursor?.historyCursor ? { cursor: record.cursor.historyCursor } : {}),
      });
      rows = page.items || [];
      nextCursor = page.nextCursor || null;
      queued = await nativeTripArchive.queueP6ExplicitTripSubjects(rows.map((row) => row.id), includeRoad);
    } else {
      const { listP6BrowserCanonicalSubjectPage, queueP6ExplicitTripSubjects } = await import('@/lib/p6TripDerivedState');
      const page = await listP6BrowserCanonicalSubjectPage({
        afterKey: record.cursor?.historyCursor || null, maxItems: 32,
      });
      rows = page.rows || [];
      nextCursor = page.nextCursor || null;
      const domains = includeRoad
        ? Object.values(P6_DOMAIN_KEYS)
        : [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY];
      queued = await queueP6ExplicitTripSubjects(rows, domains);
    }
    return {
      itemsWorked: rows.length + Number(queued.queued || 0),
      bytesWorked: queued.bytesWorked,
      cursor: nextCursor
        ? { phase: 'DISCOVER', historyCursor: nextCursor }
        : { phase: 'DRAIN_TRIPS', historyCursor: null },
      done: false,
    };
  }
  if (phase === 'DRAIN_TRIPS') {
    if (nativeDerivedStateSelected()) {
      const outcome = await nativeTripArchive.stepP6TripDerived();
      if (outcome.state !== 'IDLE') return {
        itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
        cursor: record.cursor, done: false,
      };
      const finalized = await nativeTripArchive.finalizeP6ExplicitTripBuild(false);
      return {
        itemsWorked: finalized.itemsWorked,
        bytesWorked: finalized.bytesWorked,
        cursor: includeRoad ? { phase: 'DRAIN_ROAD' } : null,
        done: finalized.complete === true && !includeRoad,
      };
    }
    const { finalizeP6BrowserExplicitTripBuild, stepP6BrowserTripDerivedUpdate } = await import('@/lib/p6TripDerivedState');
    const outcome = await stepP6BrowserTripDerivedUpdate({ explicit: true });
    if (outcome.state !== 'IDLE') return {
      itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
      cursor: record.cursor, done: false,
    };
    const finalized = await finalizeP6BrowserExplicitTripBuild({
      includeRoad: false,
      domains: includeRoad
        ? [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION]
        : [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY],
    });
    return { itemsWorked: finalized.itemsWorked, bytesWorked: finalized.bytesWorked,
      cursor: includeRoad ? { phase: 'DRAIN_ROAD' } : null,
      done: finalized.complete === true && !includeRoad };
  }
  if (nativeDerivedStateSelected()) {
    const { stepP6NativeRoadMemoryUpdate } = await import('@/lib/p6RoadMemoryState');
    const outcome = await stepP6NativeRoadMemoryUpdate();
    if (outcome.state !== 'IDLE') return {
      itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
      cursor: record.cursor, done: false,
    };
    const finalized = await nativeTripArchive.finalizeP6ExplicitTripBuild(true);
    return { itemsWorked: finalized.itemsWorked, bytesWorked: finalized.bytesWorked,
      cursor: null, done: finalized.complete === true };
  }
  const { stepP6RoadMemoryUpdate } = await import('@/lib/p6RoadMemoryState');
  const outcome = await stepP6RoadMemoryUpdate();
  if (outcome.state === 'IDLE') {
    const { finalizeP6BrowserExplicitTripBuild } = await import('@/lib/p6TripDerivedState');
    const finalized = await finalizeP6BrowserExplicitTripBuild({
      includeRoad: true,
      domains: Object.values(P6_DOMAIN_KEYS),
    });
    return { itemsWorked: finalized.itemsWorked, bytesWorked: finalized.bytesWorked,
      cursor: null, done: finalized.complete === true };
  }
  return {
    itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
    cursor: record.cursor,
    done: false,
  };
};

/** Dispatch exactly one turn for E1-E4. No lifecycle registration owns these operations. */
export async function runKnownP6ExplicitOperationTurn(id, options = {}) {
  const record = await readP6ExplicitOperation(id);
  if (!record) throw new Error('P6_EXPLICIT_OPERATION_NOT_FOUND');
  const handler = async (current) => {
    if (current.type === P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR) {
      return explicitTripBuildTurn(current);
    }
    if (current.type === P6_EXPLICIT_OPERATION_TYPES.RETAINED_HISTORY_LEARNING) {
      return explicitTripBuildTurn(current, { includeRoad: true });
    }
    if (current.type === P6_EXPLICIT_OPERATION_TYPES.AFFECTED_TRIP_RESCORE) {
      const selection = await import('@/lib/p6TripDerivedState');
      if (current.cursor?.phase === 'CREATE_REQUESTS' || current.details?.selectionPending === true) {
        const request = await selection.createP6AffectedTripSelectionRequest({
          descriptors: current.details?.descriptors || [],
          reason: current.details?.reason || 'deferred_spatial_selection',
          knowledgeMetadata: current.details?.knowledgeMetadata || {},
          continuation: current.details?.selectionContinuation || null,
        });
        if (!request.accepted) return {
          itemsWorked: 1, bytesWorked: 0, done: false,
          cursor: { phase: 'CREATE_REQUESTS' },
          details: {
            ...(current.details || {}), selectionPending: true,
            spatialSelectionState: request.state,
            spatialSelectionReason: request.reason || current.details?.spatialSelectionReason || null,
            selectionContinuation: request.partialAcceptance
              || current.details?.selectionContinuation || null,
          },
        };
        return {
          itemsWorked: Number(request.tokenCount) || 1, bytesWorked: 0, done: false,
          cursor: { phase: 'DRAIN_SELECTION' },
          details: {
            ...(current.details || {}), request, selectionPending: false,
            spatialSelectionState: 'READY', spatialSelectionReason: null,
            selectionContinuation: null,
          },
        };
      }
      const outcome = nativeDerivedStateSelected()
        ? await selection.stepP6NativeAffectedTripSelection()
        : await selection.stepP6AffectedTripSelection();
      return { itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
        cursor: current.cursor, done: outcome.state === 'IDLE' };
    }
    const { stepP6BrowserSpeedMigration } = await import('@/lib/speedKnowledgeRepository');
    const outcome = await stepP6BrowserSpeedMigration();
    return { itemsWorked: outcome.itemsWorked, bytesWorked: outcome.bytesWorked,
      cursor: outcome.cursor ?? current.cursor, done: outcome.done === true };
  };
  const knownCleanup = async (current) => {
    if (current.type !== P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION) {
      return options.cleanup?.(current);
    }
    const { cancelP6BrowserSpeedMigrationTurn } = await import('@/lib/speedKnowledgeRepository');
    return cancelP6BrowserSpeedMigrationTurn(current.cursor || {});
  };
  const updated = await runP6ExplicitOperationTurn(id, handler, { ...options, cleanup: knownCleanup });
  if (record.type === P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION
    && updated.state === P6_EXPLICIT_OPERATION_STATES.COMPLETED) {
    const { admitP6ReviewedWork } = await import('@/lib/appLifecycleWork');
    admitP6ReviewedWork(P6_JOB_KEYS.ROAD_MEMORY_UPDATES, {
      wake: { type: 'compatibility_conversion', key: 'browser-speed-v2' },
    });
  }
  return updated;
}
