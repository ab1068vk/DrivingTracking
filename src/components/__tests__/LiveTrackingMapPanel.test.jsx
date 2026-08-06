import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-query', () => ({
  useQueries: () => [],
}));

vi.mock('@/api/trips', () => ({
  tripDetailQueryOptions: (id) => ({ queryKey: ['trip', id] }),
}));

vi.mock('@/lib/localSpeedKnowledge', () => ({
  LocalSpeedKnowledge: class { },
}));

vi.mock('@/lib/speedKnowledgeRepository', () => ({
  speedKnowledgeStore: {},
}));

vi.mock('@/lib/tripEngine', async () => {
  const actual = await vi.importActual('@/lib/tripEngine');
  return { ...actual, prefetchLocalKnowledge: vi.fn(async () => []) };
});

const { default: LiveTrackingMapPanel, liveCurrentLocation } = await import('@/components/tracking/LiveTrackingMapPanel');

const snapshotWith = (routePreview, routeMaskedCount = 0) => ({
  routePreview,
  routeMaskedCount,
  routePointCount: routePreview.length,
});

const drivenRoute = [
  { lat: 43.650, lng: -79.380, speed_kmh: 30 },
  { lat: 43.651, lng: -79.379, speed_kmh: 42 },
  { lat: 43.652, lng: -79.378, speed_kmh: 47 },
];

describe('liveCurrentLocation', () => {
  it('returns the most recent usable fix', () => {
    expect(liveCurrentLocation(drivenRoute)).toEqual({ lat: 43.652, lng: -79.378, accuracy: null });
  });

  it('skips privacy-masked and gap points so the marker never lands inside a masked zone', () => {
    const route = [
      ...drivenRoute,
      { lat: 43.653, lng: -79.377, masked_for_privacy: true },
      { lat: 43.654, lng: -79.376, tracking_gap: true },
      { lat: 43.655, lng: -79.375, route_gap: true },
    ];
    expect(liveCurrentLocation(route)).toEqual({ lat: 43.652, lng: -79.378, accuracy: null });
  });

  it('returns null when no point carries usable coordinates', () => {
    expect(liveCurrentLocation([])).toBeNull();
    expect(liveCurrentLocation([{ lat: null, lng: null }])).toBeNull();
    expect(liveCurrentLocation([{ lat: 43.65, lng: -79.38, masked_for_privacy: true }])).toBeNull();
  });

  it('carries accuracy through when the fix reports it', () => {
    expect(liveCurrentLocation([{ lat: 1, lng: 2, accuracy: 12 }])).toEqual({ lat: 1, lng: 2, accuracy: 12 });
  });
});

describe('LiveTrackingMapPanel', () => {
  it('falls back to the offline SVG trace when fewer than two points are plottable', () => {
    const markup = renderToStaticMarkup(
      <LiveTrackingMapPanel snapshot={snapshotWith([drivenRoute[0]])} />
    );
    expect(markup).toContain('Route trace is waiting for at least two public GPS samples.');
    expect(markup).toContain('1 plottable of 1 preview samples');
  });

  it('treats masked points as unplottable rather than drawing through them', () => {
    const route = [drivenRoute[0], { lat: 43.651, lng: -79.379, masked_for_privacy: true }];
    const markup = renderToStaticMarkup(<LiveTrackingMapPanel snapshot={snapshotWith(route, 1)} />);
    expect(markup).toContain('Route trace is waiting for at least two public GPS samples.');
    expect(markup).toContain('1 privacy-masked');
  });

  it('hands the route to the map once two points are plottable', () => {
    const markup = renderToStaticMarkup(<LiveTrackingMapPanel snapshot={snapshotWith(drivenRoute)} />);
    expect(markup).not.toContain('Route trace is waiting for at least two public GPS samples.');
    expect(markup).toContain('3 plottable of 3 preview samples');
    expect(markup).toContain('Mapped route');
  });

  it('offers offline, repeat-risk, and speed-limit layer controls', () => {
    const markup = renderToStaticMarkup(<LiveTrackingMapPanel snapshot={snapshotWith(drivenRoute)} />);
    expect(markup).toContain('Map tiles on');
    expect(markup).toContain('Repeat risk');
    expect(markup).toContain('Speed limits');
  });

  it('defaults the history-reading overlays to off so a drive does not pay for them', () => {
    const markup = renderToStaticMarkup(<LiveTrackingMapPanel snapshot={snapshotWith(drivenRoute)} />);
    const buttonStart = markup.lastIndexOf('<button', markup.indexOf('Repeat risk'));
    const riskToggle = markup.slice(buttonStart, markup.indexOf('Repeat risk'));
    expect(riskToggle).toContain('aria-pressed="false"');

    const limitsStart = markup.lastIndexOf('<button', markup.indexOf('Speed limits'));
    expect(markup.slice(limitsStart, markup.indexOf('Speed limits'))).toContain('aria-pressed="false"');
  });

  it('renders without a snapshot rather than crashing the cockpit', () => {
    expect(() => renderToStaticMarkup(<LiveTrackingMapPanel snapshot={null} />)).not.toThrow();
  });
});
