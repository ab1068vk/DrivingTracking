import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';

const activeConditional = (record = {}) => Boolean(
  record.timeRule?.enabled || record.validFrom || record.valid_from || record.expiresAt
);

const finiteInstant = (value) => {
  if (value == null || value === '') return null;
  const instant = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(instant) ? instant : null;
};

const parseTimeMinutes = (value) => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

const normalizeRuleMinutes = (value, fallback) => {
  if (value == null || value === '') return parseTimeMinutes(fallback);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(1439, Math.round(numeric)));
  return parseTimeMinutes(fallback);
};

const cleanDays = (days = []) => [...new Set((Array.isArray(days) ? days : [])
  .map(Number)
  .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
  .sort((left, right) => left - right);

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatMinutes = (value) => {
  const minutes = Math.max(0, Math.min(1439, Math.round(Number(value) || 0)));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

const scheduleLabel = (days, startMinutes, endMinutes) => {
  const dayLabel = days.join(',') === '1,2,3,4,5'
    ? 'Weekdays'
    : days.join(',') === '0,6'
      ? 'Weekends'
      : days.length === 7
        ? 'Every day'
        : days.map((day) => dayNames[day]).join(', ');
  return `${dayLabel} ${formatMinutes(startMinutes)}-${formatMinutes(endMinutes)}`;
};

const recordedOffset = (record = {}, context = {}) => {
  const candidates = [
    context.utcOffsetMinutes,
    context.utc_offset_minutes,
    context.recordedUtcOffsetMinutes,
    record.utcOffsetMinutes,
    record.utc_offset_minutes,
    record.recordedUtcOffsetMinutes,
    record.timeRule?.utcOffsetMinutes,
    record.timeRule?.utc_offset_minutes,
  ];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const offset = Number(value);
    if (Number.isFinite(offset) && Math.abs(offset) <= 24 * 60) return offset;
  }
  return null;
};

const clockParts = (timestampMs, offsetMinutes) => {
  if (Number.isFinite(offsetMinutes)) {
    const shifted = new Date(timestampMs + offsetMinutes * 60_000);
    return {
      day: shifted.getUTCDay(),
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }
  const local = new Date(timestampMs);
  return {
    day: local.getDay(),
    minutes: local.getHours() * 60 + local.getMinutes(),
  };
};

const humanizeCode = (value) => String(value || '')
  .trim()
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^./, (letter) => letter.toUpperCase());

const optionalFiniteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const SCHEDULED_CONDITIONAL_QUALIFIERS = new Set([
  'conditional_school_when_flashing',
  'conditional_school',
  'conditional_daytime',
  'conditional_night',
]);

const qualifierConditionIsValid = (record = {}) => {
  const qualifier = String(record.qualifierStatus || '');
  if (!qualifier || qualifier === 'regulatory_text_no_qualifiers') return true;
  if (qualifier === 'conditional_temporary_work_zone') {
    return finiteInstant(record.expiresAt) != null;
  }
  if (SCHEDULED_CONDITIONAL_QUALIFIERS.has(qualifier)) {
    return record.timeRule?.enabled === true;
  }
  return false;
};

export function describeSpeedRuleApplicability(record = {}, context = {}) {
  const requestedInstant = context.timestampMs ?? context.pointTimestampMs ?? context.nowMs;
  const evaluatedAtMs = finiteInstant(requestedInstant) ?? Date.now();
  const validFromValue = record.validFrom ?? record.valid_from;
  const expiresAtValue = record.expiresAt;
  const validFromMs = finiteInstant(validFromValue);
  const expiresAtMs = finiteInstant(expiresAtValue);
  const timeRule = record.timeRule || {};
  const scheduleEnabled = timeRule.enabled === true;
  const days = cleanDays(timeRule.days);
  const startMinutes = normalizeRuleMinutes(timeRule.startMinutes, timeRule.startTime);
  const endMinutes = normalizeRuleMinutes(timeRule.endMinutes, timeRule.endTime);
  const offsetMinutes = recordedOffset(record, context);
  const timeBasis = Number.isFinite(offsetMinutes)
    ? `recorded UTC offset ${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} min`
    : 'this device\'s local clock';

  const base = {
    evaluatedAtMs,
    validFromMs,
    expiresAtMs,
    scheduleEnabled,
    schedule: scheduleEnabled && days.length && startMinutes != null && endMinutes != null
      ? scheduleLabel(days, startMinutes, endMinutes)
      : null,
    utcOffsetMinutes: offsetMinutes,
    timeBasis,
  };

  if (
    (validFromValue != null && validFromValue !== '' && validFromMs == null) ||
    (expiresAtValue != null && expiresAtValue !== '' && expiresAtMs == null) ||
    (validFromMs != null && expiresAtMs != null && validFromMs >= expiresAtMs)
  ) {
    return {
      ...base,
      active: false,
      status: 'invalid',
      reason: 'invalid_date_window',
      label: 'Date window needs repair',
      detail: 'The effective-from or expiry value is invalid, so this rule stays blocked until its date window is corrected.',
    };
  }

  if (validFromMs != null && evaluatedAtMs < validFromMs) {
    return {
      ...base,
      active: false,
      status: 'future',
      reason: 'not_yet_effective',
      label: 'Not effective yet',
      detail: `Starts ${new Date(validFromMs).toLocaleString()}. Earlier trip points keep the rule that applied at their recorded time.`,
    };
  }
  if (expiresAtMs != null && evaluatedAtMs >= expiresAtMs) {
    return {
      ...base,
      active: false,
      status: 'expired',
      reason: 'expired',
      label: 'Expired at this time',
      detail: `Ended ${new Date(expiresAtMs).toLocaleString()}. It remains visible for audit but cannot affect later points.`,
    };
  }
  if (!scheduleEnabled) {
    return {
      ...base,
      active: true,
      status: 'active',
      reason: 'active',
      label: validFromMs || expiresAtMs ? 'Active in its date window' : 'Always active',
      detail: validFromMs || expiresAtMs
        ? 'The evaluated trip point is inside this rule\'s effective date window.'
        : 'No date or clock schedule limits this rule.',
    };
  }
  if (!days.length || startMinutes == null || endMinutes == null) {
    return {
      ...base,
      active: false,
      status: 'invalid',
      reason: 'invalid_schedule',
      label: 'Schedule needs repair',
      detail: 'The saved schedule is incomplete, so the rule stays blocked until its active days and times are corrected.',
    };
  }

  const parts = clockParts(evaluatedAtMs, offsetMinutes);
  const overnight = startMinutes > endMinutes;
  const scheduleDay = overnight && parts.minutes <= endMinutes
    ? (parts.day + 6) % 7
    : parts.day;
  const dayMatches = days.includes(scheduleDay);
  const timeMatches = startMinutes === endMinutes || (startMinutes < endMinutes
    ? parts.minutes >= startMinutes && parts.minutes <= endMinutes
    : parts.minutes >= startMinutes || parts.minutes <= endMinutes);
  const active = dayMatches && timeMatches;
  return {
    ...base,
    active,
    status: active ? 'active' : 'scheduled_inactive',
    reason: active ? 'active' : dayMatches ? 'outside_scheduled_time' : 'outside_scheduled_day',
    label: active ? 'Schedule active at this time' : 'Schedule inactive at this time',
    detail: `${scheduleLabel(days, startMinutes, endMinutes)} using ${timeBasis}. ${active ? 'This point is inside the schedule.' : 'This point is outside the schedule, so the rule is not applied.'}`,
  };
}

export function buildResolverProvenance(record = {}) {
  const originCode = record.provenance ?? record.origin ?? record.evidenceOrigin ?? null;
  const selectionCode = record.selectedReason ?? record.selectionReason ?? record.resolverReason ??
    record.speedLimitSelectionReason ?? null;
  const matchCode = record.matchReason ?? record.geometryMatchReason ?? null;
  const matchType = record.matchType ?? record.geometryMatchType ?? null;
  const matchDistance = optionalFiniteNumber(record.matchDistanceM ?? record.distanceM);
  const revision = optionalFiniteNumber(
    record.speedKnowledgeRevision ?? record.knowledgeRevision ?? record.revision
  );
  const entries = [];
  if (originCode) entries.push(`Origin: ${humanizeCode(originCode)}`);
  if (selectionCode) entries.push(`Selected: ${humanizeCode(selectionCode)}`);
  if (matchCode || matchType) {
    const match = humanizeCode(matchCode || matchType);
    entries.push(`Geometry: ${match}${matchDistance != null ? ` (${Math.round(matchDistance)} m)` : ''}`);
  }
  if (revision != null && revision >= 0) entries.push(`Knowledge revision ${Math.floor(revision)}`);
  return {
    origin: originCode ? humanizeCode(originCode) : null,
    selection: selectionCode ? humanizeCode(selectionCode) : null,
    match: matchCode || matchType ? humanizeCode(matchCode || matchType) : null,
    revision: revision != null && revision >= 0 ? Math.floor(revision) : null,
    entries,
    summary: entries.join(' | '),
  };
}

export function buildSpeedEvidenceDecision(record = {}, context = {}) {
  const applicability = describeSpeedRuleApplicability(record, context);
  const provenance = buildResolverProvenance(record);
  const evidence = assessSpeedLimitEvidence(record, applicability.evaluatedAtMs);
  const source = evidence.source;
  const confirmed = source === 'user_confirmed_posted_sign';
  const mappedPosted = source === 'openstreetmap';
  const operationalMemory = source === 'local_road_memory' &&
    record.canAffectScoreAndAlerts === true &&
    (record.usageStage === 'validated' || record.active === true);
  const shadowMemory = source === 'local_road_memory' && !operationalMemory;
  const pendingCamera = source === 'on_device_regulatory_text';
  const qualifierConditional = String(record.qualifierStatus || '').startsWith('conditional_');
  const conditional = activeConditional(record) || qualifierConditional;
  const validCondition = qualifierConditionIsValid(record);
  const blocked = evidence.expired || evidence.conflict || pendingCamera || !validCondition || !applicability.active;
  const canAffect = !blocked && (confirmed || mappedPosted || operationalMemory || source === 'user_entered_estimate');
  const authorityLabel = confirmed
    ? 'Your confirmed posted sign'
    : source === 'openstreetmap'
      ? 'OpenStreetMap posted road data'
    : operationalMemory
      ? `Road Memory from ${Math.max(3, evidence.evidenceCount)} matching drives`
      : shadowMemory
        ? 'Road Memory shadow estimate'
      : pendingCamera
        ? 'Unconfirmed private camera candidate'
        : `${speedLimitConfidenceLabel(evidence)} ${evidence.authority} evidence`;
  const why = applicability.reason === 'expired'
    ? 'The rule had already expired at the evaluated point time, so it is blocked.'
    : applicability.reason === 'not_yet_effective'
      ? 'The evaluated point predates this rule. Historical trips keep the speed evidence that was valid when each point was recorded.'
      : String(applicability.reason).startsWith('invalid_')
        ? 'The active date or clock schedule is incomplete, so this rule stays blocked until it is repaired.'
        : !applicability.active
          ? 'The road rule exists, but its day-and-time schedule is inactive at the evaluated point time.'
    : evidence.conflict
      ? 'Evidence disagrees, so the saved value stays under review.'
      : pendingCamera
        ? 'The camera can create a review prompt, but only you can confirm a posted limit while parked.'
        : !validCondition
          ? record.qualifierStatus === 'conditional_temporary_work_zone'
            ? 'A temporary work-zone qualifier was detected but its expiry is missing or invalid.'
            : 'A qualifier was detected but its active schedule is unknown.'
          : confirmed
            ? 'You confirmed the posted sign for this GPS corridor.'
            : operationalMemory
            ? 'Repeated drives agreed closely enough for a lower-weight operational estimate.'
            : shadowMemory
              ? record.validationReason || 'This estimate is being tested against parked decisions before it can affect the drive.'
              : 'This is an estimate and carries less authority than a confirmed posted sign.';
  const consequence = canAffect
    ? `Used by trip scoring and voice/live speed alerts${confirmed || mappedPosted ? ' at full authority' : ' with estimate confidence weighting'} at this evaluated time.`
    : applicability.status === 'future' || applicability.status === 'scheduled_inactive' || applicability.status === 'expired'
      ? 'Does not change scoring or voice/live speed alerts for trip points outside its effective time window.'
      : 'Does not change scoring or voice/live speed alerts until its blocking review is resolved.';
  let urgency = 10;
  if (evidence.conflict) urgency += 100;
  if (evidence.expired) urgency += 90;
  if (!validCondition) urgency += 80;
  if (source === 'missing_posted_review') urgency += 70;
  if (evidence.stale) urgency += 30;
  urgency += Math.min(35, (Number(context.affectedTripCount ?? record.affectedTripCount) || 0) * 5);
  return {
    evidence,
    status: applicability.status === 'future'
      ? 'future'
      : applicability.status === 'invalid'
        ? 'schedule_error'
      : applicability.status === 'scheduled_inactive'
        ? 'inactive'
        : applicability.status === 'expired' || evidence.expired
          ? 'expired'
          : !validCondition
            ? 'invalid_condition'
            : evidence.conflict
              ? 'conflict'
              : pendingCamera
                ? 'pending'
                : confirmed
                  ? 'confirmed'
                  : mappedPosted
                    ? 'mapped'
                  : operationalMemory
                    ? 'operational'
                    : shadowMemory
                      ? 'shadow'
                      : 'estimated',
    authorityLabel,
    why,
    consequence,
    canAffectScore: canAffect,
    canAffectVoiceAlerts: canAffect,
    reviewUrgency: urgency,
    conditional,
    validCondition,
    applicability,
    provenance,
    ledger: [
      `${evidence.evidenceCount || 1} evidence item${evidence.evidenceCount === 1 ? '' : 's'}`,
      `${evidence.confidencePercent}% confidence`,
      evidence.ageDays == null ? 'Age unavailable' : `${evidence.ageDays} days since verification`,
      applicability.label,
      ...provenance.entries,
    ].filter((entry, index, values) => entry && values.indexOf(entry) === index),
  };
}

export function dedupeSpeedEvidenceReviewItems(items = []) {
  const groups = new Map();
  items.forEach((item, index) => {
    const key = String(
      item.corridorId || item.corridorEdgeId || item.sectionKey || item.geohash ||
      `${item.roadName || item.roads?.[0] || 'road'}:${Math.round(Number(item.lat) * 10000) || index}:${Math.round(Number(item.lng) * 10000) || index}`
    );
    const decision = buildSpeedEvidenceDecision(item);
    const current = groups.get(key);
    if (!current || decision.reviewUrgency > current.decision.reviewUrgency) {
      groups.set(key, { item, decision, count: (current?.count || 0) + 1 });
    } else {
      current.count += 1;
    }
  });
  return [...groups.values()].map(({ item, count }) => ({ ...item, duplicateReviewCount: count }));
}
