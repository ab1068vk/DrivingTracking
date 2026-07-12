const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function trackingTripEventCount(trip = {}) {
  const collections = [trip.driving_events, trip.phone_use_events, trip.voice_speed_limit_markers];
  const retainedCount = collections.reduce(
    (total, collection) => total + (Array.isArray(collection) ? collection.length : 0),
    0
  );
  if (retainedCount > 0) return retainedCount;
  const summaryCount = finiteNumber(trip.driving_events_count ?? trip.event_count);
  if (summaryCount != null) return Math.max(0, Math.round(summaryCount));
  return [
    trip.harsh_brakes_count,
    trip.rapid_accel_count,
    trip.sharp_turns_count,
    trip.speeding_events_count,
    trip.phone_use_window_count,
  ].reduce((total, value) => total + Math.max(0, finiteNumber(value) || 0), 0);
}

export function trackingTripRoutePointCount(trip = {}) {
  if (Array.isArray(trip.route_points)) return trip.route_points.length;
  const count = finiteNumber(
    trip.route_point_count ?? trip.route_points_count ?? trip.route_points_retained ?? trip.gps_point_count
  );
  return count == null ? null : Math.max(0, Math.round(count));
}

export function trackingTripRouteStatus(trip = {}) {
  if (trip.privacy_mode === 'summary_only') {
    return { key: 'privacy', label: 'Summary only', detail: 'Route coordinates were not retained for this private trip.' };
  }
  if (trip.route_data_expired_at) {
    return { key: 'expired', label: 'Route expired', detail: 'The trip summary remains available after coordinate retention expired.' };
  }
  const pointCount = trackingTripRoutePointCount(trip);
  if (pointCount != null && pointCount > 1) {
    return { key: 'retained', label: 'Route retained', detail: `${pointCount} route points are available.` };
  }
  return { key: 'unavailable', label: 'Route unavailable', detail: 'No retained route coordinates are available.' };
}

export function trackingTripEvidenceStatus(trip = {}) {
  const route = trackingTripRouteStatus(trip);
  const confidence = String(
    trip.score_confidence_label || trip.score_provenance?.components?.overall || trip.score_safety_confidence || ''
  ).toLowerCase();
  if (route.key === 'privacy' || route.key === 'expired') {
    return { key: 'limited', label: 'Limited evidence', detail: route.detail };
  }
  if (route.key === 'unavailable') {
    return { key: 'unavailable', label: 'Evidence unavailable', detail: route.detail };
  }
  if (confidence === 'low' || confidence === 'unavailable' || confidence === 'insufficient_data') {
    return { key: 'limited', label: 'Limited evidence', detail: 'Route data exists, but one or more calculated signals have limited evidence.' };
  }
  return { key: 'recorded', label: 'Evidence recorded', detail: 'Retained route telemetry is available for inspection.' };
}

export function trackingTripDisplayName(trip = {}) {
  if (String(trip.nickname || '').trim()) return String(trip.nickname).trim();
  if (String(trip.tag || '').trim()) return String(trip.tag).replace(/_/g, ' ');
  const date = trip.start_time ? new Date(trip.start_time) : null;
  if (date && Number.isFinite(date.getTime())) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date);
  }
  return trip.id ? `Trip ${String(trip.id).slice(0, 8)}` : 'Recorded trip';
}

export function trackingTripObservationLabel(trip = {}) {
  const count = trackingTripEventCount(trip);
  return count === 1 ? '1 recorded observation' : `${count} recorded observations`;
}

export function trackingTripStartTime(trip = {}) {
  const time = new Date(trip.start_time || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function trackingTripNumericValue(trip = {}, key) {
  return finiteNumber(trip?.[key]);
}
