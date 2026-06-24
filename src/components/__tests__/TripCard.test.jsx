import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

  it('labels trips with differential privacy aggregate noise', () => {
    const html = renderToStaticMarkup(<TripCard trip={{ ...trip('calibrated'), _dpApplied: true }} />);

    expect(html).toContain('Privacy-estimated near protected zones');
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
    expect(html).toContain('1 confirmed phone-use window');
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
    expect(html).not.toContain('confirmed phone-use window');
  });
});
