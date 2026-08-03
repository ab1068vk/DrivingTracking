import { describe, expect, it } from 'vitest';
import { summarizePerformanceTriage } from '@/lib/performanceTriage';

describe('performance triage summary', () => {
  it('groups page and data timings and highlights genuinely slow work', () => {
    const summary = summarizePerformanceTriage([
      { name: 'page.firstPaint', pathname: '/speed-limits', durationMs: 120, at: '2026-08-02T12:00:00Z' },
      { name: 'page.firstPaint', pathname: '/speed-limits', durationMs: 180, at: '2026-08-02T12:01:00Z' },
      { name: 'tripService.listAllSummaries', durationMs: 1700, at: '2026-08-02T12:02:00Z' },
    ]);

    expect(summary[0]).toMatchObject({
      name: 'tripService.listAllSummaries',
      status: 'slow',
      latestMs: 1700,
    });
    expect(summary.find((item) => item.pathname === '/speed-limits')).toMatchObject({
      count: 2,
      averageMs: 150,
      status: 'good',
    });
  });
});
