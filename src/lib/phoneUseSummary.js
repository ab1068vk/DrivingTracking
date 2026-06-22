import { buildPhoneUseFromTripEvidence, PHONE_USE_PENALTY_POINTS } from '@/lib/phoneUsageAccess';
import { scoringValue } from '@/lib/scoringConstants';
import { excludePrivacyTouchedDaysFromTrends } from '@/lib/privateTripMode';

const riskRank = { none: 0, low: 1, medium: 2, high: 3 };
const eventPenaltyPoints = scoringValue('EVENT_PENALTY_POINTS');
const PHONE_USE_SUMMARY_VERSION = 1;
const CONTEXT_EVENT_WINDOW_MS = 30_000;

const numberOrZero = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const timestampMs = (value) => {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const routeDurationSeconds = (trip = {}) => {
  const explicit = Number(trip.duration_seconds ?? trip.wall_clock_duration_seconds);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const start = timestampMs(trip.start_time);
  const end = timestampMs(trip.end_time);
  return start != null && end != null && end > start ? Math.round((end - start) / 1000) : 0;
};

const average = (values = []) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
);

const titleCase = (value = '') => String(value)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const eventStartMs = (event = {}) => timestampMs(event.startTime || event.timestamp);

const eventSeverity = (event = {}) => (
  ['low', 'medium', 'high'].includes(event.severity) ? event.severity : 'low'
);

const eventPenalty = (event = {}) => (
  PHONE_USE_PENALTY_POINTS[eventSeverity(event)] ?? PHONE_USE_PENALTY_POINTS.low
);

const nearestRoutePoint = (routePoints = [], targetMs = null) => {
  if (targetMs == null) return null;
  let nearest = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  routePoints.forEach((point) => {
    const pointMs = timestampMs(point?.timestamp ?? point?.time);
    if (pointMs == null) return;
    const delta = Math.abs(pointMs - targetMs);
    if (delta < nearestDelta) {
      nearest = point;
      nearestDelta = delta;
    }
  });
  return nearestDelta <= CONTEXT_EVENT_WINDOW_MS ? nearest : null;
};

const isIntersectionPoint = (point = {}) => Boolean(
  point.intersection ||
  point.is_intersection ||
  point.near_intersection ||
  point.junction ||
  point.osm_junction
);

const packageMatches = (packageName, pattern) => pattern.test(String(packageName || '').toLowerCase());

export function classifyPhoneUseActivity(event = {}) {
  const explicit = String(event.activity_type || event.activityType || '').toLowerCase();
  if (explicit.includes('unlock')) return { key: 'unlock_or_screen_check', label: 'Unlock or screen check' };
  if (explicit.includes('call')) return { key: 'call', label: 'Call activity' };
  if (explicit.includes('message') || explicit.includes('text')) return { key: 'messaging', label: 'Messaging' };

  const packageName = event.package_name || event.packageName || '';
  if (packageMatches(packageName, /(dialer|incall|telecom|call)/)) {
    return { key: 'call', label: 'Call activity' };
  }
  if (packageMatches(packageName, /(message|messaging|sms|mms|whatsapp|telegram|signal|messenger|discord|snapchat)/)) {
    return { key: 'messaging', label: 'Messaging' };
  }
  if (packageMatches(packageName, /(instagram|facebook|tiktok|reddit|twitter|threads|browser|chrome|firefox|youtube)/)) {
    return { key: 'browsing_or_social', label: 'Browsing or social app' };
  }
  if (packageMatches(packageName, /(camera|gallery|photos)/)) {
    return { key: 'camera_or_media', label: 'Camera or media' };
  }
  return { key: 'other_foreground_app', label: 'Foreground app activity' };
}

export function isPassengerTrip(trip = {}, wasDriver = null) {
  const normalizedWasDriver = String(
    wasDriver ??
    trip.was_driver ??
    trip.wasDriver ??
    trip.driver_role ??
    trip.trip_role ??
    ''
  ).toLowerCase();
  return normalizedWasDriver === 'no' ||
    normalizedWasDriver === 'passenger' ||
    trip.passenger_trip === true ||
    (Array.isArray(trip.data_quality_flags) && trip.data_quality_flags.includes('passenger_trip'));
}

export const isDriverMetricEligible = (trip = {}) => (
  trip.excluded_from_driver_score !== true && !isPassengerTrip(trip)
);

export function buildPhoneUseEventContext(trip = {}, event = {}) {
  const startMs = eventStartMs(event);
  const tripStartMs = timestampMs(trip.start_time);
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  const routePoint = nearestRoutePoint(routePoints, startMs);
  const relatedEvents = (Array.isArray(trip.driving_events) ? trip.driving_events : [])
    .filter((candidate) => candidate?.type && candidate.type !== 'phone_use')
    .filter((candidate) => {
      const candidateMs = eventStartMs(candidate);
      return startMs != null && candidateMs != null && Math.abs(candidateMs - startMs) <= CONTEXT_EVENT_WINDOW_MS;
    });
  const intersectionEvents = Array.isArray(trip.intersection_events) ? trip.intersection_events : [];
  const nearIntersection = isIntersectionPoint(routePoint || {}) || intersectionEvents.some((candidate) => {
    const candidateMs = eventStartMs(candidate);
    return startMs != null && candidateMs != null && Math.abs(candidateMs - startMs) <= CONTEXT_EVENT_WINDOW_MS;
  });
  const roadType = event.road_type || routePoint?.road_type || trip.dominant_road_type || trip.road_type || null;
  const weather = trip.weather_context || null;
  const activity = classifyPhoneUseActivity(event);
  const contextLabels = [];
  const speedKmh = numberOrZero(event.speed_kmh ?? routePoint?.speed_kmh);

  if (nearIntersection) contextLabels.push('Near a recorded intersection or traffic stop');
  if (roadType) contextLabels.push(`${titleCase(roadType)} road`);
  if (speedKmh >= 100) contextLabels.push('Highway-speed exposure');
  else if (speedKmh >= 50) contextLabels.push('Moving at 50 km/h or more');
  if (weather?.condition && weather.condition !== 'clear') {
    contextLabels.push(`${titleCase(weather.condition)} conditions`);
  }
  relatedEvents.slice(0, 2).forEach((candidate) => {
    contextLabels.push(`Near ${titleCase(candidate.type)}`);
  });

  return {
    ...event,
    durationSeconds: Math.max(0, Math.round(numberOrZero(event.durationS ?? event.duration_seconds))),
    speedKmh: Math.round(speedKmh),
    offsetSeconds: startMs != null && tripStartMs != null ? Math.max(0, Math.round((startMs - tripStartMs) / 1000)) : null,
    activityKey: activity.key,
    activityLabel: activity.label,
    nearIntersection,
    roadType,
    weatherCondition: weather?.condition || null,
    relatedEventTypes: [...new Set(relatedEvents.map((candidate) => candidate.type))],
    contextLabels,
    referencePenaltyPoints: eventPenalty(event),
  };
}

const buildActivityBreakdown = (events = []) => {
  const groups = new Map();
  events.forEach((event) => {
    const current = groups.get(event.activityKey) || {
      key: event.activityKey,
      label: event.activityLabel,
      windows: 0,
      seconds: 0,
    };
    current.windows += 1;
    current.seconds += numberOrZero(event.durationSeconds);
    groups.set(event.activityKey, current);
  });
  return [...groups.values()].sort((left, right) => right.seconds - left.seconds);
};

const buildEventPenaltyComparison = (trip = {}, phoneEvents = []) => {
  const rows = new Map();
  (Array.isArray(trip.driving_events) ? trip.driving_events : [])
    .filter((event) => event?.type && event.type !== 'phone_use' && event.diagnostic_only !== true)
    .forEach((event) => {
      const severity = eventSeverity(event);
      const reference = eventPenaltyPoints[event.type]?.[severity];
      if (!Number.isFinite(Number(reference))) return;
      const current = rows.get(event.type) || {
        type: event.type,
        label: titleCase(event.type),
        count: 0,
        referencePoints: 0,
      };
      current.count += 1;
      current.referencePoints += Number(reference);
      rows.set(event.type, current);
    });
  if (phoneEvents.length) {
    rows.set('phone_use', {
      type: 'phone_use',
      label: 'Phone Use',
      count: phoneEvents.length,
      referencePoints: phoneEvents.reduce((sum, event) => sum + eventPenalty(event), 0),
    });
  }
  return [...rows.values()].sort((left, right) => right.referencePoints - left.referencePoints);
};

const chooseWorstEvent = (events = []) => (
  [...events].sort((left, right) => {
    const severityDelta = (riskRank[right.severity] || 0) - (riskRank[left.severity] || 0);
    if (severityDelta) return severityDelta;
    const speedDelta = numberOrZero(right.speedKmh ?? right.speed_kmh) - numberOrZero(left.speedKmh ?? left.speed_kmh);
    if (speedDelta) return speedDelta;
    return numberOrZero(right.durationSeconds ?? right.durationS) - numberOrZero(left.durationSeconds ?? left.durationS);
  })[0] || null
);

const coachingMessageFor = ({ isPassenger, scoreAvailable, timeline, worstEvent }) => {
  if (isPassenger) return 'This trip was marked as a passenger trip. Keep the evidence for review, but do not treat it as driver behavior.';
  if (!scoreAvailable) return 'Enable Android Usage Access before driving so phone-use coverage and scoring are available.';
  if (!timeline.length) return 'No confirmed phone-use windows were recorded. Keep navigation and audio set before moving.';
  if ((worstEvent?.speedKmh || 0) >= 100) return 'The highest-risk use happened at highway speed. Set navigation, calls, and audio before moving.';
  if ((worstEvent?.durationSeconds || 0) >= 20) return 'A sustained phone-use window was recorded. Pull over before handling messages, apps, or calls.';
  if (timeline.length >= 3) return 'Several short checks accumulated during this trip. Use Do Not Disturb and voice controls before departure.';
  return 'A short phone-use window was recorded while moving. Wait until parked before checking the screen.';
};

export function summarizeTripPhoneUse(trip = {}, options = {}) {
  const compact = trip.phone_use_summary && typeof trip.phone_use_summary === 'object'
    ? trip.phone_use_summary
    : null;
  const durationSeconds = routeDurationSeconds(trip);
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    Array.isArray(trip.route_points) ? trip.route_points : [],
    durationSeconds,
    {}
  );
  const events = Array.isArray(phoneUse.phone_use_events) ? phoneUse.phone_use_events : [];
  const confirmedEvents = events.filter((event) => event?.source === 'android_usage_access');
  const timeline = confirmedEvents.map((event) => buildPhoneUseEventContext(trip, event));
  const recordedUsageAccess = trip.native_phone_usage_access_granted === true ||
    trip.phone_use_score_available === true ||
    trip.phone_use_score_status === 'android_usage_access' ||
    compact?.scoreAvailable === true ||
    confirmedEvents.length > 0;
  const windowCount = numberOrZero(
    phoneUse.phone_use_window_count ||
    compact?.windowCount ||
    trip.phone_use_window_count
  );
  const totalSeconds = numberOrZero(
    phoneUse.phone_use_total_seconds ||
    compact?.totalSeconds ||
    trip.phone_use_total_seconds
  );
  const avgSpeedKmh = average(
    timeline.length
      ? timeline.map((event) => numberOrZero(event.speedKmh))
      : [numberOrZero(compact?.avgSpeedKmh)].filter(Boolean)
  );
  const score = [
    phoneUse.phone_use_score,
    compact?.score,
    trip.phone_use_score,
  ].map(Number).find(Number.isFinite);
  const scoreAvailable = recordedUsageAccess && (
    phoneUse.phone_use_score_available === true ||
    compact?.scoreAvailable === true ||
    trip.phone_use_score_available === true
  );
  const hasConfirmedUse = recordedUsageAccess && windowCount > 0;
  const worstEvent = chooseWorstEvent(timeline) || compact?.worstEvent || null;
  const activityBreakdown = timeline.length
    ? buildActivityBreakdown(timeline)
    : Array.isArray(compact?.activityBreakdown) ? compact.activityBreakdown : [];
  const passenger = isPassengerTrip(trip, options.wasDriver);
  const risk = phoneUse.phone_use_risk && phoneUse.phone_use_risk !== 'none'
    ? phoneUse.phone_use_risk
    : compact?.risk || trip.phone_use_risk || 'none';
  const pctOfTrip = numberOrZero(
    phoneUse.phone_use_pct_of_trip ||
    compact?.pctOfTrip ||
    trip.phone_use_pct_of_trip
  );
  const dataQuality = !recordedUsageAccess
    ? 'unmeasured'
    : hasConfirmedUse && timeline.length === 0
      ? 'summary_only'
      : 'measured';
  const scoreComparison = buildEventPenaltyComparison(trip, timeline);

  return {
    tripId: trip.id || null,
    startTime: trip.start_time || null,
    endTime: trip.end_time || null,
    durationSeconds,
    scoreAvailable,
    scoreStatus: recordedUsageAccess
      ? (phoneUse.phone_use_score_status || compact?.scoreStatus || trip.phone_use_score_status || 'android_usage_access')
      : 'usage_access_required',
    risk,
    score: Number.isFinite(score) ? score : null,
    windowCount,
    totalSeconds,
    pctOfTrip,
    avgSpeedKmh: avgSpeedKmh ? Math.round(avgSpeedKmh * 10) / 10 : 0,
    hasConfirmedUse,
    isPassenger: passenger,
    dataQuality,
    events: confirmedEvents,
    timeline,
    worstEvent,
    activityBreakdown,
    scoreComparison,
    unlockClassificationAvailable: timeline.some((event) => event.activityKey === 'unlock_or_screen_check'),
    coachingMessage: coachingMessageFor({
      isPassenger: passenger,
      scoreAvailable,
      timeline,
      worstEvent,
    }),
  };
}

export function buildCompactPhoneUseSummary(trip = {}) {
  const summary = summarizeTripPhoneUse(trip);
  const compactWorstEvent = summary.worstEvent
    ? {
      startTime: summary.worstEvent.startTime || summary.worstEvent.timestamp || null,
      durationSeconds: numberOrZero(summary.worstEvent.durationSeconds ?? summary.worstEvent.durationS),
      speedKmh: numberOrZero(summary.worstEvent.speedKmh ?? summary.worstEvent.speed_kmh),
      severity: summary.worstEvent.severity || 'low',
      activityKey: summary.worstEvent.activityKey || classifyPhoneUseActivity(summary.worstEvent).key,
      activityLabel: summary.worstEvent.activityLabel || classifyPhoneUseActivity(summary.worstEvent).label,
      contextLabels: Array.isArray(summary.worstEvent.contextLabels) ? summary.worstEvent.contextLabels.slice(0, 3) : [],
    }
    : null;
  return {
    version: PHONE_USE_SUMMARY_VERSION,
    scoreAvailable: summary.scoreAvailable,
    scoreStatus: summary.scoreStatus,
    risk: summary.risk,
    score: summary.score,
    windowCount: summary.windowCount,
    totalSeconds: summary.totalSeconds,
    pctOfTrip: summary.pctOfTrip,
    avgSpeedKmh: summary.avgSpeedKmh,
    hasConfirmedUse: summary.hasConfirmedUse,
    dataQuality: summary.dataQuality,
    worstEvent: compactWorstEvent,
    activityBreakdown: summary.activityBreakdown,
  };
}

const periodStats = (summaries = [], startMs, endMs) => {
  const period = summaries.filter((summary) => {
    const start = timestampMs(summary.startTime);
    return start != null && start >= startMs && start < endMs;
  });
  const measured = period.filter((summary) => summary.scoreAvailable);
  const phoneTrips = period.filter((summary) => summary.hasConfirmedUse);
  const totalSeconds = phoneTrips.reduce((sum, summary) => sum + summary.totalSeconds, 0);
  return {
    trips: period.length,
    measuredTrips: measured.length,
    tripsWithPhoneUse: phoneTrips.length,
    windows: phoneTrips.reduce((sum, summary) => sum + summary.windowCount, 0),
    totalSeconds,
    secondsPerMeasuredTrip: measured.length ? Math.round(totalSeconds / measured.length) : 0,
  };
};

export function summarizePhoneUseAcrossTrips(trips = [], options = {}) {
  const nowMs = timestampMs(options.now) ?? Date.now();
  const allSummaries = excludePrivacyTouchedDaysFromTrends(trips).map((trip) => summarizeTripPhoneUse(trip));
  const passengerTrips = allSummaries.filter((summary) => summary.isPassenger);
  const summaries = allSummaries.filter((summary) => !summary.isPassenger);
  const measuredTrips = summaries.filter((summary) => summary.scoreAvailable);
  const tripsWithConfirmedUse = summaries.filter((summary) => summary.hasConfirmedUse);
  const riskCounts = summaries.reduce((counts, summary) => {
    const risk = summary.risk || 'none';
    counts[risk] = (counts[risk] || 0) + 1;
    return counts;
  }, { none: 0, low: 0, medium: 0, high: 0 });
  const totalSeconds = tripsWithConfirmedUse.reduce((sum, summary) => sum + summary.totalSeconds, 0);
  const totalWindows = tripsWithConfirmedUse.reduce((sum, summary) => sum + summary.windowCount, 0);
  const worstRisk = summaries.reduce((worst, summary) => (
    (riskRank[summary.risk] || 0) > (riskRank[worst] || 0) ? summary.risk : worst
  ), 'none');
  const byStartDesc = [...tripsWithConfirmedUse].sort((a, b) => (timestampMs(b.startTime) || 0) - (timestampMs(a.startTime) || 0));
  const byDurationDesc = [...tripsWithConfirmedUse].sort((a, b) => b.totalSeconds - a.totalSeconds);
  const worstMoment = chooseWorstEvent(
    tripsWithConfirmedUse
      .filter((summary) => summary.worstEvent)
      .map((summary) => ({ ...summary.worstEvent, tripId: summary.tripId, tripStartTime: summary.startTime }))
  );
  const activityMap = new Map();
  tripsWithConfirmedUse.forEach((summary) => {
    summary.activityBreakdown.forEach((activity) => {
      const current = activityMap.get(activity.key) || { ...activity, windows: 0, seconds: 0 };
      current.windows += numberOrZero(activity.windows);
      current.seconds += numberOrZero(activity.seconds);
      activityMap.set(activity.key, current);
    });
  });
  const currentPeriod = periodStats(summaries, nowMs - 7 * 86_400_000, nowMs + 1);
  const previousPeriod = periodStats(summaries, nowMs - 14 * 86_400_000, nowMs - 7 * 86_400_000);
  const currentRate = currentPeriod.secondsPerMeasuredTrip;
  const previousRate = previousPeriod.secondsPerMeasuredTrip;
  const trendPct = previousRate > 0
    ? Math.round(((currentRate - previousRate) / previousRate) * 100)
    : currentRate > 0 ? 100 : 0;
  const weeklyTrend = Array.from({ length: 4 }, (_, reverseIndex) => {
    const weeksAgo = 3 - reverseIndex;
    const endMs = nowMs - weeksAgo * 7 * 86_400_000 + 1;
    const startMs = endMs - 7 * 86_400_000;
    return {
      label: weeksAgo === 0 ? 'Current' : `${weeksAgo}w ago`,
      ...periodStats(summaries, startMs, endMs),
    };
  });

  return {
    totalTrips: allSummaries.length,
    driverTrips: summaries.length,
    excludedPassengerTrips: passengerTrips.length,
    measuredTrips: measuredTrips.length,
    unmeasuredTrips: summaries.length - measuredTrips.length,
    tripsWithConfirmedUse: tripsWithConfirmedUse.length,
    totalWindows,
    totalSeconds,
    coveragePct: summaries.length ? Math.round((measuredTrips.length / summaries.length) * 100) : 0,
    averageSecondsPerMeasuredTrip: measuredTrips.length ? Math.round(totalSeconds / measuredTrips.length) : 0,
    averagePctOfTripWhenPresent: tripsWithConfirmedUse.length
      ? Math.round(average(tripsWithConfirmedUse.map((summary) => summary.pctOfTrip)) * 10) / 10
      : 0,
    worstRisk,
    riskCounts,
    latestPhoneUseTrip: byStartDesc[0] || null,
    longestPhoneUseTrip: byDurationDesc[0] || null,
    worstMoment,
    activityBreakdown: [...activityMap.values()].sort((left, right) => right.seconds - left.seconds),
    currentPeriod,
    previousPeriod,
    trendPct,
    trendDirection: trendPct < 0 ? 'improving' : trendPct > 0 ? 'worsening' : 'steady',
    weeklyTrend,
    trips: allSummaries,
  };
}
