import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import PremiumMapTripCard, { buildPremiumMapTripCardModel } from '@/components/PremiumMapTripCard';
import { formatDate, formatTime } from '@/lib/tripEngine';

const trip = (overrides = {}) => ({
  id: 'map-trip-1',
  status: 'completed',
  start_time: '2026-07-19T18:30:00.000Z',
  distance_km: 1.4,
  score_overall: 71,
  score_confidence_label: 'high',
  score_provenance: { calibration_status: 'approximate' },
  route_points_raw_count: 79,
  route_points_map_count: 61,
  harsh_brakes_count: 2,
  sharp_turns_count: 1,
  ...overrides,
});

describe('PremiumMapTripCard', () => {
  it('builds the visual identity from score evidence and event density', () => {
    expect(buildPremiumMapTripCardModel(trip())).toMatchObject({
      confidence: 100,
      evidenceLabel: 'High evidence',
      eventCount: 3,
      mapPointLabel: '61 map/playback points',
      recordedPointLabel: '79 GPS readings',
      variant: 'orange',
    });

    expect(buildPremiumMapTripCardModel(trip({
      score_overall: 96,
      distance_km: 12,
      harsh_brakes_count: 0,
      sharp_turns_count: 0,
    })).variant).toBe('emerald');
    expect(buildPremiumMapTripCardModel(trip({ score_confidence_label: 'low' })).variant).toBe('violet');
  });

  it('makes saved night evidence authoritative over score and evidence variants', () => {
    const excellentTrip = {
      score_overall: 96,
      distance_km: 12,
      harsh_brakes_count: 0,
      sharp_turns_count: 0,
    };

    expect(buildPremiumMapTripCardModel(trip({
      ...excellentTrip,
      night_driving: true,
    }))).toMatchObject({
      timePeriod: 'night',
      variant: 'blue',
    });
    expect(buildPremiumMapTripCardModel(trip({
      ...excellentTrip,
      night_driving: false,
    }))).toMatchObject({
      timePeriod: 'day',
      variant: 'emerald',
    });
  });

  it('renders real GPS and map point counts with a selectable accessible target', () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(
      <PremiumMapTripCard trip={trip()} units="metric" selected onSelect={onSelect} />
    );

    expect(html).toContain('premium-map-trip-card');
    expect(html).toContain('premium-map-trip-orange-v2.webp');
    expect(html).toContain('premium-map-trip-emblem-orange-v2.png');
    expect(html).toContain('79 GPS readings');
    expect(html).toContain('61 map/playback points');
    expect(html).toContain('3 events');
    expect(html).toContain('High evidence');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Select trip from');
    expect(html).toContain(formatDate(trip().start_time));
    expect(html).not.toContain(formatTime(trip().start_time));
  });

  it('uses the stored summary count when route coordinates are not hydrated', () => {
    const model = buildPremiumMapTripCardModel(trip({
      route_points: undefined,
      route_points_raw_count: 72000,
      route_points_map_count: 64000,
    }));

    expect(model.recordedPointLabel).toBe('72,000 GPS readings');
    expect(model.mapPointLabel).toBe('64,000 map/playback points');
  });

  it('ships deliberate light, dark, mobile, and reduced-motion treatments', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(css).toContain('.premium-map-trip-card {');
    expect(css).toContain('.dark .premium-map-trip-card');
    expect(css).toContain('@media (max-width: 480px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('--premium-map-trip-confidence');
  });
});
