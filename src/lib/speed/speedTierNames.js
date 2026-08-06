/**
 * The speed-limit tier vocabulary: canonical source names, the tier each source
 * maps to, and the voice cooldown per tier.
 *
 * This lives at the bottom of the speed module graph on purpose. Both
 * speedLimitSource.js and speedConfidencePolicy.js need this vocabulary, and
 * pointing them at each other for it produced an import cycle. Nothing here may
 * import from either.
 */

export const SPEED_LIMIT_CONFIDENCE = Object.freeze({
  POSTED: 'posted',
  MAP_ESTIMATED: 'map_estimated',
  LEARNED_LOCAL: 'learned_local',
  REGION_DEFAULT: 'region_default_estimate',
  GPS_INFERRED: 'gps_inferred',
  UNKNOWN: 'unknown',
});

export const LEGACY_SPEED_SOURCE_ALIASES = Object.freeze({
  country_statutory: 'region_default_estimate',
  COUNTRY_STATUTORY: 'REGION_DEFAULT',
  user_correction: 'user_entered_estimate',
});

/**
 * How long a spoken warning for a tier stays suppressed after it fires. Lower
 * confidence buys a longer silence.
 */
export const VOICE_COOLDOWNS_BY_TIER = Object.freeze({
  POSTED: 60000,
  MAP_ESTIMATED: 90000,
  LEARNED_LOCAL: 90000,
  REGION_DEFAULT: 120000,
  GPS_INFERRED: 180000,
  UNKNOWN: Infinity,
});

/** Tiers whose limit is an estimate rather than an observed or mapped posting. */
export const ESTIMATED_SPEED_TIERS = Object.freeze(['MAP_ESTIMATED', 'LEARNED_LOCAL', 'REGION_DEFAULT']);

export function canonicalSpeedSource(source) {
  return LEGACY_SPEED_SOURCE_ALIASES[source] || source;
}

export function canonicalSpeedTier(tierName) {
  return LEGACY_SPEED_SOURCE_ALIASES[tierName] || tierName;
}

export function tierForSource(source) {
  switch (canonicalSpeedSource(source)) {
    case 'openstreetmap':
    case 'user_confirmed_posted_sign':
      return 'POSTED';
    case 'user_entered_estimate':
    case 'learned_local':
    case 'local_road_memory':
      return 'LEARNED_LOCAL';
    case 'osm_highway_default':
      return 'MAP_ESTIMATED';
    case 'region_default_estimate':
      return 'REGION_DEFAULT';
    case 'inferred':
      return 'GPS_INFERRED';
    default:
      return 'UNKNOWN';
  }
}

export function isEstimatedSpeedTier(tierName) {
  return ESTIMATED_SPEED_TIERS.includes(canonicalSpeedTier(tierName));
}

export function voiceCooldownMsForTier(tierName, fallbackMs = 60000) {
  const cooldown = VOICE_COOLDOWNS_BY_TIER[canonicalSpeedTier(tierName)];
  return cooldown === undefined ? fallbackMs : cooldown;
}
