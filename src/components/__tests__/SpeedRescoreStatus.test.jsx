import { describe, expect, it } from 'vitest';
import { buildSpeedRescoreView } from '@/components/SpeedRescoreStatus';

describe('buildSpeedRescoreView', () => {
  it('reports a revision-aware historical score refresh in progress', () => {
    expect(buildSpeedRescoreView({
      activeJobs: 1,
      completedTrips: 4,
      totalTrips: 10,
      latest: { knowledgeRevision: 9, status: 'running' },
    }, {
      knowledgeRevision: 9,
      knowledgeUpdatedAt: '2026-08-01T10:00:00.000Z',
    })).toMatchObject({
      active: true,
      knowledgeRevision: 9,
      historicalRevision: 9,
      tone: 'running',
      title: 'Updating historical scores - 4 of 10',
    });
  });

  it('never calls history current when its completed revision trails live knowledge', () => {
    expect(buildSpeedRescoreView({
      activeJobs: 0,
      latest: {
        status: 'complete',
        completedAt: Date.parse('2026-08-01T11:00:00.000Z'),
        knowledgeRevision: 8,
      },
    }, {
      knowledgeRevision: 10,
    })).toMatchObject({
      waitingForRevision: true,
      revisionCurrent: false,
      tone: 'warning',
      title: 'Historical scores are waiting for road-speed revision 10',
    });
  });

  it('shows proof when historical scores match the live knowledge revision', () => {
    expect(buildSpeedRescoreView({
      activeJobs: 0,
      latest: {
        status: 'complete',
        completedAt: Date.parse('2026-08-01T11:00:00.000Z'),
        knowledgeRevision: 10,
      },
    }, {
      knowledgeRevision: 10,
    })).toMatchObject({
      revisionCurrent: true,
      tone: 'current',
      title: 'Historical scores match road-speed revision 10',
    });
  });

  it('uses cautious copy for legacy queue entries without revision proof', () => {
    expect(buildSpeedRescoreView({
      activeJobs: 0,
      latest: { status: 'complete', completedAt: 1 },
    }, {
      knowledgeRevision: 4,
    })).toMatchObject({
      revisionCurrent: false,
      title: 'Historical score update completed',
    });
  });
});
