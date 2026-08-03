const COMPONENT_FACTORS = [
  { key: 'speed_limit_compliance', label: 'Speed-limit compliance', category: 'Safety', legacyKeys: ['speed_limit_compliance_score'] },
  { key: 'braking_efficiency', label: 'Braking efficiency', category: 'Safety', legacyKeys: ['braking_efficiency_score'] },
  { key: 'lane_changing', label: 'Lane-changing estimate', category: 'Safety', legacyKeys: ['lane_changing_score'] },
  { key: 'phone_use', label: 'Confirmed phone-use signal', category: 'Safety', legacyKeys: ['phone_use_score'] },
  { key: 'smoothness_index', label: 'Acceleration smoothness', category: 'Smoothness', legacyKeys: ['jerk_score'] },
  { key: 'speed_variability', label: 'Speed consistency', category: 'Smoothness', legacyKeys: ['svi_score'] },
  { key: 'brake_onset_smoothness', label: 'Brake onset smoothness', category: 'Smoothness', legacyKeys: ['brake_onset_smoothness_score'] },
  { key: 'cornering_consistency', label: 'Cornering consistency', category: 'Smoothness', legacyKeys: ['cornering_consistency_score'] },
];

const HEADLINE_FACTORS = [
  { key: 'safety', label: 'Safety', category: 'Overall', legacyKeys: ['score_safety'] },
  { key: 'smoothness', label: 'Smoothness', category: 'Overall', legacyKeys: ['score_smoothness'] },
];

const EVENT_FACTORS = [
  { key: 'harsh_brakes_count', singular: 'harsh brake', category: 'Safety' },
  { key: 'speeding_events_count', singular: 'speeding event', category: 'Safety' },
  { key: 'rapid_accel_count', singular: 'rapid acceleration', category: 'Smoothness' },
  { key: 'sharp_turns_count', singular: 'sharp turn', category: 'Smoothness' },
  { key: 'phone_use_window_count', singular: 'moving foreground-app window', category: 'Safety' },
];

const finiteScore = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null;
};

const componentFactor = (trip, definition) => {
  const stored = trip?.component_scores?.[definition.key];
  const score = finiteScore(stored?.value)
    ?? definition.legacyKeys.map((key) => finiteScore(trip?.[key])).find((value) => value != null)
    ?? null;
  if (score == null) return null;

  return {
    factor: definition.key,
    label: definition.label,
    category: definition.category,
    kind: 'component',
    score: Math.round(score),
    deficit: Math.round(100 - score),
    evidence: stored?.evidence || trip?.[`${definition.legacyKeys[0]}_confidence`] || null,
    note: stored?.note || null,
  };
};

const eventFactor = (trip, definition) => {
  const count = Math.max(0, Math.floor(Number(trip?.[definition.key]) || 0));
  if (count === 0) return null;
  return {
    factor: definition.key,
    label: `${count} ${definition.singular}${count === 1 ? '' : 's'} recorded`,
    category: definition.category,
    kind: 'event',
    count,
    deficit: count * 10,
    evidence: null,
    note: null,
  };
};

const ranked = (factors, limit) => factors
  .filter(Boolean)
  .sort((a, b) => b.deficit - a.deficit || a.label.localeCompare(b.label))
  .slice(0, limit);

export function explainTripScoreDrivers(trip = {}, { limit = 3 } = {}) {
  const detailed = ranked(COMPONENT_FACTORS.map((definition) => componentFactor(trip, definition)), limit);
  const events = ranked(EVENT_FACTORS.map((definition) => eventFactor(trip, definition)), limit);

  if (detailed.length > 0) {
    const detailedKeys = new Set(detailed.map(({ factor }) => factor));
    const nonDuplicateEvents = events.filter(({ factor }) => (
      !(factor === 'harsh_brakes_count' && detailedKeys.has('braking_efficiency')) &&
      !(factor === 'speeding_events_count' && detailedKeys.has('speed_limit_compliance')) &&
      !(factor === 'phone_use_window_count' && detailedKeys.has('phone_use'))
    ));
    return ranked([...detailed, ...nonDuplicateEvents], limit);
  }

  const headlines = ranked(HEADLINE_FACTORS.map((definition) => componentFactor(trip, definition)), limit);
  return ranked([...headlines, ...events], limit);
}
