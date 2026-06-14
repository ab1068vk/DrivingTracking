import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  summarizeAudit,
  summarizeZones,
  transmissionPrivacyLevel,
  computePrivacyScoreFromControls,
} from '@/lib/privacyIntelligence';

describe('privacy intelligence summaries', () => {
  afterEach(() => vi.useRealTimers());

  it('classifies blocked, protected, and raw outbound location data', () => {
    expect(transmissionPrivacyLevel({ coordinateDisclosure: 'blocked' })).toBe('blocked');
    expect(transmissionPrivacyLevel({ coordinateDisclosure: 'none' })).toBe('none');
    expect(transmissionPrivacyLevel({
      coordinateDisclosure: 'bounding_box',
      privacyTransformVerified: true,
    })).toBe('protected');
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
});
