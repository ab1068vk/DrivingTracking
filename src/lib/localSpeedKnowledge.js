import { isInsidePrivacyZone } from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import { SPEED_KNOWLEDGE_STORAGE_KEY } from '@/lib/speedKnowledgeRepository';

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

function geohashDecode(hash) {
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
    lat: (latitude[0] + latitude[1]) / 2,
    lng: (longitude[0] + longitude[1]) / 2,
  };
}

export function geohashCenter(hash) {
  return geohashDecode(hash);
}

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

function correctionActiveAt(correction = {}, timestampMs = null) {
  const rule = normalizeTimeRule(correction.timeRule);
  if (!rule.enabled) return true;
  if (timestampMs == null) return false;
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return false;
  if (!rule.days.includes(date.getDay())) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (rule.startMinutes === rule.endMinutes) return true;
  return rule.startMinutes < rule.endMinutes
    ? minutes >= rule.startMinutes && minutes <= rule.endMinutes
    : minutes >= rule.startMinutes || minutes <= rule.endMinutes;
}

export function correctionMatchesPoint(correction, lat, lng, radiusKm = ROAD_SECTION_MATCH_RADIUS_KM, options = {}) {
  if (!correctionActiveAt(correction, options.timestampMs ?? null)) return false;
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
  return geohashNeighboursInclude(correction?.geohash, lat, lng, LEGACY_CELL_MATCH_RADIUS_KM);
}

function correctionMatchDetails(correction, lat, lng, radiusKm = ROAD_SECTION_MATCH_RADIUS_KM, options = {}) {
  if (!correctionActiveAt(correction, options.timestampMs ?? null)) {
    return { matched: false, reason: 'time_rule_inactive' };
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
    };
  }

  const center = correction?.geohash ? geohashDecode(correction.geohash) : null;
  const distance = center ? distanceKm(center.lat, center.lng, Number(lat), Number(lng)) : Infinity;
  const matched = Number.isFinite(distance) && distance <= LEGACY_CELL_MATCH_RADIUS_KM;
  return {
    matched,
    reason: matched ? 'matched_geohash_cell' : 'too_far_from_geohash_cell',
    matchType: 'geohash_cell',
    matchDistanceM: Number.isFinite(distance) ? Math.round(distance * 1000) : null,
  };
}

export function geohashNeighboursInclude(geohash, lat, lng, radiusKm) {
  if (!geohash || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
  const center = geohashDecode(geohash);
  return distanceKm(center.lat, center.lng, Number(lat), Number(lng)) <= radiusKm;
}

function defaultData() {
  return { cells: {}, corrections: [], history: { undo: [], redo: [] } };
}

const cloneData = (data) => {
  if (typeof structuredClone === 'function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
};

const snapshotData = (data) => {
  const snapshot = cloneData(data || defaultData());
  delete snapshot.history;
  return snapshot;
};

const normalizeData = (data) => ({
  ...defaultData(),
  ...(data || {}),
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
  history: {
    undo: Array.isArray(data?.history?.undo) ? data.history.undo : [],
    redo: Array.isArray(data?.history?.redo) ? data.history.redo : [],
  },
});

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
  if (!correction?.expiresAt) return true;
  const expiresAt = new Date(correction.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
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

function lookupTimestampForPoint(point = {}) {
  return point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ?? null;
}

function lookupOptionsForPoint(point = {}) {
  return {
    headingDeg: point?.headingDeg ?? point?.heading ?? null,
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

export class LocalSpeedKnowledge {
  constructor(store) {
    this._store = store;
  }

  async _load() {
    return normalizeData((await this._store.get(STORAGE_KEY)) ?? defaultData());
  }

  async _commit(data, previous, action, historyGroup = null) {
    const history = normalizeData(data).history;
    const last = history.undo.at(-1);
    if (!historyGroup || last?.historyGroup !== historyGroup) {
      history.undo.push({
        action,
        changedAt: new Date().toISOString(),
        historyGroup,
        data: previous,
      });
      history.undo = history.undo.slice(-HISTORY_LIMIT);
    }
    history.redo = [];
    data.history = history;
    await this._store.set(STORAGE_KEY, data);
  }

  async exportData() {
    return snapshotData(await this._load());
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
        if (!isFreshCorrection(correction)) {
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
    restored.history.undo = current.history.undo;
    restored.history.redo = [
      ...current.history.redo,
      {
        action: entry.action,
        changedAt: new Date().toISOString(),
        data: snapshotData(current),
      },
    ].slice(-HISTORY_LIMIT);
    await this._store.set(STORAGE_KEY, restored);
    emitSpeedKnowledgeChanged({ action: 'undo', originalAction: entry.action });
    return true;
  }

  async redo() {
    const current = await this._load();
    const entry = current.history.redo.pop();
    if (!entry?.data) return false;
    const restored = normalizeData(entry.data);
    restored.history.undo = [
      ...current.history.undo,
      {
        action: entry.action,
        changedAt: new Date().toISOString(),
        data: snapshotData(current),
      },
    ].slice(-HISTORY_LIMIT);
    restored.history.redo = current.history.redo;
    await this._store.set(STORAGE_KEY, restored);
    emitSpeedKnowledgeChanged({ action: 'redo', originalAction: entry.action });
    return true;
  }

  _resolveForPoint(data, lat, lng, timestampMs = null, options = {}) {
    const correctionMatch = (data.corrections || [])
      .map((item) => ({
        correction: item,
        match: isFreshCorrection(item)
          ? correctionMatchDetails(item, lat, lng, ROAD_SECTION_MATCH_RADIUS_KM, {
            timestampMs,
            headingDeg: options.headingDeg ?? options.heading ?? null,
          })
          : { matched: false, reason: 'expired_rule' },
      }))
      .filter((item) => item.match.matched)
      .sort((a, b) => (
        correctionSpecificity(b.correction) - correctionSpecificity(a.correction) ||
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
        sectionPoints: (Array.isArray(correction.sectionPoints) ? correction.sectionPoints : [])
          .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
          .filter((point) => isUsableCoordinate(point.lat, point.lng)),
        conflictResolution: correction.conflictResolution || null,
      };
    }

    for (const precision of [CELL_PRECISION, FALLBACK_PRECISION]) {
      const geohash = geohashEncode(lat, lng, precision);
      const cell = data.cells?.[geohash];
      if (cell && !this._isExpired(cell)) return { ...applyBucketLimit(cell, timestampMs), geohash };
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
    const data = await this._load();
    return this._resolveForPoint(data, lat, lng, timestampMs, options);
  }

  async getForPoints(points = []) {
    const data = await this._load();
    return (Array.isArray(points) ? points : []).map((point) => this._resolveForPointOrSection(data, point));
  }

  async learnFromTrip(confirmedPoints, privacyZones = []) {
    try {
      const data = await this._load();
      data.cells ??= {};
      data.corrections ??= [];

      // Only write to the learned cache from confirmed sources: OSM maxspeed tags
      // and explicit user-confirmed posted signs. Never learn from
      // region_default_estimate, inferred, or user_entered_estimate.
      for (const point of Array.isArray(confirmedPoints) ? confirmedPoints : []) {
        if (!CACHEABLE_SOURCES.has(pointSource(point))) continue;
        const lat = Number(point?.lat);
        const lng = Number(point?.lng);
        const limitKmh = Number(point?.limitKmh ?? point?.speed_limit_kmh);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(limitKmh) || limitKmh <= 0) continue;
        if (isInsidePrivacyZone(lat, lng, privacyZones)) continue;

        const geohash = geohashEncode(lat, lng, CELL_PRECISION);
        const now = new Date().toISOString();
        const existing = data.cells[geohash];
        if (!existing) {
          const cell = {
            limitKmh,
            source: 'trip_consensus',
            confidence: 0.55,
            tripCount: 1,
            evidenceCount: 1,
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
            evidenceCount: (Number(existing.evidenceCount ?? existing.tripCount) || 1) + 1,
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
      }

      await this._store.set(STORAGE_KEY, data);
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
    if (!isUsableCoordinate(latitude, longitude) || !Number.isFinite(limit) || limit <= 0) return false;
    if (isInsidePrivacyZone(latitude, longitude, privacyZones)) return false;

    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.cells ??= {};
      data.corrections ??= [];
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const geohash = geohashEncode(latitude, longitude, CELL_PRECISION);
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
        expiresAt,
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
        sectionPoints: (Array.isArray(metadata.sectionPoints) ? metadata.sectionPoints : [])
          .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
          .filter((point) => isUsableCoordinate(point.lat, point.lng))
          .slice(0, 24),
        editHistory: [],
        auditTrail: [
          auditEntry('created', {
            limitKmh: limit,
            source: correctionType,
          }),
        ],
      };
      const identity = correctionIdentity(draftCorrection);
      const previousCorrection = data.corrections.find((correction) => correctionIdentity(correction) === identity);
      const nextCorrection = {
        ...draftCorrection,
        id: previousCorrection?.id || previousCorrection?.ruleId || previousCorrection?.sectionKey || draftCorrection.id,
      };
      data.corrections = data.corrections.filter((correction) => correctionIdentity(correction) !== identity);
      data.corrections.push(nextCorrection);
      await this._commit(data, previous, 'save_correction', metadata.historyGroup || null);
      recordSpeedKnowledgeEvent('save_correction', { source: correctionType });
      emitSpeedKnowledgeChanged({
        action: 'save_correction',
        geohash,
        correctionId: nextCorrection.id,
        source: correctionType,
      });
      return userCorrectionView(nextCorrection);
    } catch (error) {
      logSpeedKnowledgeFailure('save_correction', error, { source });
      throw error;
    }
  }

  async listUserCorrections() {
    try {
      const data = await this._load();
      return (data.corrections || [])
        .filter(isFreshCorrection)
        .map(userCorrectionView)
        .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime());
    } catch (error) {
      logSpeedKnowledgeFailure('list_corrections', error);
      throw error;
    }
  }

  async updateUserCorrection(selector, limitKmh, source = 'user_entered_estimate', note = '', metadata = {}) {
    const limit = Number(limitKmh);
    if (!selector || !Number.isFinite(limit) || limit <= 0) return false;
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.corrections ??= [];
      const index = data.corrections.findIndex((correction) => correctionMatchesSelector(correction, selector));
      if (index < 0) return false;
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const previousCorrection = data.corrections[index];
      const previousLimit = Number(previousCorrection.limitKmh);
      const metadataLat = Number(metadata.lat);
      const metadataLng = Number(metadata.lng);
      const hasMetadataCoordinate = isUsableCoordinate(metadataLat, metadataLng);
      const conflictResolution = metadata.conflictResolution && typeof metadata.conflictResolution === 'object'
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
      data.corrections[index] = {
        ...previousCorrection,
        id: previousCorrection.id || previousCorrection.ruleId || createCorrectionId(),
        limitKmh: limit,
        source: correctionType,
        note,
        appliedAt: new Date().toISOString(),
        verifiedAt: correctionType === 'user_confirmed_posted_sign'
          ? new Date().toISOString()
          : previousCorrection.verifiedAt || null,
        verificationStatus: verificationStatus(correctionType),
        evidenceCount: Math.max(1, Number(previousCorrection.evidenceCount) || 1),
        ...(conflictResolution ? { conflictResolution } : Number.isFinite(previousLimit) && Math.round(previousLimit) !== Math.round(limit) ? { conflictResolution: null } : {}),
        ...(metadata.expiresAt !== undefined ? { expiresAt: metadata.expiresAt || null } : {}),
        ...(hasMetadataCoordinate ? {
          geohash: geohashEncode(metadataLat, metadataLng, CELL_PRECISION),
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
          sectionPoints: metadata.sectionPoints
            .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
            .filter((point) => isUsableCoordinate(point.lat, point.lng))
            .slice(0, 24),
        } : {}),
      };
      await this._commit(data, previous, 'update_correction', metadata.historyGroup || null);
      recordSpeedKnowledgeEvent('update_correction', { source: correctionType });
      emitSpeedKnowledgeChanged({
        action: 'update_correction',
        geohash: previousCorrection.geohash,
        correctionId: data.corrections[index].id,
        source: correctionType,
      });
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
      for (const [geohash, cell] of Object.entries(data.cells)) {
        const updatedAt = new Date(cell?.lastUpdatedAt || 0).getTime();
        if (!Number.isFinite(updatedAt) || updatedAt < cutoff) delete data.cells[geohash];
      }
      data.corrections = data.corrections.filter(isFreshCorrection);
      await this._commit(data, previous, 'prune');
      emitSpeedKnowledgeChanged({ action: 'prune' });
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
    if (!geohash || !Number.isFinite(limitKmh) || limitKmh <= 0) return false;
    try {
      const data = await this._load();
      const previous = snapshotData(data);
      data.cells ??= {};
      const cell = data.cells[geohash];
      if (!cell) return false;
      const resolvedSource = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const resolvedAt = new Date().toISOString();
      data.cells[geohash] = {
        ...cell,
        limitKmh,
        source: resolvedSource,
        confidence: correctionConfidence(resolvedSource),
        conflict: false,
        conflictDetails: null,
        conflictResolvedAt: resolvedAt,
        conflictResolvedSource: resolvedSource,
        conflictResolvedNote: note || '',
        lastUpdatedAt: resolvedAt,
        verifiedAt: resolvedSource === 'user_confirmed_posted_sign' ? resolvedAt : cell.verifiedAt || null,
        verificationStatus: verificationStatus(resolvedSource),
        evidenceCount: Math.max(1, Number(cell.evidenceCount ?? cell.tripCount) || 1),
        auditTrail: [
          ...(Array.isArray(cell.auditTrail) ? cell.auditTrail : []),
          auditEntry('conflict_resolved', {
            previousLimitKmh: cell.limitKmh,
            nextLimitKmh: limitKmh,
            source: resolvedSource,
          }),
        ].slice(-25),
      };
      await this._commit(data, previous, 'resolve_conflict', metadata.historyGroup || null);
      recordSpeedKnowledgeEvent('resolve_conflict', { source: resolvedSource });
      emitSpeedKnowledgeChanged({ action: 'resolve_conflict', geohash, source: resolvedSource });
      return true;
    } catch (error) {
      logSpeedKnowledgeFailure('resolve_conflict', error, { source, has_geohash: Boolean(geohash) });
      throw error;
    }
  }

  _isExpired(cell) {
    if (Number(cell?.confidence) >= 0.7) return false;
    const updatedAt = new Date(cell?.lastUpdatedAt || 0).getTime();
    if (!Number.isFinite(updatedAt)) return true;
    return Date.now() - updatedAt > 90 * 86400000;
  }
}
