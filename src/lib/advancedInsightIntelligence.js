import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import { excludePrivacyTouchedDaysFromTrends } from '@/lib/privateTripMode';
import { scoringValue } from '@/lib/scoringConstants';
import { routeKeyForTrip } from '@/lib/mediumInsights';
import { buildHabitProfile, getTimeBucket } from '@/lib/habitProfile';
import { computePreTripRisk } from '@/lib/preTripRisk';
import { explainTripScoreDrivers } from '@/lib/scoring/scoreExplainer';

const COMPONENTS = [
  { id: 'safety', label: 'Safety', field: 'score_safety', weight: 'safety' },
  { id: 'smoothness', label: 'Smoothness', field: 'score_smoothness', weight: 'smoothness' },
  { id: 'intersection', label: 'Intersection approach', field: 'intersection_score', weight: 'intersection' },
  { id: 'eco', label: 'Eco estimate', field: 'score_eco', weight: 'eco' },
];
const EVENT_FIELDS = ['harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count', 'speeding_events_count'];
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 1) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const timestamp = (trip = {}) => new Date(trip.start_time || trip.created_at || 0).getTime();
const distance = (trips = []) => trips.reduce((sum, trip) => sum + Math.max(0, num(trip.distance_km) || 0), 0);
const totalEvents = (trips = [], field = null) => (field ? [field] : EVENT_FIELDS).reduce(
  (total, key) => total + trips.reduce((sum, trip) => sum + Math.max(0, num(trip[key]) || 0), 0),
  0
);
const eventRate = (trips = [], field = null) => distance(trips) > 0
  ? round(totalEvents(trips, field) / distance(trips) * 100, 1)
  : null;
const weightedScore = (trips = [], field = 'score_overall') => {
  const rows = trips.map((trip) => ({
    value: num(trip[field]),
    weight: Math.max(0.1, num(trip.distance_km) || 0.1),
  })).filter((row) => row.value != null);
  if (!rows.length) return null;
  const weights = rows.reduce((sum, row) => sum + row.weight, 0);
  return round(rows.reduce((sum, row) => sum + row.value * row.weight, 0) / weights, 1);
};
const roadType = (trip = {}) => {
  if (trip.dominant_road_type || trip.road_type) return trip.dominant_road_type || trip.road_type;
  if ((num(trip.avg_running_speed_kmh) || num(trip.avg_speed_kmh) || 0) > 85) return 'highway';
  if ((num(trip.distance_km) || 0) > 25 && (num(trip.stop_count) || 0) <= 2) return 'rural';
  return 'city';
};
const profileFor = (trip = {}) => ({
  routeKey: trip.route_key || routeKeyForTrip(trip),
  timeBucket: getTimeBucket(new Date(trip.start_time).getHours()),
  distanceKm: num(trip.distance_km) || 0,
  roadType: roadType(trip),
  vehicleId: trip.vehicle_id || null,
  weekdayClass: [0, 6].includes(new Date(trip.start_time).getDay()) ? 'weekend' : 'weekday',
});
const componentValue = (trip, component) => (
  num(trip.component_scores?.[component.id]?.value) ?? num(trip[component.field])
);

function matchTrips(currentTrips = [], previousTrips = []) {
  const used = new Set();
  const pairs = [];
  [...currentTrips].sort((a, b) => timestamp(b) - timestamp(a)).forEach((current) => {
    const profile = profileFor(current);
    const candidates = previousTrips.filter((trip) => !used.has(String(trip.id))).map((baseline) => {
      const other = profileFor(baseline);
      const routeMatch = Boolean(profile.routeKey && other.routeKey && profile.routeKey === other.routeKey);
      const distanceRatio = Math.min(profile.distanceKm, other.distanceKm) / Math.max(0.1, profile.distanceKm, other.distanceKm);
      const sameTime = profile.timeBucket === other.timeBucket;
      const sameRoad = profile.roadType === other.roadType;
      const sameVehicle = !profile.vehicleId || !other.vehicleId || String(profile.vehicleId) === String(other.vehicleId);
      const sameDayClass = profile.weekdayClass === other.weekdayClass;
      const quality = (routeMatch ? 5 : 0) + (sameTime ? 2 : 0) + (distanceRatio >= 0.65 ? 2 : distanceRatio >= 0.45 ? 1 : 0)
        + (sameRoad ? 1 : 0) + (sameVehicle ? 1 : 0) + (sameDayClass ? 1 : 0);
      return {
        baseline,
        quality,
        routeMatch,
        distanceRatio,
        why: [
          routeMatch ? 'same route' : null,
          sameTime ? `same ${profile.timeBucket.toLowerCase()} window` : null,
          distanceRatio >= 0.65 ? 'similar distance' : null,
          sameRoad ? `same ${profile.roadType} context` : null,
          sameVehicle ? 'same vehicle context' : null,
          sameDayClass ? `same ${profile.weekdayClass}` : null,
        ].filter(Boolean),
      };
    }).filter((candidate) => candidate.quality >= 5)
      .sort((a, b) => b.quality - a.quality || b.distanceRatio - a.distanceRatio);
    const best = candidates[0];
    if (!best) return;
    used.add(String(best.baseline.id));
    pairs.push({
      currentTripId: current.id,
      baselineTripId: best.baseline.id,
      currentStartTime: current.start_time,
      baselineStartTime: best.baseline.start_time,
      currentScore: num(current.score_overall),
      baselineScore: num(best.baseline.score_overall),
      scoreDelta: num(current.score_overall) == null || num(best.baseline.score_overall) == null
        ? null : round(num(current.score_overall) - num(best.baseline.score_overall), 1),
      currentEventRate: eventRate([current]),
      baselineEventRate: eventRate([best.baseline]),
      matchQuality: Math.min(100, Math.round(best.quality / 12 * 100)),
      why: best.why,
      current,
      baseline: best.baseline,
    });
  });
  const currentMatched = pairs.map((pair) => pair.current);
  const baselineMatched = pairs.map((pair) => pair.baseline);
  return {
    pairs,
    matchedTripCount: pairs.length,
    eligibleTripCount: currentTrips.length,
    coveragePct: currentTrips.length ? Math.round(pairs.length / currentTrips.length * 100) : 0,
    currentScore: weightedScore(currentMatched),
    baselineScore: weightedScore(baselineMatched),
    scoreDelta: weightedScore(currentMatched) == null || weightedScore(baselineMatched) == null
      ? null : round(weightedScore(currentMatched) - weightedScore(baselineMatched), 1),
    currentEventRate: eventRate(currentMatched),
    baselineEventRate: eventRate(baselineMatched),
    eventRateDelta: eventRate(currentMatched) == null || eventRate(baselineMatched) == null
      ? null : round(eventRate(currentMatched) - eventRate(baselineMatched), 1),
    confidence: pairs.length >= 5 ? 'strong' : pairs.length >= 3 ? 'moderate' : 'developing',
  };
}

function contributionLedger(trips = []) {
  const configured = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS') || {};
  const rows = COMPONENTS.map((component) => ({
    ...component,
    configuredWeight: Math.max(0, num(configured[component.weight]) || 0),
    weightedContribution: 0,
    weightedDeficit: 0,
    evidenceWeight: 0,
    availableTrips: 0,
  }));
  let reconstructedTotal = 0;
  let recordedTotal = 0;
  let overallWeight = 0;
  let recordedWeight = 0;
  let comparedReconstructedTotal = 0;
  trips.forEach((trip) => {
    const available = rows.map((row) => ({ row, value: componentValue(trip, row) }))
      .filter(({ row, value }) => value != null && row.configuredWeight > 0);
    const weightSum = available.reduce((sum, item) => sum + item.row.configuredWeight, 0);
    if (!weightSum) return;
    const tripWeight = Math.max(0.1, num(trip.distance_km) || 0.1);
    const reconstructed = available.reduce((sum, item) => (
      sum + item.value * item.row.configuredWeight / weightSum
    ), 0);
    available.forEach(({ row, value }) => {
      const share = row.configuredWeight / weightSum;
      row.weightedContribution += value * share * tripWeight;
      row.weightedDeficit += (100 - value) * share * tripWeight;
      row.evidenceWeight += tripWeight;
      row.availableTrips += 1;
    });
    reconstructedTotal += reconstructed * tripWeight;
    if (num(trip.score_overall) != null) {
      recordedTotal += num(trip.score_overall) * tripWeight;
      comparedReconstructedTotal += reconstructed * tripWeight;
      recordedWeight += tripWeight;
    }
    overallWeight += tripWeight;
  });
  const ledger = rows.filter((row) => row.evidenceWeight > 0).map((row) => ({
    id: row.id,
    label: row.label,
    averageContribution: round(row.weightedContribution / row.evidenceWeight, 1),
    averageDeficit: round(row.weightedDeficit / row.evidenceWeight, 1),
    availableTrips: row.availableTrips,
    configuredWeight: row.configuredWeight,
  })).sort((a, b) => b.averageDeficit - a.averageDeficit);
  const driverGroups = new Map();
  trips.forEach((trip) => explainTripScoreDrivers(trip, { limit: 5 }).forEach((driver) => {
    const current = driverGroups.get(driver.factor) || {
      factor: driver.factor, label: driver.label, category: driver.category,
      occurrences: 0, deficitTotal: 0, evidence: driver.evidence, tripIds: [],
    };
    current.occurrences += 1;
    current.deficitTotal += driver.deficit || 0;
    current.tripIds.push(trip.id);
    driverGroups.set(driver.factor, current);
  }));
  return {
    rows: ledger,
    reconstructedScore: recordedWeight
      ? round(comparedReconstructedTotal / recordedWeight, 1)
      : overallWeight ? round(reconstructedTotal / overallWeight, 1) : null,
    recordedScore: recordedWeight ? round(recordedTotal / recordedWeight, 1) : null,
    reconstructionDelta: recordedWeight
      ? round((comparedReconstructedTotal - recordedTotal) / recordedWeight, 1)
      : null,
    exactBlend: recordedWeight > 0
      && Math.abs((comparedReconstructedTotal - recordedTotal) / recordedWeight) <= 1.1,
    supportingDrivers: [...driverGroups.values()].map((row) => ({
      ...row,
      averageDeficit: round(row.deficitTotal / row.occurrences, 1),
      tripIds: [...new Set(row.tripIds)].slice(0, 4),
    })).sort((a, b) => b.averageDeficit - a.averageDeficit).slice(0, 6),
  };
}

function changePointFor(trips = []) {
  const sorted = trips.filter((trip) => num(trip.score_overall) != null).sort((a, b) => timestamp(a) - timestamp(b));
  if (sorted.length < 8) return null;
  const candidates = [];
  for (let index = 4; index <= sorted.length - 4; index += 1) {
    const before = sorted.slice(index - 4, index);
    const after = sorted.slice(index, index + 4);
    const beforeScore = weightedScore(before);
    const afterScore = weightedScore(after);
    const delta = beforeScore == null || afterScore == null ? null : round(afterScore - beforeScore, 1);
    if (delta != null && Math.abs(delta) >= 5) {
      const remaining = sorted.slice(index);
      const remainingScore = weightedScore(remaining);
      candidates.push({
        id: `change_${sorted[index].id}`,
        at: sorted[index].start_time,
        tripId: sorted[index].id,
        beforeScore,
        afterScore,
        delta,
        direction: delta > 0 ? 'improved' : 'declined',
        persisted: remaining.length >= 4 && remainingScore != null
          && (delta > 0 ? remainingScore >= beforeScore + 3 : remainingScore <= beforeScore - 3),
        beforeTripIds: before.map((trip) => trip.id),
        afterTripIds: after.map((trip) => trip.id),
      });
    }
  }
  return candidates.sort((a, b) => (
    Number(b.persisted) - Number(a.persisted)
    || Math.abs(b.delta) - Math.abs(a.delta)
    || timestamp({ start_time: b.at }) - timestamp({ start_time: a.at })
  ))[0] || null;
}

function eventEvidenceFor(trips = []) {
  return trips.flatMap((trip) => (trip.driving_events || []).map((event, index) => ({
    id: `${trip.id}:${index}`,
    tripId: trip.id,
    tripStartTime: trip.start_time,
    tripScore: num(trip.score_overall),
    eventIndex: index,
    type: event.type || 'event',
    severity: event.severity || 'unknown',
    timestamp: event.timestamp || event.startTime || trip.start_time,
    lat: num(event.lat),
    lng: num(event.lng),
    speedKmh: num(event.speed_kmh),
    speedLimitKmh: num(event.speed_limit_kmh || event.limit_kmh),
    value: num(event.value),
    roadName: event.road_name || event.roadName || null,
    diagnosticOnly: event.diagnostic_only === true,
    event,
    trip,
  }))).filter((row) => !row.diagnosticOnly)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function createComparableExperiment(candidate, currentTrips = []) {
  const metricKey = candidate.metricKey || 'score_overall';
  const reference = [...currentTrips].sort((a, b) => (
    (num(b[metricKey]) || 0) - (num(a[metricKey]) || 0) || timestamp(b) - timestamp(a)
  ))[0] || null;
  return {
    ...candidate,
    title: String(candidate.title || 'Driving experiment').replace('Three-drive', 'Five-drive'),
    targetTrips: 5,
    startedAt: new Date().toISOString(),
    baselineTripIds: currentTrips.map((trip) => trip.id),
    baselineDistanceKm: round(distance(currentTrips), 1),
    baselineEventCount: metricKey === 'score_overall' ? null : totalEvents(currentTrips, metricKey),
    baselineScoreValues: metricKey === 'score_overall'
      ? currentTrips.map((trip) => num(trip.score_overall)).filter((value) => value != null)
      : [],
    matchProfile: reference ? profileFor(reference) : null,
  };
}

const isComparable = (trip, profile) => {
  if (!profile) return true;
  const current = profileFor(trip);
  if (profile.vehicleId && current.vehicleId && String(profile.vehicleId) !== String(current.vehicleId)) return false;
  if (profile.routeKey && current.routeKey) return profile.routeKey === current.routeKey;
  const ratio = Math.min(profile.distanceKm, current.distanceKm) / Math.max(0.1, profile.distanceKm, current.distanceKm);
  return current.timeBucket === profile.timeBucket && current.roadType === profile.roadType && ratio >= 0.5;
};

export function buildComparableExperimentProgress(experiment, trips = []) {
  if (!experiment?.startedAt) return null;
  const afterStart = excludePrivacyTouchedDaysFromTrends(trips).filter((trip) => (
    trip.status === 'completed' && isDriverMetricEligible(trip)
    && timestamp(trip) > new Date(experiment.startedAt).getTime()
  )).sort((a, b) => timestamp(a) - timestamp(b));
  const comparable = afterStart.filter((trip) => isComparable(trip, experiment.matchProfile));
  const targetTrips = Math.max(1, Number(experiment.targetTrips) || 5);
  const measured = comparable.slice(0, targetTrips);
  const isScore = experiment.metricKey === 'score_overall';
  const currentValue = isScore ? weightedScore(measured) : eventRate(measured, experiment.metricKey);
  const baseline = num(experiment.baseline);
  const improvement = currentValue == null || baseline == null ? null
    : round(isScore ? currentValue - baseline : baseline - currentValue, 1);
  let confidenceInterval = null;
  let statisticallyClear = false;
  if (!isScore && measured.length && num(experiment.baselineDistanceKm) > 0) {
    const currentDistance = distance(measured);
    const currentCount = totalEvents(measured, experiment.metricKey);
    const baselineCount = Math.max(0, num(experiment.baselineEventCount) || 0);
    if (currentDistance > 0) {
      const standardError = Math.sqrt(
        currentCount / (currentDistance ** 2)
        + baselineCount / (experiment.baselineDistanceKm ** 2)
      ) * 100;
      const effect = baseline - currentValue;
      confidenceInterval = {
        lower: round(effect - 1.96 * standardError, 1),
        upper: round(effect + 1.96 * standardError, 1),
      };
      statisticallyClear = confidenceInterval.lower > 0 || confidenceInterval.upper < 0;
    }
  }
  const target = num(experiment.target);
  const targetMet = currentValue != null && target != null && (isScore ? currentValue >= target : currentValue <= target);
  const complete = measured.length >= targetTrips;
  return {
    tripCount: measured.length,
    targetTrips,
    progressPct: Math.min(100, Math.round(measured.length / targetTrips * 100)),
    currentValue,
    improvement,
    targetMet,
    complete,
    tripIds: measured.map((trip) => trip.id),
    excludedTripCount: afterStart.length - comparable.length,
    confidenceInterval,
    statisticallyClear,
    validity: !complete ? 'collecting' : statisticallyClear ? 'strong signal' : distance(measured) >= 30 ? 'directional' : 'developing',
    status: complete ? (targetMet ? 'validated' : 'finished') : 'active',
  };
}

export function buildAdvancedInsightIntelligence(analysis, settings = {}, options = {}) {
  const allTrips = options.allTrips || [...analysis.currentTrips, ...analysis.previousTrips];
  const driverHistory = excludePrivacyTouchedDaysFromTrends(allTrips).filter((trip) => (
    trip.status === 'completed' && isDriverMetricEligible(trip)
  ));
  const habitProfile = buildHabitProfile(driverHistory);
  const forecast = computePreTripRisk(driverHistory, settings, null, {
    now: options.now || new Date(),
    nearbyDangerZoneCount: analysis.hotspots.length,
  }, habitProfile);
  return {
    matched: matchTrips(analysis.currentTrips, analysis.previousTrips),
    attribution: contributionLedger(analysis.currentTrips),
    changePoint: changePointFor(driverHistory),
    forecast,
    eventEvidence: eventEvidenceFor(analysis.currentTrips),
  };
}

export function answerDriveQuestion(question, analysis, intelligence) {
  const query = String(question || '').trim().toLowerCase();
  const citations = [];
  const supportedTerms = ['why', 'score', 'safe', 'route', 'brak', 'phone', 'improv', 'better', 'worse', 'risk', 'next', 'ready'];
  if (!query || !supportedTerms.some((term) => query.includes(term))) {
    return {
      title: 'Question not supported locally',
      answer: 'Choose one of the supported questions about score changes, improvement, routes, braking, phone use, or next-drive risk.',
      citations,
      localOnly: true,
      supported: false,
    };
  }
  let answer = '';
  let title = 'Current driving summary';
  if (query.includes('why') || query.includes('score')) {
    const top = intelligence.attribution.rows.slice(0, 2);
    title = 'Why the score moved';
    answer = top.length
      ? `${top.map((row) => `${row.label} accounts for ${row.averageDeficit} missing headline points`).join('; ')}. The reconstructed blend is ${intelligence.attribution.reconstructedScore}, compared with ${intelligence.attribution.recordedScore} recorded.`
      : analysis.primaryFinding.explanation;
    citations.push(...analysis.evidenceTrips.slice(0, 3).map((trip) => ({ tripId: trip.id, label: `${trip.eventCount} events` })));
  } else if (query.includes('safe') || query.includes('route')) {
    const route = [...analysis.routes].filter((row) => row.avg_score != null).sort((a, b) => b.avg_score - a.avg_score)[0];
    title = 'Safest repeated route';
    answer = route
      ? `${route.label} is the strongest repeated route at ${route.avg_score} average across ${route.trip_count} matched trips, usually strongest near ${route.safest_time}.`
      : 'There is not enough repeated-route evidence yet.';
    if (route?.last_trip_id) citations.push({ tripId: route.last_trip_id, label: 'Latest matched route' });
  } else if (query.includes('brak')) {
    const braking = analysis.eventMovement.find((row) => row.id === 'harsh_brakes');
    title = 'Braking evidence';
    answer = braking?.currentRate == null
      ? 'There is not enough scored distance to calculate a braking rate.'
      : `Harsh braking is ${braking.currentRate} events per 100 km in this period (${braking.currentCount} events). The comparable-period direction is ${braking.direction}.`;
    citations.push(...intelligence.eventEvidence.filter((row) => row.type === 'harsh_brake').slice(0, 3)
      .map((row) => ({ tripId: row.tripId, eventId: row.id, label: new Date(row.timestamp).toLocaleDateString() })));
  } else if (query.includes('phone')) {
    const phone = analysis.phoneUseSummary;
    title = 'Phone-use evidence';
    answer = `${phone.totalWindows || 0} confirmed phone-use windows were recorded across ${phone.measuredTrips || 0} measured trips. Coverage is ${phone.coveragePct || 0}%, and the recent trend is ${phone.trendDirection || 'unavailable'}.`;
    if (phone.latestPhoneUseTrip?.tripId) citations.push({ tripId: phone.latestPhoneUseTrip.tripId, label: 'Latest confirmed use' });
  } else if (query.includes('improv') || query.includes('better') || query.includes('worse')) {
    const matched = intelligence.matched;
    title = 'Matched-trip improvement';
    answer = matched.matchedTripCount
      ? `Across ${matched.matchedTripCount} comparable trip pairs, score changed ${matched.scoreDelta > 0 ? '+' : ''}${matched.scoreDelta} points and event density changed ${matched.eventRateDelta > 0 ? '+' : ''}${matched.eventRateDelta} per 100 km. Confidence is ${matched.confidence}.`
      : 'No sufficiently similar trip pairs are available in the adjacent periods.';
    citations.push(...matched.pairs.slice(0, 3).map((pair) => ({ tripId: pair.currentTripId, label: `${pair.matchQuality}% match` })));
  } else if (query.includes('risk') || query.includes('next') || query.includes('ready')) {
    const forecast = intelligence.forecast;
    title = 'Pre-drive readiness forecast';
    answer = forecast.readinessScore == null
      ? 'The readiness forecast is unavailable because core personal-history signals are still missing.'
      : `Readiness is ${forecast.readinessScore}/100 (${forecast.riskLevel} risk). The primary concern is ${forecast.primaryConcern.toLowerCase()}. ${forecast.tipText}`;
    citations.push(...analysis.currentTrips.slice(0, 3).map((trip) => (
      { tripId: trip.id, label: 'Recent forecast evidence' }
    )));
  } else {
    answer = `${analysis.primaryFinding.headline}. ${analysis.primaryFinding.explanation}`;
    citations.push(...analysis.evidenceTrips.slice(0, 3).map((trip) => ({ tripId: trip.id, label: `${trip.eventCount} events` })));
  }
  return { title, answer, citations, localOnly: true, supported: true };
}
