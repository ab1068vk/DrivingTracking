import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendPrivacyEvent, verifyCheckpoint } from '@/lib/hashChainLog';
import { verifyExport } from '@/lib/exportIntegrity';
import {
  decryptPrivacyReportText,
  ENCRYPTED_PRIVACY_REPORT_FORMAT,
  exportEncryptedPrivacyReport,
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

  it('exports when no audit checkpoint exists yet', async () => {
    const report = await exportPrivacyReport({
      score: { overall: 72, label: 'Checking', tone: 'warn' },
      chainResult: { valid: true, length: 0 },
    });

    expect(await verifyExport(report)).toMatchObject({ valid: true });
    expect(report.payload.auditCheckpoint).toBeNull();
    expect(report.payload.audit).toMatchObject({
      checkpointAvailable: false,
      signatureStatus: 'unavailable',
    });
  });

  it('encrypts the report and keeps sensitive source fields out of the decrypted payload', async () => {
    const password = 'correct horse battery staple';
    const { report, encryptedText } = await exportEncryptedPrivacyReport({
      score: { overall: 90, label: 'Good', tone: 'ok' },
      protectionSummary: {
        warnings: 0,
        findings: [{
          id: 'network',
          label: 'Network control',
          status: 'ok',
          evidence: 'Checked lat=43.65001 and contact test@example.com before export.',
          token: 'should-not-export',
        }],
        rawCoordinates: { lat: 43.65001, lng: -79.38001 },
      },
      zoneSummary: {
        zoneCount: 1,
        activeZoneCount: 1,
        lat: 43.65001,
        lng: -79.38001,
        radius_m: 150,
        label: 'Home',
      },
      drivingReadout: {
        tripCount: 2,
        rawPointInsideZoneCount: 0,
        route_points: [{ lat: 43.65001, lng: -79.38001 }],
      },
      chainResult: {
        valid: true,
        length: 0,
        reason: 'No issue at 43.65001,-79.38001',
      },
    }, password);

    expect(JSON.parse(encryptedText)).toMatchObject({
      app: 'Road Sage',
      format: ENCRYPTED_PRIVACY_REPORT_FORMAT,
    });
    expect(encryptedText).not.toContain('43.65001');
    expect(encryptedText).not.toContain('test@example.com');
    expect(encryptedText).not.toContain('Home');

    const decrypted = JSON.parse(await decryptPrivacyReportText(encryptedText, password));
    expect(decrypted).toEqual(report);
    expect(await verifyExport(decrypted)).toMatchObject({ valid: true });

    const plaintext = JSON.stringify(decrypted);
    expect(plaintext).not.toContain('43.65001');
    expect(plaintext).not.toContain('-79.38001');
    expect(plaintext).not.toContain('test@example.com');
    expect(plaintext).not.toContain('should-not-export');
    expect(plaintext).not.toContain('Home');
    expect(decrypted.payload.protectionSummary.findings[0].evidence).toContain('[redacted-coordinate]');
    expect(decrypted.payload.protectionSummary.findings[0].evidence).toContain('[redacted-email]');
  });
});
