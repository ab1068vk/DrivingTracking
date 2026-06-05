import { getTripComponentScore } from '@/lib/scoring/componentScores';

const RECENT_UNRATED_WINDOW_DAYS = 14;

function tripTimeMs(trip = {}) {
  const raw = trip.end_time ?? trip.start_time ?? trip.created_at ?? trip.createdAt;
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function hasCalibrationRating(trip, markers = {}) {
  const marker = markers?.[String(trip?.id)];
  return Number.isInteger(Number(marker?.rating));
}

function isRecentTrip(trip, nowMs) {
  const time = tripTimeMs(trip);
  if (time == null) return false;
  return time >= nowMs - RECENT_UNRATED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function hasScore(trip) {
  return getTripComponentScore(trip, 'overall').value != null;
}

export function recentUnratedTripCount(trips = [], markers = {}, nowMs = Date.now()) {
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed')
    .filter((trip) => isRecentTrip(trip, nowMs))
    .filter(hasScore)
    .filter((trip) => !hasCalibrationRating(trip, markers))
    .length;
}
