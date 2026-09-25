import { describe, expect, it } from 'vitest';
import { scoreReviewBannerText } from '@/lib/dashboardStats';
import { tripHistoryHeaderDescription } from '@/pages/TripHistory';
import { vehicleCardFigures } from '@/pages/Vehicles';
import { buildTripDataProfile } from '@/lib/appExperienceDiagnostics';
import { unrecordedNote } from '@/components/AppExperienceDiagnosticsPanel';
import { MAP_OVERVIEW_NOT_BUILT_DETAIL, mapOverviewStatus } from '@/lib/mapOverviewStatus';

// DPD-034, wider matrix (§39 physical sweep at 3,000). Same class as the three
// original cells: a count or sum over a BOUNDED window shown as if it were the
// history. A54 readings: Trip History "60 of 60 completed trips" (history 3,000),
// Dashboard "60 completed trips used an older scoring model" (window of 60),
// vehicle cards "41 trips" for a 1,200-trip vehicle and "0 trips" for one with 30.

describe('Trip History header states a total only for a complete population', () => {
  it('names the rows read when more history exists', () => {
    expect(tripHistoryHeaderDescription(60, 60, 'MORE_AVAILABLE')).toBe('60 of the 60 completed trips read so far');
    expect(tripHistoryHeaderDescription(12, 60, 'COMPLETENESS_UNKNOWN')).toBe('12 of the 60 completed trips read so far');
  });

  it('keeps the plain total when the pagination authority says COMPLETE', () => {
    expect(tripHistoryHeaderDescription(5, 40, 'COMPLETE')).toBe('5 of 40 completed trips');
  });

  it('treats an absent state as not complete', () => {
    expect(tripHistoryHeaderDescription(60, 60, undefined)).toMatch(/read so far$/);
  });
});

describe('Dashboard score-review banner names its window', () => {
  it('scopes the mismatch count to the window when history is larger', () => {
    const text = scoreReviewBannerText({ mismatchCount: 60, windowCount: 60, lifetimeTrips: 3000 });
    expect(text).toBe('60 of the latest 60 completed trips used an older scoring model. Tap to open re-scoring.');
  });

  it('scopes it when the lifetime count is unknown', () => {
    expect(scoreReviewBannerText({ mismatchCount: 3, windowCount: 60, lifetimeTrips: null }))
      .toMatch(/^3 of the latest 60 completed trips/);
  });

  it('keeps the plain count when the window is the whole history', () => {
    expect(scoreReviewBannerText({ mismatchCount: 1, windowCount: 40, lifetimeTrips: 40 }))
      .toBe('1 completed trip used an older scoring model. Tap to open re-scoring.');
    expect(scoreReviewBannerText({ unavailableCount: 2, windowCount: 40, lifetimeTrips: 12 }))
      .toBe('2 trips have unavailable scores. Tap to re-score from Settings.');
  });

  it('scopes the unavailable-score count the same way', () => {
    expect(scoreReviewBannerText({ unavailableCount: 1, windowCount: 60, lifetimeTrips: 3000 }))
      .toBe('1 of the latest 60 trips has unavailable scores. Tap to re-score from Settings.');
  });
});

describe('Vehicle card figures come from the lifetime bucket or say they do not', () => {
  const scored = (score, km = 10) => ({ status: 'completed', distance_km: km, score_overall: score, scores: { overall: score } });
  const window41 = Array.from({ length: 41 }, () => scored(80));

  it('uses the exact lifetime trip count and score when the D1 bucket exists', () => {
    const f = vehicleCardFigures({ vehicleTrips: window41, owned: { trips: 1200, distanceKm: 23709.4, score: 83 }, windowRows: 100 });
    expect(f.tripCount).toBe(1200);
    expect(f.tripCount).not.toBe(41); // the A54 reading
    expect(f.tripCountNote).toBeNull();
    expect(f.score).toBe(83);
    // Economics still cover only the window, and say so.
    expect(f.windowNote).toBe('latest 100 trips');
  });

  it('shows a vehicle with no recent rows by its lifetime count, not 0', () => {
    const f = vehicleCardFigures({ vehicleTrips: [], owned: { trips: 30, distanceKm: 571.6, score: 81 }, windowRows: 100 });
    expect(f.tripCount).toBe(30);
    expect(f.windowNote).toBe('latest 100 trips');
  });

  it('labels the window count when there is no lifetime bucket', () => {
    const f = vehicleCardFigures({ vehicleTrips: window41, owned: null, windowRows: 100 });
    expect(f.tripCount).toBe(41);
    expect(f.tripCountNote).toBe('among the latest 100 trips');
    expect(f.windowNote).toBe('latest 100 trips');
  });

  it('drops the window note when the window holds every trip of the vehicle', () => {
    const f = vehicleCardFigures({ vehicleTrips: window41, owned: { trips: 41, distanceKm: 410, score: 80 }, windowRows: 100 });
    expect(f.windowNote).toBeNull();
  });
});

describe('DPD-036: Diagnostics trip shape discloses fields the summary row does not carry', () => {
  // The browser projection row shape: no start_source, tracking_mode or evidence fields.
  const projectionRow = { id: 'p', status: 'completed', distance_km: 3, start_time: '2026-09-18T12:00:00Z' };

  it('counts projection rows as not recorded instead of zero automatic / manual', () => {
    const profile = buildTripDataProfile(Array.from({ length: 20 }, () => ({ ...projectionRow })));
    expect(profile.automatic_trip_count).toBe(0);
    expect(profile.collection_mode_unrecorded_trip_count).toBe(20);
    expect(profile.advanced_evidence_unrecorded_trip_count).toBe(20);
    expect(`0 / 0${unrecordedNote(profile.collection_mode_unrecorded_trip_count)}`).toBe('0 / 0 · 20 not recorded');
  });

  it('does not flag full rows that carry the fields', () => {
    const profile = buildTripDataProfile([{ ...projectionRow, start_source: 'auto', motion_sample_count: 0 }]);
    expect(profile.automatic_trip_count).toBe(1);
    expect(profile.collection_mode_unrecorded_trip_count).toBe(0);
    expect(profile.advanced_evidence_unrecorded_trip_count).toBe(0);
    expect(unrecordedNote(0)).toBe('');
  });
});

describe('DPD-037: the Map overview reports an unbuilt D2 as unbuilt, not as zero trips', () => {
  it('does not claim 0 trips when Q8 refuses because the owner is not ready', () => {
    const status = mapOverviewStatus({ unavailable: { code: 'OWNER_NOT_READY', reason: 'REBUILD_REQUIRED' }, count: 0 });
    expect(status.header).toBe('Route overviews are not built yet');
    expect(status.header).not.toMatch(/0 filtered trips/); // the A54 reading
    expect(status.notBuilt).toBe(true);
    expect(status.readFailed).toBe(false);
    expect(MAP_OVERVIEW_NOT_BUILT_DETAIL).toMatch(/Repair trip analytics and route previews/);
  });

  it('keeps a real read failure distinct from an unbuilt owner', () => {
    const status = mapOverviewStatus({ unavailable: { code: 'AUTHORITY_UNAVAILABLE' } });
    expect(status.header).toBe('Route overviews could not be read');
    expect(status.readFailed).toBe(true);
  });

  it('still counts the filtered trips when the page answered', () => {
    expect(mapOverviewStatus({ count: 80 }).header).toBe('Showing 80 filtered trips');
    expect(mapOverviewStatus({ count: 1 }).header).toBe('Showing 1 filtered trip');
    expect(mapOverviewStatus({ loading: true }).header).toBe('Loading trips...');
  });
});

describe('Achievements evidence distance carries the same floor as the qualifying count', () => {
  it('prefixes the km with "at least" under the same lifetime-exact rule (structural guard)', async () => {
    // The qualifying line is inline page JSX; this pins the km to the floor rule the
    // count already uses. The A54 read "at least 124/3000 qualifying trips" above a
    // bare "2807.0 km evidence" from the same unfinished scan. Not runtime evidence —
    // the device recheck is.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../pages/Achievements.jsx', import.meta.url), 'utf8');
    expect(source).toMatch(/\{progressionLifetimeExact \? '' : 'at least '\}\s*\{formatDistance\(progression\.eligibility\.distanceKm/);
  });
});
