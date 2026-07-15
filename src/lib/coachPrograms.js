import { routeKeyForTrip } from '@/lib/commuteMatching';
import { getJson, setJson } from '@/lib/mobileStorage';
import { excludePrivacyTouchedDaysFromTrends } from '@/lib/privateTripMode';

export const COACH_PROGRAM_STORAGE_KEY = 'drivesense_coach_programs_v1';
export const COACH_PROGRAM_CHANGED_EVENT = 'drivesense:coach-program-changed';
export const COACH_PROGRAM_VERSION = 3;

export const COACH_FEEDBACK_OPTIONS = {
  helpful: { id: 'helpful', label: 'Helpful', promptDelta: 0, weight: 1 },
  too_frequent: { id: 'too_frequent', label: 'Too frequent', promptDelta: -1, weight: -0.35 },
  not_relevant: { id: 'not_relevant', label: 'Not relevant', promptDelta: 0, weight: -0.65 },
  wrong_detection: { id: 'wrong_detection', label: 'Wrong detection', promptDelta: 0, weight: -0.8 },
  unavoidable: { id: 'unavoidable', label: 'Unavoidable', promptDelta: 0, weight: -0.15 },
};

const DIFFICULTY_TARGETS = {
  gentle: { reduction: 0.15, scoreGain: 3, promptBudget: 2, label: 'Gentle' },
  standard: { reduction: 0.25, scoreGain: 5, promptBudget: 3, label: 'Standard' },
  intensive: { reduction: 0.35, scoreGain: 8, promptBudget: 4, label: 'Intensive' },
};

export const COACH_FOCUS_CATALOG = {
  harsh_brakes: {
    id: 'harsh_brakes',
    label: 'Progressive Braking',
    shortLabel: 'Brake earlier',
    metricLabel: 'harsh brakes / 100 km',
    field: 'harsh_brakes_count',
    direction: 'lower',
    cue: 'Lift early, create space, then build brake pressure gradually.',
    liveCue: 'Today\'s focus is progressive braking. Lift early and build pressure smoothly.',
    drill: [
      'Choose the stop point earlier than usual.',
      'Lift off before applying the brake.',
      'Begin with light pressure and add force smoothly.',
    ],
  },
  rapid_accel: {
    id: 'rapid_accel',
    label: 'Smoother Starts',
    shortLabel: 'Smooth acceleration',
    metricLabel: 'rapid starts / 100 km',
    field: 'rapid_accel_count',
    direction: 'lower',
    cue: 'Use a three-second throttle ramp after every full stop.',
    liveCue: 'Today\'s focus is smooth acceleration. Build throttle over three seconds.',
    drill: [
      'Settle the car fully at the stop.',
      'Add throttle progressively over three seconds.',
      'Reach cruise speed without a second surge.',
    ],
  },
  sharp_turns: {
    id: 'sharp_turns',
    label: 'Cleaner Turns',
    shortLabel: 'Set corner speed',
    metricLabel: 'sharp turns / 100 km',
    field: 'sharp_turns_count',
    direction: 'lower',
    cue: 'Set speed before the turn and accelerate only as the wheel straightens.',
    liveCue: 'Today\'s focus is cleaner turns. Set speed before steering.',
    drill: [
      'Finish braking before meaningful steering input.',
      'Hold a calm, constant speed through the corner.',
      'Accelerate only as steering unwinds.',
    ],
  },
  speeding: {
    id: 'speeding',
    label: 'Speed Discipline',
    shortLabel: 'Control speed creep',
    metricLabel: 'speed events / 100 km',
    field: 'speeding_events_count',
    direction: 'lower',
    cue: 'Choose a cruise target below the alert threshold and check after transitions.',
    liveCue: 'Today\'s focus is speed discipline. Settle below the alert threshold.',
    drill: [
      'Pick a target speed before joining the main road.',
      'Recheck speed after hills and road transitions.',
      'Use cruise control only when conditions make it appropriate.',
    ],
  },
  phone_use: {
    id: 'phone_use',
    label: 'Phone-Clear Driving',
    shortLabel: 'Remove phone exposure',
    metricLabel: 'phone-use windows / 100 km',
    field: 'phone_use_window_count',
    direction: 'lower',
    cue: 'Set navigation and audio before moving, then keep the phone out of reach.',
    liveCue: 'Today\'s focus is a phone-clear drive. Keep the phone out of reach.',
    drill: [
      'Enable Do Not Disturb before moving.',
      'Set navigation and audio while parked.',
      'Keep the device mounted or out of reach for the full trip.',
    ],
  },
  fatigue: {
    id: 'fatigue',
    label: 'Fatigue-Aware Driving',
    shortLabel: 'Protect alertness',
    metricLabel: 'fatigue risk score',
    field: 'fatigue_risk_score',
    metricKind: 'score',
    direction: 'lower',
    cue: 'Plan a break before your learned fatigue window and stop if alertness drops.',
    liveCue: 'Today\'s focus is alertness. Take a break before fatigue builds.',
    drill: [
      'Check your alertness honestly before moving.',
      'Plan the break before the learned fatigue window.',
      'Stop somewhere safe if concentration or comfort drops.',
    ],
  },
  consistency: {
    id: 'consistency',
    label: 'Repeat Your Best Drive',
    shortLabel: 'Reuse your strongest setup',
    metricLabel: 'overall score',
    field: 'score_overall',
    direction: 'higher',
    cue: 'Recreate the route, timing, and calm first five minutes from your strongest comparable drive.',
    liveCue: 'Today\'s focus is repeating your strongest measured drive setup.',
    drill: [
      'Use a route and time window from a strong previous drive.',
      'Repeat its calm first five minutes.',
      'Compare the overall score only after another comparable drive.',
    ],
  },
};

const FOCUS_ALIASES = {
  braking: 'harsh_brakes',
  'progressive braking': 'harsh_brakes',
  acceleration: 'rapid_accel',
  cornering: 'sharp_turns',
  'speed control': 'speeding',
  phone_distraction: 'phone_use',
  'distraction risk': 'phone_use',
  'attention-pattern review': 'phone_use',
  fatigue: 'fatigue',
  'fatigue risk': 'fatigue',
  alertness: 'fatigue',
  consistency: 'consistency',
};

const asDateMs = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const completedTrips = (trips = []) => excludePrivacyTouchedDaysFromTrends(trips)
  .filter((trip) => trip?.status === 'completed')
  .sort((a, b) => asDateMs(b.start_time || b.created_at) - asDateMs(a.start_time || a.created_at));

const roadTypeForTrip = (trip = {}) => String(
  trip.dominant_road_type || trip.road_type || trip.primary_road_type || 'mixed'
).toLowerCase();

const durationBucketForTrip = (trip = {}) => {
  const minutes = (Number(trip.duration_seconds) || 0) / 60;
  if (minutes <= 15) return 'short';
  if (minutes <= 40) return 'medium';
  return 'long';
};

const timeBucketForTrip = (trip = {}) => {
  const date = new Date(trip.start_time || trip.created_at || 0);
  const hour = Number.isFinite(date.getTime()) ? date.getHours() : 12;
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
};

export function buildTripContextSignature(trip = {}) {
  return {
    routeKey: routeKeyForTrip(trip),
    roadType: roadTypeForTrip(trip),
    durationBucket: durationBucketForTrip(trip),
    timeBucket: timeBucketForTrip(trip),
  };
}

const sameContext = (trip, context = {}) => {
  if (!trip) return false;
  if (context.mode === 'all') return true;
  const signature = buildTripContextSignature(trip);
  if (context.mode === 'urban') return ['urban', 'city', 'residential'].includes(signature.roadType);
  if (context.mode === 'highway') return ['highway', 'motorway'].includes(signature.roadType);
  if (context.mode !== 'comparable') return true;
  if (context.signature?.routeKey && signature.routeKey) {
    return context.signature.routeKey === signature.routeKey;
  }
  const matches = [
    context.signature?.roadType === signature.roadType,
    context.signature?.durationBucket === signature.durationBucket,
    context.signature?.timeBucket === signature.timeBucket,
  ].filter(Boolean).length;
  return matches >= 2;
};

const eventTypesForFocus = {
  harsh_brakes: ['harsh_brake'],
  rapid_accel: ['rapid_acceleration', 'rapid_accel'],
  sharp_turns: ['sharp_turn'],
  speeding: ['speeding'],
  phone_use: ['phone_use', 'phone_interaction'],
};

const measuredEventCount = (trip = {}, focus = {}) => {
  const direct = trip?.[focus.field];
  if (direct !== null && direct !== '' && Number.isFinite(Number(direct)) && Number(direct) >= 0) {
    return Number(direct);
  }
  if (focus.id === 'phone_use') {
    const compact = trip?.phone_use_summary?.windowCount ?? trip?.phone_use_summary?.window_count;
    if (compact !== null && compact !== '' && Number.isFinite(Number(compact)) && Number(compact) >= 0) {
      return Number(compact);
    }
  }
  const types = eventTypesForFocus[focus.id];
  if (!types || !Array.isArray(trip?.driving_events)) return null;
  return trip.driving_events.filter((event) => types.includes(event?.type)).length;
};

const tripMetric = (trip, focusId) => {
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  if (focus.metricKind === 'score') {
    const value = Number(trip?.[focus.field]);
    return Number.isFinite(value) ? value : null;
  }
  if (focus.direction === 'higher') {
    const score = Number(trip?.[focus.field] ?? trip?.overall_score ?? trip?.score);
    return Number.isFinite(score) ? score : null;
  }
  const distance = Number(trip?.distance_km) || 0;
  if (distance <= 0) return null;
  const count = measuredEventCount(trip, focus);
  if (count == null) return null;
  return (count / distance) * 100;
};

const cohortMetric = (trips, focusId) => {
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  if (focus.direction === 'higher' || focus.metricKind === 'score') {
    const rows = trips.map((trip) => ({
      value: tripMetric(trip, focusId),
      distance: Math.max(0, Number(trip.distance_km) || 0),
    })).filter((row) => Number.isFinite(row.value));
    const distance = rows.reduce((sum, row) => sum + row.distance, 0);
    if (!rows.length) return null;
    return distance > 0
      ? rows.reduce((sum, row) => sum + row.value * row.distance, 0) / distance
      : rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
  }
  const measured = trips.filter((trip) => tripMetric(trip, focusId) != null);
  const distance = measured.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  if (distance <= 0) return null;
  const count = measured.reduce((sum, trip) => sum + measuredEventCount(trip, focus), 0);
  return (count / distance) * 100;
};

const roundMetric = (value) => value == null || !Number.isFinite(Number(value))
  ? null
  : Math.round(Number(value) * 10) / 10;

export function buildCoachEvidenceAudit(allTrips = [], eligibleTrips = allTrips) {
  const allCompleted = (allTrips || []).filter((trip) => trip?.status === 'completed');
  const eligibleCompleted = (eligibleTrips || []).filter((trip) => trip?.status === 'completed');
  const trendEligible = excludePrivacyTouchedDaysFromTrends(eligibleCompleted);
  const scoreReady = trendEligible.filter((trip) => tripMetric(trip, 'consistency') != null);
  const eventReady = trendEligible.filter((trip) => (
    ['harsh_brakes', 'rapid_accel', 'sharp_turns', 'speeding', 'phone_use']
      .some((focusId) => tripMetric(trip, focusId) != null)
  ));
  const routeReady = trendEligible.filter((trip) => Boolean(routeKeyForTrip(trip)));
  const coachReadyIds = new Set([...scoreReady, ...eventReady].map((trip) => trip.id));
  return {
    totalCompleted: allCompleted.length,
    driverEligible: eligibleCompleted.length,
    trendEligible: trendEligible.length,
    scoreReady: scoreReady.length,
    eventReady: eventReady.length,
    routeReady: routeReady.length,
    excludedDriver: Math.max(0, allCompleted.length - eligibleCompleted.length),
    excludedPrivacy: Math.max(0, eligibleCompleted.length - trendEligible.length),
    missingCoachMeasurements: trendEligible.filter((trip) => !coachReadyIds.has(trip.id)).length,
    hasMinimumEvidence: scoreReady.length >= 2 || eventReady.length >= 2,
  };
}

const metricEvidenceCount = (trips, focusId) => (
  completedTrips(trips).filter((trip) => tripMetric(trip, focusId) != null).length
);

const contextLabel = (mode, signature) => {
  if (mode === 'all') return 'All eligible drives';
  if (mode === 'urban') return 'Urban and residential drives';
  if (mode === 'highway') return 'Highway drives';
  if (signature?.routeKey) return 'This repeated route';
  const road = signature?.roadType && signature.roadType !== 'mixed' ? `${signature.roadType} ` : '';
  return `Comparable ${road}${signature?.durationBucket || ''} drives`.replace(/\s+/g, ' ').trim();
};

const targetFor = (baseline, focus, difficulty) => {
  if (baseline == null) return null;
  const difficultyDefinition = DIFFICULTY_TARGETS[difficulty] || DIFFICULTY_TARGETS.standard;
  return focus.direction === 'higher'
    ? Math.min(100, baseline + difficultyDefinition.scoreGain)
    : Math.max(0, baseline * (1 - difficultyDefinition.reduction));
};

const makeId = (now) => `coach_${new Date(now).getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;


const routeLabelForTrips = (trips = []) => {
  const latest = trips[0] || {};
  const start = latest.start_location?.name || latest.start_address || latest.origin_name;
  const end = latest.end_location?.name || latest.end_address || latest.destination_name;
  if (start && end) return `${start} to ${end}`;
  const hour = new Date(latest.start_time || 0).getHours();
  if (hour >= 5 && hour < 11) return 'Morning repeated route';
  if (hour >= 15 && hour < 20) return 'Evening repeated route';
  return 'Repeated route';
};

export function buildCoachRouteOptions(trips = []) {
  const groups = new Map();
  completedTrips(trips).forEach((trip) => {
    const routeKey = routeKeyForTrip(trip);
    if (!routeKey) return;
    const group = groups.get(routeKey) || [];
    group.push(trip);
    groups.set(routeKey, group);
  });
  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([routeKey, group]) => ({
      routeKey,
      label: routeLabelForTrips(group),
      tripCount: group.length,
      lastTripId: group[0]?.id || null,
      tripIds: group.map((trip) => trip.id).filter(Boolean).slice(0, 8),
      signature: buildTripContextSignature(group[0]),
      averageScore: roundMetric(cohortMetric(group, 'consistency')),
      averageDistanceKm: roundMetric(group.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) / group.length),
    }))
    .sort((a, b) => b.tripCount - a.tripCount || (b.averageScore || 0) - (a.averageScore || 0));
}

export function buildCoachingEffectiveness(store = {}) {
  const history = Array.isArray(store?.history) ? store.history : [];
  const feedback = Array.isArray(store?.feedback) ? store.feedback : [];
  return Object.keys(COACH_FOCUS_CATALOG).reduce((result, focusId) => {
    const programs = history.filter((program) => program.focusId === focusId && program.result);
    const ratings = feedback.filter((item) => item.focusId === focusId);
    const graduated = programs.filter((program) => program.result?.graduated).length;
    const measured = programs.filter((program) => Number.isFinite(Number(program.result?.improvement)));
    result[focusId] = {
      programCount: programs.length,
      graduatedCount: graduated,
      graduationRate: programs.length ? Math.round((graduated / programs.length) * 100) : null,
      averageImprovement: measured.length
        ? roundMetric(measured.reduce((sum, program) => sum + Number(program.result.improvement), 0) / measured.length)
        : null,
      feedbackCount: ratings.length,
      feedbackScore: ratings.length
        ? roundMetric(ratings.reduce((sum, item) => sum + (COACH_FEEDBACK_OPTIONS[item.verdict]?.weight || 0), 0) / ratings.length)
        : null,
    };
    return result;
  }, {});
}

const adaptivePromptDelta = (store, focusId) => {
  const ratings = (store?.feedback || []).filter((item) => item.focusId === focusId).slice(0, 5);
  if (!ratings.length) return 0;
  const delta = ratings.reduce((sum, item) => sum + (COACH_FEEDBACK_OPTIONS[item.verdict]?.promptDelta || 0), 0);
  const average = delta / ratings.length;
  return Math.max(-2, Math.min(1, average < 0 ? Math.floor(average) : Math.round(average)));
};

export function recommendCoachDifficulty(focusId, store = {}) {
  const effectiveness = buildCoachingEffectiveness(store)[focusId] || {};
  const recent = (store.history || [])
    .filter((program) => (
      program.focusId === focusId &&
      Number(program.version) >= COACH_PROGRAM_VERSION &&
      ['completed', 'graduated'].includes(program.status) &&
      Number(program.result?.completedCount) >= Math.min(2, Number(program.targetTripCount) || 2)
    ))
    .slice(0, 2);
  if (effectiveness.feedbackScore != null && effectiveness.feedbackScore < -0.25) {
    return { difficulty: 'gentle', reason: 'Reduced because recent feedback suggests the prompts need more restraint.' };
  }
  if (recent.length >= 2 && recent.every((program) => program.result?.graduated)) {
    return { difficulty: 'intensive', reason: 'Raised because you graduated from the last two programs on this focus.' };
  }
  if (recent.length && recent.every((program) => !program.result?.graduated)) {
    return { difficulty: 'gentle', reason: 'Reduced to rebuild the habit after the last program missed its target.' };
  }
  return { difficulty: 'standard', reason: 'Balanced against your current evidence and coaching history.' };
}

export function recordCoachFeedback(store, { program = null, tripId = null, verdict = null, now = new Date() } = {}) {
  if (!program || !COACH_FEEDBACK_OPTIONS[verdict]) return normalizeCoachProgramStore(store);
  const feedback = [{
    id: `feedback_${new Date(now).getTime().toString(36)}`,
    programId: program.id,
    focusId: program.focusId,
    tripId,
    verdict,
    createdAt: new Date(now).toISOString(),
  }, ...(store?.feedback || []).filter((item) => !(item.programId === program.id && item.tripId === tripId))].slice(0, 100);
  return normalizeCoachProgramStore({ ...store, feedback });
}

export function buildPreTripBriefing(program, trips = []) {
  if (!program) return null;
  const focus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
  const matching = completedTrips(trips).filter((trip) => sameContext(trip, program.context));
  return {
    title: `${focus.label} briefing`,
    context: program.context?.label || 'Eligible drives',
    confidence: matching.length >= 5 ? 'strong' : matching.length >= 2 ? 'developing' : 'early',
    bullets: [
      focus.liveCue,
      `Road Sage will use at most ${program.promptBudget || 3} mission prompts; safety alerts remain separate.`,
      matching.length ? `Based on ${matching.length} comparable drive${matching.length === 1 ? '' : 's'}.` : 'The first eligible drive will strengthen this baseline.',
    ],
  };
}
export function resolveCoachFocusId(focusArea) {
  if (COACH_FOCUS_CATALOG[focusArea]) return focusArea;
  return FOCUS_ALIASES[String(focusArea || '').toLowerCase()] || 'consistency';
}

export function buildCoachRecommendations(coach = {}, trips = [], store = {}) {
  const ordered = [];
  const effectiveness = buildCoachingEffectiveness(store);
  const evidenceCount = (focusId) => metricEvidenceCount(trips, focusId);
  const add = (focusId, reason, evidence = null, priority = 'medium') => {
    if (!COACH_FOCUS_CATALOG[focusId] || ordered.some((item) => item.focusId === focusId)) return;
    if (evidenceCount(focusId) < 2) return;
    const learned = effectiveness[focusId] || {};
    let whyNow = 'Selected from your latest measured driving pattern.';
    if (learned.graduationRate != null && learned.graduationRate >= 60) {
      whyNow = `This focus has worked before: ${learned.graduationRate}% of completed programs graduated.`;
    } else if (learned.feedbackScore != null && learned.feedbackScore < -0.25) {
      whyNow = 'Recent feedback lowered this recommendation and will reduce its live-prompt intensity.';
      priority = priority === 'high' ? 'medium' : 'low';
    } else if (learned.programCount > 0) {
      whyNow = `Adjusted using ${learned.programCount} previous ${learned.programCount === 1 ? 'program' : 'programs'} on this focus.`;
    }
    ordered.push({ focusId, reason, evidence, priority, whyNow, effectiveness: learned, focus: COACH_FOCUS_CATALOG[focusId] });
  };
  const primary = resolveCoachFocusId(coach.focus_area);
  add(primary, coach.coach_brief?.why || COACH_FOCUS_CATALOG[primary].cue, coach.coach_brief?.confidence, 'high');
  (coach.risk_patterns || []).forEach((pattern) => {
    const focusId = resolveCoachFocusId(pattern.key);
    add(
      focusId,
      `${pattern.label} accounts for ${pattern.share_percent}% of recorded risk events.`,
      `${pattern.count} events`,
      pattern.share_percent >= 40 ? 'high' : 'medium'
    );
  });
  const recent = completedTrips(trips).slice(0, 10);
  const phoneTrips = recent.filter((trip) => ['medium', 'high'].includes(trip.phone_use_risk)).length;
  if (phoneTrips > 0) add('phone_use', `${phoneTrips} recent trip${phoneTrips === 1 ? '' : 's'} include measured phone-use risk.`, `${phoneTrips}/10 trips`, 'high');
  if (evidenceCount('consistency') >= 3) {
    add('consistency', 'No single risk event dominates, so repeat the setup from your strongest comparable drive.', `${evidenceCount('consistency')} scored trips`, 'low');
  }
  ['harsh_brakes', 'rapid_accel', 'sharp_turns', 'speeding', 'fatigue'].forEach((focusId) => {
    add(focusId, COACH_FOCUS_CATALOG[focusId].cue, null, 'low');
  });
  const rank = { high: 3, medium: 2, low: 1 };
  return ordered
    .map((item, index) => ({ ...item, originalRank: index }))
    .sort((a, b) => (rank[b.priority] - rank[a.priority]) || a.originalRank - b.originalRank)
    .slice(0, 6);
}

export function createCoachProgram({
  focusId = 'consistency',
  difficulty = 'standard',
  targetTripCount = 5,
  contextMode = 'comparable',
  routeKey = null,
  contextSignature = null,
  contextLabel: selectedContextLabel = null,
  store = {},
  trips = [],
  now = new Date(),
} = {}) {
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  const completed = completedTrips(trips);
  const routeTrip = routeKey ? completed.find((trip) => routeKeyForTrip(trip) === routeKey) : null;
  const signature = contextSignature || buildTripContextSignature(routeTrip || completed[0] || {});
  if (routeKey) signature.routeKey = routeKey;
  const context = {
    mode: ['all', 'urban', 'highway', 'comparable'].includes(contextMode) ? contextMode : 'comparable',
    signature,
  };
  let baselineTrips = completed
    .filter((trip) => sameContext(trip, context) && tripMetric(trip, focus.id) != null)
    .slice(0, 8);
  let usedFallbackBaseline = false;
  if (baselineTrips.length < 2) {
    baselineTrips = completed.filter((trip) => tripMetric(trip, focus.id) != null).slice(0, 8);
    usedFallbackBaseline = true;
  }
  const baselineMetric = roundMetric(cohortMetric(baselineTrips, focus.id));
  const adaptive = difficulty === 'adaptive' ? recommendCoachDifficulty(focus.id, store) : null;
  const requestedDifficulty = adaptive?.difficulty || difficulty;
  const safeDifficulty = DIFFICULTY_TARGETS[requestedDifficulty] ? requestedDifficulty : 'standard';
  const startedAt = new Date(now).toISOString();
  return {
    version: COACH_PROGRAM_VERSION,
    id: makeId(now),
    focusId: focus.id,
    status: 'active',
    difficulty: safeDifficulty,
    targetTripCount: [3, 5, 10].includes(Number(targetTripCount)) ? Number(targetTripCount) : 5,
    startedAt,
    updatedAt: startedAt,
    context: {
      ...context,
      label: selectedContextLabel || contextLabel(context.mode, signature),
      usedFallbackBaseline,
      routeKey: routeKey || signature.routeKey || null,
    },
    baseline: {
      metric: baselineMetric,
      tripCount: baselineTrips.length,
      tripIds: baselineTrips.map((trip) => trip.id).filter(Boolean),
    },
    targetMetric: roundMetric(targetFor(baselineMetric, focus, safeDifficulty)),
    promptBudget: Math.max(1, DIFFICULTY_TARGETS[safeDifficulty].promptBudget + adaptivePromptDelta(store, focus.id)),
    adaptiveReason: adaptive?.reason || null,
  };
}

export function buildCoachProgramProgress(program, trips = []) {
  if (!program) return null;
  const focus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
  const startedAt = asDateMs(program.startedAt);
  const eligible = completedTrips(trips)
    .filter((trip) => asDateMs(trip.start_time || trip.created_at) > startedAt)
    .filter((trip) => sameContext(trip, program.context))
    .sort((a, b) => asDateMs(a.start_time) - asDateMs(b.start_time));
  const measured = eligible.filter((trip) => tripMetric(trip, focus.id) != null);
  const currentMetric = roundMetric(cohortMetric(measured, focus.id));
  const baselineMetric = Number.isFinite(Number(program.baseline?.metric)) ? Number(program.baseline.metric) : null;
  const targetMetric = Number.isFinite(Number(program.targetMetric)) ? Number(program.targetMetric) : null;
  const improvement = currentMetric == null || baselineMetric == null
    ? null
    : focus.direction === 'higher'
      ? currentMetric - baselineMetric
      : baselineMetric <= 0
        ? 0
        : ((baselineMetric - currentMetric) / baselineMetric) * 100;
  const successes = measured.filter((trip) => {
    const value = tripMetric(trip, focus.id);
    if (value == null || targetMetric == null) return false;
    return focus.direction === 'higher' ? value >= targetMetric : value <= targetMetric;
  }).length;
  const latest = measured[measured.length - 1] || null;
  const latestMetric = latest ? roundMetric(tripMetric(latest, focus.id)) : null;
  const latestMetTarget = latestMetric != null && targetMetric != null
    ? focus.direction === 'higher' ? latestMetric >= targetMetric : latestMetric <= targetMetric
    : null;
  const goalCount = Math.max(1, Number(program.targetTripCount) || 5);
  const completedCount = Math.min(goalCount, measured.length);
  const readyToGraduate = measured.length >= goalCount && (
    targetMetric == null || currentMetric == null
      ? false
      : focus.direction === 'higher' ? currentMetric >= targetMetric : currentMetric <= targetMetric
  );
  return {
    focus,
    eligibleTrips: measured,
    completedCount,
    successfulTrips: successes,
    progressPercent: Math.min(100, Math.round((completedCount / goalCount) * 100)),
    currentMetric,
    baselineMetric,
    targetMetric,
    improvement: improvement == null ? null : roundMetric(improvement),
    improvementUnit: focus.direction === 'higher' ? 'points' : '%',
    readyToGraduate,
    remainingTrips: Math.max(0, goalCount - completedCount),
    confidence: measured.length >= 5 ? 'strong' : measured.length >= 2 ? 'developing' : 'early',
    latestReview: latest ? {
      tripId: latest.id,
      startTime: latest.start_time,
      metric: latestMetric,
    needsExtension: measured.length >= goalCount && !readyToGraduate,
    nextReviewIn: measured.length >= goalCount ? 1 : Math.max(1, goalCount - measured.length),
    trend: improvement == null ? 'learning' : improvement > 0 ? 'improving' : improvement < 0 ? 'declining' : 'steady',
      metTarget: latestMetTarget,
      score: Number.isFinite(Number(latest.score_overall)) ? Number(latest.score_overall) : null,
      eventCount: focus.direction === 'lower' ? measuredEventCount(latest, focus.id) : null,
      distanceKm: Number(latest.distance_km) || 0,
    } : null,
  };
}

export function finishCoachProgram(program, trips = [], status = 'completed', now = new Date()) {
  const progress = buildCoachProgramProgress(program, trips);
  return {
    ...program,
    status,
    updatedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(),
    result: progress ? {
      completedCount: progress.completedCount,
      currentMetric: progress.currentMetric,
      baselineMetric: progress.baselineMetric,
      targetMetric: progress.targetMetric,
      improvement: progress.improvement,
      improvementUnit: progress.improvementUnit,
      latestTripId: progress.latestReview?.tripId || null,
      graduated: status === 'graduated' || progress.readyToGraduate,
    } : null,
  };
}

export function buildGroundedCoachAnswer(question = '', {
  trips = [],
  program = null,
  progress = null,
  recommendations = [],
} = {}) {
  const normalizedQuestion = String(question || '').trim().toLowerCase();
  const recent = completedTrips(trips).slice(0, 5);
  const defaultEvidence = recent.slice(0, 3).map((trip) => ({
    tripId: trip.id || null,
    label: new Date(trip.start_time || trip.created_at).toLocaleDateString(),
  }));
  const primary = recommendations[0];
  const route = buildCoachRouteOptions(recent.length ? trips : [])[0] || null;
  let answer = primary
    ? `Your highest-value focus is ${primary.focus.label}: ${primary.reason}`
    : 'Road Sage needs more eligible drives before it can name a grounded coaching priority.';
  let inference = primary?.whyNow || 'This is a local coaching inference from recorded trip summaries.';
  let evidence = defaultEvidence;

  if (/progress|better|improv|target/.test(normalizedQuestion) && program && progress) {
    const focus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
    answer = progress.currentMetric == null
      ? `Your ${focus.label} program is still building its first post-start measurement.`
      : `Your current ${focus.metricLabel} is ${formatCoachMetric(progress.currentMetric, program.focusId)}, versus ${formatCoachMetric(progress.baselineMetric, program.focusId)} at baseline and a ${formatCoachMetric(progress.targetMetric, program.focusId)} target.`;
    inference = progress.trend === 'improving'
      ? 'The comparable-drive cohort is moving in the intended direction.'
      : 'The current cohort does not yet show a reliable improvement; one trip cannot establish the trend.';
    evidence = (progress.eligibleTrips || []).slice(-3).reverse().map((trip) => ({
      tripId: trip.id || null,
      label: new Date(trip.start_time || trip.created_at).toLocaleDateString(),
    }));
  } else if (/route|where|section|road/.test(normalizedQuestion) && route) {
    answer = `${route.label} is your best-sampled repeated route with ${route.tripCount} drives and an average score of ${route.averageScore ?? 'not yet scored'}.`;
    inference = 'Route matching uses similar start and end areas; section events describe where detections repeat, not why the road caused them.';
    evidence = route.tripIds.slice(0, 3).map((tripId, index) => ({ tripId, label: `Matched route drive ${index + 1}` }));
  } else if (/why|recommend|focus|change/.test(normalizedQuestion) && primary) {
    answer = `${primary.focus.label} is recommended because ${primary.reason}`;
    inference = primary.whyNow || 'The recommendation is ranked from recent risk share and prior coaching response.';
  } else if (/fatigue|tired|break|alert/.test(normalizedQuestion)) {
    const fatigueRows = recent.filter((trip) => Number.isFinite(Number(trip.fatigue_risk_score)));
    answer = fatigueRows.length
      ? `Recent fatigue-risk evidence is available on ${fatigueRows.length} of your last ${recent.length} eligible drives. Use the learned fatigue window as a planning cue, not a medical judgment.`
      : 'No recent trip has enough fatigue-risk evidence for a grounded personal conclusion.';
    inference = 'Fatigue signals are sensor-based driving estimates and cannot determine whether you are medically fit to drive.';
    evidence = fatigueRows.slice(0, 3).map((trip) => ({ tripId: trip.id || null, label: new Date(trip.start_time).toLocaleDateString() }));
  }

  return {
    question: String(question || '').trim(),
    answer,
    inference,
    evidence: evidence.filter((item) => item.tripId),
    limitation: 'Uses only local Road Sage trip evidence. It does not infer road cause, fault, impairment, or collision risk.',
  };
}

export function repairCoachProgramEvidence(program, trips = []) {
  if (!program || Number(program.version) >= COACH_PROGRAM_VERSION) return program;
  const focus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
  const completed = completedTrips(trips);
  let baselineTrips = completed
    .filter((trip) => sameContext(trip, program.context) && tripMetric(trip, focus.id) != null)
    .slice(0, 8);
  let usedFallbackBaseline = false;
  if (baselineTrips.length < 2) {
    baselineTrips = completed.filter((trip) => tripMetric(trip, focus.id) != null).slice(0, 8);
    usedFallbackBaseline = true;
  }
  const baselineMetric = roundMetric(cohortMetric(baselineTrips, focus.id));
  return {
    ...program,
    version: COACH_PROGRAM_VERSION,
    context: { ...program.context, usedFallbackBaseline },
    baseline: {
      metric: baselineMetric,
      tripCount: baselineTrips.length,
      tripIds: baselineTrips.map((trip) => trip.id).filter(Boolean),
    },
    targetMetric: roundMetric(targetFor(baselineMetric, focus, program.difficulty)),
    evidenceRepairedAt: new Date().toISOString(),
  };
}

export function emptyCoachProgramStore() {
  return { version: COACH_PROGRAM_VERSION, active: null, history: [], feedback: [], lastResult: null };
}

export function normalizeCoachProgramStore(value) {
  if (!value || typeof value !== 'object') return emptyCoachProgramStore();
  const active = value.active && typeof value.active === 'object'
    ? value.active.status === 'paused'
      ? { ...value.active, status: 'active' }
      : value.active
    : null;
  return {
    version: COACH_PROGRAM_VERSION,
    active,
    history: Array.isArray(value.history) ? value.history.slice(0, 20) : [],
    feedback: Array.isArray(value.feedback) ? value.feedback.slice(0, 100) : [],
    lastResult: value.lastResult && typeof value.lastResult === 'object' ? value.lastResult : null,
  };
}

export function reconcileCoachProgramStore(store, trips = [], now = new Date()) {
  const normalized = normalizeCoachProgramStore(store);
  if (!normalized.active || normalized.active.status !== 'active') return normalized;
  const repairedActive = repairCoachProgramEvidence(normalized.active, trips);
  const repairedStore = repairedActive === normalized.active
    ? normalized
    : { ...normalized, active: repairedActive };
  const progress = buildCoachProgramProgress(repairedActive, trips);
  if (!progress?.readyToGraduate) return repairedStore;
  const graduated = finishCoachProgram(repairedActive, trips, 'graduated', now);
  return normalizeCoachProgramStore({
    ...repairedStore,
    active: null,
    lastResult: graduated,
    history: [graduated, ...repairedStore.history],
  });
}

export function buildCoachSegmentInsights(trips = [], routeKey = null, focusId = 'consistency') {
  const matching = completedTrips(trips).filter((trip) => !routeKey || routeKeyForTrip(trip) === routeKey);
  const allowedTypes = eventTypesForFocus[focusId] || Object.values(eventTypesForFocus).flat();
  const bins = [
    { id: 'early', label: 'Early route', min: 0, max: 0.34, eventCount: 0, tripIds: new Set() },
    { id: 'middle', label: 'Middle route', min: 0.34, max: 0.67, eventCount: 0, tripIds: new Set() },
    { id: 'late', label: 'Late route', min: 0.67, max: 1.01, eventCount: 0, tripIds: new Set() },
  ];
  let locatedEvents = 0;
  matching.forEach((trip) => {
    const events = [
      ...(Array.isArray(trip.driving_events) ? trip.driving_events : []),
      ...(focusId === 'phone_use' && Array.isArray(trip.phone_use_events) ? trip.phone_use_events : []),
    ];
    events.filter((event) => allowedTypes.includes(event?.type)).forEach((event) => {
      const index = Number(event.route_point_index ?? event.point_index ?? event.start_index);
      const pointCount = Array.isArray(trip.route_points) ? trip.route_points.length : 0;
      const rawProgress = Number(event.route_progress ?? event.progress);
      const progress = Number.isFinite(rawProgress)
        ? Math.max(0, Math.min(1, rawProgress > 1 ? rawProgress / 100 : rawProgress))
        : Number.isFinite(index) && pointCount > 1 ? Math.max(0, Math.min(1, index / (pointCount - 1))) : null;
      if (progress == null) return;
      const bin = bins.find((item) => progress >= item.min && progress < item.max);
      if (!bin) return;
      locatedEvents += 1;
      bin.eventCount += 1;
      if (trip.id) bin.tripIds.add(trip.id);
    });
  });
  const sections = bins.map((bin) => ({
    id: bin.id,
    label: bin.label,
    eventCount: bin.eventCount,
    affectedTrips: bin.tripIds.size,
    repeatRate: matching.length ? Math.round((bin.tripIds.size / matching.length) * 100) : 0,
  })).sort((a, b) => b.eventCount - a.eventCount);
  return {
    tripCount: matching.length,
    locatedEvents,
    evidenceLevel: locatedEvents >= 6 ? 'strong' : locatedEvents >= 2 ? 'developing' : 'limited',
    sections,
    strongestSection: sections.find((section) => section.eventCount > 0) || null,
    explanation: locatedEvents
      ? 'Sections use event positions within matched route replays; they do not infer a road cause.'
      : 'Detailed route-event positions are needed before Road Sage can compare exact sections.',
  };
}

export async function loadCoachProgramStore() {
  return normalizeCoachProgramStore(await getJson(COACH_PROGRAM_STORAGE_KEY, emptyCoachProgramStore()));
}

export async function saveCoachProgramStore(value) {
  const normalized = normalizeCoachProgramStore(value);
  await setJson(COACH_PROGRAM_STORAGE_KEY, normalized);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COACH_PROGRAM_CHANGED_EVENT, { detail: normalized }));
  }
  return normalized;
}

export function difficultyLabel(difficulty) {
  return (DIFFICULTY_TARGETS[difficulty] || DIFFICULTY_TARGETS.standard).label;
}

export function formatCoachMetric(value, focusId) {
  if (value == null || !Number.isFinite(Number(value))) return 'Not measured';
  const focus = COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency;
  const rounded = roundMetric(value);
  if (focus.metricKind === 'score') return `${rounded}/100`;
  return focus.direction === 'higher' ? `${rounded}/100` : `${rounded} / 100 km`;
}
