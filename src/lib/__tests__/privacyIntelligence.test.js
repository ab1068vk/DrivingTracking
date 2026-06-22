import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  loadTransmissionLog: vi.fn(),
  isNativePlatform: vi.fn(() => false),
  encryptedStorage: new Map(),
  getEncryptedJson: vi.fn(async (key, fallback) => (
    mocks.encryptedStorage.has(key) ? mocks.encryptedStorage.get(key) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => {
    mocks.encryptedStorage.set(key, value);
  }),
  logSystemFailure: vi.fn(),
}));

vi.mock('@/lib/transmissionLog', () => ({
  loadTransmissionLog: mocks.loadTransmissionLog,
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: mocks.isNativePlatform,
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: mocks.getEncryptedJson,
  setEncryptedJson: mocks.setEncryptedJson,
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
}));

import {
  buildDrivingPrivacyReadout,
  buildOutboundPrivacyReadout,
  buildPrivacyRecommendations,
  detectCompoundRisk,
  detectTimingPatternExposure,
  summarizeAudit,
  summarizeScoreTrend,
  summarizeZones,
  transmissionPrivacyLevel,
  computePrivacyScoreFromControls,
  buildPrivacyActionPlan,
  getPrivacyScoreHistory,
  getTransmissionSummary,
  osrmConsentEvidence,
  PRIVACY_POSTURE_SNAPSHOT_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  PROTECTION_USER_ACTIONS,
  recordAndDetectVersionPostureRegression,
  recordPrivacyScoreHistory,
} from '@/lib/privacyIntelligence';

describe('privacy intelligence summaries', () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.loadTransmissionLog.mockReset();
    mocks.isNativePlatform.mockReturnValue(false);
    mocks.encryptedStorage.clear();
    mocks.getEncryptedJson.mockClear();
    mocks.setEncryptedJson.mockClear();
    mocks.logSystemFailure.mockClear();
    mocks.getEncryptedJson.mockImplementation(async (key, fallback) => (
      mocks.encryptedStorage.has(key) ? mocks.encryptedStorage.get(key) : fallback
    ));
    mocks.setEncryptedJson.mockImplementation(async (key, value) => {
      mocks.encryptedStorage.set(key, value);
    });
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

  it('caps a fully verified web score at Good without changing the native score', () => {
    const controls = [
      { category: 'device', status: 'ok', weight: 1 },
      { category: 'network', status: 'ok', weight: 1 },
      { category: 'inference', status: 'ok', weight: 1 },
      { category: 'integrity', status: 'ok', weight: 1 },
    ];

    mocks.isNativePlatform.mockReturnValue(false);
    const webScore = computePrivacyScoreFromControls(controls);
    // Intentional Phase 3 behavior: web evidence cannot reach the native Strong band.
    expect(webScore).toMatchObject({
      overall: 89,
      computedOverall: 100,
      label: 'Good',
      webCapApplied: true,
      capReason: 'Capped because this is a web build; install the Android app for hardware-backed checks.',
    });

    mocks.isNativePlatform.mockReturnValue(true);
    const nativeScore = computePrivacyScoreFromControls(controls);
    expect(nativeScore).toMatchObject({
      overall: 100,
      computedOverall: 100,
      label: 'Strong',
      webCapApplied: false,
      capReason: null,
    });
  });

  it('keeps status priority primary and uses category risk as the secondary recommendation sort', () => {
    const recommendations = buildPrivacyRecommendations([
      { id: 'network-error', category: 'network', status: 'error', weight: 10 },
      { id: 'network-warn', category: 'network', status: 'warn', weight: 3 },
      { id: 'device-warn', category: 'device', status: 'warn', weight: 2 },
      { id: 'integrity-warn', category: 'integrity', status: 'warn', weight: 1 },
    ]);

    expect(recommendations.map((item) => item.id)).toEqual([
      'network-error',
      'device-warn',
      'network-warn',
      'integrity-warn',
    ]);
  });

  it('provides a user action for every registry-backed protection control', () => {
    expect(Object.keys(PROTECTION_USER_ACTIONS).sort()).toEqual([
      'audit_log',
      'bridge_encryption',
      'cert_pinning',
      'commitment_scheme',
      'crash_scrubbing',
      'differential_privacy',
      'export_signing',
      'key_rotation',
      'kinematic_nulling',
      'memory_zeroing',
      'request_obfuscation',
      'root_detection',
      'score_input_masking',
      'secure_deletion',
      'storage_encryption',
      'timestamp_fuzzing',
    ]);
    expect(Object.values(PROTECTION_USER_ACTIONS).every(Boolean)).toBe(true);
  });

  it('keeps disabled OSRM evidence distinct from current consent with zone guards', () => {
    expect(osrmConsentEvidence({ enabled: false })).toBe('OSRM route matching is disabled');
    expect(osrmConsentEvidence({
      enabled: true,
      outdated: false,
      unguarded: false,
    })).toBe('Consent is current and privacy zones are always excluded');
  });

  it('stores one encrypted score snapshot per local calendar day and retains 180 entries', async () => {
    const base = new Date('2025-01-01T12:00:00.000Z').getTime();
    const score = {
      overall: 82,
      layers: [
        { id: 'device', score: 80 },
        { id: 'network', score: 84 },
      ],
    };

    await recordPrivacyScoreHistory(score, base);
    await recordPrivacyScoreHistory({ ...score, overall: 40 }, base + 60_000);
    for (let day = 1; day <= 180; day += 1) {
      await recordPrivacyScoreHistory(
        { ...score, overall: 82 + (day % 3) },
        base + day * 24 * 60 * 60 * 1000
      );
    }

    const history = await getPrivacyScoreHistory();
    expect(mocks.setEncryptedJson).toHaveBeenCalledWith(PRIVACY_SCORE_HISTORY_KEY, expect.any(Array));
    expect(history).toHaveLength(180);
    expect(history[0].timestamp).toBe(base + 24 * 60 * 60 * 1000);
    expect(history.at(-1).layerScores).toEqual({ device: 80, network: 84 });
    expect(history.some((entry) => entry.overall === 40)).toBe(false);
  });

  it('logs score-history storage failures', async () => {
    mocks.getEncryptedJson.mockRejectedValueOnce(new Error('read failed'));

    await expect(getPrivacyScoreHistory()).resolves.toEqual([]);
    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_score_history_read_failed',
      expect.any(Error),
      {}
    );

    mocks.logSystemFailure.mockClear();
    mocks.setEncryptedJson.mockRejectedValueOnce(new Error('write failed'));
    await expect(recordPrivacyScoreHistory({
      overall: 82,
      layers: [{ id: 'device', score: 80 }],
    }, Date.parse('2026-06-22T12:00:00.000Z'))).rejects.toThrow('write failed');

    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_score_history_write_failed',
      expect.any(Error),
      expect.objectContaining({ history_count: 1 })
    );
  });

  it('classifies weekly and monthly score trends', () => {
    const day = 24 * 60 * 60 * 1000;
    const latest = Date.parse('2026-06-22T12:00:00.000Z');
    const history = (weekAgo, latestScore, monthAgo = weekAgo) => [
      { timestamp: latest - 31 * day, overall: monthAgo, layerScores: {} },
      { timestamp: latest - 8 * day, overall: weekAgo, layerScores: {} },
      { timestamp: latest, overall: latestScore, layerScores: {} },
    ];

    expect(summarizeScoreTrend(history(70, 78, 60))).toEqual({
      direction: 'improving',
      changeFromLastWeek: 8,
      changeFromLastMonth: 18,
    });
    expect(summarizeScoreTrend(history(85, 72, 90))).toEqual({
      direction: 'declining',
      changeFromLastWeek: -13,
      changeFromLastMonth: -18,
    });
    expect(summarizeScoreTrend(history(80, 80))).toMatchObject({
      direction: 'flat',
      changeFromLastWeek: 0,
    });
    expect(summarizeScoreTrend([{ timestamp: latest, overall: 80, layerScores: {} }])).toEqual({
      direction: 'insufficient_data',
      changeFromLastWeek: null,
      changeFromLastMonth: null,
    });
  });

  it('flags tight request timing patterns but ignores random timing fixtures', () => {
    const day = 24 * 60 * 60 * 1000;
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    const tight = Array.from({ length: 12 }, (_, index) => ({
      service: 'open-meteo',
      status: 'safe',
      coordinateDisclosure: 'rounded',
      timestamp: base + index * day + (8 * 60 + (index % 5)) * 60 * 1000,
    }));
    const random = Array.from({ length: 12 }, (_, index) => ({
      service: 'overpass',
      status: 'safe',
      coordinateDisclosure: 'bounding_box',
      timestamp: base + index * day + ((index * 107) % 1440) * 60 * 1000,
    }));

    const findings = detectTimingPatternExposure([...tight, ...random], {
      request_obfuscation_enabled: false,
    }, base + 29 * day);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'timing_pattern_open-meteo',
      service: 'open-meteo',
      action: 'Enable request timing obfuscation',
      occurrenceDays: 12,
    });
    expect(findings[0].detail).toContain('could reveal routine activity to a network observer');
  });

  it('records app-version posture snapshots and reports update regressions', async () => {
    const v1 = await recordAndDetectVersionPostureRegression([
      { id: 'storage_encryption', label: 'Storage encryption', category: 'device', status: 'ok' },
      { id: 'cert_pinning', label: 'Certificate pinning', category: 'network', status: 'configured' },
    ], '1.0.0', Date.parse('2026-06-01T12:00:00.000Z'));
    expect(v1.findings).toEqual([]);

    const v2 = await recordAndDetectVersionPostureRegression([
      { id: 'storage_encryption', label: 'Storage encryption', category: 'device', status: 'error' },
      { id: 'cert_pinning', label: 'Certificate pinning', category: 'network', status: 'ok' },
    ], '1.1.0', Date.parse('2026-06-02T12:00:00.000Z'));

    expect(mocks.setEncryptedJson).toHaveBeenCalledWith(PRIVACY_POSTURE_SNAPSHOT_KEY, expect.any(Object));
    expect(v2.findings).toContainEqual(expect.objectContaining({
      id: 'version_posture_regression',
      tone: 'error',
      controlIds: ['storage_encryption'],
    }));
  });

  it('logs app-version posture snapshot storage failures without blocking the summary', async () => {
    mocks.getEncryptedJson.mockRejectedValueOnce(new Error('snapshot read failed'));
    mocks.setEncryptedJson.mockRejectedValueOnce(new Error('snapshot write failed'));

    const result = await recordAndDetectVersionPostureRegression([
      { id: 'storage_encryption', label: 'Storage encryption', category: 'device', status: 'ok' },
    ], '2.0.0', Date.parse('2026-06-22T12:00:00.000Z'));

    expect(result).toMatchObject({
      changed: false,
      findings: [],
      currentVersion: '2.0.0',
    });
    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_posture_snapshot_read_failed',
      expect.any(Error),
      expect.objectContaining({ current_version: '2.0.0' })
    );
    expect(mocks.logSystemFailure).toHaveBeenCalledWith(
      'privacy_posture_snapshot_write_failed',
      expect.any(Error),
      expect.objectContaining({
        current_version: '2.0.0',
        snapshot_count: 1,
      })
    );
  });

  it('flags compound risk only when two or more controls fail in the same category', () => {
    expect(detectCompoundRisk([
      { id: 'storage_encryption', category: 'device', status: 'error' },
      { id: 'secure_deletion', category: 'device', status: 'error' },
      { id: 'cert_pinning', category: 'network', status: 'error' },
    ])).toEqual([expect.objectContaining({
      id: 'compound_device_risk',
      count: 2,
      controlIds: ['storage_encryption', 'secure_deletion'],
    })]);

    expect(detectCompoundRisk([
      { id: 'storage_encryption', category: 'device', status: 'error' },
      { id: 'cert_pinning', category: 'network', status: 'error' },
    ])).toEqual([]);
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
    // Checklist: "Confirm raw saved samples inside zones are flagged."
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
      {
        op: 'TRANSMISSION',
        timestamp: Date.parse('2026-06-13T14:00:00.000Z'),
        tipSignature: 'signature',
        signingPublicKey: 'public-key',
      },
      { op: 'TRANSMISSION', timestamp: Date.parse('2026-06-10T14:00:00.000Z') },
      { op: 'ZONE_SAVED', timestamp: Date.parse('2026-05-01T14:00:00.000Z') },
    ], Date.parse('2026-06-01T12:00:00.000Z'));

    expect(summary.todayTotal).toBe(1);
    expect(summary.weekTotal).toBe(2);
    expect(summary.latestAt).toBe(Date.parse('2026-06-13T14:00:00.000Z'));
    expect(summary.lastCheckpointExportedAt).toBe(Date.parse('2026-06-01T12:00:00.000Z'));
    expect(summary.signatureCoverage).toBe(2);
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

  it('passes driving readout evidence into the Overview action plan wiring', () => {
    const source = readFileSync(new URL('../privacyIntelligence.js', import.meta.url), 'utf8');

    expect(source).toMatch(/const drivingReadout = buildDrivingPrivacyReadout\(trips, zonesWithEffectiveness\);[\s\S]*buildPrivacyActionPlan\(\{[\s\S]*drivingReadout,/);
  });

  it('surfaces zone and recent-drive findings in the action plan', () => {
    const plan = buildPrivacyActionPlan({
      score: { label: 'Good' },
      protections: [],
      transmissions: {},
      chainResult: { valid: true },
      zoneSummary: { zoneCount: 2 },
      drivingReadout: {
        tripCount: 4,
        recentTripCount: 3,
        recentProtectedTripCount: 0,
        rawPointInsideZoneCount: 2,
        untouchedZoneCount: 1,
      },
    });

    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'zones_not_matching_recent_drives',
        tone: 'warn',
        targetTab: 'zones',
        action: 'Review zones',
      }),
      expect.objectContaining({
        id: 'raw_points_inside_zone',
        tone: 'error',
        targetTab: 'zones',
        action: 'Open zones',
      }),
      expect.objectContaining({
        id: 'untouched_zones',
        tone: 'unknown',
        targetTab: 'zones',
        action: 'Review zones',
      }),
    ]));
  });

  it('adds a protections action when the weekly privacy score drops by more than 10 points', () => {
    const plan = buildPrivacyActionPlan({
      score: { label: 'Needs review' },
      protections: [],
      transmissions: {},
      chainResult: { valid: true },
      zoneSummary: { zoneCount: 1 },
      scoreTrend: { changeFromLastWeek: -11 },
    });

    expect(plan.issues).toContainEqual(expect.objectContaining({
      id: 'score_regression',
      tone: 'warn',
      targetTab: 'protections',
      title: 'Privacy score dropped recently',
      action: 'Open protections',
    }));
  });

  it('prioritizes app-update posture regressions in the action plan', () => {
    const plan = buildPrivacyActionPlan({
      score: { label: 'Needs review' },
      protections: [],
      transmissions: {},
      chainResult: { valid: true },
      zoneSummary: { zoneCount: 1 },
      postureRegression: {
        findings: [{
          id: 'version_posture_regression',
          tone: 'error',
          targetTab: 'protections',
          title: 'A protection changed after updating the app',
          detail: 'A protection changed after updating the app - review before trusting current claims. Review: Storage encryption.',
          action: 'Open protections',
        }],
      },
    });

    expect(plan.primaryAction).toMatchObject({
      id: 'version_posture_regression',
      tone: 'error',
      targetTab: 'protections',
    });
  });

  it('records the daily score before summarizing the trend during dashboard loading', () => {
    const source = readFileSync(new URL('../privacyIntelligence.js', import.meta.url), 'utf8');

    expect(source).toMatch(
      /const score = computePrivacyScoreFromControls\(protections\);[\s\S]*const scoreHistory = await recordPrivacyScoreHistory\(score\);[\s\S]*const scoreTrend = summarizeScoreTrend\(scoreHistory\);/
    );
  });
});
