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

// `coveredBy` names the component factor that already measures the same behaviour. When
// that component is shown, its event row is suppressed so one behaviour is not reported to
// the driver twice under two different headings.
const EVENT_FACTORS = [
  { key: 'harsh_brakes_count', singular: 'harsh brake', category: 'Safety', coveredBy: 'braking_efficiency' },
  { key: 'speeding_events_count', singular: 'speeding event', category: 'Safety', coveredBy: 'speed_limit_compliance' },
  { key: 'rapid_accel_count', singular: 'rapid acceleration', category: 'Smoothness', coveredBy: 'smoothness_index' },
  { key: 'sharp_turns_count', singular: 'sharp turn', category: 'Smoothness', coveredBy: 'cornering_consistency' },
  { key: 'phone_use_window_count', singular: 'moving foreground-app window', category: 'Safety', coveredBy: 'phone_use' },
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
    // An event count is not a score deficit and the two are not on a common scale, so this
    // only orders events against each other - never against a component. See `ordered`.
    deficit: count * 10,
    evidence: null,
    note: null,
  };
};

const ranked = (factors, limit) => factors
  .filter(Boolean)
  .sort((a, b) => b.deficit - a.deficit || a.label.localeCompare(b.label))
  .slice(0, limit);

// Components are measured score deficits; events are raw counts scaled by a placeholder.
// Sorting them in one list let "5 sharp turns" (deficit 50) outrank a cornering component
// of 55 (deficit 45), implying the count mattered more when the two units are not
// comparable at all. Rank each kind among its own, then show components first.
const ordered = (components, events, limit) => [
  ...ranked(components, limit),
  ...ranked(events, limit),
].slice(0, limit);

export function explainTripScoreDrivers(trip = {}, { limit = 3 } = {}) {
  const detailed = ranked(COMPONENT_FACTORS.map((definition) => componentFactor(trip, definition)), limit);
  const events = ranked(EVENT_FACTORS.map((definition) => eventFactor(trip, definition)), limit);

  if (detailed.length > 0) {
    const detailedKeys = new Set(detailed.map(({ factor }) => factor));
    const eventCoverage = new Map(EVENT_FACTORS.map(({ key, coveredBy }) => [key, coveredBy]));
    const nonDuplicateEvents = events.filter(({ factor }) => !detailedKeys.has(eventCoverage.get(factor)));
    return ordered(detailed, nonDuplicateEvents, limit);
  }

  const headlines = HEADLINE_FACTORS.map((definition) => componentFactor(trip, definition));
  return ordered(headlines, events, limit);
}
