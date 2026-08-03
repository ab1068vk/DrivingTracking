export function speedLimitSourceLabel(source, { short = false } = {}) {
  switch (source) {
    case 'user_confirmed_posted_sign':
      return short ? 'Posted sign' : 'Your confirmed posted sign';
    case 'user_entered_estimate':
    case 'user_correction':
      return short ? 'User estimate' : 'Your saved estimate';
    case 'openstreetmap':
      return short ? 'OSM maxspeed' : 'OpenStreetMap posted limit';
    case 'osm_highway_default':
      return short ? 'OSM estimate' : 'OSM road-type estimate';
    case 'region_default_estimate':
      return short ? 'Regional estimate' : 'Regional default estimate';
    case 'local_road_memory':
      return short ? 'Road Memory' : 'Local Road Memory estimate';
    case 'learned_local':
    case 'trip_consensus':
    case 'time_of_day_bucket':
      return short ? 'Learned' : 'Local learned estimate';
    case 'inferred':
      return short ? 'GPS inferred' : 'GPS-inferred estimate';
    case 'missing_posted_review':
      return short ? 'Needs review' : 'Needs parked review';
    case 'unknown':
      return 'Unknown source';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'Saved speed data';
  }
}

export function speedLimitSourceBadgeClass(source) {
  if (source === 'openstreetmap' || source === 'user_confirmed_posted_sign') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
  }
  if (source === 'user_entered_estimate' || source === 'user_correction' || source === 'voice_user_estimate' || source === 'learned_local' || source === 'local_road_memory' || source === 'trip_consensus' || source === 'time_of_day_bucket') {
    return 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
  }
  if (source === 'voice_user_posted_sign') {
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
  }
  if (source === 'osm_highway_default' || source === 'region_default_estimate' || source === 'inferred') {
    return 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100';
  }
  return 'bg-secondary text-muted-foreground';
}

export function scoreNumber(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.round(score) : null;
}

export function scoreDeltaSummary(beforeScore, afterScore, label = 'Score') {
  const before = scoreNumber(beforeScore);
  const after = scoreNumber(afterScore);
  if (before == null && after == null) return `${label} unavailable after recalculation.`;
  if (before == null) return `${label} now ${after}.`;
  if (after == null) return `${label} changed from ${before} to unavailable.`;
  if (before === after) return `${label} unchanged at ${after}.`;
  return `${label} updated: ${before} -> ${after}.`;
}

export function tripScoreDeltaSummary(beforeTrip = {}, afterTrip = {}) {
  return scoreDeltaSummary(beforeTrip?.score_overall, afterTrip?.score_overall, 'Score');
}

export function summarizeTripScoreDeltas(beforeTrips = [], afterTrips = []) {
  const beforeById = new Map((beforeTrips || []).map((trip) => [String(trip?.id), trip]));
  return (afterTrips || []).map((trip) => ({
    trip,
    text: tripScoreDeltaSummary(beforeById.get(String(trip?.id)), trip),
    changed: scoreNumber(beforeById.get(String(trip?.id))?.score_overall) !== scoreNumber(trip?.score_overall),
  }));
}

export function speedLimitScorePreview(previousLimitKmh, nextLimitKmh) {
  const previous = Number(previousLimitKmh);
  const next = Number(nextLimitKmh);
  if (!Number.isFinite(next) || next <= 0) return 'Enter a speed to preview the score impact.';
  if (!Number.isFinite(previous) || previous <= 0) {
    return 'Saving this speed will rescore matching trips that cross this road section.';
  }
  if (Math.round(previous) === Math.round(next)) {
    return 'Likely no score change unless the source, direction, or active-time rule changes.';
  }
  if (next > previous) {
    return 'Likely raises speed-limit compliance where recorded speeds were between the old and new limits.';
  }
  return 'Likely lowers speed-limit compliance where recorded speeds were above the new limit.';
}
