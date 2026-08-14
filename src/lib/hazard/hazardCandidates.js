/**
 * Turns whatever the corridor query returned into one comparable shape.
 *
 * Two things are ranked here and they come from different stores with different
 * scales: repeated-event areas (severity points from `dangerZoneEngine`) and the
 * late-braking advisory (pass counts from `routeRiskIndex`). Both are normalized
 * to a 0-1 severity so `urgency` means the same thing for either.
 *
 * Route-risk segments are deliberately *not* a hazard kind of their own. They are
 * ~110 m cells covering every road driven more than twice, so alerting on them
 * directly would bury the repeated-event areas the driver actually recognises.
 * They appear here only as the evidence base for the late-braking advisory.
 *
 * None of these weights is calibrated against collision outcomes. They order the
 * driver's own recorded history against itself, nothing more.
 */
import { clamp } from '@/lib/mathUtils';
import { relativeToProjectedPath } from '@/lib/hazard/hazardPathProjection';
import { buildCurveEntryAdvisory } from '@/lib/hazard/hazardCurveAdvisory';
import {
  HAZARD_BEHIND_TOLERANCE_M,
  HAZARD_LATE_BRAKING_SEVERITY_WEIGHT,
  HAZARD_TIME_URGENCY_FLOOR,
} from '@/lib/appConstants';

export const HAZARD_KIND_REPEATED_EVENT_AREA = 'repeated_event_area';
export const HAZARD_KIND_LATE_BRAKING = 'late_braking_pattern';

/** Higher wins a tie on equal urgency: a place is more actionable than a habit. */
export const HAZARD_KIND_PRIORITY = Object.freeze({
  [HAZARD_KIND_REPEATED_EVENT_AREA]: 2,
  [HAZARD_KIND_LATE_BRAKING]: 1,
});

const RISK_LEVEL_SEVERITY = Object.freeze({
  critical: 1, high: 0.8, medium: 0.55, moderate: 0.55, low: 0.35,
});
/** Event count at which a zone's severity stops climbing. */
const SEVERITY_EVENT_SATURATION = 8;

const finiteOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const zoneSeverity = (zone) => {
  const base = RISK_LEVEL_SEVERITY[zone?.riskLevel] ?? RISK_LEVEL_SEVERITY.low;
  const weight = clamp(finiteOr(zone?.eventCount) / SEVERITY_EVENT_SATURATION, 0, 1);
  // Level sets the floor; volume can only lift it toward that level's ceiling.
  return clamp(base * (0.75 + 0.25 * weight), 0, 1);
};

/**
 * How much of the warning window a hazard has already consumed, scored from
 * HAZARD_TIME_URGENCY_FLOOR at the far edge to 1 where a warning stops helping.
 *
 * The floor is what keeps severity meaningful. Scored from zero, imminence
 * swamps it — a low-severity area a second nearer outranks a critical one — and
 * since only the top-ranked hazard reaches the gate, that is the difference
 * between warning about the right thing and the near thing.
 */
export function timeUrgency(etaSeconds, { alertSeconds, minSeconds }) {
  const span = alertSeconds - minSeconds;
  if (!(span > 0)) return HAZARD_TIME_URGENCY_FLOOR;
  const consumed = clamp(1 - (finiteOr(etaSeconds, Infinity) - minSeconds) / span, 0, 1);
  return HAZARD_TIME_URGENCY_FLOOR + (1 - HAZARD_TIME_URGENCY_FLOOR) * consumed;
}

const positionOf = (path, target) => relativeToProjectedPath(path, target, {
  behindToleranceM: HAZARD_BEHIND_TOLERANCE_M,
});

/**
 * @param {{records: Array<any>, path: any, pathConfidence: number, speedKmh: number,
 *          alertSeconds: number, minSeconds: number}} input
 * @returns {{candidates: Array<any>, rejected: Array<{id: string, reason: string}>}}
 */
export function buildHazardCandidates({
  records = [], path, pathConfidence = 1, speedKmh = 0, alertSeconds, minSeconds,
} = {}) {
  const candidates = [];
  const rejected = [];
  if (!path) return { candidates, rejected };

  const score = (severity, etaSeconds) => clamp(
    severity * timeUrgency(etaSeconds, { alertSeconds, minSeconds }) * clamp(pathConfidence, 0, 1),
    0,
    1
  );
  const place = (id, target) => {
    const position = positionOf(path, target);
    if (position.behind) return { position, reason: 'behind' };
    if (!position.onPath) return { position, reason: 'off_path' };
    if (position.etaSeconds > alertSeconds) return { position, reason: 'beyond_horizon' };
    if (position.etaSeconds < minSeconds) return { position, reason: 'too_late' };
    return { position, reason: null, id };
  };

  for (const record of records) {
    if (record?.kind === 'zone') {
      const zone = record.zone;
      const id = `zone:${zone.id}`;
      const { position, reason } = place(id, zone);
      if (reason) {
        rejected.push({ id, reason });
        continue;
      }
      const severity = zoneSeverity(zone);
      candidates.push({
        id,
        kind: HAZARD_KIND_REPEATED_EVENT_AREA,
        lat: zone.lat,
        lng: zone.lng,
        alongTrackM: position.alongTrackM,
        crossTrackM: position.crossTrackM,
        etaSeconds: position.etaSeconds,
        severity,
        pathConfidence,
        urgency: score(severity, position.etaSeconds),
        evidence: {
          eventCount: finiteOr(zone.eventCount),
          riskLevel: zone.riskLevel ?? null,
          dominantType: zone.dominantType ?? null,
          lastSeen: zone.lastSeen ?? null,
        },
        voiceKey: HAZARD_KIND_REPEATED_EVENT_AREA,
        notificationType: HAZARD_KIND_REPEATED_EVENT_AREA,
      });
      continue;
    }

    if (record?.kind !== 'segment') continue;
    const segment = record.segment;
    const id = `segment:${segment.lat},${segment.lng}`;
    const { position, reason } = place(id, segment);
    if (reason) {
      rejected.push({ id, reason });
      continue;
    }
    const advisory = buildCurveEntryAdvisory({ segment, approachSpeedKmh: speedKmh });
    if (!advisory.eligible) {
      rejected.push({ id, reason: advisory.reason });
      continue;
    }
    // Confidence that a habit exists is not the same scale as how much a place
    // matters, so it is held below a repeated-event area rather than compared
    // to one directly.
    const advisorySeverity = advisory.confidence * HAZARD_LATE_BRAKING_SEVERITY_WEIGHT;
    candidates.push({
      id,
      kind: HAZARD_KIND_LATE_BRAKING,
      lat: segment.lat,
      lng: segment.lng,
      alongTrackM: position.alongTrackM,
      crossTrackM: position.crossTrackM,
      etaSeconds: position.etaSeconds,
      severity: advisorySeverity,
      pathConfidence,
      urgency: score(advisorySeverity, position.etaSeconds),
      evidence: advisory,
      voiceKey: HAZARD_KIND_LATE_BRAKING,
      notificationType: HAZARD_KIND_LATE_BRAKING,
    });
  }

  return { candidates, rejected };
}

/** Most urgent first; a place outranks a habit when urgency ties. */
export function rankHazardCandidates(candidates = []) {
  return [...candidates].sort((a, b) => (
    b.urgency - a.urgency ||
    (HAZARD_KIND_PRIORITY[b.kind] ?? 0) - (HAZARD_KIND_PRIORITY[a.kind] ?? 0) ||
    a.etaSeconds - b.etaSeconds
  ));
}
