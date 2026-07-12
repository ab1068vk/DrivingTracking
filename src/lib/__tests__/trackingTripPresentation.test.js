import { describe, expect, it } from 'vitest';
import {
  trackingTripEventCount,
  trackingTripEvidenceStatus,
  trackingTripRoutePointCount,
  trackingTripRouteStatus,
} from '@/lib/trackingTripPresentation';

describe('tracking trip presentation', () => {
  it('describes retained route evidence without using a score', () => {
    const trip = { route_points: [{ lat: 1, lng: 2 }, { lat: 2, lng: 3 }], score_overall: 42 };
    expect(trackingTripRoutePointCount(trip)).toBe(2);
    expect(trackingTripRouteStatus(trip)).toMatchObject({ key: 'retained', label: 'Route retained' });
    expect(trackingTripEvidenceStatus(trip)).toMatchObject({ key: 'recorded', label: 'Evidence recorded' });
  });

  it('identifies privacy and expired-route limitations', () => {
    expect(trackingTripRouteStatus({ privacy_mode: 'summary_only' }).key).toBe('privacy');
    expect(trackingTripEvidenceStatus({ privacy_mode: 'summary_only' }).key).toBe('limited');
    expect(trackingTripRouteStatus({ route_data_expired_at: '2026-01-01' }).key).toBe('expired');
  });

  it('counts retained event collections before summary fallbacks', () => {
    expect(trackingTripEventCount({ driving_events: [{}, {}], phone_use_events: [{}], event_count: 99 })).toBe(3);
    expect(trackingTripEventCount({ driving_events_count: 4 })).toBe(4);
  });
});
