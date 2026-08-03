import { describe, expect, it } from 'vitest';

import fixture from '@/lib/__fixtures__/savedSpeedResolverParityFixture.json';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';

const knowledgeWithRoadMemorySupport = (knowledge, supportSet) => {
  const cloned = JSON.parse(JSON.stringify(knowledge || {}));
  const support = fixture.roadMemoryValidationSupport?.[supportSet] || [];
  if (!support.length) return cloned;
  cloned.roadMemory = {
    ...(cloned.roadMemory || {}),
    candidates: [
      ...JSON.parse(JSON.stringify(support)),
      ...(cloned.roadMemory?.candidates || []),
    ],
  };
  return cloned;
};

const resolverFor = (knowledge, supportSet) => new LocalSpeedKnowledge({
  get: async () => knowledgeWithRoadMemorySupport(knowledge, supportSet),
  set: async () => {},
});

describe('saved-speed web/native resolver contract', () => {
  it.each(fixture.cases)('$id', async ({ knowledge, query, expected, roadMemorySupport }) => {
    const resolved = await resolverFor(knowledge, roadMemorySupport).getForPoint(
      query.lat,
      query.lng,
      new Date(query.timestamp).getTime(),
      {
        headingDeg: query.headingDeg,
        utcOffsetMinutes: query.utcOffsetMinutes,
      }
    );

    if (expected == null) {
      expect(resolved).toBeNull();
      return;
    }
    expect(resolved).toMatchObject(expected);
  });
});
