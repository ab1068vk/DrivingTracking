import { analyzeTimeOfDay } from '@/lib/tripInsights';

const eventTotal = (trips, key) => trips.reduce((sum, trip) => sum + (Number(trip[key]) || 0), 0);

export function buildWeeklyCoachSummary(trips = []) {
  const completed = (trips || [])
    .filter((trip) => trip.status === 'completed')
    .sort((a, b) => new Date(b.start_time || 0).getTime() - new Date(a.start_time || 0).getTime());
  if (completed.length < 3) {
    return {
      headline: 'Complete a few more trips to unlock weekly coaching.',
      insight: 'Road Sage needs at least three completed trips for a reliable local summary.',
      actions: ['Record normal trips this week.'],
      confidence: 'low',
    };
  }

  const now = Date.now();
  const week = completed.filter((trip) => now - new Date(trip.start_time || 0).getTime() <= 7 * 86400000);
  const scope = week.length >= 2 ? week : completed.slice(0, 10);
  const totals = [
    ['late braking', eventTotal(scope, 'harsh_brakes_count')],
    ['hard acceleration', eventTotal(scope, 'rapid_accel_count')],
    ['sharp cornering', eventTotal(scope, 'sharp_turns_count')],
    ['speeding', eventTotal(scope, 'speeding_events_count')],
    ['phone distraction', eventTotal(scope, 'phone_use_window_count')],
  ].sort((a, b) => b[1] - a[1]);
  const biggest = totals[0];
  const cityShort = scope.filter((trip) => (
    (trip.dominant_road_type === 'urban' || trip.road_type === 'urban') &&
    (Number(trip.duration_seconds) || 0) <= 30 * 60
  ));
  const evening = scope.filter((trip) => new Date(trip.start_time || 0).getHours() >= 17);
  const windows = analyzeTimeOfDay(scope).sort((a, b) => (b.events || 0) - (a.events || 0));
  const pressureWindow = windows[0]?.label || (evening.length >= scope.length / 2 ? 'Evening' : 'mixed times');
  const avgScore = Math.round(scope.reduce((sum, trip) => sum + (Number(trip.score_overall) || 0), 0) / scope.length);

  const context = [
    cityShort.length >= 2 ? 'short city trips' : null,
    pressureWindow !== 'mixed times' ? `around ${pressureWindow.toLowerCase()}` : null,
  ].filter(Boolean).join(' ');

  const headline = biggest[1] > 0
    ? `Your biggest risk is ${biggest[0]}${context ? ` on ${context}` : ''}.`
    : `Your recent trips are steady with an average score of ${avgScore}.`;

  const actions = biggest[0] === 'late braking'
    ? ['Lift earlier before stops.', 'Add two seconds of following space.', 'Watch for repeat danger zones near intersections.']
    : biggest[0] === 'speeding'
      ? ['Set cruise slightly below the limit.', 'Use the first minute of each trip to settle speed.', 'Review OSM speed-limit coverage after trips.']
      : biggest[0] === 'phone distraction'
        ? ['Enable Do Not Disturb while driving.', 'Keep the phone out of reach.', 'Use voice navigation before moving.']
        : ['Keep throttle inputs gradual.', 'Brake before turns, then accelerate out.', 'Protect a calm first five minutes.'];

  return {
    headline,
    insight: `Local rules analyzed ${scope.length} trip${scope.length === 1 ? '' : 's'} with average score ${avgScore}. No AI service was used.`,
    actions,
    focus: biggest[0],
    confidence: scope.length >= 6 ? 'high' : 'medium',
  };
}
