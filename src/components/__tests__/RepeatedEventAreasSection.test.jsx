import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RepeatedEventAreasSection from '@/components/RepeatedEventAreasSection';

const zones = Array.from({ length: 7 }, (_, index) => ({
  id: `zone-${index + 1}`,
  dominantType: index % 3 === 0 ? 'harsh_brake' : index % 3 === 1 ? 'speeding' : 'sharp_turn',
  eventCount: index + 3,
  lat: 43.65 + index * 0.001,
  lng: -79.38 - index * 0.001,
  radiusM: 96,
  riskLevel: index === 0 ? 'high' : 'medium',
}));

const props = {
  canToggleAll: true,
  completedTripCount: 18,
  dangerZones: zones,
  dangerZonesReady: true,
  displayedDangerZones: zones.slice(0, 6),
  hiddenDangerZoneCount: 1,
  loading: false,
  onShowAll: vi.fn(),
  onShowOnMap: vi.fn(),
  relativeTimeFormatter: () => 'today',
  showAllDangerZones: false,
  units: 'metric',
};

describe('RepeatedEventAreasSection', () => {
  it('preserves the established standard Coaching card when premium visuals are disabled', () => {
    const html = renderToStaticMarkup(<RepeatedEventAreasSection {...props} premium={false} />);

    expect(html).toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(html).toContain('7 local areas need attention');
    expect(html).toContain('3 events in an approximately 96 m area.');
    expect(html).toContain('8 events in an approximately 96 m area.');
    expect(html).not.toContain('9 events in an approximately 96 m area.');
    expect(html).not.toContain('premium-event-areas');
    expect(html).not.toContain('Show all areas');
  });

  it('renders the data-driven premium Coaching branch only when enabled', () => {
    const html = renderToStaticMarkup(<RepeatedEventAreasSection {...props} premium />);

    expect(html).toContain('class="premium-event-areas"');
    expect(html).toContain('data-variant="coach"');
    expect(html).toContain('7 local areas need attention');
    expect(html).toContain('premium-event-area-braking-v2.webp');
    expect(html).toContain('premium-event-area-speeding-v2.webp');
    expect(html).toContain('premium-event-area-turn-v2.webp');
    expect(html).toContain('Approximately 96 m area');
    expect(html).toContain('Show all areas');
    expect(html).toContain('1 hidden');
    expect(html).not.toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
  });
});
