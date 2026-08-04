import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { withRetry } from '@/lib/retry';
import { boundsOverlapPrivacyZone, getPrivacyZones, isPointInPrivacyZone } from '@/lib/privacyZones';
import { privacyGatedFetch } from '@/lib/privacyGatedFetch';
import { enqueueLocationRequest } from '@/lib/requestObfuscator';
import { isHeightenedPrivacyMode } from '@/lib/privacyMode';
import { normalizeHttpsEndpoint } from '@/lib/urlSecurity';

export const SPEED_LIMIT_CACHE_KEY = 'drivesense_osm_speed_limit_cache_v2';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FALLBACK_OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BBOX_SPAN_DEG = 0.8;
const MAX_GEOMETRY_POINTS = 900;
const DIRECT_BBOX_SPAN_DEG = 0.08;
const MAX_CORRIDOR_QUERIES = 6;
const MAX_PRIVACY_CORRIDOR_QUERIES = 12;
const MAX_CORRIDOR_SAMPLE_POINTS = 180;
const CORRIDOR_PAD_DEG = 0.006;
const ZONE_GUARD_M = 50;
const ALL_POINTS_PRIVATE_REASON = 'all_points_private';
const PRIVACY_BOUNDS_OVERLAP_REASON = 'privacy_bounds_overlap';
export const DEFAULT_SPEED_LIMIT_COUNTRY = 'global';
export const SPEED_LIMIT_DEFAULT_COUNTRY_LABELS = Object.freeze({
  global: 'Global',
  gb: 'United Kingdom',
  uk: 'United Kingdom',
  us: 'United States',
  ca: 'Canada',
  de: 'Germany',
  au: 'Australia',
  fr: 'France',
});

export const REGION_SPEED_DEFAULTS = Object.freeze({
  CA: Object.freeze({
    _country: Object.freeze({ urban: 50, suburban: 60, rural: 80, expressway: 100 }),
    ON: Object.freeze({ urban: 50, suburban: 60, rural: 80, expressway: 100 }),
    BC: Object.freeze({ urban: 50, suburban: 60, rural: 80, expressway: 90, highway: 100 }),
    AB: Object.freeze({ urban: 50, suburban: 60, rural: 100, highway: 110 }),
    QC: Object.freeze({ urban: 50, suburban: 70, rural: 90, highway: 100 }),
    MB: Object.freeze({ urban: 50, suburban: 60, rural: 90, highway: 100 }),
    SK: Object.freeze({ urban: 50, suburban: 60, rural: 100, highway: 110 }),
  }),
  US: Object.freeze({
    _country: Object.freeze({ residential: 40, urban: 56, rural: 88, highway: 104 }),
    CA: Object.freeze({ urban: 40, rural: 88, highway: 104 }),
    TX: Object.freeze({ urban: 56, rural: 112, highway: 120 }),
    NY: Object.freeze({ residential: 40, urban: 56, rural: 88, highway: 104 }),
  }),
  GB: Object.freeze({
    _country: Object.freeze({ urban: 48, rural_single: 96, dual_carriageway: 112, motorway: 112 }),
    ENG: Object.freeze({ urban: 48, rural_single: 96, dual_carriageway: 112, motorway: 112 }),
    WLS: Object.freeze({ urban: 32, rural_single: 96, dual_carriageway: 112, motorway: 112 }),
  }),
  DE: Object.freeze({
    _country: Object.freeze({ urban: 50, rural: 100, motorway: null, motorwayAdvisory: 130 }),
  }),
  AU: Object.freeze({
    _country: Object.freeze({ urban: 50, rural: 100, highway: 110 }),
    NSW: Object.freeze({ urban: 50, rural: 100, highway: 110 }),
    VIC: Object.freeze({ urban: 50, rural: 100, highway: 110 }),
    QLD: Object.freeze({ urban: 50, rural: 100, highway: 110 }),
  }),
  FR: Object.freeze({
    _country: Object.freeze({ urban: 50, secondary: 80, national: 80, expressway: 110, autoroute: 130 }),
  }),
  GLOBAL: Object.freeze({
    _country: Object.freeze({ urban: 50, suburban: 60, rural: 80, expressway: 100, highway: 100 }),
  }),
});

export const VOICE_COOLDOWNS_BY_TIER = Object.freeze({
  POSTED: 60000,
  MAP_ESTIMATED: 90000,
  LEARNED_LOCAL: 90000,
  REGION_DEFAULT: 120000,
  GPS_INFERRED: 180000,
  UNKNOWN: Infinity,
});

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

function canonicalSpeedSource(source) {
  return LEGACY_SPEED_SOURCE_ALIASES[source] || source;
}

export function canonicalSpeedTier(tierName) {
  return LEGACY_SPEED_SOURCE_ALIASES[tierName] || tierName;
}

// Rough road-type estimates used only when OSM returns a highway tag without
// a posted maxspeed. These are not official legal speed-limit references.
export const OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH = Object.freeze({
  global: Object.freeze({
    living_street: 20,
    service: 30,
    residential: 40,
    unclassified: 50,
    road: 50,
    tertiary: 50,
    tertiary_link: 50,
    secondary: 60,
    secondary_link: 60,
    primary: 60,
    primary_link: 60,
    trunk_link: 80,
    motorway_link: 80,
    trunk: 100,
    motorway: 100,
  }),
  gb: Object.freeze({
    primary: 96,
    primary_link: 96,
    residential: 48,
    unclassified: 48,
    road: 48,
    trunk: 112,
    motorway: 112,
  }),
  uk: Object.freeze({
    primary: 96,
    primary_link: 96,
    residential: 48,
    unclassified: 48,
    road: 48,
    trunk: 112,
    motorway: 112,
  }),
  us: Object.freeze({
    motorway: 105,
    trunk: 89,
    primary: 72,
    primary_link: 72,
    motorway_link: 89,
    trunk_link: 89,
    residential: 40,
  }),
  ca: Object.freeze({
    motorway: 100,
    trunk: 90,
    residential: 40,
  }),
  de: Object.freeze({
    motorway: null,
    trunk: 100,
    primary: 100,
    primary_link: 100,
    residential: 50,
  }),
  au: Object.freeze({
    motorway: 100,
    trunk: 100,
    primary: 80,
    residential: 50,
  }),
  fr: Object.freeze({
    motorway: 130,
    trunk: 110,
    primary: 80,
    residential: 50,
  }),
});

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

export function confidenceForSource(source, learnedLocalConfidence = null) {
  const explicitConfidence = learnedLocalConfidence == null
    ? null
    : Number(learnedLocalConfidence);
  const hasExplicitConfidence = Number.isFinite(explicitConfidence);
  switch (canonicalSpeedSource(source)) {
    case 'openstreetmap':
      return 1.0;
    case 'user_confirmed_posted_sign':
      return hasExplicitConfidence ? explicitConfidence : 0.92;
    case 'user_entered_estimate':
      return hasExplicitConfidence ? explicitConfidence : 0.75;
    case 'learned_local':
    case 'local_road_memory':
      return learnedLocalConfidence ?? 0.65;
    case 'osm_highway_default':
      return 0.70;
    case 'region_default_estimate':
      return 0.45;
    case 'inferred':
      return 0.35;
    default:
      return 0.0;
  }
}

export function confidenceToPenaltyWeight(confidence) {
  if (confidence >= 0.95) return 1.0;
  if (confidence >= 0.90) return 0.95;
  if (confidence >= 0.65) return 0.85;
  if (confidence >= 0.45) return 0.55;
  if (confidence >= 0.30) return 0.50;
  return 0.0;
}

export function alertMarginForConfidence(confidence, baseMarginKmh = 5) {
  if (confidence >= 0.90) return baseMarginKmh;
  if (confidence >= 0.65) return baseMarginKmh + 3;
  if (confidence >= 0.45) return baseMarginKmh + 7;
  if (confidence >= 0.30) return baseMarginKmh + 15;
  return Infinity;
}

export function getRegionDefaultEstimate(countryCode, provinceCode, roadContext) {
  if (!roadContext) return null;
  const countryKey = countryCode ? String(countryCode).toUpperCase() : 'GLOBAL';
  const country = REGION_SPEED_DEFAULTS[countryKey] ?? REGION_SPEED_DEFAULTS.GLOBAL;
  const provinceKey = provinceCode ? String(provinceCode).toUpperCase() : null;
  const region = provinceKey ? (country[provinceKey] ?? country._country) : country._country;
  const direct = region?.[roadContext] ?? country._country?.[roadContext];
  if (direct !== undefined) return direct;
  if (roadContext === 'highway') {
    const motorway = region?.motorway ?? country._country?.motorway;
    return motorway === undefined ? null : motorway;
  }
  return null;
}

export function roadContextFromOsmType(osmHighwayType) {
  const map = {
    motorway: 'highway',
    motorway_link: 'highway',
    trunk: 'expressway',
    trunk_link: 'expressway',
    primary: 'rural',
    primary_link: 'rural',
    secondary: 'rural',
    secondary_link: 'rural',
    tertiary: 'suburban',
    tertiary_link: 'suburban',
    residential: 'urban',
    living_street: 'urban',
    service: 'urban',
    unclassified: 'urban',
    road: 'urban',
  };
  return map[osmHighwayType] ?? null;
}

export function roadContextFromGpsBehaviour(inferredZoneKmh) {
  if (inferredZoneKmh <= 50) return 'urban';
  if (inferredZoneKmh <= 80) return 'suburban';
  if (inferredZoneKmh <= 100) return 'rural';
  return 'highway';
}

function complianceFallbackLimit(roadContext, thresholds = {}) {
  if (roadContext === 'highway') return thresholds.SPEEDING_FALLBACK_KMH ?? 100;
  if (roadContext === 'urban') return 50;
  if (roadContext === 'suburban') return 60;
  if (roadContext === 'rural') return 80;
  if (roadContext === 'expressway') return 100;
  return thresholds.SPEEDING_FALLBACK_KMH ?? 100;
}

function tier(tierName, limitKmh, confidence, source, baseMarginKmh) {
  const margin = alertMarginForConfidence(confidence, baseMarginKmh);
  return {
    limitKmh,
    tier: tierName,
    confidence,
    source,
    alertMarginKmh: margin,
    penaltyWeight: confidenceToPenaltyWeight(confidence),
    shouldAlert: (speedKmh) => Number(speedKmh) > limitKmh + margin,
  };
}

export function resolveSpeedLimitWithTier(point, context = {}) {
  const {
    localKnowledge,
    countryCode,
    provinceCode,
    osmHighwayType,
    inferredZone,
    thresholds,
  } = context;
  const baseMargin = thresholds?.SPEED_OVER_KMH ?? 5;
  const storedLimit = Number(point?.speed_limit_kmh);
  const storedSource = point?.speed_limit_source;

  if (localKnowledge?.source === 'user_confirmed_posted_sign' && Number(localKnowledge.limitKmh) > 0) {
    const confidence = Number.isFinite(Number(localKnowledge.confidence))
      ? Number(localKnowledge.confidence)
      : 0.92;
    return tier('POSTED', Number(localKnowledge.limitKmh), confidence, 'user_confirmed_posted_sign', baseMargin);
  }

  // A fresh mapped maxspeed is higher authority than a local estimate. A
  // user-confirmed sign is handled above; lower-authority local knowledge is
  // considered before map/region/GPS defaults below.
  if (storedSource === 'openstreetmap' && storedLimit > 0) {
    return tier('POSTED', storedLimit, 1.0, 'openstreetmap', baseMargin);
  }

  if (
    localKnowledge &&
    Number(localKnowledge.limitKmh) > 0 &&
    Number(localKnowledge.confidence) >= 0.55
  ) {
    const confidence = Number(localKnowledge.confidence);
    const source = canonicalSpeedSource(localKnowledge.source) === 'user_entered_estimate'
      ? 'user_entered_estimate'
      : 'learned_local';
    return tier('LEARNED_LOCAL', Number(localKnowledge.limitKmh), confidence, source, baseMargin);
  }

  if (storedSource === 'osm_highway_default' && storedLimit > 0) {
    return tier('MAP_ESTIMATED', storedLimit, 0.70, 'osm_highway_default', baseMargin);
  }

  const inferredZoneKmh = Number(inferredZone?.inferredZoneKmh);
  const roadContext = roadContextFromOsmType(osmHighwayType)
    ?? (Number.isFinite(inferredZoneKmh) ? roadContextFromGpsBehaviour(inferredZoneKmh) : null);
  const regionalDefaultEstimate = getRegionDefaultEstimate(countryCode, provinceCode, roadContext);
  if (regionalDefaultEstimate != null) {
    const regionKey = countryCode ? String(countryCode).toUpperCase() : 'GLOBAL';
    const limitKmh = regionKey === 'GLOBAL'
      ? Math.min(regionalDefaultEstimate, complianceFallbackLimit(roadContext, thresholds))
      : regionalDefaultEstimate;
    return tier('REGION_DEFAULT', limitKmh, 0.45, 'region_default_estimate', baseMargin);
  }

  if (Number.isFinite(inferredZoneKmh) && inferredZoneKmh > 0) {
    const fallbackLimit = complianceFallbackLimit(roadContext ?? 'urban', thresholds);
    return tier('GPS_INFERRED', Math.min(inferredZoneKmh, fallbackLimit), 0.35, 'inferred', baseMargin);
  }

  return {
    limitKmh: null,
    tier: 'UNKNOWN',
    confidence: 0.0,
    source: 'unknown',
    alertMarginKmh: Infinity,
    penaltyWeight: 0.0,
    shouldAlert: () => false,
  };
}

export function applySafetyGuards(best, candidates = [], settings = {}) {
  if (!best) return best;
  const list = Array.isArray(candidates) ? candidates : [];
  const posted = list.find((candidate) => Number(candidate?.confidence) >= 0.95);
  if (posted) return posted;

  const learned = list.find((candidate) => candidate?.tier === 'LEARNED_LOCAL');
  const map = list.find((candidate) => candidate?.tier === 'MAP_ESTIMATED');
  if (
    learned &&
    map &&
    Number(learned.limitKmh) > Number(map.limitKmh) + 10 &&
    learned.source !== 'user_confirmed_posted_sign'
  ) {
    return {
      ...map,
      evidence: {
        ...map.evidence,
        suppressedLearnedHigherLimit: learned.limitKmh,
        safetyGuardReason: settings.safetyGuardReason || 'learned_limit_above_map_default',
      },
    };
  }

  return best;
}

function alertPolicyForLimit(candidate, settings = {}) {
  const tierName = canonicalSpeedTier(candidate?.tier || 'UNKNOWN');
  const baseMargin = settings.threshold_speed_over_kmh ?? settings.SPEED_OVER_KMH ?? 5;
  const visualMarginKmh = Number.isFinite(Number(candidate?.alertMarginKmh))
    ? Number(candidate.alertMarginKmh)
    : alertMarginForConfidence(Number(candidate?.confidence) || 0, baseMargin);
  const estimatedTier = ['MAP_ESTIMATED', 'LEARNED_LOCAL', 'REGION_DEFAULT'].includes(tierName);
  const estimateGuidanceAllowed = settings.speed_estimates_enabled !== false || tierName === 'POSTED';
  const finiteSetting = (value, fallback) => {
    if (value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const voiceMarginKmh = (tierName === 'GPS_INFERRED' || estimatedTier)
    ? finiteSetting(settings.estimated_voice_margin_kmh, 12)
    : visualMarginKmh;
  const voiceAllowed =
    settings.voice_alerts_enabled !== false &&
    estimateGuidanceAllowed &&
    (tierName === 'POSTED'
      ? settings.speak_posted_speed_warnings !== false
      : estimatedTier
        ? settings.speak_estimated_speed_checks === true
        : tierName === 'GPS_INFERRED' && settings.speak_estimated_speed_checks === true);
  const visualAllowed =
    settings.speed_warning_enabled !== false &&
    tierName !== 'UNKNOWN' &&
    estimateGuidanceAllowed;

  return {
    marginKmh: visualMarginKmh,
    visualMarginKmh,
    voiceMarginKmh,
    visualAllowed,
    voiceAllowed,
    messageMode: tierName === 'POSTED' ? 'posted_limit_warning' : tierName === 'UNKNOWN' ? 'none' : 'speed_check',
    cooldownMs: VOICE_COOLDOWNS_BY_TIER[tierName] ?? 60000,
  };
}

/**
 * @param {{speedKmh?: number, candidate?: {limitKmh?: number, tier?: string, confidence?: number}, settings?: Record<string, any>}} params
 */
export function shouldWarnForSpeed({ speedKmh, candidate, settings = {} } = {}) {
  const speed = Number(speedKmh);
  const limit = Number(candidate?.limitKmh);
  if (!Number.isFinite(speed)) return null;
  if (!Number.isFinite(limit)) return null;

  const policy = alertPolicyForLimit(candidate, settings);
  const overBy = speed - limit;
  const visual = policy.visualAllowed && overBy > policy.visualMarginKmh;
  const voice = policy.voiceAllowed && overBy > policy.voiceMarginKmh;
  if (!visual && !voice) return null;

  return {
    overBy,
    visual,
    voice,
    messageMode: policy.messageMode,
    cooldownMs: policy.cooldownMs,
    visualMarginKmh: policy.visualMarginKmh,
    voiceMarginKmh: policy.voiceMarginKmh,
  };
}

const round = (value, places = 4) => Number(value).toFixed(places);

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (value) => value * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const normalizeRoutePointCoordinates = (point) => {
  const lat = finiteNumber(point?.lat);
  const lng = finiteNumber(point?.lng);
  return lat == null || lng == null ? null : { ...point, lat, lng };
};

export function parseMaxspeedKmh(value) {
  if (value == null) return null;
  const raw = String(value).toLowerCase().trim();
  if (!raw || ['none', 'signals', 'walk', 'variable'].includes(raw)) return null;
  const mph = raw.includes('mph');
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(mph ? parsed * 1.60934 : parsed);
}

export async function clearOsmSpeedLimitCache() {
  await removeEncryptedJson(SPEED_LIMIT_CACHE_KEY);
}

function isInsidePrivacyGuard(point, zones = []) {
  return Boolean(isPointInPrivacyZone(point, zones, ZONE_GUARD_M));
}

function finiteRoutePoints(points = []) {
  return (Array.isArray(points) ? points : [])
    .map(normalizeRoutePointCoordinates)
    .filter(Boolean);
}

function isPublicRoadDataPoint(point, privacyZones = []) {
  const normalized = normalizeRoutePointCoordinates(point);
  return Boolean(normalized) &&
    point?.masked_for_privacy !== true &&
    point?.privacy_boundary !== true &&
    point?.privacy_gap !== true &&
    !isInsidePrivacyGuard(normalized, privacyZones);
}

function privacySafeRoutePoints(points = [], privacyZones = []) {
  const valid = finiteRoutePoints(points);
  return privacyZones.length
    ? valid.filter((point) => isPublicRoadDataPoint(point, privacyZones))
    : valid;
}

function privacySafeRouteSegments(points = [], privacyZones = []) {
  if (!privacyZones.length) return [finiteRoutePoints(points)];
  const segments = [];
  let current = [];
  for (const point of Array.isArray(points) ? points : []) {
    const normalized = normalizeRoutePointCoordinates(point);
    if (normalized && isPublicRoadDataPoint(point, privacyZones)) {
      current.push(normalized);
      continue;
    }
    if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function hasFiniteBounds(bounds) {
  return Number.isFinite(bounds?.south) &&
    Number.isFinite(bounds?.west) &&
    Number.isFinite(bounds?.north) &&
    Number.isFinite(bounds?.east);
}

function routeBounds(points = [], pad = 0.01) {
  const valid = finiteRoutePoints(points);
  if (!valid.length) return null;
  const lats = valid.map((point) => point.lat);
  const lngs = valid.map((point) => point.lng);
  const bounds = {
    south: Math.min(...lats) - pad,
    west: Math.min(...lngs) - pad,
    north: Math.max(...lats) + pad,
    east: Math.max(...lngs) + pad,
  };
  return hasFiniteBounds(bounds) ? bounds : null;
}

function skippedReasonForMissingBounds(routePoints = [], privacyZones = [], safePoints = [], queryBounds = null) {
  const inputPoints = Array.isArray(routePoints) ? routePoints : [];
  if (privacyZones.length && inputPoints.length && !safePoints.length) return ALL_POINTS_PRIVATE_REASON;
  if (privacyZones.length && inputPoints.length && safePoints.length && Array.isArray(queryBounds) && !queryBounds.length) {
    return PRIVACY_BOUNDS_OVERLAP_REASON;
  }
  return null;
}

function cacheKeyForBounds(bounds) {
  return [
    round(bounds.south, 2),
    round(bounds.west, 2),
    round(bounds.north, 2),
    round(bounds.east, 2),
  ].join(',');
}

export function speedLimitDefaultCountryKey(settings = {}) {
  const candidates = typeof settings === 'string'
    ? [settings]
    : [
      settings?.country_code,
      settings?.configurable_country_defaults,
      settings?.speed_limit_default_country,
      DEFAULT_SPEED_LIMIT_COUNTRY,
    ];
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const value = String(raw).toLowerCase().trim();
    if (Object.prototype.hasOwnProperty.call(OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH, value)) return value;
  }
  return DEFAULT_SPEED_LIMIT_COUNTRY;
}

export function speedLimitDefaultsForCountry(settings = {}) {
  const country = speedLimitDefaultCountryKey(settings);
  return {
    ...OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH.global,
    ...(OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH[country] || {}),
  };
}

function bboxSpan(bounds) {
  return {
    lat: bounds ? bounds.north - bounds.south : 0,
    lng: bounds ? bounds.east - bounds.west : 0,
  };
}

function uniqueBy(items = [], keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sampleRoutePoints(points = [], maxPoints = MAX_CORRIDOR_SAMPLE_POINTS) {
  const valid = finiteRoutePoints(points);
  if (valid.length <= maxPoints) return valid;
  const step = (valid.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => valid[Math.round(index * step)]);
}

function corridorBounds(routePoints = []) {
  const sampled = sampleRoutePoints(routePoints);
  if (!sampled.length) return [];
  const chunkSize = Math.max(8, Math.ceil(sampled.length / MAX_CORRIDOR_QUERIES));
  const chunks = [];
  for (let start = 0; start < sampled.length; start += chunkSize) {
    const end = Math.min(sampled.length, start + chunkSize + 1);
    const bounds = routeBounds(sampled.slice(start, end), CORRIDOR_PAD_DEG);
    if (bounds) chunks.push(bounds);
  }
  return uniqueBy(chunks, cacheKeyForBounds);
}

function collectPrivacySafeSegmentBounds(points = [], privacyZones = [], output = []) {
  if (output.length >= MAX_PRIVACY_CORRIDOR_QUERIES) return { bounds: output, filtered: false };
  const valid = finiteRoutePoints(points);
  const bounds = routeBounds(valid, CORRIDOR_PAD_DEG);
  if (!bounds) return { bounds: output, filtered: false };
  if (!boundsOverlapPrivacyZone(bounds, privacyZones, ZONE_GUARD_M)) {
    output.push(bounds);
    return { bounds: output, filtered: false };
  }

  if (valid.length <= 1) return { bounds: output, filtered: true };

  const splitAt = Math.floor(valid.length / 2);
  const left = valid.length === 2 ? [valid[0]] : valid.slice(0, splitAt + 1);
  const right = valid.length === 2 ? [valid[1]] : valid.slice(splitAt);
  collectPrivacySafeSegmentBounds(left, privacyZones, output);
  collectPrivacySafeSegmentBounds(right, privacyZones, output);
  return {
    bounds: output,
    filtered: true,
  };
}

function privacySafeQueryBounds(routePoints = [], privacyZones = []) {
  const segments = privacySafeRouteSegments(routePoints, privacyZones);
  const plan = segments.reduce((acc, segment) => {
    const result = collectPrivacySafeSegmentBounds(segment, privacyZones, acc.bounds);
    acc.filtered = acc.filtered || result.filtered;
    return acc;
  }, { bounds: [], filtered: false });
  return {
    bounds: uniqueBy(plan.bounds, cacheKeyForBounds),
    privacyFiltered: plan.filtered,
  };
}

const overpassBboxCoordinate = (value) => Number(value).toFixed(6);

function overpassQuery(bounds) {
  const bbox = [
    overpassBboxCoordinate(bounds.south),
    overpassBboxCoordinate(bounds.west),
    overpassBboxCoordinate(bounds.north),
    overpassBboxCoordinate(bounds.east),
  ].join(',');
  return `
    [out:json][timeout:25];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bbox});
    );
    out tags geom;
  `;
}

function overpassUrls(settings = {}) {
  return uniqueBy([
    normalizeHttpsEndpoint(settings.overpass_speed_limit_url),
    OVERPASS_URL,
    ...FALLBACK_OVERPASS_URLS,
  ].filter(Boolean), (url) => url);
}

function overpassNativeRequest(bounds, settings = {}) {
  const url = overpassUrls(settings)[0];
  const body = new URLSearchParams({ data: overpassQuery(bounds) }).toString();
  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  };
}

async function fetchOverpassWays(bounds, settings = {}) {
  const urls = overpassUrls(settings);
  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchOverpassWaysFromUrl(bounds, url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Overpass request failed');
}

async function fetchOverpassWaysFromUrl(bounds, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const queryString = overpassQuery(bounds);
  const body = new URLSearchParams({ data: queryString });
  try {
    const response = await withRetry(`overpass-speed-limit:${url}`, () => privacyGatedFetch('overpass', {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: controller.signal,
    }, {
      type: 'Speed limit query',
      coordinateDisclosure: 'bounding_box',
      privacyVerificationEvidence: [
        'request body contains only the computed bounding box',
        'query does not request individual node coordinates',
      ],
      sentCoords: 'Bounding box',
      protections: ['privacy-zone excluded bbox', 'zone guard +50m'],
      status: 'safe',
    }));
    if (!response.ok) throw new Error(`Overpass request failed (${response.status})`);
    const data = await response.json();
    return Array.isArray(data?.elements) ? data.elements : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCachedWaysForBounds(bounds, settings, cache, nextCache) {
  const defaultCountry = speedLimitDefaultCountryKey(settings);
  const key = `${cacheKeyForBounds(bounds)}:${defaultCountry}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
    return { ways: cached.ways || [], status: 'cache_hit', error: null };
  }
  try {
    const ways = normalizeWays(
      await enqueueLocationRequest(
        'overpass',
        () => fetchOverpassWays(bounds, settings),
        overpassNativeRequest(bounds, settings),
        // A manual Get Road Data tap passes request_obfuscation_enabled: false
        // so it runs now instead of waiting for the next batch.
        { settings }
      ),
      settings
    );
    nextCache[key] = { savedAt: Date.now(), ways };
    return { ways, status: ways.length ? 'fetched' : 'no_tagged_ways', error: null };
  } catch (error) {
    return {
      ways: [],
      status: 'unavailable',
      error: error?.name === 'AbortError' ? 'OpenStreetMap speed-limit lookup timed out.' : error?.message,
    };
  }
}

export function defaultSpeedLimitKmhForOsmHighway(highway, settings = {}, countryCode = null) {
  const value = String(highway || '').toLowerCase().trim();
  if (!value) return null;
  const profileSettings = countryCode ? { ...settings, country_code: countryCode } : settings;
  return speedLimitDefaultsForCountry(profileSettings)[value] ?? null;
}

function overpassElementsFromResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.elements)) return result.elements;
  return [];
}

function normalizeWays(result = [], settings = {}) {
  const elements = overpassElementsFromResult(result);
  const defaultCountry = speedLimitDefaultCountryKey(settings);
  return elements
    .map((element) => {
      const taggedLimitKmh = parseMaxspeedKmh(
        element.tags?.maxspeed ?? element.tags?.['maxspeed:forward'] ?? element.tags?.['maxspeed:backward']
      );
      const highway = element.tags?.highway || null;
      const defaultLimitKmh = taggedLimitKmh ? null : defaultSpeedLimitKmhForOsmHighway(highway, settings);
      const limitKmh = taggedLimitKmh ?? defaultLimitKmh;
      const geometry = Array.isArray(element.geometry)
        ? element.geometry
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
          .slice(0, MAX_GEOMETRY_POINTS)
          .map((point) => ({ lat: point.lat, lng: point.lon }))
        : [];
      if (!limitKmh || geometry.length < 2) return null;
      return {
        id: element.id,
        limitKmh,
        limitSource: taggedLimitKmh ? 'openstreetmap' : 'osm_highway_default',
        limitDefaultCountry: taggedLimitKmh ? null : defaultCountry,
        highway,
        name: element.tags?.name || element.tags?.ref || null,
        geometry,
      };
    })
    .filter(Boolean);
}

function pointToSegmentDistanceM(point, start, end) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((Number(point.lat) || 0) * Math.PI / 180);
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return haversineDistance(point.lat, point.lng, start.lat, start.lng) * 1000;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const nearestX = ax + t * dx;
  const nearestY = ay + t * dy;
  return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
}

function nearestWayLimit(point, ways = [], maxDistanceM = 75) {
  let best = null;
  for (const way of ways) {
    for (let i = 1; i < way.geometry.length; i++) {
      const prev = way.geometry[i - 1];
      const curr = way.geometry[i];
      const distanceM = pointToSegmentDistanceM(point, prev, curr);
      if (distanceM <= maxDistanceM && (!best || distanceM < best.distanceM)) {
        best = { ...way, distanceM };
      }
    }
  }
  return best;
}

export async function loadOsmSpeedLimitWays(routePoints = [], settings = {}) {
  if (isHeightenedPrivacyMode(settings)) {
    return { ways: [], status: 'disabled_heightened_privacy', source: 'openstreetmap_overpass' };
  }
  if (settings.speed_limit_lookup_enabled === false) {
    return { ways: [], status: 'disabled', source: 'openstreetmap_overpass' };
  }
  const privacyZones = getPrivacyZones(settings);
  const safeRoutePoints = privacySafeRoutePoints(routePoints, privacyZones);
  const bounds = routeBounds(safeRoutePoints);
  if (!bounds) {
    if (privacyZones.length && routePoints.length) {
      await privacyGatedFetch('overpass', { url: overpassUrls(settings)[0] }, {
        type: 'Speed limit query',
        coordinateDisclosure: 'blocked',
        block: {
          privacyVerificationEvidence: ['privacy filtering left no public road-data points'],
          protections: ['all route points inside privacy guard - request blocked'],
        },
      });
    }
    return {
      ways: [],
      status: 'empty_route',
      source: 'openstreetmap_overpass',
      skipped_reason: skippedReasonForMissingBounds(routePoints, privacyZones, safeRoutePoints),
    };
  }
  if ((bounds.north - bounds.south) > MAX_BBOX_SPAN_DEG || (bounds.east - bounds.west) > MAX_BBOX_SPAN_DEG) {
    return { ways: [], status: 'bbox_too_large', source: 'openstreetmap_overpass' };
  }

  const cache = await getEncryptedJson(SPEED_LIMIT_CACHE_KEY, {});
  const nextCache = { ...cache };
  const span = bboxSpan(bounds);
  const queryPlan = privacyZones.length
    ? privacySafeQueryBounds(routePoints, privacyZones)
    : {
      bounds: span.lat <= DIRECT_BBOX_SPAN_DEG && span.lng <= DIRECT_BBOX_SPAN_DEG
        ? [bounds]
        : corridorBounds(safeRoutePoints),
      privacyFiltered: false,
    };
  const queryBounds = queryPlan.bounds;

  if (!queryBounds.length) {
    if (privacyZones.length && routePoints.length) {
      await privacyGatedFetch('overpass', { url: overpassUrls(settings)[0] }, {
        type: 'Speed limit query',
        coordinateDisclosure: 'blocked',
        block: {
          privacyVerificationEvidence: ['computed road-data bounding boxes overlapped a privacy-zone guard'],
          protections: ['road-data bounding box would overlap privacy guard - request blocked'],
        },
      });
    }
    return {
      ways: [],
      status: 'empty_route',
      source: 'openstreetmap_overpass',
      skipped_reason: skippedReasonForMissingBounds(routePoints, privacyZones, safeRoutePoints, queryBounds),
    };
  }

  const results = await Promise.all(queryBounds.map((item) => loadCachedWaysForBounds(item, settings, cache, nextCache)));
  await setEncryptedJson(SPEED_LIMIT_CACHE_KEY, nextCache);

  const ways = uniqueBy(results.flatMap((result) => result.ways), (way) => `${way.id}:${way.limitKmh}`);
  const failures = results.filter((result) => result.status === 'unavailable');
  const cacheHits = results.filter((result) => result.status === 'cache_hit');
  const fetched = results.filter((result) => result.status === 'fetched');
  const noTags = results.filter((result) => result.status === 'no_tagged_ways');
  const error = failures.map((result) => result.error).find(Boolean) || null;

  if (ways.length) {
    return {
      ways,
      status: failures.length || queryPlan.privacyFiltered ? 'partial_fetched' : cacheHits.length && !fetched.length ? 'cache_hit' : 'fetched',
      source: 'openstreetmap_overpass',
      query_count: queryBounds.length,
      error,
    };
  }
  if (failures.length === results.length) {
    return { ways: [], status: 'unavailable', source: 'openstreetmap_overpass', query_count: queryBounds.length, error };
  }
  return {
    ways: [],
    status: noTags.length || cacheHits.length ? 'no_tagged_ways' : 'unavailable',
    source: 'openstreetmap_overpass',
    query_count: queryBounds.length,
    error,
  };
}

export async function annotateRouteSpeedLimits(routePoints = [], settings = {}) {
  try {
    const fallbackCountry = speedLimitDefaultCountryKey(settings);
    const result = await loadOsmSpeedLimitWays(routePoints, settings);
    if (!result.ways.length) {
      return {
        routePoints,
        coverage: 0,
        status: result.status,
        source: result.source,
        fallback_country: fallbackCountry,
        query_count: result.query_count,
        error: result.error,
        skipped_reason: result.skipped_reason,
      };
    }

    let matched = 0;
    const annotated = routePoints.map((point) => {
      const normalized = normalizeRoutePointCoordinates(point);
      if (!normalized) return point;
      const match = nearestWayLimit(normalized, result.ways);
      if (!match) return point;
      matched++;
      return {
        ...point,
        speed_limit_kmh: match.limitKmh,
        speed_limit_source: match.limitSource,
        speed_limit_default_country: match.limitDefaultCountry,
        fallback_country: match.limitDefaultCountry,
        speed_limit_way_id: match.id,
        speed_limit_road_name: match.name,
        speed_limit_highway: match.highway,
      };
    });

    return {
      routePoints: annotated,
      coverage: routePoints.length ? Math.round((matched / routePoints.length) * 100) : 0,
      status: result.status,
      source: result.source,
      fallback_country: fallbackCountry,
      query_count: result.query_count,
      error: result.error,
    };
  } catch (error) {
    return {
      routePoints,
      coverage: 0,
      status: 'unavailable',
      source: 'openstreetmap_overpass',
      fallback_country: speedLimitDefaultCountryKey(settings),
      error: error?.message || 'Speed limit lookup unavailable',
    };
  }
}
