import { describe, expect, it } from 'vitest';
import {
  buildLegalAcknowledgementRecord,
  classifyLegalAcknowledgement,
  LEGAL_ACK_STATES,
  legalNoticeReviewRequired,
} from '@/lib/legalNoticeAcknowledgement';
import {
  canonicalLegalNoticeContent,
  LEGAL_DATA_PRACTICES,
  LEGAL_DISCLAIMER_ITEMS,
  LEGAL_NOTICE_ACK_VERSION,
  LEGAL_NOTICE_CHANGELOG,
  LEGAL_NOTICE_KEY_POINTS,
} from '@/lib/legalDisclaimers';
import { LEGAL_NOTICE_CONTENT_HASH, LEGAL_NOTICE_HASHED_VERSION } from '@/lib/legalNoticeVersion.generated';

const HASH = LEGAL_NOTICE_CONTENT_HASH;
const V = LEGAL_NOTICE_ACK_VERSION;

describe('legal notice acknowledgement validity', () => {
  it('requires review when nothing has ever been acknowledged', () => {
    expect(classifyLegalAcknowledgement({})).toBe(LEGAL_ACK_STATES.NONE);
    expect(classifyLegalAcknowledgement({ legal_notice_ack_version: 0 })).toBe(LEGAL_ACK_STATES.NONE);
    expect(legalNoticeReviewRequired({})).toBe(true);
  });

  it('accepts a current acknowledgement bound to the presented content', () => {
    const settings = {
      legal_notice_ack_version: V,
      legal_notice_acknowledged_at: '2026-09-18T00:00:00.000Z',
      legal_notice_ack_content_hash: HASH,
    };
    expect(classifyLegalAcknowledgement(settings)).toBe(LEGAL_ACK_STATES.CONTENT_BOUND);
    expect(legalNoticeReviewRequired(settings)).toBe(false);
  });

  it('keeps existing version-only acknowledgements valid as legacy records', () => {
    // A real pre-hash v9 user: version and timestamp, no content hash. They did read the
    // current notice, so introducing hashing must not push them back through the dialog.
    const legacy = {
      legal_notice_ack_version: V,
      legal_notice_acknowledged_at: '2026-01-01T00:00:00.000Z',
    };
    expect(classifyLegalAcknowledgement(legacy)).toBe(LEGAL_ACK_STATES.VERSIONED_LEGACY);
    expect(legalNoticeReviewRequired(legacy)).toBe(false);

    const emptyHash = { ...legacy, legal_notice_ack_content_hash: '' };
    expect(classifyLegalAcknowledgement(emptyHash)).toBe(LEGAL_ACK_STATES.VERSIONED_LEGACY);
    expect(legalNoticeReviewRequired(emptyHash)).toBe(false);
  });

  it('requires review for an older acknowledged version', () => {
    const outdated = { legal_notice_ack_version: V - 1, legal_notice_ack_content_hash: HASH };
    expect(classifyLegalAcknowledgement(outdated)).toBe(LEGAL_ACK_STATES.OUTDATED);
    expect(legalNoticeReviewRequired(outdated)).toBe(true);
  });

  it('requires review when the same version was bound to different content', () => {
    // Discriminator: the version matches, so a version-only check would wrongly accept this.
    const mismatch = {
      legal_notice_ack_version: V,
      legal_notice_ack_content_hash: 'sha256-legal-notice-v1:0000000000000000000000000000dead',
    };
    expect(classifyLegalAcknowledgement(mismatch)).toBe(LEGAL_ACK_STATES.CONTENT_MISMATCH);
    expect(legalNoticeReviewRequired(mismatch)).toBe(true);
  });

  it('does not re-prompt a record from a newer build', () => {
    const ahead = { legal_notice_ack_version: V + 5, legal_notice_ack_content_hash: 'whatever' };
    expect(classifyLegalAcknowledgement(ahead)).toBe(LEGAL_ACK_STATES.AHEAD_OF_BUILD);
    expect(legalNoticeReviewRequired(ahead)).toBe(false);
  });

  it('fails safe on a corrupt acknowledgement record', () => {
    for (const bad of ['not-a-number', Number.NaN, -3, 1.5, {}]) {
      const settings = { legal_notice_ack_version: bad };
      expect(classifyLegalAcknowledgement(settings)).toBe(LEGAL_ACK_STATES.MALFORMED);
      expect(legalNoticeReviewRequired(settings)).toBe(true);
    }
  });

  it('writes version, timestamp and content hash when acknowledging', () => {
    const record = buildLegalAcknowledgementRecord({ acknowledgedAt: '2026-09-18T12:00:00.000Z' });
    expect(record).toEqual({
      legal_notice_ack_version: V,
      legal_notice_acknowledged_at: '2026-09-18T12:00:00.000Z',
      legal_notice_ack_content_hash: HASH,
    });
    // The record it writes must satisfy the check it will later face.
    expect(classifyLegalAcknowledgement(record)).toBe(LEGAL_ACK_STATES.CONTENT_BOUND);
  });
});

describe('canonical notice content and hash', () => {
  it('publishes a hash for the version actually shipped', () => {
    expect(LEGAL_NOTICE_HASHED_VERSION).toBe(V);
    expect(HASH).toMatch(/^sha256-legal-notice-v1:[0-9a-f]{32}$/);
  });

  it('covers every substantive disclosure surface the user acknowledges', () => {
    const canonical = canonicalLegalNoticeContent();
    expect(canonical.version).toBe(V);
    expect(canonical.keyPoints).toHaveLength(LEGAL_NOTICE_KEY_POINTS.length);
    expect(canonical.dataPractices).toHaveLength(LEGAL_DATA_PRACTICES.length);
    expect(canonical.items).toHaveLength(LEGAL_DISCLAIMER_ITEMS.length);

    // Every data practice carries all three disclosure dimensions.
    for (const entry of canonical.dataPractices) {
      expect(typeof entry.title).toBe('string');
      expect(typeof entry.access).toBe('string');
      expect(typeof entry.use).toBe('string');
      expect(typeof entry.sharing).toBe('string');
    }
  });

  it('excludes rendering-only detail from the canonical content', () => {
    const serialized = JSON.stringify(canonicalLegalNoticeContent());
    // Layout, styling and component structure must never influence the hash.
    expect(serialized).not.toMatch(/className|rounded-|text-xs|dark:|AlertDialog|useMemo/);
  });

  it('records changelog entries only for versions whose history is actually known', () => {
    // Versions 1-8 predate the mechanism; inventing summaries for them would be fabrication.
    for (const key of Object.keys(LEGAL_NOTICE_CHANGELOG)) {
      expect(Number(key)).toBeGreaterThanOrEqual(9);
    }
    const current = LEGAL_NOTICE_CHANGELOG[V];
    expect(current).toBeTruthy();
    expect(Array.isArray(current.changes)).toBe(true);
  });
});
