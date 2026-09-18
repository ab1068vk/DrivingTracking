// ...and the legacy call lives in another module entirely.
import { tripService } from '@/api/trips';

export function sharedLegacyRead() {
  return tripService.list();
}
