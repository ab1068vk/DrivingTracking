import { tripService } from '@/api/trips';
import { refreshTripForLocalSpeedKnowledge } from '@/lib/localSpeedScoreRefresh';
import { scheduleRescoringQueue } from '@/lib/rescoringQueue';

export async function rescoreTripForQueue(tripId, job = {}) {
  if (String(job?.reason || '').startsWith('speed_knowledge')) {
    return refreshTripForLocalSpeedKnowledge(tripId);
  }
  await tripService.update(tripId, {
    needs_rescore: true,
    score_update_acknowledged_at: null,
    updated_at: new Date().toISOString(),
  });
  await tripService.getById(tripId);
}

export function startRescoringWorker() {
  scheduleRescoringQueue({ rescoreTrip: rescoreTripForQueue });
}
