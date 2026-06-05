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
});
