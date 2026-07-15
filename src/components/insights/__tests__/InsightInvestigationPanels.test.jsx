import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/TripMap', () => ({
  default: ({ routes = [] }) => (
    <div data-testid="embedded-trip-map" data-route-count={routes.length}>
      Embedded map
    </div>
  ),
}));

import { GeographicInvestigationWorkspace } from '@/components/insights/InsightInvestigationPanels';

describe('GeographicInvestigationWorkspace', () => {
  it('renders stored routes directly when no detailed events exist', () => {
    const html = renderToStaticMarkup(
      <GeographicInvestigationWorkspace
        intelligence={{ eventEvidence: [] }}
        hotspots={[]}
        trips={[{
          id: 'stored-route',
          status: 'completed',
          start_time: '2026-07-10T08:00:00.000Z',
          distance_km: 12.4,
          score_overall: 84,
          route_points: [
            { lat: 43.65, lng: -79.38 },
            { lat: 43.66, lng: -79.37 },
          ],
        }]}
        onOpenTrip={() => {}}
        onOpenFullMap={() => {}}
      />
    );

    expect(html).toContain('Loading evidence map...');
    expect(html).toContain('Selected stored route');
    expect(html).toContain('replayable routes but no stored exact event records');
  });
});
