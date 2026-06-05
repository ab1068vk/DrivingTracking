import { mean, pearsonCorrelation, round } from './numberUtils.js';
import { routeRiskScoreForGroup } from './routeRiskFit.js';

function leaveOneOutPairs(routeGroups, constants) {
  return routeGroups.flatMap((group) => {
    if (group.trips.length < 3) return [];
    return group.trips.map((trip, index) => {
      const peers = group.trips.filter((_, peerIndex) => peerIndex !== index);
      const peerGroup = {
        ...group,
        trips: peers,
        meanEventRatePerKm: mean(peers.map((peer) => peer.eventRatePerKm)) ?? 0,
        meanHarshEventRatePerKm: mean(peers.map((peer) => peer.harshEventRatePerKm)) ?? 0,
      };
      const tripGroup = {
        ...group,
        meanEventRatePerKm: trip.eventRatePerKm,
        meanHarshEventRatePerKm: trip.harshEventRatePerKm,
      };

      return {
        x: routeRiskScoreForGroup(tripGroup, constants),
        y: routeRiskScoreForGroup(peerGroup, constants),
      };
    });
  });
}

function meanGroupRisk(routeGroups, constants, predicate) {
  return mean(
    routeGroups
      .filter(predicate)
      .map((group) => routeRiskScoreForGroup(group, constants))
  );
}

function saturationEffectiveness(routeGroups, cap) {
  const inflatedRates = routeGroups
    .flatMap((group) => group.trips.map((trip) => trip.eventRatePerKm))
    .filter((rate) => rate > cap);
  if (!inflatedRates.length) return 1;

  const reductions = inflatedRates.map((rate) => 1 - (cap / rate));
  return mean(reductions) ?? 0;
}

export function validateRouteRiskFit(routeGroups, constants) {
  const harshMean = meanGroupRisk(routeGroups, constants, (group) => group.harshEventRatio > 0);
  const normalMean = meanGroupRisk(routeGroups, constants, (group) => group.harshEventRatio === 0);

  return {
    repeatedRouteConsistency: round(pearsonCorrelation(leaveOneOutPairs(routeGroups, constants)), 3),
    harshVsNormalRouteRatio: normalMean && normalMean > 0 ? round(harshMean / normalMean, 3) : null,
    saturationEffectiveness: round(saturationEffectiveness(routeGroups, constants.EVENT_DENSITY_MAX_EVENTS_PER_KM), 3),
  };
}
