import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
  AUTO_RESCORE_RECENT_WINDOW_DAYS,
  TRIP_EVENT_MIGRATION_VERSION,
} from '@/lib/localTripRepository';

/**
 * Settings' score-migration summary (P7 Stage 8, **B9 -> O61**).
 *
 * What it replaces: `tripService.getScoreMigrationSummary()`, which read every
 * completed trip and returned an **unbounded** `trips` array — one entry per
 * mismatched trip. The panel rendered four of them and a "+N more" derived
 * from the array's length, so the payload grew with the history to produce a
 * number the page could have had from a counter.
 *
 * `p7.settings.scoreMigrationSummary@1` returns a fixed shape: the counters,
 * `has_unknown_legacy_unrescored`, and a **four-slot** `mismatch_preview` in
 * the reducer's deterministic newest-first scan order. "+N more" is
 * `mismatch_count - preview.length`.
 *
 * Completeness is not cosmetic here. Until the scan reaches terminal EOF the
 * counts are floors, and the panel says "at least N" rather than presenting a
 * partial tally as the state of the driver's history.
 */

const REDUCER = 'p7.settings.scoreMigrationSummary@1';
const DAY_MS = 86400000;

/** The ratio the auto-rescore recommendation is derived from. */
export const scoreMigrationRatio = (terms) => {
  const recent = Number(terms?.recent_completed_count) || 0;
  if (!recent) return 0;
  return (Number(terms?.recent_mismatch_count) || 0) / recent;
};

/**
 * @param {{enabled?: boolean}} [options]
 */
export function useScoreMigrationSummary({ enabled = true } = {}) {
  const query = useQuery({
    queryKey: p7QueryKeys.reduce('p7.settings.scoreMigrationSummary', 1, 'settings'),
    queryFn: () => p7TripQueries.reducer({
      reducer: REDUCER,
      status: 'completed',
      limit: 200,
      context: {
        scoring_version: SCORING_VERSION,
        recent_window_days: AUTO_RESCORE_RECENT_WINDOW_DAYS,
        recentCutoffMs: Date.now() - AUTO_RESCORE_RECENT_WINDOW_DAYS * DAY_MS,
        auto_rescore_threshold_ratio: AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
        event_migration_version: TRIP_EVENT_MIGRATION_VERSION,
      },
    }),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  const result = query.data;
  const exact = result?.completeness === 'EXACT' && !result?.unavailable;
  const terms = result?.unavailable
    ? null
    : (exact ? result?.data : result?.data?.partial) ?? null;

  if (!terms) {
    return { data: undefined, scoreMigrationExact: false, unavailable: result?.unavailable ?? null };
  }

  const ratio = scoreMigrationRatio(terms);
  return {
    data: {
      ...terms,
      recent_mismatch_ratio: ratio,
      // The recommendation may only be made from a tally that finished: a
      // partial ratio could cross the threshold on the rows read so far and
      // fall back below it once the rest are counted.
      auto_rescore_recommended: exact && ratio > (Number(terms.auto_rescore_threshold_ratio) || 0),
    },
    scoreMigrationExact: exact,
    unavailable: null,
  };
}
