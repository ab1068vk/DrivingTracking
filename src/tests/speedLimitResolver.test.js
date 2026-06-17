import { describe, expect, it } from 'vitest';

import {
  getRegionDefaultEstimate,
  resolveSpeedLimitWithTier,
  shouldWarnForSpeed,
  tierForSource,
} from '@/lib/speedLimitSource';

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
    expect(r.confidence).toBe(1.0);
    expect(r.limitKmh).toBe(60);
  });

  it('returns MAP_ESTIMATED for osm_highway_default', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 50, speed_limit_source: 'osm_highway_default' },
      {}
    );
    expect(r.tier).toBe('MAP_ESTIMATED');
    expect(r.confidence).toBe(0.70);
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

  it('does not let learned local estimates raise a conservative global road default', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      {
        inferredZone: { inferredZoneKmh: 70 },
        localKnowledge: { limitKmh: 70, source: 'learned_local', confidence: 0.8 },
      }
    );
    expect(r.tier).toBe('REGION_DEFAULT');
    expect(r.limitKmh).toBe(60);
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

  it('MAP_ESTIMATED: no alert at 65 in estimated 60 zone (only +5, needs +8)', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    expect(r.shouldAlert(65)).toBe(false);
    expect(r.shouldAlert(69)).toBe(true);
  });

  it('REGION_DEFAULT: alert at 63 in 50 zone (> +12)', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      {
        countryCode: 'CA',
        provinceCode: 'ON',
        osmHighwayType: 'residential',
        thresholds: { SPEED_OVER_KMH: 5 },
      }
    );
    expect(r.shouldAlert(62)).toBe(false);
    expect(r.shouldAlert(63)).toBe(true);
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
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'osm_highway_default' },
      { thresholds: { SPEED_OVER_KMH: 5 } }
    );
    const belowVoiceMargin = shouldWarnForSpeed({
      speedKmh: 71,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        estimated_voice_margin_kmh: 12,
      },
    });
    const aboveVoiceMargin = shouldWarnForSpeed({
      speedKmh: 73,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        estimated_voice_margin_kmh: 12,
      },
    });
    expect(belowVoiceMargin.visual).toBe(true);
    expect(belowVoiceMargin.voice).toBe(false);
    expect(aboveVoiceMargin.visual).toBe(true);
    expect(aboveVoiceMargin.voice).toBe(true);
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

  it('uses the configured inferred voice margin for GPS-only checks', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEED_OVER_KMH: 5, SPEEDING_FALLBACK_KMH: 100 } }
    );
    const warning = shouldWarnForSpeed({
      speedKmh: 116,
      candidate: r,
      settings: {
        speak_estimated_speed_checks: true,
        inferred_voice_margin_kmh: 15,
      },
    });
    expect(warning.visual).toBe(false);
    expect(warning.voice).toBe(true);
    expect(warning.voiceMarginKmh).toBe(15);
  });
});
