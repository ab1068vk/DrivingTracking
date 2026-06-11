import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logSystemFailure, recordTrackingDiagnostic } = vi.hoisted(() => ({
  logSystemFailure: vi.fn(),
  recordTrackingDiagnostic: vi.fn((event) => event),
}));

vi.mock('@/lib/systemLog', () => ({ logSystemFailure }));
vi.mock('@/lib/trackingDiagnostics', () => ({ recordTrackingDiagnostic }));

import { logError } from '@/lib/errorReporting';

describe('privacy-safe error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrubs error text and extra state before either reporting sink receives it', () => {
    const error = new Error('Map failed near 43.6532,-79.3832 at 2026-06-11T14:30:00.000Z');
    const extra = {
      trip: {
        routePoints: [{ lat: 43.6532, lng: -79.3832 }],
        timestamp: 1781188200000,
      },
    };

    logError('trip_map', error, extra);

    const systemPayload = JSON.stringify(logSystemFailure.mock.calls[0]);
    const diagnosticPayload = JSON.stringify(recordTrackingDiagnostic.mock.calls[0]);
    for (const payload of [systemPayload, diagnosticPayload]) {
      expect(payload).not.toContain('43.6532');
      expect(payload).not.toContain('-79.3832');
      expect(payload).not.toContain('1781188200000');
      expect(payload).not.toContain('2026-06-11T14:30:00.000Z');
    }
    expect(recordTrackingDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      context: 'trip_map',
      stack_preview: expect.stringContaining('[LAT_REDACTED]'),
    }));
  });
});
