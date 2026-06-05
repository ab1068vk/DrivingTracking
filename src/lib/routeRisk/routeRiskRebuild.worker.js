import { buildRouteRiskIndexFromTrips } from '@/lib/routeRisk/aggregate';

self.onmessage = (event) => {
  try {
    const { trips = [], privacyZones = [] } = event.data || {};
    self.postMessage({ status: 'running', completed: 0, total: trips.length });
    const index = buildRouteRiskIndexFromTrips(trips, privacyZones);
    self.postMessage({
      status: 'complete',
      completed: trips.length,
      total: trips.length,
      entries: [...index.entries()],
      metadata: index.metadata || {},
    });
  } catch (error) {
    self.postMessage({
      status: 'error',
      message: error?.message || 'Route risk index rebuild failed',
    });
  }
};
