import { describe, expect, it } from 'vitest';
import { defaultSpeedLimitKmhForOsmHighway, parseMaxspeedKmh } from '@/lib/speedLimitSource';
import {
  buildRoadContextPrivacyMessage,
  describeMapMatchingStatus,
  describeOsmSpeedLimitStatus,
  isExternalContextAutoFetchEnabled,
  isOsrmMapMatchingConfigured,
  PUBLIC_OSRM_DEMO_URL,
} from '@/lib/openSourceTripContext';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
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

  it('uses configured country defaults when OSM maxspeed tags are missing', () => {
    expect(defaultSpeedLimitKmhForOsmHighway('residential', { configurable_country_defaults: 'gb' })).toBe(48);
    expect(defaultSpeedLimitKmhForOsmHighway('motorway', { configurable_country_defaults: 'gb' })).toBe(112);
    expect(defaultSpeedLimitKmhForOsmHighway('motorway', { configurable_country_defaults: 'us' })).toBe(105);
    expect(defaultSpeedLimitKmhForOsmHighway('primary', {}, 'GB')).toBe(96);
    expect(defaultSpeedLimitKmhForOsmHighway('motorway', { country_code: 'DE' })).toBeNull();
    expect(defaultSpeedLimitKmhForOsmHighway('motorway', { configurable_country_defaults: 'unknown' })).toBe(100);
  });

  it('treats OSRM road matching as explicit opt-in', () => {
    expect(isOsrmMapMatchingConfigured({ map_matching_enabled: true, osrm_map_matching_url: '' })).toBe(false);
    expect(isOsrmMapMatchingConfigured({ map_matching_enabled: false, osrm_map_matching_url: 'https://example.test' })).toBe(false);
    expect(isOsrmMapMatchingConfigured({ map_matching_enabled: true, osrm_map_matching_url: 'https://example.test' })).toBe(true);
    expect(describeMapMatchingStatus({ status: 'disabled' })).toContain('sampled GPS points');
    expect(describeMapMatchingStatus({ status: 'needs_endpoint' })).toContain('OSRM endpoint');
    expect(describeMapMatchingStatus({ status: 'manual_required' })).toContain('Get Road Data');
    expect(describeOsmSpeedLimitStatus({ status: 'manual_required' })).toContain('Get Road Data');
  });

  it('describes external road-context data before manual fetch', () => {
    expect(isExternalContextAutoFetchEnabled({})).toBe(true);
    expect(isExternalContextAutoFetchEnabled({ external_context_auto_fetch_enabled: false })).toBe(false);
    expect(isExternalContextAutoFetchEnabled({ external_context_auto_fetch_enabled: true })).toBe(true);
    const message = buildRoadContextPrivacyMessage({
      speed_limit_lookup_enabled: true,
      weather_context_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://example.test',
    });
    expect(message).toContain('OpenStreetMap Overpass');
    expect(message).toContain('Open-Meteo');
    expect(message).toContain('Snap route to roads');
  });

  it('identifies the public OSRM demo endpoint and discloses it in road-context consent', () => {
    expect(PUBLIC_OSRM_DEMO_URL).toBe('https://router.project-osrm.org');
    expect(isPublicOsrmDemoUrl(PUBLIC_OSRM_DEMO_URL)).toBe(true);
    expect(isPublicOsrmDemoUrl('http://router.project-osrm.org')).toBe(true);

    const message = buildRoadContextPrivacyMessage({
      map_matching_enabled: true,
      osrm_map_matching_url: PUBLIC_OSRM_DEMO_URL,
    });

    expect(message).toContain('router.project-osrm.org');
    expect(message).toContain('public third-party OSRM demo server');
    expect(describeMapMatchingStatus({ status: 'matched', snapped_coverage: 100, isOsrmDemoUrl: true })).toContain('public OSRM demo');
  });

  it('penalizes harsh events more during risky weather', () => {
    const scores = {
      score_safety: 90,
      score_smoothness: 90,
      score_eco: 90,
      intersection_score: 90,
      score_overall: 90,
      harsh_brakes_count: 2,
      component_scores: {
        safety: { value: 90, evidence: 'high', dataSource: ['gps'] },
        overall: { value: 90, evidence: 'high', dataSource: ['gps'] },
      },
    };
    const adjusted = applyWeatherRiskToScores(scores, {
      riskScore: 70,
      riskMultiplier: 1.45,
      riskLevel: 'high',
      condition: 'freezing_precipitation',
    });
    expect(adjusted.score_safety).toBeLessThan(scores.score_safety);
    expect(adjusted.weather_score_adjustment).toBeLessThan(0);
    expect(adjusted.component_scores.safety.value).toBe(adjusted.score_safety);
    expect(adjusted.component_scores.overall.value).toBe(adjusted.score_overall);
    expect(adjusted.component_scores.overall.dataSource).toContain('open_meteo_weather');
  });

  it('keeps estimated brake-turn alerts advisory-only during risky weather', () => {
    const scores = {
      score_safety: 90,
      score_smoothness: 90,
      score_eco: 90,
      score_overall: 90,
      close_proximity_count: 2,
    };
    const adjusted = applyWeatherRiskToScores(scores, {
      riskScore: 70,
      riskMultiplier: 1.45,
      riskLevel: 'high',
    });

    expect(adjusted.score_safety).toBe(scores.score_safety);
    expect(adjusted.score_overall).toBe(scores.score_overall);
    expect(adjusted.weather_score_adjustment).toBe(0);
  });

  it('does not label unavailable weather as low risk', async () => {
    const disabled = await fetchWeatherContextForTrip([], null, null, {
      weather_context_enabled: false,
    });

    expect(disabled).toMatchObject({
      status: 'disabled',
      riskLevel: null,
      riskScore: null,
    });
    expect(applyWeatherRiskToScores({ score_safety: 90 }, disabled)).toMatchObject({
      weather_risk_score: null,
      weather_score_adjustment: 0,
    });
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
