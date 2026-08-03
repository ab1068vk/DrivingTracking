import { tripService } from '@/api/trips';
import {
  createCoachProgram,
  finishCoachProgram,
  loadCoachProgramStore,
  recordCoachFeedback,
  saveCoachProgramStore,
} from '@/lib/coachPrograms';

const REVIEW_FEEDBACK = new Set(['helpful', 'not_relevant', 'wrong_detection']);

export function buildPostDriveCoachStore({
  store,
  trip,
  trips = [],
  focusId = 'consistency',
  now = new Date(),
}) {
  const history = Array.isArray(store?.history) ? store.history : [];
  const completedTrips = [
    trip,
    ...(Array.isArray(trips) ? trips : []),
  ].filter((item, index, values) => (
    item?.id &&
    item?.status === 'completed' &&
    values.findIndex((candidate) => String(candidate?.id) === String(item.id)) === index
  ));
  const active = store?.active?.status === 'active' ? store.active : null;
  const nextProgram = {
    ...createCoachProgram({
      focusId,
      difficulty: 'adaptive',
      targetTripCount: 3,
      contextMode: 'comparable',
      routeKey: trip?.route_key || null,
      store,
      trips: completedTrips,
      now,
    }),
    source: 'post_drive_review',
    sourceTripId: trip?.id || null,
  };
  return {
    program: nextProgram,
    replaced: Boolean(active),
    store: {
      ...store,
      active: nextProgram,
      history: active
        ? [finishCoachProgram(active, completedTrips, 'replaced', now), ...history]
        : history,
    },
  };
}

export async function activatePostDriveFocus(options) {
  const current = await loadCoachProgramStore();
  const next = buildPostDriveCoachStore({ ...options, store: current });
  return {
    ...next,
    store: await saveCoachProgramStore(next.store),
  };
}

export function buildPostDriveFeedbackStore({
  store,
  tripId,
  focusId,
  verdict,
  now = new Date(),
}) {
  if (!REVIEW_FEEDBACK.has(verdict) || !tripId || !focusId) return store;
  return recordCoachFeedback(store, {
    program: {
      id: `post_drive_review:${String(tripId)}`,
      focusId,
    },
    tripId,
    verdict,
    now,
  });
}

export async function savePostDriveRecommendationFeedback({
  trip,
  focusId,
  verdict,
  now = new Date(),
}) {
  const store = await loadCoachProgramStore();
  const nextStore = buildPostDriveFeedbackStore({
    store,
    tripId: trip?.id,
    focusId,
    verdict,
    now,
  });
  const savedStore = await saveCoachProgramStore(nextStore);
  await tripService.update(trip.id, {
    post_drive_review_feedback: {
      focus_id: focusId,
      verdict,
      reviewed_at: new Date(now).toISOString(),
    },
  });
  return savedStore;
}
