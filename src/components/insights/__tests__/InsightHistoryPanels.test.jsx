import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InsightHistoryPanels } from '@/components/insights/InsightHistoryPanels';

describe('InsightHistoryPanels', () => {
  it('restores calendar, route, phone, goal, and road-context tools', () => {
    const trip = {
      id: 'history-trip',
      status: 'completed',
      start_time: new Date().toISOString(),
      distance_km: 12,
      score_overall: 88,
      score_safety: 90,
      score_smoothness: 86,
      harsh_brakes_count: 0,
      rapid_accel_count: 0,
      sharp_turns_count: 0,
      speeding_events_count: 0,
      dominant_road_type: 'city',
    };
    const html = renderToStaticMarkup(
      <InsightHistoryPanels trips={[trip]} settings={{}} units='metric' onOpenTrip={() => {}} />
    );

    expect(html).toContain('Trip calendar');
    expect(html).toContain('Commute detection');
    expect(html).toContain('Repeated route comparison');
    expect(html).toContain('Phone use focus');
    expect(html).toContain('Weekly goals');
    expect(html).toContain('Road type breakdown');
  });

  it('renders the month its caller selected, from that month own rows', () => {
    // P7 Stage 6.5: which month to open on is the page's decision, because
    // changing months changes which window is **queried**. The page answers it
    // from one newest-first row (`insightsMonthOffset`) and hands this
    // component both the offset and the rows of that grid.
    const latestTripDate = new Date();
    latestTripDate.setMonth(latestTripDate.getMonth() - 2);
    const olderTrip = {
      id: 'older-history-trip',
      status: 'completed',
      start_time: latestTripDate.toISOString(),
      distance_km: 4,
      score_overall: 82,
    };
    const html = renderToStaticMarkup(
      <InsightHistoryPanels
        trips={[olderTrip]}
        calendarTrips={[olderTrip]}
        monthOffset={-2}
        onMonthOffsetChange={() => {}}
        settings={{}}
        units='metric'
        onOpenTrip={() => {}}
      />
    );

    expect(html).toContain('1 trip');
    expect(html).toContain(latestTripDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  });

  it('reads the calendar from its own window, not from the analysis rows', () => {
    // The analysis rows and the calendar grid are different windows. A trip
    // outside the calendar's month must not appear in its day cells just
    // because the analysis window happens to hold it.
    const thisMonth = new Date();
    const analysisOnly = {
      id: 'analysis-only',
      status: 'completed',
      start_time: thisMonth.toISOString(),
      distance_km: 40,
      score_overall: 90,
    };
    const html = renderToStaticMarkup(
      <InsightHistoryPanels
        trips={[analysisOnly]}
        calendarTrips={[]}
        monthOffset={0}
        onMonthOffsetChange={() => {}}
        settings={{}}
        units='metric'
        onOpenTrip={() => {}}
      />
    );

    expect(html).toContain('Trip calendar');
    // No drive days, because the calendar's own window returned no rows.
    expect(html).toContain('0 days');
  });
});
