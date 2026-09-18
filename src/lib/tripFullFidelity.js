import {
  createNativeTripCommitWriter,
  iterateNativeTripJsonArray,
  nativeTripArchive,
} from '@/lib/nativeTripArchive';
import { calculateSegmentMetrics, inferSpeedZones, createZoneLookup } from '@/lib/tripEngine';
import { buildPhoneUseFromTripEvidenceStream } from '@/lib/phoneUsageAccess';

const SPEED_WINDOW_POINTS = 2048;
const SPEED_WINDOW_OVERLAP = 256;
const MAX_UI_STOPS = 1000;

const pointTime = (point) => {
  const value = new Date(point?.timestamp ?? point?.time ?? 0).getTime();
  return Number.isFinite(value) ? value : null;
};

const deterministicSplitId = async (tripId, revision, segment) => {
  const source = new TextEncoder().encode([
    String(tripId), Number(revision) || 0, segment.startIndex, segment.endIndex,
    segment.startTime, segment.endTime,
  ].join('|'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  source.fill(0);
  return `split_${Array.from(digest.subarray(0, 18)).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * First full-fidelity pass. It keeps fixed stop state and bounded speed
 * windows, never the complete route. Segment descriptors are the bounded
 * mutation result; route points remain exclusively in canonical chunks.
 */
export async function analyzeNativeTripFullFidelity(trip, { minParkMinutes = 5, thresholds = undefined } = {}) {
  const minStopMs = Math.max(0, Number(minParkMinutes) || 0) * 60_000;
  const maxStopSpeed = thresholds?.IDLE_SPEED_KMH ?? 5;
  const segments = [];
  const stops = [];
  const byZone = new Map();
  let speedBuffer = [];
  let pointIndex = 0;
  let segmentStart = 0;
  let segmentStartTime = null;
  let pointBeforeCandidate = null;
  let candidate = null;
  let previous = null;
  let fullRoutePointCount = 0;
  let maxBufferedPoints = 0;

  const processSpeedBuffer = (points, final = false) => {
    if (points.length < 2) return;
    const zones = inferSpeedZones(points, thresholds);
    const zoneForIndex = createZoneLookup(zones);
    const finalIndex = final ? points.length - 1 : Math.max(1, points.length - SPEED_WINDOW_OVERLAP);
    for (let index = 1; index <= finalIndex; index += 1) {
      const zone = zoneForIndex(index);
      if (!zone) continue;
      const metric = calculateSegmentMetrics(points[index - 1], points[index]);
      if (metric.dt <= 0 || metric.dt > 120 || metric.isNoise) continue;
      const current = byZone.get(zone.inferredZone) || {
        inferredZone: zone.inferredZone,
        inferredZoneKmh: zone.inferredZoneKmh,
        confidence: zone.confidence,
        distanceKm: 0,
      };
      current.distanceKm += metric.distanceKm;
      if (zone.confidence === 'high') current.confidence = 'high';
      else if (zone.confidence === 'medium' && current.confidence !== 'high') current.confidence = 'medium';
      byZone.set(zone.inferredZone, current);
    }
  };

  const closeSegmentBeforeCandidate = () => {
    const endIndex = candidate.startIndex - 1;
    if (endIndex - segmentStart + 1 >= 2 && pointBeforeCandidate) {
      segments.push({
        startIndex: segmentStart,
        endIndex,
        startTime: segmentStartTime,
        endTime: pointBeforeCandidate.timestamp,
      });
    }
  };

  for await (const point of iterateNativeTripJsonArray(trip.id, 'route_points')) {
    const timestamp = pointTime(point);
    if (segmentStartTime == null && timestamp != null) segmentStartTime = point.timestamp;
    const speed = Math.max(0, Number(point?.speed_kmh ?? point?.speedKmh) || 0);
    if (timestamp != null && speed <= maxStopSpeed) {
      if (!candidate) {
        candidate = {
          startIndex: pointIndex,
          startTime: point.timestamp,
          startMs: timestamp,
          startPoint: point,
          lastMs: timestamp,
          lastPoint: point,
        };
        pointBeforeCandidate = previous;
      } else {
        candidate.lastMs = timestamp;
        candidate.lastPoint = point;
      }
    } else if (candidate) {
      if (candidate.lastMs - candidate.startMs >= minStopMs) {
        closeSegmentBeforeCandidate();
        if (stops.length < MAX_UI_STOPS) {
          stops.push({
            lat: candidate.startPoint?.lat,
            lng: candidate.startPoint?.lng,
            start_time: candidate.startTime,
            end_time: candidate.lastPoint?.timestamp,
            duration_seconds: Math.round((candidate.lastMs - candidate.startMs) / 1000),
          });
        }
        segmentStart = pointIndex;
        segmentStartTime = point.timestamp;
      }
      candidate = null;
      pointBeforeCandidate = null;
    }

    speedBuffer.push(point);
    maxBufferedPoints = Math.max(maxBufferedPoints, speedBuffer.length);
    if (speedBuffer.length >= SPEED_WINDOW_POINTS) {
      processSpeedBuffer(speedBuffer, false);
      speedBuffer = speedBuffer.slice(-SPEED_WINDOW_OVERLAP);
    }
    previous = point;
    pointIndex += 1;
    fullRoutePointCount += 1;
  }

  if (candidate && candidate.lastMs - candidate.startMs >= minStopMs) {
    closeSegmentBeforeCandidate();
    if (stops.length < MAX_UI_STOPS) {
      stops.push({
        lat: candidate.startPoint?.lat,
        lng: candidate.startPoint?.lng,
        start_time: candidate.startTime,
        end_time: candidate.lastPoint?.timestamp,
        duration_seconds: Math.round((candidate.lastMs - candidate.startMs) / 1000),
      });
    }
    segmentStart = pointIndex;
  }
  if (pointIndex - segmentStart >= 2) {
    segments.push({
      startIndex: segmentStart,
      endIndex: pointIndex - 1,
      startTime: segmentStartTime,
      endTime: previous?.timestamp,
    });
  }
  processSpeedBuffer(speedBuffer, true);

  // Phone-use evidence consumes the complete canonical stream through a
  // separate bounded pass. Only the fixed native usage-session metadata and
  // one prior point are retained.
  const phoneUse = await analyzePhoneUseStream(trip);
  return {
    stops,
    stopsTruncated: stops.length >= MAX_UI_STOPS,
    splitSegments: segments,
    speedZoneSummary: [...byZone.values()].sort((a, b) => a.inferredZoneKmh - b.inferredZoneKmh),
    phoneUse,
    fullRoutePointCount,
    maximumBufferedPoints: Math.max(maxBufferedPoints, 2),
    routeSource: 'canonical_stream',
  };
}

async function analyzePhoneUseStream(trip) {
  return buildPhoneUseFromTripEvidenceStream(
    trip,
    iterateNativeTripJsonArray(trip.id, 'route_points'),
    trip.duration_seconds || 0,
    {}
  );
}

const CHILD_OVERRIDES = new Set([
  'id', 'route_points', 'route_overview_only', 'route_points_raw_count', 'start_time', 'end_time',
  'revision', 'canonical_seq', 'point_count', 'distance', 'duration',
  'distance_km', 'duration_seconds', 'driving_events', 'score_inputs',
  'phone_use_events', 'phone_use_window_count', 'phone_use_total_seconds',
  'phone_use_high_confidence_count', 'phone_use_risk', 'phone_use_score',
  'phone_use_score_available', 'phone_use_score_status', 'phone_use_pct_of_trip',
  'score_overall', 'score_safety',
  'score_smoothness', 'score_status', 'needs_rescore', 'split_parent_id',
  'split_segment_index', 'created_at', 'updated_at', 'status',
]);

const appendChildPrefix = async (writer) => writer.text('{"route_points":[');

const appendChildSuffix = async (writer, metadata) => {
  await writer.text(']');
  for (const key of Object.keys(metadata).sort()) {
    if (key === 'route_points') continue;
    await writer.text(',');
    await writer.value(key);
    await writer.text(':');
    await writer.value(metadata[key]);
  }
  await writer.text('}');
};

/**
 * Full-fidelity split with two streamed passes. Child IDs and payload metadata
 * are deterministic, so interruption before the source tombstone retries
 * idempotently and cannot create duplicate children.
 */
export async function splitNativeTripAtStopsStreamed(trip, {
  minParkMinutes = 5,
  analysis = null,
  faultAfterChildren = null,
} = {}) {
  if (trip?.route_overview_only !== true) throw new Error('STREAMED_SPLIT_REQUIRES_NATIVE_OVERVIEW');
  const full = analysis || await analyzeNativeTripFullFidelity(trip, { minParkMinutes });
  const ranges = full.splitSegments || [];
  if (ranges.length < 2) return [];
  const children = [];
  let rangeIndex = 0;
  let routeIndex = 0;
  let writer = null;
  let prior = null;
  let pointCount = 0;
  let distanceKm = 0;
  let first = true;
  let currentId = null;
  let maxWriterBufferBytes = 0;

  const finishRange = async (range) => {
    const stableCreated = trip.created_at || trip.start_time || range.startTime;
    const metadata = {};
    for (const [key, value] of Object.entries(trip)) {
      if (!CHILD_OVERRIDES.has(key)) metadata[key] = value;
    }
    Object.assign(metadata, {
      id: currentId,
      split_parent_id: trip.id,
      split_segment_index: rangeIndex + 1,
      status: 'completed',
      start_time: range.startTime,
      end_time: range.endTime,
      route_points_raw_count: pointCount,
      distance_km: distanceKm,
      duration_seconds: Math.max(0, Math.round((pointTime({ timestamp: range.endTime }) - pointTime({ timestamp: range.startTime })) / 1000)),
      score_overall: null,
      score_safety: null,
      score_smoothness: null,
      score_status: 'pending_rescore',
      needs_rescore: true,
      created_at: stableCreated,
      updated_at: trip.updated_at || trip.end_time || range.endTime,
    });
    await appendChildSuffix(writer, metadata);
    const committed = await writer.finish();
    if (committed?.verified !== true) throw new Error('SPLIT_CHILD_NOT_VERIFIED');
    maxWriterBufferBytes = Math.max(maxWriterBufferBytes, Number(committed.maximumBufferedBytes) || 0);
    children.push({ ...metadata, verified: true, payloadHash: committed.payloadHash });
    if (faultAfterChildren != null && children.length === faultAfterChildren) {
      throw new Error('TEST_SPLIT_INTERRUPTED');
    }
    writer = null;
  };

  try {
    for await (const point of iterateNativeTripJsonArray(trip.id, 'route_points')) {
      const range = ranges[rangeIndex];
      if (!range) break;
      if (routeIndex < range.startIndex) { routeIndex += 1; continue; }
      if (routeIndex > range.endIndex) {
        await finishRange(range);
        rangeIndex += 1;
        prior = null;
        pointCount = 0;
        distanceKm = 0;
        first = true;
      }
      const activeRange = ranges[rangeIndex];
      if (!activeRange) break;
      if (routeIndex >= activeRange.startIndex && routeIndex <= activeRange.endIndex) {
        if (!writer) {
          currentId = await deterministicSplitId(trip.id, trip.revision, activeRange);
          writer = await createNativeTripCommitWriter(currentId);
          await appendChildPrefix(writer);
        }
        if (!first) await writer.text(',');
        await writer.value(point);
        if (prior) {
          const metric = calculateSegmentMetrics(prior, point);
          if (metric.dt > 0 && metric.dt <= 120 && !metric.isNoise) distanceKm += metric.distanceKm;
        }
        prior = point;
        pointCount += 1;
        first = false;
      }
      routeIndex += 1;
    }
    if (writer && ranges[rangeIndex]) await finishRange(ranges[rangeIndex]);
    if (children.length !== ranges.length) throw new Error('SPLIT_CHILD_COUNT_MISMATCH');
    // The split commits bypass tripService.create/delete by design, so mark
    // forward-folded achievement/calibration state invalid before the source
    // can leave authority. If this durable write fails, the source remains.
    const { invalidateAchievementAggregates } = await import('@/lib/achievementAggregates');
    await invalidateAchievementAggregates('trip_split_replaced');
    const deleted = await nativeTripArchive.tombstone(trip.id, 'split_replaced', false);
    if (deleted?.deleted !== true) throw new Error('SPLIT_SOURCE_TOMBSTONE_FAILED');
    return { children, sourceDeleted: true, maximumBufferedPoints: full.maximumBufferedPoints, maxWriterBufferBytes };
  } catch (error) {
    if (writer) await writer.abort();
    throw error;
  }
}
