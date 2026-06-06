import { describe, expect, it } from 'vitest';
import {
  LEGAL_DISCLAIMER_ITEMS,
  LEGAL_DISCLAIMER_SHORT,
  LEGAL_DISCLAIMER_SUMMARY,
  LEGAL_NOTICE_ACK_VERSION,
  LEGAL_NOTICE_INTRO,
} from '@/lib/legalDisclaimers';

describe('legal and responsible-use explanations', () => {
  it('clearly identifies estimates and keeps driving responsibility with the user', () => {
    expect(LEGAL_DISCLAIMER_SHORT).toContain('Personal-use estimates only');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('You remain responsible for safe driving');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('posted signs');
    expect(LEGAL_DISCLAIMER_SUMMARY).toContain('traffic laws');
  });

  it('covers each high-risk interpretation without promising professional or emergency use', () => {
    const copy = LEGAL_DISCLAIMER_ITEMS.map(({ title, body }) => `${title} ${body}`).join(' ');

    expect(LEGAL_NOTICE_ACK_VERSION).toBeGreaterThan(0);
    expect(LEGAL_NOTICE_INTRO).toContain('local-first');
    expect(LEGAL_DISCLAIMER_ITEMS.length).toBeGreaterThanOrEqual(12);
    expect(copy).toContain('Maps are not navigation');
    expect(copy.toLowerCase()).toContain('not official records');
    expect(copy).toContain('not diagnostics');
    expect(copy).toContain('does not monitor you for emergencies');
    expect(copy).toContain('Survey labels are local');
    expect(copy).toContain('Optional external requests');
    expect(copy).toContain('Backups, imports, and deletion');
    expect(copy).not.toMatch(/\bwill always\b/i);
  });
});
