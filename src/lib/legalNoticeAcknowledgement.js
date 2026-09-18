import { LEGAL_NOTICE_ACK_VERSION } from '@/lib/legalDisclaimers';
import { LEGAL_NOTICE_CONTENT_HASH } from '@/lib/legalNoticeVersion.generated';

/**
 * Acknowledgement means the user confirmed they have read and understand the notice.
 *
 * It is deliberately NOT consent to data processing, and NOT acceptance of contractual terms.
 * Feature-specific consents (weather, road data, OSRM sharing, camera, usage access, Bluetooth)
 * are separate states and are never granted by acknowledging this notice.
 */
export const LEGAL_ACK_STATES = Object.freeze({
  /** Never acknowledged, or the stored record carries no usable version. */
  NONE: 'none',
  /** Acknowledged at the current version, bound to the exact content hash presented. */
  CONTENT_BOUND: 'acknowledged_content_bound',
  /**
   * Acknowledged at the current version before content-hash binding existed.
   * Accepted: these users did read the current notice; only the provenance record is weaker.
   */
  VERSIONED_LEGACY: 'acknowledged_versioned_legacy',
  /**
   * Acknowledged at the current version, but bound to different content than is present now.
   * Treated as requiring review: what they agreed to is not what would be shown today.
   */
  CONTENT_MISMATCH: 'content_mismatch',
  /** Acknowledged an older version. Requires review. */
  OUTDATED: 'outdated',
  /** Stored version is ahead of this build, e.g. after a downgrade. Accepted, not re-prompted. */
  AHEAD_OF_BUILD: 'ahead_of_build',
  /** Stored record is unusable (non-numeric, negative, corrupt). Fails safe to requiring review. */
  MALFORMED: 'malformed',
});

const REVIEW_REQUIRED = new Set([
  LEGAL_ACK_STATES.NONE,
  LEGAL_ACK_STATES.CONTENT_MISMATCH,
  LEGAL_ACK_STATES.OUTDATED,
  LEGAL_ACK_STATES.MALFORMED,
]);

/**
 * Classifies a stored acknowledgement against the notice this build presents.
 *
 * `settings` is the persisted settings object. Missing fields are normal for a first launch and
 * must not throw.
 */
export function classifyLegalAcknowledgement(settings = {}, {
  requiredVersion = LEGAL_NOTICE_ACK_VERSION,
  currentHash = LEGAL_NOTICE_CONTENT_HASH,
} = {}) {
  const rawVersion = settings?.legal_notice_ack_version;
  const storedHash = typeof settings?.legal_notice_ack_content_hash === 'string'
    ? settings.legal_notice_ack_content_hash
    : '';

  if (rawVersion === undefined || rawVersion === null || rawVersion === '') return LEGAL_ACK_STATES.NONE;

  const version = Number(rawVersion);
  if (!Number.isFinite(version) || !Number.isInteger(version) || version < 0) {
    return LEGAL_ACK_STATES.MALFORMED;
  }
  if (version === 0) return LEGAL_ACK_STATES.NONE;
  if (version > requiredVersion) return LEGAL_ACK_STATES.AHEAD_OF_BUILD;
  if (version < requiredVersion) return LEGAL_ACK_STATES.OUTDATED;

  // Same version from here on.
  if (!storedHash) return LEGAL_ACK_STATES.VERSIONED_LEGACY;
  if (!currentHash) return LEGAL_ACK_STATES.VERSIONED_LEGACY;
  return storedHash === currentHash
    ? LEGAL_ACK_STATES.CONTENT_BOUND
    : LEGAL_ACK_STATES.CONTENT_MISMATCH;
}

/** True when the first-launch notice must be shown. */
export function legalNoticeReviewRequired(settings = {}, options = {}) {
  return REVIEW_REQUIRED.has(classifyLegalAcknowledgement(settings, options));
}

/** The record written when a user acknowledges the current notice. */
export function buildLegalAcknowledgementRecord({
  acknowledgedAt = new Date().toISOString(),
  version = LEGAL_NOTICE_ACK_VERSION,
  contentHash = LEGAL_NOTICE_CONTENT_HASH,
} = {}) {
  return {
    legal_notice_ack_version: version,
    legal_notice_acknowledged_at: acknowledgedAt,
    legal_notice_ack_content_hash: contentHash,
  };
}
