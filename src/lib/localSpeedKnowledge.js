import { isInsidePrivacyZone } from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

// CHANGES (session):
// - Added LocalSpeedKnowledge with geohash-backed local speed cache, user corrections, pruning, and privacy-zone guards.
// - Added geohashEncode and geohashNeighboursInclude helpers for cache lookup and tests.
// - Updated getForPoint so user corrections take priority over learned cells.
// - Added time-of-day bucket learning and bucket-aware speed lookup.
// - Added conflict detection, conflicted-cell listing, and user-confirmed conflict resolution.
// - Split user corrections into confirmed posted signs and user-entered estimates.
// - Restricted learned-cache writes to OSM maxspeed and user-confirmed posted sign sources.

export const STORAGE_KEY = 'speed_knowledge_v1';
export const SPEED_KNOWLEDGE_CHANGED_EVENT = 'speed-knowledge-changed';
export const CELL_PRECISION = 6;
export const FALLBACK_PRECISION = 5;
const CACHEABLE_SOURCES = new Set(['openstreetmap', 'user_confirmed_posted_sign']);

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

export function geohashNeighboursInclude(geohash, lat, lng, radiusKm) {
  if (!geohash || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
  const center = geohashDecode(geohash);
  return distanceKm(center.lat, center.lng, Number(lat), Number(lng)) <= radiusKm;
}

function defaultData() {
  return { cells: {}, corrections: [] };
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

function pointSource(point) {
  return point?.source ?? point?.speed_limit_source ?? point?.limitSource ?? null;
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
  const baseLimit = Number(cell?.limitKmh);
  if (!Number.isFinite(bucketLimit) || !Number.isFinite(baseLimit)) return cell;
  if (baseLimit - bucketLimit <= 10) return cell;
  return {
    ...cell,
    limitKmh: Math.max(5, Math.round(bucketLimit)),
    source: 'time_of_day_bucket',
    timeOfDayBucket: bucket,
    baseLimitKmh: baseLimit,
  };
}

export class LocalSpeedKnowledge {
  constructor(store) {
    this._store = store;
  }

  async _load() {
    return (await this._store.get(STORAGE_KEY)) ?? defaultData();
  }

  async getForPoint(lat, lng, timestampMs = null) {
    const data = await this._load();
    const correction = (data.corrections || [])
      .filter((item) => (
        isFreshCorrection(item) &&
        geohashNeighboursInclude(item.geohash, lat, lng, 0.8)
      ))
      .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime())[0];
    if (correction) {
      const source = correctionSource(correction);
      return {
        limitKmh: correction.limitKmh,
        source,
        confidence: correctionConfidence(source),
      };
    }

    for (const precision of [CELL_PRECISION, FALLBACK_PRECISION]) {
      const geohash = geohashEncode(lat, lng, precision);
      const cell = data.cells?.[geohash];
      if (cell && !this._isExpired(cell)) return { ...applyBucketLimit(cell, timestampMs), geohash };
    }

    return null;
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
            firstSeenAt: now,
            lastUpdatedAt: now,
          };
          updateTimeOfDayBuckets(cell, point, limitKmh);
          data.cells[geohash] = cell;
        } else if (Number(existing.limitKmh) === limitKmh) {
          const n = (Number(existing.tripCount) || 0) + 1;
          const cell = {
            ...existing,
            tripCount: n,
            confidence: Math.min(0.85, 0.50 + n * 0.035),
            lastUpdatedAt: now,
          };
          updateTimeOfDayBuckets(cell, point, limitKmh);
          data.cells[geohash] = cell;
        } else {
          const conflictDelta = Math.abs(Number(existing.limitKmh) - limitKmh);
          const cell = {
            ...existing,
            confidence: Math.max(0.25, (Number(existing.confidence) || 0) - 0.12),
            lastUpdatedAt: now,
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

  async saveUserCorrection(lat, lng, limitKmh, note = '', expiresAt = null, privacyZones = [], source = 'user_entered_estimate') {
    const latitude = Number(lat);
    const longitude = Number(lng);
    const limit = Number(limitKmh);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(limit) || limit <= 0) return false;
    if (isInsidePrivacyZone(latitude, longitude, privacyZones)) return false;

    try {
      const data = await this._load();
      data.cells ??= {};
      data.corrections ??= [];
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      const geohash = geohashEncode(latitude, longitude, CELL_PRECISION);
      data.corrections = data.corrections.filter((correction) => correction?.geohash !== geohash);
      data.corrections.push({
        geohash,
        lat: latitude,
        lng: longitude,
        coordinateSource: 'driven_route_sample',
        limitKmh: limit,
        note,
        source: correctionType,
        appliedAt: new Date().toISOString(),
        expiresAt,
      });
      await this._store.set(STORAGE_KEY, data);
      recordSpeedKnowledgeEvent('save_correction', { source: correctionType });
      emitSpeedKnowledgeChanged({ action: 'save_correction', geohash, source: correctionType });
      return true;
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
        .map((correction) => {
          const center = geohashCenter(correction.geohash);
          const source = correctionSource(correction);
          const savedLat = Number(correction.lat);
          const savedLng = Number(correction.lng);
          const hasSavedCoordinate = Number.isFinite(savedLat) && Number.isFinite(savedLng);
          return {
            ...correction,
            lat: hasSavedCoordinate ? savedLat : center.lat,
            lng: hasSavedCoordinate ? savedLng : center.lng,
            coordinateSource: hasSavedCoordinate
              ? (correction.coordinateSource || 'driven_route_sample')
              : 'geohash_cell_center_legacy',
            source,
            confidence: correctionConfidence(source),
          };
        })
        .sort((a, b) => new Date(b.appliedAt || 0).getTime() - new Date(a.appliedAt || 0).getTime());
    } catch (error) {
      logSpeedKnowledgeFailure('list_corrections', error);
      throw error;
    }
  }

  async updateUserCorrection(geohash, limitKmh, source = 'user_entered_estimate', note = '') {
    const limit = Number(limitKmh);
    if (!geohash || !Number.isFinite(limit) || limit <= 0) return false;
    try {
      const data = await this._load();
      data.corrections ??= [];
      const index = data.corrections.findIndex((correction) => correction?.geohash === geohash);
      if (index < 0) return false;
      const correctionType = source === 'user_confirmed_posted_sign'
        ? 'user_confirmed_posted_sign'
        : 'user_entered_estimate';
      data.corrections[index] = {
        ...data.corrections[index],
        limitKmh: limit,
        source: correctionType,
        note,
        appliedAt: new Date().toISOString(),
      };
      await this._store.set(STORAGE_KEY, data);
      recordSpeedKnowledgeEvent('update_correction', { source: correctionType });
      emitSpeedKnowledgeChanged({ action: 'update_correction', geohash, source: correctionType });
      return true;
    } catch (error) {
      logSpeedKnowledgeFailure('update_correction', error, { source, has_geohash: Boolean(geohash) });
      throw error;
    }
  }

  async removeUserCorrection(geohash) {
    if (!geohash) return false;
    try {
      const data = await this._load();
      data.corrections ??= [];
      const before = data.corrections.length;
      data.corrections = data.corrections.filter((correction) => correction?.geohash !== geohash);
      if (data.corrections.length === before) return false;
      await this._store.set(STORAGE_KEY, data);
      recordSpeedKnowledgeEvent('remove_correction');
      emitSpeedKnowledgeChanged({ action: 'remove_correction', geohash });
      return true;
    } catch (error) {
      logSpeedKnowledgeFailure('remove_correction', error, { has_geohash: Boolean(geohash) });
      throw error;
    }
  }

  async prune(maxAgeDays = 180) {
    try {
      const data = await this._load();
      data.cells ??= {};
      data.corrections ??= [];
      const cutoff = Date.now() - maxAgeDays * 86400000;
      for (const [geohash, cell] of Object.entries(data.cells)) {
        const updatedAt = new Date(cell?.lastUpdatedAt || 0).getTime();
        if (!Number.isFinite(updatedAt) || updatedAt < cutoff) delete data.cells[geohash];
      }
      data.corrections = data.corrections.filter(isFreshCorrection);
      await this._store.set(STORAGE_KEY, data);
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

  async resolveConflict(geohash, confirmedLimitKmh, source = 'user_confirmed_posted_sign', note = '') {
    const limitKmh = Number(confirmedLimitKmh);
    if (!geohash || !Number.isFinite(limitKmh) || limitKmh <= 0) return false;
    try {
      const data = await this._load();
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
      };
      await this._store.set(STORAGE_KEY, data);
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
