import { haversineDistance } from '@/lib/tripEngine';
import {
  buildPlaybackTimeline,
  buildRouteComparison,
  prepareMapRoutePoints,
  pointTimeMs,
} from '@/lib/mapPlaybackInsights';
import { maskRoutePointsForPrivacy, maskEventsForPrivacy } from '@/lib/privacyZones';

const REPLAYABLE_POINT_MIN = 2;
const SIMILAR_ENDPOINT_METERS = 350;
const SIMILAR_DISTANCE_RATIO = 0.35;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validPoint = (point = {}) => (
  finiteNumber(point.lat) != null && finiteNumber(point.lng) != null
);

const validRoutePoints = (trip = {}) => (
  Array.isArray(trip?.route_points) ? trip.route_points.filter(validPoint) : []
);

const pointPrivacyMasked = (point = {}) => (
  point.masked_for_privacy === true ||
  point.privacy_gap === true ||
  point.privacy_boundary === true ||
  point.privacy_live_redacted === true ||
  point.privacy_purged === true ||
  point.lat == null ||
  point.lng == null
);

const formatDurationLabel = (seconds = 0) => {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(value / 60);
  const secs = value % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
};

const titleCase = (value) => String(value || 'event')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export function isReplayTripAvailable(trip = {}) {
  return trip?.privacy_mode !== 'summary_only' &&
    !trip?.route_data_expired_at &&
    validRoutePoints(trip).length >= REPLAYABLE_POINT_MIN;
}

export function replayUnavailableReason(trip = {}) {
  if (!trip) return 'Trip unavailable.';
  if (trip.privacy_mode === 'summary_only') return 'This private trip saved summary data only.';
  if (trip.route_data_expired_at) return 'Route coordinates for this trip have expired.';
  return 'This trip does not have enough retained route points.';
}

export function buildReplayTripOptions(trips = []) {
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed' || trip?.status == null)
    .map((trip) => ({
      id: String(trip.id || ''),
      label: trip.nickname || trip.tag || trip.id || 'Completed trip',
      startTime: trip.start_time || null,
      distanceKm: finiteNumber(trip.distance_km),
      routePointCount: validRoutePoints(trip).length,
      available: isReplayTripAvailable(trip),
      unavailableReason: isReplayTripAvailable(trip) ? '' : replayUnavailableReason(trip),
    }))
    .sort((a, b) => new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime());
}

export function compareRouteSimilarity(primaryTrip = {}, secondaryTrip = {}) {
  const primary = validRoutePoints(primaryTrip);
  const secondary = validRoutePoints(secondaryTrip);
  if (primary.length < 2 || secondary.length < 2) {
    return { status: 'unavailable', label: 'Route similarity unavailable', startDeltaM: null, endDeltaM: null, distanceDeltaPct: null };
  }
  const startDeltaM = haversineDistance(primary[0].lat, primary[0].lng, secondary[0].lat, secondary[0].lng) * 1000;
  const primaryEnd = primary[primary.length - 1];
  const secondaryEnd = secondary[secondary.length - 1];
  const endDeltaM = haversineDistance(primaryEnd.lat, primaryEnd.lng, secondaryEnd.lat, secondaryEnd.lng) * 1000;
  const primaryDistance = finiteNumber(primaryTrip.distance_km);
  const secondaryDistance = finiteNumber(secondaryTrip.distance_km);
  const distanceDeltaPct = primaryDistance && secondaryDistance
    ? Math.abs(primaryDistance - secondaryDistance) / Math.max(primaryDistance, secondaryDistance)
    : null;
  const endpointMatch = startDeltaM <= SIMILAR_ENDPOINT_METERS && endDeltaM <= SIMILAR_ENDPOINT_METERS;
  const distanceMatch = distanceDeltaPct == null || distanceDeltaPct <= SIMILAR_DISTANCE_RATIO;
  const status = endpointMatch && distanceMatch ? 'similar' : 'different';
  return {
    status,
    label: status === 'similar' ? 'Same or similar route' : 'Route geometry differs',
    startDeltaM: Math.round(startDeltaM),
    endDeltaM: Math.round(endDeltaM),
    distanceDeltaPct: distanceDeltaPct == null ? null : Math.round(distanceDeltaPct * 100),
  };
}

function gapRows(points = [], tripId = '') {
  const rows = [];
  points.forEach((point, index) => {
    if (index === 0) return;
    const previous = points[index - 1];
    const previousMs = pointTimeMs(previous);
    const currentMs = pointTimeMs(point);
    const deltaSeconds = previousMs != null && currentMs != null && currentMs > previousMs
      ? Math.round((currentMs - previousMs) / 1000)
      : null;
    if (point.tracking_gap === true || point.route_gap === true || (deltaSeconds != null && deltaSeconds > 120)) {
      rows.push({
        id: `${tripId || 'trip'}-gap-${index}`,
        tripId,
        index,
        timestamp: point.timestamp || point.time || null,
        seconds: deltaSeconds,
        label: deltaSeconds == null ? 'Route gap recorded' : `${deltaSeconds}s route gap`,
      });
    }
  });
  return rows;
}

function speedLimitSourceChanges(timeline = {}, tripId = '') {
  const rows = [];
  (timeline.segments || []).forEach((segment, index, list) => {
    const previous = list[index - 1];
    if (index === 0 || segment.speedLimitSource !== previous?.speedLimitSource || segment.speedLimitKmh !== previous?.speedLimitKmh) {
      rows.push({
        id: `${tripId || 'trip'}-limit-${index}`,
        tripId,
        offsetSeconds: Math.round(segment.startOffsetSeconds || 0),
        limitKmh: segment.speedLimitKmh ?? null,
        source: segment.speedLimitSource || 'source unavailable',
      });
    }
  });
  return rows;
}

function playbackModeRows(timeline = {}, mode = 'real_time') {
  const segments = timeline.segments || [];
  if (mode === 'event_to_event') {
    const events = timeline.events || [];
    if (!events.length) return [];
    return events.map((event, index) => ({
      id: `event-mode-${index}`,
      label: titleCase(event.type),
      start: formatDurationLabel(event.offsetSeconds || 0),
      end: events[index + 1] ? formatDurationLabel(events[index + 1].offsetSeconds || 0) : 'route end',
      detail: 'event-to-event playback segment',
    }));
  }
  if (mode === 'normalized') {
    return segments.slice(0, 16).map((segment, index) => ({
      id: `normalized-${index}`,
      label: `${Math.round(segment.timeProgressStart || segment.progressStart || 0)}-${Math.round(segment.timeProgressEnd || segment.progressEnd || 0)}%`,
      start: `${Math.round(segment.speedKmh || 0)} km/h`,
      end: segment.speedLimitKmh == null ? 'limit unavailable' : `${Math.round(segment.speedLimitKmh)} km/h limit`,
      detail: 'normalized route progress',
    }));
  }
  return segments.slice(0, 16).map((segment, index) => ({
    id: `real-time-${index}`,
    label: formatDurationLabel(segment.startOffsetSeconds || 0),
    start: `${Math.round(segment.speedKmh || 0)} km/h`,
    end: segment.speedLimitKmh == null ? 'limit unavailable' : `${Math.round(segment.speedLimitKmh)} km/h limit`,
    detail: 'real-time playback segment',
  }));
}

function chapterRows(timeline = {}) {
  const rows = [];
  const fastest = (timeline.segments || []).reduce((best, segment) => (
    Number(segment.speedKmh) > Number(best?.speedKmh || 0) ? segment : best
  ), null);
  if (fastest) {
    rows.push({
      id: 'fastest',
      type: 'speed',
      label: 'Fastest segment',
      offsetSeconds: Math.round(fastest.startOffsetSeconds || 0),
      detail: `${Math.round(fastest.speedKmh || 0)} km/h`,
    });
  }
  const firstGap = (timeline.points || []).find((point) => point.tracking_gap || point.route_gap);
  if (firstGap) {
    rows.push({
      id: 'first-gap',
      type: 'gap',
      label: 'Route gap',
      offsetSeconds: 0,
      detail: 'gap indicator recorded',
    });
  }
  (timeline.events || []).slice(0, 10).forEach((event, index) => {
    rows.push({
      id: `event-${index}`,
      type: event.type || 'event',
      label: titleCase(event.type),
      offsetSeconds: Math.round(event.offsetSeconds || 0),
      detail: '3D replay event chapter',
    });
  });
  return rows.sort((a, b) => a.offsetSeconds - b.offsetSeconds).slice(0, 12);
}

export function buildCompareReplayData({
  primaryTrip = null,
  secondaryTrip = null,
  settings = {},
  playbackMode = 'real_time',
} = {}) {
  const primaryAvailable = isReplayTripAvailable(primaryTrip);
  const secondaryAvailable = isReplayTripAvailable(secondaryTrip);
  const privacySettings = {
    privacy_zones: settings.privacy_zones,
    show_privacy_circles: settings.show_privacy_circles,
  };
  const primaryRoute = primaryAvailable
    ? maskRoutePointsForPrivacy(primaryTrip.route_points || [], privacySettings)
    : [];
  const secondaryRoute = secondaryAvailable
    ? maskRoutePointsForPrivacy(secondaryTrip.route_points || [], privacySettings)
    : [];
  const primaryPoints = prepareMapRoutePoints(primaryRoute, { maxPoints: null, smooth: false });
  const secondaryPoints = prepareMapRoutePoints(secondaryRoute, { maxPoints: null, smooth: false });
  const primaryEvents = primaryAvailable
    ? maskEventsForPrivacy(primaryTrip.driving_events || [], privacySettings)
    : [];
  const secondaryEvents = secondaryAvailable
    ? maskEventsForPrivacy(secondaryTrip.driving_events || [], privacySettings)
    : [];
  const primaryTimeline = buildPlaybackTimeline(primaryPoints, primaryEvents);
  const secondaryTimeline = buildPlaybackTimeline(secondaryPoints, secondaryEvents);
  const routeComparison = primaryAvailable && secondaryAvailable
    ? buildRouteComparison(primaryTrip, secondaryTrip)
    : { rows: [], notes: [] };
  const routeSimilarity = primaryAvailable && secondaryAvailable
    ? compareRouteSimilarity(primaryTrip, secondaryTrip)
    : { status: 'unavailable', label: 'Route similarity unavailable', startDeltaM: null, endDeltaM: null, distanceDeltaPct: null };
  const primaryPrivacyGaps = primaryRoute.filter(pointPrivacyMasked);
  const secondaryPrivacyGaps = secondaryRoute.filter(pointPrivacyMasked);

  return {
    primaryAvailable,
    secondaryAvailable,
    primaryUnavailableReason: primaryAvailable ? '' : replayUnavailableReason(primaryTrip),
    secondaryUnavailableReason: secondaryAvailable ? '' : replayUnavailableReason(secondaryTrip),
    routeSimilarity,
    routeComparison,
    primaryTimeline,
    secondaryTimeline,
    playbackRows: playbackModeRows(primaryTimeline, playbackMode),
    chapterRows: chapterRows(primaryTimeline),
    speedOverlayRows: [
      { tripId: primaryTrip?.id || '', label: 'Primary speed timeline', segments: primaryTimeline.segments.length },
      { tripId: secondaryTrip?.id || '', label: 'Comparison speed timeline', segments: secondaryTimeline.segments.length },
    ],
    eventOverlayRows: [
      ...(primaryTimeline.events || []).map((event, index) => ({
        id: `primary-event-${index}`,
        trip: 'primary',
        label: titleCase(event.type),
        offsetSeconds: event.offsetSeconds || 0,
      })),
      ...(secondaryTimeline.events || []).map((event, index) => ({
        id: `secondary-event-${index}`,
        trip: 'comparison',
        label: titleCase(event.type),
        offsetSeconds: event.offsetSeconds || 0,
      })),
    ].sort((a, b) => a.offsetSeconds - b.offsetSeconds),
    routeGapRows: [
      ...gapRows(primaryPoints, primaryTrip?.id || 'primary'),
      ...gapRows(secondaryPoints, secondaryTrip?.id || 'comparison'),
    ],
    speedLimitSourceRows: [
      ...speedLimitSourceChanges(primaryTimeline, primaryTrip?.id || 'primary'),
      ...speedLimitSourceChanges(secondaryTimeline, secondaryTrip?.id || 'comparison'),
    ],
    privacyGapRows: [
      ...primaryPrivacyGaps.map((point, index) => ({ id: `primary-privacy-${index}`, trip: 'primary', timestamp: point.timestamp || point.time || null, label: 'privacy gap indicator' })),
      ...secondaryPrivacyGaps.map((point, index) => ({ id: `secondary-privacy-${index}`, trip: 'comparison', timestamp: point.timestamp || point.time || null, label: 'privacy gap indicator' })),
    ],
  };
}
