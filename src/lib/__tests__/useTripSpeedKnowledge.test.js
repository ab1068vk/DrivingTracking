import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefetchLocalKnowledge = vi.fn();
const logSystemFailure = vi.fn();

vi.mock('@/lib/tripEngine', () => ({
  prefetchLocalKnowledge: (...args) => prefetchLocalKnowledge(...args),
}));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: (...args) => logSystemFailure(...args),
}));
vi.mock('@/lib/localSpeedKnowledge', () => ({
  LocalSpeedKnowledge: class {},
  SPEED_KNOWLEDGE_CHANGED_EVENT: 'drivesense:speed-knowledge-changed',
}));
vi.mock('@/lib/speedKnowledgeRepository', () => ({ speedKnowledgeStore: {} }));

const { resolveTripSpeedKnowledge } = await import('@/hooks/useTripSpeedKnowledge');

const tripWith = (n) => ({
  id: 'trip-1',
  route_points: Array.from({ length: n }, (_, i) => ({ lat: 51.5 + i * 0.001, lng: -0.12 })),
});

describe('resolveTripSpeedKnowledge', () => {
  beforeEach(() => {
    prefetchLocalKnowledge.mockReset();
    logSystemFailure.mockReset();
  });

  it('resolves through the heading-deriving path', async () => {
    // The divergence this replaced: Speed Analysis called knowledge.getForPoints,
    // which passes points through with no heading, while the resolver is
    // direction-aware — so it could report a different limit than Trip Detail
    // for the same trip.
    prefetchLocalKnowledge.mockResolvedValue([{ limitKmh: 50 }]);

    const result = await resolveTripSpeedKnowledge(tripWith(1));

    expect(prefetchLocalKnowledge).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ results: [{ limitKmh: 50 }], failed: false });
  });

  it('reports a load failure instead of silently returning nulls', async () => {
    prefetchLocalKnowledge.mockRejectedValue(new Error('store unreadable'));

    const result = await resolveTripSpeedKnowledge(tripWith(3));

    expect(result.failed).toBe(true);
    expect(logSystemFailure).toHaveBeenCalledTimes(1);
    const [context, error, extra] = logSystemFailure.mock.calls[0];
    expect(context).toBe('trip_speed_knowledge');
    expect(error).toBeInstanceOf(Error);
    expect(extra).toMatchObject({ trip_id: 'trip-1' });
  });

  it('keeps the failure result index-aligned with the route', async () => {
    // Callers index into this by route-point position. An empty array on failure
    // would silently misalign every lookup.
    prefetchLocalKnowledge.mockRejectedValue(new Error('nope'));

    const result = await resolveTripSpeedKnowledge(tripWith(5));

    expect(result.results).toHaveLength(5);
    expect(result.results.every((entry) => entry === null)).toBe(true);
  });

  it('labels the failure with the caller-supplied context', async () => {
    prefetchLocalKnowledge.mockRejectedValue(new Error('nope'));

    await resolveTripSpeedKnowledge(tripWith(1), { context: 'speed_analysis_local_speed_knowledge' });

    expect(logSystemFailure.mock.calls[0][0]).toBe('speed_analysis_local_speed_knowledge');
  });

  it('does not touch the store for a trip with no route points', async () => {
    const result = await resolveTripSpeedKnowledge({ id: 'empty', route_points: [] });

    expect(prefetchLocalKnowledge).not.toHaveBeenCalled();
    expect(logSystemFailure).not.toHaveBeenCalled();
    expect(result).toEqual({ results: [], failed: false });
  });

  it('does not touch the store for a null trip', async () => {
    const result = await resolveTripSpeedKnowledge(null);

    expect(prefetchLocalKnowledge).not.toHaveBeenCalled();
    expect(result.failed).toBe(false);
  });
});
