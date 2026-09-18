import { activeTripStore } from '@/lib/trackingStore';
import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import { localTripRepository } from '@/lib/localTripRepository';

globalThis.__browserRsas = {
  activeTripStore,
  browserActiveTripSpool,
  localTripRepository,
};
