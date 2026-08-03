import {
  buildCoachProgramProgress,
  buildCoachSegmentInsights,
  buildTripContextSignature,
  COACH_FOCUS_CATALOG,
} from '@/lib/coachPrograms';

const EVENT_FOCUS = {
  harsh_brakes: {
    field: 'harsh_brakes_count',
    types: ['harsh_brake'],
    singular: 'harsh brake',
    plural: 'harsh brakes',
  },
  rapid_accel: {
    field: 'rapid_accel_count',
    types: ['rapid_acceleration', 'rapid_accel'],
    singular: 'rapid acceleration',
    plural: 'rapid accelerations',
  },
  sharp_turns: {
    field: 'sharp_turns_count',
    types: ['sharp_turn'],
    singular: 'sharp turn',
    plural: 'sharp turns',
  },
  speeding: {
    field: 'speeding_events_count',
    types: ['speeding'],
    singular: 'speeding event',
    plural: 'speeding events',
  },
  phone_use: {
    field: 'phone_use_window_count',
    types: ['phone_use', 'phone_interaction'],
    singular: 'foreground-app window',
    plural: 'foreground-app windows',
  },
};

const asNumber = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const asTime = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : null;
};

const round = (value, places = 1) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

const completedTrips = (trips = []) => (Array.isArray(trips) ? trips : [])
  .filter((candidate) => candidate?.status === 'completed');

const normalizedRoadType = (value) => String(value || 'mixed')
  .toLowerCase()
  .replaceAll('_', ' ');

const measuredEventCount = (trip = {}, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  if (!definition) return null;
  const direct = asNumber(trip?.[definition.field]);
  if (direct != null && direct >= 0) return Math.round(direct);
  if (focusId === 'phone_use') {
    const compact = asNumber(
      trip?.phone_use_summary?.windowCount ?? trip?.phone_use_summary?.window_count
    );
    if (compact != null && compact >= 0) return Math.round(compact);
  }
  if (!Array.isArray(trip?.driving_events)) return null;
  return trip.driving_events.filter((event) => definition.types.includes(event?.type)).length;
};

const timeBucket = (trip = {}) => buildTripContextSignature(trip).timeBucket;

const comparableTripsFor = (trip, previousTrips = []) => {
  const signature = buildTripContextSignature(trip);
  const candidates = completedTrips(previousTrips)
    .filter((candidate) => String(candidate?.id) !== String(trip?.id))
    .sort((a, b) => (asTime(b.start_time || b.created_at) || 0) - (asTime(a.start_time || a.created_at) || 0));
  const sameRoute = signature.routeKey
    ? candidates.filter((candidate) => buildTripContextSignature(candidate).routeKey === signature.routeKey)
    : [];
  if (sameRoute.length) return { trips: sameRoute.slice(0, 8), label: 'same-route drives', strength: 'route' };

  const scored = candidates.map((candidate) => {
    const other = buildTripContextSignature(candidate);
    const matches = [
      other.roadType === signature.roadType,
      other.durationBucket === signature.durationBucket,
      other.timeBucket === signature.timeBucket,
    ].filter(Boolean).length;
    return { candidate, matches };
  });
  const contextual = scored.filter(({ matches }) => matches >= 2).map(({ candidate }) => candidate);
  if (contextual.length) {
    return { trips: contextual.slice(0, 8), label: 'context-matched drives', strength: 'context' };
  }
  return { trips: candidates.slice(0, 5), label: 'recent drives', strength: 'recent' };
};

const ratePer10Km = (trips, focusId) => {
  const measured = trips
    .map((trip) => ({ trip, count: measuredEventCount(trip, focusId) }))
    .filter(({ trip, count }) => count != null && (asNumber(trip.distance_km) || 0) > 0);
  const distanceKm = measured.reduce((sum, { trip }) => sum + Number(trip.distance_km), 0);
  if (distanceKm <= 0) return null;
  const count = measured.reduce((sum, item) => sum + item.count, 0);
  return {
    count,
    distanceKm: round(distanceKm, 1),
    measuredTrips: measured.length,
    value: round((count / distanceKm) * 10, 1),
  };
};

const eventListFor = (trip = {}, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  if (!definition) return [];
  const drivingEvents = Array.isArray(trip.driving_events) ? trip.driving_events : [];
  const phoneEvents = focusId === 'phone_use' && Array.isArray(trip.phone_use_events)
    ? trip.phone_use_events
    : [];
  return [...drivingEvents, ...phoneEvents]
    .filter((event) => definition.types.includes(event?.type))
    .filter((event) => event?.diagnostic_only !== true);
};

const severityRank = (severity) => ({ high: 3, medium: 2, low: 1 }[severity] || 0);

const focalEventFor = (trip, focusId) => eventListFor(trip, focusId)
  .map((event) => {
    const speed = asNumber(event.speed_kmh ?? event.value);
    const limit = asNumber(event.speed_limit_kmh ?? event.limit_kmh);
    return {
      event,
      relevance: severityRank(event.severity) * 100
        + Math.max(0, speed != null && limit != null ? speed - limit : 0),
    };
  })
  .sort((a, b) => b.relevance - a.relevance)[0]?.event || null;

const nearestRoutePoint = (trip = {}, event = {}) => {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (!points.length) return { point: null, index: null };
  const explicitIndex = asNumber(
    event.route_point_index ?? event.point_index ?? event.start_index
  );
  if (explicitIndex != null && points[Math.round(explicitIndex)]) {
    const index = Math.round(explicitIndex);
    return { point: points[index], index };
  }
  const eventTime = asTime(event.timestamp || event.startTime);
  if (eventTime == null) return { point: null, index: null };
  let best = null;
  points.forEach((point, index) => {
    const pointTime = asTime(point.timestamp);
    if (pointTime == null) return;
    const distance = Math.abs(pointTime - eventTime);
    if (!best || distance < best.distance) best = { point, index, distance };
  });
  return best || { point: null, index: null };
};

const formatOffset = (trip, event) => {
  const start = asTime(trip.start_time || trip.created_at);
  const eventTime = asTime(event?.timestamp || event?.startTime);
  if (start == null || eventTime == null || eventTime < start) return null;
  const seconds = Math.round((eventTime - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, '0')}s into the drive` : `${seconds}s into the drive`;
};

const routeSection = (trip, event, index) => {
  const rawProgress = asNumber(event?.route_progress ?? event?.progress);
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const progress = rawProgress != null
    ? Math.max(0, Math.min(1, rawProgress > 1 ? rawProgress / 100 : rawProgress))
    : index != null && points.length > 1 ? index / (points.length - 1) : null;
  if (progress == null) return null;
  if (progress < 0.34) return 'early route';
  if (progress < 0.67) return 'middle route';
  return 'late route';
};

const pointRoadLabel = (trip, event, point) => {
  const roadName = event?.road_name || event?.roadName
    || point?.road_name || point?.roadName || point?.name || point?.ref;
  if (roadName) return String(roadName);
  const roadType = event?.road_type || point?.road_type
    || trip?.dominant_road_type || trip?.road_type;
  return roadType ? `${normalizedRoadType(roadType)} road` : null;
};

const buildMoment = (trip, comparableTrips, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  const event = focalEventFor(trip, focusId);
  if (!definition || !event) {
    return {
      available: false,
      headline: 'No precise event moment retained',
      detail: 'Road Sage can still measure the trip-level pattern, but it will not invent a location or cause.',
      repeated: null,
    };
  }
  const nearest = nearestRoutePoint(trip, event);
  const offset = formatOffset(trip, event);
  const section = routeSection(trip, event, nearest.index);
  const road = pointRoadLabel(trip, event, nearest.point);
  const speed = asNumber(event.speed_kmh ?? event.value ?? nearest.point?.speed_kmh);
  const limit = asNumber(event.speed_limit_kmh ?? event.limit_kmh ?? nearest.point?.speed_limit_kmh);
  const evidence = [];
  if (speed != null && focusId === 'speeding') {
    evidence.push(limit != null ? `${Math.round(speed)} in a ${Math.round(limit)} km/h zone` : `${Math.round(speed)} km/h recorded`);
  } else if (speed != null) {
    evidence.push(`${Math.round(speed)} km/h recorded`);
  }
  if (offset) evidence.push(offset);
  if (road) evidence.push(`on ${road}`);
  else if (section) evidence.push(`in the ${section}`);

  const routeKey = trip.route_key || buildTripContextSignature(trip).routeKey;
  const sectionAnalysis = routeKey
    ? buildCoachSegmentInsights([trip, ...comparableTrips], routeKey, focusId)
    : null;
  const strongest = sectionAnalysis?.strongestSection;
  const repeated = strongest && strongest.affectedTrips >= 2
    ? `${strongest.label} contains this focus in ${strongest.affectedTrips} matched drives (${strongest.repeatRate}% of the route sample).`
    : null;
  return {
    available: true,
    event,
    headline: evidence.join(' · ') || `${definition.singular} retained with timestamp evidence`,
    detail: repeated || 'This is the strongest retained event moment from the completed drive.',
    repeated,
    road,
    section,
    offset,
    speedKmh: speed,
    limitKmh: limit,
    routePointIndex: nearest.index,
  };
};

const speedLimitTransition = (trip, moment) => {
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (moment?.routePointIndex == null || !points.length) return null;
  const currentIndex = moment.routePointIndex;
  const currentPoint = points[currentIndex] || {};
  const currentLimit = asNumber(
    moment.limitKmh ?? currentPoint.speed_limit_kmh ?? currentPoint.speedLimitKmh
  );
  if (currentLimit == null) return null;
  const currentTime = asTime(currentPoint.timestamp || moment.event?.timestamp);
  const earlier = points.slice(Math.max(0, currentIndex - 30), currentIndex)
    .map((point) => ({
      limit: asNumber(point.speed_limit_kmh ?? point.speedLimitKmh),
      time: asTime(point.timestamp),
    }))
    .filter((row) => row.limit != null && row.limit !== currentLimit)
    .filter((row) => currentTime == null || row.time == null || currentTime - row.time <= 120000)
    .at(-1);
  if (!earlier || Math.abs(earlier.limit - currentLimit) < 10) return null;
  return {
    from: Math.round(earlier.limit),
    to: Math.round(currentLimit),
    direction: earlier.limit > currentLimit ? 'drop' : 'increase',
  };
};

const hasRecentStop = (trip, moment) => {
  const eventTime = asTime(moment?.event?.timestamp);
  if (eventTime == null) return false;
  const stopTypes = new Set(['traffic_stop', 'stop_start_pattern', 'tailgate_cycle']);
  const nearbyEvent = (trip.driving_events || []).some((event) => {
    if (!stopTypes.has(event?.type)) return false;
    const time = asTime(event.timestamp);
    return time != null && Math.abs(eventTime - time) <= 45000;
  });
  if (nearbyEvent) return true;
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const currentIndex = moment.routePointIndex;
  if (currentIndex == null) return false;
  return points.slice(Math.max(0, currentIndex - 15), currentIndex)
    .some((point) => (asNumber(point.speed_kmh) || 0) <= 5);
};

const contextTags = (trip = {}) => [
  ...(Array.isArray(trip.tags) ? trip.tags : []),
  trip.tag,
  trip.auto_tag,
].filter(Boolean).map((value) => String(value).toLowerCase());

const weatherCondition = (trip = {}) => String(
  trip.weather_context?.condition || trip.weather_context?.summary || ''
).toLowerCase();

const buildCause = (trip, focusId, moment) => {
  if (!moment.available) {
    return {
      headline: 'Cause not established',
      detail: 'There is not enough event-level evidence to distinguish driver input from road or traffic context.',
      confidence: 'limited',
      evidence: 'Trip-level measurement only',
    };
  }
  const transition = focusId === 'speeding' ? speedLimitTransition(trip, moment) : null;
  if (transition?.direction === 'drop') {
    return {
      headline: 'Likely speed-limit transition',
      detail: `The retained limit changes from ${transition.from} to ${transition.to} km/h shortly before the event. The likely coaching opportunity is settling speed earlier after the limit drops.`,
      confidence: 'strong',
      evidence: 'Timestamp-aligned route and speed-limit evidence',
    };
  }
  if (moment.repeated) {
    return {
      headline: 'Route-specific pressure point',
      detail: `${moment.repeated} That repetition makes the road section a stronger explanation than a one-off whole-trip problem.`,
      confidence: 'developing',
      evidence: 'Repeated matched-route event position',
    };
  }

  const weather = weatherCondition(trip);
  if (['harsh_brakes', 'sharp_turns'].includes(focusId) && /(rain|snow|ice|sleet|fog|storm)/.test(weather)) {
    return {
      headline: 'Conditions may be contributing',
      detail: `${trip.weather_context?.condition || 'Adverse weather'} was retained for this drive. It may have reduced the margin for smooth braking or turning, but the app cannot prove causation.`,
      confidence: 'developing',
      evidence: 'Saved weather context plus event timing',
    };
  }

  const stoppedRecently = hasRecentStop(trip, moment);
  if (focusId === 'rapid_accel' && stoppedRecently) {
    return {
      headline: 'Launch immediately after a stop',
      detail: 'Low-speed or stop evidence appears shortly before the acceleration. A slower three-second throttle ramp is the most directly testable change.',
      confidence: 'strong',
      evidence: 'Event timestamp aligned with preceding low-speed evidence',
    };
  }
  if (focusId === 'harsh_brakes' && stoppedRecently) {
    return {
      headline: 'Reactive approach to a slowdown',
      detail: 'Stop or low-speed evidence sits close to the braking event. Extra following space and an earlier lift are the most directly testable changes.',
      confidence: 'developing',
      evidence: 'Event timestamp aligned with stop or low-speed evidence',
    };
  }
  if (focusId === 'sharp_turns' && (moment.speedKmh || 0) >= 30) {
    return {
      headline: 'Turn-entry speed is the leading signal',
      detail: `The event was retained near ${Math.round(moment.speedKmh)} km/h. Setting speed before steering is the most directly testable change.`,
      confidence: 'developing',
      evidence: 'Event speed and route position',
    };
  }
  if (focusId === 'speeding' && moment.speedKmh != null && moment.limitKmh != null) {
    const over = Math.max(0, Math.round(moment.speedKmh - moment.limitKmh));
    return {
      headline: over >= 10 ? 'Sustained speed above the retained limit' : 'Small speed creep',
      detail: `${over} km/h above the retained limit was recorded at the strongest event. No earlier limit transition was retained, so this remains a behavior hypothesis rather than a proven cause.`,
      confidence: 'developing',
      evidence: 'Recorded event speed and retained speed limit',
    };
  }
  if (focusId === 'phone_use') {
    return {
      headline: 'Foreground activity while moving',
      detail: 'The phone recorded foreground-app activity during motion. Confirm that you were the driver before treating this as a distraction pattern.',
      confidence: 'developing',
      evidence: 'On-device foreground activity and movement window',
    };
  }
  const tags = contextTags(trip);
  if (tags.includes('heavy_traffic') || tags.includes('traffic')) {
    return {
      headline: 'Traffic pressure may be contributing',
      detail: 'The trip carries traffic context, but the available evidence cannot separate unavoidable traffic response from driving behavior.',
      confidence: 'limited',
      evidence: 'Saved trip context',
    };
  }
  return {
    headline: 'No single cause established',
    detail: `The event is located in the ${moment.section || timeBucket(trip)}, but no strong transition, stop, weather, or repeated-section signal explains it yet.`,
    confidence: 'limited',
    evidence: 'Event timing and available route context',
  };
};

const buildPattern = (trip, comparable, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  if (!definition) {
    return {
      classification: 'score_pattern',
      headline: 'Consistency experiment',
      detail: `${comparable.trips.length} ${comparable.label} are available to judge whether the next drives repeat this result.`,
      confidence: comparable.trips.length >= 5 ? 'strong' : comparable.trips.length >= 2 ? 'developing' : 'early',
    };
  }
  const measured = comparable.trips
    .map((candidate) => ({ trip: candidate, count: measuredEventCount(candidate, focusId) }))
    .filter(({ count }) => count != null);
  const affected = measured.filter(({ count }) => count > 0);
  const historicalRate = ratePer10Km(measured.map(({ trip }) => trip), focusId);
  const currentRate = ratePer10Km([trip], focusId);
  const classification = affected.length >= 3 || (measured.length >= 3 && affected.length / measured.length >= 0.5)
    ? 'recurring'
    : affected.length > 0 ? 'intermittent' : measured.length > 0 ? 'first_seen' : 'learning';
  const headline = classification === 'recurring'
    ? `Recurring in ${affected.length} of ${measured.length} comparable drives`
    : classification === 'intermittent'
      ? `Occasional: ${affected.length} of ${measured.length} comparable drives`
      : classification === 'first_seen'
        ? `First occurrence in ${measured.length + 1} measured drives`
        : 'Personal recurrence is still learning';
  const rateComparison = currentRate?.value != null && historicalRate?.value != null
    ? `This drive was ${currentRate.value} per 10 km versus ${historicalRate.value} across your ${comparable.label}.`
    : `Road Sage needs more measured distance before it can calculate a reliable per-distance recurrence.`;
  return {
    affectedTrips: affected.length,
    classification,
    comparableTripCount: measured.length,
    confidence: measured.length >= 5 ? 'strong' : measured.length >= 2 ? 'developing' : 'early',
    currentRatePer10Km: currentRate?.value ?? null,
    historicalRatePer10Km: historicalRate?.value ?? null,
    headline,
    detail: rateComparison,
    label: comparable.label,
  };
};

const weightedScore = (trips = []) => {
  const rows = trips.map((trip) => ({
    value: asNumber(trip.score_overall ?? trip.overall_score ?? trip.score),
    weight: Math.max(0.1, asNumber(trip.distance_km) || 0.1),
  })).filter(({ value }) => value != null);
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
};

const sampleVariance = (values = []) => {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
};

const buildUpside = (comparableTrips, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  if (!definition) {
    return {
      available: false,
      headline: 'Upside will be measured, not guessed',
      detail: 'Complete the three-drive experiment to compare the new score with the saved baseline.',
    };
  }
  const scored = comparableTrips
    .map((trip) => ({
      trip,
      count: measuredEventCount(trip, focusId),
      score: asNumber(trip.score_overall ?? trip.overall_score ?? trip.score),
    }))
    .filter(({ count, score }) => count != null && score != null);
  const clean = scored.filter(({ count }) => count === 0);
  const affected = scored.filter(({ count }) => count > 0);
  if (clean.length < 2 || affected.length < 2) {
    return {
      available: false,
      headline: 'Personal score upside is still learning',
      detail: `A grounded estimate needs at least two ${definition.singular}-free and two affected comparable drives; currently ${clean.length} and ${affected.length}.`,
      cleanTrips: clean.length,
      affectedTrips: affected.length,
    };
  }
  const cleanAverage = weightedScore(clean.map(({ trip }) => trip));
  const affectedAverage = weightedScore(affected.map(({ trip }) => trip));
  const estimate = cleanAverage - affectedAverage;
  if (!Number.isFinite(estimate) || estimate < 1) {
    return {
      available: false,
      headline: 'No positive personal score gap yet',
      detail: `Your comparable event-free drives average ${round(cleanAverage)} versus ${round(affectedAverage)} when affected. The behavior target is more reliable than a score prediction right now.`,
      cleanTrips: clean.length,
      affectedTrips: affected.length,
    };
  }
  const cleanValues = clean.map(({ score }) => score);
  const affectedValues = affected.map(({ score }) => score);
  const standardError = Math.sqrt(
    sampleVariance(cleanValues) / cleanValues.length
    + sampleVariance(affectedValues) / affectedValues.length
  );
  const lower = Math.max(0, estimate - 1.28 * standardError);
  const upper = Math.min(20, estimate + 1.28 * standardError);
  return {
    available: true,
    estimate: round(estimate),
    lower: round(lower),
    upper: round(Math.max(lower, upper)),
    headline: `About +${round(estimate)} score points of observed upside`,
    detail: `Your ${clean.length} comparable event-free drives average ${round(cleanAverage)} versus ${round(affectedAverage)} across ${affected.length} affected drives. Observational range: +${round(lower)} to +${round(Math.max(lower, upper))}; this is not a causal guarantee.`,
    cleanTrips: clean.length,
    affectedTrips: affected.length,
  };
};

const buildTarget = (trip, comparableTrips, focusId) => {
  const definition = EVENT_FOCUS[focusId];
  if (!definition) {
    const scores = comparableTrips
      .map((candidate) => asNumber(candidate.score_overall ?? candidate.overall_score ?? candidate.score))
      .filter((value) => value != null);
    const baseline = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
    const target = baseline == null ? null : Math.min(100, baseline + 3);
    return {
      baseline,
      target,
      headline: target == null ? 'Repeat three comparable drives' : `Reach at least ${Math.round(target)}/100`,
      detail: target == null
        ? 'The next three comparable drives will establish the first measurable consistency target.'
        : `Target: improve the ${round(baseline)} comparable-drive baseline by at least 3 points across three drives.`,
    };
  }
  const historical = ratePer10Km(comparableTrips, focusId);
  const current = ratePer10Km([trip], focusId);
  const basis = historical?.value ?? current?.value;
  const target = basis == null ? null : round(Math.max(0, basis * 0.75), 1);
  const noun = target === 1 ? definition.singular : definition.plural;
  return {
    baseline: historical?.value ?? null,
    current: current?.value ?? null,
    target,
    headline: target == null ? `Measure ${definition.plural} across three drives` : `At or below ${target} ${noun} per 10 km`,
    detail: target == null
      ? 'There is not enough measured distance for a numeric target yet; the first eligible drive will establish it.'
      : `A 25% reduction target across the next three comparable drives${historical?.value != null ? `, from a ${historical.value} per 10 km personal baseline` : ''}.`,
  };
};

const matchingProgram = (coachStore = {}, trip, focusId) => {
  const sourceTripId = String(trip?.id || '');
  const candidates = [
    coachStore.active,
    coachStore.lastResult,
    ...(Array.isArray(coachStore.history) ? coachStore.history : []),
  ].filter(Boolean);
  return candidates.find((program) => (
    program.focusId === focusId
    && String(program.sourceTripId || '') === sourceTripId
  ))
    || candidates.find((program) => (
      program.source === 'post_drive_review'
      && program.status === 'active'
    ))
    || candidates.find((program) => (
      program.source === 'post_drive_review'
      && program.result
    ))
    || null;
};

const buildOutcome = (trip, allTrips, focusId, coachStore) => {
  const program = matchingProgram(coachStore, trip, focusId);
  if (!program) {
    return {
      status: 'ready',
      headline: 'Ready for a three-drive test',
      detail: 'Use this next drive to save the baseline, apply one focused cue, and return a before/after result.',
    };
  }
  if (program.status === 'active') {
    const progress = buildCoachProgramProgress(program, allTrips);
    const programFocus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
    if (progress?.readyToGraduate) {
      return {
        status: 'validated',
        headline: `${programFocus.label} target met: ${progress.improvement}${progress.improvementUnit === '%' ? '%' : ' points'} improvement`,
        detail: `Before ${progress.baselineMetric}; after ${progress.currentMetric}; target ${progress.targetMetric}. The three-drive comparison is complete.`,
        progress,
      };
    }
    if (progress?.completedCount >= (program.targetTripCount || 3)) {
      return {
        status: 'finished',
        headline: `${programFocus.label}: three-drive comparison complete`,
        detail: `Before ${progress.baselineMetric}; after ${progress.currentMetric}; target ${progress.targetMetric}. The target was not met, so the result is retained as measured rather than presented as improvement.`,
        progress,
      };
    }
    return {
      status: 'active',
      headline: `${programFocus.label}: ${progress?.completedCount || 0} of ${program.targetTripCount || 3} drives measured`,
      detail: progress?.currentMetric == null
        ? `The baseline is saved. ${progress?.remainingTrips || program.targetTripCount || 3} eligible drive${(progress?.remainingTrips || program.targetTripCount || 3) === 1 ? '' : 's'} remain before the before/after verdict.`
        : `Current result: ${progress.currentMetric} versus ${progress.baselineMetric} at baseline and ${progress.targetMetric} target.`,
      progress,
    };
  }
  const result = program.result;
  if (result?.improvement != null) {
    const programFocus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
    return {
      status: result.graduated ? 'validated' : 'finished',
      headline: result.graduated
        ? `${programFocus.label} target met: ${result.improvement}${result.improvementUnit === '%' ? '%' : ' points'} improvement`
        : `${programFocus.label} finished: ${result.improvement}${result.improvementUnit === '%' ? '%' : ' points'} change`,
      detail: `Before ${result.baselineMetric}; after ${result.currentMetric}; target ${result.targetMetric}.`,
      result,
    };
  }
  return {
    status: 'finished',
    headline: 'Experiment ended without enough measured evidence',
    detail: 'A new three-drive test can rebuild the comparison with eligible drives.',
  };
};

export function buildAdvancedPostDriveAnalysis(
  trip,
  previousTrips = [],
  focusId = 'consistency',
  coachStore = {}
) {
  if (!trip) return null;
  const comparable = comparableTripsFor(trip, previousTrips);
  const pattern = buildPattern(trip, comparable, focusId);
  const moment = buildMoment(trip, comparable.trips, focusId);
  const cause = buildCause(trip, focusId, moment);
  const target = buildTarget(trip, comparable.trips, focusId);
  const upside = buildUpside(comparable.trips, focusId);
  const allTrips = [
    trip,
    ...completedTrips(previousTrips).filter((candidate) => String(candidate.id) !== String(trip.id)),
  ];
  const outcome = buildOutcome(trip, allTrips, focusId, coachStore);
  const confidence = pattern.confidence === 'strong' && cause.confidence === 'strong'
    ? 'strong'
    : pattern.confidence === 'early' && cause.confidence === 'limited'
      ? 'early'
      : 'developing';
  return {
    confidence,
    comparisonLabel: comparable.label,
    comparisonStrength: comparable.strength,
    focus: COACH_FOCUS_CATALOG[focusId] || COACH_FOCUS_CATALOG.consistency,
    pattern,
    moment,
    cause,
    target,
    upside,
    outcome,
    limitation: 'Likely contributors are local evidence-based hypotheses, not proof of why an event happened.',
  };
}
