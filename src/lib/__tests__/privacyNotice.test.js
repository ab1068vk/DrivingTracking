import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRIVACY_CONSENT_POINTS,
  PRIVACY_NOTICE_HIGHLIGHTS,
  PRIVACY_NOTICE_SUMMARY,
} from '@/lib/privacyNotice';

describe('privacy notice disclosures', () => {
  it('covers local storage, external services, masking, and deletion limits', () => {
    const notice = [
      PRIVACY_NOTICE_SUMMARY,
      ...PRIVACY_NOTICE_HIGHLIGHTS.map((item) => `${item.title} ${item.body}`),
      ...PRIVACY_CONSENT_POINTS,
    ].join('\n');

    [
      'local',
      'OpenStreetMap',
      'Open-Meteo',
      'OSRM',
      'privacy zones',
      'backups',
      'Deletion limits',
      'external services',
      'browser',
      'Android Keystore',
    ].forEach((term) => {
      expect(notice).toContain(term);
    });
  });

  it('keeps the docs notice aligned with the app notice topics', () => {
    const docs = readFileSync(new URL('../../../docs/PRIVACY_NOTICE.md', import.meta.url), 'utf8');

    [
      'What Stays Local',
      'What Can Leave The Device',
      'External Services',
      'Privacy Zones',
      'Exports And Backups',
      'Deletion Limits',
      'Consent Checkpoints',
    ].forEach((heading) => {
      expect(docs).toContain(heading);
    });
  });
});
