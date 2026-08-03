import { correctionMatchesPoint, LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import {
  getEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import {
  deleteSpeedSignEvidenceImage,
  drainNativeSpeedSignEvidence,
} from '@/lib/speedSignScanner';

export const SPEED_SIGN_EVIDENCE_STORAGE_KEY = 'drivesense_speed_sign_evidence_v1';
export const SPEED_SIGN_EVIDENCE_CHANGED_EVENT = 'roadsage-speed-sign-evidence-changed';
const MAX_EVIDENCE = 64;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REVIEW_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const QUALIFIER_STATUSES = new Set([
  'regulatory_text_no_qualifiers',
  'conditional_school_when_flashing',
  'conditional_school',
  'conditional_temporary_work_zone',
  'conditional_daytime',
  'conditional_night',
]);

const finite = (value) => Number.isFinite(Number(value));
const timestampMs = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const timeRuleKey = (rule = null) => {
  if (rule?.enabled !== true) return 'always';
  return JSON.stringify({
    days: [...new Set((Array.isArray(rule.days) ? rule.days : []).map(Number))].sort((a, b) => a - b),
    startMinutes: Number(rule.startMinutes),
    endMinutes: Number(rule.endMinutes),
  });
};

const instantKey = (value) => {
  if (value == null || value === '') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : 'invalid';
};

const normalizeEvidence = (value, now = Date.now()) => {
  if (!value || typeof value !== 'object') return null;
  const timestamp = timestampMs(value.timestamp);
  const limitKmh = Number(value.limitKmh);
  const confidence = Number(value.confidence);
  const reviewImageExpiresAt = timestampMs(value.reviewImageExpiresAt);
  const reviewImageAvailable = value.reviewImageAvailable === true
    && reviewImageExpiresAt > now
    && reviewImageExpiresAt <= timestamp + REVIEW_IMAGE_MAX_AGE_MS + 5 * 60 * 1000;
  // Fail closed: an absent or unfamiliar qualifier must never be upgraded to
  // an always-active rule. Only the scanner's explicit, supported qualifier
  // values are eligible for parked review; malformed candidates are dropped.
  if (!QUALIFIER_STATUSES.has(value.qualifierStatus)) return null;
  const qualifierStatus = value.qualifierStatus;
  if (
    !String(value.id || '').startsWith('sign_') ||
    !String(value.tripId || '').trim() ||
    !String(value.corridorId || '').startsWith('corridor_') ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    now - timestamp > MAX_AGE_MS ||
    !Number.isFinite(limitKmh) ||
    limitKmh < 10 ||
    limitKmh > 210 ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) return null;
  return {
    id: String(value.id).slice(0, 100),
    tripId: String(value.tripId).slice(0, 140),
    corridorId: String(value.corridorId).slice(0, 80),
    limitKmh: Math.round(limitKmh * 10) / 10,
    displayedValue: Math.round(Number(value.displayedValue) || limitKmh),
    displayedUnit: value.displayedUnit === 'mph' ? 'mph' : 'km/h',
    confidence,
    frameCount: Math.max(2, Math.min(20, Math.round(Number(value.frameCount) || 2))),
    timestamp,
    source: 'on_device_regulatory_text',
    qualifierStatus,
    conditional: qualifierStatus !== 'regulatory_text_no_qualifiers',
    visualQuality: Math.max(0, Math.min(1, Number(value.visualQuality) || 0)),
    visualQualityLabel: String(value.visualQualityLabel || 'Unavailable').slice(0, 80),
    scanPolicyLabel: String(value.scanPolicyLabel || 'Adaptive scan').slice(0, 80),
    detectorMode: value.detectorMode === 'local_sign_proposal_v1'
      ? 'local_sign_proposal_v1'
      : 'regulatory_text_fallback',
    signTargetFound: value.signTargetFound === true,
    signTargetScore: Math.max(0, Math.min(1, Number(value.signTargetScore) || 0)),
    requiresParkedConfirmation: true,
    affectsScore: false,
    affectsVoiceAlerts: false,
    reviewState: ['pending', 'deferred'].includes(value.reviewState) ? value.reviewState : 'pending',
    deferredAt: value.deferredAt ? String(value.deferredAt).slice(0, 80) : '',
    reviewImageAvailable,
    reviewImageExpiresAt: reviewImageAvailable ? reviewImageExpiresAt : 0,
  };
};

const emitChanged = (detail = {}) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, { detail }));
};

async function readEvidence() {
  const stored = await getEncryptedJson(SPEED_SIGN_EVIDENCE_STORAGE_KEY, []);
  const now = Date.now();
  return (Array.isArray(stored) ? stored : [])
    .map((item) => normalizeEvidence(item, now))
    .filter(Boolean)
    .slice(-MAX_EVIDENCE);
}

async function writeEvidence(items, detail = {}) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => normalizeEvidence(item))
    .filter(Boolean)
    .slice(-MAX_EVIDENCE);
  await setEncryptedJson(SPEED_SIGN_EVIDENCE_STORAGE_KEY, normalized);
  emitChanged(detail);
  return normalized;
}

export async function importSpeedSignEvidence(items = []) {
  const current = await readEvidence();
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of items) {
    const normalized = normalizeEvidence(item);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return writeEvidence([...byId.values()], { action: 'import_native_evidence' });
}

export async function syncNativeSpeedSignEvidence() {
  const nativeEvidence = await drainNativeSpeedSignEvidence();
  if (!nativeEvidence.length) return readEvidence();
  return importSpeedSignEvidence(nativeEvidence);
}

export async function listSpeedSignEvidence({ tripId = null, pendingOnly = true } = {}) {
  const items = await readEvidence();
  return items
    .filter((item) => !tripId || String(item.tripId) === String(tripId))
    .filter((item) => !pendingOnly || item.reviewState === 'pending')
    .sort((a, b) => b.timestamp - a.timestamp);
}

const pointTimestamp = (point) => timestampMs(
  point?.timestampMs ??
  point?.timestamp_ms ??
  point?.timestamp ??
  point?.recorded_at
);

export function routeContextForSpeedSignEvidence(trip, evidence) {
  if (!trip || !evidence || String(trip.id) !== String(evidence.tripId)) return null;
  const points = (Array.isArray(trip.route_points) ? trip.route_points : [])
    .map((point, index) => ({
      point,
      index,
      timestamp: pointTimestamp(point),
    }))
    .filter(({ point, timestamp }) => (
      finite(point?.lat) &&
      finite(point?.lng) &&
      Math.abs(Number(point.lat)) <= 90 &&
      Math.abs(Number(point.lng)) <= 180 &&
      point.privacy_masked !== true &&
      point.masked_for_privacy !== true &&
      timestamp > 0
    ))
    .sort((a, b) => (
      Math.abs(a.timestamp - evidence.timestamp) - Math.abs(b.timestamp - evidence.timestamp)
    ));
  const nearest = points[0];
  if (!nearest || Math.abs(nearest.timestamp - evidence.timestamp) > 120_000) return null;
  const route = Array.isArray(trip.route_points) ? trip.route_points : [];
  const sectionPoints = route
    .slice(Math.max(0, nearest.index - 5), nearest.index + 6)
    .filter((point) => (
      finite(point?.lat) &&
      finite(point?.lng) &&
      point.privacy_masked !== true &&
      point.masked_for_privacy !== true
    ))
    .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  return {
    lat: Number(nearest.point.lat),
    lng: Number(nearest.point.lng),
    heading: finite(nearest.point.heading) ? Number(nearest.point.heading) : null,
    sectionPoints,
  };
}

export async function reviewSpeedSignEvidence(evidenceId, {
  action,
  trip = null,
  limitKmh = null,
  privacyZones = [],
  replaceExistingConfirmed = false,
  condition = null,
} = {}) {
  const items = await readEvidence();
  const evidence = items.find((item) => item.id === evidenceId);
  if (!evidence) return null;
  if (!['confirm_posted', 'adjust_and_confirm', 'defer', 'reject'].includes(action)) {
    throw new Error('Unsupported speed-sign evidence review action.');
  }

  if (action === 'defer') {
    const next = items.map((item) => item.id === evidenceId
      ? {
          ...item,
          reviewState: 'deferred',
          deferredAt: new Date().toISOString(),
        }
      : item);
    await writeEvidence(next, { action, evidenceId });
    return {
      action,
      evidence: next.find((item) => item.id === evidenceId) || evidence,
    };
  }

  if (action === 'reject') {
    await writeEvidence(items.filter((item) => item.id !== evidenceId), { action, evidenceId });
    await deleteSpeedSignEvidenceImage(evidenceId);
    return { action, evidence };
  }

  const routeContext = routeContextForSpeedSignEvidence(trip, evidence);
  if (!routeContext) {
    throw new Error('The matching public trip location is unavailable. This camera candidate cannot be confirmed safely.');
  }
  const confirmedLimit = action === 'adjust_and_confirm' ? Number(limitKmh) : Number(evidence.limitKmh);
  if (!Number.isFinite(confirmedLimit) || confirmedLimit <= 0 || confirmedLimit > 210) {
    throw new Error('Enter a valid posted speed.');
  }

  let timeRule = null;
  let expiresAt = null;
  if (evidence.conditional) {
    if (evidence.qualifierStatus === 'conditional_temporary_work_zone') {
      const parsedExpiry = new Date(condition?.expiresAt || 0).getTime();
      if (!Number.isFinite(parsedExpiry) || parsedExpiry <= Date.now()) {
        throw new Error('Choose a future expiry date for this temporary work-zone sign.');
      }
      expiresAt = new Date(parsedExpiry).toISOString();
    } else {
      const days = Array.isArray(condition?.days)
        ? [...new Set(condition.days.map(Number).filter((day) => day >= 0 && day <= 6))]
        : [];
      const startMinutes = Number(condition?.startMinutes);
      const endMinutes = Number(condition?.endMinutes);
      if (!days.length || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || startMinutes === endMinutes) {
        throw new Error('Enter the days and active hours printed for this conditional sign. If they are unknown, keep it for later.');
      }
      timeRule = { enabled: true, days, startMinutes, endMinutes };
    }
  }

  const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
  const existingConfirmed = (await knowledge.listUserCorrections()).find((correction) => (
    correction.source === 'user_confirmed_posted_sign' &&
    correctionMatchesPoint(correction, routeContext.lat, routeContext.lng, undefined, {
      headingDeg: routeContext.heading,
      timestampMs: evidence.timestamp,
      // The recurring schedule describes when a limit applies, not whether
      // this is the same saved corridor. Ignore it for identity matching so
      // an off-hours review updates/versions the existing rule instead of
      // creating an overlapping duplicate. Effective-from and expiry checks
      // still run at the evidence capture instant inside correctionMatchesPoint.
      ignoreSchedule: true,
    })
  ));
  const existingLimitKmh = Number(existingConfirmed?.limitKmh);
  const limitChanged = existingConfirmed && Math.round(existingLimitKmh) !== Math.round(confirmedLimit);
  const qualifierChanged = Boolean(existingConfirmed) && (
    String(existingConfirmed.qualifierStatus || 'regulatory_text_no_qualifiers') !== evidence.qualifierStatus ||
    timeRuleKey(existingConfirmed.timeRule) !== timeRuleKey(timeRule) ||
    instantKey(existingConfirmed.expiresAt) !== instantKey(expiresAt)
  );
  const replacementChanged = Boolean(existingConfirmed) && (limitChanged || qualifierChanged);
  const evidenceEffectiveAt = new Date(evidence.timestamp).toISOString();
  const replacementEffectiveAt = replacementChanged
    ? evidenceEffectiveAt
    : null;

  if (replacementChanged && !replaceExistingConfirmed) {
    return {
      action: 'confirmed_speed_conflict',
      evidence,
      existingCorrection: existingConfirmed,
      proposedLimitKmh: confirmedLimit,
      qualifierChanged,
      existingQualifierStatus: existingConfirmed.qualifierStatus || 'regulatory_text_no_qualifiers',
      proposedQualifierStatus: evidence.qualifierStatus,
      requiresReplacementConfirmation: true,
    };
  }

  const correctionMetadata = {
    contextLabel: `User-confirmed posted sign after ${evidence.frameCount} matching on-device frames`,
    directionMode: routeContext.heading == null ? 'both' : 'forward',
    directionBearing: routeContext.heading,
    sectionPoints: routeContext.sectionPoints,
    evidenceIncrement: 1,
    historyGroup: `speed_sign_evidence:${evidence.id}`,
    qualifierStatus: evidence.qualifierStatus,
    timeRule,
    expiresAt,
    ...((replacementChanged || (!existingConfirmed && evidence.conditional)) ? {
      validFrom: replacementEffectiveAt || evidenceEffectiveAt,
      validFromDate: (replacementEffectiveAt || evidenceEffectiveAt).slice(0, 10),
    } : {}),
    ...(replacementChanged ? {
      conflictResolution: {
        savedLimitKmh: confirmedLimit,
        observedLimitKmh: confirmedLimit,
        deltaKmh: Math.abs(existingLimitKmh - confirmedLimit),
        action: 'camera_candidate_replaced_after_second_confirmation',
        note: qualifierChanged
          ? 'The posted sign conditions changed; the user explicitly confirmed the new rule after parking.'
          : `Previously confirmed ${Math.round(existingLimitKmh)} km/h; user explicitly confirmed the new posted sign after parking.`,
      },
    } : {}),
  };
  let correction;
  if (existingConfirmed) {
    const updated = await knowledge.updateUserCorrection(
      existingConfirmed.id || existingConfirmed.ruleId || existingConfirmed.sectionKey,
      confirmedLimit,
      'user_confirmed_posted_sign',
      'Reverified by the user after parking from a private on-device camera prompt.',
      correctionMetadata
    );
    if (updated) {
      const existingId = String(
        existingConfirmed.id || existingConfirmed.ruleId || existingConfirmed.sectionKey
      );
      correction = (await knowledge.listUserCorrections()).find((item) => (
        item.historicalVersion !== true &&
        Math.round(Number(item.limitKmh)) === Math.round(confirmedLimit) &&
        (
          String(item.supersedesCorrectionId || '') === existingId ||
          correctionMatchesPoint(item, routeContext.lat, routeContext.lng, undefined, {
            headingDeg: routeContext.heading,
            timestampMs: evidence.timestamp,
            ignoreSchedule: true,
          })
        )
      ));
    }
  } else {
    correction = await knowledge.saveUserCorrection(
      routeContext.lat,
      routeContext.lng,
      confirmedLimit,
      'Confirmed by the user after parking; camera output was only a private review prompt.',
      expiresAt,
      privacyZones,
      'user_confirmed_posted_sign',
      correctionMetadata
    );
  }
  if (!correction) {
    throw new Error('This candidate is inside a protected privacy area or lacks a usable public route point.');
  }

  await writeEvidence(items.filter((item) => item.id !== evidenceId), { action, evidenceId });
  await deleteSpeedSignEvidenceImage(evidenceId);
  return {
    action,
    evidence,
    correction,
    reverifiedExisting: Boolean(existingConfirmed && !replacementChanged),
    replacedExisting: replacementChanged,
    replacementEffectiveAt,
    previousLimitKmh: existingConfirmed ? existingLimitKmh : null,
    qualifierChanged,
  };
}
