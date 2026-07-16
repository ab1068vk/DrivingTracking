import { isDriverMetricEligible, summarizePhoneUseAcrossTrips } from '@/lib/phoneUseSummary';
import { tripTouchesPrivacyZoneForTrend } from '@/lib/privateTripMode';
import { scoringValue } from '@/lib/scoringConstants';
import {
  buildDriverSignature, buildDrivingCoachInsights, calculateDrivingConsistency,
  calculatePeakHourStress, calculateRiskEventRate, computePersonalBaseline,
} from '@/lib/tripInsights';
import {
  buildDriverInsightBrief, buildRiskHotspots, buildRoadTypeBreakdown, buildRouteComparisons,
} from '@/lib/mediumInsights';

const DAY_MS = 86400000;
const COMPONENTS = [
  ['safety', 'Safety', 'score_safety', 'safety'],
  ['smoothness', 'Smoothness', 'score_smoothness', 'smoothness'],
  ['intersection', 'Intersection approach', 'intersection_score', 'intersection'],
  ['eco', 'Eco estimate', 'score_eco', 'eco', true],
];
const EVENTS = [
  ['harsh_brakes', 'Harsh braking', 'harsh_brakes_count', 'Begin braking earlier and leave more space before the next three stops.'],
  ['rapid_accel', 'Rapid acceleration', 'rapid_accel_count', 'Use a steady three-second throttle ramp after stops.'],
  ['sharp_turns', 'Sharp turns', 'sharp_turns_count', 'Set corner speed before turning and accelerate as the wheel straightens.'],
  ['speeding', 'Speeding', 'speeding_events_count', 'Choose a cruise target below the alert threshold before moving.'],
];
const num = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, places = 1) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const tripTime = (trip = {}) => new Date(trip.start_time || trip.created_at || 0).getTime();
const distance = (trips) => round(trips.reduce((sum, trip) => sum + Math.max(0, num(trip.distance_km) || 0), 0), 1) || 0;
const eventCount = (trips, field = null) => (field ? [field] : EVENTS.map((row) => row[2]))
  .reduce((total, key) => total + trips.reduce((sum, trip) => sum + Math.max(0, num(trip[key]) || 0), 0), 0);
const rate = (trips, field = null) => distance(trips) > 0 ? round(eventCount(trips, field) / distance(trips) * 100, 1) : null;
const score = (trips, field = 'score_overall') => {
  const rows = trips.map((trip) => ({ value: num(trip[field]), weight: Math.max(0.1, num(trip.distance_km) || 0.1) }))
    .filter((row) => row.value != null);
  if (!rows.length) return null;
  const weights = rows.reduce((sum, row) => sum + row.weight, 0);
  return round(rows.reduce((sum, row) => sum + row.value * row.weight, 0) / weights, 1);
};
const context = (id, label, type, trips) => ({
  id, label, type, tripCount: trips.length, distanceKm: distance(trips), score: score(trips),
  eventCount: eventCount(trips), eventRate: rate(trips),
  latestTripId: [...trips].sort((a, b) => tripTime(b) - tripTime(a))[0]?.id || null,
});

function contextsFor(trips) {
  const rows = [];
  const add = (id, label, type, matches) => matches.length && rows.push(context(id, label, type, matches));
  [
    ['morning', 'Morning', 5, 12], ['afternoon', 'Afternoon', 12, 17],
    ['evening', 'Evening', 17, 22], ['night', 'Night', 22, 29],
  ].forEach(([id, label, from, to]) => add(`time_${id}`, label, 'time', trips.filter((trip) => {
    const raw = new Date(trip.start_time).getHours();
    const hour = raw < 5 ? raw + 24 : raw;
    return hour >= from && hour < to;
  })));
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    .forEach((label, index) => add(`day_${index}`, label, 'day', trips.filter(
      (trip) => new Date(trip.start_time).getDay() === index
    )));
  const roadType = (trip) => {
    if ((num(trip.parking_stop_duration_seconds) || 0) >= 180 || trip.parking_approach_grade === 'rough') return 'parking';
    if (trip.dominant_road_type || trip.road_type) return trip.dominant_road_type || trip.road_type;
    if ((num(trip.avg_running_speed_kmh) || num(trip.avg_speed_kmh) || 0) > 85) return 'highway';
    if ((num(trip.distance_km) || 0) > 25 && (num(trip.stop_count) || 0) <= 2) return 'rural';
    return 'city';
  };
  const roadLabels = { city: 'City', urban: 'City', highway: 'Highway', residential: 'Residential', rural: 'Rural', parking: 'Parking areas', mixed: 'Mixed' };
  [...new Set(trips.map(roadType))].forEach((key) => add(
    `road_${key}`, roadLabels[key] || String(key).replace(/_/g, ' '), 'road', trips.filter((trip) => roadType(trip) === key)
  ));
  [...new Set(trips.map((trip) => trip.vehicle_id).filter(Boolean))].forEach((key, index) => {
    const matches = trips.filter((trip) => String(trip.vehicle_id) === String(key));
    add(`vehicle_${key}`, matches[0]?.vehicle_name || matches[0]?.vehicle_label || `Vehicle ${index + 1}`, 'vehicle', matches);
  });
  return rows;
}

function scoreMovement(current, previous) {
  const weights = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS') || {};
  const rows = COMPONENTS.map(([id, label, field, weightKey, separate]) => ({
    id, label, field, separate, current: score(current, field), previous: score(previous, field),
    weight: Math.max(0, num(weights[weightKey]) || 0),
  }));
  const totalWeight = rows.filter((row) => !row.separate && row.current != null && row.previous != null)
    .reduce((sum, row) => sum + row.weight, 0);
  return rows.map((row) => {
    const delta = row.current == null || row.previous == null ? null : round(row.current - row.previous, 1);
    return {
      id: row.id, label: row.label, current: row.current, previous: row.previous, delta,
      estimatedImpact: delta == null || row.separate || totalWeight <= 0 ? null : round(delta * row.weight / totalWeight, 1),
      isHeadlineComponent: !row.separate && row.weight > 0,
      note: row.separate ? 'Reported separately from the headline score' : null,
    };
  }).filter((row) => row.current != null || row.previous != null);
}

function eventMovement(current, previous) {
  return EVENTS.map(([id, label, field, cue]) => {
    const currentRate = rate(current, field);
    const previousRate = rate(previous, field);
    const delta = currentRate == null || previousRate == null ? null : round(currentRate - previousRate, 1);
    return {
      id, label, field, cue, currentRate, previousRate, delta,
      currentCount: eventCount(current, field), previousCount: eventCount(previous, field),
      deltaPct: delta == null || previousRate <= 0 ? null : Math.round(delta / previousRate * 100),
      direction: delta == null ? 'unknown' : delta > 0.5 ? 'worse' : delta < -0.5 ? 'better' : 'steady',
      latestTripId: [...current].sort((a, b) => tripTime(b) - tripTime(a)).find((trip) => (num(trip[field]) || 0) > 0)?.id || null,
    };
  });
}

function experimentFor(events, brief, coach) {
  const focus = events.filter((row) => row.currentCount > 0).sort((a, b) => (
    Number(b.direction === 'worse') - Number(a.direction === 'worse') || (b.currentRate || 0) - (a.currentRate || 0)
  ))[0];
  if (focus) return {
    id: focus.id, title: `Five-drive ${focus.label.toLowerCase()} reset`, focus: focus.label,
    metricKey: focus.field, metricLabel: `${focus.label} per 100 km`, baseline: focus.currentRate,
    target: focus.currentRate == null ? null : round(Math.max(0, focus.currentRate * 0.7), 1),
    targetTrips: 5, cue: focus.cue,
    steps: coach?.coach_brief?.drill?.steps || ['Choose one cue before starting.', 'Use it on five comparable drives.', 'Review the rate after drive five.'],
  };
  return {
    id: 'consistency', title: 'Five-drive consistency challenge', focus: 'Consistency',
    metricKey: 'score_overall', metricLabel: 'Average score', baseline: brief.average_score,
    target: brief.average_score == null ? null : Math.min(100, round(brief.average_score + 2, 1)),
    targetTrips: 5, cue: 'Repeat the setup, route timing, and opening pace from a strong trip.',
    steps: coach?.coach_brief?.drill?.steps || ['Pick a strong reference trip.', 'Match its opening pace.', 'Keep five scores inside your high range.'],
  };
}

function findingsFor({ baseline, signature, consistency, peak, routes, contexts, phone }) {
  const rows = [];
  if (baseline.delta != null && Math.abs(baseline.delta) >= 3) rows.push({
    id: 'baseline', tone: baseline.delta > 0 ? 'good' : 'warn',
    title: `${Math.abs(baseline.delta)} points ${baseline.delta > 0 ? 'above' : 'below'} personal baseline`,
    detail: `${baseline.baseline_trip_count} recent trips define this comparison.`,
  });
  if (peak.stress_ratio != null && peak.stress_ratio >= 1.3) rows.push({
    id: 'peak', tone: 'warn', title: `Rush-hour event rate is ${peak.stress_ratio}x off-peak`,
    detail: `${peak.peak_trip_count} peak and ${peak.off_peak_trip_count} off-peak trips compared.`,
  });
  if (phone.previousPeriod?.measuredTrips > 0 && phone.trendDirection !== 'steady') rows.push({
    id: 'phone', tone: phone.trendDirection === 'improving' ? 'good' : 'warn',
    title: `Phone-use exposure is ${phone.trendDirection}`, detail: `${Math.abs(phone.trendPct)}% change per measured trip.`,
  });
  const route = routes.find((row) => row.trend === 'declining');
  if (route) rows.push({
    id: 'route', tone: 'warn', title: `${route.label} is declining`,
    detail: `${route.trip_count} matched trips; strongest near ${route.safest_time}.`, tripId: route.last_trip_id,
  });
  const qualified = contexts.filter((row) => row.tripCount >= 2 && row.score != null);
  const best = [...qualified].sort((a, b) => b.score - a.score)[0];
  const worst = [...qualified].sort((a, b) => a.score - b.score)[0];
  if (best && worst && best.id !== worst.id && best.score - worst.score >= 5) rows.push({
    id: 'context', tone: 'neutral', title: `${best.label} outperforms ${worst.label} by ${round(best.score - worst.score, 0)} points`,
    detail: 'This is a comparison against your own recorded driving.',
  });
  if (signature?.style_shifts?.length) {
    const shift = signature.style_shifts[0];
    rows.push({
      id: 'signature', tone: 'neutral',
      title: `${String(shift.dimension).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')} is ${shift.direction}`,
      detail: `Recent driving differs from the prior signature by ${Math.round(shift.delta * 100)}%.`,
    });
  }
  if (consistency.consistency_score != null) rows.push({
    id: 'consistency', tone: consistency.consistency_score >= 80 ? 'good' : consistency.consistency_score < 60 ? 'warn' : 'neutral',
    title: `Consistency score: ${consistency.consistency_score}`, detail: `${consistency.trip_count} scored trips define the spread.`,
  });
  return rows.slice(0, 6);
}

export function buildAdvancedInsights(trips = [], settings = {}, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const periodDays = Math.max(7, Number(options.periodDays) || 30);
  const completed = trips.filter((trip) => trip.status === 'completed');
  const eligibleCompleted = completed.filter(isDriverMetricEligible)
    .sort((a, b) => tripTime(b) - tripTime(a));
  // Privacy-zone coordinates and events are already masked before these local
  // summaries are built. Keep their remaining evidence in Insights.
  const drivers = eligibleCompleted;
  const privacyProtectedTrips = drivers.filter(tripTouchesPrivacyZoneForTrend).length;
  const privacySafeSnapshot = false;
  const start = now.getTime() - periodDays * DAY_MS;
  let current = drivers.filter((trip) => tripTime(trip) >= start && tripTime(trip) <= now.getTime());
  let previous = drivers.filter((trip) => tripTime(trip) >= start - periodDays * DAY_MS && tripTime(trip) < start);
  const periodEmpty = current.length === 0;
  const phone = summarizePhoneUseAcrossTrips(current);
  const brief = buildDriverInsightBrief(current, settings, {
    now,
    driverTrips: current,
    phoneUseSummary: phone,
  });
  const coach = buildDrivingCoachInsights(current, settings);
  const baseline = computePersonalBaseline(drivers);
  const signature = buildDriverSignature(current);
  const consistency = calculateDrivingConsistency(current);
  const peak = calculatePeakHourStress(current);
  const routes = buildRouteComparisons(current);
  const contexts = contextsFor(current);
  const scoreRows = scoreMovement(current, previous);
  const eventRows = eventMovement(current, previous);
  const hotspots = buildRiskHotspots(current);
  const currentScore = score(current);
  const previousScore = score(previous);
  const scoreDelta = currentScore == null || previousScore == null ? null : round(currentScore - previousScore, 1);
  const currentRate = rate(current);
  const previousRate = rate(previous);
  const rateDelta = currentRate == null || previousRate == null ? null : round(currentRate - previousRate, 1);
  const comparison = current.length > 0 && previous.length > 0;
  const topEvent = [...eventRows].sort((a, b) => (
    Number(b.direction === 'worse') - Number(a.direction === 'worse') || (b.currentRate || 0) - (a.currentRate || 0)
  ))[0] || null;
  const confidence = current.length >= 10 && distance(current) >= 50 && previous.length >= 5
    ? 'strong' : current.length >= 3 && distance(current) >= 10 ? 'moderate' : 'developing';
  let headline = brief.headline;
  let explanation = coach?.coach_brief?.why || 'Road Sage is still building a comparable personal baseline.';
  let tone = 'neutral';
  if (periodEmpty) {
    headline = `No eligible trips in the last ${periodDays} days`;
    explanation = 'Choose a longer range or record another drive. Older trips stay in History and are no longer substituted into the selected range.';
    tone = 'neutral';
  } else if (comparison && scoreDelta != null && Math.abs(scoreDelta) >= 3) {
    headline = `Your score is ${Math.abs(scoreDelta)} points ${scoreDelta > 0 ? 'higher' : 'lower'} than the prior ${periodDays} days`;
    tone = scoreDelta > 0 ? 'good' : 'warn';
  } else if (comparison && rateDelta != null && Math.abs(rateDelta) >= 1) {
    headline = `Risk-event density is ${Math.abs(rateDelta)} per 100 km ${rateDelta < 0 ? 'lower' : 'higher'}`;
    tone = rateDelta < 0 ? 'good' : 'warn';
  } else if (topEvent?.currentCount > 0) {
    headline = `${topEvent.label} is the clearest current opportunity`;
    tone = 'warn';
  } else if (current.length) {
    headline = 'No dominant risk pattern is standing out';
    explanation = 'Recent trips are stable enough that consistency is the most useful target.';
    tone = 'good';
  }
  const evidenceTrips = topEvent ? current.filter((trip) => (num(trip[topEvent.field]) || 0) > 0)
    .sort((a, b) => (num(b[topEvent.field]) || 0) - (num(a[topEvent.field]) || 0) || tripTime(b) - tripTime(a))
    .slice(0, 4).map((trip) => ({
      id: trip.id, startTime: trip.start_time, score: num(trip.score_overall),
      eventCount: num(trip[topEvent.field]) || 0, distanceKm: num(trip.distance_km) || 0,
    })) : [];
  const routeTrips = current.filter((trip) => trip.route_replay_available || (num(trip.route_points_map_count) || 0) > 1).length;
  const scoredTrips = current.filter((trip) => num(trip.score_overall) != null).length;
  return {
    periodDays, periodEmpty, periodFallback: false, currentTrips: current, previousTrips: previous, currentScore, previousScore, scoreDelta, privacySafeSnapshot,
    currentEventRate: currentRate, previousEventRate: previousRate, eventRateDelta: rateDelta,
    comparisonAvailable: comparison, confidence,
    primaryFinding: {
      headline, explanation, tone,
      evidence: [`${current.length} driver trip${current.length === 1 ? '' : 's'}`, `${distance(current)} km`, `${confidence} confidence`],
      action: brief.actions[0] || null,
    },
    scoreMovement: scoreRows, eventMovement: eventRows, topEvent, evidenceTrips, routes,
    roadTypes: buildRoadTypeBreakdown(current), contexts, hotspots,
    experimentCandidate: experimentFor(eventRows, brief, coach),
    supportingFindings: findingsFor({ baseline, signature, consistency, peak, routes, contexts, phone }),
    baseline, signature, consistency, peakHourStress: peak,
    riskRate: calculateRiskEventRate(current), phoneUseSummary: phone,
    dataQuality: {
      scoredTrips, scoredCoveragePct: current.length ? Math.round(scoredTrips / current.length * 100) : 0,
      routeTrips, routeCoveragePct: current.length ? Math.round(routeTrips / current.length * 100) : 0,
      phoneCoveragePct: phone.coveragePct || 0, phoneMeasuredTrips: phone.measuredTrips || 0,
      privacyExcludedTrips: 0,
      privacyProtectedTrips,
      passengerExcludedTrips: Math.max(0, completed.length - eligibleCompleted.length),
      availableEligibleTrips: eligibleCompleted.length,
      trendEligibleTrips: drivers.length,
      privacySafeSnapshot,
      scoringConfidence: baseline.baseline_confidence, scoringVersion: baseline.baseline_score_version,
      hotspotCount: hotspots.length, hotspotEventCount: hotspots.reduce((sum, zone) => sum + zone.eventCount, 0),
    },
  };
}

export function buildInsightExperimentProgress(experiment, trips = []) {
  if (!experiment?.startedAt) return null;
  const measured = (Array.isArray(trips) ? trips : []).filter((trip) => (
    trip.status === 'completed' && isDriverMetricEligible(trip) && tripTime(trip) > new Date(experiment.startedAt).getTime()
  )).sort((a, b) => tripTime(a) - tripTime(b)).slice(0, Math.max(1, Number(experiment.targetTrips) || 3));
  const targetTrips = Math.max(1, Number(experiment.targetTrips) || 3);
  const isScore = experiment.metricKey === 'score_overall';
  const currentValue = isScore ? score(measured, experiment.metricKey) : rate(measured, experiment.metricKey);
  const baseline = num(experiment.baseline);
  const improvement = currentValue == null || baseline == null ? null : round(isScore ? currentValue - baseline : baseline - currentValue, 1);
  const target = num(experiment.target);
  const targetMet = currentValue != null && target != null && (isScore ? currentValue >= target : currentValue <= target);
  return {
    tripCount: measured.length, targetTrips, progressPct: Math.min(100, Math.round(measured.length / targetTrips * 100)),
    currentValue, improvement, targetMet, complete: measured.length >= targetTrips,
    tripIds: measured.map((trip) => trip.id),
    status: measured.length >= targetTrips ? (targetMet ? 'validated' : 'finished') : 'active',
  };
}
