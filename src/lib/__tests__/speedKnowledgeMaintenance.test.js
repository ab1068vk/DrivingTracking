import { describe, expect, it, vi } from 'vitest';

import {
  formatApproximateBytes,
  MAX_SPEED_KNOWLEDGE_RETENTION_DAYS,
  MIN_SPEED_KNOWLEDGE_RETENTION_DAYS,
  pruneSpeedKnowledge,
  speedKnowledgeRetentionDays,
  summarizeSpeedKnowledgeStorage,
} from '@/lib/speed/speedKnowledgeMaintenance';
import { SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT } from '@/lib/appConstants';

describe('speedKnowledgeRetentionDays', () => {
  it('falls back to the shared default when unset', () => {
    expect(speedKnowledgeRetentionDays({})).toBe(SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT);
    expect(speedKnowledgeRetentionDays({ speed_knowledge_retention_days: '' }))
      .toBe(SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT);
    expect(speedKnowledgeRetentionDays({ speed_knowledge_retention_days: 'soon' }))
      .toBe(SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT);
  });

  it('clamps a restored or typed value into the supported range', () => {
    expect(speedKnowledgeRetentionDays({ speed_knowledge_retention_days: 0 }))
      .toBe(MIN_SPEED_KNOWLEDGE_RETENTION_DAYS);
    expect(speedKnowledgeRetentionDays({ speed_knowledge_retention_days: 99999 }))
      .toBe(MAX_SPEED_KNOWLEDGE_RETENTION_DAYS);
    expect(speedKnowledgeRetentionDays({ speed_knowledge_retention_days: 90 })).toBe(90);
  });
});

describe('summarizeSpeedKnowledgeStorage', () => {
  it('counts rules in force apart from retained historical versions', () => {
    const summary = summarizeSpeedKnowledgeStorage({
      corrections: [
        { id: 'a' },
        { id: 'b' },
        { id: 'c', historicalVersion: true },
      ],
      cells: { g1: {}, g2: {} },
      excludedSections: [{ key: 'x' }],
      roadMemory: { candidates: [{}, {}, {}] },
    });

    expect(summary).toMatchObject({
      ruleCount: 2,
      historicalRuleCount: 1,
      learnedRoadCount: 3,
      cellCount: 2,
      excludedSectionCount: 1,
    });
    expect(summary.approximateBytes).toBeGreaterThan(0);
  });

  it('reports zeroes rather than throwing on an empty or malformed document', () => {
    expect(summarizeSpeedKnowledgeStorage(null)).toMatchObject({
      ruleCount: 0,
      learnedRoadCount: 0,
      cellCount: 0,
    });
    expect(summarizeSpeedKnowledgeStorage({ corrections: 'nope', cells: 7 })).toMatchObject({
      ruleCount: 0,
      cellCount: 0,
    });
  });

  it('survives a document that cannot be serialized', () => {
    const cyclic = /** @type {any} */ ({ corrections: [] });
    cyclic.self = cyclic;
    expect(summarizeSpeedKnowledgeStorage(cyclic).approximateBytes).toBe(0);
  });
});

describe('formatApproximateBytes', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatApproximateBytes(0)).toBe('0 KB');
    expect(formatApproximateBytes(512)).toBe('512 B');
    expect(formatApproximateBytes(4096)).toBe('4 KB');
    expect(formatApproximateBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('pruneSpeedKnowledge', () => {
  const knowledgeStub = (documents) => {
    let call = 0;
    return {
      prune: vi.fn(async () => true),
      exportData: vi.fn(async () => documents[Math.min(call++, documents.length - 1)]),
    };
  };

  it('prunes at the clamped retention window and reports it back', async () => {
    const knowledge = knowledgeStub([{ corrections: [] }, { corrections: [] }]);

    const result = await pruneSpeedKnowledge(knowledge, { retentionDays: 5000 });

    expect(knowledge.prune).toHaveBeenCalledWith(MAX_SPEED_KNOWLEDGE_RETENTION_DAYS);
    expect(result.retentionDays).toBe(MAX_SPEED_KNOWLEDGE_RETENTION_DAYS);
  });

  it('hands the before and after documents to the rescore callback', async () => {
    const before = { corrections: [{ id: 'a' }, { id: 'b' }] };
    const after = { corrections: [{ id: 'a' }] };
    const knowledge = knowledgeStub([before, after]);
    const rescore = vi.fn(async () => [{ id: 'trip-1' }]);

    const result = await pruneSpeedKnowledge(knowledge, { retentionDays: 90, rescore });

    expect(rescore).toHaveBeenCalledWith(before, after);
    expect(result.updatedTrips).toEqual([{ id: 'trip-1' }]);
    expect(result.storage.ruleCount).toBe(1);
  });

  it('reports no recalculated trips rather than a bogus list when rescoring is skipped', async () => {
    const knowledge = knowledgeStub([{ corrections: [] }, { corrections: [] }]);

    const result = await pruneSpeedKnowledge(knowledge, { retentionDays: 90 });

    expect(result.updatedTrips).toBeNull();
  });
});
