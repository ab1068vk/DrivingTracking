/**
 * The CPU-heavy middle of a speed-knowledge rescore, as one pure function.
 *
 * DPD-031. `buildLocalSpeedKnowledgeScorePatch` used to run trip stats, event
 * detection, phone-use evidence and scoring synchronously on the renderer's main
 * thread, inside one rescore turn. On the A54 at 3,000 trips that was 1-4 s of
 * blocked UI per trip, for hours. Turns were bounded by item count, not time, so
 * "one trip per turn" still meant one multi-second freeze for a long route.
 *
 * This module holds exactly that middle so it can run in a Web Worker
 * (`src/workers/tripRescore.worker.js`) with the main thread only doing the async
 * I/O around it. It must stay pure: data in, data out, no storage, no settings
 * reads, no DOM - the same inputs give the same result wherever it runs.
 */
import { calculateTripScores, calculateTripStats, detectDrivingEvents } from '@/lib/tripEngine';
import { buildPhoneUseFromTripEvidence } from '@/lib/phoneUsageAccess';
import { applyWeatherRiskToScores } from '@/lib/weatherContext';

/**
 * Structured clone copies array *elements* only. The knowledge prefetch result is
 * an array that also carries `knowledgeMetadata` (non-enumerable) and
 * `sourceReliability`, and scoring reads both, so they cross the worker boundary
 * explicitly and are re-attached on the other side.
 */
export const packKnowledgeResults = (results) => {
  if (!Array.isArray(results)) return { items: results ?? null, isArray: false };
  return {
    items: [...results],
    isArray: true,
    knowledgeMetadata: results.knowledgeMetadata ?? null,
    sourceReliability: results.sourceReliability ?? null,
  };
};

export const unpackKnowledgeResults = (packed) => {
  if (!packed || !packed.isArray) return packed?.items ?? null;
  const results = [...packed.items];
  if (packed.knowledgeMetadata) {
    Object.defineProperty(results, 'knowledgeMetadata', {
      configurable: true,
      enumerable: false,
      value: packed.knowledgeMetadata,
    });
  }
  if (packed.sourceReliability) results.sourceReliability = packed.sourceReliability;
  return results;
};

/**
 * @param {{
 *   trip: any,
 *   scoringRoutePoints: any[],
 *   thresholds: any,
 *   privacyZones: any[],
 *   settings: any,
 *   knowledge: ReturnType<typeof packKnowledgeResults>,
 * }} input
 */
export function computeTripRescore({ trip, scoringRoutePoints, thresholds, privacyZones, settings, knowledge }) {
  const localKnowledgeResults = unpackKnowledgeResults(knowledge);
  const stats = calculateTripStats(scoringRoutePoints, trip.start_time, trip.end_time, thresholds, {
    ...trip,
    raw_route_points: scoringRoutePoints,
  });
  const { events: detectedEvents, phoneUse: detectedPhoneUse } = detectDrivingEvents(
    scoringRoutePoints,
    thresholds,
    trip.end_time,
    privacyZones,
    { localKnowledgeResults, settings }
  );
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    scoringRoutePoints,
    stats.duration_seconds,
    detectedPhoneUse
  );
  let scores = calculateTripScores(
    detectedEvents,
    stats,
    scoringRoutePoints,
    thresholds,
    stats.duration_seconds,
    phoneUse,
    {
      endTime: trip.end_time,
      privacyZones,
      localKnowledgeResults,
      settings,
    }
  );
  scores = applyWeatherRiskToScores(scores, trip.weather_context || null);
  return { stats, detectedEvents, phoneUse, scores };
}
