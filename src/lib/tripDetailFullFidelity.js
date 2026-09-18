import { tripService } from '@/api/trips';
import { splitTripAtStops } from '@/lib/tripEngine';
import { detectTripStops } from '@/lib/tripInsights';
import { buildPhoneUseFromTripEvidence } from '@/lib/phoneUsageAccess';

export const tripDetailExactResults = (trip, analysis = null) => {
  if (trip?.route_overview_only === true) {
    return {
      source: 'canonical_stream',
      ready: Boolean(analysis?.routeSource === 'canonical_stream'),
      stops: analysis?.stops || [],
      splitSegments: analysis?.splitSegments || [],
      speedZoneSummary: analysis?.speedZoneSummary || [],
      phoneUse: analysis?.phoneUse || null,
      pointCount: analysis?.fullRoutePointCount ?? null,
    };
  }
  return {
    source: 'complete_record',
    ready: true,
    stops: detectTripStops(trip?.route_points || []),
    splitSegments: null,
    speedZoneSummary: null,
    phoneUse: buildPhoneUseFromTripEvidence(trip, trip?.route_points || [], trip?.duration_seconds || 0, {}),
    pointCount: trip?.route_points?.length || 0,
  };
};

export async function splitTripFromDetail(trip, analysis, service = tripService) {
  if (trip?.route_overview_only === true) {
    if (analysis?.routeSource !== 'canonical_stream') {
      throw new Error('FULL_FIDELITY_ROUTE_REQUIRED');
    }
    return service.splitAtStopsStreamed(trip, { minParkMinutes: 5, analysis });
  }
  const children = splitTripAtStops(trip, 5);
  await Promise.all(children.map((child) => service.create(child)));
  await service.delete(trip.id);
  return children;
}
