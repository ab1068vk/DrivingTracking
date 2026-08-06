import { describe, expect, it } from 'vitest';

import {
  getRegionDefaultEstimate,
  resolveSpeedLimitWithTier,
  shouldWarnForSpeed,
  tierForSource,
} from '@/lib/speedLimitSource';
import { DEFAULT_THRESHOLDS, resolveEffectiveSpeedLimitForIndex } from '@/lib/tripEngine';

// CHANGES (session):
// - Added Category A tier resolution tests for resolveSpeedLimitWithTier.
// - Added Category B alert suppression tests for tier-aware shouldAlert behavior.
// - Updated regional default tier expectations to REGION_DEFAULT.
// - Updated user-confirmed correction expectation to POSTED.
// - Split user corrections into posted-sign and user-entered estimate expectations.
// - Updated REGION_DEFAULT alert margin expectation to confidence 0.45 => base + 7.
// - Added legacy country_statutory and normal user-entered correction guard tests.
// - Added live settings policy coverage for estimate toggles and tier voice margins.
// - Added coverage for blank voice margin drafts falling back to default margins.

describe('resolveSpeedLimitWithTier', () => {
  it('returns POSTED when OSM maxspeed is present', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      {}
    );
    expect(r.tier).toBe('POSTED');
    // A crowd-sourced OSM maxspeed is high-confidence mapped data, not certainty; the
    // single SPEED_LIMIT_SOURCE_PROFILES table rates it below a user-confirmed sign.
    expect(r.confidence).toBe(0.90);
    expect(r.limitKmh).toBe(60);
  });

  it('keeps fresh OSM posted data above a user-entered estimate', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      { localKnowledge: { limitKmh: 40, source: 'user_entered_estimate', confidence: 0.75 } }
    );
    expect(r.tier).toBe('POSTED');
    expect(r.limitKmh).toBe(60);
    expect(r.source).toBe('openstreetmap');
  });

  it('returns MAP_ESTIMATED for osm_highway_default', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 50, speed_limit_source: 'osm_highway_default' },
      {}
    );
    expect(r.tier).toBe('MAP_ESTIMATED');
    // A limit guessed from an OSM highway tag alone: low confidence, wide alert margin.
    expect(r.confidence).toBe(0.48);
  });

  it('returns POSTED for user-confirmed posted sign over MAP_ESTIMATED', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 50, speed_limit_source: 'osm_highway_default' },
      { localKnowledge: { limitKmh: 40, source: 'user_confirmed_posted_sign', confidence: 0.92 } }
    );
    expect(r.tier).toBe('POSTED');
    expect(r.limitKmh).toBe(40);
    expect(r.source).toBe('user_confirmed_posted_sign');
    expect(r.confidence).toBe(0.92);
  });

  it('returns LEARNED_LOCAL for user-entered estimate when no posted or map signal is available', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { localKnowledge: { limitKmh: 40, source: 'user_entered_estimate', confidence: 0.75 } }
    );
    expect(r.tier).toBe('LEARNED_LOCAL');
    expect(r.limitKmh).toBe(40);
    expect(r.source).toBe('user_entered_estimate');
    expect(r.confidence).toBe(0.75);
  });

  it('uses learned local estimates before conservative global road defaults', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      {
        inferredZone: { inferredZoneKmh: 70 },
        localKnowledge: { limitKmh: 70, source: 'learned_local', confidence: 0.8 },
      }
    );
    expect(r.tier).toBe('LEARNED_LOCAL');
    expect(r.limitKmh).toBe(70);
  });

  it('normal user-entered correction does not become POSTED', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { localKnowledge: { limitKmh: 45, source: 'user_entered_estimate', confidence: 0.75 } }
    );
    expect(r.tier).toBe('LEARNED_LOCAL');
    expect(r.tier).not.toBe('POSTED');
  });

  it('treats legacy user_correction as a user-entered estimate', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { localKnowledge: { limitKmh: 40, source: 'user_correction', confidence: 0.75 } }
    );
    expect(r.tier).toBe('LEARNED_LOCAL');
    expect(r.source).toBe('user_entered_estimate');
  });

  it('legacy country_statutory source maps to REGION_DEFAULT for old trips', () => {
    expect(tierForSource('country_statutory')).toBe('REGION_DEFAULT');
  });

  it('returns REGION_DEFAULT for Ontario urban road when no OSM data', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: null, speed_limit_source: null },
      { countryCode: 'CA', provinceCode: 'ON', osmHighwayType: 'residential' }
    );
    expect(r.tier).toBe('REGION_DEFAULT');
    expect(r.limitKmh).toBe(50);
  });

  it('returns REGION_DEFAULT for Germany urban (50), null for motorway', () => {
    const urban = resolveSpeedLimitWithTier({}, { countryCode: 'DE', osmHighwayType: 'residential' });
    expect(urban.tier).toBe('REGION_DEFAULT');
    expect(urban.limitKmh).toBe(50);

    const motorway = getRegionDefaultEstimate('DE', null, 'highway');
    expect(motorway).toBeNull();
  });

  it('returns REGION_DEFAULT from global defaults when no country code is selected', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { inferredZone: { inferredZoneKmh: 70 }, thresholds: { SPEEDING_FALLBACK_KMH: 100 } }
    );
    expect(r.tier).toBe('REGION_DEFAULT');
    expect(r.limitKmh).toBe(60);
  });

  it('returns GPS_INFERRED when regional defaults deliberately have no usable limit', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEEDING_FALLBACK_KMH: 100 } }
    );
    expect(r.tier).toBe('GPS_INFERRED');
    expect(r.confidence).toBe(0.35);
  });

  it('returns UNKNOWN when nothing is available', () => {
    const r = resolveSpeedLimitWithTier({}, {});
    expect(r.tier).toBe('UNKNOWN');
    expect(r.limitKmh).toBeNull();
  });
});

describe('resolveEffectiveSpeedLimitForIndex priority', () => {
  it('keeps fresh OSM posted data above local estimates for live/manual checks', () => {
    const points = [
      { lat: 43.65, lng: -79.38, speed_kmh: 52, speed_limit_kmh: 60, speed_limit_source: 'openstreetmap', timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6501, lng: -79.38, speed_kmh: 54, speed_limit_kmh: 60, speed_limit_source: 'openstreetmap', timestamp: '2026-01-01T12:00:05.000Z' },
    ];
    const resolved = resolveEffectiveSpeedLimitForIndex(points, 1, DEFAULT_THRESHOLDS, {
      localKnowledge: { limitKmh: 40, source: 'user_entered_estimate', confidence: 0.75 },
    });
    expect(resolved.limitKmh).toBe(60);
    expect(resolved.tier).toBe('POSTED');
    expect(resolved.limitSource).toBe('openstreetmap');
    expect(resolved.resolutionReason).toBe('openstreetmap_posted_limit');
    expect(resolved.localSpeedRule).toMatchObject({
      source: 'user_entered_estimate',
    });
    expect(resolved.fallbackReason).toBeNull();
  });

  it('lets validated local knowledge replace lower-authority stored defaults', () => {
    const points = [
      { lat: 43.65, lng: -79.38, speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
    ];
    const resolved = resolveEffectiveSpeedLimitForIndex(points, 0, DEFAULT_THRESHOLDS, {
      localKnowledge: { limitKmh: 50, source: 'local_road_memory', confidence: 0.66 },
    });

    expect(resolved).toMatchObject({
      limitKmh: 50,
      tier: 'LEARNED_LOCAL',
      limitSource: 'learned_local',
      resolutionReason: 'learned_local_speed',
    });
  });

  it('reports when it falls back because no saved or posted road speed matched', () => {
    const points = [
      { lat: 43.65, lng: -79.38, speed_kmh: 42, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6501, lng: -79.38, speed_kmh: 44, timestamp: '2026-01-01T12:00:05.000Z' },
    ];
    const resolved = resolveEffectiveSpeedLimitForIndex(points, 1, DEFAULT_THRESHOLDS, {
      settings: { configurable_country_defaults: 'CA-ON' },
    });
    expect(resolved.limitKmh).toBe(50);
    expect(resolved.tier).toBe('REGION_DEFAULT');
    expect(resolved.resolutionReason).toBe('regional_default_estimate');
    expect(resolved.fallbackReason).toBe('regional_default_estimate');
    expect(resolved.localSpeedRule).toBeNull();
  });
});

describe('alert suppression by tier', () => {
  it('UNKNOWN tier never alerts', () => {
    const r = resolveSpeedLimitWithTier({}, {});
    expect(r.shouldAlert(180)).toBe(false);
  });

  it('GPS_INFERRED uses the wider +20 km/h margin around an estimated 60 zone', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEED_OVER_KMH: 5, SPEEDING_FALLBACK_KMH: 100 } }
    );
    expect(r.shouldAlert(115)).toBe(false);
    expect(r.shouldAlert(121)).toBe(true);
  });

  it('POSTED: alert fires at 66 in 60 zone (> +5)', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    expect(r.shouldAlert(65)).toBe(false);
    expect(r.shouldAlert(66)).toBe(true);
  });

  it('MAP_ESTIMATED: no alert until well over an estimated 60 zone (needs +12)', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    expect(r.alertMarginKmh).toBe(12);
    expect(r.shouldAlert(65)).toBe(false);
    expect(r.shouldAlert(72)).toBe(false);
    expect(r.shouldAlert(73)).toBe(true);
  });

  it('REGION_DEFAULT: alert only well over a 50 zone (> +20)', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      {
        countryCode: 'CA',
        provinceCode: 'ON',
        osmHighwayType: 'residential',
        thresholds: { SPEED_OVER_KMH: 5 },
      }
    );
    expect(r.alertMarginKmh).toBe(20);
    expect(r.shouldAlert(70)).toBe(false);
    expect(r.shouldAlert(71)).toBe(true);
  });
});

describe('live speed warning settings policy', () => {
  it('disables estimated visual and voice checks when speed_estimates_enabled is false', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    expect(shouldWarnForSpeed({
      speedKmh: 90,
      candidate: r,
      settings: {
        speed_estimates_enabled: false,
        speak_estimated_speed_checks: true,
      },
    })).toBeNull();
  });

  it('keeps posted speed warnings active when estimate guidance is disabled', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 70,
      candidate: r,
      settings: {
        speed_estimates_enabled: false,
        speak_posted_speed_warnings: true,
      },
    });
    expect(warning.visual).toBe(true);
    expect(warning.voice).toBe(true);
  });

  it('shows estimated visual checks without voice when speak_estimated_speed_checks is off', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 73,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: false,
        estimated_voice_margin_kmh: 12,
      },
    });
    expect(warning.visual).toBe(true);
    expect(warning.voice).toBe(false);
  });

  it('requires the configured estimated voice margin before speaking estimates', () => {
    // A learned local limit at 0.70 clears the alert confidence floor, so the
    // configured voice margin is what separates visual from voice. Its visual
    // margin is +8, so the voice margin has to sit above that to be observable.
    const r = resolveSpeedLimitWithTier({}, {
      localKnowledge: { limitKmh: 60, confidence: 0.7, source: 'learned_local' },
      thresholds: { SPEED_OVER_KMH: 5 },
    });
    const settings = {
      speak_estimated_speed_checks: true,
      estimated_voice_margin_kmh: 20,
    };
    const belowVoiceMargin = shouldWarnForSpeed({ speedKmh: 75, candidate: r, settings });
    const aboveVoiceMargin = shouldWarnForSpeed({ speedKmh: 85, candidate: r, settings });

    expect(belowVoiceMargin.visual).toBe(true);
    expect(belowVoiceMargin.voice).toBe(false);
    expect(aboveVoiceMargin.visual).toBe(true);
    expect(aboveVoiceMargin.voice).toBe(true);
  });

  it('does not speak an estimate that fails the alert confidence floor', () => {
    // osm_highway_default carries 0.48 confidence, below the 0.55 floor the
    // native service already applied. Turning estimate speech on is not enough.
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 85,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        estimated_voice_margin_kmh: 20,
      },
    });
    expect(warning.visual).toBe(true);
    expect(warning.voice).toBe(false);
    expect(warning.meetsConfidenceFloor).toBe(false);
  });

  it('uses the default estimated voice margin while the settings input is blank', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 61,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        estimated_voice_margin_kmh: '',
      },
    });
    expect(warning).toBeNull();
  });

  it('never speaks a GPS-only check before the badge is willing to show it', () => {
    // This used to be inverted: a GPS_INFERRED limit has a +20 visual margin but
    // the voice margin was a flat 12, so the app spoke at +12 about something it
    // refused to display until +20.
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEED_OVER_KMH: 5, SPEEDING_FALLBACK_KMH: 100 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 125,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        estimated_voice_margin_kmh: 12,
        speed_alert_min_confidence: 0.3,
      },
    });
    expect(warning.visualMarginKmh).toBe(20);
    expect(warning.voiceMarginKmh).toBeGreaterThanOrEqual(warning.visualMarginKmh);
    expect(warning.visual).toBe(true);
  });

  it('honours inferred_voice_margin_kmh for GPS-only checks', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEED_OVER_KMH: 5, SPEEDING_FALLBACK_KMH: 100 } }
    );
    const settings = {
      speak_estimated_speed_checks: true,
      estimated_voice_margin_kmh: 12,
      inferred_voice_margin_kmh: 40,
      speed_alert_min_confidence: 0.3,
    };
    const belowVoiceMargin = shouldWarnForSpeed({ speedKmh: 125, candidate: r, settings });
    const aboveVoiceMargin = shouldWarnForSpeed({ speedKmh: 145, candidate: r, settings });

    expect(belowVoiceMargin.voiceMarginKmh).toBe(40);
    expect(belowVoiceMargin.visual).toBe(true);
    expect(belowVoiceMargin.voice).toBe(false);
    expect(aboveVoiceMargin.voice).toBe(true);
  });
});
