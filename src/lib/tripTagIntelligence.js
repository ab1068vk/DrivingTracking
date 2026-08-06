import {
  isEveningRushHour,
  isMorningRushHour,
  isNightRiskHour,
} from '@/lib/appConstants';
import { routeKeyForTrip } from '@/lib/commuteMatching';
import {
  TRIP_TAG_OPTIONS,
  getTripTagOption,
  normalizeTripTags,
} from '@/lib/tripMetadata';

export const TRIP_TAG_INTELLIGENCE_VERSION = 2;

const PURPOSE_TAGS = new Set(
  TRIP_TAG_OPTIONS.filter((option) => option.category === 'purpose').map((option) => option.id)
);
const AUTO_APPLY_SOURCES = new Set([
  'trip_fact',
  'weather_evidence',
  'road_evidence',
  'confirmed_route_learning',
]);
const EXCLUSIVE_TAG_CATEGORIES = new Set(['purpose', 'route']);
const WEATHER_TAGS = new Set(['rain', 'snow']);

/**
 * Tag "confidence" is rule-based, not learned. Every value fed in below is a
 * fixed constant chosen per heuristic (plus a small ramp for repeated
 * user-confirmed routes) - it is not an observed accuracy rate for this user.
 */
const confidenceLabel = (confidence) => {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.65) return 'medium';
  return 'low';
};

// A trip with no recorded start time has no known hour or weekday. Falling
// back to `Date.now()` tagged such a trip "night" or "commute" from whenever
// the page happened to be open, which is a fabricated fact about the drive.
// Return null instead so time-based suggestions are simply skipped.
const tripStartDate = (trip = {}) => {
  const raw = trip.start_time || trip.created_at;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
};

const tripHour = (trip = {}) => tripStartDate(trip)?.getHours() ?? null;

const tripDay = (trip = {}) => tripStartDate(trip)?.getDay() ?? null;

const weatherCondition = (trip = {}) => String(
  trip.weather_context?.condition ||
  trip.weather_condition ||
  trip.slippery_proxy ||
  ''
).trim().toLowerCase();

const trafficCondition = (trip = {}) => String(
  trip.traffic_context?.condition ||
  trip.traffic_context?.level ||
  trip.traffic_level ||
  trip.congestion_level ||
  ''
).trim().toLowerCase();

const candidateSort = (left, right) => (
  right.confidence - left.confidence ||
  left.tag.localeCompare(right.tag)
);

/**
 * Infer explainable, multi-dimensional tags using only local trip history.
 * Purpose labels are conservative; observable route/condition facts can be
 * applied automatically. User-confirmed route labels outrank heuristics.
 *
 * @param {any} trip
 * @param {any[]} history
 */
export function inferTripTags(trip = {}, history = []) {
  const candidates = new Map();
  const add = (tag, confidence, reason, source, autoApply = false) => {
    const option = getTripTagOption(tag);
    if (!option || !Number.isFinite(confidence)) return;
    const next = {
      tag: option.id,
      label: option.label,
      category: option.category,
      confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
      confidence_label: confidenceLabel(confidence),
      reason,
      source,
      auto_apply: autoApply && AUTO_APPLY_SOURCES.has(source) && confidence >= 0.85,
    };
    const current = candidates.get(option.id);
    if (!current || next.confidence > current.confidence) candidates.set(option.id, next);
  };

  const hour = tripHour(trip);
  const day = tripDay(trip);
  const hasClock = hour != null && day != null;
  const weekday = hasClock && day >= 1 && day <= 5;
  const weekend = hasClock && (day === 0 || day === 6);
  const durationMinutes = (Number(trip.duration_seconds) || 0) / 60;
  const distanceKm = Number(trip.distance_km) || 0;
  const rushHour = hasClock && (isMorningRushHour(hour) || isEveningRushHour(hour));

  // The Night card on Trip Detail reports the recorded solar/twilight
  // classification. Suggesting a `night` tag from the fixed clock window while
  // that card says "Day" put two contradictory answers on one screen, so the
  // recorded classification wins whenever it exists.
  const solarClassified = trip.night_classification?.method != null &&
    trip.night_classification.method !== 'unavailable';
  if (trip.night_driving === true) {
    add('night', 0.99, 'The trip was classified as night driving.', 'trip_fact', true);
  } else if (solarClassified) {
    // Recorded as daylight - no night suggestion.
  } else if (hasClock && isNightRiskHour(hour)) {
    add('night', 0.78, 'The trip started during night-risk hours (22:00-04:59); no sunrise/sunset classification was recorded.', 'time_pattern');
  }

  const weather = weatherCondition(trip);
  const weatherSource = String(trip.weather_context?.source || '').toLowerCase();
  const verifiedWeather = ['open_meteo', 'user_confirmed'].includes(weatherSource);
  if (/(snow|ice|freez|sleet)/.test(weather)) {
    add('snow', verifiedWeather ? 0.96 : 0.78, verifiedWeather
      ? 'Saved weather evidence reported snow or freezing conditions.'
      : 'Trip signals suggest snow or freezing conditions.',
    verifiedWeather ? 'weather_evidence' : 'trip_pattern', verifiedWeather);
  } else if (/(rain|wet|storm)/.test(weather)) {
    const likelyWet = weather === 'likely_wet';
    const confidence = verifiedWeather ? 0.96 : likelyWet ? 0.82 : 0.68;
    add('rain', confidence, verifiedWeather
      ? 'Saved weather evidence reported rain or wet conditions.'
      : 'Trip signals suggest wet-road conditions.',
    verifiedWeather ? 'weather_evidence' : 'trip_pattern', verifiedWeather);
  }

  const roadType = String(trip.dominant_road_type || trip.road_type || '').toLowerCase();
  if (roadType === 'highway') {
    add('highway', 0.93, 'Highway was the dominant road type.', 'road_evidence', true);
  } else if (['urban', 'residential', 'city'].includes(roadType)) {
    add('city', 0.88, `${roadType === 'residential' ? 'Residential' : 'Urban'} roads dominated this trip.`, 'road_evidence', true);
  } else if (['rural', 'country'].includes(roadType)) {
    add('rural', 0.9, 'Rural roads dominated this trip.', 'road_evidence', true);
  }

  const traffic = trafficCondition(trip);
  if (/(heavy|severe|congest|stop.?and.?go)/.test(traffic)) {
    add('heavy_traffic', 0.9, 'Saved traffic context reported congestion.', 'trip_fact', true);
  }

  const routeKey = trip.route_key || routeKeyForTrip(trip);
  const matchingRouteTrips = routeKey
    ? (Array.isArray(history) ? history : []).filter((item) => (
      String(item?.id || '') !== String(trip?.id || '') &&
      (item?.route_key || routeKeyForTrip(item)) === routeKey
    ))
    : [];
  const confirmedPurposeCounts = new Map();
  matchingRouteTrips.forEach((item) => {
    if (item.tag_reviewed !== true) return;
    normalizeTripTags(item).filter((tag) => PURPOSE_TAGS.has(tag)).forEach((tag) => {
      confirmedPurposeCounts.set(tag, (confirmedPurposeCounts.get(tag) || 0) + 1);
    });
  });
  const confirmedPurpose = [...confirmedPurposeCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0];
  const confirmedTotal = [...confirmedPurposeCounts.values()].reduce((sum, count) => sum + count, 0);
  if (confirmedPurpose && confirmedPurpose[1] >= 2 && confirmedPurpose[1] / Math.max(1, confirmedTotal) >= 0.6) {
    const [tag, confirmations] = confirmedPurpose;
    const confidence = Math.min(0.98, 0.82 + confirmations * 0.04);
    add(
      tag,
      confidence,
      `You confirmed ${getTripTagOption(tag)?.label || tag} on this repeated route ${confirmations} times.`,
      'confirmed_route_learning',
      true
    );
  } else if (weekday && matchingRouteTrips.length >= 2) {
    const similarTimeTrips = matchingRouteTrips.filter((item) => {
      const difference = Math.abs(tripHour(item) - hour);
      return difference <= 2 || difference >= 22;
    });
    if (similarTimeTrips.length >= 2) {
      add(
        'commute',
        Math.min(0.84, 0.72 + similarTimeTrips.length * 0.03),
        `This route repeats at a similar weekday time (${similarTimeTrips.length} earlier trips).`,
        'route_pattern'
      );
    }
  }

  if (weekday && rushHour && durationMinutes >= 10 && durationMinutes <= 90 && distanceKm >= 5 && distanceKm <= 80) {
    add('commute', 0.76, 'The weekday time, distance, and duration match a commute pattern.', 'time_pattern');
  } else if (weekday && hour >= 6 && hour <= 18 && durationMinutes >= 15) {
    add('commute', 0.66, 'The weekday timing and duration resemble a commute.', 'time_pattern');
  }
  if (durationMinutes > 0 && durationMinutes < 20 && distanceKm > 0 && distanceKm < 10) {
    add('errand', 0.69, 'This was a short, local trip.', 'trip_pattern');
  } else if (weekend && hour >= 9 && hour <= 17 && distanceKm > 0 && distanceKm < 20) {
    add('errand', 0.65, 'The weekend timing and distance resemble an errand.', 'trip_pattern');
  }
  if (distanceKm > 0 && distanceKm < 8 && durationMinutes >= 10) {
    add('practice', 0.54, 'The short distance and longer duration may indicate driving practice.', 'trip_pattern');
  }

  const allCandidates = [...candidates.values()];
  const purposeCandidates = allCandidates
    .filter((candidate) => candidate.category === 'purpose')
    .sort(candidateSort);
  const contextualCandidates = allCandidates
    .filter((candidate) => candidate.category !== 'purpose')
    .sort(candidateSort);
  const ranked = [
    ...(purposeCandidates[0] ? [purposeCandidates[0]] : []),
    ...contextualCandidates,
  ].sort(candidateSort);
  const recommended = ranked.filter((candidate) => candidate.confidence >= 0.65);
  const autoApplyTags = recommended
    .filter((candidate) => candidate.auto_apply)
    .map((candidate) => candidate.tag);
  const primary = (
    purposeCandidates.find((candidate) => candidate.confidence >= 0.65) ||
    ranked[0] ||
    null
  );

  return {
    version: TRIP_TAG_INTELLIGENCE_VERSION,
    primary,
    candidates: ranked,
    recommended,
    recommended_tags: recommended.map((candidate) => candidate.tag),
    auto_apply_tags: autoApplyTags,
    route_match_count: matchingRouteTrips.length,
    learned_from_confirmations: confirmedTotal,
  };
}

/**
 * Return stored tags plus high-confidence local inferences. Useful for
 * smart filtering of older trips without mutating their saved records.
 */
export function getEffectiveTripTags(trip = {}, history = []) {
  const stored = normalizeTripTags(trip);
  if (trip.tag_reviewed === true) return stored;
  const intelligence = inferTripTags(trip, history);
  const occupiedExclusiveCategories = new Set(stored
    .map((tag) => getTripTagOption(tag)?.category)
    .filter((category) => EXCLUSIVE_TAG_CATEGORIES.has(category)));
  const compatibleInferences = intelligence.auto_apply_tags.filter((tag) => {
    const category = getTripTagOption(tag)?.category;
    return !EXCLUSIVE_TAG_CATEGORIES.has(category) || !occupiedExclusiveCategories.has(category) || stored.includes(tag);
  });
  return [...new Set([...stored, ...compatibleInferences])];
}

/**
 * Keep automatically applied weather tags aligned with newer trusted weather
 * evidence. Tags explicitly reviewed by the driver are never changed here.
 *
 * @param {any} trip
 * @param {any} nextWeatherContext
 */
export function reconcileWeatherDerivedTags(trip = {}, nextWeatherContext = null) {
  const source = String(nextWeatherContext?.source || '').toLowerCase();
  if (!['open_meteo', 'user_confirmed'].includes(source) || !nextWeatherContext?.condition) {
    return {};
  }

  const existingTags = normalizeTripTags(trip);
  const existingSources = { ...(trip.tag_sources || {}) };
  const existingAutoTags = Array.isArray(trip.auto_tags)
    ? normalizeTripTags(trip.auto_tags)
    : [];
  const nextIntelligence = inferTripTags({
    ...trip,
    weather_context: nextWeatherContext,
    weather_condition: '',
    slippery_proxy: '',
  });
  const nextWeatherCandidate = nextIntelligence.candidates.find((candidate) => (
    candidate.source === 'weather_evidence' &&
    WEATHER_TAGS.has(candidate.tag) &&
    candidate.auto_apply === true
  )) || null;

  const isAutomaticallyDerivedWeatherTag = (tag) => {
    if (!WEATHER_TAGS.has(tag)) return false;
    if (existingSources[tag]?.source === 'weather_evidence') return true;
    return trip.tag_reviewed !== true &&
      !existingSources[tag] &&
      existingAutoTags.includes(tag);
  };

  const tags = existingTags.filter((tag) => !isAutomaticallyDerivedWeatherTag(tag));
  const tagSources = { ...existingSources };
  WEATHER_TAGS.forEach((tag) => {
    if (isAutomaticallyDerivedWeatherTag(tag)) delete tagSources[tag];
  });

  if (trip.tag_reviewed !== true && nextWeatherCandidate && !tags.includes(nextWeatherCandidate.tag)) {
    tags.push(nextWeatherCandidate.tag);
    tagSources[nextWeatherCandidate.tag] = {
      source: nextWeatherCandidate.source,
      confidence: nextWeatherCandidate.confidence,
      reason: nextWeatherCandidate.reason,
      applied_at: new Date().toISOString(),
    };
  }

  const autoTags = existingAutoTags.filter((tag) => !WEATHER_TAGS.has(tag));
  if (nextWeatherCandidate && !autoTags.includes(nextWeatherCandidate.tag)) {
    autoTags.push(nextWeatherCandidate.tag);
  }

  const existingCandidates = Array.isArray(trip.tag_candidates) ? trip.tag_candidates : [];
  const tagCandidates = existingCandidates.filter((candidate) => (
    candidate?.source !== 'weather_evidence' && !WEATHER_TAGS.has(candidate?.tag)
  ));
  if (nextWeatherCandidate) tagCandidates.push(nextWeatherCandidate);

  const primaryTag = tags[0] || null;
  const autoTagWasWeather = WEATHER_TAGS.has(String(trip.auto_tag || '').toLowerCase());
  const autoTag = autoTagWasWeather
    ? nextWeatherCandidate?.tag || autoTags[0] || primaryTag
    : trip.auto_tag;

  return {
    tags,
    tag: existingTags.includes(trip.tag) && tags.includes(trip.tag) ? trip.tag : primaryTag,
    tag_sources: tagSources,
    auto_tags: autoTags,
    tag_candidates: tagCandidates,
    ...(autoTagWasWeather
      ? {
        auto_tag: autoTag || null,
        auto_tag_confidence: nextWeatherCandidate?.confidence_label || 'low',
        auto_tag_reason: nextWeatherCandidate?.reason || 'Weather evidence was updated.',
      }
      : {}),
  };
}
