import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumEventAreasCard, {
  buildPremiumEventAreaTypeSummaries,
  buildPremiumEventAreaViewModel,
} from '@/components/PremiumEventAreasCard';

const zones = [
  {
    id: 'braking-zone',
    dominantType: 'harsh_brake',
    eventCount: 12,
    lat: 43.6532,
    lng: -79.3832,
    riskLevel: 'critical',
    radiusM: 96,
    severityScore: 19,
    lastSeen: '2026-07-18T12:00:00.000Z',
  },
  {
    id: 'speed-zone',
    dominantType: 'speeding',
    eventCount: 4,
    lat: 43.7001,
    lng: -79.4012,
    riskLevel: 'high',
    severityScore: 9,
  },
  {
    id: 'turn-zone',
    dominantType: 'sharp_turn',
    eventCount: 2,
    lat: 43.6111,
    lng: -79.4222,
    riskLevel: 'medium',
    severityScore: 4,
  },
];

const baseProps = {
  canToggleAll: false,
  completedTripCount: 60,
  dangerZonesReady: true,
  displayedDangerZones: [],
  hiddenAreaCount: 0,
  hiddenDangerZoneCount: 0,
  loading: false,
  onShowAll: vi.fn(),
  onShowOnMap: vi.fn(),
  relativeTimeFormatter: () => 'yesterday',
  showAllDangerZones: false,
  units: 'metric',
  variant: 'coach',
  visibleDangerZoneCount: 0,
};

function findElements(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  React.Children.forEach(node.props?.children, (child) => findElements(child, predicate, found));
  return found;
}

describe('PremiumEventAreasCard', () => {
  it('normalizes live danger-zone values without replacing them with demo data', () => {
    expect(buildPremiumEventAreaViewModel(zones[0])).toMatchObject({
      coordLabel: '43.6532, -79.3832',
      areaLabel: 'Approximately 96 m area',
      eventCount: 12,
      evidenceDots: 5,
      label: 'Harsh braking',
      riskLabel: 'critical event level',
      tone: 'braking',
    });
    expect(buildPremiumEventAreaViewModel({
      dominantType: 'unexpected_sensor_event',
      eventCount: 123456789,
      lat: 'invalid',
      lng: null,
      riskLevel: 'unexpected',
    })).toMatchObject({
      coordLabel: 'Location unavailable',
      eventCount: 123456789,
      label: 'Unexpected Sensor Event',
      riskLevel: 'low',
    });
    expect(buildPremiumEventAreaViewModel(zones[0], 'imperial').areaLabel).toBe('Approximately 0.1 mi area');
  });

  it('derives the three reference summary counts from learned areas', () => {
    expect(buildPremiumEventAreaTypeSummaries([
      ...zones,
      { ...zones[0], id: 'second-braking-zone', eventCount: 7 },
      { id: 'ignored', dominantType: 'rapid_accel', eventCount: 999 },
    ]).map(({ type, areaCount, eventCount }) => ({ type, areaCount, eventCount }))).toEqual([
      { type: 'harsh_brake', areaCount: 2, eventCount: 19 },
      { type: 'speeding', areaCount: 1, eventCount: 4 },
      { type: 'sharp_turn', areaCount: 1, eventCount: 2 },
    ]);
  });

  it('renders distinct generated artwork and real values for every supported event card', () => {
    const html = renderToStaticMarkup(<PremiumEventAreasCard
      {...baseProps}
      canToggleAll
      displayedDangerZones={zones}
      hiddenDangerZoneCount={4}
      visibleDangerZoneCount={7}
    />);

    expect(html).toContain('premium-event-areas');
    expect(html).toContain('data-accent="braking"');
    expect(html).toContain('data-risk="critical"');
    expect(html).toContain('premium-event-areas-shield-v3.webp');
    expect(html).toContain('premium-event-area-braking-v2.webp');
    expect(html).toContain('premium-event-area-speeding-v2.webp');
    expect(html).toContain('premium-event-area-turn-v2.webp');
    expect(html).toContain('Approximately 96 m area');
    expect(html).toContain('Harsh braking');
    expect(html).toContain('Speeding');
    expect(html).toContain('Sharp turn');
    expect(html).toContain('43.6532, -79.3832');
    expect(html).toContain('Last seen yesterday');
    expect(html).toContain('<strong>7</strong> areas');
    expect(html).toContain('<strong>60</strong> trips checked');
    expect(html).toContain('<strong>12</strong> events in the leading area');
    expect(html).toContain('Show all areas');
    expect(html).toContain('4 hidden');
  });

  it('preserves loading, zero-data, and privacy-hidden messages with live counts', () => {
    const loadingHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} dangerZonesReady={false} loading />);
    expect(loadingHtml).toContain('Checking your driving history');
    expect(loadingHtml).toContain('role="status"');

    const emptyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={987654} />);
    expect(emptyHtml).toContain('987654');
    expect(emptyHtml).toContain('No repeated event area has enough evidence yet');
    expect(emptyHtml).toContain('premium-event-areas-shield-v3.webp');
    expect(emptyHtml).not.toContain('premium-event-areas-map-button');
    expect(emptyHtml).toContain('all 987654 completed trips have been checked');
    expect(emptyHtml).toContain('<strong>987654</strong> trips checked');

    const privacyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={9} hiddenAreaCount={3} />);
    expect(privacyHtml).toContain('3 repeated event areas stay private');
    expect(privacyHtml).toContain('3 repeated driving-event areas are hidden');

    const noTripsHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={0} />);
    expect(noTripsHtml).toContain('Complete a trip with event-location evidence to start building your private pattern.');
    expect(noTripsHtml).not.toContain('Stay aware.');
  });

  it('uses the reference-led highway composition and honest type totals in the map variant', () => {
    const mapHtml = renderToStaticMarkup(<PremiumEventAreasCard
      {...baseProps}
      dangerZones={zones}
      displayedDangerZones={zones}
      variant="map"
      visibleDangerZoneCount={zones.length}
    />);
    expect(mapHtml).toContain('Repeated Driving-Event Areas');
    expect(mapHtml).toContain('Your repeated harsh-braking, speeding, or sharp-turn locations');
    expect(mapHtml).toContain('premium-event-areas-highway-v7.webp');
    expect(mapHtml).toContain('premium-event-areas-evidence-shell');
    expect(mapHtml).toContain('<polyline');
    expect(mapHtml).toContain('premium-event-areas-shield-wheel-v4.webp');
    expect(mapHtml).toContain('premium-event-areas-trip-map-v4.webp');
    expect(mapHtml).toContain('Repeated driving-event area totals by type');
    expect(mapHtml).toContain('Harsh braking. 1 learned area, 12 qualifying events.');
    expect(mapHtml).toContain('Speeding. 1 learned area, 4 qualifying events.');
    expect(mapHtml).toContain('Sharp turns. 1 learned area, 2 qualifying events.');
    expect(mapHtml).toContain('Each area contains at least <b>3</b>');
    expect(mapHtml).not.toContain('premium-event-areas-shield-v3.webp');
    expect(mapHtml).not.toContain('Coordinates stay in the existing private map workflow');
  });

  it('keeps map and overflow controls wired and disables map access without visible areas', () => {
    const onShowOnMap = vi.fn();
    const onShowAll = vi.fn();
    const populatedTree = PremiumEventAreasCard({
      ...baseProps,
      canToggleAll: true,
      displayedDangerZones: zones,
      hiddenDangerZoneCount: 4,
      onShowAll,
      onShowOnMap,
      variant: 'map',
      visibleDangerZoneCount: 7,
    });
    const mapButton = findElements(populatedTree, (node) => node.props?.className === 'premium-event-areas-map-button')[0];
    const moreButton = findElements(populatedTree, (node) => node.props?.className === 'premium-event-areas-more')[0];
    expect(mapButton.props.disabled).toBe(false);
    mapButton.props.onClick();
    moreButton.props.onClick();
    expect(onShowOnMap).toHaveBeenCalledOnce();
    expect(onShowAll).toHaveBeenCalledOnce();

    const emptyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} variant="map" />);
    expect(emptyHtml).toContain('class="premium-event-areas-map-button" disabled=""');
    expect(emptyHtml).toContain('Show on map unavailable. No areas to map.');
    expect(emptyHtml).toContain('<small>No areas to map</small>');
    expect(emptyHtml).toContain('Harsh braking. 0 learned areas, 0 qualifying events.');
    expect(emptyHtml).toContain('No small map area has at least <b>3</b>');

    const loadingHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} dangerZonesReady={false} loading variant="map" />);
    expect(loadingHtml).toContain('Show on map unavailable. Areas are still loading.');

    const privateHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} hiddenAreaCount={3} variant="map" />);
    expect(privateHtml).toContain('Show on map unavailable. All areas are private.');
  });
});
