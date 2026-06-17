import { verifyChain, loadPrivacyAuditChain } from '@/lib/hashChainLog';
import { getZoneStatsSnapshot } from '@/lib/privacyZones';
import { loadTransmissionLog } from '@/lib/transmissionLog';
import { tripService } from '@/api/trips';
import { localSettings } from '@/lib/trackingStore';
import {
  checkAuditLog,
  checkBridgeEncryption,
  checkCertPinning,
  checkCommitmentScheme,
  checkCrashScrubbing,
  checkDeviceIntegrity,
  checkDifferentialPrivacy,
  checkExportSigning,
  checkKinematicNulling,
  checkMemoryZeroing,
  checkRequestObfuscation,
  checkSecureDeletion,
  checkStorageEncryption,
  checkTimestampFuzzing,
  getBiometricType,
  isBiometricGateEnabled,
  isOsrmConsentOutdated,
  isOsrmEnabled,
  isOsrmEnabledWithoutZoneGuard,
  isScreenSecureEnabled,
} from '@/lib/deviceStatus';
import { getKeyRotationStatus } from '@/lib/keyRotationManager';
import { isNativePlatform } from '@/lib/nativePlatform';

const DAY_MS = 24 * 60 * 60 * 1000;

export const STATUS_POINTS = Object.freeze({
  ok: 1,
  configured: 0.6,
  warn: 0.3,
  unknown: 0,
  error: 0,
  not_applicable: null,
});

const LAYERS = {
  device: { label: 'Device', color: '#10b981', weight: 0.3 },
  network: { label: 'Network', color: '#0ea5e9', weight: 0.25 },
  inference: { label: 'Inference', color: '#8b5cf6', weight: 0.25 },
  integrity: { label: 'Integrity', color: '#f59e0b', weight: 0.2 },
};

const RECOMMENDATION_PRIORITY = {
  error: 0,
  warn: 1,
  unknown: 2,
  configured: 3,
  ok: 4,
  not_applicable: 5,
};

const control = (id, category, weight, label, check, riskIfMissing, developerAction) => ({
  id,
  category,
  weight,
  label,
  check,
  riskIfMissing,
  userAction: null,
  developerAction,
});

const CONTROL_REGISTRY = [
  control('storage_encryption', 'device', 3, 'Storage encryption', checkStorageEncryption, 'Extracted trip data could be readable in plaintext.', 'Verify the secure payload encryption and key-provider paths.'),
  control('secure_deletion', 'device', 2, 'Secure deletion', checkSecureDeletion, 'Deleted application records may remain recoverable.', 'Verify secureDelete() overwrites before logical deletion.'),
  control('cert_pinning', 'network', 2, 'Certificate pinning', checkCertPinning, 'Location-bearing requests could be intercepted by a trusted malicious certificate.', 'Maintain pins for every native external endpoint.'),
  control('bridge_encryption', 'network', 1, 'Bridge encryption', checkBridgeEncryption, 'Sensitive native bridge payloads could be exposed.', 'Verify the encrypted bridge echo round-trip.'),
  control('request_obfuscation', 'network', 1, 'Request timing obfuscation', checkRequestObfuscation, 'Request timing may correlate with trip activity.', 'Verify that obfuscation batches execute successfully.'),
  control('memory_zeroing', 'inference', 1, 'Memory zeroing', checkMemoryZeroing, 'Raw coordinates could remain in process memory after masking.', 'Keep SecureGpsBuffer.zero() in finally blocks.'),
  control('timestamp_fuzzing', 'inference', 2, 'Boundary timestamp fuzzing', checkTimestampFuzzing, 'Boundary times may reveal private arrival or departure patterns.', 'Verify export boundary timestamps are fuzzed.'),
  control('kinematic_nulling', 'inference', 2, 'Kinematic data nulling', checkKinematicNulling, 'Boundary motion fields could help infer private route segments.', 'Keep all recorded kinematic fields in the sanitization list.'),
  control('differential_privacy', 'inference', 2, 'Differential privacy', checkDifferentialPrivacy, 'Repeated aggregate exports could reveal private activity.', 'Verify metric budgets and Laplace noise.'),
  control('commitment_scheme', 'inference', 2, 'Export commitments', checkCommitmentScheme, 'Repeated exports could expose privacy-zone centers.', 'Ensure commitments use fresh salts and exclude coordinates.'),
  control('export_signing', 'integrity', 2, 'Export HMAC signing', checkExportSigning, 'Modified backups could be accepted as authentic.', 'Verify signing keys and tamper rejection.'),
  control('crash_scrubbing', 'integrity', 2, 'Crash report scrubbing', checkCrashScrubbing, 'Crash payloads could disclose GPS coordinates.', 'Keep sensitive key and coordinate patterns current.'),
  control('audit_log', 'integrity', 1, 'Local audit chain', checkAuditLog, 'Privacy operations could be altered without detection.', 'Verify append and chain validation together.'),
  control('root_detection', 'device', 3, 'Root / jailbreak detection', checkDeviceIntegrity, 'A compromised device can weaken every local protection.', null),
  control('key_rotation', 'device', 2, 'Key rotation', getKeyRotationStatus, 'Older encryption keys may remain in use indefinitely.', 'Inspect stored payload key versions and rotation failures.'),
];

const settingBackedControls = () => {
  const native = isNativePlatform();
  const biometric = isBiometricGateEnabled();
  const screenSecure = isScreenSecureEnabled();
  const osrmEnabled = isOsrmEnabled();
  const osrmOutdated = isOsrmConsentOutdated();
  const osrmUnguarded = isOsrmEnabledWithoutZoneGuard();
  return [
    {
      id: 'biometric_gate',
      category: 'device',
      weight: 2,
      label: 'Biometric gate',
      status: !native ? 'not_applicable' : biometric ? 'configured' : 'error',
      evidence: !native
        ? 'Biometric app lock applies only to the native runtime'
        : biometric
          ? `Enabled using ${getBiometricType()}`
          : 'App lock is not enabled',
      riskIfMissing: 'Anyone with an unlocked device can open private trip and zone views.',
      userAction: 'Enable app lock in Settings.',
      developerAction: null,
    },
    {
      id: 'screenshot_prevention',
      category: 'device',
      weight: 1,
      label: 'Screenshot prevention',
      status: !native ? 'not_applicable' : screenSecure ? 'configured' : 'error',
      evidence: !native
        ? 'Native screenshot prevention does not apply to the web runtime'
        : screenSecure
          ? 'Screen capture is disabled in settings'
          : 'Screen capture is allowed',
      riskIfMissing: 'Screenshots and recent-app previews can expose private locations.',
      userAction: 'Disable screen capture in Settings.',
      developerAction: null,
    },
    {
      id: 'osrm_consent',
      category: 'network',
      weight: 2,
      label: 'OSRM data sharing consent',
      status: !osrmEnabled ? 'not_applicable' : osrmOutdated ? 'warn' : osrmUnguarded ? 'error' : 'configured',
      evidence: !osrmEnabled
        ? 'OSRM route matching is disabled'
        : osrmOutdated
          ? 'Consent predates a privacy-zone change'
          : osrmUnguarded
            ? 'OSRM endpoint blocking near privacy zones is off'
            : 'Consent is current and privacy zones are always excluded',
      riskIfMissing: 'Raw public route coordinates may be sent without current consent or zone exclusion.',
      userAction: 'Review OSRM sharing in Settings.',
      developerAction: null,
    },
  ];
};

export async function getProtectionStatus() {
  const checked = await Promise.all(CONTROL_REGISTRY.map(async (definition) => {
    const live = await definition.check();
    return {
      ...definition,
      check: undefined,
      status: live.status,
      evidence: live.evidence,
      value: live.status === 'ok' ? 'Verified' : live.status === 'configured' ? 'Configured' : live.status === 'not_applicable' ? 'N/A' : 'Review',
      detail: live.evidence,
      action: live.userAction || live.developerAction,
      lastCheckedAt: live.lastCheckedAt || Date.now(),
      source: live.source || definition.id,
      ...(definition.id === 'key_rotation' ? { rotation: live } : {}),
    };
  }));
  return [...checked, ...settingBackedControls().map((item) => ({
    ...item,
    value: item.status === 'configured' ? 'Configured' : item.status === 'not_applicable' ? 'N/A' : 'Review',
    detail: item.evidence,
    action: item.userAction,
    lastCheckedAt: Date.now(),
    source: 'settings',
  }))];
}

const scoreBand = (score) => {
  if (score == null) return { label: 'Unavailable', tone: 'unknown', detail: 'No applicable controls could be scored.' };
  if (score >= 90) return { label: 'Strong', tone: 'ok', detail: 'Most applicable protections were verified.' };
  if (score >= 75) return { label: 'Good', tone: 'ok', detail: 'Protection is solid with some checks to review.' };
  if (score >= 55) return { label: 'Needs review', tone: 'warn', detail: 'Several protections are unverified or need attention.' };
  return { label: 'At risk', tone: 'error', detail: 'Important protections are unavailable or failing.' };
};

export function computePrivacyScoreFromControls(controls = []) {
  const layers = Object.entries(LAYERS).map(([id, layer]) => {
    const allControls = controls.filter((item) => item.category === id);
    const applicable = allControls.filter((item) => item.status !== 'not_applicable');
    const denominator = applicable.reduce((sum, item) => sum + item.weight, 0);
    const earned = applicable.reduce(
      (sum, item) => sum + item.weight * (STATUS_POINTS[item.status] ?? 0),
      0
    );
    return {
      id,
      label: layer.label,
      color: layer.color,
      score: denominator ? Math.round((earned / denominator) * 100) : null,
      applicableControls: applicable.length,
      totalControls: allControls.length,
    };
  });
  const applicableLayers = layers.filter((layer) => layer.score != null);
  const totalLayerWeight = applicableLayers.reduce((sum, layer) => sum + LAYERS[layer.id].weight, 0);
  const overall = totalLayerWeight
    ? Math.round(applicableLayers.reduce(
      (sum, layer) => sum + layer.score * LAYERS[layer.id].weight,
      0
    ) / totalLayerWeight)
    : null;
  const summary = Object.fromEntries(
    ['ok', 'configured', 'warn', 'unknown', 'error', 'not_applicable']
      .map((status) => [status, controls.filter((item) => item.status === status).length])
  );
  summary.total = controls.length;
  return { overall, ...scoreBand(overall), layers, summary };
}

export async function computePrivacyScore(controls = null) {
  return computePrivacyScoreFromControls(controls || await getProtectionStatus());
}

export async function getZoneStats() {
  const trips = await tripService.listAll({ sort: '-start_time' }).catch(() => []);
  return getZoneStatsSnapshot(localSettings.get(), trips);
}

export function transmissionPrivacyLevel(entry = {}) {
  if (entry.coordinateDisclosure === 'blocked') return 'blocked';
  if (entry.coordinateDisclosure === 'none') return 'none';
  if (entry.coordinateDisclosure === 'raw') return 'raw';
  return entry.privacyTransformVerified && !(entry.privacyVerificationWarnings || []).length
    ? 'protected'
    : 'unverified';
}

export function classifyTransmissionForDisplay(entry = {}) {
  if (entry.coordinateDisclosure === 'blocked') return { label: 'Blocked', color: '#ef4444' };
  if (entry.coordinateDisclosure === 'none') return { label: 'No location data', color: '#10b981' };
  if (entry.coordinateDisclosure === 'raw') {
    return (entry.protections || []).includes('explicit consent')
      ? { label: 'Raw - consented', color: '#f59e0b' }
      : { label: 'Raw - REVIEW', color: '#ef4444' };
  }
  return entry.privacyTransformVerified && !(entry.privacyVerificationWarnings || []).length
    ? { label: 'Verified protection', color: '#10b981' }
    : { label: 'Unverified protection claim', color: '#f59e0b' };
}

export async function getTransmissionSummary() {
  const log = await loadTransmissionLog();
  const byService = {};
  /** @type {Array<Record<string, any>>} */
  const entries = log.map((entry) => ({
    ...entry,
    privacyLevel: transmissionPrivacyLevel(entry),
    displayClassification: classifyTransmissionForDisplay(entry),
  }));
  entries.forEach((entry) => {
    byService[entry.service] = (byService[entry.service] || 0) + 1;
  });
  const now = Date.now();
  const statusCounts = entries.reduce((counts, entry) => ({
    ...counts,
    [entry.status]: (counts[entry.status] || 0) + 1,
  }), { safe: 0, blocked: 0, warning: 0 });
  const rawEntries = entries.filter((entry) => entry.privacyLevel === 'raw');
  const rawWithConsent = rawEntries.filter((entry) => (
    (entry.protections || []).some((item) => /explicit consent/i.test(item))
  ));
  const unverifiedEntries = entries.filter((entry) => entry.privacyLevel === 'unverified');
  return {
    entries: entries.slice().sort((a, b) => b.timestamp - a.timestamp),
    totalRawCoords: rawEntries.length,
    rawWithConsentCount: rawWithConsent.length,
    rawWithoutConsentCount: rawEntries.length - rawWithConsent.length,
    protectedTotal: entries.filter((entry) => entry.privacyLevel === 'protected').length,
    claimedButUnverifiedCount: unverifiedEntries.length,
    rawUnverifiedCount: entries.filter((entry) => (
      entry.coordinateDisclosure === 'raw' && entry.privacyTransformVerified !== true
    )).length,
    needsReviewTotal: rawEntries.length + unverifiedEntries.length + statusCounts.warning,
    blockedTotal: statusCounts.blocked,
    warningTotal: statusCounts.warning,
    safeTotal: statusCounts.safe,
    totalBytesOut: entries.reduce((sum, entry) => sum + (Number(entry.bytesOut) || 0), 0),
    byService,
    services: Object.entries(byService)
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count),
    todayTotal: entries.filter((entry) => entry.timestamp > now - DAY_MS).length,
    weekTotal: entries.filter((entry) => entry.timestamp > now - 7 * DAY_MS).length,
    latestAt: entries[0]?.timestamp || null,
  };
}

export function buildPrivacyActionPlan({
  score = {},
  protections = [],
  transmissions = {},
  chainResult = {},
  zoneSummary = {},
} = {}) {
  const failedControls = protections.filter((item) => item.status === 'error');
  const warningControls = protections.filter((item) => item.status === 'warn');
  const unknownControls = protections.filter((item) => item.status === 'unknown');
  const rawWithoutConsent = Number(transmissions.rawWithoutConsentCount) || 0;
  const rawWithConsent = Number(transmissions.rawWithConsentCount) || 0;
  const unverifiedTransmissions = Number(transmissions.claimedButUnverifiedCount) || 0;
  const issues = [];

  if (rawWithoutConsent > 0) {
    issues.push({
      id: 'raw_without_consent',
      tone: 'error',
      targetTab: 'transmissions',
      title: 'Review raw-coordinate sends',
      detail: `${rawWithoutConsent} raw-coordinate request${rawWithoutConsent === 1 ? '' : 's'} had no explicit-consent evidence.`,
      action: 'Open transmissions',
    });
  }
  if (chainResult.valid === false) {
    issues.push({
      id: 'audit_invalid',
      tone: 'error',
      targetTab: 'audit',
      title: 'Audit history needs review',
      detail: chainResult.reason || 'The local audit chain did not verify.',
      action: 'Open audit log',
    });
  }
  if (failedControls.length) {
    issues.push({
      id: 'failed_controls',
      tone: 'error',
      targetTab: 'protections',
      title: 'Fix failing protection checks',
      detail: `${failedControls.length} protection${failedControls.length === 1 ? '' : 's'} failed local verification.`,
      action: 'Open protections',
    });
  }
  if (unverifiedTransmissions > 0) {
    issues.push({
      id: 'unverified_transmissions',
      tone: 'warn',
      targetTab: 'transmissions',
      title: 'Verify protected-request claims',
      detail: `${unverifiedTransmissions} outbound record${unverifiedTransmissions === 1 ? '' : 's'} claimed protection without complete evidence.`,
      action: 'Open transmissions',
    });
  }
  if (rawWithConsent > 0) {
    issues.push({
      id: 'raw_with_consent',
      tone: 'warn',
      targetTab: 'transmissions',
      title: 'Raw sharing is active',
      detail: `${rawWithConsent} raw-coordinate request${rawWithConsent === 1 ? '' : 's'} had consent metadata. Confirm the endpoint is still trusted.`,
      action: 'Review sharing',
    });
  }
  if (warningControls.length) {
    issues.push({
      id: 'warning_controls',
      tone: 'warn',
      targetTab: 'protections',
      title: 'Resolve degraded checks',
      detail: `${warningControls.length} protection${warningControls.length === 1 ? '' : 's'} reported a warning.`,
      action: 'Open protections',
    });
  }
  if (unknownControls.length) {
    issues.push({
      id: 'unknown_controls',
      tone: 'unknown',
      targetTab: 'protections',
      title: 'Do not treat unknown as safe',
      detail: `${unknownControls.length} protection${unknownControls.length === 1 ? '' : 's'} could not be verified in this session.`,
      action: 'Open protections',
    });
  }
  if ((Number(zoneSummary.zoneCount) || 0) === 0) {
    issues.push({
      id: 'no_privacy_zones',
      tone: 'unknown',
      targetTab: 'zones',
      title: 'Add privacy zones for private places',
      detail: 'No home, work, or sensitive-place mask is configured yet.',
      action: 'Open zones',
    });
  }

  const hasErrors = issues.some((item) => item.tone === 'error');
  const hasWarnings = issues.some((item) => item.tone === 'warn');
  const hasUnknowns = issues.some((item) => item.tone === 'unknown');
  const headline = hasErrors
    ? 'Needs action before privacy claims are trustworthy'
    : hasWarnings
      ? 'Useful, with items to review'
      : hasUnknowns
        ? 'Useful, but evidence is incomplete'
        : 'No urgent privacy issues recorded';

  return {
    headline,
    tone: hasErrors ? 'error' : hasWarnings ? 'warn' : hasUnknowns ? 'unknown' : 'ok',
    scoreLabel: score.label || 'Unavailable',
    claim: hasErrors
      ? 'Do not claim this setup is private until the flagged items are fixed.'
      : hasWarnings || hasUnknowns
        ? 'Treat this as local transparency, not a security guarantee.'
        : 'The dashboard found no urgent local issues, but it is still not an external audit.',
    primaryAction: issues[0] || {
      id: 'no_action',
      tone: 'ok',
      targetTab: 'overview',
      title: 'Keep reviewing after trips',
      detail: 'New trips, exports, and external lookups can change this posture.',
      action: 'Stay on overview',
    },
    issues: issues.slice(0, 5),
  };
}

export function summarizeZones(zones = []) {
  return (Array.isArray(zones) ? zones : []).reduce((summary, zone) => ({
    zoneCount: summary.zoneCount + 1,
    pointsToday: summary.pointsToday + (Number(zone?.today?.hidden) || 0),
    eventsToday: summary.eventsToday + (Number(zone?.today?.events) || 0),
    pointsWeek: summary.pointsWeek + (Number(zone?.week?.hidden) || 0),
    eventsWeek: summary.eventsWeek + (Number(zone?.week?.events) || 0),
    pointsAllTime: summary.pointsAllTime + (Number(zone?.allTime?.hidden) || 0),
    eventsAllTime: summary.eventsAllTime + (Number(zone?.allTime?.events) || 0),
    activeZoneCount: summary.activeZoneCount + (zone?.lastActive ? 1 : 0),
    latestAt: Math.max(summary.latestAt || 0, Number(zone?.lastActive) || 0) || null,
  }), {
    zoneCount: 0,
    pointsToday: 0,
    eventsToday: 0,
    pointsWeek: 0,
    eventsWeek: 0,
    pointsAllTime: 0,
    eventsAllTime: 0,
    activeZoneCount: 0,
    latestAt: null,
  });
}

export function summarizeAudit(chain = []) {
  const now = Date.now();
  const operations = {};
  (Array.isArray(chain) ? chain : []).forEach((entry) => {
    operations[entry.op] = (operations[entry.op] || 0) + 1;
  });
  return {
    todayTotal: chain.filter((entry) => Number(entry.timestamp) > now - DAY_MS).length,
    weekTotal: chain.filter((entry) => Number(entry.timestamp) > now - 7 * DAY_MS).length,
    latestAt: chain.reduce((latest, entry) => Math.max(latest, Number(entry?.timestamp) || 0), 0) || null,
    operations: Object.entries(operations)
      .map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function loadPrivacyIntelligence() {
  const protections = await getProtectionStatus();
  const score = computePrivacyScoreFromControls(protections);
  const [zones, transmissions, chain, chainResult] = await Promise.all([
    getZoneStats(),
    getTransmissionSummary(),
    loadPrivacyAuditChain(),
    verifyChain(),
  ]);
  const recommendations = protections
    .filter((item) => ['error', 'warn', 'unknown'].includes(item.status))
    .sort((a, b) => (
      (RECOMMENDATION_PRIORITY[a.status] ?? 9) - (RECOMMENDATION_PRIORITY[b.status] ?? 9) ||
      (b.weight || 0) - (a.weight || 0)
    ))
    .slice(0, 4);
  const zoneSummary = summarizeZones(zones);
  const actionPlan = buildPrivacyActionPlan({
    score,
    protections,
    transmissions,
    chainResult,
    zoneSummary,
  });
  return {
    generatedAt: Date.now(),
    score,
    protections,
    protectionSummary: {
      active: protections.filter((item) => item.status === 'ok').length,
      configured: protections.filter((item) => item.status === 'configured').length,
      warnings: protections.filter((item) => item.status === 'warn').length,
      unknown: protections.filter((item) => item.status === 'unknown').length,
      errors: protections.filter((item) => item.status === 'error').length,
      notApplicable: protections.filter((item) => item.status === 'not_applicable').length,
    },
    recommendations,
    zones,
    zoneSummary,
    transmissions,
    chain,
    chainResult,
    auditSummary: summarizeAudit(chain),
    actionPlan,
  };
}
