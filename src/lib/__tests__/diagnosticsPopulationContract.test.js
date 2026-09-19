import { describe, expect, it } from 'vitest';
import { buildAppExperienceReport, buildTripDataProfile } from '@/lib/appExperienceDiagnostics';
import { DIAGNOSTICS_POPULATION_NOT_LOADED } from '@/hooks/useDiagnosticsPageData';

/**
 * Regression cover for the clean-install Diagnostics crash found on the A54.
 *
 * `useDiagnosticsPageData` published `population: null` before its query
 * settled. A default parameter only covers `undefined`, so neither
 * `buildAppExperienceReport({tripPopulation = {}})` nor
 * `buildTripDataProfile(…, {population = {}})` could absorb it, and
 * `population.available` threw `TypeError: Cannot read properties of null`.
 * React always renders before the query resolves, so the first render always
 * threw and the error boundary latched permanently.
 *
 * The rule these tests hold: a population that has not been read is reported as
 * unavailable **with a reason**, and never as a count.
 */

const ROWS = [
  { status: 'completed', distance_km: 4, duration_minutes: 9, route_replay_available: false },
  { status: 'completed', distance_km: 11, duration_minutes: 17, route_replay_available: false },
];

const WINDOW = {
  limit: 20,
  hasMore: false,
  populationComplete: true,
  completeness: 'EXACT',
  snapshot: { authority: 'browser', generation: 'g1', revision: 7, queryId: 'diagnostics.page' },
};

describe('Diagnostics trip-population contract', () => {
  it('does not crash when the population is null, and invents no count', () => {
    const profile = buildTripDataProfile(ROWS, { window: WINDOW, population: null });

    expect(profile.population.available).toBe(false);
    expect(profile.population.total_trip_count).toBeNull();
    expect(profile.population.completed_trip_count).toBeNull();
    // The bounded window is still reported truthfully; only the population is unknown.
    expect(profile.window.row_count).toBe(2);
    expect(profile.scope).toBe('bounded_window');
  });

  it('treats an absent population exactly like a null one', () => {
    const withNull = buildTripDataProfile(ROWS, { window: WINDOW, population: null });
    const withAbsent = buildTripDataProfile(ROWS, { window: WINDOW });

    expect(withNull.population).toEqual(withAbsent.population);
  });

  it('does not crash when the window is null', () => {
    const profile = buildTripDataProfile(ROWS, { window: null, population: null });

    expect(profile.window.row_count).toBe(2);
    expect(profile.window.source.authority).toBe('unknown');
  });

  it('reports the not-yet-loaded state truthfully rather than as zero trips', () => {
    const profile = buildTripDataProfile([], {
      window: WINDOW,
      population: DIAGNOSTICS_POPULATION_NOT_LOADED,
    });

    expect(profile.population.available).toBe(false);
    expect(profile.population.reason).toBe('population_not_loaded');
    // "Not read yet" must never be presented as a real count of zero.
    expect(profile.population.total_trip_count).toBeNull();
  });

  it('never invents a count for the pending contract itself', () => {
    expect(DIAGNOSTICS_POPULATION_NOT_LOADED.available).toBe(false);
    expect(DIAGNOSTICS_POPULATION_NOT_LOADED.reason).toBe('population_not_loaded');
    expect(DIAGNOSTICS_POPULATION_NOT_LOADED).not.toHaveProperty('totalTripCount');
  });

  it('still reports a populated result exactly', () => {
    for (const total of [0, 1, 128, 5000]) {
      const profile = buildTripDataProfile(ROWS, {
        window: WINDOW,
        population: {
          available: true,
          totalTripCount: total,
          completedTripCount: null,
          completedCountState: 'not_indexed',
          snapshot: { authority: 'browser', generation: 'g1', revision: 7 },
        },
      });

      expect(profile.population.available).toBe(true);
      expect(profile.population.total_trip_count).toBe(total);
      expect(profile.population.reason).toBeNull();
      expect(profile.population.matches_window_snapshot).toBe(true);
    }
  });

  it.each([
    'indexeddb_unavailable',
    'snapshot_changed_during_count',
    'native_health_unavailable',
  ])('preserves the real unavailable reason %s instead of flattening it', (reason) => {
    const profile = buildTripDataProfile(ROWS, {
      window: WINDOW,
      population: {
        available: false,
        reason,
        snapshot: { authority: 'browser', generation: null, revision: null },
      },
    });

    expect(profile.population.available).toBe(false);
    expect(profile.population.reason).toBe(reason);
    expect(profile.population.total_trip_count).toBeNull();
  });

  it('builds a whole report when the page passes a null population (the device path)', () => {
    const report = buildAppExperienceReport({
      trips: ROWS,
      tripWindow: WINDOW,
      tripPopulation: null,
    });

    expect(report.data.population.available).toBe(false);
    expect(report.data.population.total_trip_count).toBeNull();
    expect(report.data.window.row_count).toBe(2);
  });

  it('builds a whole report from the hook pending contract', () => {
    const report = buildAppExperienceReport({
      trips: [],
      tripWindow: WINDOW,
      tripPopulation: DIAGNOSTICS_POPULATION_NOT_LOADED,
    });

    expect(report.data.population.reason).toBe('population_not_loaded');
    expect(report.data.population.total_trip_count).toBeNull();
  });
});
