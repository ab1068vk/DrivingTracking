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

