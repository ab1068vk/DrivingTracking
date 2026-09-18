import { describe, expect, it } from 'vitest';

import {
  P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES,
  P6_DOMAIN_KEYS,
  P6_EXPLICIT_OPERATION_TYPES,
  P6_JOB_KEYS,
  P6_MANUAL_SPEED_HEADROOM_BYTES,
  P6_MAX_SPEED_PARTITION_BYTES,
  P6_PLAN_COUNTS,
  P6_READINESS_STATES,
  P6_REQUIREMENTS,
  assertFrozenP6Contract,
  normalizeP6Readiness,
  p6CompositeReadiness,
} from '@/lib/p6Contracts';
import {
  P6_DERIVED_STORAGE_RESERVE_BYTES,
  assessP6DerivedStorage,
  orderP6ReclamationCandidates,
  p6DerivedFootprintEnvelope,
  p6DerivedReplacementEnvelope,
} from '@/lib/p6DerivedStorage';
import {
  P6_PROVENANCE_DISPOSITIONS,
  applyP6EvidenceDisposition,
  composeP6CandidateEvidence,
  freezeP6Receipt,
  p6EvidencePartCount,
  reconcileP6E2Evidence,
} from '@/lib/p6RoadEvidence';
import { p6GridCellsForDescriptor } from '@/lib/p6TripDerivedState';
import { mergeRoadMemoryObservation } from '@/lib/localRoadMemory';

describe('P6 frozen contracts', () => {
  it('covers traced segment interiors and match-radius neighbour cells', async () => {
    const cells = await p6GridCellsForDescriptor({
      kind: 'correction',
      sectionPoints: [{ lat: 43, lng: -79 }, { lat: 43, lng: -78.99 }],
    });
    const size = 0.00135;
    const middleLat = Math.floor((43 + 90) / size);
    const middleLng = Math.floor((-78.995 + 180) / size);
    expect(cells).toContain(`${middleLat}:${middleLng}`);
    expect(cells).toContain(`${middleLat + 1}:${middleLng}`);
  });
  it('does not truncate a long-corridor posting superset at one request page', async () => {
    const cells = await p6GridCellsForDescriptor({
      kind: 'correction',
      sectionPoints: [{ lat: 10, lng: 10 }, { lat: 10, lng: 12 }],
    });
    expect(cells.length).toBeGreaterThan(4096);
    const size = 0.00135;
    expect(cells).toContain(`${Math.floor(100 / size)}:${Math.floor(191 / size)}`);
  });
  it('keeps the approved counts and capacity identity exact', () => {
    expect(assertFrozenP6Contract()).toBe(true);
    expect(P6_PLAN_COUNTS).toEqual(expect.objectContaining({
      historical: 3, already: 0, still: 3, superseded: 0,
      newRequirements: 8, must: 17, should: 2, validations: 26,
      lifecycleJobs: 3, coordinatorRegistrations: 3, explicitOperations: 4,
    }));
    expect(P6_REQUIREMENTS.historical).toEqual(['P6-H01', 'P6-H02', 'P6-H03']);
    expect(P6_REQUIREMENTS.new).toHaveLength(8);
    expect(P6_REQUIREMENTS.must).toHaveLength(17);
    expect(P6_REQUIREMENTS.validations).toHaveLength(26);
    expect(Object.values(P6_JOB_KEYS)).toHaveLength(3);
    expect(Object.values(P6_EXPLICIT_OPERATION_TYPES)).toHaveLength(4);
    expect(P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES + P6_MANUAL_SPEED_HEADROOM_BYTES)
      .toBe(P6_MAX_SPEED_PARTITION_BYTES);
  });

  it('keeps D1-D4 independent and never treats an unknown state as verified', () => {
    const ready = Object.values(P6_DOMAIN_KEYS).map((domain) => ({
      domain, state: P6_READINESS_STATES.VERIFIED, complete: true,
      sourceBinding: 'generation-1', requiredVersion: 4, appliedVersion: 4,
    }));
    expect(p6CompositeReadiness(ready, [P6_DOMAIN_KEYS.ANALYTICS]).complete).toBe(true);
    const geometry = p6CompositeReadiness(ready, [P6_DOMAIN_KEYS.GEOMETRY]);
    expect(geometry.complete).toBe(true);
    expect(p6CompositeReadiness(ready.slice(0, 3), Object.values(P6_DOMAIN_KEYS)))
      .toEqual(expect.objectContaining({ complete: false, state: P6_READINESS_STATES.REBUILD_REQUIRED }));
    expect(normalizeP6Readiness({ domain: 'D1', state: 'EMPTY', complete: true }))
      .toEqual(expect.objectContaining({ state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false }));
  });

  it('blocks exactly below the 280 MiB derived reserve and admits the boundary', () => {
    expect(P6_DERIVED_STORAGE_RESERVE_BYTES).toBe(280 * 1024 * 1024);
    const boundary = assessP6DerivedStorage({
      quota: P6_DERIVED_STORAGE_RESERVE_BYTES + 100,
      usage: 50,
      proposedBytes: 50,
    });
    expect(boundary).toEqual(expect.objectContaining({ admitted: true, remaining: P6_DERIVED_STORAGE_RESERVE_BYTES }));
    expect(assessP6DerivedStorage({
      quota: P6_DERIVED_STORAGE_RESERVE_BYTES + 99,
      usage: 50,
      proposedBytes: 50,
    })).toEqual(expect.objectContaining({ admitted: false, state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED }));
    expect(assessP6DerivedStorage({ quota: undefined, usage: 0, proposedBytes: 0 }))
      .toEqual(expect.objectContaining({ admitted: false, reason: 'ESTIMATE_UNAVAILABLE' }));
  });

  it('uses deterministic scale envelopes for 5k trips, 3M public points, and 25k speed records', () => {
    const scale = { trips: 5_000, publicPoints: 3_000_000, speedRecords: 25_000 };
    const footprint = p6DerivedFootprintEnvelope(scale);
    expect(footprint).toBe(
      (32 * 1024 * 1024)
      + (5_000 * 24 * 1024)
      + (3_000_000 * 224)
      + (25_000 * 512)
    );
    expect(p6DerivedReplacementEnvelope(scale)).toBe((2 * footprint) + (16 * 1024 * 1024));
    expect(p6DerivedFootprintEnvelope({ trips: -1, publicPoints: -1, speedRecords: -1 }))
      .toBe(32 * 1024 * 1024);
  });

  it('reclaims only derived rows in deterministic order', () => {
    expect(orderP6ReclamationCandidates([
      { id: 'canonical', kind: 'OBSOLETE_STAGE', canonical: true },
      { id: 'frozen', kind: 'FROZEN_OBSERVATION_PAYLOAD', frozenBaseline: true },
      { id: 'preview', kind: 'PREVIEW_CACHE', updatedAt: 2 },
      { id: 'stage-b', kind: 'OBSOLETE_STAGE', updatedAt: 2 },
      { id: 'stage-a', kind: 'OBSOLETE_STAGE', updatedAt: 1 },
      { id: 'posting', kind: 'SPATIAL_POSTINGS', updatedAt: 1 },
    ]).map((item) => item.id)).toEqual(['stage-a', 'stage-b', 'preview', 'posting']);
  });
});

describe('P6 frozenBaseline + receiptedEvidence law', () => {
  const receipt = (overrides = {}) => ({
    receiptId: 'trip-a:2:0', tripId: 'trip-a', sourceRevision: 2,
    observationOrdinal: 0, membershipToken: 'member-a', observedAt: 1_000,
    scalars: {
      supportCount: 1, sampleCount: 20, limitVotes: { 50: 1 },
      agreementNumerator: 1, agreementDenominator: 1,
      confidenceNumerator: 0.8, confidenceDenominator: 1,
      timeBuckets: { weekday_morning: 1 },
    },
    ...overrides,
  });

  it('replaces a known frozen membership during E2 and remains idempotent', () => {
    const frozen = freezeP6Receipt(receipt(), 'member-a', { operational: true });
    const first = reconcileP6E2Evidence({ frozenBaseline: [frozen], replayedEvidence: [receipt()] });
    expect(first.frozenBaseline).toEqual([]);
    expect(first.receiptedEvidence).toHaveLength(1);
    expect(p6EvidencePartCount(first, { membershipToken: 'member-a', receiptId: 'trip-a:2:0' })).toBe(1);
    const second = reconcileP6E2Evidence({ ...first, replayedEvidence: [receipt()] });
    expect(second).toEqual(expect.objectContaining({ frozenBaseline: [], state: 'VERIFIED' }));
    expect(second.receiptedEvidence).toHaveLength(1);
  });

  it('does not add opaque replay evidence on top of a frozen share', () => {
    const frozen = freezeP6Receipt(receipt(), 'opaque-member', { operational: true });
    const result = reconcileP6E2Evidence({
      frozenBaseline: [frozen],
      replayedEvidence: [receipt({ receiptId: 'legacy', membershipToken: '', overlapKnown: false })],
    });
    expect(result.state).toBe('PARTIAL');
    expect(result.reason).toBe('LEGACY_OVERLAP_UNKNOWN');
    expect(result.frozenBaseline).toHaveLength(1);
    expect(result.receiptedEvidence).toHaveLength(0);
  });

  it('preserves operational continuity from frozen evidence without inventing freshness', () => {
    const scalars = {
      supportCount: 3, sampleCount: 60, limitVotes: { 50: 3 },
      agreementNumerator: 3, agreementDenominator: 3,
      confidenceNumerator: 2.1, confidenceDenominator: 3,
      timeBuckets: {},
    };
    const result = composeP6CandidateEvidence({
      frozenBaseline: [{ membershipToken: 'f', scalars, operationalAtFreeze: true }],
      receiptedEvidence: [], now: 10_000,
    });
    expect(result).toEqual(expect.objectContaining({
      operational: true, freshness: 'FROZEN_CONTINUITY', supportCount: 3,
    }));
  });

  it('freezes a live receipt without retaining source identity or timestamp', () => {
    const result = applyP6EvidenceDisposition({ receiptedEvidence: [receipt({ sourceIdentity: 'native:trip-a' })] }, {
      disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
      sourceIdentity: 'native:trip-a', operational: true,
    });
    expect(result.receiptedEvidence).toEqual([]);
    expect(result.frozenBaseline).toHaveLength(1);
    expect(JSON.stringify(result.frozenBaseline[0])).not.toContain('trip-a');
    expect(JSON.stringify(result.frozenBaseline[0])).not.toContain('observedAt');
  });

  it('uses production candidate merging to replace a frozen share during E2 replay', () => {
    const observation = {
      tripId: 'browser:trip-a', limitKmh: 50, sampleCount: 20,
      observedAt: 1_000, distanceM: 220, p85Kmh: 49,
      lat: 43.65, lng: -79.38, directionMode: 'both', directionBearing: 90,
      sectionPoints: [{ lat: 43.65, lng: -79.381 }, { lat: 43.65, lng: -79.379 }],
      p6Receipt: receipt({ sourceIdentity: 'browser:trip-a' }),
    };
    const live = mergeRoadMemoryObservation(null, observation, 'candidate-a');
    const frozenEvidence = applyP6EvidenceDisposition(live.p6AutomaticEvidence, {
      disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
      sourceIdentity: 'browser:trip-a',
      operational: false,
    });
    const retained = {
      ...live,
      tripVotes: {}, tripVoteOrder: [], tripIds: [], recentObservations: [],
      p6AutomaticEvidence: { version: 1, ...frozenEvidence },
    };
    const replayed = mergeRoadMemoryObservation(retained, observation, 'candidate-a');
    expect(p6EvidencePartCount(replayed.p6AutomaticEvidence, {
      membershipToken: 'member-a', receiptId: 'trip-a:2:0',
    })).toBe(1);
    expect(replayed.p6AutomaticEvidence.frozenBaseline).toEqual([]);
    expect(replayed.p6AutomaticEvidence.receiptedEvidence).toHaveLength(1);
    expect(composeP6CandidateEvidence(replayed.p6AutomaticEvidence).supportCount).toBe(1);
  });
});
