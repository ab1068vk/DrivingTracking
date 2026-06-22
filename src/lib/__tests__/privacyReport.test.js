import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendPrivacyEvent, verifyCheckpoint } from '@/lib/hashChainLog';
import { verifyExport } from '@/lib/exportIntegrity';
import {
  exportPrivacyReport,
  PRIVACY_REPORT_HEADER,
} from '@/lib/privacyReport';

const storage = new Map();

describe('Privacy Report export', () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => storage.get(key) ?? null),
      setItem: vi.fn((key, value) => storage.set(key, value)),
      removeItem: vi.fn((key) => storage.delete(key)),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs a safe-worded report whose embedded checkpoint verifies against the live chain', async () => {
    await appendPrivacyEvent({ op: 'ZONE_SAVED' });
    const protections = Array.from({ length: 6 }, (_, index) => ({
      id: `control-${index}`,
      label: `Control ${index}`,
      category: index % 2 ? 'device' : 'network',
      status: index === 0 ? 'error' : 'warn',
      weight: 6 - index,
      riskIfMissing: `Risk ${index}`,
      userAction: `Action ${index}`,
    }));

    const report = await exportPrivacyReport({
      score: {
        overall: 89,
        label: 'Good',
        tone: 'ok',
        layers: [],
        summary: {},
        webCapApplied: true,
        capReason: 'Capped because this is a web build; install the Android app for hardware-backed checks.',
      },
      protectionSummary: { warnings: 5, errors: 1 },
      protections,
      zoneSummary: { zoneCount: 1 },
      drivingReadout: { tripCount: 4, rawPointInsideZoneCount: 0 },
      chainResult: { valid: true, length: 1 },
    });

    expect(await verifyExport(report)).toMatchObject({ valid: true });
    expect(report.payload).toMatchObject({
      header: PRIVACY_REPORT_HEADER,
      score: {
        overall: 89,
        webCapApplied: true,
        capNote: 'Capped because this is a web build; install the Android app for hardware-backed checks.',
      },
      protectionSummary: { warnings: 5, errors: 1 },
      zoneSummary: { zoneCount: 1 },
      drivingReadout: { tripCount: 4, rawPointInsideZoneCount: 0 },
      audit: {
        chainResult: { valid: true, length: 1 },
        signatureStatus: 'unsigned',
      },
    });
    expect(report.payload.recommendations).toHaveLength(5);
    expect(report.payload.recommendations.every((item) => item.userAction)).toBe(true);
    await expect(verifyCheckpoint(report.payload.auditCheckpoint)).resolves.toMatchObject({
      valid: true,
      signatureStatus: 'unsigned',
    });
  });
});
