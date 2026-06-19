export const DASHBOARD_SCORE_REVIEW_DISMISSAL_KEY = 'drivesense_dashboard_score_review_dismissal';

const tripFingerprint = (trip, issue) => [
  trip?.id || 'unknown-trip',
  trip?.updated_at || trip?.score_provenance?.computed_at || trip?.end_time || '',
  issue,
].join(':');

export function buildDashboardScoreReviewFingerprint({
  mismatchTrips = [],
  unavailableTrips = [],
} = {}) {
  const affectedTrips = [
    ...mismatchTrips.map((trip) => tripFingerprint(trip, 'model-mismatch')),
    ...unavailableTrips.map((trip) => tripFingerprint(trip, 'score-unavailable')),
  ].sort();

  return affectedTrips.length ? affectedTrips.join('|') : '';
}
