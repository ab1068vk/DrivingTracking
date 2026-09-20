/** Frozen P6 production contracts. Keep this module free of storage side effects. */

export const P6_PLAN_COUNTS = Object.freeze({
  historical: 3,
  already: 0,
  still: 3,
  superseded: 0,
  newRequirements: 8,
  must: 17,
  should: 2,
  validations: 26,
  lifecycleJobs: 3,
  coordinatorRegistrations: 3,
  explicitOperations: 4,
});

export const P6_REQUIREMENTS = Object.freeze({
  historical: Object.freeze(['P6-H01', 'P6-H02', 'P6-H03']),
  new: Object.freeze(Array.from({ length: 8 }, (_, index) => `P6-N${String(index + 1).padStart(2, '0')}`)),
  must: Object.freeze(Array.from({ length: 17 }, (_, index) => `P6-M${String(index + 1).padStart(2, '0')}`)),
  should: Object.freeze(['P6-S01', 'P6-S02']),
  validations: Object.freeze(Array.from({ length: 26 }, (_, index) => `P6-V${String(index + 1).padStart(2, '0')}`)),
});

export const P6_DOMAIN_KEYS = Object.freeze({
  ANALYTICS: 'D1_ANALYTICS',
  GEOMETRY: 'D2_GEOMETRY',
  SPATIAL_SELECTION: 'D3_SPATIAL_SELECTION',
  ROAD_LEARNING: 'D4_ROAD_LEARNING_SPEED_LOOKUP',
});

export const P6_READINESS_STATES = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  DIRTY: 'DIRTY',
  REBUILD_REQUIRED: 'REBUILD_REQUIRED',
  QUARANTINED: 'QUARANTINED',
  NO_PUBLIC_GEOMETRY: 'NO_PUBLIC_GEOMETRY',
  CONVERSION_REQUIRED: 'CONVERSION_REQUIRED',
  CAPACITY_BLOCKED: 'CAPACITY_BLOCKED',
  DERIVED_STORAGE_BLOCKED: 'DERIVED_STORAGE_BLOCKED',
  REPAIR_ESCALATED: 'REPAIR_ESCALATED',
});

const READINESS_VALUES = new Set(Object.values(P6_READINESS_STATES));

export const P6_JOB_KEYS = Object.freeze({
  TRIP_DERIVED_UPDATES: 'p6TripDerivedUpdates',
  ROAD_MEMORY_UPDATES: 'p6RoadMemoryUpdates',
  AFFECTED_TRIP_SELECTION: 'p6AffectedTripSelection',
});

export const P6_EXPLICIT_OPERATION_TYPES = Object.freeze({
  DERIVED_REPAIR: 'E1_DERIVED_ANALYTICS_GEOMETRY_REPAIR',
  RETAINED_HISTORY_LEARNING: 'E2_RETAINED_HISTORY_LEARNING',
  AFFECTED_TRIP_RESCORE: 'E3_AFFECTED_TRIP_RESCORE',
  BROWSER_SPEED_MIGRATION: 'E4_BROWSER_SAVED_SPEED_MIGRATION',
});

export const P6_EXPLICIT_OPERATION_STATES = Object.freeze({
  READY: 'READY',
  RUNNING: 'RUNNING',
  WAITING_FOR_OWNER: 'WAITING_FOR_OWNER',
  PAUSED_HIDDEN: 'PAUSED_HIDDEN',
  PAUSED_AFTER_RESTART: 'PAUSED_AFTER_RESTART',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const P6_TURN_BUDGET = Object.freeze({
  items: 256,
  bytes: 4 * 1024 * 1024,
  turns: 8,
  timeMs: 25,
});

/**
 * DPD-015B. The byte allowance a bounded turn keeps in reserve before it reads
 * one whole canonical trip row whose size it cannot know in advance.
 *
 * A turn that reads payloads of unknown size cannot decide "does this fit?"
 * after the read — by then the bytes are spent, and either it reports them and
 * breaks its declared budget or it hides them. It therefore stops *before* the
 * read whenever less than this much of the turn's byte budget is left.
 *
 * This reserve is a cheap early exit, **not** the bound. It cannot be the
 * bound: it constrains each read in isolation, so an accumulation still
 * overruns — with a 4 MiB budget, two 1.5 MB rows leave 1.19 MB "available" and
 * a third 1.5 MB row takes the turn to 4.5 MB. The actual bound is that a turn
 * takes at most **one** read of unknown size, which makes its payload cost
 * exactly one row; a single row larger than the whole budget is then handled by
 * the oversized-unit rule, which reports a fully consumed turn and discloses the
 * true cost separately.
 *
 * 1 MiB is four times the largest canonical row observed on the 500-trip
 * qualification device (p50 ≈ 242 KB; `route_points` is import-capped at
 * `MAX_IMPORTED_TRIP_ROUTE_POINTS`, but that cap applies only to imports, so
 * larger canonical rows are producible — which is why the reserve is not
 * trusted as the bound).
 */
export const P6_SOURCE_READ_RESERVE_BYTES = 1024 * 1024;

export const P6_MAX_AUTOMATIC_REPAIR_ROUNDS = 2;
export const P6_MAX_SPEED_PARTITION_BYTES = 8 * 1024 * 1024;
export const P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES = 7 * 1024 * 1024;
export const P6_MANUAL_SPEED_HEADROOM_BYTES = 1024 * 1024;

export const normalizeP6Readiness = (value = {}) => {
  const state = READINESS_VALUES.has(value?.state)
    ? value.state
    : P6_READINESS_STATES.REBUILD_REQUIRED;
  return Object.freeze({
    domain: String(value?.domain || ''),
    sourceBinding: value?.sourceBinding ?? null,
    requiredVersion: Math.max(0, Number(value?.requiredVersion) || 0),
    appliedVersion: Math.max(0, Number(value?.appliedVersion) || 0),
    state,
    complete: state === P6_READINESS_STATES.VERIFIED && value?.complete === true,
    cursor: value?.cursor ?? null,
    storageOutcome: value?.storageOutcome ?? null,
    capacityOutcome: value?.capacityOutcome ?? null,
    updatedAt: Math.max(0, Number(value?.updatedAt) || Date.now()),
  });
};

export const p6CompositeReadiness = (states = [], domains = []) => {
  const byDomain = new Map(states.map((value) => [value?.domain, normalizeP6Readiness(value)]));
  const selected = domains.map((domain) => byDomain.get(domain) || normalizeP6Readiness({ domain }));
  const blocking = selected.find((value) => !value.complete || value.state !== P6_READINESS_STATES.VERIFIED);
  return {
    complete: !blocking,
    state: blocking?.state || P6_READINESS_STATES.VERIFIED,
    domains: selected,
  };
};

export const assertFrozenP6Contract = () => {
  if (Object.keys(P6_JOB_KEYS).length !== P6_PLAN_COUNTS.lifecycleJobs) throw new Error('P6_JOB_COUNT_MISMATCH');
  if (Object.keys(P6_EXPLICIT_OPERATION_TYPES).length !== P6_PLAN_COUNTS.explicitOperations) throw new Error('P6_EXPLICIT_OPERATION_COUNT_MISMATCH');
  if (Object.keys(P6_DOMAIN_KEYS).length !== 4) throw new Error('P6_DOMAIN_COUNT_MISMATCH');
  if (P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES + P6_MANUAL_SPEED_HEADROOM_BYTES !== P6_MAX_SPEED_PARTITION_BYTES) {
    throw new Error('P6_SPEED_CAPACITY_CONTRACT_MISMATCH');
  }
  return true;
};

