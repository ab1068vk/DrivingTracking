export const DASHBOARD_SCORE_REVIEW_DISMISSAL_KEY = 'drivesense_dashboard_score_review_dismissal';

const SCORE_REVIEW_ISSUES = new Set([
  'model-mismatch',
  'score-unavailable',
]);

const tripFingerprint = (trip, issue) => [
  'trip',
  trip?.id || 'unknown-trip',
  issue,
].join(':');

const normalizeScoreReviewItem = (item) => {
  const raw = String(item || '').trim();
  if (!raw) return '';

  const parts = raw.split(':');
  if (parts[0] === 'trip' && parts.length >= 3) {
    const issue = parts[parts.length - 1];
    if (!SCORE_REVIEW_ISSUES.has(issue)) return '';
    return ['trip', parts[1] || 'unknown-trip', issue].join(':');
  }

  const legacyIssue = parts[parts.length - 1];
  if (!SCORE_REVIEW_ISSUES.has(legacyIssue)) return '';
  return ['trip', parts[0] || 'unknown-trip', legacyIssue].join(':');
};

export function normalizeDashboardScoreReviewFingerprint(fingerprint = '') {
  return String(fingerprint || '')
    .split('|')
    .map(normalizeScoreReviewItem)
    .filter(Boolean)
    .sort()
    .join('|');
}

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

export function isDashboardScoreReviewDismissed(dismissedFingerprint = '', currentFingerprint = '') {
  const currentItems = normalizeDashboardScoreReviewFingerprint(currentFingerprint).split('|').filter(Boolean);
  if (!currentItems.length) return false;
  const dismissedItems = new Set(
    normalizeDashboardScoreReviewFingerprint(dismissedFingerprint).split('|').filter(Boolean)
  );
  return currentItems.every((item) => dismissedItems.has(item));
}
