import {
  boundsOverlapPrivacyZone,
  isPointInPrivacyZone,
  routeTouchesPrivacyZone,
} from '@/lib/privacyZones';
import { geohashBounds } from '@/lib/localSpeedKnowledge';
import {
  SPEED_KNOWLEDGE_STORAGE_KEY,
  speedKnowledgeStore,
} from '@/lib/speedKnowledgeRepository';
import { recordSystemEvent } from '@/lib/systemLog';

const usableCoordinate = (point = {}) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
};

const cleanPoints = (value = {}) => {
  const sectionPoints = (Array.isArray(value?.sectionPoints) ? value.sectionPoints : [])
    .filter(usableCoordinate)
    .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  if (sectionPoints.length) return sectionPoints;
  return usableCoordinate(value)
    ? [{ lat: Number(value.lat), lng: Number(value.lng) }]
    : [];
};

const geohashTouchesZones = (geohash, zones) => {
  if (!geohash) return false;
  try {
    return boundsOverlapPrivacyZone(geohashBounds(String(geohash)), zones);
  } catch {
    // Malformed legacy hashes are ignored here and remain available for the
    // regular repair tool instead of making a privacy cleanup fail halfway.
    return false;
  }
};

export function speedKnowledgeRecordTouchesPrivacyZones(record = {}, zones = []) {
  if (!Array.isArray(zones) || !zones.length) return false;
  const points = cleanPoints(record);
  if (points.some((point) => Boolean(isPointInPrivacyZone(point, zones)))) return true;
  if (points.length >= 2 && zones.some((zone) => routeTouchesPrivacyZone(points, zone))) return true;
  return geohashTouchesZones(record?.geohash, zones);
}

const countHistorySnapshots = (history = {}) => (
  (Array.isArray(history?.undo) ? history.undo.length : 0) +
  (Array.isArray(history?.redo) ? history.redo.length : 0)
);

/**
 * Removes derived road-location knowledge that intersects a privacy zone.
 * The function is pure so storage callers can run it inside one atomic
 * read/modify/write transaction.
 */
export function purgeSpeedKnowledgeDataForPrivacyZones(value = {}, zones = []) {
  const source = value && typeof value === 'object' ? value : {};
  const activeZones = Array.isArray(zones) ? zones.filter(Boolean) : [];
  if (!activeZones.length) {
    return {
      data: source,
      result: {
        changed: false,
        cellsPurged: 0,
        correctionsPurged: 0,
        roadMemoryCandidatesPurged: 0,
        exclusionsPurged: 0,
        processedTripMarkersPurged: 0,
        historySnapshotsPurged: 0,
        totalRecordsPurged: 0,
      },
    };
  }

  const cells = source.cells && typeof source.cells === 'object' ? source.cells : {};
  const nextCells = Object.fromEntries(Object.entries(cells).filter(([geohash]) => (
    !geohashTouchesZones(geohash, activeZones)
  )));
  const corrections = Array.isArray(source.corrections) ? source.corrections : [];
  const nextCorrections = corrections.filter((record) => (
    !speedKnowledgeRecordTouchesPrivacyZones(record, activeZones)
  ));
  const candidates = Array.isArray(source.roadMemory?.candidates)
    ? source.roadMemory.candidates
    : [];
  const nextCandidates = candidates.filter((record) => (
    !speedKnowledgeRecordTouchesPrivacyZones(record, activeZones)
  ));
  const exclusions = Array.isArray(source.excludedSections) ? source.excludedSections : [];
  const nextExclusions = exclusions.filter((record) => (
    !speedKnowledgeRecordTouchesPrivacyZones(record, activeZones)
  ));
  const processedTrips = source.roadMemory?.processedTrips &&
    typeof source.roadMemory.processedTrips === 'object'
    ? source.roadMemory.processedTrips
    : {};

  const result = {
    cellsPurged: Object.keys(cells).length - Object.keys(nextCells).length,
    correctionsPurged: corrections.length - nextCorrections.length,
    roadMemoryCandidatesPurged: candidates.length - nextCandidates.length,
    exclusionsPurged: exclusions.length - nextExclusions.length,
    // Clear replay markers whenever protection changes. Candidate trip-votes
    // de-duplicate a later replay, while the fresh replay can no longer rebuild
    // observations through the newly private area.
    processedTripMarkersPurged: Object.keys(processedTrips).length,
    historySnapshotsPurged: countHistorySnapshots(source.history),
  };
  result.totalRecordsPurged = result.cellsPurged + result.correctionsPurged +
    result.roadMemoryCandidatesPurged + result.exclusionsPurged +
    result.processedTripMarkersPurged + result.historySnapshotsPurged;
  result.changed = result.totalRecordsPurged > 0;

  if (!result.changed) return { data: source, result };

  return {
    data: {
      ...source,
      cells: nextCells,
      corrections: nextCorrections,
      excludedSections: nextExclusions,
      roadMemory: {
        ...(source.roadMemory || {}),
        candidates: nextCandidates,
        processedTrips: {},
        // Calibration is derived from candidate feedback. Rebuild it from the
        // remaining public candidates instead of retaining aggregates that may
        // include a removed private corridor.
        intelligence: null,
      },
      // Undo/redo snapshots can contain the exact coordinates just removed.
      history: { undo: [], redo: [] },
    },
    result,
  };
}

export async function purgeLocalSpeedKnowledgeForPrivacyZones(zones = []) {
  if (Array.isArray(zones) && zones.length) {
    const { clearSpeedGeometryIndex } = await import('@/lib/speedGeometryIndex');
    await clearSpeedGeometryIndex('privacy_zone_changed');
    if (typeof window !== 'undefined') {
      // Legacy presentation caches can contain geohashes or rounded section
      // identities. They are convenience-only and must not outlive a new zone.
      window.localStorage.removeItem('roadsage_excluded_speed_sections_v1');
      window.localStorage.removeItem('roadsage_ignored_unset_speed_sections_v1');
      window.localStorage.removeItem('roadsage_ignored_trip_speed_review_sections_v1');
    }
  }
  let cleanupResult = null;
  const stored = await speedKnowledgeStore.update(
    SPEED_KNOWLEDGE_STORAGE_KEY,
    (current) => {
      const cleanup = purgeSpeedKnowledgeDataForPrivacyZones(current, zones);
      cleanupResult = cleanup.result;
      return cleanup.result.changed ? cleanup.data : undefined;
    }
  );
  const result = {
    ...(cleanupResult || {
      changed: false,
      cellsPurged: 0,
      correctionsPurged: 0,
      roadMemoryCandidatesPurged: 0,
      exclusionsPurged: 0,
      processedTripMarkersPurged: 0,
      historySnapshotsPurged: 0,
      totalRecordsPurged: 0,
    }),
    knowledgeRevision: Number(stored?.knowledgeRevision) || 0,
  };

  if (result.changed) {
    recordSystemEvent('speed_knowledge_privacy_purged', {
      zone_count: Array.isArray(zones) ? zones.length : 0,
      cell_count: result.cellsPurged,
      correction_count: result.correctionsPurged,
      road_memory_candidate_count: result.roadMemoryCandidatesPurged,
      exclusion_count: result.exclusionsPurged,
      history_snapshot_count: result.historySnapshotsPurged,
      knowledge_revision: result.knowledgeRevision,
    }, { category: 'privacy', title: 'Private saved-road knowledge erased' });
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('speed-knowledge-changed', {
        detail: { action: 'privacy_zone_cleanup', ...result },
      }));
    }
  }

  return result;
}
