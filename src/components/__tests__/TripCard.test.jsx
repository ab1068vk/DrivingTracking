import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import TripCard from '@/components/TripCard';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }) => <div {...props}>{children}</div>,
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const trip = (calibrationStatus) => ({
  id: 'trip-card-1',
  status: 'completed',
  start_time: '2026-05-01T08:00:00.000Z',
  end_time: '2026-05-01T08:20:00.000Z',
  distance_km: 12,
  duration_seconds: 1200,
  avg_speed_kmh: 36,
  score_overall: 88,
  score_provenance: {
    calibration_status: calibrationStatus,
  },
});

describe('TripCard score provenance display', () => {
  it('prefixes approximate trip scores with a tilde', () => {
    const html = renderToStaticMarkup(<TripCard trip={trip('approximate')} />);

    expect(html).toContain('~88');
  });

  it('does not prefix calibrated trip scores with a tilde', () => {
    const html = renderToStaticMarkup(<TripCard trip={trip('calibrated')} />);

    expect(html).toContain('>88</span>');
    expect(html).not.toContain('~88');
  });

  it('uses separate labeled buttons for opening and favoriting a trip', () => {
    const html = renderToStaticMarkup(<TripCard trip={trip('approximate')} />);

    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Open trip: Untitled trip"');
    expect(html).toContain('aria-label="Add Untitled trip to favorites"');
  });

  it('shows a direct parked speed-limit review action when a trip is flagged', () => {
    const html = renderToStaticMarkup(<TripCard trip={{
      ...trip('calibrated'),
      speed_limit_review_required: true,
    }} />);

    expect(html).toContain('Review speed');
    expect(html).toContain('aria-label="Review speed limits for Untitled trip"');
  });

  it('hides the speed-limit review action after the trip review was resolved', () => {
    const html = renderToStaticMarkup(<TripCard trip={{
      ...trip('calibrated'),
      speed_limit_review_required: true,
      speed_limit_review_resolved_at: '2026-05-01T09:00:00.000Z',
    }} />);

    expect(html).not.toContain('Review speed');
    expect(html).not.toContain('aria-label="Review speed limits for Untitled trip"');
  });

  it('labels trips with differential privacy aggregate noise', () => {
    const html = renderToStaticMarkup(<TripCard trip={{ ...trip('calibrated'), _dpApplied: true }} />);

    expect(html).toContain('Privacy-estimated near protected zones');
  });

  it('shows a locally confirmed clear condition on compact trip cards', () => {
    const html = renderToStaticMarkup(<TripCard compact trip={{
      ...trip('calibrated'),
      tags: ['city'],
      weather_context: {
        source: 'user_confirmed',
        condition: 'clear',
      },
    }} />);

    expect(html).toContain('title="Weather: Clear (confirmed by you)"');
    expect(html).toContain('>Clear</span>');
  });

  it('uses the saved weather badge instead of duplicating a derived rain tag', () => {
    const html = renderToStaticMarkup(<TripCard compact trip={{
      ...trip('calibrated'),
      tags: ['city', 'rain'],
      tag_sources: {
        rain: { source: 'weather_evidence' },
      },
      weather_context: {
        source: 'open_meteo',
        condition: 'rain',
      },
    }} />);

    expect(html.match(/>Rain<\/span>/g)).toHaveLength(1);
    expect(html).toContain('title="Weather: Rain (Open-Meteo)"');
  });

  it('labels trips whose route data expired while keeping the summary', () => {
    const html = renderToStaticMarkup(<TripCard trip={{
      ...trip('calibrated'),
      route_data_expired_at: '2026-06-01T00:00:00.000Z',
      route_data_retention_days: 90,
    }} />);

    expect(html).toContain('Route expired - summary kept');
    expect(html).toContain('Raw GPS retention removed the route coordinates');
  });

  it('shows confirmed phone-use windows in the compact event badges', () => {
    const html = renderToStaticMarkup(<TripCard trip={{
      ...trip('calibrated'),
      phone_use_score_available: true,
      phone_use_score_status: 'android_usage_access',
      phone_use_window_count: 1,
    }} />);

    expect(html).toContain('1 phone');
    expect(html).toContain('1 moving foreground-app window');
  });

  it('does not show diagnostic GPS phone proxy windows as confirmed phone use', () => {
    const html = renderToStaticMarkup(<TripCard trip={{
      ...trip('calibrated'),
      phone_use_score_available: false,
      phone_use_score_status: 'usage_access_required',
      phone_use_window_count: 1,
      phone_use_events: [{
        type: 'phone_use',
        source: 'gps_proxy',
        diagnostic_only: true,
      }],
    }} />);

    expect(html).not.toContain('1 phone');
    expect(html).not.toContain('moving foreground-app window');
  });

  it('renders the time-aware premium card only when explicitly enabled', () => {
    const standardHtml = renderToStaticMarkup(<TripCard trip={trip('calibrated')} />);
    const premiumHtml = renderToStaticMarkup(<TripCard premium trip={{
      ...trip('calibrated'),
      start_time: new Date(2026, 6, 18, 19, 30).toISOString(),
      route_replay_available: true,
      harsh_brakes_count: 2,
    }} scoreDelta={{ delta: 8, direction: 'up', sampleCount: 5 }} />);

    expect(standardHtml).not.toContain('premium-trip-card');
    expect(premiumHtml).toContain('premium-trip-card');
    expect(premiumHtml).toContain('data-time="dusk"');
    expect(premiumHtml).toContain('data-scene="dusk"');
    expect(premiumHtml).toContain('data-score-tone="excellent"');
    expect(premiumHtml).toContain('premium-trip-emblem-dusk-v2.webp');
    expect(premiumHtml).toContain('8 vs last 5');
    expect(premiumHtml).toContain('2 events');
    expect(premiumHtml).toContain('Open 3D replay for Untitled trip');
  });

  it('ships the layout rules required to render the premium markup as a card', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(css).toContain('.premium-trip-card {');
    expect(css).toContain('.premium-trip-scene {');
    expect(css).toContain('.premium-trip-content {');
    expect(css).toContain('.premium-trip-open-target {');
    expect(css).toContain('overflow: hidden;');
    expect(css).toContain('border-radius: 1.75rem;');
  });

  it.each([
    [58, 'dusk-caution', 'premium-trip-emblem-dusk-caution-v2.webp'],
    [49, 'dusk-risk', 'premium-trip-emblem-dusk-risk-v2.webp'],
    [20, 'dusk-risk', 'premium-trip-emblem-dusk-risk-v2.webp'],
  ])('selects score %i as the dusk %s scene', (score, scene, emblem) => {
    const html = renderToStaticMarkup(<TripCard premium trip={{
      ...trip('calibrated'),
      start_time: new Date(2026, 6, 18, 19, 19).toISOString(),
      score_overall: score,
    }} />);

    expect(html).toContain(`data-scene="${scene}"`);
    expect(html).toContain(emblem);
  });

  it.each([
    [6, 'dawn', 'premium-trip-emblem-dawn-v2.webp'],
    [12, 'day', 'premium-trip-emblem-day-v2.webp'],
    [19, 'dusk', 'premium-trip-emblem-dusk-v2.webp'],
    [23, 'night', 'premium-trip-emblem-night-v2.webp'],
  ])('selects local hour %i as the generated %s emblem', (hour, scene, emblem) => {
    const html = renderToStaticMarkup(<TripCard premium trip={{
      ...trip('calibrated'),
      start_time: new Date(2026, 6, 18, hour, 30).toISOString(),
    }} />);

    expect(html).toContain(`data-scene="${scene}"`);
    expect(html).toContain(emblem);
  });

  it('selects the red dusk scene for a fair score with high event density', () => {
    const html = renderToStaticMarkup(<TripCard premium trip={{
      ...trip('calibrated'),
      start_time: new Date(2026, 6, 18, 19, 45).toISOString(),
      score_overall: 59,
      distance_km: 1.9,
      harsh_brakes_count: 2,
      rapid_accel_count: 1,
      sharp_turns_count: 1,
    }} />);

    expect(html).toContain('data-scene="dusk-risk"');
    expect(html).toContain('4 events');
  });
});
