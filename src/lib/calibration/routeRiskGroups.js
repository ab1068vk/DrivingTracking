import { mean } from './numberUtils.js';
import { routeRiskCellKeyForPoint } from './routeRiskGrid.js';
import { routeRiskTripMetrics } from './routeRiskTripMetrics.js';

function groupKeyForMetric(metric) {
  return routeRiskCellKeyForPoint(metric.center.lat, metric.center.lng);
}

function summarizeGroup(key, metrics) {
  const eventRates = metrics.map((metric) => metric.eventRatePerKm);
  const harshRates = metrics.map((metric) => metric.harshEventRatePerKm);
  const eventCount = metrics.reduce((sum, metric) => sum + metric.eventCount, 0);
  const harshCount = metrics.reduce((sum, metric) => sum + metric.harshCount, 0);

  return {
    key,
    trips: metrics,
    tripCount: metrics.length,
    meanEventRatePerKm: mean(eventRates) ?? 0,
    meanHarshEventRatePerKm: mean(harshRates) ?? 0,
    harshEventRatio: eventCount > 0 ? harshCount / eventCount : 0,
  };
}

export function routeRiskCalibrationGroups(trips = []) {
  const grouped = new Map();
  for (const metric of routeRiskTripMetrics(trips)) {
    const key = groupKeyForMetric(metric);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), metric]);
  }

  return [...grouped.entries()]
    .map(([key, metrics]) => summarizeGroup(key, metrics))
    .filter((group) => group.tripCount >= 3);
}
