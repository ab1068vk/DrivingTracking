import { describe, expect, it } from 'vitest';
import {
  MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE,
  describeLearnedSourceConfidence,
  learnedSourceConfidence,
  summarizeSourceReliability,
} from '@/lib/scoring/learnedSourceReliability';
import { SPEED_LIMIT_SOURCE_PROFILES } from '@/lib/speedLimitConfidence';

const cell = (entries) => ({ auditTrail: entries });
const observation = (pointSource, observedLimitKmh, limitKmh) => ({
  action: 'evidence_added',
  pointSource,
  observedLimitKmh,
  limitKmh,
});

describe('summarizeSourceReliability', () => {
  it('counts agreements and disagreements per source', () => {
    const totals = summarizeSourceReliability([
      cell([
        observation('openstreetmap', 50, 50),
        observation('openstreetmap', 50, 50),
        observation('openstreetmap', 60, 50),
      ]),
      cell([observation('inferred', 30, 50)]),
    ]);
    expect(totals.openstreetmap).toEqual({ observations: 3, agreements: 2, hitRate: 0.667 });
    expect(totals.inferred).toEqual({ observations: 1, agreements: 0, hitRate: 0 });
  });

  it('treats a sub-1 difference as agreement rather than a miss', () => {
    const totals = summarizeSourceReliability([cell([observation('openstreetmap', 50.4, 50)])]);
    expect(totals.openstreetmap.agreements).toBe(1);
  });

  it('ignores entries with nothing to compare', () => {
    const totals = summarizeSourceReliability([
      cell([
        { action: 'created', pointSource: 'openstreetmap' },
        observation(null, 50, 50),
        observation('openstreetmap', null, 50),
      ]),
    ]);
    expect(totals).toEqual({});
  });

  it('tolerates malformed input', () => {
    expect(summarizeSourceReliability(null)).toEqual({});
    expect(summarizeSourceReliability([{}, { auditTrail: 'nope' }])).toEqual({});
  });
});

describe('learnedSourceConfidence', () => {
  const reference = SPEED_LIMIT_SOURCE_PROFILES.openstreetmap.confidence;

  it('returns the reference profile untouched below the observation floor', () => {
    const reliability = { openstreetmap: { observations: 4, agreements: 4, hitRate: 1 } };
    const result = learnedSourceConfidence('openstreetmap', reliability, reference);
    expect(result).toEqual({
      confidence: reference,
      basis: 'reference',
      observations: 4,
      hitRate: null,
    });
  });

  it('returns the reference profile when nothing has been observed', () => {
    expect(learnedSourceConfidence('openstreetmap', {}, reference)).toMatchObject({
      confidence: reference,
      basis: 'reference',
      observations: 0,
    });
  });

  it('moves toward the observed rate once there is enough evidence', () => {
    const reliability = {
      inferred: { observations: 40, agreements: 36, hitRate: 0.9 },
    };
    const referenceInferred = SPEED_LIMIT_SOURCE_PROFILES.inferred.confidence;
    const result = learnedSourceConfidence('inferred', reliability, referenceInferred);
    expect(result.basis).toBe('learned');
    // A source the fixed table trusts least, but which this driver's own data
    // shows performing well, must be allowed to rise.
    expect(result.confidence).toBeGreaterThan(referenceInferred);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it('shrinks a short streak toward the reference instead of jumping to a certainty', () => {
    const reliability = {
      openstreetmap: {
        observations: MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE,
        agreements: MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE,
        hitRate: 1,
      },
    };
    const result = learnedSourceConfidence('openstreetmap', reliability, reference);
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThan(reference);
  });

  it('lets a consistently wrong source fall below its reference confidence', () => {
    const reliability = { openstreetmap: { observations: 50, agreements: 5, hitRate: 0.1 } };
    const result = learnedSourceConfidence('openstreetmap', reliability, reference);
    expect(result.confidence).toBeLessThan(reference);
  });

  it('never returns a confidence outside 0..1', () => {
    const result = learnedSourceConfidence(
      'inferred',
      { inferred: { observations: 100, agreements: 100, hitRate: 1 } },
      1
    );
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe('describeLearnedSourceConfidence', () => {
  it('describes a learned rate', () => {
    expect(describeLearnedSourceConfidence({ basis: 'learned', hitRate: 0.87, observations: 34 }))
      .toBe('Matched your confirmed limits 87% of the time across 34 observations.');
  });

  it('says nothing when the value is still the fixed reference', () => {
    expect(describeLearnedSourceConfidence({ basis: 'reference' })).toBeNull();
    expect(describeLearnedSourceConfidence(null)).toBeNull();
  });
});
