import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PremiumEventAreasCard, { buildPremiumEventAreaViewModel } from '@/components/PremiumEventAreasCard';

const zones = [
  {
    id: 'braking-zone',
    dominantType: 'harsh_brake',
    eventCount: 12,
    lat: 43.6532,
    lng: -79.3832,
    riskLevel: 'critical',
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
    expect(html).toContain('premium-event-areas-hero.png');
    expect(html).toContain('premium-event-area-braking.png');
    expect(html).toContain('premium-event-area-speeding.png');
    expect(html).toContain('premium-event-area-turn.png');
    expect(html).toContain('Harsh braking');
    expect(html).toContain('Speeding');
    expect(html).toContain('Sharp turn');
    expect(html).toContain('43.6532, -79.3832');
    expect(html).toContain('Last seen yesterday');
    expect(html).toContain('Show all areas');
    expect(html).toContain('4 hidden');
  });

  it('preserves loading, zero-data, and privacy-hidden messages with live counts', () => {
    const loadingHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} dangerZonesReady={false} loading />);
    expect(loadingHtml).toContain('Checking your driving history');
    expect(loadingHtml).toContain('role="status"');

    const emptyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={987654} />);
    expect(emptyHtml).toContain('987654');
    expect(emptyHtml).toContain('No repeated area has enough evidence yet.');
    expect(emptyHtml).toContain('roughly <b>80-metre</b> cells');

    const privacyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={9} hiddenAreaCount={3} />);
    expect(privacyHtml).toContain('Your privacy zones are working.');
    expect(privacyHtml).toContain('3 repeated driving-event areas are hidden');

    const noTripsHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} completedTripCount={0} />);
    expect(noTripsHtml).toContain('No completed trips with event-location evidence are available yet.');
    expect(noTripsHtml).not.toContain('Stay aware.');
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
      visibleDangerZoneCount: 7,
    });
    const mapButton = findElements(populatedTree, (node) => node.props?.className === 'premium-event-areas-map-button')[0];
    const moreButton = findElements(populatedTree, (node) => node.props?.className === 'premium-event-areas-more')[0];
    expect(mapButton.props.disabled).toBe(false);
    mapButton.props.onClick();
    moreButton.props.onClick();
    expect(onShowOnMap).toHaveBeenCalledOnce();
    expect(onShowAll).toHaveBeenCalledOnce();

    const emptyHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} />);
    expect(emptyHtml).toContain('class="premium-event-areas-map-button" disabled=""');
    expect(emptyHtml).toContain('Show on map unavailable. No areas to map.');
    expect(emptyHtml).toContain('<small>No areas to map</small>');

    const loadingHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} dangerZonesReady={false} loading />);
    expect(loadingHtml).toContain('Show on map unavailable. Areas are still loading.');

    const privateHtml = renderToStaticMarkup(<PremiumEventAreasCard {...baseProps} hiddenAreaCount={3} />);
    expect(privateHtml).toContain('Show on map unavailable. All areas are private.');
  });
});
