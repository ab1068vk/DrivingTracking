export const TRIP_TAG_CATEGORIES = [
  { id: 'purpose', label: 'Purpose', description: 'Why you made the trip' },
  { id: 'route', label: 'Route', description: 'Where and how the trip was driven' },
  { id: 'condition', label: 'Conditions', description: 'Weather, light, and traffic context' },
  { id: 'custom', label: 'Your tags', description: 'Personal labels you created' },
];

export const TRIP_TAG_OPTIONS = [
  { id: 'commute', label: 'Commute', category: 'purpose', description: 'A repeated workday route', className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50' },
  { id: 'errand', label: 'Errand', category: 'purpose', description: 'A short practical trip', className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-800/50' },
  { id: 'school_run', label: 'School run', category: 'purpose', description: 'School or childcare travel', className: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/30 dark:text-fuchsia-300 dark:border-fuchsia-800/50' },
  { id: 'appointment', label: 'Appointment', category: 'purpose', description: 'A scheduled visit or meeting', className: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800/50' },
  { id: 'leisure', label: 'Leisure', category: 'purpose', description: 'Personal or recreational travel', className: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950/30 dark:text-pink-300 dark:border-pink-800/50' },
  { id: 'practice', label: 'Practice', category: 'purpose', description: 'Driving practice or training', className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800/50' },
  { id: 'highway', label: 'Highway', category: 'route', description: 'Mostly highway driving', className: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800/50' },
  { id: 'city', label: 'City', category: 'route', description: 'Mostly urban or residential roads', className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/50' },
  { id: 'rural', label: 'Rural', category: 'route', description: 'Mostly rural roads', className: 'bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/30 dark:text-lime-300 dark:border-lime-800/50' },
  { id: 'night', label: 'Night', category: 'condition', description: 'Driven during night-risk hours', className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' },
  { id: 'rain', label: 'Rain', category: 'condition', description: 'Rain or wet-road evidence', className: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-800/50' },
  { id: 'snow', label: 'Snow / ice', category: 'condition', description: 'Snow or freezing-condition evidence', className: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800/50' },
  { id: 'heavy_traffic', label: 'Heavy traffic', category: 'condition', description: 'Congested traffic evidence', className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800/50' },
];

const LEGACY_TAG_MAP = {
  work: 'commute',
  errands: 'errand',
  personal: 'city',
};

const SCORE_LABELS = {
  overall: 'Overall score',
  score_overall: 'Overall score',
  safety: 'Safety score',
  score_safety: 'Safety score',
  smoothness: 'Smoothness score',
  score_smoothness: 'Smoothness score',
  aggressive: 'Aggression score',
  aggressive_driving_score: 'Aggression score',
  defensive: 'Defensive driving estimate',
  defensive_driving_score: 'Defensive driving estimate',
};

const TAG_BY_ID = new Map(TRIP_TAG_OPTIONS.map((tag) => [tag.id, tag]));
const CUSTOM_TAG_CLASS = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800/50';
const WEATHER_TAG_IDS = new Set(['rain', 'snow']);
const WEATHER_BADGE_PRESENTATION = Object.freeze({
  clear: {
    label: 'Clear',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800/50',
  },
  cloudy: {
    label: 'Cloudy',
    className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
  },
  fog: {
    label: 'Fog',
    className: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600',
  },
  rain: {
    label: 'Rain',
    className: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-800/50',
    replacesTag: 'rain',
  },
  snow: {
    label: 'Snow / ice',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800/50',
    replacesTag: 'snow',
  },
  freezing_precipitation: {
    label: 'Ice / freezing rain',
    className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50',
    replacesTag: 'snow',
  },
  storm: {
    label: 'Thunderstorm',
    className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800/50',
    replacesTag: 'rain',
  },
});

const titleCaseTag = (id = '') => String(id)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

/**
 * Normalize a built-in or user-created tag to a safe local identifier.
 * @param {any} value
 * @returns {string}
 */
export function normalizeTripTagId(value) {
  const raw = String(value || '').trim().toLowerCase();
  const legacy = LEGACY_TAG_MAP[raw] || raw;
  const normalized = legacy
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/[_-]{2,}/g, '_')
    .slice(0, 40);
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized) ? normalized : '';
}

/**
 * @param {any} tripOrTags
 * @returns {string[]}
 */
export function normalizeTripTags(tripOrTags = []) {
  const input = Array.isArray(tripOrTags)
    ? tripOrTags
    : [
      ...(Array.isArray(tripOrTags?.tags) ? tripOrTags.tags : []),
      tripOrTags?.tag,
    ];

  const normalized = [...new Set(input
    .map(normalizeTripTagId)
    .filter(Boolean))];
  if (Array.isArray(tripOrTags)) return normalized;

  const weatherSource = String(tripOrTags?.weather_context?.source || '').toLowerCase();
  const weatherCondition = String(tripOrTags?.weather_context?.condition || '').toLowerCase();
  if (!['open_meteo', 'user_confirmed'].includes(weatherSource) || !weatherCondition) {
    return normalized;
  }

  const expectedWeatherTag = /(snow|ice|freez|sleet)/.test(weatherCondition)
    ? 'snow'
    : /(rain|wet|storm)/.test(weatherCondition)
      ? 'rain'
      : null;
  return normalized.filter((tag) => (
    !WEATHER_TAG_IDS.has(tag) ||
    tripOrTags?.tag_sources?.[tag]?.source !== 'weather_evidence' ||
    tag === expectedWeatherTag
  ));
}

/**
 * Build a display-only weather badge from saved trusted weather evidence.
 * Clear, fog, storm, and freezing conditions are intentionally not persisted as
 * trip tags, but should still remain visible on trip summary cards.
 *
 * @param {any} trip
 * @returns {{id:string,label:string,className:string,title:string,replacesTag:string|null,source:string}|null}
 */
export function getTripWeatherBadge(trip = {}) {
  const weather = trip?.weather_context;
  const rawSource = String(weather?.source || weather?.provider || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  const source = rawSource === 'openmeteo' ? 'open_meteo' : rawSource;
  if (!['open_meteo', 'user_confirmed'].includes(source)) return null;

  const rawCondition = String(weather?.condition || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const condition = /(snow|sleet)/.test(rawCondition)
    ? 'snow'
    : /(freez|ice)/.test(rawCondition)
      ? 'freezing_precipitation'
      : /(rain|wet|shower|drizzle)/.test(rawCondition)
        ? 'rain'
        : /(storm|thunder)/.test(rawCondition)
          ? 'storm'
          : /(fog|mist)/.test(rawCondition)
            ? 'fog'
            : /(cloud|overcast)/.test(rawCondition)
              ? 'cloudy'
              : /(clear|dry)/.test(rawCondition)
                ? 'clear'
                : rawCondition;
  const presentation = WEATHER_BADGE_PRESENTATION[condition];
  if (!presentation) return null;

  const sourceLabel = source === 'user_confirmed' ? 'confirmed by you' : 'Open-Meteo';
  return {
    id: `weather:${condition}`,
    label: presentation.label,
    className: presentation.className,
    title: `Weather: ${presentation.label} (${sourceLabel})`,
    replacesTag: presentation.replacesTag || null,
    source,
  };
}

/**
 * @param {string} id
 */
export function getTripTagOption(id) {
  const normalized = normalizeTripTagId(id);
  if (!normalized) return null;
  return TAG_BY_ID.get(normalized) || {
    id: normalized,
    label: titleCaseTag(normalized),
    category: 'custom',
    description: 'Your personal trip tag',
    className: CUSTOM_TAG_CLASS,
    custom: true,
  };
}

/**
 * @param {string} id
 */
export function getTripTagLabel(id) {
  return getTripTagOption(id)?.label || id;
}

/**
 * @param {any} trip
 */
export function getTripDisplayName(trip = {}) {
  const nickname = String(trip.nickname || '').trim();
  if (nickname) return nickname;
  if (trip.start_address || trip.end_address) {
    return [trip.start_address || 'Start', trip.end_address || 'End'].join(' to ');
  }
  return 'Untitled trip';
}

/**
 * @param {any} trip
 * @param {any} vehicle
 */
const searchableNumberForms = (value, digits = 1) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return [];
  return [...new Set([
    String(numeric),
    numeric.toFixed(digits),
    String(Math.round(numeric)),
  ])];
};

const tripDateSearchTokens = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return [];
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(date);
  const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date);
  const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(date);

  return [
    date.toLocaleDateString(),
    date.toLocaleString(),
    new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date),
    monthLong,
    monthShort,
    weekdayLong,
    `${year}-${paddedMonth}-${paddedDay}`,
    `${month}/${day}/${year}`,
    `${day}/${month}/${year}`,
    `${monthLong} ${day}`,
    `${day} ${monthLong}`,
  ];
};

/**
 * Build a token-rich search record so users can combine place, calendar,
 * distance, duration, score, event, tag, and vehicle terms in any order.
 * @param {any} trip
 * @param {any} vehicle
 */
export function buildTripSearchText(trip = {}, vehicle = null) {
  const tags = normalizeTripTags(trip).map(getTripTagLabel);
  const distanceKm = Number(trip.distance_km);
  const distanceMiles = Number.isFinite(distanceKm) ? distanceKm * 0.621371 : null;
  const durationSeconds = Number(trip.duration_seconds);
  const durationMinutes = Number.isFinite(durationSeconds) ? durationSeconds / 60 : null;
  const durationHours = Number.isFinite(durationSeconds) ? durationSeconds / 3600 : null;
  const speedKmh = Number(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh);
  const distanceTokens = searchableNumberForms(distanceKm).flatMap((value) => [
    `${value} km`, `${value}km`, `distance ${value}`, `${value} kilometres`, `${value} kilometers`,
  ]);
  const mileTokens = searchableNumberForms(distanceMiles).flatMap((value) => [
    `${value} mi`, `${value}mi`, `${value} miles`,
  ]);
  const durationTokens = [
    ...searchableNumberForms(durationMinutes).flatMap((value) => [
      `${value} min`, `${value} minutes`, `duration ${value}`,
    ]),
    ...searchableNumberForms(durationHours).flatMap((value) => [
      `${value} hr`, `${value} hours`,
    ]),
  ];
  const speedTokens = searchableNumberForms(speedKmh).flatMap((value) => [
    `${value} km/h`, `${value} kmh`, `speed ${value}`,
  ]);
  const scoreTokens = [
    ['overall', trip.score_overall],
    ['safety', trip.score_safety],
    ['smoothness', trip.score_smoothness],
  ].flatMap(([label, value]) => searchableNumberForms(value, 0).flatMap((number) => [
    number,
    `${label} ${number}`,
    `${label} score ${number}`,
    `score ${number}`,
  ]));
  const eventTokens = [
    ['harsh brake', trip.harsh_brakes_count],
    ['rapid acceleration', trip.rapid_accel_count],
    ['sharp turn', trip.sharp_turns_count],
    ['speeding', trip.speeding_events_count],
    ['phone use', trip.phone_use_window_count],
  ].flatMap(([label, value]) => searchableNumberForms(value, 0).flatMap((number) => [
    `${number} ${label}`,
    `${label} ${number}`,
  ]));

  return [
    trip.id,
    trip.nickname,
    trip.notes,
    trip.start_address,
    trip.end_address,
    trip.road_type,
    trip.dominant_road_type,
    trip.status,
    trip.is_favorite ? 'favorite starred' : '',
    trip.night_driving ? 'night evening' : '',
    trip.privacy_mode === 'summary_only' ? 'private privacy summary only' : '',
    vehicle?.name,
    vehicle?.make,
    vehicle?.model,
    vehicle?.year,
    vehicle?.license_plate,
    ...tags,
    ...tripDateSearchTokens(trip.start_time),
    ...distanceTokens,
    ...mileTokens,
    ...durationTokens,
    ...speedTokens,
    ...scoreTokens,
    ...eventTokens,
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * @param {any} trip
 */
export function isHighRiskTrip(trip = {}) {
  const riskyEvents =
    (trip.harsh_brakes_count || 0) +
    (trip.rapid_accel_count || 0) +
    (trip.sharp_turns_count || 0) +
    (trip.speeding_events_count || 0) +
    (trip.close_proximity_count ?? 0);
  return (trip.score_overall ?? 100) < 60 ||
    riskyEvents >= 4 ||
    trip.aggressive_grade === 'aggressive' ||
    (trip.phone_use_score_available === true && ['medium', 'high'].includes(trip.phone_use_risk));
}

const plural = (count, label) => `${count} ${label}${count === 1 ? '' : 's'}`;

/**
 * @param {any} trip
 * @param {string} scoreKey
 */
export function buildScoreExplanation(trip = {}, scoreKey = 'overall') {
  const label = SCORE_LABELS[scoreKey] || 'Score';
  const candidates = [trip[scoreKey], trip[`score_${scoreKey}`], trip.score_overall]
    .map((value) => (value == null || value === '' ? null : Number(value)))
    .filter(Number.isFinite);
  const score = candidates[0] ?? null;
  const reasons = [];

  if ((trip.harsh_brakes_count || 0) > 0) reasons.push(plural(trip.harsh_brakes_count, 'harsh brake'));
  if ((trip.sharp_turns_count || 0) > 0) reasons.push(plural(trip.sharp_turns_count, 'sharp turn'));
  if ((trip.rapid_accel_count || 0) > 0) reasons.push(plural(trip.rapid_accel_count, 'rapid acceleration'));
  if ((trip.speeding_events_count || 0) > 0) reasons.push(plural(trip.speeding_events_count, 'speeding event'));
  if ((trip.close_proximity_count ?? 0) > 0) reasons.push(plural(trip.close_proximity_count, 'estimated brake-turn manoeuvre alert'));
  if ((trip.phone_use_window_count || 0) > 0) reasons.push(plural(trip.phone_use_window_count, 'phone-use window'));

  if (score == null) {
    return `${label} is unavailable until this trip has enough scored evidence.`;
  }

  if (score >= 85 && reasons.length === 0) {
    return `${label} stayed high because Road Sage found no major harsh braking, sharp turns, speeding, or confirmed phone-use events.`;
  }

  if (reasons.length === 0) {
    return `${label} reflects smoothness, speed consistency, eco driving, and route context from this trip.`;
  }

  const verb = score < 70 ? 'dropped' : 'changed';
  return `${label} ${verb} because of ${reasons.slice(0, 4).join(', ')}.`;
}

const startOfWeek = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
};

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

/**
 * @param {any[]} trips
 */
export function calculateRecentBrakingImprovement(trips = []) {
  const weekStart = startOfWeek();
  const previousWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
  const completed = trips.filter((trip) => trip.status === 'completed');
  const scoreFor = (trip) => Number.isFinite(Number(trip.braking_efficiency_score))
    ? Number(trip.braking_efficiency_score)
    : Math.max(0, 100 - (Number(trip.harsh_brakes_count) || 0) * 12);
  const thisWeek = completed
    .filter((trip) => new Date(trip.start_time).getTime() >= weekStart.getTime())
    .map(scoreFor);
  const previousWeek = completed
    .filter((trip) => {
      const time = new Date(trip.start_time).getTime();
      return time >= previousWeekStart.getTime() && time < weekStart.getTime();
    })
    .map(scoreFor);
  const current = average(thisWeek);
  const previous = average(previousWeek);

  if (current == null || previous == null || previous <= 0) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent <= 0) return null;
  return {
    percent,
    current: Math.round(current),
    previous: Math.round(previous),
    message: `You improved braking by ${percent}% this week.`,
  };
}

/**
 * @param {any} parkedLocation
 */
export function formatParkingReminder(parkedLocation) {
  const parkingState = parkedLocation?.status ? parkedLocation : null;
  const location = parkingState?.status === 'saved'
    ? parkingState.location
    : parkedLocation;
  const timestamp = parkingState?.timestamp || location?.timestamp;
  if (!timestamp) return null;
  const parkedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(parkedAt)) return null;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - parkedAt) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (parkingState?.status === 'private') {
    return `Parked ${duration} ago in a privacy zone. The exact location is intentionally hidden.`;
  }
  if (parkingState?.status === 'unavailable') {
    return `Parking update from ${duration} ago needs review because the trip ended without a trustworthy public GPS fix.`;
  }
  const place = location?.address ||
    (Number.isFinite(location?.lat) && Number.isFinite(location?.lng)
      ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`
      : 'your last saved spot');
  const confidenceScore = Number(location?.confidence_score ?? parkingState?.confidence_score);
  const confidence = Number.isFinite(confidenceScore) && confidenceScore > 0
    ? ` ${Math.round(confidenceScore)}% parking confidence${location?.strategy === 'post_stop_refinement' || Number(location?.refinement_count) > 0 ? ' after GPS refinement' : ''}.`
    : '';
  return `Parked ${duration} ago near ${place}.${confidence}`;
}
