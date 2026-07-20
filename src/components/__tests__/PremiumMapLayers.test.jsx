import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumMapLayers, { getPremiumSpeedLayerStatus } from '@/components/PremiumMapLayers';

const trip = {
  id: 'trip-1',
  route_points: [{ lat: 43.1, lng: -79.1 }, { lat: 43.2, lng: -79.2 }],
  speed_limit_context: { status: 'not_fetched' },
  map_matching_context: { status: 'disabled' },
};

const baseProps = {
  selectedTrip: null,
  selectedRouteReady: false,
  selectedHasLocalSpeedLimits: false,
  selectedHasSpeedLimits: false,
  selectedSpeedLimitCoverage: 0,
  selectedSpeedLimitStatus: 'not_fetched',
  selectedMapMatchingStatus: 'not_fetched',
  selectedRiskSegmentCount: 0,
  visibleDangerZoneCount: 0,
  dangerZonesLoading: false,
  speedLimitLookupEnabled: true,
  showSpeedLimits: false,
  showRouteRisk: false,
  showDangerZones: false,
  speedLayerDisabled: true,
  roadDataPending: false,
  roadDataError: '',
  osmFetchStatus: '',
  selectedLayerEffect: 'No extra road context has been applied.',
  osrmConfigured: false,
  settings: {},
  onSpeedLayer: vi.fn(),
  onRouteRiskLayer: vi.fn(),
  onDangerZoneLayer: vi.fn(),
  onFetchRoadData: vi.fn(),
};

describe('PremiumMapLayers', () => {
  it('renders the premium empty state with all three generated artworks and real zero values', () => {
    const html = renderToStaticMarkup(<PremiumMapLayers {...baseProps} />);

    expect(html).toContain('premium-map-layers-card');
    expect(html).toContain('Customize what appears on your map');
    expect(html.match(/Select a trip first/g).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('0 local areas');
    expect(html).toContain('premium-map-layer-speed.webp');
    expect(html).toContain('premium-map-layer-repeated-route.webp');
    expect(html).toContain('premium-map-layer-event-areas.webp');
    expect(html.match(/lucide-lock-keyhole/g)).toHaveLength(2);
    expect(html.match(/Trip required/g).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('premium-map-road-data');
  });

  it('renders selected-trip layer states, long coverage, and the road-data controls', () => {
    const html = renderToStaticMarkup(
      <PremiumMapLayers
        {...baseProps}
        selectedTrip={trip}
        selectedRouteReady
        selectedHasSpeedLimits
        selectedSpeedLimitCoverage={100}
        selectedSpeedLimitStatus="complete_with_saved_local_knowledge"
        selectedRiskSegmentCount={12450}
        visibleDangerZoneCount={9876}
        speedLayerDisabled={false}
        showSpeedLimits
        showRouteRisk
        showDangerZones
      />,
    );

    expect(html).toContain('Fine-tune overlays for this selected trip');
    expect(html).toContain('100% coverage - tap to show or hide');
    expect(html).toContain('12,450 matched segments');
    expect(html).toContain('9,876 local areas');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).toContain('Get Road Data, in plain words');
    expect(html).toContain('Privacy-zone coordinates are excluded');
    expect(html).toContain('complete with saved local knowledge');
  });

  it('derives loading, saved, disabled, and fetchable speed-layer status without demo values', () => {
    expect(getPremiumSpeedLayerStatus({ ...baseProps })).toBe('Select a trip first');
    expect(getPremiumSpeedLayerStatus({ ...baseProps, selectedTrip: trip })).toBe('Loading route data');
    expect(getPremiumSpeedLayerStatus({ ...baseProps, selectedTrip: trip, selectedRouteReady: true, selectedHasLocalSpeedLimits: true })).toContain('Saved local speeds');
    expect(getPremiumSpeedLayerStatus({ ...baseProps, selectedTrip: trip, selectedRouteReady: true, speedLimitLookupEnabled: false })).toContain('off in Settings');
    expect(getPremiumSpeedLayerStatus({ ...baseProps, selectedTrip: trip, selectedRouteReady: true, roadDataPending: true, osmFetchStatus: 'Fetching box 2 of 4' })).toBe('Fetching box 2 of 4');
  });

  it('shows the real area-loading state instead of presenting a temporary zero', () => {
    const html = renderToStaticMarkup(<PremiumMapLayers {...baseProps} dangerZonesLoading />);

    expect(html).toContain('Checking local areas...');
    expect(html).not.toContain('Repeated event areas. 0 local areas');
  });

  it('labels a selected but settings-disabled speed layer as locked', () => {
    const html = renderToStaticMarkup(
      <PremiumMapLayers
        {...baseProps}
        selectedTrip={trip}
        selectedRouteReady
        speedLimitLookupEnabled={false}
        speedLayerDisabled
        settings={{ speed_limit_lookup_enabled: false }}
      />,
    );

    expect(html).toContain('OpenStreetMap speed-limit lookup is off in Settings');
    expect(html).toContain('Settings off');
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain('lucide-lock-keyhole');
  });
});
