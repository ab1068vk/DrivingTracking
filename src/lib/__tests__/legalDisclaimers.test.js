import { describe, expect, it } from 'vitest';
import {
  LEGAL_DATA_PRACTICES,
  LEGAL_DISCLAIMER_ITEMS,
  LEGAL_DISCLAIMER_SHORT,
  LEGAL_DISCLAIMER_SUMMARY,
  LEGAL_NOTICE_ACK_VERSION,
  LEGAL_NOTICE_INTRO,
  LEGAL_NOTICE_KEY_POINTS,
} from '@/lib/legalDisclaimers';

describe('legal and responsible-use explanations', () => {
  it('clearly identifies estimates and keeps driving responsibility with the user', () => {
    expect(LEGAL_DISCLAIMER_SHORT).toContain('Personal-use informational estimates only');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('You remain responsible for safe driving');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('posted signs');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('traffic laws');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('consent');
  });

  it('covers each high-risk interpretation without promising professional or emergency use', () => {
    const copy = LEGAL_DISCLAIMER_ITEMS.map(({ title, body }) => `${title} ${body}`).join(' ');

    expect(LEGAL_NOTICE_ACK_VERSION).toBeGreaterThan(0);
    expect(LEGAL_NOTICE_INTRO).toContain('local-first');
    expect(LEGAL_NOTICE_KEY_POINTS).toEqual(expect.arrayContaining([
      expect.stringContaining('Do not use the app while driving'),
      expect.stringContaining('may be wrong'),
      expect.stringContaining('outside services'),
    ]));
    expect(LEGAL_DISCLAIMER_ITEMS.length).toBeGreaterThanOrEqual(12);
    expect(LEGAL_NOTICE_ACK_VERSION).toBeGreaterThanOrEqual(5);
    expect(copy).toContain('Maps are not navigation');
    expect(copy.toLowerCase()).toContain('not official records');
    expect(copy).toContain('not diagnostics');
    expect(copy).toContain('does not monitor you for emergencies');
    expect(copy).toContain('No use for monitoring others without consent');
    expect(copy).toContain('Not for adverse decisions');
    expect(copy).toContain('No app-wide assurances');
    expect(copy).toContain('Background tracking requires consent');
    expect(copy).toContain('while the app is minimized or in the background');
    expect(copy).toContain('force-stopping the app can still stop Android tracking');
    expect(copy).toContain('Usage Access');
    expect(copy).toContain('Survey labels are local');
    expect(copy).toContain('Optional external requests');
    expect(copy).toContain('Backups, imports, and deletion');
    expect(copy).not.toMatch(/\bwill always\b/i);
  });

  it('summarizes sensitive data practices for the in-app privacy notice', () => {
    const summary = LEGAL_DATA_PRACTICES.map((item) => `${item.title} ${item.access} ${item.use} ${item.sharing}`).join(' ');

    expect(LEGAL_DATA_PRACTICES.length).toBeGreaterThanOrEqual(4);
    expect(summary).toContain('Background tracking');
    expect(summary).toContain('while the app is minimized');
    expect(summary).toContain('Fully closing or force-stopping the app can still stop Android tracking');
    expect(summary).toContain('OpenStreetMap');
    expect(summary).toContain('Open-Meteo');
    expect(summary).toContain('OSRM');
    expect(summary).toContain('Consent, control, and device access');
    expect(summary).toContain('backup files');
    expect(summary).toContain('cannot be recovered');
  });
});
