// @ts-check
import { tripTouchesPrivacyZoneForTrend } from '@/lib/privateTripMode';
import { routeKeyForTrip } from '@/lib/commuteMatching';
import { getTripComponentScore } from '@/lib/tripEngine';

const DAY_MS = 86400000;
const LEDGER_KEY = 'drivesense_driver_progression_ledger_v1';
const TIER_POINTS = { bronze: 100, silver: 180, gold: 280, platinum: 420, master: 650 };

const emptyLedger = () => ({
  version: 2,
  mastery: {},
  missions: {},
  seasons: {},
  weeklyPlans: {},
  xpTransactions: [],
  celebrations: [],
});

const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const componentValue = (trip, componentKey, fallbackFields = []) => {
  const component = getTripComponentScore(trip, componentKey);
  if (component.value != null && Number.isFinite(Number(component.value))) return Number(component.value);
  // A typed component explicitly marked unavailable must stay unavailable.
  if (trip?.component_scores?.[componentKey]) return null;
  const fallbackField = fallbackFields.find((field) => trip?.[field] != null && trip?.[field] !== '');
  const fallback = fallbackField ? Number(trip[fallbackField]) : NaN;
  return Number.isFinite(fallback) ? fallback : null;
};

const normalizedTripDuration = (trip) => {
  const stored = Number(trip?.duration_seconds);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const startMs = new Date(trip?.start_time || 0).getTime();
  const endMs = new Date(trip?.end_time || 0).getTime();
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? Math.round((endMs - startMs) / 1000)
    : null;
};

const normalizedTripDistance = (trip) => {
  const storedKm = Number(trip?.distance_km);
  if (Number.isFinite(storedKm) && storedKm >= 0) return storedKm;
  const storedM = Number(trip?.distance_m ?? trip?.private_trip_summary?.distance_m);
  return Number.isFinite(storedM) && storedM >= 0 ? storedM / 1000 : 0;
};

const normalizeProgressionTrip = (trip) => {
  const scoreOverall = componentValue(trip, 'overall', ['score_overall', 'overall_score', 'score']);
  const scoreSafety = componentValue(trip, 'safety', ['score_safety', 'safety_score']);
  const scoreSmoothness = componentValue(trip, 'smoothness', ['score_smoothness', 'smoothness_score']);
  const brakingEfficiency = componentValue(trip, 'braking_efficiency', ['braking_efficiency_score']);
  const corneringConsistency = componentValue(trip, 'cornering_consistency', ['cornering_consistency_score']);
  const speedCompliance = componentValue(trip, 'speed_limit_compliance', ['overall_compliance_score', 'speed_compliance_score']);
  const phoneUse = componentValue(trip, 'phone_use', ['phone_use_score']);
  const durationSeconds = normalizedTripDuration(trip);
  return {
    ...trip,
    distance_km: normalizedTripDistance(trip),
    ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}),
    ...(scoreOverall != null ? { score_overall: scoreOverall } : {}),
    ...(scoreSafety != null ? { score_safety: scoreSafety } : {}),
    ...(scoreSmoothness != null ? { score_smoothness: scoreSmoothness } : {}),
    ...(brakingEfficiency != null ? { braking_efficiency_score: brakingEfficiency } : {}),
    ...(corneringConsistency != null ? { cornering_consistency_score: corneringConsistency } : {}),
    ...(speedCompliance != null ? { overall_compliance_score: speedCompliance } : {}),
    ...(phoneUse != null ? { phone_use_score: phoneUse, phone_use_score_available: true } : {}),
  };
};

const round = (value, digits = 0) => {
  const scale = 10 ** digits;
  return Math.round(number(value) * scale) / scale;
};

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, number(value)));

const mean = (values = []) => {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};

const weightedMean = (trips = [], getter = (trip) => trip.score_overall) => {
  let weighted = 0;
  let weight = 0;
  trips.forEach((trip) => {
    const value = Number(getter(trip));
    if (!Number.isFinite(value)) return;
    const tripWeight = Math.max(0.5, number(trip.distance_km, 0));
    weighted += value * tripWeight;
    weight += tripWeight;
  });
  return weight > 0 ? weighted / weight : null;
};

const tripTime = (trip) => new Date(trip.start_time || trip.created_at || 0).getTime();
const totalDistance = (trips) => trips.reduce((sum, trip) => sum + Math.max(0, number(trip.distance_km)), 0);
const totalFor = (trips, field) => trips.reduce((sum, trip) => sum + Math.max(0, number(trip[field])), 0);

const severeEventCount = (trip) => {
  const explicit = Array.isArray(trip.driving_events)
    ? trip.driving_events.filter((event) => ['high', 'severe', 'emergency'].includes(String(event?.severity || '').toLowerCase())).length
    : 0;
  return explicit + number(trip.emergency_heavy_braking_count) + number(trip.phone_use_high_confidence_count);
};

const riskEventCount = (trip) => (
  number(trip.harsh_brakes_count) +
  number(trip.rapid_accel_count) +
  number(trip.sharp_turns_count) +
  number(trip.speeding_events_count)
);

const isCleanTrip = (trip) => riskEventCount(trip) === 0 && severeEventCount(trip) === 0;

const shortHash = (value = '') => {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const roadContextForTrip = (trip) => {
  const explicit = String(trip.dominant_road_type || trip.road_type || '').toLowerCase();
  if (explicit.includes('highway') || explicit.includes('motorway')) return 'highway';
  if (explicit.includes('residential')) return 'residential';
  return 'city';
};

const timeContextForTrip = (trip) => {
  if (trip.night_driving) return 'night';
  const date = new Date(trip.start_time || trip.created_at || 0);
  const hour = date.getHours();
  const weekday = date.getDay() >= 1 && date.getDay() <= 5;
  if (weekday && ((hour >= 7 && hour < 10) || (hour >= 15 && hour < 19))) return 'rush_hour';
  return 'off_peak';
};

const contextLabel = (id) => ({
  highway: 'Highway control', city: 'City composure', residential: 'Residential precision',
  night: 'Naturally occurring night trips', rush_hour: 'Rush-hour composure', off_peak: 'Off-peak consistency',
}[id] || 'Comparable conditions');

function scoreStdDev(trips = []) {
  const values = trips.map((trip) => Number(trip.score_overall)).filter(Number.isFinite);
  if (values.length < 2) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length);
}

function averageField(trips = [], fields = []) {
  return mean(trips.map((trip) => {
    const field = fields.find((candidate) => trip[candidate] != null && trip[candidate] !== '');
    return field ? Number(trip[field]) : NaN;
  }));
}

export function progressionStats(trips = []) {
  const distanceKm = totalDistance(trips);
  const eventTotals = {
    braking: totalFor(trips, 'harsh_brakes_count'),
    acceleration: totalFor(trips, 'rapid_accel_count'),
    cornering: totalFor(trips, 'sharp_turns_count'),
    speed: totalFor(trips, 'speeding_events_count'),
  };
  const rate = (count) => distanceKm > 0 ? (count / distanceKm) * 100 : null;
  const phoneMeasured = trips.filter((trip) => trip.phone_use_score_available === true);
  const phoneClean = phoneMeasured.filter((trip) => trip.phone_use_risk === 'none');
  const cleanTrips = trips.filter(isCleanTrip);

  return {
    trips,
    tripCount: trips.length,
    distanceKm,
    avgScore: weightedMean(trips),
    safetyScore: weightedMean(trips, (trip) => trip.score_safety ?? trip.safety_score),
    smoothnessScore: weightedMean(trips, (trip) => trip.score_smoothness ?? trip.smoothness_score),
    brakingEfficiency: averageField(trips, ['braking_efficiency_score']),
    corneringConsistency: averageField(trips, ['cornering_consistency_score']),
    speedCompliance: averageField(trips, ['overall_compliance_score', 'speed_compliance_score']),
    eventTotals,
    eventRates: {
      braking: rate(eventTotals.braking),
      acceleration: rate(eventTotals.acceleration),
      cornering: rate(eventTotals.cornering),
      speed: rate(eventTotals.speed),
      all: rate(Object.values(eventTotals).reduce((sum, count) => sum + count, 0)),
    },
    cleanRate: trips.length ? (cleanTrips.length / trips.length) * 100 : null,
    cleanTrips: cleanTrips.length,
    severeEvents: trips.reduce((sum, trip) => sum + severeEventCount(trip), 0),
    scoreStdDev: scoreStdDev(trips),
    phoneMeasured: phoneMeasured.length,
    phoneCoverage: trips.length ? (phoneMeasured.length / trips.length) * 100 : null,
    phoneCleanRate: phoneMeasured.length ? (phoneClean.length / phoneMeasured.length) * 100 : null,
    specializedCoverage: {
      braking: trips.filter((trip) => trip.braking_efficiency_score != null).length,
      acceleration: trips.filter((trip) => (trip.score_smoothness ?? trip.smoothness_score) != null).length,
      cornering: trips.filter((trip) => trip.cornering_consistency_score != null).length,
      speed: trips.filter((trip) => (trip.overall_compliance_score ?? trip.speed_compliance_score) != null).length,
      consistency: trips.filter((trip) => trip.score_overall != null).length,
      focus: phoneMeasured.length,
    },
  };
}

const requirement = (id, label, value, target, direction = 'min', unit = '') => {
  const available = value != null && Number.isFinite(Number(value));
  const numericValue = available ? Number(value) : null;
  const met = available && (direction === 'max' ? numericValue <= target : numericValue >= target);
  let progress = 0;
  if (available) {
    if (met) progress = 100;
    else if (direction === 'min') progress = target > 0 ? (numericValue / target) * 100 : 0;
    else progress = target > 0 ? (target / Math.max(target, numericValue)) * 100 : 0;
  }
  return { id, label, value: numericValue, target, direction, unit, available, met, progress: clamp(progress) };
};

const TIER_SPECS = [
  { id: 'bronze', label: 'Bronze', trips: 5, km: 50, score: 74, rate: 5, clean: 45 },
  { id: 'silver', label: 'Silver', trips: 10, km: 120, score: 81, rate: 3, clean: 60 },
  { id: 'gold', label: 'Gold', trips: 15, km: 250, score: 87, rate: 1.7, clean: 72 },
  { id: 'platinum', label: 'Platinum', trips: 25, km: 500, score: 92, rate: 0.9, clean: 82 },
  { id: 'master', label: 'Master', trips: 40, km: 900, score: 95, rate: 0.45, clean: 90 },
];

const TRACK_DEFINITIONS = [
  {
    id: 'braking', label: 'Braking Control', icon: 'braking', accent: 'rose',
    description: 'Progressive braking, low harsh-brake frequency, and repeatable control.',
    metric: (stats) => stats.brakingEfficiency ?? stats.safetyScore,
    rate: (stats) => stats.eventRates.braking,
    metricLabel: 'braking quality',
  },
  {
    id: 'acceleration', label: 'Acceleration Control', icon: 'acceleration', accent: 'amber',
    description: 'Smooth starts and controlled power delivery across repeated trips.',
    metric: (stats) => stats.smoothnessScore,
    rate: (stats) => stats.eventRates.acceleration,
    metricLabel: 'smoothness score',
  },
  {
    id: 'cornering', label: 'Cornering Precision', icon: 'cornering', accent: 'violet',
    description: 'Stable cornering with few sharp-turn events and strong lateral control.',
    metric: (stats) => stats.corneringConsistency ?? stats.smoothnessScore,
    rate: (stats) => stats.eventRates.cornering,
    metricLabel: 'cornering quality',
  },
  {
    id: 'speed', label: 'Speed Discipline', icon: 'speed', accent: 'blue',
    description: 'Reliable speed compliance across enough measured distance.',
    metric: (stats) => stats.speedCompliance ?? stats.safetyScore,
    rate: (stats) => stats.eventRates.speed,
    metricLabel: 'speed discipline',
  },
  {
    id: 'consistency', label: 'Consistency', icon: 'consistency', accent: 'emerald',
    description: 'Strong scores with low variation and a high share of clean trips.',
    metric: (stats) => stats.avgScore,
    rate: (stats) => stats.eventRates.all,
    metricLabel: 'average score',
    requirements: (stats, tier) => [
      requirement('trips', 'Qualifying trips', stats.tripCount, tier.trips, 'min', 'trips'),
      requirement('distance', 'Measured distance', round(stats.distanceKm, 1), tier.km, 'min', 'km'),
      requirement('score', 'Distance-weighted score', round(stats.avgScore, 1), tier.score, 'min', 'pts'),
      requirement('clean', 'Clean-trip share', round(stats.cleanRate, 1), tier.clean, 'min', '%'),
      requirement('variation', 'Score variation', round(stats.scoreStdDev, 1), Math.max(3, 11 - TIER_SPECS.indexOf(tier) * 2), 'max', 'pts'),
    ],
  },
  {
    id: 'focus', label: 'Driver Focus', icon: 'focus', accent: 'cyan',
    description: 'Usage Access-verified trips without confirmed phone interaction.',
    metric: (stats) => stats.phoneCleanRate,
    rate: () => null,
    metricLabel: 'distraction-free rate',
    requirements: (stats, tier) => {
      const tierIndex = TIER_SPECS.indexOf(tier);
      return [
        requirement('measured', 'Usage Access-measured trips', stats.phoneMeasured, [3, 8, 15, 25, 40][tierIndex], 'min', 'trips'),
        requirement('coverage', 'Measurement coverage', round(stats.phoneCoverage, 1), [50, 65, 75, 85, 90][tierIndex], 'min', '%'),
        requirement('clean', 'Distraction-free measured trips', round(stats.phoneCleanRate, 1), [90, 95, 98, 99, 100][tierIndex], 'min', '%'),
        requirement('severe', 'High-confidence phone events', stats.trips.reduce((sum, trip) => sum + number(trip.phone_use_high_confidence_count), 0), tierIndex < 2 ? 1 : 0, 'max', 'events'),
      ];
    },
  },
];

function defaultTrackRequirements(stats, tier, definition) {
  return [
    requirement('trips', 'Qualifying trips', stats.tripCount, tier.trips, 'min', 'trips'),
    requirement('distance', 'Measured distance', round(stats.distanceKm, 1), tier.km, 'min', 'km'),
    requirement('score', definition.metricLabel, round(definition.metric(stats), 1), tier.score, 'min', 'pts'),
    requirement('rate', `${definition.label} events`, round(definition.rate(stats), 2), tier.rate, 'max', '/100 km'),
    requirement('severe', 'Severe events', stats.severeEvents, TIER_SPECS.indexOf(tier) < 2 ? 2 : 0, 'max', 'events'),
  ];
}

function requirementsProgress(requirements) {
  if (!requirements.length) return 0;
  const progress = requirements.reduce((sum, item) => sum + item.progress, 0) / requirements.length;
  return requirements.every((item) => item.met) ? 100 : Math.min(99, round(progress));
}

function scoreForTrack(definition, stats) {
  if (definition.id === 'focus') return stats.phoneMeasured > 0 ? round(stats.phoneCleanRate) : null;
  if (definition.id === 'consistency') {
    if (stats.avgScore == null) return null;
    const variationPenalty = stats.scoreStdDev == null ? 8 : Math.max(0, stats.scoreStdDev - 3) * 1.5;
    return round(clamp(stats.avgScore - variationPenalty));
  }
  const quality = definition.metric(stats);
  if (quality == null) return null;
  const rate = definition.rate(stats);
  const ratePenalty = rate == null ? 0 : Math.min(35, rate * 4);
  return round(clamp(quality - ratePenalty));
}

function trendFor(current, previous) {
  if (current == null || previous == null) return { direction: 'developing', delta: null, label: 'Building baseline' };
  const delta = round(current - previous);
  if (delta >= 3) return { direction: 'improving', delta, label: `+${delta} improving` };
  if (delta <= -3) return { direction: 'declining', delta, label: `${delta} declining` };
  return { direction: 'stable', delta, label: 'Stable' };
}

function buildMasteryTracks(allStats, recentStats, previousStats, ledger = {}) {
  return TRACK_DEFINITIONS.map((definition) => {
    const currentScore = scoreForTrack(definition, recentStats);
    const previousScore = scoreForTrack(definition, previousStats);
    const tiers = TIER_SPECS.map((tier) => {
      const requirements = definition.requirements
        ? definition.requirements(allStats, tier)
        : defaultTrackRequirements(allStats, tier, definition);
      const ledgerKey = `${definition.id}:${tier.id}`;
      const achievedNow = requirements.every((item) => item.met);
      const earnedAt = ledger.mastery?.[ledgerKey] || null;
      return {
        ...tier,
        ledgerKey,
        requirements,
        achievedNow,
        unlocked: achievedNow || Boolean(earnedAt),
        earnedAt,
        progress: requirementsProgress(requirements),
        points: TIER_POINTS[tier.id],
      };
    });
    const unlocked = tiers.filter((tier) => tier.unlocked);
    const currentTier = unlocked.at(-1) || null;
    const nextTier = tiers.find((tier) => !tier.unlocked) || null;
    const measuredTrips = recentStats.specializedCoverage[definition.id] || 0;
    const fallbackUsed = measuredTrips < recentStats.tripCount && definition.id !== 'consistency';
    const confidenceLevel = measuredTrips >= 15 && recentStats.distanceKm >= 200
      ? 'Strong'
      : measuredTrips >= 6 && recentStats.distanceKm >= 75 ? 'Moderate' : measuredTrips > 0 ? 'Developing' : 'Unavailable';
    return {
      ...definition,
      score: currentScore,
      trend: trendFor(currentScore, previousScore),
      tiers,
      currentTier,
      nextTier,
      progress: nextTier?.progress ?? 100,
      evidence: {
        confidence: confidenceLevel,
        measuredTrips,
        totalTrips: recentStats.tripCount,
        distanceKm: round(recentStats.distanceKm, 1),
        fallbackUsed,
        source: definition.id === 'focus' ? 'Android Usage Access' : fallbackUsed ? 'Specialized metric plus score fallback' : 'Specialized trip metric',
      },
    };
  });
}

function weekBounds(nowMs) {
  const now = new Date(nowMs);
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day);
  return { startMs: start.getTime(), endMs: start.getTime() + 7 * DAY_MS - 1 };
}

function missionFromRequirements({ id, title, description, difficulty, category, deadline, requirements, reward }) {
  const qualified = requirements.filter((item) => ['trips', 'distance', 'measured'].includes(item.id)).every((item) => item.met);
  const completed = qualified && requirements.every((item) => item.met);
  const progress = requirementsProgress(requirements);
  const failedRequirement = requirements.find((item) => item.available && !item.met && !['trips', 'distance', 'measured'].includes(item.id));
  return {
    id, title, description, difficulty, category, deadline, requirements, reward,
    qualified, completed, progress,
    status: completed ? 'complete' : qualified && failedRequirement ? 'at_risk' : qualified ? 'on_track' : 'building_evidence',
    nextAction: requirements.filter((item) => !item.met).sort((a, b) => a.progress - b.progress)[0]?.label || 'Mission complete',
  };
}

function consecutiveQualityStreak(trips, targetScore) {
  let streak = 0;
  for (const trip of trips) {
    if (number(trip.score_overall) < targetScore || severeEventCount(trip) > 0 || riskEventCount(trip) > 1) break;
    streak += 1;
  }
  return streak;
}

function routeMissionData(trips, preferredRouteId = null) {
  const groups = new Map();
  trips.forEach((trip) => {
    const key = routeKeyForTrip(trip);
    if (!key) return;
    const id = shortHash(key);
    const group = groups.get(id) || [];
    group.push(trip);
    groups.set(id, group);
  });
  const candidates = [...groups.entries()]
    .filter(([, group]) => group.length >= 4)
    .sort((a, b) => b[1].length - a[1].length || totalDistance(b[1]) - totalDistance(a[1]));
  const selected = preferredRouteId ? candidates.find(([id]) => id === preferredRouteId) : candidates[0];
  if (!selected) return null;
  return { id: selected[0], trips: selected[1] };
}

function dominantComparableContext(trips, preferredContextId = null) {
  const counts = new Map();
  trips.forEach((trip) => {
    [roadContextForTrip(trip), timeContextForTrip(trip)].forEach((context) => counts.set(context, (counts.get(context) || 0) + 1));
  });
  if (preferredContextId && (counts.get(preferredContextId) || 0) >= 3) return preferredContextId;
  return [...counts.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function tripsForContext(trips, contextId) {
  if (!contextId) return [];
  return trips.filter((trip) => roadContextForTrip(trip) === contextId || timeContextForTrip(trip) === contextId);
}

function buildMissions(eligible, tracks, nowMs, storedPlan = null) {
  const { startMs, endMs } = weekBounds(nowMs);
  const weekTrips = eligible.filter((trip) => tripTime(trip) >= startMs && tripTime(trip) <= nowMs);
  const baselineTrips = eligible.filter((trip) => tripTime(trip) < startMs && tripTime(trip) >= startMs - 28 * DAY_MS);
  // Aggregate scores and event totals remain useful after privacy masking, but
  // route identity and inferred location context must not use privacy-touched trips.
  const contextWeekTrips = weekTrips.filter((trip) => !tripTouchesPrivacyZoneForTrend(trip));
  const contextBaselineTrips = baselineTrips.filter((trip) => !tripTouchesPrivacyZoneForTrend(trip));
  const week = progressionStats(weekTrips);
  const baseline = progressionStats(baselineTrips);
  const deadline = new Date(endMs).toISOString();
  const weekKey = new Date(startMs).toISOString().slice(0, 10);
  const weakestCandidate = [...tracks].filter((track) => track.score != null).sort((a, b) => a.score - b.score)[0] || tracks[0];
  const weakest = tracks.find((track) => track.id === storedPlan?.primaryTrackId) || weakestCandidate;
  const riskKey = ['braking', 'acceleration', 'cornering', 'speed'].includes(weakest.id) ? weakest.id : 'all';
  const baselineRate = baseline.eventRates[riskKey];
  const currentRate = week.eventRates[riskKey];
  const hasBaseline = baseline.tripCount >= 5 && baseline.distanceKm >= 75;

  const primaryRequirements = hasBaseline
    ? [
        requirement('trips', 'Qualifying trips this week', week.tripCount, 5, 'min', 'trips'),
        requirement('distance', 'Measured distance this week', round(week.distanceKm, 1), 75, 'min', 'km'),
        requirement('rate', `${weakest.label} event rate`, round(currentRate, 2), round(Math.max(0.25, baselineRate * 0.8), 2), 'max', '/100 km'),
        requirement('severe', 'Severe events', week.severeEvents, 0, 'max', 'events'),
      ]
    : [
        requirement('trips', 'Baseline trips', Math.min(5, baseline.tripCount + week.tripCount), 5, 'min', 'trips'),
        requirement('distance', 'Baseline distance', round(baseline.distanceKm + week.distanceKm, 1), 75, 'min', 'km'),
        requirement('score', 'Trips with a usable score', [...baselineTrips, ...weekTrips].filter((trip) => Number.isFinite(Number(trip.score_overall))).length, 5, 'min', 'trips'),
      ];

  const scoreTarget = clamp(round(Math.max(85, (baseline.avgScore ?? 82) + 2)), 80, 94);
  const streakTarget = clamp(round(Math.max(84, (baseline.avgScore ?? 82) + 1)), 80, 92);
  const streak = consecutiveQualityStreak(eligible, streakTarget);
  const routeData = routeMissionData(contextBaselineTrips, storedPlan?.routeId);
  const contextId = dominantComparableContext(contextBaselineTrips, storedPlan?.contextId);
  const candidates = [
    missionFromRequirements({
      id: `${weekKey}:primary:${weakest.id}`,
      title: hasBaseline ? `Raise ${weakest.label}` : 'Build a trustworthy baseline',
      description: hasBaseline
        ? `Beat your previous 28-day ${weakest.label.toLowerCase()} rate by 20% without a severe event.`
        : 'Collect enough quality evidence before Road Sage sets harder personal targets.',
      difficulty: hasBaseline ? 'Stretch' : 'Foundation', category: weakest.label, deadline, reward: hasBaseline ? 160 : 80,
      requirements: primaryRequirements,
    }),
    missionFromRequirements({
      id: `${weekKey}:balanced`, title: 'Balanced week', category: 'All-round control', difficulty: 'Advanced', deadline, reward: 180,
      description: 'Pair a strong distance-weighted score with a low event rate across a meaningful week.',
      requirements: [
        requirement('trips', 'Qualifying trips this week', week.tripCount, 5, 'min', 'trips'),
        requirement('distance', 'Measured distance this week', round(week.distanceKm, 1), 75, 'min', 'km'),
        requirement('score', 'Distance-weighted score', round(week.avgScore, 1), scoreTarget, 'min', 'pts'),
        requirement('rate', 'All risk events', round(week.eventRates.all, 2), Math.max(2, round((baseline.eventRates.all ?? 4) * 0.85, 1)), 'max', '/100 km'),
        requirement('severe', 'Severe events', week.severeEvents, 0, 'max', 'events'),
      ],
    }),
    missionFromRequirements({
      id: `${weekKey}:precision-streak`, title: 'Precision streak', category: 'Consistency', difficulty: 'Expert', deadline, reward: 220,
      description: `Hold ${streakTarget}+ with no severe event and no more than one risk event per trip for six consecutive trips.`,
      requirements: [
        requirement('trips', 'Consecutive precision trips', streak, 6, 'min', 'trips'),
        requirement('score', 'Required score on every trip', streakTarget, streakTarget, 'min', 'pts'),
      ],
    }),
  ];

  if (week.phoneMeasured >= 2 || baseline.phoneMeasured >= 3) {
    candidates.push(missionFromRequirements({
      id: `${weekKey}:focus`, title: 'Verified focus', category: 'Driver Focus', difficulty: 'Expert', deadline, reward: 220,
      description: 'Complete a fully measured, distraction-free set of trips with strong Usage Access coverage.',
      requirements: [
        requirement('measured', 'Usage Access-measured trips', week.phoneMeasured, 6, 'min', 'trips'),
        requirement('coverage', 'Measurement coverage', round(week.phoneCoverage, 1), 85, 'min', '%'),
        requirement('clean', 'Distraction-free measured trips', round(week.phoneCleanRate, 1), 100, 'min', '%'),
      ],
    }));
  }

  if (routeData) {
    const routeBaselineTrips = routeData.trips.filter((trip) => tripTime(trip) < startMs);
    const routeWeekTrips = contextWeekTrips.filter((trip) => shortHash(routeKeyForTrip(trip) || '') === routeData.id);
    const routeBaseline = progressionStats(routeBaselineTrips);
    const routeWeek = progressionStats(routeWeekTrips);
    candidates.push(missionFromRequirements({
      id: `${weekKey}:route:${routeData.id}`, title: 'Route mastery', category: 'Repeated route', difficulty: 'Advanced', deadline, reward: 210,
      description: 'Improve a repeated route against its own historical baseline. The route identifier stays local and opaque.',
      requirements: [
        requirement('trips', 'Comparable route trips', routeWeek.tripCount, 3, 'min', 'trips'),
        requirement('distance', 'Comparable route distance', round(routeWeek.distanceKm, 1), 35, 'min', 'km'),
        requirement('score', 'Route average score', round(routeWeek.avgScore, 1), clamp(round((routeBaseline.avgScore ?? 80) + 4), 82, 95), 'min', 'pts'),
        requirement('rate', 'Route risk-event rate', round(routeWeek.eventRates.all, 2), Math.max(1.5, round((routeBaseline.eventRates.all ?? 4) * 0.8, 1)), 'max', '/100 km'),
      ],
    }));
  }

  if (contextId) {
    const contextBaseline = progressionStats(tripsForContext(contextBaselineTrips, contextId));
    const contextWeek = progressionStats(tripsForContext(contextWeekTrips, contextId));
    candidates.push(missionFromRequirements({
      id: `${weekKey}:context:${contextId}`, title: contextLabel(contextId), category: 'Comparable context', difficulty: 'Stretch', deadline, reward: 190,
      description: 'Evaluated only when this condition occurs naturally; Road Sage never asks you to seek additional exposure.',
      requirements: [
        requirement('trips', 'Naturally occurring context trips', contextWeek.tripCount, 3, 'min', 'trips'),
        requirement('distance', 'Comparable context distance', round(contextWeek.distanceKm, 1), 40, 'min', 'km'),
        requirement('score', 'Context-weighted score', round(contextWeek.avgScore, 1), clamp(round((contextBaseline.avgScore ?? 80) + 3), 82, 94), 'min', 'pts'),
        requirement('rate', 'Context risk-event rate', round(contextWeek.eventRates.all, 2), Math.max(1.5, round((contextBaseline.eventRates.all ?? 4) * 0.85, 1)), 'max', '/100 km'),
      ],
    }));
  }

  const recentFive = eligible.slice(0, 5);
  const previousFive = eligible.slice(5, 10);
  const recentFiveStats = progressionStats(recentFive);
  const previousFiveStats = progressionStats(previousFive);
  const recoveryTarget = clamp(round(Math.max(84, previousFiveStats.avgScore ?? 84)), 80, 93);
  candidates.push(missionFromRequirements({
    id: `${weekKey}:recovery`, title: 'Controlled recovery', category: 'Recovery', difficulty: 'Stretch', deadline, reward: 200,
    description: 'Turn a difficult run into sustained improvement instead of requiring perfection forever.',
    requirements: [
      requirement('trips', 'Recent recovery trips', recentFive.length, 5, 'min', 'trips'),
      requirement('score', 'Recent five-trip form', round(recentFiveStats.avgScore, 1), recoveryTarget, 'min', 'pts'),
      requirement('rate', 'Recent risk-event rate', round(recentFiveStats.eventRates.all, 2), Math.max(1.5, round((previousFiveStats.eventRates.all ?? 4) * 0.75, 1)), 'max', '/100 km'),
      requirement('severe', 'Severe events in recovery run', recentFiveStats.severeEvents, 0, 'max', 'events'),
    ],
  }));

  const candidateIds = new Set(candidates.map((mission) => mission.id));
  const defaultActiveIds = [
    `${weekKey}:primary:${weakest.id}`,
    `${weekKey}:balanced`,
    routeData ? `${weekKey}:route:${routeData.id}` : candidates.find((mission) => mission.id.includes(':focus'))?.id || `${weekKey}:precision-streak`,
  ].filter((id) => id && candidateIds.has(id)).slice(0, 3);
  const activeMissionIds = (storedPlan?.activeMissionIds || defaultActiveIds).filter((id) => candidateIds.has(id)).slice(0, 3);
  const plan = {
    weekKey,
    primaryTrackId: weakest.id,
    routeId: routeData?.id || null,
    contextId,
    activeMissionIds: activeMissionIds.length === 3 ? activeMissionIds : candidates.slice(0, 3).map((mission) => mission.id),
    createdAt: storedPlan?.createdAt || new Date(nowMs).toISOString(),
    selectionLocked: Boolean(storedPlan?.selectionLocked || week.tripCount >= 2),
  };
  return { candidates, active: candidates.filter((mission) => plan.activeMissionIds.includes(mission.id)), plan };
}

function monthBounds(nowMs) {
  const now = new Date(nowMs);
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { startMs: start.getTime(), endMs: end.getTime() - 1, previousStartMs: previous.getTime(), key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` };
}

function buildSeason(eligible, ledger, nowMs) {
  const bounds = monthBounds(nowMs);
  const currentTrips = eligible.filter((trip) => tripTime(trip) >= bounds.startMs && tripTime(trip) <= nowMs);
  const previousTrips = eligible.filter((trip) => tripTime(trip) >= bounds.previousStartMs && tripTime(trip) < bounds.startMs);
  const current = progressionStats(currentTrips);
  const previous = progressionStats(previousTrips);
  const completedWeeklyMissions = Object.entries(ledger.missions || {}).filter(([id, earnedAt]) => id.startsWith(bounds.key) || (new Date(earnedAt).getTime() >= bounds.startMs && new Date(earnedAt).getTime() <= bounds.endMs)).length;
  const scoreTarget = clamp(round(Math.max(86, (previous.avgScore ?? 83) + 2)), 82, 94);
  const challenges = [
    missionFromRequirements({
      id: `season:${bounds.key}:form`, title: 'Season form', category: 'Monthly', difficulty: 'Advanced', deadline: new Date(bounds.endMs).toISOString(), reward: 300,
      description: 'Sustain quality across a meaningful monthly sample.',
      requirements: [
        requirement('trips', 'Qualifying trips this month', current.tripCount, 10, 'min', 'trips'),
        requirement('distance', 'Measured distance this month', round(current.distanceKm, 1), 175, 'min', 'km'),
        requirement('score', 'Monthly distance-weighted score', round(current.avgScore, 1), scoreTarget, 'min', 'pts'),
      ],
    }),
    missionFromRequirements({
      id: `season:${bounds.key}:risk`, title: 'Season risk reduction', category: 'Monthly', difficulty: 'Expert', deadline: new Date(bounds.endMs).toISOString(), reward: 360,
      description: 'Lower the normalized risk-event rate versus the previous month.',
      requirements: [
        requirement('trips', 'Qualifying trips this month', current.tripCount, 10, 'min', 'trips'),
        requirement('distance', 'Measured distance this month', round(current.distanceKm, 1), 175, 'min', 'km'),
        requirement('rate', 'Monthly risk-event rate', round(current.eventRates.all, 2), Math.max(1.25, round((previous.eventRates.all ?? 4) * 0.85, 1)), 'max', '/100 km'),
      ],
    }),
    missionFromRequirements({
      id: `season:${bounds.key}:missions`, title: 'Mission specialist', category: 'Monthly', difficulty: 'Stretch', deadline: new Date(bounds.endMs).toISOString(), reward: 280,
      description: 'Complete two selected weekly missions during the season.',
      requirements: [requirement('missions', 'Completed weekly missions', completedWeeklyMissions, 2, 'min', 'missions')],
    }),
  ].map((challenge) => ({
    ...challenge,
    completed: challenge.completed || Boolean(ledger.seasons?.[challenge.id]),
    status: challenge.completed || ledger.seasons?.[challenge.id] ? 'complete' : challenge.status,
  }));
  return {
    key: bounds.key,
    label: new Date(bounds.startMs).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    challenges,
    stats: { trips: current.tripCount, distanceKm: round(current.distanceKm, 1), score: current.avgScore == null ? null : round(current.avgScore) },
    completedCount: challenges.filter((challenge) => challenge.completed).length,
  };
}

function rollingWindows(trips, size) {
  const chronological = [...trips].sort((a, b) => tripTime(a) - tripTime(b));
  return chronological.slice(size - 1).map((_, index) => chronological.slice(index, index + size));
}

function buildRecords(eligible) {
  const bestTrip = [...eligible].filter((trip) => Number.isFinite(Number(trip.score_overall))).sort((a, b) => number(b.score_overall) - number(a.score_overall))[0];
  const fiveWindows = rollingWindows(eligible, 5);
  const bestFive = fiveWindows.map((trips) => ({ trips, value: weightedMean(trips) })).filter((entry) => entry.value != null).sort((a, b) => b.value - a.value)[0];
  const lowRisk = fiveWindows.map((trips) => {
    const stats = progressionStats(trips);
    return { trips, value: stats.distanceKm >= 50 ? stats.eventRates.all : null, distance: stats.distanceKm };
  }).filter((entry) => entry.value != null).sort((a, b) => a.value - b.value)[0];
  let cleanStreak = 0;
  let bestCleanStreak = 0;
  [...eligible].sort((a, b) => tripTime(a) - tripTime(b)).forEach((trip) => {
    cleanStreak = isCleanTrip(trip) ? cleanStreak + 1 : 0;
    bestCleanStreak = Math.max(bestCleanStreak, cleanStreak);
  });
  const recentFive = eligible.slice(0, 5);
  const previousFive = eligible.slice(5, 10);
  const improvement = recentFive.length === 5 && previousFive.length === 5
    ? round((weightedMean(recentFive) ?? 0) - (weightedMean(previousFive) ?? 0), 1)
    : null;

  return [
    { id: 'best_trip', label: 'Best single trip', value: bestTrip ? `${round(bestTrip.score_overall)} pts` : '—', numericValue: bestTrip ? number(bestTrip.score_overall) : null, detail: 'Highest overall score', date: bestTrip?.start_time || null, tripId: bestTrip?.id || null },
    { id: 'best_five', label: 'Best five-trip form', value: bestFive ? `${round(bestFive.value, 1)} avg` : '—', numericValue: bestFive?.value ?? null, detail: 'Best distance-weighted five-trip run', date: bestFive?.trips.at(-1)?.start_time || null, tripId: bestFive?.trips.at(-1)?.id || null },
    { id: 'clean_streak', label: 'Longest clean streak', value: `${bestCleanStreak} trips`, numericValue: bestCleanStreak, detail: 'Consecutive trips without a core or severe risk event', date: null, tripId: null },
    { id: 'lowest_risk', label: 'Lowest five-trip risk rate', value: lowRisk ? `${round(lowRisk.value, 1)}/100 km` : '—', numericValue: lowRisk?.value ?? null, detail: 'Requires at least 50 km in the five-trip window', date: lowRisk?.trips.at(-1)?.start_time || null, tripId: lowRisk?.trips.at(-1)?.id || null },
    { id: 'recent_improvement', label: 'Recent form change', value: improvement == null ? '—' : `${improvement >= 0 ? '+' : ''}${improvement} pts`, numericValue: improvement, detail: 'Latest five trips versus the previous five', date: recentFive[0]?.start_time || null, tripId: recentFive[0]?.id || null },
  ];
}

function rankForScore(score) {
  if (score == null) return { name: 'Unranked', division: '', label: 'Unranked' };
  const bands = [
    { min: 92, max: 100, name: 'Elite' },
    { min: 85, max: 92, name: 'Advanced' },
    { min: 75, max: 85, name: 'Skilled' },
    { min: 65, max: 75, name: 'Developing' },
    { min: 0, max: 65, name: 'Foundation' },
  ];
  const band = bands.find((item) => score >= item.min) || bands.at(-1);
  const position = (score - band.min) / Math.max(1, band.max - band.min);
  const division = position >= 0.67 ? 'I' : position >= 0.34 ? 'II' : 'III';
  return { name: band.name, division, label: `${band.name} ${division}` };
}

export function loadDriverProgressionLedger() {
  if (typeof localStorage === 'undefined') return emptyLedger();
  try {
    const value = JSON.parse(localStorage.getItem(LEDGER_KEY) || 'null');
    if (value && typeof value === 'object') return {
      ...emptyLedger(),
      ...value,
      version: 2,
      mastery: value.mastery || {},
      missions: value.missions || {},
      seasons: value.seasons || {},
      weeklyPlans: value.weeklyPlans || {},
      xpTransactions: Array.isArray(value.xpTransactions) ? value.xpTransactions : [],
      celebrations: Array.isArray(value.celebrations) ? value.celebrations : [],
    };
  } catch {
    // A corrupt optional ledger should never prevent the progression page from loading.
  }
  return emptyLedger();
}

const writeDriverProgressionLedger = (ledger) => {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch { /* optional persistence */ }
};

export function updateDriverProgressionMissionSelection(weekKey, missionIds, currentLedger = loadDriverProgressionLedger()) {
  const next = { ...emptyLedger(), ...JSON.parse(JSON.stringify(currentLedger)) };
  next.version = 2;
  next.weeklyPlans ||= {};
  const current = next.weeklyPlans[weekKey];
  if (!current) return next;
  if (current.selectionLocked) return next;
  const selected = [...new Set(missionIds)].slice(0, 3);
  if (selected.length !== 3) return next;
  next.weeklyPlans[weekKey] = { ...current, activeMissionIds: selected, selectionLocked: true };
  writeDriverProgressionLedger(next);
  return next;
}

export function acknowledgeDriverProgressionCelebration(id, currentLedger = loadDriverProgressionLedger()) {
  const next = { ...emptyLedger(), ...JSON.parse(JSON.stringify(currentLedger)) };
  next.version = 2;
  next.celebrations = (next.celebrations || []).map((celebration) => celebration.id === id ? { ...celebration, seen: true } : celebration);
  writeDriverProgressionLedger(next);
  return next;
}

export function syncDriverProgressionLedger(progression, currentLedger = loadDriverProgressionLedger()) {
  const next = { ...emptyLedger(), ...JSON.parse(JSON.stringify(currentLedger || emptyLedger())) };
  next.version = 2;
  next.mastery ||= {};
  next.missions ||= {};
  next.seasons ||= {};
  next.weeklyPlans ||= {};
  next.xpTransactions ||= [];
  next.celebrations ||= [];
  const now = progression.generatedAt;
  const newUnlocks = [];
  if (progression.missionPlan && !next.weeklyPlans[progression.missionPlan.weekKey]) {
    next.weeklyPlans[progression.missionPlan.weekKey] = progression.missionPlan;
  } else if (progression.missionPlan?.selectionLocked && next.weeklyPlans[progression.missionPlan.weekKey]) {
    next.weeklyPlans[progression.missionPlan.weekKey].selectionLocked = true;
  }
  const addTransaction = ({ id, type, title, detail, amount, tripId = null, newlyUnlocked = false }) => {
    const transactionId = `xp:${id}`;
    if (!next.xpTransactions.some((transaction) => transaction.id === transactionId)) {
      next.xpTransactions.push({ id: transactionId, sourceId: id, type, title, detail, amount, tripId, earnedAt: now });
    }
    if (newlyUnlocked) {
      const unlock = { id, type, title, detail, xp: amount, tripId, earnedAt: now };
      newUnlocks.push(unlock);
      if (!next.celebrations.some((celebration) => celebration.id === id)) next.celebrations.push({ ...unlock, seen: false });
    }
  };
  progression.masteryTracks.forEach((track) => track.tiers.forEach((tier) => {
    if (!tier.achievedNow && !next.mastery[tier.ledgerKey]) return;
    const newlyUnlocked = !next.mastery[tier.ledgerKey];
    if (newlyUnlocked) next.mastery[tier.ledgerKey] = now;
    addTransaction({ id: `mastery:${tier.ledgerKey}`, type: 'mastery', title: `${track.label} · ${tier.label}`, detail: `${tier.label} mastery tier`, amount: tier.points, newlyUnlocked });
  }));
  progression.missions.forEach((mission) => {
    if (!mission.completed && !next.missions[mission.id]) return;
    const newlyUnlocked = !next.missions[mission.id];
    if (newlyUnlocked) next.missions[mission.id] = now;
    addTransaction({ id: `mission:${mission.id}`, type: 'mission', title: mission.title, detail: `${mission.difficulty} weekly mission`, amount: mission.reward, tripId: progression.latestTripId, newlyUnlocked });
  });
  progression.season.challenges.forEach((challenge) => {
    if (!challenge.completed && !next.seasons[challenge.id]) return;
    const newlyUnlocked = !next.seasons[challenge.id];
    if (newlyUnlocked) next.seasons[challenge.id] = now;
    addTransaction({ id: `season:${challenge.id}`, type: 'season', title: challenge.title, detail: `${progression.season.label} seasonal challenge`, amount: challenge.reward, tripId: progression.latestTripId, newlyUnlocked });
  });
  next.xpTransactions.sort((a, b) => new Date(b.earnedAt).getTime() - new Date(a.earnedAt).getTime());
  const seenCelebrations = next.celebrations.filter((celebration) => celebration.seen).slice(-20);
  const pendingCelebrations = next.celebrations.filter((celebration) => !celebration.seen).slice(-5);
  next.celebrations = [...seenCelebrations, ...pendingCelebrations];
  const changed = JSON.stringify(next) !== JSON.stringify(currentLedger);
  if (changed) writeDriverProgressionLedger(next);
  return { ledger: next, changed, newUnlocks };
}

export function buildDriverProgression(trips = [], settings = {}, options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const ledger = options.ledger || emptyLedger();
  const minimumTripKm = number(settings.progression_min_trip_km, 2);
  const minimumTripSeconds = number(settings.progression_min_trip_seconds, 180);
  const allCompleted = (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip.status === 'completed')
    .map(normalizeProgressionTrip)
    .sort((a, b) => tripTime(b) - tripTime(a));
  const completed = allCompleted;
  const privacyLimitedTrips = allCompleted.filter((trip) => tripTouchesPrivacyZoneForTrend(trip)).length;
  const exclusionCounts = {
    distance: 0,
    duration: 0,
    score: 0,
  };
  const eligible = completed.filter((trip) => {
    if (number(trip.distance_km) < minimumTripKm) {
      exclusionCounts.distance += 1;
      return false;
    }
    if (number(trip.duration_seconds, minimumTripSeconds) < minimumTripSeconds) {
      exclusionCounts.duration += 1;
      return false;
    }
    if (trip.score_overall == null || trip.score_overall === '' || !Number.isFinite(Number(trip.score_overall))) {
      exclusionCounts.score += 1;
      return false;
    }
    return true;
  });
  const recent = eligible.slice(0, 20);
  const previous = eligible.slice(20, 40);
  const allStats = progressionStats(eligible);
  const masteryStats = progressionStats(eligible.slice(0, 40));
  const recentStats = progressionStats(recent);
  const previousStats = progressionStats(previous);
  const masteryTracks = buildMasteryTracks(masteryStats, recentStats, previousStats, ledger);
  const scoredTracks = masteryTracks.map((track) => track.score).filter((score) => score != null);
  const formScore = scoredTracks.length ? round(mean(scoredTracks)) : null;
  const previousScores = TRACK_DEFINITIONS.map((definition) => scoreForTrack(definition, previousStats)).filter((score) => score != null);
  const previousForm = previousScores.length ? round(mean(previousScores)) : null;
  const formTrend = trendFor(formScore, previousForm);
  const currentWeekKey = new Date(weekBounds(nowMs).startMs).toISOString().slice(0, 10);
  const missionBuild = buildMissions(eligible, masteryTracks, nowMs, ledger.weeklyPlans?.[currentWeekKey]);
  const missionCandidates = missionBuild.candidates.map((mission) => ({
    ...mission,
    completed: mission.completed || Boolean(ledger.missions?.[mission.id]),
    status: mission.completed || ledger.missions?.[mission.id] ? 'complete' : mission.status,
  }));
  const missions = missionCandidates.filter((mission) => missionBuild.plan.activeMissionIds.includes(mission.id));
  const season = buildSeason(eligible, ledger, nowMs);
  const xp = (ledger.xpTransactions || []).reduce((sum, transaction) => sum + number(transaction.amount), 0);
  const level = Math.floor(xp / 500) + 1;
  const history = (ledger.xpTransactions || []).map((transaction) => ({ ...transaction, detail: `${transaction.detail} · +${transaction.amount} XP` }));

  const confidence = eligible.length >= 20 && allStats.distanceKm >= 300
    ? 'Strong'
    : eligible.length >= 8 && allStats.distanceKm >= 100 ? 'Moderate' : 'Developing';

  return {
    generatedAt: new Date(nowMs).toISOString(),
    latestTripId: options.tripId || eligible[0]?.id || null,
    eligibility: {
      completedTrips: allCompleted.length,
      eligibleTrips: eligible.length,
      excludedTrips: allCompleted.length - eligible.length,
      distanceKm: round(allStats.distanceKm, 1),
      minimumTripKm,
      minimumTripSeconds,
      confidence,
      privacyLimitedTrips,
      exclusionReasons: [
        { id: 'distance', label: `Under ${minimumTripKm} km`, count: exclusionCounts.distance, detail: 'The trip is too short to provide stable progression evidence.' },
        { id: 'duration', label: `Under ${Math.ceil(minimumTripSeconds / 60)} min`, count: exclusionCounts.duration, detail: 'The trip duration is below the evidence minimum.' },
        { id: 'score', label: 'No usable overall score', count: exclusionCounts.score, detail: 'The trip has no available canonical or legacy overall score.' },
      ],
    },
    currentForm: {
      score: formScore,
      rank: rankForScore(formScore),
      trend: formTrend,
      recentTrips: recent.length,
      previousTrips: previous.length,
    },
    xp: {
      total: xp,
      level,
      current: xp % 500,
      target: 500,
      progress: round(((xp % 500) / 500) * 100),
      sources: [
        { id: 'mastery', label: 'Mastery tiers', detail: 'Meet every requirement for a skill tier.', rewards: '100–650 XP per tier' },
        { id: 'missions', label: 'Weekly missions', detail: 'Complete every requirement shown on one of your three active mission cards.', rewards: '80–220 XP per mission' },
        { id: 'seasons', label: 'Season challenges', detail: 'Finish the monthly form, risk-reduction, or mission challenge.', rewards: '280–360 XP per challenge' },
      ],
    },
    masteryTracks,
    missions,
    missionCandidates,
    missionPlan: missionBuild.plan,
    season,
    records: buildRecords(eligible),
    history,
    pendingCelebration: (ledger.celebrations || []).find((celebration) => !celebration.seen) || null,
    formSeries: [...eligible].slice(0, 30).reverse().map((trip) => ({ date: trip.start_time, score: round(trip.score_overall), tripId: trip.id })),
  };
}

export function processDriverProgressionAfterTrip(trips = [], settings = {}, options = {}) {
  const currentLedger = loadDriverProgressionLedger();
  const beforeSync = buildDriverProgression(trips, settings, { ...options, ledger: currentLedger });
  const firstSync = syncDriverProgressionLedger(beforeSync, currentLedger);
  const afterFirstSync = buildDriverProgression(trips, settings, { ...options, ledger: firstSync.ledger });
  const secondSync = syncDriverProgressionLedger(afterFirstSync, firstSync.ledger);
  const progression = buildDriverProgression(trips, settings, { ...options, ledger: secondSync.ledger });
  const newUnlocks = [...firstSync.newUnlocks, ...secondSync.newUnlocks];
  return {
    progression,
    ledger: secondSync.ledger,
    newUnlocks,
    // Include every persisted unlock so notification delivery can recover after
    // a denied permission or scheduling failure. The notification service owns
    // the durable delivered-ID dedupe, so already-sent milestones remain quiet.
    notificationBadges: secondSync.ledger.xpTransactions.map((transaction) => ({
      id: `progression_${transaction.sourceId}`,
      label: transaction.title,
      description: `${transaction.detail}. +${transaction.amount} XP`,
      earned: true,
    })),
  };
}
