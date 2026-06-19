import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTransmissionLog: vi.fn(),
}));

vi.mock('@/lib/transmissionLog', () => ({
  loadTransmissionLog: mocks.loadTransmissionLog,
}));

import {
  buildDrivingPrivacyReadout,
  buildOutboundPrivacyReadout,
  summarizeAudit,
  summarizeZones,
  transmissionPrivacyLevel,
  computePrivacyScoreFromControls,
  buildPrivacyActionPlan,
  getTransmissionSummary,
} from '@/lib/privacyIntelligence';

describe('privacy intelligence summaries', () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.loadTransmissionLog.mockReset();
  });

  it('classifies blocked, protected, and raw outbound location data', () => {
    expect(transmissionPrivacyLevel({ coordinateDisclosure: 'blocked' })).toBe('blocked');
    expect(transmissionPrivacyLevel({ coordinateDisclosure: 'none' })).toBe('none');
    expect(transmissionPrivacyLevel({
      coordinateDisclosure: 'bounding_box',
      privacyTransformVerified: true,
    })).toBe('protected');
    expect(transmissionPrivacyLevel({
      coordinateDisclosure: 'bounding_box',
      privacyTransformVerified: true,
      privacyVerificationWarnings: ['missing evidence'],
    })).toBe('unverified');
    expect(transmissionPrivacyLevel({
      coordinateDisclosure: 'raw',
    })).toBe('raw');
    expect(transmissionPrivacyLevel({
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: false,
    })).toBe('unverified');
  });

  it('excludes not-applicable controls and renormalizes applicable layers', () => {
    const score = computePrivacyScoreFromControls([
      { category: 'device', status: 'not_applicable', weight: 3 },
      { category: 'network', status: 'ok', weight: 1 },
      { category: 'inference', status: 'unknown', weight: 1 },
      { category: 'integrity', status: 'configured', weight: 1 },
    ]);
    expect(score.layers.find((layer) => layer.id === 'device').score).toBeNull();
    expect(score.summary.unknown).toBe(1);
    expect(score.overall).toBe(53);
  });

  it('summarizes saved zone protection across time windows', () => {
    const summary = summarizeZones([
      {
        today: { hidden: 4, events: 1 },
        week: { hidden: 12, events: 3 },
        allTime: { hidden: 30, events: 8 },
        lastActive: 100,
      },
      {
        today: { hidden: 2, events: 0 },
        week: { hidden: 5, events: 2 },
        allTime: { hidden: 11, events: 4 },
        lastActive: null,
      },
    ]);

    expect(summary).toMatchObject({
      zoneCount: 2,
      activeZoneCount: 1,
      pointsToday: 6,
      eventsToday: 1,
      pointsWeek: 17,
      eventsWeek: 5,
      pointsAllTime: 41,
      eventsAllTime: 12,
      latestAt: 100,
    });
  });

  it('builds a trip-derived privacy readout for zone usefulness', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T16:00:00.000Z'));
    const protectedAt = '2026-06-13T14:00:00.000Z';
    const zones = [
      {
        id: 'home',
        label: 'Home',
        lat: 43.65,
        lng: -79.38,
        radius_m: 100,
        week: { hidden: 1, events: 1 },
        allTime: { hidden: 3, events: 2 },
        lastActive: Date.parse(protectedAt),
      },
      {
        id: 'work',
        label: 'Work',
        lat: 43.72,
        lng: -79.42,
        radius_m: 100,
        week: { hidden: 0, events: 0 },
        allTime: { hidden: 0, events: 0 },
        lastActive: null,
      },
    ];
    const readout = buildDrivingPrivacyReadout([
      {
        id: 'private-trip',
        start_time: protectedAt,
        route_points: [
          { lat: null, lng: null, timestamp: protectedAt, masked_for_privacy: true, privacy_gap: true, privacy_zone_id: 'home' },
          { lat: 43.6532, lng: -79.38, timestamp: protectedAt },
        ],
        driving_events: [
          { type: 'harsh_brake', lat: null, lng: null, timestamp: protectedAt, privacy_event_redacted: true, privacy_zone_id: 'home' },
        ],
      },
      {
        id: 'raw-local-trip',
        start_time: protectedAt,
        route_points: [
          { lat: 43.65, lng: -79.38, timestamp: protectedAt },
          { lat: 43.6532, lng: -79.38, timestamp: protectedAt },
        ],
      },
    ], zones);

    expect(readout).toMatchObject({
      tripCount: 2,
      recentTripCount: 2,
      tripsWithProtectedActivity: 2,
      recentProtectedTripCount: 2,
      privateEndpointTripCount: 2,
      protectedPointCount: 1,
      protectedEventCount: 1,
      rawPointInsideZoneCount: 1,
      recentProtectionRate: 100,
      untouchedZoneCount: 1,
    });
    expect(readout.recommendedChecks).toEqual(expect.arrayContaining([
      '1 zone has not protected a saved trip yet.',
      '1 saved local route sample still sits inside a configured zone and should be purged or redacted.',
    ]));
  });

  it('summarizes audit activity without inspecting sensitive payloads', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T16:00:00.000Z'));
    const summary = summarizeAudit([
      { op: 'TRANSMISSION', timestamp: Date.parse('2026-06-13T14:00:00.000Z') },
      { op: 'TRANSMISSION', timestamp: Date.parse('2026-06-10T14:00:00.000Z') },
      { op: 'ZONE_SAVED', timestamp: Date.parse('2026-05-01T14:00:00.000Z') },
    ]);

    expect(summary.todayTotal).toBe(1);
    expect(summary.weekTotal).toBe(2);
    expect(summary.latestAt).toBe(Date.parse('2026-06-13T14:00:00.000Z'));
    expect(summary.operations).toEqual([
      { operation: 'TRANSMISSION', count: 2 },
      { operation: 'ZONE_SAVED', count: 1 },
    ]);
  });

  it('summarizes raw and unverified transmissions as review-worthy', async () => {
    mocks.loadTransmissionLog.mockResolvedValue([
      {
        service: 'osrm',
        coordinateDisclosure: 'raw',
        protections: ['explicit consent'],
        status: 'warning',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      {
        service: 'osrm',
        coordinateDisclosure: 'raw',
        protections: [],
        status: 'warning',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      {
        service: 'open-meteo',
        coordinateDisclosure: 'rounded',
        privacyTransformVerified: false,
        privacyVerificationWarnings: ['missing evidence'],
        status: 'warning',
        timestamp: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    ]);

    const summary = await getTransmissionSummary();

    expect(summary.totalRawCoords).toBe(2);
    expect(summary.rawWithConsentCount).toBe(1);
    expect(summary.rawWithoutConsentCount).toBe(1);
    expect(summary.claimedButUnverifiedCount).toBe(1);
    expect(summary.warningTotal).toBe(3);
    expect(summary.outboundReadout.rawWithoutConsentCount).toBe(1);
    expect(summary.outboundReadout.unverifiedCount).toBe(1);
  });

  it('judges outbound privacy confidence by service and evidence quality', () => {
    const readout = buildOutboundPrivacyReadout([
      {
        service: 'open-meteo',
        coordinateDisclosure: 'rounded',
        privacyLevel: 'protected',
        privacyTransformVerified: true,
        status: 'safe',
        timestamp: 100,
        bytesOut: 120,
      },
      {
        service: 'osrm',
        coordinateDisclosure: 'raw',
        privacyLevel: 'raw',
        privacyTransformVerified: true,
        protections: ['explicit consent'],
        status: 'warning',
        timestamp: 200,
        bytesOut: 500,
      },
      {
        service: 'overpass',
        coordinateDisclosure: 'bounding_box',
        privacyLevel: 'unverified',
        privacyTransformVerified: false,
        status: 'warning',
        timestamp: 300,
        bytesOut: 220,
      },
    ], {
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example',
    }, 400);

    expect(readout.confidence).toBeLessThan(85);
    expect(readout.rawWithConsent).toBe(1);
    expect(readout.unverifiedCount).toBe(1);
    expect(readout.headline).toBe('Raw sharing is visible and needs trust in the endpoint');
    expect(readout.serviceSummaries.find((item) => item.service === 'open-meteo')).toMatchObject({
      label: 'Weather context',
      tone: 'ok',
      protectedCount: 1,
    });
    expect(readout.serviceSummaries.find((item) => item.service === 'osrm')).toMatchObject({
      tone: 'warn',
      rawCount: 1,
      worstDisclosure: 'raw',
    });
    expect(readout.findings.map((item) => item.id)).toEqual(expect.arrayContaining([
      'raw_with_consent',
      'unverified_protection',
    ]));
  });

  it('reports enabled outbound services with no retained evidence', () => {
    const readout = buildOutboundPrivacyReadout([], {
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example',
    }, 400);

    expect(readout.tone).toBe('unknown');
    expect(readout.enabledWithoutEvidenceCount).toBe(3);
    expect(readout.findings.map((item) => item.id)).toEqual(expect.arrayContaining([
      'no_retained_outbound_records',
      'no_evidence_open-meteo',
      'no_evidence_overpass',
      'no_evidence_osrm',
    ]));
  });

  it('builds an actionable privacy plan from the highest-risk findings', () => {
    const plan = buildPrivacyActionPlan({
      score: { label: 'Needs review' },
      protections: [
        { status: 'error' },
        { status: 'unknown' },
      ],
      transmissions: {
        rawWithoutConsentCount: 1,
        rawWithConsentCount: 0,
        claimedButUnverifiedCount: 2,
      },
      chainResult: { valid: true },
      zoneSummary: { zoneCount: 1 },
    });

    expect(plan.tone).toBe('error');
    expect(plan.primaryAction.id).toBe('raw_without_consent');
    expect(plan.issues.map((item) => item.id)).toEqual(expect.arrayContaining([
      'raw_without_consent',
      'failed_controls',
      'unverified_transmissions',
      'unknown_controls',
    ]));
  });
});
