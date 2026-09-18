import { describe, expect, it, vi } from 'vitest';
import { createLatestAsyncRequestGuard } from '@/lib/latestAsyncRequest';

describe('latest async request guard', () => {
  it('rejects an older completion after a newer refresh begins', async () => {
    const guard = createLatestAsyncRequestGuard();
    const committed = vi.fn();
    let resolveOlder;
    let resolveNewer;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const newer = new Promise((resolve) => { resolveNewer = resolve; });
    const run = async (promise) => {
      const generation = guard.begin();
      const value = await promise;
      if (guard.isCurrent(generation)) committed(value);
    };
    const first = run(older);
    const second = run(newer);

    resolveNewer('newer');
    await second;
    resolveOlder('older');
    await first;

    expect(committed).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledWith('newer');
  });

  it('rejects an outstanding completion after unmount invalidation', () => {
    const guard = createLatestAsyncRequestGuard();
    const generation = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(generation)).toBe(false);
  });
});
