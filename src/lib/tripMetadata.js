export const TRIP_TAG_OPTIONS = [
  { id: 'commute', label: 'Commute', className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50' },
  { id: 'errand', label: 'Errand', className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-800/50' },
  { id: 'highway', label: 'Highway', className: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800/50' },
  { id: 'city', label: 'City', className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/50' },
  { id: 'practice', label: 'Practice', className: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-800/50' },
  { id: 'night', label: 'Night', className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' },
  { id: 'rain', label: 'Rain', className: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-800/50' },
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
  eco: 'Eco score',
  score_eco: 'Eco score',
  aggressive: 'Aggression score',
  aggressive_driving_score: 'Aggression score',
  defensive: 'Defensive score',
  defensive_driving_score: 'Defensive score',
};

const TAG_BY_ID = new Map(TRIP_TAG_OPTIONS.map((tag) => [tag.id, tag]));

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

  return [...new Set(input
    .map((tag) => LEGACY_TAG_MAP[String(tag || '').toLowerCase()] || String(tag || '').toLowerCase())
    .filter((tag) => TAG_BY_ID.has(tag)))];
}

/**
 * @param {string} id
 */
export function getTripTagOption(id) {
  return TAG_BY_ID.get(id) || null;
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
export function buildTripSearchText(trip = {}, vehicle = null) {
  const tags = normalizeTripTags(trip).map(getTripTagLabel);
  const scores = [
    trip.score_overall,
    trip.score_safety,
    trip.score_smoothness,
    trip.score_eco,
  ].filter((score) => score != null);
  const dates = [
    trip.start_time ? new Date(trip.start_time).toLocaleDateString() : '',
    trip.start_time ? new Date(trip.start_time).toLocaleString() : '',
  ];

  return [
    trip.nickname,
    trip.notes,
    trip.start_address,
    trip.end_address,
    vehicle?.name,
    vehicle?.make,
    vehicle?.model,
    ...tags,
    ...scores,
    ...dates,
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
    (trip.near_miss_count || 0);
  return (trip.score_overall ?? 100) < 60 ||
    riskyEvents >= 4 ||
    trip.aggressive_grade === 'aggressive' ||
    ['possible', 'likely', 'high'].includes(trip.phone_proxy_risk || trip.phone_use_risk);
}

const plural = (count, label) => `${count} ${label}${count === 1 ? '' : 's'}`;

/**
 * @param {any} trip
 * @param {string} scoreKey
 */
export function buildScoreExplanation(trip = {}, scoreKey = 'overall') {
  const label = SCORE_LABELS[scoreKey] || 'Score';
  const score = Number(trip[scoreKey]) || Number(trip[`score_${scoreKey}`]) || Number(trip.score_overall) || 0;
  const reasons = [];

  if ((trip.harsh_brakes_count || 0) > 0) reasons.push(plural(trip.harsh_brakes_count, 'harsh brake'));
  if ((trip.sharp_turns_count || 0) > 0) reasons.push(plural(trip.sharp_turns_count, 'sharp turn'));
  if ((trip.rapid_accel_count || 0) > 0) reasons.push(plural(trip.rapid_accel_count, 'rapid acceleration'));
  if ((trip.speeding_events_count || 0) > 0) reasons.push(plural(trip.speeding_events_count, 'speeding event'));
  if ((trip.near_miss_count || 0) > 0) reasons.push(plural(trip.near_miss_count, 'estimated close-proximity alert'));
  if ((trip.phone_use_window_count || 0) > 0) reasons.push(plural(trip.phone_use_window_count, 'phone-use window'));

  if (score >= 85 && reasons.length === 0) {
    return `${label} stayed high because Road Sage found no major harsh braking, sharp turns, speeding, or phone-use patterns.`;
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
  if (!parkedLocation?.timestamp) return null;
  const parkedAt = new Date(parkedLocation.timestamp).getTime();
  if (!Number.isFinite(parkedAt)) return null;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - parkedAt) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const place = parkedLocation.address ||
    (Number.isFinite(parkedLocation.lat) && Number.isFinite(parkedLocation.lng)
      ? `${parkedLocation.lat.toFixed(5)}, ${parkedLocation.lng.toFixed(5)}`
      : 'your last saved spot');
  return `Parked ${duration} ago near ${place}.`;
}
