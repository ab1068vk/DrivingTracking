const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const integer = (value) => Math.max(0, Math.trunc(number(value)));

export const P6_PROVENANCE_DISPOSITIONS = Object.freeze({
  FREEZE: 'FREEZE',
  SUBTRACT: 'SUBTRACT',
  REPLACE: 'SUBTRACT_OLD_ADD_REPLACEMENT',
  PRESERVE: 'PRESERVE',
});

export const p6RetentionDisposition = (event) => {
  switch (event) {
    case 'RAW_GPS_EXPIRED':
    case 'MOTION_SOURCE_EXPIRED':
    case 'ROUTE_EXPIRED':
    case 'PUBLIC_GEOMETRY_EXPIRED':
      return P6_PROVENANCE_DISPOSITIONS.FREEZE;
    case 'TRIP_EDITED':
    case 'TRIP_SUPERSEDED':
      return P6_PROVENANCE_DISPOSITIONS.REPLACE;
    case 'TRIP_TOMBSTONED':
    case 'IDENTITY_ERASED':
      return P6_PROVENANCE_DISPOSITIONS.SUBTRACT;
    default:
      return P6_PROVENANCE_DISPOSITIONS.PRESERVE;
  }
};

const normalizeHistogram = (value = {}) => Object.fromEntries(
  Object.entries(value || {})
    .filter(([key, count]) => key && number(count) > 0)
    .map(([key, count]) => [key, integer(count)])
);

const normalizeScalars = (value = {}) => ({
  supportCount: integer(value.supportCount ?? value.tripSupportCount),
  sampleCount: integer(value.sampleCount),
  limitVotes: normalizeHistogram(value.limitVotes),
  agreementNumerator: number(value.agreementNumerator),
  agreementDenominator: number(value.agreementDenominator),
  confidenceNumerator: number(value.confidenceNumerator),
  confidenceDenominator: number(value.confidenceDenominator),
  timeBuckets: normalizeHistogram(value.timeBuckets),
});

export const normalizeP6Receipt = (value = {}) => ({
  receiptId: String(value.receiptId || `${value.tripId || ''}:${value.sourceRevision || ''}:${value.observationOrdinal || 0}`),
  tripId: String(value.tripId || ''),
  sourceRevision: String(value.sourceRevision || ''),
  observationOrdinal: integer(value.observationOrdinal),
  observedAt: Number.isFinite(Number(value.observedAt)) ? Number(value.observedAt) : null,
  membershipToken: String(value.membershipToken || ''),
  sourceIdentity: String(value.sourceIdentity || ''),
  overlapKnown: value.overlapKnown !== false,
  scalars: normalizeScalars(value.scalars || value),
});

export const applyP6EvidenceDisposition = ({ frozenBaseline = [], receiptedEvidence = [] } = {}, {
  disposition = P6_PROVENANCE_DISPOSITIONS.PRESERVE,
  sourceIdentity = '',
  membershipTokens = [],
  operational = false,
  algorithmVersion = 1,
} = {}) => {
  const identity = String(sourceIdentity || '');
  const tokens = new Set((membershipTokens || []).map(String).filter(Boolean));
  const keptReceipts = [];
  const removedReceipts = [];
  for (const value of receiptedEvidence) {
    const receipt = normalizeP6Receipt(value);
    if ((identity && receipt.sourceIdentity === identity) || (receipt.membershipToken && tokens.has(receipt.membershipToken))) {
      removedReceipts.push(receipt);
    } else keptReceipts.push(receipt);
  }
  if (disposition === P6_PROVENANCE_DISPOSITIONS.PRESERVE) {
    return { frozenBaseline: [...frozenBaseline], receiptedEvidence: [...receiptedEvidence], changed: false };
  }
  const removingTokens = new Set([...tokens, ...removedReceipts.map((value) => value.membershipToken)].filter(Boolean));
  const keptFrozen = frozenBaseline.filter((share) => !removingTokens.has(String(share?.membershipToken || '')));
  if (disposition === P6_PROVENANCE_DISPOSITIONS.FREEZE) {
    const frozenByToken = new Map(keptFrozen.map((share) => [String(share?.membershipToken || ''), share]));
    removedReceipts.forEach((receipt) => {
      const share = freezeP6Receipt(receipt, receipt.membershipToken, { operational, algorithmVersion });
      frozenByToken.set(share.membershipToken, share);
    });
    return { frozenBaseline: [...frozenByToken.values()], receiptedEvidence: keptReceipts, changed: removedReceipts.length > 0 };
  }
  return {
    frozenBaseline: keptFrozen,
    receiptedEvidence: keptReceipts,
    changed: removedReceipts.length > 0 || keptFrozen.length !== frozenBaseline.length,
  };
};

export const freezeP6Receipt = (receipt, membershipToken, { operational = false, algorithmVersion = 1 } = {}) => {
  const normalized = normalizeP6Receipt(receipt);
  const token = String(membershipToken || normalized.membershipToken || '');
  if (!token) throw new Error('P6_FROZEN_MEMBERSHIP_TOKEN_REQUIRED');
  return Object.freeze({
    membershipToken: token,
    scalars: normalized.scalars,
    operationalAtFreeze: operational === true,
    algorithmVersion: Math.max(1, integer(algorithmVersion)),
    // The frozen record deliberately has no trip/source/ordinal/time/geometry fields.
    frozen: true,
  });
};

const addHistogram = (target, value) => {
  Object.entries(value || {}).forEach(([key, count]) => {
    target[key] = integer(target[key]) + integer(count);
  });
};

const addScalars = (target, value) => {
  const scalars = normalizeScalars(value);
  target.supportCount += scalars.supportCount;
  target.sampleCount += scalars.sampleCount;
  target.agreementNumerator += scalars.agreementNumerator;
  target.agreementDenominator += scalars.agreementDenominator;
  target.confidenceNumerator += scalars.confidenceNumerator;
  target.confidenceDenominator += scalars.confidenceDenominator;
  addHistogram(target.limitVotes, scalars.limitVotes);
  addHistogram(target.timeBuckets, scalars.timeBuckets);
};

export const composeP6CandidateEvidence = ({ frozenBaseline = [], receiptedEvidence = [], now = Date.now(), freshMs = 45 * 86400000 } = {}) => {
  const totals = {
    supportCount: 0,
    sampleCount: 0,
    agreementNumerator: 0,
    agreementDenominator: 0,
    confidenceNumerator: 0,
    confidenceDenominator: 0,
    limitVotes: {},
    timeBuckets: {},
  };
  let frozenOperational = false;
  frozenBaseline.forEach((share) => {
    addScalars(totals, share?.scalars || share);
    frozenOperational ||= share?.operationalAtFreeze === true;
  });
  let liveFresh = false;
  receiptedEvidence.forEach((receiptValue) => {
    const receipt = normalizeP6Receipt(receiptValue);
    addScalars(totals, receipt.scalars);
    liveFresh ||= receipt.observedAt != null && receipt.observedAt >= now - freshMs;
  });
  const agreement = totals.agreementDenominator > 0
    ? totals.agreementNumerator / totals.agreementDenominator
    : 0;
  const confidence = totals.confidenceDenominator > 0
    ? totals.confidenceNumerator / totals.confidenceDenominator
    : 0;
  const gatesPass = totals.supportCount >= 3 && agreement >= 0.67 && confidence >= 0.62;
  return {
    ...totals,
    agreement,
    confidence,
    freshness: liveFresh ? 'LIVE_FRESH' : frozenOperational ? 'FROZEN_CONTINUITY' : 'STALE',
    operational: gatesPass && (liveFresh || frozenOperational),
    frozenShareCount: frozenBaseline.length,
    liveReceiptCount: receiptedEvidence.length,
  };
};

/**
 * Reconcile an explicit E2 replay without ever adding a possibly overlapping
 * receipt on top of an opaque baseline share.
 */
export const reconcileP6E2Evidence = ({ frozenBaseline = [], receiptedEvidence = [], replayedEvidence = [] } = {}) => {
  const frozenByToken = new Map(frozenBaseline.map((share) => [String(share?.membershipToken || ''), share]));
  const receiptsById = new Map(receiptedEvidence.map((value) => {
    const receipt = normalizeP6Receipt(value);
    return [receipt.receiptId, receipt];
  }));
  const skipped = [];
  for (const value of replayedEvidence) {
    const receipt = normalizeP6Receipt(value);
    if (receiptsById.has(receipt.receiptId)) continue;
    if (receipt.membershipToken && frozenByToken.has(receipt.membershipToken)) {
      frozenByToken.delete(receipt.membershipToken);
      receiptsById.set(receipt.receiptId, receipt);
      continue;
    }
    if (!receipt.overlapKnown) {
      skipped.push({ receiptId: receipt.receiptId, reason: 'LEGACY_OVERLAP_UNKNOWN' });
      continue;
    }
    receiptsById.set(receipt.receiptId, receipt);
  }
  return {
    frozenBaseline: [...frozenByToken.values()],
    receiptedEvidence: [...receiptsById.values()],
    skipped,
    state: skipped.length ? 'PARTIAL' : 'VERIFIED',
    reason: skipped.length ? 'LEGACY_OVERLAP_UNKNOWN' : null,
  };
};

export const p6EvidencePartCount = ({ frozenBaseline = [], receiptedEvidence = [] } = {}, identity = {}) => {
  const token = String(identity.membershipToken || '');
  const receiptId = String(identity.receiptId || '');
  return frozenBaseline.filter((share) => token && share?.membershipToken === token).length
    + receiptedEvidence.map(normalizeP6Receipt).filter((receipt) => (
      (token && receipt.membershipToken === token) || (receiptId && receipt.receiptId === receiptId)
    )).length;
};
