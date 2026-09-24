const DAY_MS = 24 * 60 * 60 * 1000;

const validDate = (value) => {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
};

const tripDurationSeconds = (trip) => {
  const stored = Number(trip?.duration_seconds);
  if (Number.isFinite(stored) && stored >= 0) return stored;

  const start = validDate(trip?.start_time ?? trip?.startedAt);
  const end = validDate(trip?.end_time ?? trip?.endedAt);
  if (!start || !end || end <= start) return 0;
  return (end.getTime() - start.getTime()) / 1000;
};

const localDayKey = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

/**
 * Build compact, descriptive dashboard activity metrics. These intentionally
 * describe mobility volume rather than repeating Coaching or Insights analysis.
 */
export function buildDashboardActivityStats(trips = [], { now = new Date(), periodDays = 7 } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const limitedPeriodDays = Number.isFinite(Number(periodDays)) && Number(periodDays) > 0 ? Number(periodDays) : null;
  const cutoffMs = limitedPeriodDays == null ? null : nowDate.getTime() - limitedPeriodDays * DAY_MS;
  const completed = (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed')
    .map((trip) => ({ trip, start: validDate(trip.start_time ?? trip.startedAt) }))
    .filter(({ start }) => (
      start
      && start.getTime() <= nowDate.getTime()
      && (cutoffMs == null || start.getTime() >= cutoffMs)
    ));

  const distanceKm = completed.reduce((sum, { trip }) => sum + Math.max(0, Number(trip.distance_km) || 0), 0);
  const drivingSeconds = completed.reduce((sum, { trip }) => sum + tripDurationSeconds(trip), 0);
  const activeDays = new Set(completed.map(({ start }) => localDayKey(start))).size;
  const longestTripKm = completed.reduce((longest, { trip }) => Math.max(longest, Number(trip.distance_km) || 0), 0);

  return {
    periodDays: limitedPeriodDays,
    tripCount: completed.length,
    distanceKm,
    drivingSeconds,
    activeDays,
    averageTripKm: completed.length ? distanceKm / completed.length : 0,
    longestTripKm,
    tripsPerActiveDay: activeDays ? completed.length / activeDays : 0,
  };
}


/**
 * The Dashboard's activity figures from its two owners: the exact D1 lifetime
 * aggregate (all-time trips and distance) and the bounded activity reducer
 * (`p7.dashboard.activityStats@1`: driving time, active local days, longest trip,
 * and its own trip count over the same scanned rows).
 *
 * DPD-034. `tripsPerActiveDay` divided the D1 lifetime trip count by the reducer's
 * active days — 3,000 / 67 = 44.8 on the A54, against a true 3.0. A rate must take
 * both operands from one population, so it uses the reducer's own trip count.
 */
export function deriveDashboardActivity({
  stats = null,
  isAllTime = false,
  lifetimeTrips = null,
  lifetimeDistanceKm = null,
} = {}) {
  const tripCount = isAllTime && Number.isFinite(lifetimeTrips)
    ? lifetimeTrips
    : Number(stats?.trip_count) || 0;
  const distanceKm = isAllTime && Number.isFinite(lifetimeDistanceKm)
    ? lifetimeDistanceKm
    : (Number(stats?.distance_m) || 0) / 1000;
  const activeDays = Number(stats?.active_local_days) || 0;
  const windowTripCount = Number(stats?.trip_count) || 0;
  return {
    periodDays: isAllTime ? null : 7,
    tripCount,
    distanceKm,
    drivingSeconds: Number(stats?.driving_seconds) || 0,
    activeDays,
    averageTripKm: tripCount ? distanceKm / tripCount : 0,
    longestTripKm: (Number(stats?.longest_trip_distance_m) || 0) / 1000,
    tripsPerActiveDay: activeDays ? windowTripCount / activeDays : 0,
  };
}

/**
 * The score-review banner counts trips in the Dashboard's bounded recent window
 * (the latest `windowCount` rows), not the history. At 3,000 trips the A54 read
 * "60 completed trips used an older scoring model" — a window count stated as if
 * it were the population. The count names its window unless the lifetime owner
 * proves the window is the whole history.
 */
export function scoreReviewBannerText({
  mismatchCount = 0,
  unavailableCount = 0,
  windowCount = 0,
  lifetimeTrips = null,
} = {}) {
  const wholeHistory = Number.isFinite(lifetimeTrips) && lifetimeTrips <= windowCount;
  const among = wholeHistory ? '' : ` of the latest ${windowCount}`;
  if (mismatchCount > 0) {
    const noun = wholeHistory ? `completed trip${mismatchCount === 1 ? '' : 's'}` : 'completed trips';
    return `${mismatchCount}${among} ${noun} used an older scoring model. Tap to open re-scoring.`;
  }
  const verb = unavailableCount === 1 ? ' has' : ' have';
  const noun = wholeHistory ? `trip${unavailableCount === 1 ? '' : 's'}` : 'trips';
  return `${unavailableCount}${among} ${noun}${verb} unavailable scores. Tap to re-score from Settings.`;
}
