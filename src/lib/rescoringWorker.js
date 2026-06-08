import { tripService } from '@/api/trips';
import { scheduleRescoringQueue } from '@/lib/rescoringQueue';

export async function rescoreTripForQueue(tripId) {
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
