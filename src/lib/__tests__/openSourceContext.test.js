import { describe, expect, it } from 'vitest';
import { defaultSpeedLimitKmhForOsmHighway, parseMaxspeedKmh } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores } from '@/lib/weatherContext';
import { maskTripForPrivacy } from '@/lib/privacyZones';

describe('open-source trip context', () => {
  it('parses common OSM maxspeed formats', () => {
    expect(parseMaxspeedKmh('50')).toBe(50);
    expect(parseMaxspeedKmh('30 mph')).toBe(48);
    expect(parseMaxspeedKmh('signals')).toBeNull();
  });

  it('maps OSM highway tags to urban default speed limits', () => {
    expect(defaultSpeedLimitKmhForOsmHighway('residential')).toBe(40);
    expect(defaultSpeedLimitKmhForOsmHighway('secondary')).toBe(60);
    expect(defaultSpeedLimitKmhForOsmHighway('motorway')).toBe(100);
    expect(defaultSpeedLimitKmhForOsmHighway('unclassified')).toBe(50);
  });

  it('penalizes harsh events more during risky weather', () => {
    const scores = {
      score_safety: 90,
      score_smoothness: 90,
      score_eco: 90,
      intersection_score: 90,
      score_overall: 90,
      harsh_brakes_count: 2,
    };
    const adjusted = applyWeatherRiskToScores(scores, {
      riskScore: 70,
      riskMultiplier: 1.45,
      riskLevel: 'high',
      condition: 'freezing_precipitation',
    });
    expect(adjusted.score_safety).toBeLessThan(scores.score_safety);
    expect(adjusted.weather_score_adjustment).toBeLessThan(0);
  });

  it('clips route coordinates to privacy-zone boundaries and hides private events', () => {
    const trip = {
      distance_km: 3.2,
      route_points: [{ lat: 43.65, lng: -79.38 }, { lat: 43.66, lng: -79.39 }],
      driving_events: [{ type: 'harsh_brake', lat: 43.65, lng: -79.38 }],
    };
    const masked = maskTripForPrivacy(trip, {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 250 }],
    });
    expect(masked.distance_km).toBe(3.2);
    expect(masked.route_points).toHaveLength(2);
    expect(masked.route_points[0].lat).not.toBeNull();
    expect(masked.route_points[0].privacy_boundary).toBe(true);
    expect(masked.driving_events).toHaveLength(0);
    expect(masked.route_points[1].lat).toBe(43.66);
  });
});
