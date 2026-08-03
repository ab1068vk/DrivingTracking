import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeDriverProgressionCelebration,
  buildDriverProgression,
  progressionStats,
  syncDriverProgressionLedger,
  processDriverProgressionAfterTrip,
  updateDriverProgressionMissionSelection,
} from '@/lib/driverProgression';
import { calculateWeeklyDrivingGoals } from '@/lib/tripInsights';

const DAY_MS = 86400000;
const NOW = new Date('2026-07-13T16:00:00.000Z');

function trip(index, overrides = {}) {
  return {
    id: `trip-${index}`,
    status: 'completed',
    start_time: new Date(NOW.getTime() - index * DAY_MS).toISOString(),
    duration_seconds: 1800,
    distance_km: 20,
    score_overall: 90,
    score_safety: 90,
    score_smoothness: 90,
    score_eco: 90,
    braking_efficiency_score: 90,
    cornering_consistency_score: 90,
    overall_compliance_score: 90,
    harsh_brakes_count: 0,
    rapid_accel_count: 0,
    sharp_turns_count: 0,
    speeding_events_count: 0,
    phone_use_score_available: true,
    phone_use_risk: 'none',
    phone_use_high_confidence_count: 0,
    ...overrides,
  };
}

const repeatedRoute = [
  { lat: 43.65, lng: -79.38, speed_kmh: 40 },
  { lat: 43.68, lng: -79.35, speed_kmh: 45 },
];

describe('driver progression', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires meaningful trip evidence before missions can complete', () => {
    const progression = buildDriverProgression([trip(0)], {}, { now: NOW });

    expect(progression.eligibility.eligibleTrips).toBe(1);
    expect(progression.missions.every((mission) => mission.completed === false)).toBe(true);
    expect(progression.missions.some((mission) => mission.status === 'building_evidence')).toBe(true);
  });

  it('excludes short and unscored trips from progression evidence', () => {
    const progression = buildDriverProgression([
      trip(0, { distance_km: 0.8 }),
      trip(1, { score_overall: null }),
      trip(2),
    ], {}, { now: NOW });

    expect(progression.eligibility).toMatchObject({ completedTrips: 3, eligibleTrips: 1, excludedTrips: 2 });
    expect(progression.eligibility.exclusionReasons.find((reason) => reason.id === 'distance').count).toBe(1);
    expect(progression.eligibility.exclusionReasons.find((reason) => reason.id === 'score').count).toBe(1);
  });

  it('qualifies historical trips that store the overall score in the canonical component envelope', () => {
    const historical = trip(0, {
      score_overall: null,
      component_scores: {
        overall: { value: 88, evidence: 'developing', dataSource: ['gps_events'] },
      },
    });
    const progression = buildDriverProgression([historical], {}, { now: NOW });

    expect(progression.eligibility.eligibleTrips).toBe(1);
    expect(progression.formSeries).toEqual([{ date: historical.start_time, score: 88, tripId: historical.id }]);
  });

  it('uses privacy-masked aggregate evidence without using private route identity or context', () => {
    const privateRouteTrips = Array.from({ length: 10 }, (_, index) => trip(index, {
      privacy_zone_touched: true,
      route_points: repeatedRoute,
      dominant_road_type: 'city',
    }));
    const progression = buildDriverProgression(privateRouteTrips, {}, { now: NOW });

    expect(progression.eligibility.eligibleTrips).toBe(10);
    expect(progression.eligibility.privacyLimitedTrips).toBe(10);
    expect(progression.missionCandidates.some((mission) => mission.title === 'Route mastery')).toBe(false);
    expect(progression.missionCandidates.some((mission) => mission.category === 'Comparable context')).toBe(false);
  });

  it('normalizes risk events by distance', () => {
    const short = progressionStats([trip(0, { distance_km: 10, harsh_brakes_count: 2 })]);
    const long = progressionStats([trip(0, { distance_km: 100, harsh_brakes_count: 2 })]);

    expect(short.eventRates.braking).toBe(20);
    expect(long.eventRates.braking).toBe(2);
  });

  it('does not grant advanced mastery from trip volume alone', () => {
    const trips = Array.from({ length: 45 }, (_, index) => trip(index, {
      score_overall: 70,
      score_safety: 70,
      braking_efficiency_score: 68,
      harsh_brakes_count: 3,
    }));
    const progression = buildDriverProgression(trips, {}, { now: NOW });
    const braking = progression.masteryTracks.find((track) => track.id === 'braking');

    expect(braking.tiers.find((tier) => tier.id === 'master').unlocked).toBe(false);
    expect(braking.tiers.find((tier) => tier.id === 'master').requirements.some((item) => item.met === false)).toBe(true);
  });

  it('keeps earned mastery permanent through the local ledger', () => {
    const excellentTrips = Array.from({ length: 45 }, (_, index) => trip(index, { distance_km: 25, score_overall: 97, score_safety: 97, braking_efficiency_score: 98 }));
    const earned = buildDriverProgression(excellentTrips, {}, { now: NOW });
    const result = syncDriverProgressionLedger(earned, { version: 1, mastery: {}, missions: {} });
    const laterTrips = excellentTrips.map((item) => ({ ...item, score_safety: 60, braking_efficiency_score: 60, harsh_brakes_count: 4 }));
    const later = buildDriverProgression(laterTrips, {}, { now: new Date(NOW.getTime() + DAY_MS), ledger: result.ledger });
    const brakingMaster = later.masteryTracks.find((track) => track.id === 'braking').tiers.find((tier) => tier.id === 'master');

    expect(brakingMaster.achievedNow).toBe(false);
    expect(brakingMaster.unlocked).toBe(true);
  });

  it('requires measured phone coverage for focus mastery', () => {
    const unmeasured = Array.from({ length: 40 }, (_, index) => trip(index, {
      phone_use_score_available: false,
      phone_use_risk: 'none',
    }));
    const progression = buildDriverProgression(unmeasured, {}, { now: NOW });
    const focus = progression.masteryTracks.find((track) => track.id === 'focus');

    expect(focus.score).toBeNull();
    expect(focus.tiers.every((tier) => tier.unlocked === false)).toBe(true);
  });

  it('does not mark under-limit weekly goals complete before evidence qualifies', () => {
    const emptyGoals = calculateWeeklyDrivingGoals([], {});
    const thisWeek = new Date().toISOString();
    const qualifiedGoals = calculateWeeklyDrivingGoals([
      trip(0, { start_time: thisWeek }),
      trip(1, { start_time: thisWeek }),
      trip(2, { start_time: thisWeek }),
    ], {});

    expect(emptyGoals.every((goal) => goal.met === false && goal.status === 'building_evidence')).toBe(true);
    expect(qualifiedGoals.every((goal) => goal.qualified === true)).toBe(true);
    expect(qualifiedGoals.find((goal) => goal.id === 'harsh_brakes').met).toBe(true);
  });

  it('locks the weekly plan and allows exactly three selected mission candidates', () => {
    const baselineTrips = Array.from({ length: 18 }, (_, index) => trip(index, {
      braking_efficiency_score: 70,
      harsh_brakes_count: 2,
    }));
    const initial = buildDriverProgression(baselineTrips, {}, { now: NOW });
    const synced = syncDriverProgressionLedger(initial, { version: 1, mastery: {}, missions: {} });
    const changedEvidence = baselineTrips.map((item) => ({
      ...item,
      braking_efficiency_score: 98,
      harsh_brakes_count: 0,
      score_smoothness: 60,
      rapid_accel_count: 4,
    }));
    const locked = buildDriverProgression(changedEvidence, {}, { now: NOW, ledger: synced.ledger });
    const selectedIds = locked.missionCandidates.slice(-3).map((mission) => mission.id);
    const selectedLedger = updateDriverProgressionMissionSelection(locked.missionPlan.weekKey, selectedIds, synced.ledger);
    const selected = buildDriverProgression(changedEvidence, {}, { now: NOW, ledger: selectedLedger });

    expect(locked.missionPlan.primaryTrackId).toBe(initial.missionPlan.primaryTrackId);
    expect(selected.missions.map((mission) => mission.id)).toEqual(selectedIds);
    expect(selectedLedger.weeklyPlans[locked.missionPlan.weekKey].selectionLocked).toBe(true);
    expect(updateDriverProgressionMissionSelection(locked.missionPlan.weekKey, selectedIds.slice(0, 2), selectedLedger).weeklyPlans[locked.missionPlan.weekKey].activeMissionIds).toEqual(selectedIds);
  });

  it('creates route-specific and comparable-context mission candidates without raw route keys in the plan', () => {
    const trips = Array.from({ length: 10 }, (_, index) => trip(index, {
      route_points: repeatedRoute,
      dominant_road_type: 'city',
    }));
    const progression = buildDriverProgression(trips, {}, { now: NOW });

    expect(progression.missionCandidates.some((mission) => mission.title === 'Route mastery')).toBe(true);
    expect(progression.missionCandidates.some((mission) => mission.category === 'Comparable context')).toBe(true);
    expect(progression.missionPlan.routeId).toMatch(/^[a-z0-9]+$/);
    expect(JSON.stringify(progression.missionPlan)).not.toContain('43.65');
  });

  it('records XP transactions once and queues acknowledgement-based celebrations', () => {
    const excellentTrips = Array.from({ length: 45 }, (_, index) => trip(index, {
      distance_km: 25,
      score_overall: 97,
      score_safety: 97,
      score_smoothness: 97,
      score_eco: 97,
      braking_efficiency_score: 98,
      cornering_consistency_score: 98,
      overall_compliance_score: 98,
    }));
    const initial = buildDriverProgression(excellentTrips, {}, { now: NOW });
    const firstSync = syncDriverProgressionLedger(initial, { version: 1, mastery: {}, missions: {} });
    const afterFirst = buildDriverProgression(excellentTrips, {}, { now: NOW, ledger: firstSync.ledger });
    const secondSync = syncDriverProgressionLedger(afterFirst, firstSync.ledger);
    const transactionIds = secondSync.ledger.xpTransactions.map((transaction) => transaction.id);
    const pending = secondSync.ledger.celebrations.find((celebration) => !celebration.seen);
    const acknowledged = acknowledgeDriverProgressionCelebration(pending.id, secondSync.ledger);

    expect(firstSync.newUnlocks.length).toBeGreaterThan(0);
    expect(secondSync.newUnlocks).toHaveLength(0);
    expect(new Set(transactionIds).size).toBe(transactionIds.length);
    expect(afterFirst.xp.total).toBeGreaterThan(0);
    expect(acknowledged.celebrations.find((celebration) => celebration.id === pending.id).seen).toBe(true);
  });

  it('keeps earned progression badges available for notification delivery retries', () => {
    const storedValues = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => storedValues.get(key) ?? null),
      setItem: vi.fn((key, value) => storedValues.set(key, value)),
    });
    const excellentTrips = Array.from({ length: 45 }, (_, index) => trip(index, {
      distance_km: 25,
      score_overall: 97,
      score_safety: 97,
      score_smoothness: 97,
      score_eco: 97,
      braking_efficiency_score: 98,
      cornering_consistency_score: 98,
      overall_compliance_score: 98,
    }));
    const first = processDriverProgressionAfterTrip(excellentTrips, {}, { now: NOW });
    const second = processDriverProgressionAfterTrip(excellentTrips, {}, { now: NOW });

    expect(first.notificationBadges.length).toBeGreaterThan(0);
    expect(second.newUnlocks).toHaveLength(0);
    expect(second.notificationBadges).toEqual(first.notificationBadges);
  });

  it('builds seasonal challenges and exposes skill evidence confidence', () => {
    const trips = Array.from({ length: 20 }, (_, index) => trip(index));
    const progression = buildDriverProgression(trips, {}, { now: NOW });

    expect(progression.season.challenges).toHaveLength(3);
    expect(progression.formSeries.length).toBe(20);
    expect(progression.masteryTracks.every((track) => track.evidence?.confidence)).toBe(true);
  });
});
