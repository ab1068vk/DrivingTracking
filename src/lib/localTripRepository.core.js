export async function enforceDataRetention(retentionMonths = 0, {
  now = Date.now,
  getAllTrips = async () => [],
  deleteTrip = async () => {},
  invalidateTripDerivedCaches = async () => {},
} = {}) {
  const months = Number(retentionMonths);
  if (!Number.isFinite(months) || months <= 0) return 0;

  const cutoff = now() - months * 30.44 * 24 * 60 * 60 * 1000;
  const trips = await getAllTrips();
  const expired = (Array.isArray(trips) ? trips : []).filter((trip) => {
    if (trip?.status !== 'completed') return false;
    const startedAt = new Date(trip.start_time || 0).getTime();
    return Number.isFinite(startedAt) && startedAt > 0 && startedAt < cutoff;
  });

  for (const trip of expired) {
    await deleteTrip(trip.id);
  }
  if (expired.length) await invalidateTripDerivedCaches();
  return expired.length;
}
