import { analyzeTimeOfDay } from '@/lib/tripInsights';
import { excludePrivacyTouchedDaysFromTrends } from '@/lib/privateTripMode';

export const WEEKLY_COACH_MIN_SCORE_DELTA = 3;

const eventTotal = (trips, key) => trips.reduce((sum, trip) => sum + (Number(trip[key]) || 0), 0);

const distanceWeightedScore = (trips = []) => {
  const scored = trips
    .map((trip) => ({
      score: trip?.score_overall == null || trip?.score_overall === ''
        ? null
        : Number(trip.score_overall),
      distance: Number(trip?.distance_km) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  const totalKm = scored.reduce((sum, item) => sum + item.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm
    : null;
};

export function buildWeeklyCoachSummary(trips = []) {
  const completed = excludePrivacyTouchedDaysFromTrends(trips)
    .filter((trip) => trip.status === 'completed')
    .sort((a, b) => new Date(b.start_time || 0).getTime() - new Date(a.start_time || 0).getTime());
  if (completed.length < 3) {
    const actions = ['Record normal trips this week.', 'Keep the phone out of reach before moving.', 'Review each completed trip for any obvious wrong events.'];
    return {
      headline: 'Complete a few more trips to unlock weekly coaching.',
      insight: 'Road Sage needs at least three completed trips for a reliable local summary.',
      actions,
      plan: actions.map((action, index) => ({
        id: `weekly-plan-starter-${index + 1}`,
        title: index === 0 ? 'Build baseline' : index === 1 ? 'During each drive' : 'After driving',
        action,
        target: 'Unlock a reliable weekly coach',
      })),
      confidence: 'low',
    };
  }

  const now = Date.now();
  const week = completed.filter((trip) => now - new Date(trip.start_time || 0).getTime() <= 7 * 86400000);
  const scope = week.length >= 2 ? week : completed.slice(0, 10);
  const scopeScore = distanceWeightedScore(scope);
  if (scopeScore == null) {
    const actions = ['Record trips with valid distance and score evidence.', 'Keep the phone out of reach before moving.', 'Review completed trips for any obvious wrong events.'];
    return {
      headline: 'Weekly coaching is waiting for scored driving distance.',
      insight: `Local rules found ${scope.length} completed trip${scope.length === 1 ? '' : 's'}, but none had valid scored distance. No AI service was used.`,
      actions,
      plan: actions.map((action, index) => ({
        id: `weekly-plan-evidence-${index + 1}`,
        title: index === 0 ? 'Build evidence' : index === 1 ? 'During each drive' : 'After driving',
        action,
        target: 'Unlock a reliable weekly coach',
      })),
      confidence: 'unavailable',
    };
  }
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
  const avgScore = Math.round(scopeScore);
  const scopeIds = new Set(scope.map((trip) => trip.id).filter(Boolean));
  const comparison = completed.filter((trip) => !scopeIds.has(trip.id)).slice(0, scope.length);
  const priorScore = distanceWeightedScore(comparison);
  const scoreDelta = priorScore == null ? null : Math.round(avgScore - priorScore);
  const meaningfulScoreChange = scoreDelta != null && Math.abs(scoreDelta) > WEEKLY_COACH_MIN_SCORE_DELTA;

  const context = [
    cityShort.length >= 2 ? 'short city trips' : null,
    pressureWindow !== 'mixed times' ? `around ${pressureWindow.toLowerCase()}` : null,
  ].filter(Boolean).join(' ');

  const headline = biggest[1] > 0
    ? `Your biggest risk is ${biggest[0]}${context ? ` on ${context}` : ''}.`
    : `Your recent trips are steady with an average score of ${avgScore}.`;

  const actions = biggest[0] === 'late braking'
    ? ['Lift earlier before stops.', 'Leave more space ahead.', 'Watch for your repeated driving-event areas near stops.']
    : biggest[0] === 'speeding'
      ? ['Set cruise slightly below the limit.', 'Use the first minute of each trip to settle speed.', 'Review OSM speed-limit coverage after trips.']
      : biggest[0] === 'phone distraction'
        ? ['Enable Do Not Disturb while driving.', 'Keep the phone out of reach.', 'Use voice navigation before moving.']
        : ['Keep throttle inputs gradual.', 'Brake before turns, then accelerate out.', 'Protect a calm first five minutes.'];
  const plan = actions.map((action, index) => ({
    id: `weekly-plan-${index + 1}`,
    title: index === 0 ? 'Primary habit' : index === 1 ? 'During each drive' : 'Review after driving',
    action,
    target: biggest[1] > 0
      ? `Reduce ${biggest[0]} events this week`
      : `Hold average score near ${avgScore}`,
  }));

  return {
    headline,
    insight: `Local rules analyzed ${scope.length} trip${scope.length === 1 ? '' : 's'} with average score ${avgScore}.${meaningfulScoreChange ? ` Score changed ${scoreDelta > 0 ? '+' : ''}${scoreDelta} points from the comparison period.` : ''} No AI service was used.`,
    actions: [...new Set(actions)],
    plan,
    focus: biggest[0],
    confidence: scope.length >= 6 ? 'high' : 'medium',
    decisionRule: `One focus metric per week; score-change commentary requires more than ${WEEKLY_COACH_MIN_SCORE_DELTA} points.`,
  };
}
