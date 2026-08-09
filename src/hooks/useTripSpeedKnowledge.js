/**
 * One way to load a trip's saved road speeds.
 *
 * Trip Detail, Speed Analysis, and the map screen each had their own copy of
 * this effect, and they did not agree:
 *
 * - Speed Analysis preferred knowledge.getForPoints, which passes points
 *   through untouched. The other two used prefetchLocalKnowledge, which derives
 *   a heading for each point first. The resolver is direction-aware, so on a
 *   road whose saved limit depends on direction the two paths could resolve
 *   different limits for the same trip — which is exactly what it looked like
 *   from the outside: Trip Detail and Speed Analysis disagreeing.
 * - All three swallowed load failures into an array of nulls, which is
 *   indistinguishable from a route that genuinely has no saved road speeds.
 *   A store that merely failed to open was reported as an empty road memory,
 *   and nothing was logged, so the two cases could not be told apart later.
 *
 * This hook resolves through prefetchLocalKnowledge for everyone — the
 * heading-deriving path, because the resolver uses direction — and reports a
 * failure as a failure.
 */
import { useCallback, useEffect, useState } from 'react';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { prefetchLocalKnowledge } from '@/lib/tripEngine';
import { logSystemFailure } from '@/lib/systemLog';

/**
 * The load itself, kept free of React so it can be tested directly — this
 * project's test environment is Node with no DOM, so a hook's effect never runs
 * under test and the error path would otherwise be unverifiable.
 *
 * @param {any} trip
 * @param {{context?: string}} [options]
 * @returns {Promise<{results: Array<any>, failed: boolean}>}
 */
export async function resolveTripSpeedKnowledge(trip, options = {}) {
  const { context = 'trip_speed_knowledge' } = options;
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (!points.length) return { results: [], failed: false };

  try {
    const results = await prefetchLocalKnowledge(points, new LocalSpeedKnowledge(speedKnowledgeStore));
    return { results, failed: false };
  } catch (error) {
    logSystemFailure(context, error, { trip_id: trip?.id });
    // Same length as the route, not an empty array: callers index into this by
    // route-point position, and an empty array would break that alignment.
    return { results: points.map(() => null), failed: true };
  }
}

/**
 * @param {any} trip
 * @param {{context?: string}} [options] context labels the failure in the system log.
 * @returns {{results: Array<any>, failed: boolean, loading: boolean, reload: () => void}}
 *   results is index-aligned with trip.route_points, so a caller may index into
 *   it directly. On failure it is a same-length array of nulls rather than an
 *   empty array, preserving that alignment. reload() re-resolves after a change
 *   this tab made itself, which does not raise the cross-tab change event.
 */
export function useTripSpeedKnowledge(trip, options = {}) {
  const { context = 'trip_speed_knowledge' } = options;
  const [results, setResults] = useState([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  const tripId = trip?.id;
  const routePoints = trip?.route_points;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const points = Array.isArray(routePoints) ? routePoints : [];
      if (!points.length) {
        if (!cancelled) {
          setResults([]);
          setFailed(false);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      const resolved = await resolveTripSpeedKnowledge({ id: tripId, route_points: points }, { context });
      if (cancelled) return;
      setResults(resolved.results);
      setFailed(resolved.failed);
      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [context, revision, routePoints, tripId]);

  // A confirmed limit elsewhere in the app must reach this trip without a
  // reload, so the saved-speed change event forces a re-resolve.
  useEffect(() => {
    const onChanged = () => setRevision((value) => value + 1);
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onChanged);
  }, []);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  return { results, failed, loading, reload };
}

export default useTripSpeedKnowledge;
