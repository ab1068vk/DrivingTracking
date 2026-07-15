import { buildDangerZones } from '@/lib/dangerZoneEngine';
import { routeKeyForTrip } from '@/lib/commuteMatching';
import { excludePrivacyTouchedDaysFromTrends } from '@/lib/privateTripMode';
import { buildVehicleMaintenancePlan } from '@/lib/vehicleMaintenance';
export { COMMUTE_MATCH_RADIUS_M, routeKeyForTrip } from '@/lib/commuteMatching';

const DAY_MS = 86400000;

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const startOfWeek = (value = new Date()) => {
  const date = startOfDay(value);
  date.setDate(date.getDate() - date.getDay());
  return date;
};

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

const distanceWeightedScore = (trips = [], field = 'score_overall') => {
  const scored = trips
    .map((trip) => ({
      score: Number(trip?.[field]),
      distance: Number(trip?.distance_km) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  const totalKm = scored.reduce((sum, item) => sum + item.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm
    : null;
};

const eventRiskDefinitions = [
  {
    id: 'harsh_brakes',
    label: 'Harsh braking',
    field: 'harsh_brakes_count',
    coaching: 'Brake earlier for the next five stops and leave one extra car length before intersections.',
  },
  {
    id: 'rapid_accel',
    label: 'Rapid acceleration',
    field: 'rapid_accel_count',
    coaching: 'Use a three-second throttle ramp after stops so launches stay smoother.',
  },
  {
    id: 'sharp_turns',
    label: 'Sharp turns',
    field: 'sharp_turns_count',
    coaching: 'Set corner speed before turning, then accelerate only as the wheel straightens.',
  },
  {
    id: 'speeding',
    label: 'Speeding',
    field: 'speeding_events_count',
    coaching: 'Pick a cruise target 5 km/h below your alert threshold on repeated routes.',
  },
];

const scoreDeltaSummary = (currentScore, previousScore) => {
  if (currentScore == null || previousScore == null) {
    return { delta: null, direction: 'developing', label: 'More baseline needed' };
  }
  const delta = Math.round(currentScore - previousScore);
  return {
    delta,
    direction: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
    label: delta === 0 ? 'No change' : `${delta > 0 ? '+' : ''}${delta} pts`,
  };
};

const timeBucketLabel = (dateInput) => {
  const date = new Date(dateInput);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const minutes = date.getHours() * 60 + date.getMinutes();
  const bucket = Math.round(minutes / 30) * 30;
  const h = Math.floor(bucket / 60) % 24;
  const m = bucket % 60;
  const labelDate = new Date(date);
  labelDate.setHours(h, m, 0, 0);
  return labelDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const inferRouteLabel = (trips = []) => {
  const hours = trips
    .map((trip) => new Date(trip.start_time).getHours())
    .filter((hour) => Number.isFinite(hour));
  const avgHour = average(hours) ?? 12;
  const weekdays = trips.filter((trip) => {
    const day = new Date(trip.start_time).getDay();
    return day >= 1 && day <= 5;
  }).length;
  const avgDistance = average(trips.map((trip) => Number(trip.distance_km) || 0)) ?? 0;

  if (weekdays / Math.max(1, trips.length) >= 0.65 && avgHour >= 5 && avgHour < 11) return 'Morning commute';
  if (weekdays / Math.max(1, trips.length) >= 0.65 && avgHour >= 15 && avgHour < 20) return 'Evening commute';
  if (avgDistance <= 8 && avgHour >= 16 && avgHour <= 22) return 'Gym route';
  if (avgDistance <= 10) return 'Errand route';
  return 'Repeated route';
};

export function buildRouteComparisons(trips = []) {
  const groups = new Map();
  excludePrivacyTouchedDaysFromTrends(trips)
    .filter((trip) => trip.status === 'completed')
    .forEach((trip) => {
      const key = routeKeyForTrip(trip);
      if (!key) return;
      const group = groups.get(key) || [];
      group.push(trip);
      groups.set(key, group);
    });

  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([routeKey, group]) => {
      const sorted = [...group].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      const scores = sorted.map((trip) => Number(trip.score_overall)).filter(Number.isFinite);
      const distanceValues = sorted.map((trip) => Number(trip.distance_km) || 0);
      const durationValues = sorted.map((trip) => Number(trip.duration_seconds) || 0);
      const byWindow = new Map();
      sorted.forEach((trip) => {
        const label = timeBucketLabel(trip.start_time);
        const current = byWindow.get(label) || [];
        const score = Number(trip.score_overall);
        if (Number.isFinite(score)) current.push(score);
        byWindow.set(label, current);
      });
      const bestWindow = [...byWindow.entries()]
        .map(([label, values]) => ({ label, avg: average(values), count: values.length }))
        .filter((window) => window.avg != null)
        .sort((a, b) => b.avg - a.avg || b.count - a.count)[0] || null;
      const recent = sorted.slice(-3);
      const firstAvg = distanceWeightedScore(sorted.slice(0, Math.min(3, sorted.length)));
      const recentAvg = distanceWeightedScore(recent);
      const avgScore = distanceWeightedScore(sorted);
      return {
        route_key: routeKey,
        label: inferRouteLabel(sorted),
        trip_count: sorted.length,
        avg_score: avgScore == null ? null : Math.round(avgScore),
        best_score: scores.length ? Math.max(...scores) : null,
        worst_score: scores.length ? Math.min(...scores) : null,
        avg_distance_km: Math.round((average(distanceValues) || 0) * 10) / 10,
        avg_duration_minutes: Math.round((average(durationValues) || 0) / 60),
        safest_time: bestWindow?.label || 'More trips needed',
        safest_time_score: bestWindow ? Math.round(bestWindow.avg) : null,
        trend: recentAvg != null && firstAvg != null && recentAvg > firstAvg + 3 ? 'improving' : recentAvg != null && firstAvg != null && recentAvg < firstAvg - 3 ? 'declining' : 'stable',
        last_trip_id: sorted[sorted.length - 1]?.id,
      };
    })
    .sort((a, b) => b.trip_count - a.trip_count || (b.avg_score ?? Number.NEGATIVE_INFINITY) - (a.avg_score ?? Number.NEGATIVE_INFINITY));
}

export function buildCommuteDetections(trips = []) {
  return buildRouteComparisons(trips)
    .filter((route) => (
      route.label === 'Morning commute' ||
      route.label === 'Evening commute' ||
      route.label === 'Gym route'
    ))
    .map((route) => ({
      id: route.route_key,
      label: route.label,
      trip_count: route.trip_count,
      avg_score: route.avg_score,
      avg_distance_km: route.avg_distance_km,
      usual_time: route.safest_time,
      safest_time_score: route.safest_time_score,
      trend: route.trend,
      last_trip_id: route.last_trip_id,
      explanation: route.label === 'Gym route'
        ? 'Repeated short evening route inferred from timing and distance.'
        : 'Repeated weekday route inferred from similar start and end areas.',
    }));
}

export function buildTripCalendarMonth(trips = [], monthDate = new Date()) {
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const firstGridDay = startOfDay(monthStart);
  firstGridDay.setDate(firstGridDay.getDate() - firstGridDay.getDay());
  const days = [];
  const completed = excludePrivacyTouchedDaysFromTrends(trips)
    .filter((trip) => trip.status === 'completed');

  for (let i = 0; i < 42; i++) {
    const date = new Date(firstGridDay.getTime() + i * DAY_MS);
    const dayTrips = completed.filter((trip) => startOfDay(trip.start_time).getTime() === date.getTime());
    const scores = dayTrips.map((trip) => Number(trip.score_overall)).filter(Number.isFinite);
    days.push({
      key: date.toISOString().slice(0, 10),
      date,
      inMonth: date.getMonth() === monthStart.getMonth(),
      trip_count: dayTrips.length,
      distance_km: Math.round(dayTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
      avg_score: distanceWeightedScore(dayTrips) == null ? null : Math.round(distanceWeightedScore(dayTrips)),
      best_score: scores.length ? Math.max(...scores) : null,
      worst_score: scores.length ? Math.min(...scores) : null,
    });
  }

  const monthDays = days.filter((day) => day.inMonth);
  const driveDays = monthDays.filter((day) => day.trip_count > 0);
  let currentStreak = 0;
  let bestStreak = 0;
  monthDays.forEach((day) => {
    if (day.trip_count > 0) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  });

  const scoredDriveDays = driveDays.filter((day) => day.avg_score != null);
  const bestDay = [...scoredDriveDays].sort((a, b) => b.avg_score - a.avg_score)[0] || null;
  const worstDay = [...scoredDriveDays].sort((a, b) => a.avg_score - b.avg_score)[0] || null;

  return {
    label: monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    days,
    drive_days: driveDays.length,
    total_distance_km: Math.round(driveDays.reduce((sum, day) => sum + day.distance_km, 0) * 10) / 10,
    best_day: bestDay,
    worst_day: worstDay,
    best_streak_days: bestStreak,
  };
}

export function buildWeeklyDriverSummary(trips = [], settings = {}) {
  const weekStart = startOfWeek();
  const trendTrips = excludePrivacyTouchedDaysFromTrends(trips);
  const completed = trendTrips.filter((trip) => (
    trip.status === 'completed' &&
    new Date(trip.start_time).getTime() >= weekStart.getTime()
  ));
  const previousStart = new Date(weekStart.getTime() - 7 * DAY_MS);
  const previous = trendTrips.filter((trip) => {
    const time = new Date(trip.start_time).getTime();
    return trip.status === 'completed' && time >= previousStart.getTime() && time < weekStart.getTime();
  });
  const totalDistance = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const byDay = new Map();
  completed.forEach((trip) => {
    const key = new Date(trip.start_time).toLocaleDateString(undefined, { weekday: 'long' });
    const current = byDay.get(key) || [];
    current.push(trip);
    byDay.set(key, current);
  });
  const dayScores = [...byDay.entries()].map(([day, dayTrips]) => ({
    day,
    avg_score: distanceWeightedScore(dayTrips) == null ? null : Math.round(distanceWeightedScore(dayTrips)),
  }));
  const bestDay = dayScores
    .filter((day) => day.avg_score != null)
    .sort((a, b) => b.avg_score - a.avg_score)[0]?.day || 'More trips needed';
  const issueCounts = {
    'late braking': completed.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    'sharp turns': completed.reduce((sum, trip) => sum + (trip.sharp_turns_count || 0), 0),
    speeding: completed.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0),
    acceleration: completed.reduce((sum, trip) => sum + (trip.rapid_accel_count || 0), 0),
  };
  const mainIssue = Object.entries(issueCounts).sort((a, b) => b[1] - a[1])[0];
  const avgFor = (items, field) => average(
    items
      .map((trip) => trip[field])
      .filter((value) => value != null && value !== '')
      .map(Number)
      .filter(Number.isFinite)
  );
  const improvementFor = (label, field) => {
    const current = avgFor(completed, field);
    const baseline = avgFor(previous, field);
    return current == null || baseline == null ? null : { label, delta: current - baseline };
  };
  const improvements = previous.length === 0 ? [] : [
    improvementFor('smoother turns', 'cornering_consistency_score'),
    improvementFor('better braking', 'braking_efficiency_score'),
    improvementFor('steadier speed', 'svi_score'),
    improvementFor('higher safety score', 'score_safety'),
  ].filter(Boolean).sort((a, b) => b.delta - a.delta);

  return {
    trip_count: completed.length,
    distance_km: Math.round(totalDistance * 10) / 10,
    best_day: bestDay,
    main_issue: mainIssue?.[1] > 0 ? mainIssue[0] : 'no major risk pattern',
    biggest_improvement: improvements[0]?.delta > 0 ? improvements[0].label : 'more trips needed',
    avg_score: completed.length ? (distanceWeightedScore(completed) == null ? null : Math.round(distanceWeightedScore(completed))) : null,
    night_distance_km: Math.round(completed.filter((trip) => trip.night_driving).reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
    goals: buildGoalStatus(completed, settings),
  };
}

export function buildGoalStatus(weekTrips = [], settings = {}) {
  const trendTrips = excludePrivacyTouchedDaysFromTrends(weekTrips);
  const harshBrakes = trendTrips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const weightedScore = distanceWeightedScore(trendTrips);
  const avgScore = weightedScore == null ? null : Math.round(weightedScore);
  const nightKm = trendTrips
    .filter((trip) => trip.night_driving)
    .reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const harshBrakeTarget = Number(settings.weekly_goal_harsh_brakes ?? 0);
  const minAverageScore = Number(settings.weekly_goal_min_avg_score ?? 85);
  const maxNightKm = Number(settings.weekly_goal_max_night_km ?? 20);
  const weekDistanceKm = trendTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const minimumTrips = Math.max(1, Number(settings.weekly_goal_min_trips ?? 3));
  const minimumDistanceKm = Math.max(1, Number(settings.weekly_goal_min_distance_km ?? 25));
  const qualified = trendTrips.length >= minimumTrips && weekDistanceKm >= minimumDistanceKm;
  const evidence = {
    qualified,
    trips: trendTrips.length,
    distance_km: Math.round(weekDistanceKm * 10) / 10,
    minimum_trips: minimumTrips,
    minimum_distance_km: minimumDistanceKm,
  };
  const goalState = (conditionMet) => ({
    met: qualified && conditionMet,
    qualified,
    status: !qualified ? 'building_evidence' : conditionMet ? 'met' : 'needs_attention',
    evidence,
  });
  return [
    {
      id: 'no_harsh_braking',
      label:
        harshBrakeTarget === 0
          ? 'No harsh braking this week'
          : `Keep harsh braking at ${harshBrakeTarget} or less`,
      value: harshBrakes,
      target: harshBrakeTarget,
      ...goalState(harshBrakes <= harshBrakeTarget),
      display: qualified ? `${harshBrakes}/${harshBrakeTarget}` : `${trendTrips.length}/${minimumTrips} trips · ${Math.round(weekDistanceKm * 10) / 10}/${minimumDistanceKm} km`,
    },
    {
      id: 'average_score',
      label: `Keep average score above ${minAverageScore}`,
      value: avgScore,
      target: minAverageScore,
      ...goalState(weightedScore != null && avgScore >= minAverageScore),
      display: qualified && weightedScore != null ? `${avgScore}/${minAverageScore}` : `${trendTrips.length}/${minimumTrips} trips · ${Math.round(weekDistanceKm * 10) / 10}/${minimumDistanceKm} km`,
    },
    {
      id: 'night_distance',
      label: `Drive under ${maxNightKm} km at night`,
      value: Math.round(nightKm * 10) / 10,
      target: maxNightKm,
      ...goalState(nightKm <= maxNightKm),
      display: qualified ? `${Math.round(nightKm * 10) / 10}/${maxNightKm} km` : `${trendTrips.length}/${minimumTrips} trips · ${Math.round(weekDistanceKm * 10) / 10}/${minimumDistanceKm} km`,
    },
  ];
}

export function buildDriverInsightBrief(trips = [], settings = {}, options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const trendTrips = excludePrivacyTouchedDaysFromTrends(trips);
  const completed = trendTrips
    .filter((trip) => trip.status === 'completed')
    .sort((a, b) => new Date(b.start_time || b.created_at || 0).getTime() - new Date(a.start_time || a.created_at || 0).getTime());
  const driverTrips = options.driverTrips || completed;
  const driverCompleted = driverTrips
    .filter((trip) => trip.status === 'completed')
    .sort((a, b) => new Date(b.start_time || b.created_at || 0).getTime() - new Date(a.start_time || a.created_at || 0).getTime());
  const totalDistanceKm = driverCompleted.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const currentStartMs = nowMs - 7 * DAY_MS;
  const previousStartMs = nowMs - 14 * DAY_MS;
  let currentTrips = driverCompleted.filter((trip) => {
    const time = new Date(trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(time) && time >= currentStartMs && time <= nowMs;
  });
  let previousTrips = driverCompleted.filter((trip) => {
    const time = new Date(trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(time) && time >= previousStartMs && time < currentStartMs;
  });

  if (currentTrips.length === 0 && driverCompleted.length > 0) {
    currentTrips = driverCompleted.slice(0, 5);
    previousTrips = driverCompleted.slice(5, 10);
  }

  const averageScore = distanceWeightedScore(driverCompleted);
  const currentScore = distanceWeightedScore(currentTrips);
  const previousScore = distanceWeightedScore(previousTrips);
  const scoreTrend = scoreDeltaSummary(
    currentScore == null ? null : Math.round(currentScore),
    previousScore == null ? null : Math.round(previousScore)
  );
  const riskRows = eventRiskDefinitions.map((definition) => {
    const count = driverCompleted.reduce((sum, trip) => sum + (Number(trip[definition.field]) || 0), 0);
    return {
      ...definition,
      count,
      per100km: totalDistanceKm > 0 ? Math.round((count / totalDistanceKm) * 1000) / 10 : null,
    };
  });
  const totalRiskEvents = riskRows.reduce((sum, row) => sum + row.count, 0);
  const topRisk = riskRows
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || (b.per100km || 0) - (a.per100km || 0))[0] || null;
  const roadTypes = buildRoadTypeBreakdown(driverCompleted).filter((road) => road.avg_score != null && road.trip_count >= 1);
  const strongestContext = [...roadTypes].sort((a, b) => b.avg_score - a.avg_score || b.distance_km - a.distance_km)[0] || null;
  const weakestContextCandidate = [...roadTypes].sort((a, b) => a.avg_score - b.avg_score || b.risk_events - a.risk_events)[0] || null;
  const weakestContext = weakestContextCandidate && (
    roadTypes.length > 1 ||
    weakestContextCandidate.risk_events > 0 ||
    weakestContextCandidate.avg_score < 80
  )
    ? weakestContextCandidate
    : null;
  const routes = buildRouteComparisons(driverCompleted);
  const routeOpportunity = routes
    .filter((route) => route.trend === 'declining' || (route.avg_score != null && route.avg_score < 80))
    .sort((a, b) => (
      (a.trend === 'declining' ? -1 : 0) - (b.trend === 'declining' ? -1 : 0) ||
      (a.avg_score ?? 100) - (b.avg_score ?? 100)
    ))[0] || null;
  const weekStart = startOfWeek(new Date(nowMs));
  const weekTrips = driverCompleted.filter((trip) => {
    const time = new Date(trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(time) && time >= weekStart.getTime() && time <= nowMs;
  });
  const unmetGoal = buildGoalStatus(weekTrips, settings).find((goal) => !goal.met) || null;
  const phoneUseSummary = options.phoneUseSummary || null;

  const actions = [];
  if (phoneUseSummary && ['medium', 'high'].includes(phoneUseSummary.worstRisk)) {
    actions.push({
      id: 'phone_use',
      priority: 'high',
      title: 'Remove phone-use exposure first',
      detail: `${phoneUseSummary.tripsWithConfirmedUse} trip${phoneUseSummary.tripsWithConfirmedUse === 1 ? '' : 's'} include confirmed phone-use windows. Set navigation/audio before moving and use Do Not Disturb.`,
      metric: `${phoneUseSummary.coveragePct}% Usage Access coverage`,
    });
  }
  if (topRisk) {
    actions.push({
      id: topRisk.id,
      priority: topRisk.per100km != null && topRisk.per100km >= 10 ? 'high' : 'medium',
      title: `Reduce ${topRisk.label.toLowerCase()}`,
      detail: topRisk.coaching,
      metric: `${topRisk.count} event${topRisk.count === 1 ? '' : 's'}${topRisk.per100km == null ? '' : `, ${topRisk.per100km} per 100 km`}`,
    });
  }
  if (routeOpportunity) {
    actions.push({
      id: 'route_opportunity',
      priority: routeOpportunity.trend === 'declining' ? 'medium' : 'low',
      title: `Review ${routeOpportunity.label.toLowerCase()}`,
      detail: `This repeated route averages ${Math.round(routeOpportunity.avg_score)} and is usually strongest near ${routeOpportunity.safest_time}. Open the latest trip to compare timing and events.`,
      metric: `${routeOpportunity.trip_count} matched trips`,
      tripId: routeOpportunity.last_trip_id,
    });
  }
  if (unmetGoal) {
    actions.push({
      id: `goal_${unmetGoal.id}`,
      priority: 'medium',
      title: 'Protect this week\'s goal',
      detail: unmetGoal.label,
      metric: unmetGoal.display,
    });
  }
  if (actions.length === 0 && strongestContext) {
    actions.push({
      id: 'protect_strength',
      priority: 'low',
      title: `Repeat your ${strongestContext.label.toLowerCase()} pattern`,
      detail: 'Your strongest context is a useful baseline. Compare tougher trips against its speed, braking, and route timing.',
      metric: `${strongestContext.trip_count} trip${strongestContext.trip_count === 1 ? '' : 's'}, avg ${strongestContext.avg_score}`,
    });
  }

  const confidence = driverCompleted.length >= 10 && totalDistanceKm >= 50
    ? 'strong'
    : driverCompleted.length >= 3
      ? 'moderate'
      : 'developing';
  const headline = driverCompleted.length === 0
    ? 'Complete a few trips to unlock a personalized brief.'
    : actions[0]?.title || 'Keep building a clean driving baseline';

  return {
    headline,
    confidence,
    trip_count: driverCompleted.length,
    distance_km: Math.round(totalDistanceKm * 10) / 10,
    average_score: averageScore == null ? null : Math.round(averageScore),
    current_period: {
      trip_count: currentTrips.length,
      avg_score: currentScore == null ? null : Math.round(currentScore),
    },
    previous_period: {
      trip_count: previousTrips.length,
      avg_score: previousScore == null ? null : Math.round(previousScore),
    },
    score_trend: scoreTrend,
    risk_event_rate: {
      total_events: totalRiskEvents,
      per100km: totalDistanceKm > 0 ? Math.round((totalRiskEvents / totalDistanceKm) * 1000) / 10 : null,
      rows: riskRows,
    },
    top_risk: topRisk,
    strongest_context: strongestContext,
    weakest_context: weakestContext,
    route_opportunity: routeOpportunity,
    actions: actions.slice(0, 4),
    evidence: [
      `${driverCompleted.length} driver trip${driverCompleted.length === 1 ? '' : 's'}`,
      `${Math.round(totalDistanceKm * 10) / 10} km`,
      confidence === 'strong' ? 'strong evidence' : confidence === 'moderate' ? 'moderate evidence' : 'developing evidence',
    ],
  };
}

const roadTypeForTrip = (trip = {}) => {
  if ((trip.parking_stop_duration_seconds || 0) >= 180 || trip.parking_approach_grade === 'rough') return 'parking';
  if (trip.dominant_road_type) return trip.dominant_road_type;
  if (trip.road_type) return trip.road_type;
  if ((trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0) > 85) return 'highway';
  if ((trip.distance_km || 0) > 25 && (trip.stop_count || 0) <= 2) return 'rural';
  return 'city';
};

export function buildRoadTypeBreakdown(trips = []) {
  const labels = {
    city: 'City',
    urban: 'City',
    highway: 'Highway',
    residential: 'Residential',
    rural: 'Rural',
    parking: 'Parking areas',
    mixed: 'Mixed',
  };
  const groups = new Map();
  trips.filter((trip) => trip.status === 'completed').forEach((trip) => {
    const key = roadTypeForTrip(trip);
    const current = groups.get(key) || [];
    current.push(trip);
    groups.set(key, current);
  });

  return [...groups.entries()].map(([key, group]) => ({
    id: key,
    label: labels[key] || key,
    trip_count: group.length,
    avg_score: distanceWeightedScore(group) == null ? null : Math.round(distanceWeightedScore(group)),
    avg_safety: average(group.map((trip) => Number(trip.score_safety)).filter(Number.isFinite)) == null ? null : Math.round(average(group.map((trip) => Number(trip.score_safety)).filter(Number.isFinite))),
    distance_km: Math.round(group.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
    risk_events: group.reduce((sum, trip) => sum +
      (trip.harsh_brakes_count || 0) +
      (trip.rapid_accel_count || 0) +
      (trip.sharp_turns_count || 0) +
      (trip.speeding_events_count || 0), 0),
  })).sort((a, b) => b.distance_km - a.distance_km);
}

export function buildRiskHotspots(trips = []) {
  return buildDangerZones(trips, {
    eventTypes: ['harsh_brake', 'sharp_turn', 'speeding'],
    minEvents: 2,
  });
}

export function buildVehicleCostSummary(vehicle = {}, trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const totalDistance = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const fuelLiters = completed.reduce((sum, trip) => {
    const lPer100 = Number(vehicle.fuel_efficiency_l_per_100km) || 8.5;
    return sum + ((Number(trip.distance_km) || 0) * lPer100 / 100);
  }, 0);
  const fuelCost = fuelLiters * (Number(vehicle.fuel_price_per_liter) || 1.65);
  const reservePerKm = Number(vehicle.maintenance_reserve_per_km) || 0.08;
  const maintenanceReserve = totalDistance * reservePerKm;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthTrips = completed.filter((trip) => new Date(trip.start_time).getTime() >= monthStart.getTime());
  const monthlyDistance = monthTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const monthlyFuelCost = monthlyDistance * (Number(vehicle.fuel_efficiency_l_per_100km) || 8.5) / 100 * (Number(vehicle.fuel_price_per_liter) || 1.65);
  const monthlyReserve = monthlyDistance * reservePerKm;
  const totalCost = fuelCost + maintenanceReserve;

  return {
    total_distance_km: Math.round(totalDistance * 10) / 10,
    fuel_liters: Math.round(fuelLiters * 10) / 10,
    fuel_cost: Math.round(fuelCost * 100) / 100,
    maintenance_reserve: Math.round(maintenanceReserve * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    cost_per_km: totalDistance > 0 ? Math.round((totalCost / totalDistance) * 100) / 100 : 0,
    monthly_cost: Math.round((monthlyFuelCost + monthlyReserve) * 100) / 100,
    monthly_distance_km: Math.round(monthlyDistance * 10) / 10,
    maintenance_reserve_per_km: reservePerKm,
  };
}

export function buildMaintenanceReminders(vehicle = {}, trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const distanceKm = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const anchoredDistanceKm = Number(vehicle.odometer_trip_distance_anchor_km) || 0;
  const odometerKm = Math.round((Number(vehicle.odometer_km) || 0) + Math.max(0, distanceKm - anchoredDistanceKm));
  const plan = buildVehicleMaintenancePlan(vehicle, { odometerKm });
  const severity = { due: 0, soon: 1, needs_confirmation: 2, needs_baseline: 3, needs_source: 4, ok: 5 };
  return plan.items
    .map((item) => ({
      ...item,
      type: item.interval_km > 0 && item.interval_months > 0
        ? 'distance_and_time'
        : item.interval_months > 0 ? 'time' : 'distance',
    }))
    .sort((a, b) => (severity[a.status] ?? 9) - (severity[b.status] ?? 9));
}
