import { describe, expect, it } from 'vitest';
import { buildRoadSpeedCommandState } from '@/components/RoadSpeedCommandCenter';
import { SCOPE_STATE, atLeastTotal } from '@/lib/scopeDisclosure';
import { isSpeedSampleBounded, markSpeedSampleBounded } from '@/lib/speedKnowledgeRepository';

/**
 * DPD-016 — "Saved road speeds" fell 16 -> 4 -> 3 with no user action.
 *
 * Traced to `speedKnowledgeStore.getSample(8)`. Under **v1** authority it
 * returned the whole stored document, so counting its corrections was correct.
 * Under **browser-v2** it returns the first 8 partitions only:
 *
 *     const page = await p6ListV2BucketIds({ limit: 8 });
 *     return readP6BrowserSpeedBuckets(page.items);
 *
 * The Speed Limits header went on counting what it received and printing it as
 * the total. The 16 imported corrections were never deleted — the ones outside
 * the sampled partitions were simply never read. That is the same class of
 * defect as DPD-017: a bounded population presented as a complete one.
 *
 * These tests pin the sample marker and the wording that depends on it. Whether
 * the device's partitions really do hold more than three corrections is a
 * separate physical readback; this file proves only that a bounded sample can
 * no longer be stated as a total.
 */

describe('a speed-knowledge sample says whether it is one', () => {
  it('marks a bounded sample without changing its value', () => {
    const value = { corrections: [{ id: 'a' }], cells: {} };
    const marked = markSpeedSampleBounded(value, true);

    expect(marked).toBe(value);
    expect(isSpeedSampleBounded(marked)).toBe(true);
    // Non-enumerable: every existing consumer sees exactly what it saw before.
    expect(Object.keys(marked)).toEqual(['corrections', 'cells']);
    expect(JSON.parse(JSON.stringify(marked))).toEqual({ corrections: [{ id: 'a' }], cells: {} });
  });

  it('marks a complete read as not bounded', () => {
    const marked = markSpeedSampleBounded({ corrections: [] }, false);
    expect(isSpeedSampleBounded(marked)).toBe(false);
  });

  it('tolerates a missing or non-object sample', () => {
    expect(markSpeedSampleBounded(null, true)).toBeNull();
    expect(isSpeedSampleBounded(null)).toBe(false);
    expect(isSpeedSampleBounded(undefined)).toBe(false);
    expect(isSpeedSampleBounded({})).toBe(false);
  });
});

describe('saved-speed counts are floors when the model was sampled', () => {
  const state = (bounded) => buildRoadSpeedCommandState({
    bounded, savedCount: 3, postedCount: 0, estimatedCount: 3,
    reviewCount: 0, learningCount: 0, cameraCount: 0, mapStatus: 'idle',
  });

  it('states a sampled count as a floor', () => {
    const view = state(true);
    // The exact sentence the device printed, now floored.
    expect(view.title).toBe('at least 3 saved road speeds working for you');
    expect(view.detail).toContain('at least 0 posted and at least 3 estimated');
  });

  it('states a complete count as fact', () => {
    const view = state(false);
    expect(view.title).toBe('3 saved road speeds working for you');
    expect(view.detail).toContain('0 posted and 3 estimated');
    expect(view.detail).not.toContain('at least');
  });

  it('is the same count under both, and only the sample marker moves the wording', () => {
    expect(state(true).title).not.toBe(state(false).title);
  });
});

describe('the header chip uses the same law', () => {
  it('floors a sampled total and states a complete one', () => {
    // `SpeedLimits.jsx` renders `atLeastTotal(active + memory, savedRowsScope)`.
    const sampled = SCOPE_STATE.PARTIAL;
    const complete = SCOPE_STATE.VERIFIED;
    expect(atLeastTotal('3', sampled)).toBe('at least 3');
    expect(atLeastTotal('16', complete)).toBe('16');
  });
});
