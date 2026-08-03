import {
  boundsOverlapPrivacyZone,
  getPrivacyZones,
  isInsidePrivacyZone,
  routeTouchesPrivacyZone,
} from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import {
  MAX_SAVED_SPEED_LIMIT_KMH,
  speedKnowledgeCellEligibility,
} from '@/lib/speedKnowledgeCellPolicy';
import {
  SPEED_KNOWLEDGE_SCHEMA_VERSION,
  SPEED_KNOWLEDGE_STORAGE_KEY,
} from '@/lib/speedKnowledgeRepository';
import {
  buildRoadMemoryObservations,
  consolidateRoadMemoryCandidates,
  findRoadMemoryCandidateMatch,
  mergeRoadMemoryObservation,
  roadMemoryCandidateOperationalState,
  roadMemoryConfidenceExplanation,
  roadMemoryEffectiveLimit,
  roadMemoryTripSignature,
} from '@/lib/localRoadMemory';
import {
  decorateRoadMemoryCandidates,
  roadMemoryContextKey,
} from '@/lib/roadMemoryIntelligence';

// CHANGES (session):
// - Added LocalSpeedKnowledge with geohash-backed local speed cache, user corrections, pruning, and privacy-zone guards.
// - Added geohashEncode and geohashNeighboursInclude helpers for cache lookup and tests.
// - Updated getForPoint so user corrections take priority over learned cells.
// - Added time-of-day bucket learning and bucket-aware speed lookup.
// - Added conflict detection, conflicted-cell listing, and user-confirmed conflict resolution.
// - Split user corrections into confirmed posted signs and user-entered estimates.
// - Restricted learned-cache writes to OSM maxspeed and user-confirmed posted sign sources.

export const STORAGE_KEY = SPEED_KNOWLEDGE_STORAGE_KEY;
export const SPEED_KNOWLEDGE_CHANGED_EVENT = 'speed-knowledge-changed';
export const CELL_PRECISION = 6;
export const FALLBACK_PRECISION = 5;
const CACHEABLE_SOURCES = new Set(['openstreetmap', 'user_confirmed_posted_sign']);
const NULL_ISLAND_EPSILON = 0.001;
const ROAD_SECTION_MATCH_RADIUS_KM = 0.045;
const LEGACY_CELL_MATCH_RADIUS_KM = 0.35;
const DIRECTION_MATCH_TOLERANCE_DEG = 60;
const HISTORY_LIMIT = 20;
const ROAD_MEMORY_MAX_PROCESSED_TRIPS = 1500;
const ROAD_MEMORY_MAX_CANDIDATES = 2500;
const ROAD_MEMORY_STALE_MS = 120 * 86400000;
const ROAD_MEMORY_CHRONOLOGY_VERSION = 1;
const fallbackMutationTails = new WeakMap();

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(lat, lng, precision = CELL_PRECISION) {
  let latitude = [-90, 90];
  let longitude = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    const range = even ? longitude : latitude;
    const value = even ? Number(lng) : Number(lat);
    const mid = (range[0] + range[1]) / 2;
    if (value >= mid) {
      ch |= 1 << (4 - bit);
      range[0] = mid;
    } else {
      range[1] = mid;
    }
    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

export function geohashBounds(hash) {
  let latitude = [-90, 90];
  let longitude = [-180, 180];
  let even = true;

  for (const char of String(hash || '')) {
    const value = BASE32.indexOf(char);
    if (value < 0) continue;
    for (const mask of [16, 8, 4, 2, 1]) {
      const range = even ? longitude : latitude;
      const mid = (range[0] + range[1]) / 2;
      if (value & mask) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }

  return {
    south: latitude[0],
    west: longitude[0],
    north: latitude[1],
    east: longitude[1],
    lat: (latitude[0] + latitude[1]) / 2,
    lng: (longitude[0] + longitude[1]) / 2,
  };
}

function geohashDecode(hash) {
  const bounds = geohashBounds(hash);
  return { lat: bounds.lat, lng: bounds.lng };
}

export function geohashCenter(hash) {
  return geohashDecode(hash);
}

const geohashOverlapsPrivacyZones = (geohash, privacyZones = []) => (
  Array.isArray(privacyZones) && privacyZones.length > 0 &&
  boundsOverlapPrivacyZone(geohashBounds(geohash), privacyZones)
);

const geometryTouchesPrivacyZones = (points = [], privacyZones = []) => (
  Array.isArray(privacyZones) && privacyZones.some((zone) => (
    routeTouchesPrivacyZone(points, zone)
  ))
);

function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToSegmentDistanceKm(lat, lng, start, end) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  const startLat = Number(start?.lat);
  const startLng = Number(start?.lng);
  const endLat = Number(end?.lat);
  const endLng = Number(end?.lng);
  if (![latitude, longitude, startLat, startLng, endLat, endLng].every(Number.isFinite)) return Infinity;

  const meanLat = (latitude + startLat + endLat) / 3 * Math.PI / 180;
  const kmPerLatDegree = 111.32;
  const kmPerLngDegree = Math.max(1, 111.32 * Math.cos(meanLat));
  const px = (longitude - startLng) * kmPerLngDegree;
  const py = (latitude - startLat) * kmPerLatDegree;
  const vx = (endLng - startLng) * kmPerLngDegree;
  const vy = (endLat - startLat) * kmPerLatDegree;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared <= 0) return Math.hypot(px, py);
  const projection = Math.max(0, Math.min(1, (px * vx + py * vy) / lengthSquared));
  return Math.hypot(px - projection * vx, py - projection * vy);
}

function bearingDeg(start, end) {
  const startLat = Number(start?.lat) * Math.PI / 180;
  const endLat = Number(end?.lat) * Math.PI / 180;
  const deltaLng = (Number(end?.lng) - Number(start?.lng)) * Math.PI / 180;
  if (![startLat, endLat, deltaLng].every(Number.isFinite)) return null;
  const y = Math.sin(deltaLng) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) -
    Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLng);
  const bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

function angleDiffDeg(a, b) {
  if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return Infinity;
  return Math.abs((((Number(a) - Number(b)) + 540) % 360) - 180);
}

function directionMode(value) {
  return ['forward', 'reverse'].includes(value) ? value : 'both';
}

const VALID_DIRECTION_MODES = new Set(['both', 'forward', 'reverse']);
const VALID_QUALIFIER_STATUSES = new Set([
  'regulatory_text_no_qualifiers',
  'conditional_school_when_flashing',
  'conditional_school',
  'conditional_temporary_work_zone',
  'conditional_daytime',
  'conditional_night',
]);

function validExplicitDirectionMode(value) {
  return typeof value === 'string' && VALID_DIRECTION_MODES.has(value);
}

function correctionHasValidDirectionMode(correction = {}) {
  return !Object.prototype.hasOwnProperty.call(correction, 'directionMode') ||
    validExplicitDirectionMode(correction.directionMode);
}

function validExplicitQualifierStatus(value) {
  return typeof value === 'string' && VALID_QUALIFIER_STATUSES.has(value);
}

function correctionHasValidQualifierSemantics(correction = {}) {
  if (!Object.prototype.hasOwnProperty.call(correction, 'qualifierStatus') ||
      correction.qualifierStatus == null) return true;
  if (!validExplicitQualifierStatus(correction.qualifierStatus)) return false;
  if (correction.qualifierStatus === 'regulatory_text_no_qualifiers') return true;
  if (correction.qualifierStatus === 'conditional_temporary_work_zone') {
    return instantMs(correction.expiresAt) != null;
  }
  return validTimeRule(correction.timeRule) && correction.timeRule?.enabled === true;
}

function createCorrectionId() {
  return `speed-rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sectionBearing(points = []) {
  const clean = points.filter((point) => isUsableCoordinate(Number(point?.lat), Number(point?.lng)));
  if (clean.length < 2) return null;
  return bearingDeg(clean[0], clean[clean.length - 1]);
}

function correctionBearing(correction = {}) {
  const stored = Number(correction.directionBearing);
  if (Number.isFinite(stored)) return ((stored % 360) + 360) % 360;
  return sectionBearing(Array.isArray(correction.sectionPoints) ? correction.sectionPoints : []);
}

function correctionMatchesDirection(correction = {}, headingDeg = null) {
  const mode = directionMode(correction.directionMode);
  if (mode === 'both') return true;
  const heading = Number(headingDeg);
  if (!Number.isFinite(heading)) return false;
  const bearing = correctionBearing(correction);
  if (!Number.isFinite(bearing)) return false;
  const expected = mode === 'reverse' ? (bearing + 180) % 360 : bearing;
  return angleDiffDeg(heading, expected) <= DIRECTION_MATCH_TOLERANCE_DEG;
}

function correctionHeadingDelta(correction = {}, headingDeg = null) {
  const heading = Number(headingDeg);
  if (!Number.isFinite(heading)) return Infinity;
  const bearing = correctionBearing(correction);
  if (!Number.isFinite(bearing)) return Infinity;
  const forwardDelta = angleDiffDeg(heading, bearing);
  const reverseDelta = angleDiffDeg(heading, (bearing + 180) % 360);
  const mode = directionMode(correction.directionMode);
  if (mode === 'forward') return forwardDelta;
  if (mode === 'reverse') return reverseDelta;
  return Math.min(forwardDelta, reverseDelta);
}

function parseTimeMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function cleanDays(days) {
  return [...new Set((Array.isArray(days) ? days : [])
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b);
}

function normalizeTimeRule(rule = null) {
  if (!rule || rule.enabled !== true) return { enabled: false, days: [], startMinutes: null, endMinutes: null };
  const startMinutes = Number.isFinite(Number(rule.startMinutes))
    ? Number(rule.startMinutes)
    : parseTimeMinutes(rule.startTime);
  const endMinutes = Number.isFinite(Number(rule.endMinutes))
    ? Number(rule.endMinutes)
    : parseTimeMinutes(rule.endTime);
  const days = cleanDays(rule.days);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || days.length === 0) {
    return { enabled: false, days: [], startMinutes: null, endMinutes: null };
  }
  return {
    enabled: true,
    days,
    startMinutes: Math.max(0, Math.min(1439, Math.round(startMinutes))),
    endMinutes: Math.max(0, Math.min(1439, Math.round(endMinutes))),
    label: String(rule.label || '').trim(),
  };
}

function correctionSpecificity(correction = {}) {
  return (directionMode(correction.directionMode) === 'both' ? 0 : 2) +
    (normalizeTimeRule(correction.timeRule).enabled ? 1 : 0);
}

function validTimeRuleDays(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) return false;
  const seen = new Set();
  for (const rawDay of days) {
    if (typeof rawDay !== 'number' || !Number.isInteger(rawDay) || rawDay < 0 || rawDay > 6 || seen.has(rawDay)) {
      return false;
    }
    seen.add(rawDay);
  }
  return true;
}

function validTimeRule(rule = null, { allowClockStrings = false } = {}) {
  if (rule == null) return true;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.enabled !== 'boolean') {
    return false;
  }
  if (!rule.enabled) return true;
  const rawStart = allowClockStrings && rule.startMinutes == null
    ? parseTimeMinutes(rule.startTime)
    : rule.startMinutes;
  const rawEnd = allowClockStrings && rule.endMinutes == null
    ? parseTimeMinutes(rule.endTime)
    : rule.endMinutes;
  return typeof rawStart === 'number' && Number.isInteger(rawStart) && rawStart >= 0 && rawStart <= 1439 &&
    typeof rawEnd === 'number' && Number.isInteger(rawEnd) && rawEnd >= 0 && rawEnd <= 1439 &&
    validTimeRuleDays(rule.days);
}

function correctionAuthority(correction = {}) {
  const source = correctionSource(correction);
  if (source === 'user_confirmed_posted_sign' || source === 'camera_sign_confirmed') return 3;
  if (source === 'openstreetmap') return 2;
  return 1;
}

function compareOptionalNumber(a, b) {
  const left = Number.isFinite(Number(a)) ? Number(a) : Number.MAX_SAFE_INTEGER;
  const right = Number.isFinite(Number(b)) ? Number(b) : Number.MAX_SAFE_INTEGER;
  return left - right;
}

function geometryIdentity(points = []) {
  const clean = (Array.isArray(points) ? points : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => isUsableCoordinate(point.lat, point.lng));
  if (clean.length < 2) return null;
  const sampleIndexes = [...new Set([
    0,
    Math.floor(clean.length / 2),
    clean.length - 1,
  ])];
  return sampleIndexes
    .map((index) => `${clean[index].lat.toFixed(5)},${clean[index].lng.toFixed(5)}`)
    .join('|');
}

function correctionIdentity(correction = {}) {
  const mode = directionMode(correction.directionMode);
  const bearing = correctionBearing(correction);
  const timeRule = normalizeTimeRule(correction.timeRule);
  const geometry = geometryIdentity(correction.sectionPoints);
  return JSON.stringify({
    geohash: correction.geohash || '',
    geometry,
    mode,
    validFrom: normalizedInstant(correction.validFrom ?? correction.valid_from) || null,
    expiresAt: normalizedInstant(correction.expiresAt) || null,
    bearing: mode === 'both' || !Number.isFinite(bearing) ? null : Math.round(bearing / 15) * 15 % 360,
    timeRule: timeRule.enabled
      ? {
        days: timeRule.days,
        startMinutes: timeRule.startMinutes,
        endMinutes: timeRule.endMinutes,
      }
      : null,
  });
}

function correctionRepairRank(correction = {}) {
  const sourceScore = correctionSource(correction) === 'user_confirmed_posted_sign' ? 1000 : 0;
  const evidenceScore = Number(correction.evidenceCount) || 0;
  const updatedAt = new Date(correction.appliedAt || correction.verifiedAt || 0).getTime();
  return sourceScore + evidenceScore + (Number.isFinite(updatedAt) ? updatedAt / 10000000000000 : 0);
}

function correctionMatchesSelector(correction = {}, selector = '') {
  return Boolean(selector) && (
    correction.id === selector ||
    correction.ruleId === selector ||
    correction.sectionKey === selector ||
    correction.correctionId === selector ||
    correction.geohash === selector
  );
}

function instantMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedInstant(value) {
  if (value == null || value === '') return null;
  const parsed = instantMs(value);
  return parsed == null ? undefined : new Date(parsed).toISOString();
}

function normalizedDateOnly(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function calendarDateForInstant(value, utcOffsetMinutes = null) {
  const parsed = instantMs(value);
  if (parsed == null) return null;
  const offset = Number(utcOffsetMinutes);
  if (
    utcOffsetMinutes !== null &&
    utcOffsetMinutes !== undefined &&
    utcOffsetMinutes !== '' &&
    Number.isFinite(offset) &&
    Math.abs(offset) <= 24 * 60
  ) {
    return new Date(parsed + offset * 60000).toISOString().slice(0, 10);
  }
  const date = new Date(parsed);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function localClockParts(timestampMs, utcOffsetMinutes = null) {
  const hasRecordedOffset = utcOffsetMinutes !== null &&
    utcOffsetMinutes !== undefined &&
    utcOffsetMinutes !== '';
  const offset = Number(utcOffsetMinutes);
  if (hasRecordedOffset && Number.isFinite(offset) && Math.abs(offset) <= 24 * 60) {
    const shifted = new Date(timestampMs + offset * 60000);
    return {
      day: shifted.getUTCDay(),
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }
  const local = new Date(timestampMs);
  return {
    day: local.getDay(),
    minutes: local.getHours() * 60 + local.getMinutes(),
  };
}

function correctionTemporalState(correction = {}, timestampMs = null, options = {}) {
  const evaluatedAtMs = instantMs(timestampMs) ?? Date.now();
  const rawValidFrom = correction.validFrom ?? correction.valid_from;
  const validFromMs = instantMs(rawValidFrom);
  const expiresAtMs = instantMs(correction.expiresAt);
  if (rawValidFrom != null && rawValidFrom !== '' && validFromMs == null) {
    return { active: false, reason: 'invalid_valid_from', evaluatedAtMs };
  }
  if (correction.expiresAt != null && correction.expiresAt !== '' && expiresAtMs == null) {
    return { active: false, reason: 'invalid_expiry', evaluatedAtMs };
  }
  if (validFromMs != null && evaluatedAtMs < validFromMs) {
    return { active: false, reason: 'not_yet_effective', evaluatedAtMs, validFromMs, expiresAtMs };
  }
  if (expiresAtMs != null && evaluatedAtMs >= expiresAtMs) {
    return { active: false, reason: 'expired_rule', evaluatedAtMs, validFromMs, expiresAtMs };
  }
  if (options.ignoreSchedule === true) {
    return { active: true, reason: 'active', evaluatedAtMs, validFromMs, expiresAtMs };
  }

  if (!validTimeRule(correction.timeRule)) {
    return { active: false, reason: 'invalid_time_rule', evaluatedAtMs, validFromMs, expiresAtMs };
  }
  const rule = normalizeTimeRule(correction.timeRule);
  if (!rule.enabled) {
    return { active: true, reason: 'active', evaluatedAtMs, validFromMs, expiresAtMs };
  }
  const { day, minutes } = localClockParts(evaluatedAtMs, options.utcOffsetMinutes);
  let active;
  if (rule.startMinutes === rule.endMinutes) {
    active = rule.days.includes(day);
  } else if (rule.startMinutes < rule.endMinutes) {
    active = rule.days.includes(day) &&
      minutes >= rule.startMinutes && minutes <= rule.endMinutes;
  } else if (minutes >= rule.startMinutes) {
    active = rule.days.includes(day);
  } else if (minutes <= rule.endMinutes) {
    // The after-midnight part belongs to the previous configured day. This
    // keeps a Friday 22:00-06:00 rule active at 02:00 Saturday.
    active = rule.days.includes((day + 6) % 7);
  } else {
    active = false;
  }
  return {
    active,
    reason: active ? 'active' : 'time_rule_inactive',
    evaluatedAtMs,
    validFromMs,
    expiresAtMs,
  };
}

export function correctionMatchesPoint(correction, lat, lng, radiusKm = ROAD_SECTION_MATCH_RADIUS_KM, options = {}) {
  if (!correctionHasValidDirectionMode(correction)) return false;
  if (!correctionHasValidQualifierSemantics(correction)) return false;
  if (!correctionTemporalState(correction, options.timestampMs ?? null, options).active) return false;
  if (!correctionMatchesDirection(correction, options.headingDeg ?? null)) return false;
  const points = Array.isArray(correction?.sectionPoints)
    ? correction.sectionPoints.filter((point) => isUsableCoordinate(Number(point?.lat), Number(point?.lng)))
    : [];
  if (points.length >= 2) {
    for (let index = 1; index < points.length; index++) {
      if (pointToSegmentDistanceKm(lat, lng, points[index - 1], points[index]) <= radiusKm) return true;
    }
    return false;
  }
  // A geohash identifies an area, not a road. Legacy point-only corrections
  // stay visible for review/retracing but cannot drive scores or alerts where
  // they could otherwise leak across parallel or stacked roads.
  return options.allowLegacyCellMatch === true &&
    geohashNeighboursInclude(correction?.geohash, lat, lng, LEGACY_CELL_MATCH_RADIUS_KM);
}

function correctionMatchDetails(correction, lat, lng, radiusKm = ROAD_SECTION_MATCH_RADIUS_KM, options = {}) {
  if (!correctionHasValidDirectionMode(correction)) {
    return { matched: false, reason: 'invalid_direction_mode' };
  }
  if (!correctionHasValidQualifierSemantics(correction)) {
    return { matched: false, reason: 'invalid_qualifier_semantics' };
  }
  const temporal = correctionTemporalState(correction, options.timestampMs ?? null, options);
  if (!temporal.active) {
    return { matched: false, reason: temporal.reason };
  }
  if (!correctionMatchesDirection(correction, options.headingDeg ?? null)) {
    return { matched: false, reason: 'direction_mismatch' };
  }

  const points = Array.isArray(correction?.sectionPoints)
    ? correction.sectionPoints.filter((point) => isUsableCoordinate(Number(point?.lat), Number(point?.lng)))
    : [];
  if (points.length >= 2) {
    let bestDistanceKm = Infinity;
    for (let index = 1; index < points.length; index++) {
      bestDistanceKm = Math.min(bestDistanceKm, pointToSegmentDistanceKm(lat, lng, points[index - 1], points[index]));
    }
    return {
      matched: bestDistanceKm <= radiusKm,
      reason: bestDistanceKm <= radiusKm ? 'matched_traced_section' : 'too_far_from_traced_section',
      matchType: 'traced_section',
      matchDistanceM: Number.isFinite(bestDistanceKm) ? Math.round(bestDistanceKm * 1000) : null,
      headingDeltaDeg: correctionHeadingDelta(correction, options.headingDeg ?? null),
    };
  }

  const center = correction?.geohash ? geohashDecode(correction.geohash) : null;
  const distance = center ? distanceKm(center.lat, center.lng, Number(lat), Number(lng)) : Infinity;
  const matched = options.allowLegacyCellMatch === true &&
    Number.isFinite(distance) && distance <= LEGACY_CELL_MATCH_RADIUS_KM;
  return {
    matched,
    reason: matched
      ? 'matched_geohash_cell'
      : options.allowLegacyCellMatch === true
        ? 'too_far_from_geohash_cell'
        : 'road_geometry_required',
    matchType: 'geohash_cell',
    matchDistanceM: Number.isFinite(distance) ? Math.round(distance * 1000) : null,
    headingDeltaDeg: correctionHeadingDelta(correction, options.headingDeg ?? null),
  };
}

export function geohashNeighboursInclude(geohash, lat, lng, radiusKm) {
  if (!geohash || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
  const center = geohashDecode(geohash);
  return distanceKm(center.lat, center.lng, Number(lat), Number(lng)) <= radiusKm;
}

function createExcludedSectionId() {
  return `excluded-road-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeExcludedSection(section = {}, reason = 'parking_private') {
  const sectionPoints = (Array.isArray(section.sectionPoints) ? section.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => isUsableCoordinate(point.lat, point.lng))
    .slice(0, 24);
  const suppliedLat = Number(section.lat);
  const suppliedLng = Number(section.lng);
  const center = isUsableCoordinate(suppliedLat, suppliedLng)
    ? { lat: suppliedLat, lng: suppliedLng }
    : sectionPoints[Math.floor(sectionPoints.length / 2)] || null;
  if (!center) return null;
  return {
    id: String(section.exclusionId || section.exclusionKey || '').trim() || createExcludedSectionId(),
    geohash: String(section.geohash || '').trim() || geohashEncode(center.lat, center.lng, CELL_PRECISION),
    lat: center.lat,
    lng: center.lng,
    roadName: String(section.roadName || '').trim(),
    reason: String(reason || 'parking_private').slice(0, 80),
    directionMode: 'both',
    exclusionKeys: Array.isArray(section.exclusionKeys)
      ? [...new Set(section.exclusionKeys.filter(Boolean).map(String))].slice(0, 12)
      : [],
    sectionPoints,
    createdAt: new Date().toISOString(),
  };
}

function recordPoints(record = {}) {
  const points = (Array.isArray(record.sectionPoints) ? record.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => isUsableCoordinate(point.lat, point.lng));
  if (points.length) return points;
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (isUsableCoordinate(lat, lng)) return [{ lat, lng }];
  if (!record.geohash) return [];
  try {
    return [geohashCenter(record.geohash)];
  } catch {
    return [];
  }
}

function candidateCoveredByConfirmedCorrection(candidate = {}, corrections = [], timestampMs = Date.now()) {
  const candidatePoints = recordPoints(candidate);
  if (!candidatePoints.length) return false;
  const headingDeg = Number.isFinite(Number(candidate.directionBearing))
    ? Number(candidate.directionBearing)
    : null;
  return (Array.isArray(corrections) ? corrections : []).some((correction) => (
    correctionSource(correction) === 'user_confirmed_posted_sign' &&
    !isHistoricalCorrectionVersion(correction) &&
    candidatePoints.some((point) => correctionMatchesPoint(
      correction,
      point.lat,
      point.lng,
      ROAD_SECTION_MATCH_RADIUS_KM,
      { headingDeg, timestampMs, ignoreSchedule: true }
    ))
  ));
}

function unresolvedCandidateCoveredByConfirmedCorrection(candidate = {}, corrections = [], timestampMs = Date.now()) {
  return !['confirmed', 'adjusted'].includes(candidate?.reviewState) &&
    candidateCoveredByConfirmedCorrection(candidate, corrections, timestampMs);
}

function recordMatchesExcludedSection(record = {}, exclusion = {}) {
  const recordGeometry = recordPoints(record);
  const exclusionGeometry = recordPoints(exclusion);
  return recordGeometry.some((point) => correctionMatchesPoint(
    exclusion,
    point.lat,
    point.lng,
    ROAD_SECTION_MATCH_RADIUS_KM,
    { allowLegacyCellMatch: true }
  )) || exclusionGeometry.some((point) => correctionMatchesPoint(
    record,
    point.lat,
    point.lng,
    ROAD_SECTION_MATCH_RADIUS_KM,
    { allowLegacyCellMatch: true }
  ));
}

function pointMatchesExcludedSection(data = {}, lat, lng, options = {}) {
  return (Array.isArray(data.excludedSections) ? data.excludedSections : [])
    .some((exclusion) => correctionMatchesPoint(
      exclusion,
      Number(lat),
      Number(lng),
      ROAD_SECTION_MATCH_RADIUS_KM,
      { ...options, allowLegacyCellMatch: true }
    ));
}

function defaultData() {
  return {
    schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
    knowledgeRevision: 0,
    knowledgeUpdatedAt: null,
    cells: {},
    corrections: [],
    excludedSections: [],
    roadMemory: {
      version: 3,
      chronologyVersion: ROAD_MEMORY_CHRONOLOGY_VERSION,
      candidates: [],
      processedTrips: {},
      intelligence: null,
    },
    history: { undo: [], redo: [] },
  };
}

const cloneData = (data) => {
  if (data === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
};

const snapshotData = (data) => {
  const snapshot = cloneData(data || defaultData());
  delete snapshot.history;
  return snapshot;
};

const FULL_ROAD_MEMORY_HISTORY_ACTIONS = new Set([
  'restore_speed_backup',
  'restore_backup',
  'exclude_speed_section',
  'restore_excluded_speed_sections',
]);

const ROAD_MEMORY_USER_DECISION_FIELDS = [
  'reviewState',
  'reviewedAt',
  'timeProfilesAcceptedAt',
  'limitAtReviewKmh',
  'reviewedLimitKmh',
  'feedbackOutcome',
  'feedbackOrigin',
  'feedbackContext',
  'lastPromptedTripCount',
];

const roadMemoryCandidateHistoryKey = (candidate = {}) => String(
  candidate.id || candidate.sectionKey || candidate.geohash || ''
);

const roadMemoryDecisionSnapshot = (candidate = {}) => ROAD_MEMORY_USER_DECISION_FIELDS
  .map((field) => (
    Object.prototype.hasOwnProperty.call(candidate, field)
      ? [field, true, cloneData(candidate[field])]
      : [field, false, null]
  ));

const sameRoadMemoryDecisionSnapshot = (candidate = {}, snapshot = []) => (
  JSON.stringify(roadMemoryDecisionSnapshot(candidate)) === JSON.stringify(snapshot)
);

const applyRoadMemoryDecisionSnapshot = (candidate = {}, snapshot = []) => {
  const next = { ...candidate };
  const entries = new Map(Array.isArray(snapshot) ? snapshot.map((entry) => [entry?.[0], entry]) : []);
  for (const field of ROAD_MEMORY_USER_DECISION_FIELDS) {
    const entry = entries.get(field);
    if (entry?.[1] === true) next[field] = cloneData(entry[2]);
    else delete next[field];
  }
  return next;
};

const mergeRoadMemoryDecisionChanges = (current = [], incoming = []) => {
  const merged = new Map((Array.isArray(current) ? current : []).map((change) => (
    [String(change?.candidateKey || ''), cloneData(change)]
  )));
  for (const change of Array.isArray(incoming) ? incoming : []) {
    const key = String(change?.candidateKey || '');
    if (!key || !Array.isArray(change?.before) || !Array.isArray(change?.after)) continue;
    const existing = merged.get(key);
    merged.set(key, existing
      ? { ...existing, after: cloneData(change.after) }
      : cloneData(change));
  }
  return [...merged.values()].filter((change) => change?.candidateKey);
};

// Saved-rule decisions can calibrate Road Memory. Undo/redo must reverse those
// user-controlled feedback fields while retaining automatic trip evidence
// learned since the snapshot. Whole-store restore/exclusion actions are exact
// transactions and therefore restore their Road Memory snapshot wholesale.
const roadMemoryForHistoryTransition = (
  target = {},
  current = {},
  action = '',
  roadMemoryDecisionChanges = [],
  direction = 'undo'
) => {
  if (FULL_ROAD_MEMORY_HISTORY_ACTIONS.has(action)) return cloneData(target || {});
  // Most correction-history actions never mutate Road Memory. Preserve its
  // newer automatic learning and parked-review decisions unless this exact
  // transaction recorded feedback through applyPostedCorrectionToRoadMemory.
  if (!Array.isArray(roadMemoryDecisionChanges) || !roadMemoryDecisionChanges.length) {
    return cloneData(current || {});
  }
  const currentCandidates = Array.isArray(current?.candidates) ? current.candidates : [];
  const changesByKey = new Map(roadMemoryDecisionChanges.map((change) => (
    [String(change?.candidateKey || ''), change]
  )));
  const mergedCandidates = currentCandidates.map((candidate) => {
    const key = roadMemoryCandidateHistoryKey(candidate);
    const change = changesByKey.get(key);
    if (!change) return candidate;
    const expected = direction === 'redo' ? change.before : change.after;
    const replacement = direction === 'redo' ? change.after : change.before;
    // A later parked review wins over an older correction history entry.
    // Reverse/reapply only while the decision still matches what this exact
    // transaction produced (or what its Undo restored).
    return sameRoadMemoryDecisionSnapshot(candidate, expected)
      ? applyRoadMemoryDecisionSnapshot(candidate, replacement)
      : candidate;
  });
  const model = decorateRoadMemoryCandidates(mergedCandidates);
  const { feedback: _feedback, ...calibrationSummary } = model.calibration;
  return {
    ...(current || {}),
    candidates: model.candidates.map((candidate) => ({
      ...candidate,
      intelligenceVersion: model.calibration.version,
    })),
    intelligence: {
      ...calibrationSummary,
      updatedAt: new Date().toISOString(),
    },
  };
};

const normalizeData = (data) => {
  const storedRoadMemory = data?.roadMemory && typeof data.roadMemory === 'object'
    ? data.roadMemory
    : {};
  const needsChronologyRepair = Number(storedRoadMemory.chronologyVersion) <
    ROAD_MEMORY_CHRONOLOGY_VERSION;
  const candidates = Array.isArray(storedRoadMemory.candidates)
    ? storedRoadMemory.candidates.filter(Boolean).map((candidate) => (
      needsChronologyRepair
        ? {
          ...candidate,
          recentObservations: [],
          chronologyRepairPending: true,
        }
        : candidate
    ))
    : [];

  return {
    ...defaultData(),
    ...(data || {}),
    schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
    knowledgeRevision: Number.isSafeInteger(Number(data?.knowledgeRevision)) &&
      Number(data.knowledgeRevision) >= 0
      ? Number(data.knowledgeRevision)
      : 0,
    knowledgeUpdatedAt: String(data?.knowledgeUpdatedAt || '').trim() || null,
    cells: data?.cells && typeof data.cells === 'object' ? data.cells : {},
    corrections: Array.isArray(data?.corrections)
      ? data.corrections.map((correction, index) => ({
        ...correction,
        id: correction?.id || correction?.ruleId || correction?.sectionKey || [
          'legacy-speed-rule',
          correction?.geohash || 'unknown',
          directionMode(correction?.directionMode),
          index,
        ].join('-'),
      }))
      : [],
    excludedSections: Array.isArray(data?.excludedSections)
      ? data.excludedSections.filter(Boolean)
      : [],
    roadMemory: {
      version: 3,
      chronologyVersion: ROAD_MEMORY_CHRONOLOGY_VERSION,
      candidates,
      // A one-time replay is safe because tripVotes de-duplicate independent
      // drives. It reconstructs the recent-observation window in real time
      // order without throwing away user reviews or learned corridor geometry.
      processedTrips: !needsChronologyRepair && storedRoadMemory.processedTrips &&
        typeof storedRoadMemory.processedTrips === 'object'
        ? storedRoadMemory.processedTrips
        : {},
      intelligence: storedRoadMemory.intelligence && typeof storedRoadMemory.intelligence === 'object'
        ? storedRoadMemory.intelligence
        : null,
    },
    history: {
      undo: Array.isArray(data?.history?.undo) ? data.history.undo : [],
      redo: Array.isArray(data?.history?.redo) ? data.history.redo : [],
    },
  };
};

function createRoadMemoryCandidateId(observation = {}, index = 0) {
  const geohash = geohashEncode(observation.lat, observation.lng, CELL_PRECISION);
  const bearing = Number.isFinite(Number(observation.directionBearing))
    ? Math.round(Number(observation.directionBearing) / 15) * 15 % 360
    : 'both';
  return `road-memory-${geohash}-${bearing}-${Date.now().toString(36)}-${index}`;
}

function emitSpeedKnowledgeChanged(detail = {}) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SPEED_KNOWLEDGE_CHANGED_EVENT, { detail }));
}

function recordSpeedKnowledgeEvent(action, details = {}) {
  recordSystemEvent(`speed_knowledge_${action}`, details, {
    category: 'storage',
    title: 'Saved road speed updated',
  });
}

function logSpeedKnowledgeFailure(action, error, details = {}) {
  logSystemFailure(`speed_knowledge_${action}`, error, details);
}

export function timeToBucket(timestampMs) {
  const date = new Date(timestampMs);
  const hour = Number.isFinite(date.getTime()) ? date.getHours() : new Date().getHours();
  const start = Math.floor(hour / 2) * 2;
  const end = start + 2;
  return `${String(start).padStart(2, '0')}-${String(end).padStart(2, '0')}`;
}

function isFreshCorrection(correction) {
  return correctionTemporalState(correction, Date.now(), { ignoreSchedule: true }).active;
}

export function isHistoricalCorrectionVersion(correction = {}) {
  return correction.historicalVersion === true ||
    correction.supersededByCorrectionId != null ||
    (Array.isArray(correction.auditTrail) && correction.auditTrail.some((entry) => (
      entry?.action === 'superseded_by_effective_version'
    )));
}

function correctionSource(correction) {
  if (correction?.source === 'user_confirmed_posted_sign') return 'user_confirmed_posted_sign';
  return 'user_entered_estimate';
}

function correctionConfidence(source) {
  return source === 'user_confirmed_posted_sign' ? 0.92 : 0.75;
}

function verificationStatus(source) {
  return source === 'user_confirmed_posted_sign' ? 'confirmed_posted_sign' : 'user_estimate';
}

const plausibleResolverLimit = (value) => {
  const limitKmh = Number(value);
  return Number.isFinite(limitKmh) && limitKmh > 0 && limitKmh <= MAX_SAVED_SPEED_LIMIT_KMH;
};

function userCorrectionView(correction = {}) {
  const center = geohashCenter(correction.geohash);
  const source = correctionSource(correction);
  const savedLat = Number(correction.lat);
  const savedLng = Number(correction.lng);
  const hasSavedCoordinate = Number.isFinite(savedLat) && Number.isFinite(savedLng);
  const view = {
    ...correction,
    lat: hasSavedCoordinate ? savedLat : center.lat,
    lng: hasSavedCoordinate ? savedLng : center.lng,
    coordinateSource: hasSavedCoordinate
      ? (correction.coordinateSource || 'driven_route_sample')
      : 'geohash_cell_center_legacy',
    source,
    confidence: correctionConfidence(source),
    historicalVersion: isHistoricalCorrectionVersion(correction),
  };
  return {
    ...view,
    ...assessSpeedLimitEvidence({
      ...view,
      source,
      confidence: correctionConfidence(source),
    }),
    verificationStatus: correction.verificationStatus || verificationStatus(source),
  };
}

function auditEntry(action, details = {}) {
  return {
    action,
    changedAt: new Date().toISOString(),
    ...details,
  };
}

function pointSource(point) {
  return point?.source ?? point?.speed_limit_source ?? point?.limitSource ?? null;
}

function isUsableCoordinate(lat, lng) {
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(Math.abs(lat) < NULL_ISLAND_EPSILON && Math.abs(lng) < NULL_ISLAND_EPSILON);
}

function hasTracedSectionGeometry(points = []) {
  const usable = (Array.isArray(points) ? points : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => isUsableCoordinate(point.lat, point.lng));
  if (usable.length < 2) return false;
  const first = usable[0];
  return usable.some((point) => point.lat !== first.lat || point.lng !== first.lng);
}

function timestampForPoint(point) {
  const raw = point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at;
  const time = typeof raw === 'number' ? raw : new Date(raw).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function bucketSpeedForPoint(point, fallbackLimitKmh) {
  const speed = Number(point?.p85Kmh ?? point?.p85_speed_kmh ?? point?.speed_kmh ?? point?.speedKmh ?? fallbackLimitKmh);
  return Number.isFinite(speed) && speed > 0 ? speed : Number(fallbackLimitKmh);
}

function updateTimeOfDayBuckets(cell, point, fallbackLimitKmh) {
  const bucketKey = timeToBucket(timestampForPoint(point));
  const bucketSpeed = bucketSpeedForPoint(point, fallbackLimitKmh);
  cell.timeOfDayBuckets ??= {};
  const existing = cell.timeOfDayBuckets[bucketKey] || { p85Kmh: 0, count: 0 };
  const count = (Number(existing.count) || 0) + 1;
  const previousTotal = (Number(existing.p85Kmh) || 0) * (count - 1);
  cell.timeOfDayBuckets[bucketKey] = {
    p85Kmh: Math.round((previousTotal + bucketSpeed) / count),
    count,
  };
}

function applyBucketLimit(cell, timestampMs) {
  if (timestampMs == null || !cell?.timeOfDayBuckets) return cell;
  const bucket = cell.timeOfDayBuckets[timeToBucket(timestampMs)];
  const bucketLimit = Number(bucket?.p85Kmh);
  if (!Number.isFinite(bucketLimit)) return cell;
  return {
    ...cell,
    timeOfDayBucket: bucket,
    observedTimeOfDayP85Kmh: Math.max(0, Math.round(bucketLimit)),
  };
}

function tripChronologyTimestamp(trip = {}) {
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const values = [
    trip?.start_time,
    lookupTimestampForPoint(points[0]),
    trip?.end_time,
    lookupTimestampForPoint(points.at(-1)),
  ];
  for (const value of values) {
    if (value == null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function chronologicalTrips(trips = []) {
  return (Array.isArray(trips) ? trips : [])
    .map((trip, index) => ({ trip, index, timestamp: tripChronologyTimestamp(trip) }))
    .sort((a, b) => (
      (a.timestamp ?? Number.MAX_SAFE_INTEGER) - (b.timestamp ?? Number.MAX_SAFE_INTEGER) ||
      a.index - b.index
    ))
    .map((item) => item.trip);
}

function applyPostedCorrectionToRoadMemory(data, correction = {}, origin = 'saved_posted_rule') {
  const candidates = Array.isArray(data?.roadMemory?.candidates) ? data.roadMemory.candidates : [];
  const explicitCandidateId = String(correction.roadMemoryCandidateId || '');
  const confirmedPosted = correction.source === 'user_confirmed_posted_sign';
  const explicitEstimateReview = Boolean(explicitCandidateId) &&
    correction.source === 'user_entered_estimate';
  if (!candidates.length || (!confirmedPosted && !explicitEstimateReview)) {
    return { changed: false, changedUsageCandidates: [], decisionChanges: [] };
  }
  const headingDeg = correction.directionBearing;
  const matched = candidates
    .map((candidate) => ({
      candidate,
      match: explicitCandidateId && String(candidate.id) === explicitCandidateId
        ? { matched: true, matchDistanceM: 0 }
        : correctionMatchDetails(candidate, correction.lat, correction.lng, ROAD_SECTION_MATCH_RADIUS_KM, {
          headingDeg,
        }),
    }))
    .filter((item) => item.match?.matched)
    .sort((a, b) => (
      Number(a.match.matchDistanceM ?? Infinity) - Number(b.match.matchDistanceM ?? Infinity) ||
      Number(b.candidate.tripCount) - Number(a.candidate.tripCount)
    ))[0]?.candidate;
  if (!matched || ['confirmed', 'adjusted', 'rejected'].includes(matched.reviewState)) {
    return { changed: false, changedUsageCandidates: [], decisionChanges: [] };
  }
  const candidateKey = roadMemoryCandidateHistoryKey(matched);
  const beforeDecision = roadMemoryDecisionSnapshot(matched);
  const beforeUsageById = new Map(
    decorateRoadMemoryCandidates(candidates).candidates
      .map((item) => [String(item.id), item.canAffectScoreAndAlerts === true])
  );
  const reviewedAt = new Date().toISOString();
  const proposedLimitKmh = Math.round(Number(
    matched.changeDetection?.status === 'possible_change'
      ? matched.changeDetection.proposedLimitKmh
      : matched.limitKmh
  ));
  const reviewedLimitKmh = Math.round(Number(correction.limitKmh));
  data.roadMemory.candidates = candidates.map((candidate) => (
    String(candidate.id) === String(matched.id)
      ? {
        ...candidate,
        reviewState: confirmedPosted ? 'confirmed' : 'adjusted',
        reviewedAt,
        limitAtReviewKmh: proposedLimitKmh,
        reviewedLimitKmh,
        feedbackOutcome: proposedLimitKmh === reviewedLimitKmh ? 'exact' : 'adjusted',
        feedbackOrigin: origin,
        feedbackContext: {
          contextKey: roadMemoryContextKey(candidate),
          proposedLimitKmh,
          chosenLimitKmh: reviewedLimitKmh,
          tripCount: Number(candidate.tripCount) || 0,
          agreement: Number(candidate.agreement) || 0,
          observedP85Kmh: Number(candidate.observedP85Kmh) || null,
        },
        lastPromptedTripCount: Number(candidate.tripCount) || 0,
      }
      : candidate
  ));
  const nextModel = decorateRoadMemoryCandidates(data.roadMemory.candidates);
  data.roadMemory.candidates = nextModel.candidates.map((candidate) => ({
    ...candidate,
    intelligenceVersion: nextModel.calibration.version,
  }));
  const { feedback: _feedback, ...calibrationSummary } = nextModel.calibration;
  data.roadMemory.intelligence = {
    ...calibrationSummary,
    updatedAt: reviewedAt,
  };
  const updatedCandidate = data.roadMemory.candidates.find((candidate) => (
    roadMemoryCandidateHistoryKey(candidate) === candidateKey
  ));
  return {
    changed: true,
    decisionChanges: updatedCandidate ? [{
      candidateKey,
      before: beforeDecision,
      after: roadMemoryDecisionSnapshot(updatedCandidate),
    }] : [],
    changedUsageCandidates: data.roadMemory.candidates.filter((candidate) => (
      beforeUsageById.get(String(candidate.id)) !== (candidate.canAffectScoreAndAlerts === true)
    )),
  };
}

function refreshRoadMemoryUsageChanges(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return;
  void import('@/lib/localSpeedScoreRefresh')
    .then(({ refreshTripsForLocalSpeedCorrections }) => refreshTripsForLocalSpeedCorrections(candidates))
    .catch((error) => logSpeedKnowledgeFailure('road_memory_calibration_rescore', error, {
      candidate_count: candidates.length,
    }));
}

function lookupTimestampForPoint(point = {}) {
  return point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ??
    point?.sampleTimestamp ?? null;
}

function lookupOptionsForPoint(point = {}) {
  return {
    headingDeg: point?.headingDeg ?? point?.heading ?? point?.sampleHeadingDeg ?? null,
    utcOffsetMinutes: point?.utcOffsetMinutes ?? point?.utc_offset_minutes ??
      point?.sampleUtcOffsetMinutes ?? null,
  };
}

function sectionLookupPoints(point = {}) {
  return (Array.isArray(point?.sectionPoints) ? point.sectionPoints : [])
    .map((sectionPoint) => ({
      lat: Number(sectionPoint?.lat),
      lng: Number(sectionPoint?.lng),
    }))
    .filter((sectionPoint) => isUsableCoordinate(sectionPoint.lat, sectionPoint.lng));
}

function sectionLookupThreshold(pointCount) {
  if (pointCount <= 1) return pointCount;
  return Math.min(pointCount, Math.max(2, Math.ceil(pointCount * 0.2)));
}

function runFallbackStoreMutationExclusive(store, operation) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) {
    return Promise.resolve().then(operation);
  }
  const previousTail = fallbackMutationTails.get(store) || Promise.resolve();
  const result = previousTail.catch(() => {}).then(operation);
  const nextTail = result.catch(() => {});
  fallbackMutationTails.set(store, nextTail);
  return result.finally(() => {
    if (fallbackMutationTails.get(store) === nextTail) fallbackMutationTails.delete(store);
  });
}

export class LocalSpeedKnowledge {
  constructor(store) {
    this._store = store;
  }

  async _load() {
    return normalizeData((await this._store.get(STORAGE_KEY)) ?? defaultData());
  }

  _runMutation(operation) {
    if (typeof this._store?.runExclusive === 'function') {
      return this._store.runExclusive(STORAGE_KEY, operation);
    }
    return runFallbackStoreMutationExclusive(this._store, operation);
  }

  async _write(data, previous = null) {
    const previousRevision = Number(previous?.knowledgeRevision);
    const dataRevision = Number(data?.knowledgeRevision);
    data.schemaVersion = SPEED_KNOWLEDGE_SCHEMA_VERSION;
    data.knowledgeRevision = Math.max(
      Number.isSafeInteger(previousRevision) && previousRevision >= 0 ? previousRevision : 0,
      Number.isSafeInteger(dataRevision) && dataRevision >= 0 ? dataRevision : 0
    ) + 1;
    data.knowledgeUpdatedAt = new Date().toISOString();
    await this._store.set(STORAGE_KEY, data);
    return data;
  }

  _prepareResolverData(data) {
    const model = decorateRoadMemoryCandidates(data.roadMemory?.candidates || []);
    return {
      ...data,
      _preparedRoadMemoryCandidates: model.candidates.filter((candidate) => (
        candidate.canAffectScoreAndAlerts === true &&
        plausibleResolverLimit(candidate?.limitKmh) &&
        Array.isArray(candidate?.sectionPoints) && candidate.sectionPoints.length >= 2 &&
        !candidateCoveredByConfirmedCorrection(candidate, data.corrections) &&
        !(data.excludedSections || []).some((exclusion) => (
          recordMatchesExcludedSection(candidate, exclusion)
        ))
      )),
    };
  }

  async _commit(data, previous, action, historyGroup = null, {
    roadMemoryDecisionChanges = [],
  } = {}) {
    const history = normalizeData(data).history;
    const last = history.undo.at(-1);
    if (!historyGroup || last?.historyGroup !== historyGroup) {
      history.undo.push({
        action,
        changedAt: new Date().toISOString(),
        historyGroup,
        roadMemoryDecisionChanges: mergeRoadMemoryDecisionChanges([], roadMemoryDecisionChanges),
        data: previous,
      });
      history.undo = history.undo.slice(-HISTORY_LIMIT);
    } else if (roadMemoryDecisionChanges.length > 0) {
      last.roadMemoryDecisionChanges = mergeRoadMemoryDecisionChanges(
        last.roadMemoryDecisionChanges,
        roadMemoryDecisionChanges
      );
    }
    history.redo = [];
    data.history = history;
    await this._write(data, previous);
  }

  async exportData() {
    return snapshotData(await this._load());
  }

  async getMetadata() {
    const data = await this._load();
    return {
      schemaVersion: data.schemaVersion,
      knowledgeRevision: data.knowledgeRevision,
      knowledgeUpdatedAt: data.knowledgeUpdatedAt,
    };
  }

  async replaceData(value, action = 'restore_backup') {
    const current = await this._load();
    const next = normalizeData(value);
    await this._commit(next, snapshotData(current), action);
    emitSpeedKnowledgeChanged({ action });
    return true;
  }

  async repairSavedSpeedData() {
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      const corrections = Array.isArray(data.corrections) ? data.corrections : [];
      const byIdentity = new Map();
      let removedExpired = 0;
      let removedDuplicates = 0;

      for (const correction of corrections) {
        if (!isFreshCorrection(correction) && !isHistoricalCorrectionVersion(correction)) {
          removedExpired += 1;
          continue;
        }
        const identity = correctionIdentity(correction);
        const existing = byIdentity.get(identity);
        if (!existing || correctionRepairRank(correction) >= correctionRepairRank(existing)) {
          if (existing) removedDuplicates += 1;
          byIdentity.set(identity, correction);
        } else {
          removedDuplicates += 1;
        }
      }

      const nextCorrections = [...byIdentity.values()];
      const changed = removedExpired > 0 ||
        removedDuplicates > 0 ||
        nextCorrections.length !== corrections.length;
      if (!changed) {
        return {
          changed: false,
          removedExpired,
          removedDuplicates,
          keptCorrections: corrections.length,
        };
      }

      data.corrections = nextCorrections;
      await this._commit(data, previous, 'repair_saved_speed_data');
      recordSpeedKnowledgeEvent('repair_saved_speed_data', {
        removed_expired: removedExpired,
        removed_duplicates: removedDuplicates,
      });
      emitSpeedKnowledgeChanged({
        action: 'repair_saved_speed_data',
        removedExpired,
        removedDuplicates,
      });
      return {
        changed: true,
        removedExpired,
        removedDuplicates,
        keptCorrections: nextCorrections.length,
      };
    } catch (error) {
      logSpeedKnowledgeFailure('repair_saved_speed_data', error);
      throw error;
    }
  }

  async getHistoryState() {
    const data = await this._load();
    return {
      canUndo: data.history.undo.length > 0,
      canRedo: data.history.redo.length > 0,
      undoLabel: data.history.undo.at(-1)?.action || '',
      redoLabel: data.history.redo.at(-1)?.action || '',
    };
  }

  async undo() {
    const current = await this._load();
    const entry = current.history.undo.pop();
    if (!entry?.data) return false;
    const restored = normalizeData(entry.data);
    restored.roadMemory = roadMemoryForHistoryTransition(
      restored.roadMemory,
      current.roadMemory,
      entry.action,
      entry.roadMemoryDecisionChanges,
      'undo'
    );
    restored.history.undo = current.history.undo;
    restored.history.redo = [
      ...current.history.redo,
      {
        action: entry.action,
        changedAt: new Date().toISOString(),
        roadMemoryDecisionChanges: cloneData(entry.roadMemoryDecisionChanges || []),
        data: snapshotData(current),
      },
    ].slice(-HISTORY_LIMIT);
    await this._write(restored, current);
    emitSpeedKnowledgeChanged({ action: 'undo', originalAction: entry.action });
    return true;
  }

  async redo() {
    const current = await this._load();
    const entry = current.history.redo.pop();
    if (!entry?.data) return false;
    const restored = normalizeData(entry.data);
    restored.roadMemory = roadMemoryForHistoryTransition(
      restored.roadMemory,
      current.roadMemory,
      entry.action,
      entry.roadMemoryDecisionChanges,
      'redo'
    );
    restored.history.undo = [
      ...current.history.undo,
      {
        action: entry.action,
        changedAt: new Date().toISOString(),
        roadMemoryDecisionChanges: cloneData(entry.roadMemoryDecisionChanges || []),
        data: snapshotData(current),
      },
    ].slice(-HISTORY_LIMIT);
    restored.history.redo = current.history.redo;
    await this._write(restored, current);
    emitSpeedKnowledgeChanged({ action: 'redo', originalAction: entry.action });
    return true;
  }

  _resolveForPoint(data, lat, lng, timestampMs = null, options = {}) {
    if (pointMatchesExcludedSection(data, lat, lng, {
      ...options,
      timestampMs,
    })) return null;
    const correctionMatch = (data.corrections || [])
      .filter((item) => plausibleResolverLimit(item?.limitKmh))
      .map((item) => ({
        correction: item,
        match: correctionMatchDetails(item, lat, lng, ROAD_SECTION_MATCH_RADIUS_KM, {
          timestampMs,
          headingDeg: options.headingDeg ?? options.heading ?? null,
          utcOffsetMinutes: options.utcOffsetMinutes ?? options.utc_offset_minutes ?? null,
        }),
      }))
      .filter((item) => item.match.matched)
      .sort((a, b) => (
        correctionAuthority(b.correction) - correctionAuthority(a.correction) ||
        correctionSpecificity(b.correction) - correctionSpecificity(a.correction) ||
        compareOptionalNumber(a.match.headingDeltaDeg, b.match.headingDeltaDeg) ||
        compareOptionalNumber(a.match.matchDistanceM, b.match.matchDistanceM) ||
        new Date(b.correction.appliedAt || 0).getTime() - new Date(a.correction.appliedAt || 0).getTime()
      ))[0];
    const correction = correctionMatch?.correction;
    if (correction) {
      const source = correctionSource(correction);
      const evidence = assessSpeedLimitEvidence({
        ...correction,
        source,
        confidence: correctionConfidence(source),
      });
      return {
        id: correction.id || correction.ruleId || null,
        ruleId: correction.ruleId || null,
        sectionKey: correction.sectionKey || correction.id || correction.ruleId || correction.geohash,
        limitKmh: correction.limitKmh,
        source,
        confidence: evidence.confidence,
        confidenceLevel: evidence.level,
        verificationStatus: correction.verificationStatus || verificationStatus(source),
        verifiedAt: correction.verifiedAt || correction.appliedAt || null,
        evidenceCount: Number(correction.evidenceCount) || 1,
        stale: evidence.stale,
        needsReview: evidence.needsReview,
        geohash: correction.geohash,
        correctionId: correction.id || correction.ruleId || null,
        matchType: correctionMatch.match.matchType,
        matchDistanceM: correctionMatch.match.matchDistanceM,
        matchReason: correctionMatch.match.reason,
        roadName: correction.roadName || null,
        contextLabel: correction.contextLabel || null,
        directionLabel: correction.directionLabel || null,
        timeLabel: correction.timeLabel || null,
        lat: Number.isFinite(Number(correction.lat)) ? Number(correction.lat) : null,
        lng: Number.isFinite(Number(correction.lng)) ? Number(correction.lng) : null,
        distanceM: Number(correction.distanceM) || 0,
        directionMode: correction.directionMode || 'both',
        directionBearing: Number.isFinite(Number(correction.directionBearing)) ? Number(correction.directionBearing) : null,
        timeRule: correction.timeRule || null,
        validFrom: correction.validFrom || null,
        validFromDate: correction.validFromDate || null,
        expiresAt: correction.expiresAt || null,
        expiresAtDate: correction.expiresAtDate || null,
        historicalVersion: isHistoricalCorrectionVersion(correction),
        supersededAt: correction.supersededAt || null,
        supersededByCorrectionId: correction.supersededByCorrectionId || null,
        supersedesCorrectionId: correction.supersedesCorrectionId || null,
        versionRootId: correction.versionRootId || null,
        knowledgeRevision: Number(data.knowledgeRevision) || 0,
        sectionPoints: (Array.isArray(correction.sectionPoints) ? correction.sectionPoints : [])
          .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
          .filter((point) => isUsableCoordinate(point.lat, point.lng)),
        conflictResolution: correction.conflictResolution || null,
      };
    }

    const headingDeg = options.headingDeg ?? options.heading ?? null;
    const activeRoadMemoryCandidates = Array.isArray(data._preparedRoadMemoryCandidates)
      ? data._preparedRoadMemoryCandidates
      : decorateRoadMemoryCandidates(data.roadMemory?.candidates || []).candidates
        .filter((candidate) => candidate.canAffectScoreAndAlerts === true &&
          plausibleResolverLimit(candidate?.limitKmh) &&
          Array.isArray(candidate?.sectionPoints) && candidate.sectionPoints.length >= 2);
    const roadMemoryMatch = activeRoadMemoryCandidates
      .map((candidate) => ({
        candidate,
        match: correctionMatchDetails(candidate, lat, lng, ROAD_SECTION_MATCH_RADIUS_KM, {
          timestampMs,
          headingDeg,
          utcOffsetMinutes: options.utcOffsetMinutes ?? options.utc_offset_minutes ?? null,
        }),
      }))
      .filter((item) => item.match.matched)
      .sort((a, b) => (
        Number(b.candidate.confidence) - Number(a.candidate.confidence) ||
        Number(b.candidate.tripCount) - Number(a.candidate.tripCount) ||
        compareOptionalNumber(a.match.matchDistanceM, b.match.matchDistanceM)
      ))[0];
    if (roadMemoryMatch) {
      const candidate = roadMemoryMatch.candidate;
      const state = candidate;
      const effective = roadMemoryEffectiveLimit(
        candidate,
        timestampMs,
        options.utcOffsetMinutes ?? options.utc_offset_minutes ?? null
      );
      const evidence = assessSpeedLimitEvidence({
        ...candidate,
        confidence: state.effectiveConfidence,
      });
      return {
        id: candidate.id,
        sectionKey: candidate.sectionKey || candidate.id,
        candidateId: candidate.id,
        roadMemoryCandidate: true,
        correctionId: null,
        geohash: candidate.geohash,
        limitKmh: effective.limitKmh,
        source: 'local_road_memory',
        confidence: Math.min(evidence.confidence, state.effectiveConfidence),
        confidenceLevel: evidence.level,
        verificationStatus: 'local_candidate',
        verifiedAt: null,
        evidenceCount: Number(candidate.evidenceCount) || 0,
        tripCount: Number(candidate.tripCount) || 0,
        agreement: Number(candidate.agreement) || 0,
        stale: evidence.stale,
        needsReview: true,
        matchType: roadMemoryMatch.match.matchType,
        matchDistanceM: roadMemoryMatch.match.matchDistanceM,
        matchReason: roadMemoryMatch.match.reason,
        roadName: candidate.roadName || null,
        contextLabel: roadMemoryConfidenceExplanation(candidate),
        directionLabel: candidate.directionLabel || null,
        timeLabel: effective.timeProfile
          ? `${String(effective.timeBucket).replace(/_/g, ' ')} pattern`
          : candidate.timeLabel || null,
        timeBucket: effective.timeBucket,
        timeProfile: effective.timeProfile,
        pendingTimeProfile: effective.pendingTimeProfile,
        timeProfilesAccepted: effective.timeProfilesAccepted,
        stage: state.stage,
        baseStage: state.baseStage,
        usageStage: state.usageStage,
        shadowMode: state.shadowMode,
        canAffectScoreAndAlerts: state.canAffectScoreAndAlerts,
        validationReason: state.validationReason,
        lat: Number(candidate.lat),
        lng: Number(candidate.lng),
        distanceM: Number(candidate.distanceM) || 0,
        directionMode: candidate.directionMode || 'both',
        directionBearing: Number.isFinite(Number(candidate.directionBearing))
          ? Number(candidate.directionBearing)
          : null,
        timeRule: null,
        sectionPoints: (Array.isArray(candidate.sectionPoints) ? candidate.sectionPoints : [])
          .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
          .filter((point) => isUsableCoordinate(point.lat, point.lng)),
        knowledgeRevision: Number(data.knowledgeRevision) || 0,
      };
    }

    // A validated Road Memory corridor has road geometry and direction
    // evidence. Prefer it over a coarse learned geohash cell so a cell learned
    // on a nearby parallel road cannot bleed into this road. Explicit manual
    // corrections remain the highest-authority result above both sources.
    for (const precision of [CELL_PRECISION, FALLBACK_PRECISION]) {
      const geohash = geohashEncode(lat, lng, precision);
      const cell = data.cells?.[geohash];
      if (cell && !this._isExpired(cell)) {
        return {
          ...applyBucketLimit(cell, timestampMs),
          geohash,
          knowledgeRevision: Number(data.knowledgeRevision) || 0,
        };
      }
    }

    return null;
  }

  _resolveForPointOrSection(data, point = {}) {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!isUsableCoordinate(lat, lng)) return null;

    const timestampMs = lookupTimestampForPoint(point);
    const options = lookupOptionsForPoint(point);
    const direct = this._resolveForPoint(data, lat, lng, timestampMs, options);
    if (direct) return direct;

    const sectionPoints = sectionLookupPoints(point);
    const requiredMatches = sectionLookupThreshold(sectionPoints.length);
    if (requiredMatches <= 0) return null;

    const sectionMatches = new Map();
    for (const sectionPoint of sectionPoints) {
      const match = this._resolveForPoint(data, sectionPoint.lat, sectionPoint.lng, timestampMs, options);
      if (!match?.correctionId) continue;
      const key = String(match.correctionId);
      const current = sectionMatches.get(key) || {
        count: 0,
        bestDistanceM: Infinity,
        result: match,
      };
      current.count += 1;
      const distanceM = Number(match.matchDistanceM);
      if (Number.isFinite(distanceM) && distanceM < current.bestDistanceM) {
        current.bestDistanceM = distanceM;
        current.result = match;
      }
      sectionMatches.set(key, current);
    }

    return [...sectionMatches.values()]
      .filter((match) => match.count >= requiredMatches)
      .sort((a, b) => (
        b.count - a.count ||
        a.bestDistanceM - b.bestDistanceM ||
        String(a.result.correctionId).localeCompare(String(b.result.correctionId))
      ))[0]?.result || null;
  }

  async getForPoint(lat, lng, timestampMs = null, options = {}) {
    const data = this._prepareResolverData(await this._load());
    return this._resolveForPoint(data, lat, lng, timestampMs, options);
  }

  async getForPoints(points = []) {
    const data = this._prepareResolverData(await this._load());
    const results = (Array.isArray(points) ? points : [])
      .map((point) => this._resolveForPointOrSection(data, point));
    Object.defineProperty(results, 'knowledgeMetadata', {
      configurable: true,
      enumerable: false,
      value: {
        schemaVersion: data.schemaVersion,
        knowledgeRevision: data.knowledgeRevision,
        knowledgeUpdatedAt: data.knowledgeUpdatedAt,
      },
    });
    return results;
  }

  async listRoadMemoryCandidates({ activeOnly = false } = {}) {
    const data = await this._load();
    const model = decorateRoadMemoryCandidates(data.roadMemory?.candidates || []);
    return model.candidates
      .map((candidate) => {
        const evidence = assessSpeedLimitEvidence({
          ...candidate,
          confidence: candidate.confidence,
        });
        return {
          ...candidate,
          ...evidence,
          confidence: Math.min(evidence.confidence, candidate.confidence),
          roadMemoryCandidate: true,
          saved: false,
        };
      })
      .filter((candidate) => !unresolvedCandidateCoveredByConfirmedCorrection(candidate, data.corrections))
      .filter((candidate) => !activeOnly || candidate.active === true)
      .sort((a, b) => (
        Number(b.canAffectScoreAndAlerts) - Number(a.canAffectScoreAndAlerts) ||
        String(a.usageStage).localeCompare(String(b.usageStage)) ||
        Number(b.tripCount) - Number(a.tripCount) ||
        Number(b.confidence) - Number(a.confidence)
      ));
  }

  async getSpeedLimitsSnapshot() {
    const data = await this._load();
    const model = decorateRoadMemoryCandidates(data.roadMemory?.candidates || []);
    const suppressedSuggestionCount = model.candidates.filter((candidate) => (
      unresolvedCandidateCoveredByConfirmedCorrection(candidate, data.corrections)
    )).length;
    const candidates = model.candidates
      .map((candidate) => {
        const evidence = assessSpeedLimitEvidence({
          ...candidate,
          confidence: candidate.confidence,
        });
        return {
          ...candidate,
          ...evidence,
          confidence: Math.min(evidence.confidence, candidate.confidence),
          roadMemoryCandidate: true,
          saved: false,
        };
      })
      .filter((candidate) => !unresolvedCandidateCoveredByConfirmedCorrection(candidate, data.corrections))
      .sort((a, b) => (
        Number(b.canAffectScoreAndAlerts) - Number(a.canAffectScoreAndAlerts) ||
        String(a.usageStage).localeCompare(String(b.usageStage)) ||
        Number(b.tripCount) - Number(a.tripCount) ||
        Number(b.confidence) - Number(a.confidence)
      ));
    return {
      rows: (data.corrections || [])
        .map(userCorrectionView)
        .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime()),
      candidates,
      history: {
        canUndo: data.history.undo.length > 0,
        canRedo: data.history.redo.length > 0,
        undoLabel: data.history.undo.at(-1)?.action || '',
        redoLabel: data.history.redo.at(-1)?.action || '',
      },
      exclusions: (data.excludedSections || []).map((section) => ({ ...section })),
      protection: {
        confirmedCorridorCount: (data.corrections || []).filter((correction) => (
          correctionSource(correction) === 'user_confirmed_posted_sign' &&
          !isHistoricalCorrectionVersion(correction) &&
          Array.isArray(correction.sectionPoints) && correction.sectionPoints.length >= 2
        )).length,
        suppressedSuggestionCount,
      },
      rawKnowledge: snapshotData(data),
    };
  }

  async getDashboardSpeedSnapshot({
    lat = null,
    lng = null,
    timestampMs = Date.now(),
    headingDeg = null,
    utcOffsetMinutes = null,
  } = {}) {
    const data = this._prepareResolverData(await this._load());
    const hasPoint = isUsableCoordinate(Number(lat), Number(lng));
    return {
      activeDecision: hasPoint
        ? this._resolveForPoint(data, Number(lat), Number(lng), timestampMs, {
          headingDeg,
          utcOffsetMinutes,
        })
        : null,
      rawKnowledge: snapshotData(data),
    };
  }

  async listExcludedSpeedSections() {
    const data = await this._load();
    return (data.excludedSections || []).map((section) => ({ ...section }));
  }

  async excludeSpeedSection(section = {}, reason = 'parking_private') {
    const exclusion = normalizeExcludedSection(section, reason);
    if (!exclusion) return false;
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.excludedSections = Array.isArray(data.excludedSections) ? data.excludedSections : [];
      data.corrections = Array.isArray(data.corrections) ? data.corrections : [];
      data.cells = data.cells && typeof data.cells === 'object' ? data.cells : {};
      data.roadMemory ??= { version: 3, candidates: [], processedTrips: {}, intelligence: null };
      data.roadMemory.candidates = Array.isArray(data.roadMemory.candidates)
        ? data.roadMemory.candidates
        : [];

      const correctionCountBefore = data.corrections.length;
      const candidateCountBefore = data.roadMemory.candidates.length;
      const cellCountBefore = Object.keys(data.cells).length;
      data.corrections = data.corrections.filter((record) => (
        !recordMatchesExcludedSection(record, exclusion)
      ));
      data.roadMemory.candidates = data.roadMemory.candidates.filter((record) => (
        !recordMatchesExcludedSection(record, exclusion)
      ));
      data.cells = Object.fromEntries(Object.entries(data.cells).filter(([geohash]) => (
        !recordMatchesExcludedSection({ geohash }, exclusion)
      )));
      data.excludedSections = data.excludedSections
        .filter((record) => !recordMatchesExcludedSection(record, exclusion));
      data.excludedSections.push(exclusion);
      data.roadMemory.intelligence = null;

      const result = {
        exclusion,
        correctionsRemoved: correctionCountBefore - data.corrections.length,
        roadMemoryCandidatesRemoved: candidateCountBefore - data.roadMemory.candidates.length,
        cellsRemoved: cellCountBefore - Object.keys(data.cells).length,
      };
      await this._commit(data, previous, 'exclude_speed_section');
      recordSpeedKnowledgeEvent('exclude_speed_section', {
        reason: exclusion.reason,
        correction_count: result.correctionsRemoved,
        road_memory_candidate_count: result.roadMemoryCandidatesRemoved,
        cell_count: result.cellsRemoved,
      });
      emitSpeedKnowledgeChanged({ action: 'exclude_speed_section', ...result });
      return result;
    } catch (error) {
      logSpeedKnowledgeFailure('exclude_speed_section', error, { reason });
      throw error;
    }
  }

  async restoreExcludedSpeedSections(selector = null) {
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      const exclusions = Array.isArray(data.excludedSections) ? data.excludedSections : [];
      const matchesSelector = (record) => {
        if (selector == null) return true;
        if (typeof selector === 'object') return recordMatchesExcludedSection(record, selector);
        const key = String(selector || '');
        return correctionMatchesSelector(record, key) ||
          String(record.exclusionId || record.exclusionKey || '') === key;
      };
      const restoredSections = exclusions.filter(matchesSelector);
      const restoredCount = restoredSections.length;
      if (!restoredCount) return { restoredCount: 0 };
      const replayMarkersCleared = Object.keys(data.roadMemory?.processedTrips || {}).length;
      data.excludedSections = exclusions.filter((record) => !matchesSelector(record));
      if (data.roadMemory) data.roadMemory.processedTrips = {};
      await this._commit(data, previous, 'restore_excluded_speed_sections');
      recordSpeedKnowledgeEvent('restore_excluded_speed_sections', {
        restored_count: restoredCount,
        replay_marker_count: replayMarkersCleared,
      });
      emitSpeedKnowledgeChanged({
        action: 'restore_excluded_speed_sections',
        restoredCount,
        replayMarkersCleared,
      });
      return { restoredCount, replayMarkersCleared, restoredSections };
    } catch (error) {
      logSpeedKnowledgeFailure('restore_excluded_speed_sections', error);
      throw error;
    }
  }

  async reviewRoadMemoryCandidate(candidateId, {
    action = 'defer',
    limitKmh = null,
    effectiveFrom = null,
    effectiveFromDate = null,
    privacyZones = [],
  } = {}) {
    const id = String(candidateId || '');
    if (!id) return false;
    const data = await this._load();
    const candidate = (data.roadMemory?.candidates || []).find((item) => String(item?.id) === id);
    if (!candidate) return false;
    const beforeUsageById = new Map(
      decorateRoadMemoryCandidates(data.roadMemory?.candidates || []).candidates
        .map((item) => [String(item.id), item.canAffectScoreAndAlerts === true])
    );
    if (![
      'confirm_posted',
      'adjust_estimate',
      'keep_existing',
      'accept_time_profiles',
      'defer',
      'reject',
    ].includes(action)) return false;
    const reviewedAt = new Date().toISOString();

    if (action === 'confirm_posted' || action === 'adjust_estimate') {
      const nextLimit = Number(limitKmh) ||
        Number(candidate.changeDetection?.proposedLimitKmh) ||
        Number(candidate.limitKmh);
      if (!plausibleResolverLimit(nextLimit)) return false;
      const source = action === 'confirm_posted'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const changeEffectiveFrom = candidate.changeDetection?.status === 'possible_change'
        ? normalizedInstant(effectiveFrom || candidate.changeDetection?.detectedAt)
        : null;
      if (candidate.changeDetection?.status === 'possible_change' && !changeEffectiveFrom) return false;
      const note = action === 'confirm_posted'
        ? 'Confirmed from parked Road Memory review'
        : 'Adjusted from parked Road Memory review';
      const metadata = {
        roadName: candidate.roadName,
        contextLabel: roadMemoryConfidenceExplanation(candidate),
        directionLabel: candidate.directionLabel,
        timeLabel: candidate.timeLabel,
        distanceM: candidate.distanceM,
        directionMode: candidate.directionMode,
        directionBearing: candidate.directionBearing,
        sectionPoints: candidate.sectionPoints,
        provenance: 'road_memory_review',
        roadMemoryCandidateId: id,
        historyGroup: `road-memory-review-${id}`,
        ...(changeEffectiveFrom ? {
          validFrom: changeEffectiveFrom,
          validFromDate: normalizedDateOnly(effectiveFromDate) || calendarDateForInstant(changeEffectiveFrom),
        } : {}),
      };
      const existingCorrection = (data.corrections || [])
        .filter((correction) => !isHistoricalCorrectionVersion(correction))
        .map((correction) => ({
          correction,
          match: String(correction.roadMemoryCandidateId || '') === id
            ? { matched: true, matchDistanceM: 0 }
            : correctionMatchDetails(
              correction,
              candidate.lat,
              candidate.lng,
              ROAD_SECTION_MATCH_RADIUS_KM,
              { headingDeg: candidate.directionBearing }
            ),
        }))
        .filter((entry) => entry.match?.matched)
        .sort((a, b) => Number(a.match.matchDistanceM) - Number(b.match.matchDistanceM))[0]?.correction;
      const saved = existingCorrection && changeEffectiveFrom
        ? await this._updateUserCorrectionUnlocked(
          existingCorrection.id || existingCorrection.ruleId || existingCorrection.sectionKey || existingCorrection.geohash,
          nextLimit,
          source,
          note,
          metadata
        )
        : await this._saveUserCorrectionUnlocked(
          candidate.lat,
          candidate.lng,
          nextLimit,
          note,
          null,
          privacyZones,
          source,
          metadata
        );
      if (!saved) return false;
    }

    const refreshed = await this._load();
    const candidateIndex = (refreshed.roadMemory?.candidates || [])
      .findIndex((item) => String(item?.id) === id);
    if (candidateIndex < 0) return false;
    const current = refreshed.roadMemory.candidates[candidateIndex];
    const proposedLimitKmh = Math.round(Number(
      current.changeDetection?.status === 'possible_change'
        ? current.changeDetection?.proposedLimitKmh
        : current.limitKmh
    ));
    const reviewedLimitKmh = Number.isFinite(Number(limitKmh)) && Number(limitKmh) > 0
      ? Math.round(Number(limitKmh))
      : proposedLimitKmh;
    const reviewState = action === 'confirm_posted'
      ? 'confirmed'
      : action === 'adjust_estimate'
        ? 'adjusted'
        : action === 'keep_existing'
          ? 'kept_existing'
          : action === 'accept_time_profiles'
            ? 'time_profiles_accepted'
        : action === 'reject'
          ? 'rejected'
          : 'deferred';
    refreshed.roadMemory.candidates[candidateIndex] = {
      ...current,
      reviewState,
      reviewedAt,
      ...(reviewState === 'time_profiles_accepted'
        ? { timeProfilesAcceptedAt: reviewedAt }
        : {}),
      limitAtReviewKmh: proposedLimitKmh,
      reviewedLimitKmh: ['confirm_posted', 'adjust_estimate'].includes(action)
        ? reviewedLimitKmh
        : null,
      feedbackOutcome: action === 'confirm_posted'
        ? reviewedLimitKmh === proposedLimitKmh ? 'exact' : 'adjusted'
        : action === 'adjust_estimate'
          ? reviewedLimitKmh === proposedLimitKmh ? 'exact' : 'adjusted'
          : ['keep_existing', 'reject'].includes(action)
            ? 'rejected'
            : null,
      feedbackContext: ['confirm_posted', 'adjust_estimate', 'keep_existing', 'reject'].includes(action)
        ? {
          contextKey: roadMemoryContextKey(current),
          proposedLimitKmh,
          chosenLimitKmh: ['confirm_posted', 'adjust_estimate'].includes(action) ? reviewedLimitKmh : null,
          tripCount: Number(current.tripCount) || 0,
          agreement: Number(current.agreement) || 0,
          observedP85Kmh: Number(current.observedP85Kmh) || null,
        }
        : current.feedbackContext || null,
      lastPromptedTripCount: Number(current.tripCount) || 0,
      ...(reviewState === 'deferred' ? {} : {
        changeDetection: current.changeDetection?.status === 'possible_change'
          ? { ...current.changeDetection, resolvedAt: reviewedAt, status: 'resolved' }
          : current.changeDetection,
      }),
    };
    const nextModel = decorateRoadMemoryCandidates(refreshed.roadMemory.candidates);
    refreshed.roadMemory.candidates = nextModel.candidates.map((item) => ({
      ...item,
      intelligenceVersion: nextModel.calibration.version,
    }));
    const { feedback: _feedback, ...calibrationSummary } = nextModel.calibration;
    refreshed.roadMemory.intelligence = {
      ...calibrationSummary,
      updatedAt: reviewedAt,
    };
    const changedUsageCandidates = refreshed.roadMemory.candidates.filter((item) => (
      beforeUsageById.get(String(item.id)) !== (item.canAffectScoreAndAlerts === true)
    ));
    await this._write(refreshed, refreshed);
    emitSpeedKnowledgeChanged({
      action: 'road_memory_reviewed',
      candidateId: id,
      reviewState,
    });
    recordSpeedKnowledgeEvent('road_memory_reviewed', {
      review_state: reviewState,
    });
    return {
      candidate: refreshed.roadMemory.candidates.find((item) => String(item.id) === id),
      reviewState,
      changedUsageCandidates,
    };
  }

  async learnRoadMemoryFromTrips(trips = [], privacyZones = []) {
    try {
      const data = await this._load();
      data.roadMemory ??= { version: 3, candidates: [], processedTrips: {}, intelligence: null };
      data.roadMemory.version = 3;
      data.roadMemory.candidates = Array.isArray(data.roadMemory.candidates)
        ? data.roadMemory.candidates
        : [];
      data.roadMemory.processedTrips = data.roadMemory.processedTrips &&
        typeof data.roadMemory.processedTrips === 'object'
        ? data.roadMemory.processedTrips
        : {};

      let changed = false;
      let processedTripCount = 0;
      let observationCount = 0;
      const changedCandidateIds = new Set();

      const uncoveredCandidates = data.roadMemory.candidates.filter((candidate) => (
        !unresolvedCandidateCoveredByConfirmedCorrection(candidate, data.corrections)
      ));
      if (uncoveredCandidates.length !== data.roadMemory.candidates.length) {
        data.roadMemory.candidates = uncoveredCandidates;
        changed = true;
      }

      const refreshedModel = decorateRoadMemoryCandidates(data.roadMemory.candidates);
      data.roadMemory.candidates = refreshedModel.candidates.map((candidate, index) => {
        const previousCandidate = data.roadMemory.candidates[index] || {};
        if (
          previousCandidate.active !== candidate.active ||
          previousCandidate.stage !== candidate.stage ||
          previousCandidate.usageStage !== candidate.usageStage ||
          previousCandidate.stale !== candidate.stale
        ) {
          changed = true;
          changedCandidateIds.add(candidate.id);
        }
        return {
          ...candidate,
          contextLabel: candidate.confidenceExplanation || roadMemoryConfidenceExplanation(candidate),
        };
      });

      // Repository history is intentionally returned newest-first for the UI,
      // while change detection requires real chronological evidence. Always
      // normalize here so every caller gets the same deterministic learner.
      const activePrivacyZones = Array.isArray(privacyZones) && privacyZones.length
        ? privacyZones
        : getPrivacyZones();
      for (const trip of chronologicalTrips(trips)) {
        if (!trip || (trip.status && trip.status !== 'completed')) continue;
        const signature = roadMemoryTripSignature(trip);
        if (!signature || data.roadMemory.processedTrips[signature]) continue;
        const publicTrip = activePrivacyZones.length
          ? {
            ...trip,
            route_points: (trip.route_points || []).filter((point) => (
              Number.isFinite(Number(point?.lat)) &&
              Number.isFinite(Number(point?.lng)) &&
              !isInsidePrivacyZone(Number(point.lat), Number(point.lng), activePrivacyZones)
            )),
          }
          : trip;
        // Removing private points can leave two public endpoints whose straight
        // connection crosses the hidden zone. Do not learn that synthetic link.
        const observations = buildRoadMemoryObservations(publicTrip).filter((observation) => (
          !geometryTouchesPrivacyZones(observation.sectionPoints || [], activePrivacyZones) &&
          !candidateCoveredByConfirmedCorrection(observation, data.corrections) &&
          !(data.excludedSections || []).some((exclusion) => (
            recordMatchesExcludedSection(observation, exclusion)
          ))
        ));
        processedTripCount += 1;
        observationCount += observations.length;

        observations.forEach((observation, observationIndex) => {
          const matched = findRoadMemoryCandidateMatch(
            observation,
            data.roadMemory.candidates
          );
          const candidateId = matched?.id || createRoadMemoryCandidateId(observation, observationIndex);
          const merged = mergeRoadMemoryObservation(matched, observation, candidateId);
          merged.geohash = geohashEncode(merged.lat, merged.lng, CELL_PRECISION);
          if (matched) {
            const index = data.roadMemory.candidates.findIndex((candidate) => candidate.id === matched.id);
            if (index >= 0) data.roadMemory.candidates[index] = merged;
          } else {
            data.roadMemory.candidates.push(merged);
          }
          changedCandidateIds.add(candidateId);
          changed = true;
        });

        data.roadMemory.processedTrips[signature] = new Date().toISOString();
        changed = true;
      }

      if (!changed) {
        return {
          changed: false,
          processedTripCount: 0,
          observationCount: 0,
          changedCandidates: [],
        };
      }

      const consolidatedCandidates = consolidateRoadMemoryCandidates(data.roadMemory.candidates)
        .map((candidate) => ({
          ...candidate,
          ...roadMemoryCandidateOperationalState(candidate),
          contextLabel: roadMemoryConfidenceExplanation(candidate),
        }))
        .filter((candidate) => {
          const observedAt = new Date(candidate?.lastObservedAt || 0).getTime();
          return Number.isFinite(observedAt) &&
            Date.now() - observedAt <= ROAD_MEMORY_STALE_MS * 2 &&
            !unresolvedCandidateCoveredByConfirmedCorrection(candidate, data.corrections) &&
            !(data.excludedSections || []).some((exclusion) => (
              recordMatchesExcludedSection(candidate, exclusion)
            ));
        })
        .sort((a, b) => (
          new Date(b.lastObservedAt || 0).getTime() -
          new Date(a.lastObservedAt || 0).getTime()
        ))
        .slice(0, ROAD_MEMORY_MAX_CANDIDATES);
      const intelligenceModel = decorateRoadMemoryCandidates(consolidatedCandidates);
      data.roadMemory.candidates = intelligenceModel.candidates.map((candidate) => ({
        ...candidate,
        intelligenceVersion: intelligenceModel.calibration.version,
      }));
      const { feedback: _privateFeedback, ...calibrationSummary } = intelligenceModel.calibration;
      data.roadMemory.intelligence = {
        ...calibrationSummary,
        // Keep aggregate calibration only. Exact coordinates and raw trip traces
        // already live in their existing private records and are not duplicated.
        updatedAt: new Date().toISOString(),
      };
      data.roadMemory.processedTrips = Object.fromEntries(
        Object.entries(data.roadMemory.processedTrips)
          .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
          .slice(0, ROAD_MEMORY_MAX_PROCESSED_TRIPS)
      );
      await this._write(data, data);
      recordSpeedKnowledgeEvent('road_memory_learned', {
        processed_trip_count: processedTripCount,
        observation_count: observationCount,
        active_candidate_count: data.roadMemory.candidates.filter((candidate) => candidate.active).length,
        suggested_candidate_count: data.roadMemory.candidates.filter((candidate) => candidate.stage === 'suggested').length,
        change_review_count: data.roadMemory.candidates.filter((candidate) => candidate.stage === 'change_review').length,
      });
      emitSpeedKnowledgeChanged({
        action: 'road_memory_learned',
        processedTripCount,
        observationCount,
      });
      return {
        changed: true,
        processedTripCount,
        observationCount,
        changedCandidates: data.roadMemory.candidates.filter((candidate) => (
          changedCandidateIds.has(candidate.id)
        )),
      };
    } catch (error) {
      logSpeedKnowledgeFailure('road_memory_learned', error, {
        trip_count: Array.isArray(trips) ? trips.length : 0,
      });
      throw error;
    }
  }

  async learnFromTrip(confirmedPoints, privacyZones = [], options = {}) {
    try {
      const data = await this._load();
      data.cells ??= {};
      data.corrections ??= [];

      const evidenceId = String(
        options?.tripId ||
        options?.evidenceId ||
        `speed-evidence-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      );
      const observationsByCell = new Map();
      const newlyEligibleCellGeohashes = new Set();
      let cellChanged = false;
      const activePrivacyZones = Array.isArray(privacyZones) && privacyZones.length
        ? privacyZones
        : getPrivacyZones();

      // Only write to the learned cache from confirmed sources: OSM maxspeed tags
      // and explicit user-confirmed posted signs. Never learn from
      // region_default_estimate, inferred, or user_entered_estimate.
      for (const point of Array.isArray(confirmedPoints) ? confirmedPoints : []) {
        if (!CACHEABLE_SOURCES.has(pointSource(point))) continue;
        const lat = Number(point?.lat);
        const lng = Number(point?.lng);
        const limitKmh = Number(point?.limitKmh ?? point?.speed_limit_kmh);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !plausibleResolverLimit(limitKmh)) continue;
        if (isInsidePrivacyZone(lat, lng, activePrivacyZones)) continue;
        if (pointMatchesExcludedSection(data, lat, lng, lookupOptionsForPoint(point))) continue;

        const geohash = geohashEncode(lat, lng, CELL_PRECISION);
        // A coarse cell that overlaps a private zone still reveals that area
        // even when the sampled point itself is just outside the boundary.
        if (geohashOverlapsPrivacyZones(geohash, activePrivacyZones)) continue;
        const observations = observationsByCell.get(geohash) || [];
        observations.push({ ...point, lat, lng, limitKmh });
        observationsByCell.set(geohash, observations);
      }

      for (const [geohash, observations] of observationsByCell.entries()) {
        const limits = [...new Set(observations.map((point) => Math.round(Number(point.limitKmh))))];
        // A coarse legacy cell cannot safely represent two roads or speed zones.
        // Keep the trip as review evidence elsewhere instead of inventing one
        // cell-wide limit at an intersection or zone boundary.
        if (limits.length !== 1) continue;
        const limitKmh = limits[0];
        const point = observations[Math.floor(observations.length / 2)];
        const now = new Date().toISOString();
        const existing = data.cells[geohash];
        const wasEligible = speedKnowledgeCellEligibility(existing || {}).eligible;
        const existingEvidenceIds = Array.isArray(existing?.tripEvidenceIds)
          ? existing.tripEvidenceIds.map(String)
          : [];
        if (existingEvidenceIds.includes(evidenceId)) continue;
        const tripEvidenceIds = [...existingEvidenceIds, evidenceId].slice(-100);
        if (!existing) {
          const cell = {
            limitKmh,
            source: 'trip_consensus',
            confidence: 0.55,
            tripCount: 1,
            evidenceCount: 1,
            tripEvidenceIds,
            firstSeenAt: now,
            lastUpdatedAt: now,
            verifiedAt: now,
            verificationStatus: 'learned_from_confirmed_source',
            auditTrail: [auditEntry('learned', { limitKmh, pointSource: pointSource(point) })],
          };
          updateTimeOfDayBuckets(cell, point, limitKmh);
          data.cells[geohash] = cell;
        } else if (Number(existing.limitKmh) === limitKmh) {
          const n = (Number(existing.tripCount) || 0) + 1;
          const cell = {
            ...existing,
            tripCount: n,
            evidenceCount: n,
            tripEvidenceIds,
            confidence: Math.min(0.85, 0.50 + n * 0.035),
            lastUpdatedAt: now,
            verifiedAt: now,
            auditTrail: [
              ...(Array.isArray(existing.auditTrail) ? existing.auditTrail : []),
              auditEntry('evidence_added', { limitKmh, pointSource: pointSource(point) }),
            ].slice(-25),
          };
          updateTimeOfDayBuckets(cell, point, limitKmh);
          data.cells[geohash] = cell;
        } else {
          const conflictDelta = Math.abs(Number(existing.limitKmh) - limitKmh);
          const cell = {
            ...existing,
            confidence: Math.max(0.25, (Number(existing.confidence) || 0) - 0.12),
            lastUpdatedAt: now,
            tripCount: (Number(existing.tripCount) || 0) + 1,
            evidenceCount: (Number(existing.evidenceCount ?? existing.tripCount) || 1) + 1,
            tripEvidenceIds,
            auditTrail: [
              ...(Array.isArray(existing.auditTrail) ? existing.auditTrail : []),
              auditEntry('conflict_detected', {
                existingLimitKmh: Number(existing.limitKmh),
                observedLimitKmh: limitKmh,
                pointSource: pointSource(point),
              }),
            ].slice(-25),
          };
          updateTimeOfDayBuckets(cell, point, limitKmh);
          if (conflictDelta > 10) {
            cell.conflict = true;
            cell.conflictDetails = {
              existingLimitKmh: Number(existing.limitKmh),
              newLimitKmh: limitKmh,
              detectedAt: now,
            };
          }
          data.cells[geohash] = cell;
        }
        cellChanged = true;
        if (!wasEligible && speedKnowledgeCellEligibility(data.cells[geohash] || {}).eligible) {
          newlyEligibleCellGeohashes.add(geohash);
        }
      }

      if (!cellChanged) return { newlyEligibleCellGeohashes: [] };
      await this._write(data, data);
      if (newlyEligibleCellGeohashes.size) {
        void import('@/lib/localSpeedScoreRefresh')
          .then(({ refreshTripsCrossingLocalSpeedCell }) => Promise.all(
            [...newlyEligibleCellGeohashes].map((geohash) => (
              refreshTripsCrossingLocalSpeedCell(geohash).catch(() => null)
            ))
          ))
          .catch(() => null);
      }
      return {
        newlyEligibleCellGeohashes: [...newlyEligibleCellGeohashes],
      };
    } catch (error) {
      logSpeedKnowledgeFailure('learn_from_trip', error, {
        point_count: Array.isArray(confirmedPoints) ? confirmedPoints.length : 0,
      });
      throw error;
    }
  }

  async saveUserCorrection(lat, lng, limitKmh, note = '', expiresAt = null, privacyZones = [], source = 'user_entered_estimate', metadata = {}) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    const limit = Number(limitKmh);
    if (!isUsableCoordinate(latitude, longitude) || !plausibleResolverLimit(limit)) return false;
    if (
      (Object.prototype.hasOwnProperty.call(metadata, 'directionMode') &&
        !validExplicitDirectionMode(metadata.directionMode)) ||
      (Object.prototype.hasOwnProperty.call(metadata, 'qualifierStatus') &&
        !validExplicitQualifierStatus(metadata.qualifierStatus)) ||
      !validTimeRule(metadata.timeRule, { allowClockStrings: true })
    ) return false;
    const activePrivacyZones = Array.isArray(privacyZones) && privacyZones.length
      ? privacyZones
      : getPrivacyZones();
    const requestedSectionPoints = (Array.isArray(metadata.sectionPoints) ? metadata.sectionPoints : [])
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => isUsableCoordinate(point.lat, point.lng))
      .slice(0, 24);
    const resolvesConflictGeohash = String(metadata.resolvesConflictGeohash || '').trim();
    if (resolvesConflictGeohash && requestedSectionPoints.length < 2) return false;
    const validFrom = normalizedInstant(metadata.validFrom ?? metadata.valid_from);
    const normalizedExpiresAt = normalizedInstant(expiresAt ?? metadata.expiresAt);
    if (validFrom === undefined || normalizedExpiresAt === undefined) return false;
    if (
      validFrom &&
      normalizedExpiresAt &&
      new Date(validFrom).getTime() >= new Date(normalizedExpiresAt).getTime()
    ) return false;
    const geohash = geohashEncode(latitude, longitude, CELL_PRECISION);
    if (
      isInsidePrivacyZone(latitude, longitude, activePrivacyZones) ||
      geohashOverlapsPrivacyZones(geohash, activePrivacyZones) ||
      geometryTouchesPrivacyZones(requestedSectionPoints, activePrivacyZones)
    ) return false;

    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.cells ??= {};
      data.corrections ??= [];
      if (resolvesConflictGeohash && data.cells[resolvesConflictGeohash]?.conflict !== true) {
        return false;
      }
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const draftCorrection = {
        id: createCorrectionId(),
        geohash,
        lat: latitude,
        lng: longitude,
        coordinateSource: 'driven_route_sample',
        limitKmh: limit,
        note,
        source: correctionType,
        appliedAt: new Date().toISOString(),
        verifiedAt: correctionType === 'user_confirmed_posted_sign' ? new Date().toISOString() : null,
        verificationStatus: verificationStatus(correctionType),
        evidenceCount: 1,
        validFrom,
        validFromDate: validFrom
          ? normalizedDateOnly(metadata.validFromDate) || calendarDateForInstant(
            validFrom,
            metadata.validityUtcOffsetMinutes
          )
          : null,
        expiresAt: normalizedExpiresAt,
        expiresAtDate: normalizedExpiresAt
          ? normalizedDateOnly(metadata.expiresAtDate) || calendarDateForInstant(
            normalizedExpiresAt,
            metadata.validityUtcOffsetMinutes
          )
          : null,
        roadName: String(metadata.roadName || '').trim(),
        contextLabel: String(metadata.contextLabel || '').trim(),
        directionLabel: String(metadata.directionLabel || '').trim(),
        timeLabel: String(metadata.timeLabel || '').trim(),
        distanceM: Number(metadata.distanceM) || 0,
        directionMode: directionMode(metadata.directionMode),
        directionBearing: Number.isFinite(Number(metadata.directionBearing))
          ? ((Number(metadata.directionBearing) % 360) + 360) % 360
          : sectionBearing(Array.isArray(metadata.sectionPoints) ? metadata.sectionPoints : []),
        timeRule: normalizeTimeRule(metadata.timeRule),
        ...(metadata.qualifierStatus != null ? { qualifierStatus: metadata.qualifierStatus } : {}),
        provenance: String(metadata.provenance || '').trim() || null,
        roadMemoryCandidateId: String(metadata.roadMemoryCandidateId || '').trim() || null,
        sectionPoints: requestedSectionPoints,
        editHistory: [],
        auditTrail: [
          auditEntry('created', {
            limitKmh: limit,
            source: correctionType,
          }),
        ],
      };
      if (!correctionHasValidQualifierSemantics(draftCorrection)) return false;
      if ((data.excludedSections || []).some((exclusion) => (
        recordMatchesExcludedSection(draftCorrection, exclusion)
      ))) return false;
      const identity = correctionIdentity(draftCorrection);
      const previousCorrection = data.corrections.find((correction) => correctionIdentity(correction) === identity);
      const nextCorrection = {
        ...draftCorrection,
        id: previousCorrection?.id || previousCorrection?.ruleId || previousCorrection?.sectionKey || draftCorrection.id,
      };
      data.corrections = data.corrections.filter((correction) => correctionIdentity(correction) !== identity);
      data.corrections.push(nextCorrection);
      if (resolvesConflictGeohash) delete data.cells[resolvesConflictGeohash];
      const roadMemoryFeedback = metadata.provenance === 'road_memory_review'
        ? { changed: false, changedUsageCandidates: [] }
        : applyPostedCorrectionToRoadMemory(data, nextCorrection, 'saved_road_speed');
      const action = resolvesConflictGeohash ? 'resolve_conflict_as_correction' : 'save_correction';
      await this._commit(data, previous, action, metadata.historyGroup || null, {
        roadMemoryDecisionChanges: roadMemoryFeedback.decisionChanges,
      });
      recordSpeedKnowledgeEvent(action, { source: correctionType });
      emitSpeedKnowledgeChanged({
        action,
        geohash,
        correctionId: nextCorrection.id,
        source: correctionType,
        resolvedConflictGeohash: resolvesConflictGeohash || null,
      });
      refreshRoadMemoryUsageChanges(roadMemoryFeedback.changedUsageCandidates);
      return {
        ...userCorrectionView(nextCorrection),
        roadMemoryFeedbackRecorded: roadMemoryFeedback.changed,
        roadMemoryUsageChangeCount: roadMemoryFeedback.changedUsageCandidates.length,
      };
    } catch (error) {
      logSpeedKnowledgeFailure('save_correction', error, { source });
      throw error;
    }
  }

  async listUserCorrections() {
    try {
      const data = await this._load();
      return (data.corrections || [])
        .map(userCorrectionView)
        .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime());
    } catch (error) {
      logSpeedKnowledgeFailure('list_corrections', error);
      throw error;
    }
  }

  async updateUserCorrection(selector, limitKmh, source = 'user_entered_estimate', note = '', metadata = {}) {
    const limit = Number(limitKmh);
    const resolvesConflictGeohash = String(metadata.resolvesConflictGeohash || '').trim();
    const resolvesSavedConflict = metadata.conflictResolution &&
      typeof metadata.conflictResolution === 'object';
    if (!selector || !plausibleResolverLimit(limit)) return false;
    if (
      (metadata.directionMode != null && !validExplicitDirectionMode(metadata.directionMode)) ||
      (metadata.qualifierStatus != null && !validExplicitQualifierStatus(metadata.qualifierStatus)) ||
      !validTimeRule(metadata.timeRule, { allowClockStrings: true })
    ) return false;
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.cells ??= {};
      data.corrections ??= [];
      if (resolvesConflictGeohash && data.cells[resolvesConflictGeohash]?.conflict !== true) {
        return false;
      }
      const index = data.corrections.findIndex((correction) => correctionMatchesSelector(correction, selector));
      if (index < 0) return false;
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const previousCorrection = data.corrections[index];
      if (isHistoricalCorrectionVersion(previousCorrection) && metadata.allowHistoricalEdit !== true) {
        return false;
      }
      const validFromProvided = metadata.validFrom !== undefined || metadata.valid_from !== undefined;
      const expiresAtProvided = metadata.expiresAt !== undefined;
      const nextValidFrom = validFromProvided
        ? normalizedInstant(metadata.validFrom ?? metadata.valid_from)
        : previousCorrection.validFrom || null;
      const nextExpiresAt = metadata.expiresAt !== undefined
        ? normalizedInstant(metadata.expiresAt)
        : previousCorrection.expiresAt || null;
      if (nextValidFrom === undefined || nextExpiresAt === undefined) return false;
      if (
        nextValidFrom &&
        nextExpiresAt &&
        new Date(nextValidFrom).getTime() >= new Date(nextExpiresAt).getTime()
      ) return false;
      const previousLimit = Number(previousCorrection.limitKmh);
      const previousValidFrom = normalizedInstant(
        previousCorrection.validFrom ?? previousCorrection.valid_from
      );
      const previousIntervalStarted = previousValidFrom == null ||
        new Date(previousValidFrom).getTime() <= Date.now();
      const createsHistoricalVersion = metadata.preserveHistoricalVersion !== false &&
        previousIntervalStarted &&
        nextValidFrom &&
        nextValidFrom !== previousValidFrom;
      if (
        createsHistoricalVersion &&
        previousValidFrom &&
        new Date(nextValidFrom).getTime() <= new Date(previousValidFrom).getTime()
      ) return false;
      const metadataLat = Number(metadata.lat);
      const metadataLng = Number(metadata.lng);
      const hasMetadataCoordinate = isUsableCoordinate(metadataLat, metadataLng);
      const nextLat = hasMetadataCoordinate ? metadataLat : Number(previousCorrection.lat);
      const nextLng = hasMetadataCoordinate ? metadataLng : Number(previousCorrection.lng);
      const nextGeohash = hasMetadataCoordinate
        ? geohashEncode(metadataLat, metadataLng, CELL_PRECISION)
        : previousCorrection.geohash;
      const nextSectionPoints = (Array.isArray(metadata.sectionPoints)
        ? metadata.sectionPoints
        : previousCorrection.sectionPoints || [])
        .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
        .filter((point) => isUsableCoordinate(point.lat, point.lng))
        .slice(0, 24);
      // Any conflict decision can affect scoring and alerts, including dynamic
      // trip-vs-saved conflicts with no coarse cell to delete. Fail closed for
      // point-only/degenerate legacy rules until the road corridor is traced.
      if ((resolvesConflictGeohash || resolvesSavedConflict) &&
        !hasTracedSectionGeometry(nextSectionPoints)) return false;
      const activePrivacyZones = getPrivacyZones();
      if (
        (isUsableCoordinate(nextLat, nextLng) && isInsidePrivacyZone(nextLat, nextLng, activePrivacyZones)) ||
        geohashOverlapsPrivacyZones(nextGeohash, activePrivacyZones) ||
        (resolvesConflictGeohash && geohashOverlapsPrivacyZones(resolvesConflictGeohash, activePrivacyZones)) ||
        geometryTouchesPrivacyZones(nextSectionPoints, activePrivacyZones)
      ) return false;
      if ((data.excludedSections || []).some((exclusion) => recordMatchesExcludedSection({
        ...previousCorrection,
        geohash: nextGeohash,
        lat: nextLat,
        lng: nextLng,
        sectionPoints: nextSectionPoints,
      }, exclusion))) return false;
      const conflictResolution = resolvesSavedConflict
        ? {
          savedLimitKmh: Math.round(Number(metadata.conflictResolution.savedLimitKmh ?? limit)),
          observedLimitKmh: Math.round(Number(metadata.conflictResolution.observedLimitKmh)),
          deltaKmh: Math.round(Number(metadata.conflictResolution.deltaKmh)),
          action: metadata.conflictResolution.action || 'resolved',
          source: correctionType,
          note: String(metadata.conflictResolution.note || '').slice(0, 240),
          resolvedAt: new Date().toISOString(),
        }
        : undefined;
      const updatedCorrection = {
        ...previousCorrection,
        id: createsHistoricalVersion
          ? createCorrectionId()
          : previousCorrection.id || previousCorrection.ruleId || createCorrectionId(),
        limitKmh: limit,
        source: correctionType,
        note,
        appliedAt: new Date().toISOString(),
        verifiedAt: correctionType === 'user_confirmed_posted_sign'
          ? new Date().toISOString()
          : previousCorrection.verifiedAt || null,
        verificationStatus: verificationStatus(correctionType),
        evidenceCount: Math.max(1, Number(previousCorrection.evidenceCount) || 1) +
          Math.max(0, Number(metadata.evidenceIncrement) || 0),
        ...(conflictResolution ? { conflictResolution } : Number.isFinite(previousLimit) && Math.round(previousLimit) !== Math.round(limit) ? { conflictResolution: null } : {}),
        validFrom: nextValidFrom,
        validFromDate: nextValidFrom
          ? validFromProvided
            ? normalizedDateOnly(metadata.validFromDate) || calendarDateForInstant(
              nextValidFrom,
              metadata.validityUtcOffsetMinutes
            )
            : previousCorrection.validFromDate || calendarDateForInstant(nextValidFrom)
          : null,
        expiresAt: nextExpiresAt,
        expiresAtDate: nextExpiresAt
          ? expiresAtProvided
            ? normalizedDateOnly(metadata.expiresAtDate) || calendarDateForInstant(
              nextExpiresAt,
              metadata.validityUtcOffsetMinutes
            )
            : previousCorrection.expiresAtDate || calendarDateForInstant(nextExpiresAt)
          : null,
        ...(createsHistoricalVersion ? {
          historicalVersion: nextExpiresAt != null && new Date(nextExpiresAt).getTime() <= Date.now(),
          supersededAt: null,
          supersededByCorrectionId: null,
          supersedesCorrectionId: previousCorrection.id || previousCorrection.ruleId || null,
          versionRootId: previousCorrection.versionRootId || previousCorrection.id || previousCorrection.ruleId || null,
        } : {}),
        ...(hasMetadataCoordinate ? {
          geohash: nextGeohash,
          lat: metadataLat,
          lng: metadataLng,
        } : {}),
        ...(metadata.roadName != null ? { roadName: String(metadata.roadName).trim() } : {}),
        ...(metadata.directionMode != null ? { directionMode: directionMode(metadata.directionMode) } : {}),
        ...(metadata.directionBearing != null ? {
          directionBearing: Number.isFinite(Number(metadata.directionBearing))
            ? ((Number(metadata.directionBearing) % 360) + 360) % 360
            : previousCorrection.directionBearing,
        } : {}),
        ...(metadata.timeRule != null ? { timeRule: normalizeTimeRule(metadata.timeRule) } : {}),
        ...(metadata.qualifierStatus != null ? { qualifierStatus: metadata.qualifierStatus } : {}),
        editHistory: [
          ...(Array.isArray(previousCorrection.editHistory) ? previousCorrection.editHistory : []),
          {
            changedAt: new Date().toISOString(),
            previousLimitKmh: previousCorrection.limitKmh,
            previousSource: previousCorrection.source,
            previousNote: previousCorrection.note || '',
          },
        ].slice(-10),
        auditTrail: [
          ...(Array.isArray(previousCorrection.auditTrail) ? previousCorrection.auditTrail : []),
          auditEntry(conflictResolution ? 'conflict_resolution_saved' : 'updated', {
            previousLimitKmh: previousCorrection.limitKmh,
            nextLimitKmh: limit,
            previousSource: previousCorrection.source,
            nextSource: correctionType,
            conflictAction: conflictResolution?.action || null,
            observedLimitKmh: conflictResolution?.observedLimitKmh || null,
          }),
        ].slice(-25),
        ...(Array.isArray(metadata.sectionPoints) ? {
          sectionPoints: nextSectionPoints,
        } : {}),
      };
      if (!correctionHasValidQualifierSemantics(updatedCorrection)) return false;
      if (createsHistoricalVersion) {
        const priorExpiry = normalizedInstant(previousCorrection.expiresAt);
        const historicalExpiry = priorExpiry &&
          new Date(priorExpiry).getTime() < new Date(nextValidFrom).getTime()
          ? priorExpiry
          : nextValidFrom;
        data.corrections[index] = {
          ...previousCorrection,
          expiresAt: historicalExpiry,
          historicalVersion: true,
          supersededAt: new Date().toISOString(),
          supersededByCorrectionId: updatedCorrection.id,
          auditTrail: [
            ...(Array.isArray(previousCorrection.auditTrail) ? previousCorrection.auditTrail : []),
            auditEntry('superseded_by_effective_version', {
              nextCorrectionId: updatedCorrection.id,
              nextLimitKmh: limit,
              effectiveAt: nextValidFrom,
            }),
          ].slice(-25),
        };
        data.corrections.push(updatedCorrection);
      } else {
        data.corrections[index] = updatedCorrection;
      }
      if (resolvesConflictGeohash) delete data.cells[resolvesConflictGeohash];
      const roadMemoryFeedback = applyPostedCorrectionToRoadMemory(
        data,
        updatedCorrection,
        'updated_saved_road_speed'
      );
      const action = resolvesConflictGeohash || resolvesSavedConflict
        ? 'resolve_conflict_update'
        : 'update_correction';
      await this._commit(data, previous, action, metadata.historyGroup || null, {
        roadMemoryDecisionChanges: roadMemoryFeedback.decisionChanges,
      });
      recordSpeedKnowledgeEvent(action, { source: correctionType });
      emitSpeedKnowledgeChanged({
        action,
        geohash: previousCorrection.geohash,
        correctionId: updatedCorrection.id,
        source: correctionType,
        historicalVersionCreated: createsHistoricalVersion,
        resolvedConflictGeohash: resolvesConflictGeohash || null,
      });
      refreshRoadMemoryUsageChanges(roadMemoryFeedback.changedUsageCandidates);
      return true;
    } catch (error) {
      logSpeedKnowledgeFailure('update_correction', error, { source, has_selector: Boolean(selector) });
      throw error;
    }
  }

  async removeUserCorrection(selector, options = {}) {
    if (!selector) return false;
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.corrections ??= [];
      const before = data.corrections.length;
      const exactIdMatch = data.corrections.some((correction) => (
        correction.id === selector ||
        correction.ruleId === selector ||
        correction.sectionKey === selector ||
        correction.correctionId === selector
      ));
      data.corrections = data.corrections.filter((correction) => (
        exactIdMatch
          ? !correctionMatchesSelector(correction, selector)
          : correction.geohash !== selector
      ));
      if (data.corrections.length === before) return false;
      await this._commit(data, previous, 'remove_correction', options.historyGroup || null);
      recordSpeedKnowledgeEvent('remove_correction');
      emitSpeedKnowledgeChanged({ action: 'remove_correction', selector });
      return true;
    } catch (error) {
      logSpeedKnowledgeFailure('remove_correction', error, { has_selector: Boolean(selector) });
      throw error;
    }
  }

  async prune(maxAgeDays = 180) {
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.cells ??= {};
      data.corrections ??= [];
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let cellsRemoved = 0;
      for (const [geohash, cell] of Object.entries(data.cells)) {
        const updatedAt = new Date(cell?.lastUpdatedAt || 0).getTime();
        if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
          delete data.cells[geohash];
          cellsRemoved += 1;
        }
      }
      const correctionCountBefore = data.corrections.length;
      data.corrections = data.corrections.filter((correction) => (
        isFreshCorrection(correction) || isHistoricalCorrectionVersion(correction)
      ));
      const correctionsRemoved = correctionCountBefore - data.corrections.length;
      if (!cellsRemoved && !correctionsRemoved) {
        return { changed: false, cellsRemoved: 0, correctionsRemoved: 0 };
      }
      await this._commit(data, previous, 'prune');
      emitSpeedKnowledgeChanged({ action: 'prune', cellsRemoved, correctionsRemoved });
      return { changed: true, cellsRemoved, correctionsRemoved };
    } catch (error) {
      logSpeedKnowledgeFailure('prune', error, { max_age_days: maxAgeDays });
      throw error;
    }
  }

  async getConflictedCells() {
    const data = await this._load();
    return Object.entries(data.cells || {})
      .filter(([, cell]) => cell?.conflict === true)
      .map(([geohash, cell]) => ({ geohash, ...cell }));
  }

  async resolveConflict(geohash, confirmedLimitKmh, source = 'user_confirmed_posted_sign', note = '', metadata = {}) {
    const limitKmh = Number(confirmedLimitKmh);
    if (!geohash || !plausibleResolverLimit(limitKmh)) return false;
    if (geohashOverlapsPrivacyZones(geohash, getPrivacyZones())) return false;
    const sectionPoints = (Array.isArray(metadata.sectionPoints) ? metadata.sectionPoints : [])
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => isUsableCoordinate(point.lat, point.lng))
      .slice(0, 24);
    // A coarse geohash cannot identify a road reliably. Conflict review must
    // produce traced road geometry; otherwise the cell remains shadow-only.
    if (sectionPoints.length < 2) return false;
    const center = geohashCenter(geohash);
    const metadataLat = Number(metadata.lat);
    const metadataLng = Number(metadata.lng);
    const anchor = isUsableCoordinate(metadataLat, metadataLng)
      ? { lat: metadataLat, lng: metadataLng }
      : sectionPoints[Math.floor(sectionPoints.length / 2)] || center;
    try {
      return await this._saveUserCorrectionUnlocked(
        anchor.lat,
        anchor.lng,
        limitKmh,
        note,
        metadata.expiresAt ?? null,
        getPrivacyZones(),
        source,
        {
          ...metadata,
          sectionPoints,
          resolvesConflictGeohash: geohash,
          provenance: metadata.provenance || 'coarse_conflict_review',
        }
      );
    } catch (error) {
      logSpeedKnowledgeFailure('resolve_conflict', error, { source, has_geohash: Boolean(geohash) });
      throw error;
    }
  }

  _isExpired(cell) {
    return !speedKnowledgeCellEligibility(cell).eligible;
  }
}

// Every read/modify/write mutation is serialized per backing store, including
// across multiple LocalSpeedKnowledge instances in the same app runtime. Keep
// the original save implementation available to the compound Road Memory
// review transaction so it does not enqueue itself behind its own lock.
Object.defineProperty(LocalSpeedKnowledge.prototype, '_saveUserCorrectionUnlocked', {
  value: LocalSpeedKnowledge.prototype.saveUserCorrection,
});
Object.defineProperty(LocalSpeedKnowledge.prototype, '_updateUserCorrectionUnlocked', {
  value: LocalSpeedKnowledge.prototype.updateUserCorrection,
});

[
  'replaceData',
  'repairSavedSpeedData',
  'undo',
  'redo',
  'excludeSpeedSection',
  'restoreExcludedSpeedSections',
  'reviewRoadMemoryCandidate',
  'learnRoadMemoryFromTrips',
  'learnFromTrip',
  'saveUserCorrection',
  'updateUserCorrection',
  'removeUserCorrection',
  'prune',
  'resolveConflict',
].forEach((methodName) => {
  const implementation = LocalSpeedKnowledge.prototype[methodName];
  Object.defineProperty(LocalSpeedKnowledge.prototype, methodName, {
    configurable: true,
    writable: true,
    value(...args) {
      return this._runMutation(() => implementation.apply(this, args));
    },
  });
});
