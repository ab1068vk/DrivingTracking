import { P6_READINESS_STATES } from '@/lib/p6Contracts';

export const P6_CANONICAL_RESERVE_BYTES = 256 * 1024 * 1024;
export const P6_LARGEST_DERIVED_STAGE_BYTES = 8 * 1024 * 1024;
export const P6_DERIVED_SAFETY_BYTES = 16 * 1024 * 1024;
export const P6_DERIVED_STORAGE_RESERVE_BYTES = (
  P6_CANONICAL_RESERVE_BYTES + P6_LARGEST_DERIVED_STAGE_BYTES + P6_DERIVED_SAFETY_BYTES
);

export class P6DerivedStorageBlockedError extends Error {
  constructor(details = {}) {
    super('Derived P6 storage is blocked to preserve canonical write capacity.');
    this.name = 'P6DerivedStorageBlockedError';
    this.code = P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED;
    this.details = Object.freeze({ ...details });
  }
}

export const p6DerivedFootprintEnvelope = ({ trips = 0, publicPoints = 0, speedRecords = 0 } = {}) => (
  32 * 1024 * 1024
  + Math.max(0, Number(trips) || 0) * 24 * 1024
  + Math.max(0, Number(publicPoints) || 0) * 224
  + Math.max(0, Number(speedRecords) || 0) * 512
);

export const p6DerivedReplacementEnvelope = (scale = {}) => (
  2 * p6DerivedFootprintEnvelope(scale) + 16 * 1024 * 1024
);

export const assessP6DerivedStorage = ({ quota, usage, proposedBytes = 0 } = {}) => {
  const safeQuota = Number(quota);
  const safeUsage = Number(usage);
  const proposed = Number(proposedBytes);
  if (![safeQuota, safeUsage, proposed].every(Number.isFinite) || safeQuota < 0 || safeUsage < 0 || proposed < 0) {
    return { admitted: false, state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, reason: 'ESTIMATE_UNAVAILABLE' };
  }
  const remaining = safeQuota - safeUsage - proposed;
  return {
    admitted: remaining >= P6_DERIVED_STORAGE_RESERVE_BYTES,
    state: remaining >= P6_DERIVED_STORAGE_RESERVE_BYTES
      ? P6_READINESS_STATES.VERIFIED
      : P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED,
    reason: remaining >= P6_DERIVED_STORAGE_RESERVE_BYTES ? null : 'DERIVED_RESERVE_WOULD_BE_VIOLATED',
    quota: safeQuota,
    usage: safeUsage,
    proposedBytes: proposed,
    remaining,
    reserveBytes: P6_DERIVED_STORAGE_RESERVE_BYTES,
  };
};

const browserDerivedReclaimers = [];
export const registerP6BrowserDerivedReclaimer = (reclaimer, priority = 100) => {
  if (typeof reclaimer !== 'function' || browserDerivedReclaimers.some((item) => item.reclaimer === reclaimer)) return;
  browserDerivedReclaimers.push({ reclaimer, priority: Number(priority) || 100 });
  browserDerivedReclaimers.sort((a, b) => a.priority - b.priority);
};

export async function requireBrowserP6DerivedStorage(proposedBytes, estimate = null) {
  const estimator = estimate || globalThis.navigator?.storage?.estimate?.bind(globalThis.navigator.storage);
  if (typeof estimator !== 'function') {
    throw new P6DerivedStorageBlockedError({ reason: 'ESTIMATE_UNAVAILABLE' });
  }
  let observation;
  try {
    observation = await estimator();
  } catch (cause) {
    throw new P6DerivedStorageBlockedError({ reason: 'ESTIMATE_FAILED', cause: String(cause?.message || cause) });
  }
  let assessment = assessP6DerivedStorage({ ...observation, proposedBytes });
  if (!assessment.admitted && browserDerivedReclaimers.length) {
    for (let turn = 0; turn < 8 && !assessment.admitted; turn += 1) {
      let reclaimed = null;
      for (const candidate of browserDerivedReclaimers) {
        const result = await candidate.reclaimer();
        if (result?.reclaimedBytes > 0) { reclaimed = result; break; }
      }
      if (!reclaimed || reclaimed.reclaimedBytes <= 0) break;
      try { observation = await estimator(); }
      catch (cause) { throw new P6DerivedStorageBlockedError({ reason: 'ESTIMATE_FAILED_AFTER_RECLAIM', cause: String(cause?.message || cause) }); }
      assessment = assessP6DerivedStorage({ ...observation, proposedBytes });
    }
  }
  if (!assessment.admitted) throw new P6DerivedStorageBlockedError(assessment);
  return assessment;
}

export const P6_DERIVED_RECLAMATION_ORDER = Object.freeze([
  'OBSOLETE_STAGE',
  'RETIRED_CONTENT_VERSION',
  'PREVIEW_CACHE',
  'SPATIAL_POSTINGS',
  'FROZEN_OBSERVATION_PAYLOAD',
  'OTHER_DERIVED_CHUNKS',
]);

export const orderP6ReclamationCandidates = (items = []) => {
  const priority = new Map(P6_DERIVED_RECLAMATION_ORDER.map((value, index) => [value, index]));
  return [...items]
    .filter((item) => item?.canonical !== true && item?.frozenBaseline !== true)
    .sort((a, b) => (
      (priority.get(a?.kind) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b?.kind) ?? Number.MAX_SAFE_INTEGER)
      || (Number(a?.updatedAt) || 0) - (Number(b?.updatedAt) || 0)
      || String(a?.id || '').localeCompare(String(b?.id || ''))
    ));
};
