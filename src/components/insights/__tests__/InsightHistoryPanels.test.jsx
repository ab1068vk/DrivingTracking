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
});
