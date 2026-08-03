import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpeedMapModelCacheKey,
  clearSpeedMapModelCache,
  readSpeedMapModelCache,
  writeSpeedMapModelCache,
} from '@/lib/speedMapModelCache';

describe('speedMapModelCache', () => {
  beforeEach(() => clearSpeedMapModelCache());

  it('reuses an unchanged map model', () => {
    const key = buildSpeedMapModelCacheKey(
      [{ id: 'trip-1', updated_at: '2026-01-01', route_points: [{}, {}] }],
      [{ id: 'rule-1', limitKmh: 50 }],
      []
    );
    const sections = [{ sectionKey: 'section-1' }];
    writeSpeedMapModelCache(key, sections);
    expect(readSpeedMapModelCache(key)).toBe(sections);
  });

  it('invalidates when geometry changes without changing its point count', () => {
    const first = [{
      id: 'trip-1',
      route_points: [{ lat: 43.7, lng: -79.4 }, { lat: 43.71, lng: -79.39 }],
    }];
    const moved = [{
      id: 'trip-1',
      route_points: [{ lat: 43.7, lng: -79.4 }, { lat: 43.72, lng: -79.38 }],
    }];
    expect(buildSpeedMapModelCacheKey(first, [], []))
      .not.toBe(buildSpeedMapModelCacheKey(moved, [], []));
  });

  it('invalidates when a rule or trip revision changes', () => {
    const first = buildSpeedMapModelCacheKey(
      [{ id: 'trip-1', updated_at: '2026-01-01', route_points: [{}, {}] }],
      [{ id: 'rule-1', limitKmh: 50 }],
      []
    );
    const second = buildSpeedMapModelCacheKey(
      [{ id: 'trip-1', updated_at: '2026-01-02', route_points: [{}, {}] }],
      [{ id: 'rule-1', limitKmh: 60 }],
      []
    );
    expect(second).not.toBe(first);
  });
});
