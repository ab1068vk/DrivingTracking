import { describe, expect, it, vi } from 'vitest';

import { composeDashboardRefetch } from '@/hooks/useDashboardData';

/**
 * DPD-024, second half -- the Dashboard's own Refresh control did not move the
 * lifetime totals on the device, because the hook forwarded only the 60-row
 * window query's `refetch`. The lifetime aggregate, the today page and the
 * activity reducer were never asked, so a user watching the Dashboard while D1
 * converged behind them kept the bounded window until they restarted the app.
 *
 * Refresh must refresh what the page shows.
 */
describe('DPD-024 Dashboard refresh covers every query the page reads', () => {
  const fakeQuery = (label) => ({
    label,
    refetch: vi.fn(async () => ({ data: label })),
  });

  it('refetches every query it is given, not just the first', async () => {
    const queries = ['window', 'today', 'lifetime', 'activity'].map(fakeQuery);

    await composeDashboardRefetch(queries);

    queries.forEach((query) => {
      expect(query.refetch, `${query.label} was never refetched`).toHaveBeenCalledTimes(1);
    });
  });

  it('resolves with the window result, so existing callers are unchanged', async () => {
    const queries = ['window', 'today', 'lifetime', 'activity'].map(fakeQuery);

    const resolved = await composeDashboardRefetch(queries);

    expect(resolved).toEqual({ data: 'window' });
  });

  it('refetches concurrently rather than serially', async () => {
    const started = [];
    const queries = ['window', 'today', 'lifetime', 'activity'].map((label) => ({
      label,
      refetch: vi.fn(() => {
        started.push(label);
        return new Promise((resolve) => { setTimeout(() => resolve({ data: label }), 0); });
      }),
    }));

    const pending = composeDashboardRefetch(queries);
    // Every refetch is invoked before any of them settles.
    expect(started).toEqual(['window', 'today', 'lifetime', 'activity']);
    await pending;
  });

  it('rejects if a query fails, rather than reporting a refresh that did not happen', async () => {
    const queries = [
      fakeQuery('window'),
      { label: 'today', refetch: vi.fn(async () => { throw new Error('today failed'); }) },
      fakeQuery('lifetime'),
      fakeQuery('activity'),
    ];

    await expect(composeDashboardRefetch(queries)).rejects.toThrow('today failed');
  });
});
