import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DashboardSummaryPanels from '@/components/dashboard/DashboardSummaryPanels';
import { SCOPE_STATE } from '@/lib/scopeDisclosure';

/**
 * DPD-017 on the STANDARD Dashboard variant.
 *
 * The premium card is covered in `dashboardScopeTruth.test.jsx`. This file
 * exists because the defect that forced this correction was, at bottom, two
 * variants disagreeing: the carve-out lived only in the premium card, so the
 * same device in the same state said "Everything recorded on this device" on
 * one appearance setting and "Totals so far" on the other.
 *
 * Both variants now read one `activityScope`, decided once in `Dashboard.jsx`
 * from the raw completeness signals. These tests pin that the standard grid
 * obeys the same four-state law, so the two cannot drift apart again.
 */

/** The shape `dashboardActivity` produces while its queries are pending. */
const pendingActivity = {
  periodDays: null,
  tripCount: 0,
  distanceKm: 0,
  drivingSeconds: 0,
  activeDays: 0,
  averageTripKm: 0,
  longestTripKm: 0,
  tripsPerActiveDay: 0,
};

const renderStandard = (activityScope, dashboardActivity = pendingActivity) => renderToStaticMarkup(
  <DashboardSummaryPanels
    activityPeriod="all_time"
    activityScope={activityScope}
    analyticsCompletedTrips={[]}
    avgScore={null}
    avgScoreEvidence={null}
    baseline={{}}
    baselineRangeLabel=""
    baselineText=""
    completedTrips={[]}
    dailyFatigue={{}}
    dashboardActivity={dashboardActivity}
    fatigueRisk={{}}
    isAllTimeActivity
    noHarshBrakeStreak={0}
    peakStress={{}}
    recentTripError={null}
    recentTripsError={null}
    recentTripsLoaded
    refetch={() => {}}
    scoreTrend={[]}
    setActivityPeriod={() => {}}
    settings={{}}
    tips={[]}
    units="metric"
    weeklyGoals={[]}
  />,
);

describe('the standard Dashboard grid obeys the same scope law', () => {
  it('UNKNOWN: never claims a complete history over an unanswered source', () => {
    const html = renderStandard(SCOPE_STATE.UNKNOWN);

    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');
    expect(html).toContain('Preparing totals');
    expect(html).toContain('Your lifetime totals are still being prepared');
  });

  it('PARTIAL: hedges explicitly', () => {
    const html = renderStandard(SCOPE_STATE.PARTIAL, {
      ...pendingActivity, tripCount: 200, distanceKm: 2892.6,
    });

    expect(html).toContain('Totals so far');
    expect(html).toContain('Still counting everything recorded on this device');
    expect(html).toContain('at least 2892.6 km');
    expect(html).not.toContain('All-time totals');
  });

  it('VERIFIED non-empty: states the lifetime totals plainly', () => {
    const html = renderStandard(SCOPE_STATE.VERIFIED, {
      ...pendingActivity, tripCount: 500, distanceKm: 10063.7, averageTripKm: 20.13,
    });

    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    expect(html).toContain('10063.7 km');
    expect(html).not.toContain('at least');
  });

  it('VERIFIED empty: states zero as the whole truth', () => {
    const html = renderStandard(SCOPE_STATE.VERIFIED);

    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    expect(html).not.toContain('at least');
  });

  it('is the same zero under two signals, and only the signal decides', () => {
    // The whole point of the correction, stated as one assertion.
    expect(renderStandard(SCOPE_STATE.VERIFIED)).toContain('All-time totals');
    expect(renderStandard(SCOPE_STATE.UNKNOWN)).not.toContain('All-time totals');
  });

  it('UNAVAILABLE: reports a refusal rather than an unfinished tally', () => {
    // Deliberately rendered with the all-zero object: `UNAVAILABLE` now means
    // nothing was read, so there are no figures to contradict the sentence.
    const html = renderStandard(SCOPE_STATE.UNAVAILABLE);

    expect(html).toContain('Totals unavailable');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('Still counting');
    expect(html).not.toContain('Preparing totals');
  });

  it('a refusal beside a valid substitute keeps the real figures and their floors', () => {
    // The regression for the defect that stopped the previous round. D1 refused
    // while the activity reducer answered, so the card is PARTIAL and every
    // figure the reducer supplied stays on screen, floored.
    const html = renderStandard(SCOPE_STATE.PARTIAL, {
      ...pendingActivity, tripCount: 200, distanceKm: 2892.6, averageTripKm: 14.463,
    });

    expect(html).not.toContain('Totals unavailable');
    expect(html).not.toContain('could not be read');
    expect(html).toContain('at least 2892.6 km');
    expect(html).toContain('at least 200');
    // The mean keeps disclosing its denominator rather than standing bare.
    expect(html).toContain('over trips counted so far');
  });
});
