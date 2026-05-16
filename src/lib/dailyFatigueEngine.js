const startOfLocalDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function getTodayTrips(trips = []) {
  const start = startOfLocalDay();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return (trips || []).filter((trip) => {
    if (trip?.status !== 'completed') return false;
    const startTime = new Date(trip.start_time);
    return startTime >= start && startTime < end;
  });
}

export function computeDailyFatigue(todayTrips = [], settings = {}) {
  const trips = [...(todayTrips || [])]
    .filter((trip) => trip?.status === 'completed')
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  const totalDrivingMinutes = Math.max(0, trips.reduce((sum, trip) => {
    const movingSeconds = Math.max(0, (Number(trip.duration_seconds) || 0) - (Number(trip.idle_time_seconds) || 0));
    return sum + movingSeconds / 60;
  }, 0));
  const tripCount = trips.length;

  let longestBreakMinutes = 0;
  for (let i = 1; i < trips.length; i++) {
    const previousEnd = new Date(trips[i - 1].end_time || trips[i - 1].start_time).getTime();
    const currentStart = new Date(trips[i].start_time).getTime();
    if (Number.isFinite(previousEnd) && Number.isFinite(currentStart)) {
      longestBreakMinutes = Math.max(longestBreakMinutes, Math.max(0, (currentStart - previousEnd) / 60000));
    }
  }

  const lastTrip = trips[trips.length - 1] || null;
  const lastTripEndTime = lastTrip?.end_time || null;
  const minutesSinceLastTrip = lastTripEndTime
    ? Math.max(0, (Date.now() - Date.parse(lastTripEndTime)) / 60000)
    : null;

  const durationFatigue = Math.min(5, totalDrivingMinutes / 60);
  const tripCountFatigue = Math.min(2, Math.max(0, tripCount - 1) * 0.5);
  const recoveryCredit = minutesSinceLastTrip != null ? Math.min(2, minutesSinceLastTrip / 30) : 2;
  const cumulativeFatigueScore = clamp(
    Math.round((durationFatigue + tripCountFatigue - recoveryCredit) * 10) / 10,
    0,
    10
  );
  const fatigueLevel = cumulativeFatigueScore >= 7
    ? 'critical'
    : cumulativeFatigueScore >= 5
      ? 'high'
      : cumulativeFatigueScore >= 3
        ? 'moderate'
        : 'low';
  const recommendedBreakMinutes = fatigueLevel === 'critical'
    ? 30
    : fatigueLevel === 'high'
      ? 20
      : fatigueLevel === 'moderate'
        ? 10
        : 0;

  return {
    totalDrivingMinutes: Math.round(totalDrivingMinutes),
    tripCount,
    longestBreakMinutes: Math.round(longestBreakMinutes),
    minutesSinceLastTrip: minutesSinceLastTrip == null ? null : Math.round(minutesSinceLastTrip),
    cumulativeFatigueScore,
    fatigueLevel,
    recommendedBreakMinutes,
    shouldWarnBeforeTrip: fatigueLevel === 'high' || fatigueLevel === 'critical',
  };
}
