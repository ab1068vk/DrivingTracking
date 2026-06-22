import { describe, expect, it, vi } from 'vitest';
import { defaultSpeedLimitKmhForOsmHighway, parseMaxspeedKmh } from '@/lib/speedLimitSource';
import {
  buildPrivacySafeOsrmRoute,
  buildOpenSourceTripContextPatch,
  buildRoadDataDisabledMessage,
  buildRoadContextPrivacyMessage,
  describeMapMatchingStatus,
  describeOsmSpeedLimitStatus,
  isExternalContextAutoFetchEnabled,
  isOsrmMapMatchingConfigured,
  isRoadDataLookupConfigured,
  PUBLIC_OSRM_DEMO_URL,
} from '@/lib/openSourceTripContext';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { createPrivacyCellHashes, maskTripForPrivacy } from '@/lib/privacyZones';

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
    expect(isOsrmMapMatchingConfigured({ map_matching_enabled: true, osrm_map_matching_url: 'https://example.test' })).toBe(false);
    expect(isOsrmMapMatchingConfigured({ map_matching_enabled: true, osrm_map_matching_url: 'https://example.test', osrm_data_sharing_consented: true })).toBe(true);
    expect(describeMapMatchingStatus({ status: 'disabled' })).toContain('sampled GPS points');
    expect(describeMapMatchingStatus({ status: 'needs_endpoint' })).toContain('OSRM endpoint');
    expect(describeMapMatchingStatus({ status: 'needs_consent' })).toContain('consent');
    expect(describeMapMatchingStatus({ status: 'manual_required' })).toContain('Get Road Data');
    expect(describeOsmSpeedLimitStatus({ status: 'manual_required' })).toContain('Get Road Data');
    expect(describeOsmSpeedLimitStatus({ status: 'empty_route', skipped_reason: 'all_points_private' })).toContain('privacy-zone guard');
    expect(describeOsmSpeedLimitStatus({ status: 'empty_route', skipped_reason: 'privacy_bounds_overlap' })).toContain('overlap a privacy-zone guard');
  });

  it('describes external road-context data before manual fetch', () => {
    expect(isExternalContextAutoFetchEnabled({})).toBe(false);
    expect(isExternalContextAutoFetchEnabled({ external_context_auto_fetch_enabled: false })).toBe(false);
    expect(isExternalContextAutoFetchEnabled({ external_context_auto_fetch_enabled: true })).toBe(false);
    expect(isExternalContextAutoFetchEnabled({
      external_context_auto_fetch_enabled: true,
      external_context_auto_fetch_consented_at: '2026-06-07T12:00:00.000Z',
    })).toBe(true);
    const message = buildRoadContextPrivacyMessage({
      speed_limit_lookup_enabled: true,
      weather_context_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });
    expect(message).toContain('OpenStreetMap');
    expect(message).toContain('Open-Meteo');
    expect(message).toContain('Snap route to roads');
    expect(message).not.toContain('allowed for OSRM');
  });

  it('explains when Get Road Data has no enabled lookup to run', () => {
    const settings = {
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      map_matching_enabled: true,
      osrm_map_matching_url: '',
      osrm_data_sharing_consented: false,
    };

    expect(isRoadDataLookupConfigured(settings)).toBe(false);
    expect(buildRoadDataDisabledMessage(settings)).toContain('Nothing to get right now');
    expect(buildRoadDataDisabledMessage(settings)).toContain('Settings > Speed & Road Data');
    expect(isRoadDataLookupConfigured({
      ...settings,
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
    })).toBe(true);
  });

  it('identifies the public OSRM demo endpoint as reference text only', () => {
    expect(PUBLIC_OSRM_DEMO_URL).toBe('https://router.project-osrm.org');
    expect(isPublicOsrmDemoUrl(PUBLIC_OSRM_DEMO_URL)).toBe(true);
    expect(isPublicOsrmDemoUrl('http://router.project-osrm.org')).toBe(true);

    const message = buildRoadContextPrivacyMessage({
      map_matching_enabled: true,
      osrm_map_matching_url: PUBLIC_OSRM_DEMO_URL,
      osrm_data_sharing_consented: true,
    });

    expect(message).toContain('public OSRM demo is help text only');
    expect(describeMapMatchingStatus({ status: 'matched', snapped_coverage: 100, isOsrmDemoUrl: true })).toContain('public OSRM demo');
    expect(describeMapMatchingStatus({ status: 'public_demo_blocked' })).toContain('example');
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
    expect(adjusted.weather_context.source).toBe('open_meteo');
  });

  it('passes GPS weather inference through when Open-Meteo is unavailable', () => {
    const adjusted = applyWeatherRiskToScores({
      score_safety: 90,
      slippery_proxy: 'likely_wet',
      wet_signal_count: 3,
      wet_ratio: 0.6,
    }, {
      provider: 'open-meteo',
      status: 'unavailable',
      riskScore: null,
      riskMultiplier: 1,
    });

    expect(adjusted.weather_context).toMatchObject({
      source: 'gps_inference',
      condition: 'likely_wet',
      wet_signal_count: 3,
    });
    expect(adjusted.weather_score_adjustment).toBe(0);
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
      source: 'unavailable',
      status: 'disabled',
      riskLevel: null,
      riskScore: null,
    });
    expect(applyWeatherRiskToScores({ score_safety: 90 }, disabled)).toMatchObject({
      weather_risk_score: null,
      weather_score_adjustment: 0,
    });
  });

  it('skips Open-Meteo when only cell-hashed privacy-zone geometry is available', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const zoneCenter = { lat: 43.65, lng: -79.38, radius_m: 200 };
    const result = await fetchWeatherContextForTrip([
      { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z' },
    ], '2026-01-01T12:00:00.000Z', '2026-01-01T12:05:00.000Z', {
      weather_context_enabled: true,
      privacy_zones: [{
        id: 'home',
        label: 'Home',
        radius_m: zoneCenter.radius_m,
        privacy_cell_hashes: createPrivacyCellHashes(zoneCenter),
        privacy_cell_size_m: 50,
        masked_for_privacy: true,
      }],
    });

    expect(result).toMatchObject({
      status: 'skipped_privacy',
      weather_skipped_reason: 'all_points_within_privacy_zones',
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it('splits OSRM input around privacy zones without exposing interior or boundary coordinates', () => {
    const route = [
      { lat: 43.648, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:10.000Z' },
      { lat: 43.652, lng: -79.38, timestamp: '2026-01-01T12:00:20.000Z' },
    ];
    const safe = buildPrivacySafeOsrmRoute(route, {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 }],
    });

    expect(safe.some((point) => point.lat === 43.65 && point.lng === -79.38)).toBe(false);
    expect(safe.filter((point) => point.privacy_boundary)).toHaveLength(0);
    expect(safe.filter((point) => point.privacy_gap)).toHaveLength(1);
    expect(safe.findIndex((point) => point.privacy_gap)).toBeGreaterThan(0);
    expect(safe.every((point) => !point.masked_for_privacy || point.privacy_gap)).toBe(true);
  });

  it('ignores legacy OSRM exposure flags and still excludes privacy zones', () => {
    const route = [
      { lat: 43.648, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:10.000Z' },
      { lat: 43.652, lng: -79.38, timestamp: '2026-01-01T12:00:20.000Z' },
    ];
    const safe = buildPrivacySafeOsrmRoute(route, {
      privacy_zones: [{
        id: 'home',
        label: 'Home',
        lat: 43.65,
        lng: -79.38,
        radius_m: 100,
        exclude_from_osrm: false,
      }],
    });

    expect(safe.some((point) => point.lat === 43.65 && point.lng === -79.38)).toBe(false);
    expect(safe.filter((point) => point.privacy_gap)).toHaveLength(1);
    expect(safe.every((point) => point?.exclude_from_osrm !== false)).toBe(true);
  });

  it('produces no OSRM coordinates when every route point is private', () => {
    const route = [
      { lat: 43.65, lng: -79.38 },
      { lat: 43.6501, lng: -79.38 },
    ];
    const safe = buildPrivacySafeOsrmRoute(route, {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 500 }],
    });

    expect(safe).toEqual([]);
  });

  it('skips every network request when OSRM is configured but the whole route is private', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const route = [
      { lat: 43.65, lng: -79.38, speed_kmh: 20, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6501, lng: -79.38, speed_kmh: 20, timestamp: '2026-01-01T12:00:10.000Z' },
    ];

    const patch = await buildOpenSourceTripContextPatch({
      id: 'private-trip',
      start_time: route[0].timestamp,
      end_time: route[1].timestamp,
      route_points: route,
      driving_events: [],
    }, {
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 500 }],
    });

    expect(patch.map_matching_context.status).toBe('privacy_zones_excluded');
    // Phase 8: road-data rescoring no longer returns raw all-private route points as score/storage inputs.
    expect(patch.route_points).toEqual([]);
    expect(patch.score_input_masking_applied).toBe(true);
    expect(patch.privacy_zone_touched).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
