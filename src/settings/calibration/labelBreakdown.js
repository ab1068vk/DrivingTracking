const ratingBuckets = Object.freeze({
  5: 'careful',
  4: 'normal',
  3: 'rushed',
  2: 'rushed',
  1: 'incident',
});

export const EMPTY_LABEL_BREAKDOWN = Object.freeze({
  careful: 0,
  normal: 0,
  rushed: 0,
  incident: 0,
});

function ratingFromMarker(marker) {
  const rating = Number(marker?.rating);
  return Number.isInteger(rating) ? rating : null;
}

export function labelBreakdownFromMarkers(markers = {}) {
  return Object.values(markers || {}).reduce((counts, marker) => {
    const bucket = ratingBuckets[ratingFromMarker(marker)];
    if (!bucket) return counts;
    return {
      ...counts,
      [bucket]: counts[bucket] + 1,
    };
  }, { ...EMPTY_LABEL_BREAKDOWN });
}

export function ratedTripCount(markers = {}) {
  return Object.values(markers || {})
    .filter((marker) => ratingFromMarker(marker) != null)
    .length;
}
