import { describe, expect, it } from 'vitest';

import {
  P6_PROVENANCE_DISPOSITIONS, applyP6EvidenceDisposition, composeP6CandidateEvidence,
  reconcileP6E2Evidence,
} from '@/lib/p6RoadEvidence';

/**
 * P6-V17: an independent chronological model of a candidate's evidence, folded
 * in test code, against the incremental replacement the production reducer
 * performs. The law under test is exactly-one-part: every membership token
 * contributes its scalars once, whether it is live, frozen or replayed, and no
 * sequence of freeze, subtract and E2 replay may lose or double count it.
 */

const scalarsFor = (index) => ({
  supportCount: 1 + (index % 3),
  sampleCount: 10 + index,
  limitVotes: { [`${40 + (index % 3) * 10}`]: 1 + (index % 2) },
  agreementNumerator: 0.5 + (index % 4) * 0.1,
  agreementDenominator: 1,
  confidenceNumerator: 0.4 + (index % 5) * 0.1,
  confidenceDenominator: 1,
  timeBuckets: { [index % 2 === 0 ? 'day' : 'night']: 1 + (index % 2) },
});

const receiptFor = (index, tripId = `trip-${index}`) => ({
  receiptId: `${tripId}:1:${index}`,
  tripId,
  sourceRevision: '1',
  observationOrdinal: index,
  observedAt: 1_756_000_000_000 + index * 86_400_000,
  membershipToken: `token-${index}`,
  sourceIdentity: `browser:${tripId}`,
  overlapKnown: true,
  scalars: scalarsFor(index),
});

/**
 * The independent model: sum the scalars of every membership token the
 * candidate currently holds, in chronological order, with no knowledge of how
 * production stores them.
 */
const chronologicalModel = (tokens) => {
  const totals = {
    supportCount: 0, sampleCount: 0,
    agreementNumerator: 0, agreementDenominator: 0,
    confidenceNumerator: 0, confidenceDenominator: 0,
    limitVotes: {}, timeBuckets: {},
  };
  for (const index of [...tokens].sort((left, right) => left - right)) {
    const scalars = scalarsFor(index);
    totals.supportCount += scalars.supportCount;
    totals.sampleCount += scalars.sampleCount;
    totals.agreementNumerator += scalars.agreementNumerator;
    totals.agreementDenominator += scalars.agreementDenominator;
    totals.confidenceNumerator += scalars.confidenceNumerator;
    totals.confidenceDenominator += scalars.confidenceDenominator;
    for (const [key, count] of Object.entries(scalars.limitVotes)) {
      totals.limitVotes[key] = (totals.limitVotes[key] || 0) + count;
    }
    for (const [key, count] of Object.entries(scalars.timeBuckets)) {
      totals.timeBuckets[key] = (totals.timeBuckets[key] || 0) + count;
    }
  }
  return totals;
};

const expectMatchesModel = (evidence, tokens, label) => {
  const actual = composeP6CandidateEvidence({ ...evidence, now: 1_756_000_000_000 + 40 * 86_400_000 });
  const expected = chronologicalModel(tokens);
  expect(actual.supportCount, `${label} supportCount`).toBe(expected.supportCount);
  expect(actual.sampleCount, `${label} sampleCount`).toBe(expected.sampleCount);
  expect(actual.agreementNumerator, `${label} agreementNumerator`).toBeCloseTo(expected.agreementNumerator, 9);
  expect(actual.agreementDenominator, `${label} agreementDenominator`).toBeCloseTo(expected.agreementDenominator, 9);
  expect(actual.confidenceNumerator, `${label} confidenceNumerator`).toBeCloseTo(expected.confidenceNumerator, 9);
  expect(actual.confidenceDenominator, `${label} confidenceDenominator`)
    .toBeCloseTo(expected.confidenceDenominator, 9);
  expect(actual.limitVotes, `${label} limitVotes`).toEqual(expected.limitVotes);
  expect(actual.timeBuckets, `${label} timeBuckets`).toEqual(expected.timeBuckets);
  // Exactly one part per token, however the parts are stored.
  expect(actual.frozenShareCount + actual.liveReceiptCount, `${label} part count`).toBe(tokens.size);
  return actual;
};

describe('P6-V17 chronological evidence model', () => {
  const indexes = [0, 1, 2, 3, 4, 5, 6, 7];
  const allLive = { frozenBaseline: [], receiptedEvidence: indexes.map((index) => receiptFor(index)) };

  it('matches the model for an all-live candidate', () => {
    const totals = expectMatchesModel(allLive, new Set(indexes), 'all live');
    expect(totals.freshness).toBe('LIVE_FRESH');
  });

  it('keeps the model exact through freeze, subtract and an all-frozen end state', () => {
    // Freeze the first three identities: retention, so the scalars stay.
    let evidence = allLive;
    for (const index of [0, 1, 2]) {
      evidence = applyP6EvidenceDisposition(evidence, {
        disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
        sourceIdentity: `browser:trip-${index}`,
        operational: true,
      });
    }
    expectMatchesModel(evidence, new Set(indexes), 'after freeze');
    expect(evidence.frozenBaseline).toHaveLength(3);
    expect(evidence.receiptedEvidence).toHaveLength(5);

    // Erase two identities, one already frozen and one still live: erasure
    // removes their parts entirely.
    for (const index of [1, 5]) {
      evidence = applyP6EvidenceDisposition(evidence, {
        disposition: P6_PROVENANCE_DISPOSITIONS.SUBTRACT,
        sourceIdentity: `browser:trip-${index}`,
        membershipTokens: [`token-${index}`],
      });
    }
    const remaining = new Set(indexes.filter((index) => ![1, 5].includes(index)));
    expectMatchesModel(evidence, remaining, 'after subtract');

    // Freeze everything that is left: an all-frozen candidate is worth exactly
    // what it was worth live.
    for (const index of remaining) {
      evidence = applyP6EvidenceDisposition(evidence, {
        disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
        sourceIdentity: `browser:trip-${index}`,
        operational: true,
      });
    }
    const frozen = expectMatchesModel(evidence, remaining, 'all frozen');
    expect(evidence.receiptedEvidence).toHaveLength(0);
    expect(evidence.frozenBaseline).toHaveLength(remaining.size);
    expect(frozen.freshness).toBe('FROZEN_CONTINUITY');
  });

  it('replays E2 over a retained subset without loss or double count', () => {
    // Known set, freeze a subset, then E2 replays retained history: the
    // replayed receipts include both frozen and never-seen identities.
    let evidence = allLive;
    for (const index of [0, 1, 2, 3]) {
      evidence = applyP6EvidenceDisposition(evidence, {
        disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
        sourceIdentity: `browser:trip-${index}`,
        operational: true,
      });
    }
    expect(evidence.frozenBaseline).toHaveLength(4);

    const replayed = [
      receiptFor(0), receiptFor(2), // already frozen: the share is replaced, not added to
      receiptFor(4), receiptFor(6), // already live: the same receipt id, so ignored
      receiptFor(8), receiptFor(9), // genuinely new history
    ];
    const reconciled = reconcileP6E2Evidence({ ...evidence, replayedEvidence: replayed });
    expect(reconciled.state).toBe('VERIFIED');
    expect(reconciled.skipped).toEqual([]);
    expectMatchesModel(reconciled, new Set([...indexes, 8, 9]), 'after E2 replay');
    // The two replayed frozen identities became live again; the other two stay
    // frozen. Nothing is counted twice.
    expect(reconciled.frozenBaseline.map((share) => share.membershipToken).sort())
      .toEqual(['token-1', 'token-3']);

    // Replaying the identical set again changes nothing at all.
    const again = reconcileP6E2Evidence({ ...reconciled, replayedEvidence: replayed });
    expectMatchesModel(again, new Set([...indexes, 8, 9]), 'idempotent replay');
    expect(again.frozenBaseline.map((share) => share.membershipToken).sort())
      .toEqual(['token-1', 'token-3']);
  });

  it('refuses to add a receipt whose overlap with the baseline is unknown', () => {
    const evidence = applyP6EvidenceDisposition(allLive, {
      disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
      sourceIdentity: 'browser:trip-0',
      operational: true,
    });
    const legacy = { ...receiptFor(20), membershipToken: '', overlapKnown: false };
    const reconciled = reconcileP6E2Evidence({ ...evidence, replayedEvidence: [legacy] });
    expect(reconciled.state).toBe('PARTIAL');
    expect(reconciled.reason).toBe('LEGACY_OVERLAP_UNKNOWN');
    expect(reconciled.skipped).toEqual([{ receiptId: legacy.receiptId, reason: 'LEGACY_OVERLAP_UNKNOWN' }]);
    // The baseline is untouched: an unknown overlap never grows it.
    expectMatchesModel(reconciled, new Set(indexes), 'legacy overlap refused');
  });

  it('never grows the baseline when the same identity is frozen repeatedly', () => {
    let evidence = allLive;
    for (let round = 0; round < 5; round += 1) {
      evidence = applyP6EvidenceDisposition(evidence, {
        disposition: P6_PROVENANCE_DISPOSITIONS.FREEZE,
        sourceIdentity: 'browser:trip-3',
        operational: true,
      });
    }
    expect(evidence.frozenBaseline).toHaveLength(1);
    expectMatchesModel(evidence, new Set(indexes), 'repeated freeze');
  });
});
