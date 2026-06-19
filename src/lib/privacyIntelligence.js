import { verifyChain, loadPrivacyAuditChain } from '@/lib/hashChainLog';
import { getHydratedPrivacyZones, getZoneStatsSnapshot, isPointInPrivacyZone } from '@/lib/privacyZones';
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
const STALE_ZONE_MS = 90 * DAY_MS;

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

const OUTBOUND_SERVICE_PROFILES = Object.freeze({
  'open-meteo': {
    label: 'Weather context',
    expectedDisclosure: 'rounded',
    enabled: (settings = {}) => settings.weather_context_enabled !== false,
    usefulFor: 'Weather risk for scored trips',
    safeShape: 'One public route point rounded to 4 decimals, after privacy-zone buffer checks.',
  },
  overpass: {
    label: 'OpenStreetMap speed limits',
    expectedDisclosure: 'bounding_box',
    enabled: (settings = {}) => settings.speed_limit_lookup_enabled !== false,
    usefulFor: 'Posted or inferred speed-limit context',
    safeShape: 'Privacy-filtered public road bounding boxes, not raw route traces.',
  },
  osrm: {
    label: 'OSRM route snapping',
    expectedDisclosure: 'raw',
    enabled: (settings = {}) => settings.map_matching_enabled !== false && Boolean(settings.osrm_map_matching_url),
    usefulFor: 'Optional route snapping to roads',
    safeShape: 'Sampled public GPS segments only after consent and privacy-zone endpoint guards.',
  },
  export: {
    label: 'Backup export',
    expectedDisclosure: 'committed',
    enabled: () => true,
    usefulFor: 'Manual backup files',
    safeShape: 'Coordinate-free zone commitments and signed backup metadata.',
  },
});

const disclosureRank = Object.freeze({
  blocked: 0,
  none: 0,
  committed: 1,
  masked: 1,
  bounding_box: 2,
  rounded: 2,
  raw: 4,
});

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

export async function getZoneStats(trips = null) {
  const settings = localSettings.get();
  const hydratedZones = await getHydratedPrivacyZones(settings).catch(() => []);
  const zoneSettings = hydratedZones.length ? { ...settings, privacy_zones: hydratedZones } : settings;
  const sourceTrips = Array.isArray(trips)
    ? trips
    : await tripService.listAll({ sort: '-start_time' }).catch(() => []);
  return getZoneStatsSnapshot(zoneSettings, sourceTrips);
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

const serviceTone = (serviceEntries = []) => {
  if (serviceEntries.some((entry) => (
    entry.coordinateDisclosure === 'raw' &&
    !(entry.protections || []).some((item) => /explicit consent/i.test(item))
  ))) return 'error';
  if (serviceEntries.some((entry) => entry.coordinateDisclosure === 'raw')) return 'warn';
  if (serviceEntries.some((entry) => entry.privacyLevel === 'unverified' || entry.status === 'warning')) return 'warn';
  if (serviceEntries.some((entry) => entry.coordinateDisclosure === 'blocked')) return 'unknown';
  return serviceEntries.length ? 'ok' : 'unknown';
};

const serviceVerdict = (tone, entries = []) => {
  if (!entries.length) return 'No retained evidence yet';
  if (tone === 'error') return 'Raw send needs review';
  if (tone === 'warn') return 'Use with caution';
  if (tone === 'unknown') return 'No data sent or blocked';
  return 'Verified records';
};

export function buildOutboundPrivacyReadout(entries = [], settings = localSettings.get(), now = Date.now()) {
  const retained = Array.isArray(entries) ? entries : [];
  const rawEntries = retained.filter((entry) => entry.coordinateDisclosure === 'raw');
  const rawWithoutConsent = rawEntries.filter((entry) => (
    !(entry.protections || []).some((item) => /explicit consent/i.test(item))
  ));
  const rawWithConsent = rawEntries.length - rawWithoutConsent.length;
  const unverified = retained.filter((entry) => entry.privacyLevel === 'unverified' || (
    entry.coordinateDisclosure !== 'raw' &&
    entry.coordinateDisclosure !== 'blocked' &&
    entry.coordinateDisclosure !== 'none' &&
    entry.privacyTransformVerified !== true
  ));
  const warningEntries = retained.filter((entry) => entry.status === 'warning');
  const protectedEntries = retained.filter((entry) => entry.privacyLevel === 'protected');
  const blockedEntries = retained.filter((entry) => entry.coordinateDisclosure === 'blocked');
  const serviceNames = Array.from(new Set([
    ...Object.keys(OUTBOUND_SERVICE_PROFILES),
    ...retained.map((entry) => entry.service || 'unknown'),
  ]));
  const serviceSummaries = serviceNames.map((service) => {
    const profile = OUTBOUND_SERVICE_PROFILES[service] || {
      label: service,
      expectedDisclosure: null,
      enabled: () => false,
      usefulFor: 'App-recorded outbound request',
      safeShape: 'No service policy is registered for this request type.',
    };
    const serviceEntries = retained.filter((entry) => entry.service === service);
    const tone = serviceTone(serviceEntries);
    const disclosures = serviceEntries.reduce((counts, entry) => ({
      ...counts,
      [entry.coordinateDisclosure]: (counts[entry.coordinateDisclosure] || 0) + 1,
    }), {});
    const worstDisclosure = serviceEntries.reduce((worst, entry) => (
      (disclosureRank[entry.coordinateDisclosure] ?? 3) > (disclosureRank[worst] ?? -1)
        ? entry.coordinateDisclosure
        : worst
    ), 'none');
    return {
      service,
      label: profile.label,
      usefulFor: profile.usefulFor,
      safeShape: profile.safeShape,
      expectedDisclosure: profile.expectedDisclosure,
      enabled: profile.enabled(settings) === true,
      retainedCount: serviceEntries.length,
      latestAt: serviceEntries.reduce((latest, entry) => Math.max(latest, Number(entry.timestamp) || 0), 0) || null,
      bytesOut: serviceEntries.reduce((sum, entry) => sum + (Number(entry.bytesOut) || 0), 0),
      protectedCount: serviceEntries.filter((entry) => entry.privacyLevel === 'protected').length,
      rawCount: serviceEntries.filter((entry) => entry.coordinateDisclosure === 'raw').length,
      blockedCount: serviceEntries.filter((entry) => entry.coordinateDisclosure === 'blocked').length,
      unverifiedCount: serviceEntries.filter((entry) => entry.privacyLevel === 'unverified').length,
      warningCount: serviceEntries.filter((entry) => entry.status === 'warning').length,
      disclosures,
      worstDisclosure,
      tone,
      verdict: serviceVerdict(tone, serviceEntries),
    };
  }).sort((a, b) => (
    Number(b.enabled) - Number(a.enabled) ||
    b.retainedCount - a.retainedCount ||
    a.label.localeCompare(b.label)
  ));
  const enabledWithoutEvidence = serviceSummaries.filter((service) => (
    service.enabled && service.retainedCount === 0 && service.service !== 'export'
  ));

  let confidence = retained.length ? 100 : 55;
  confidence -= rawWithoutConsent.length * 35;
  confidence -= rawWithConsent * 14;
  confidence -= unverified.length * 18;
  confidence -= Math.max(0, warningEntries.length - rawEntries.length) * 6;
  confidence -= Math.min(20, enabledWithoutEvidence.length * 6);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const findings = [];
  if (!retained.length) {
    findings.push({
      id: 'no_retained_outbound_records',
      tone: 'unknown',
      title: 'No retained outbound records yet',
      detail: 'Privacy Intelligence has no recent transmission log entries to inspect. Run road data, weather, OSRM, or export actions to create evidence.',
    });
  }
  if (rawWithoutConsent.length) {
    findings.push({
      id: 'raw_without_consent',
      tone: 'error',
      title: 'Raw coordinates without consent evidence',
      detail: `${rawWithoutConsent.length} retained request${rawWithoutConsent.length === 1 ? '' : 's'} sent raw coordinates without explicit-consent metadata.`,
    });
  }
  if (rawWithConsent) {
    findings.push({
      id: 'raw_with_consent',
      tone: 'warn',
      title: 'Raw sharing happened',
      detail: `${rawWithConsent} request${rawWithConsent === 1 ? '' : 's'} sent sampled raw coordinates with consent metadata. Confirm the endpoint is still trusted.`,
    });
  }
  if (unverified.length) {
    findings.push({
      id: 'unverified_protection',
      tone: 'warn',
      title: 'Protection claims need evidence',
      detail: `${unverified.length} retained request${unverified.length === 1 ? '' : 's'} lacked complete pre-send verification evidence.`,
    });
  }
  enabledWithoutEvidence.forEach((service) => {
    findings.push({
      id: `no_evidence_${service.service}`,
      tone: 'unknown',
      title: `${service.label} has no retained records`,
      detail: `${service.label} is enabled or configured, but Privacy Intelligence has no retained outbound log entries for it in the last 30 days.`,
    });
  });

  const latestAt = retained.reduce((latest, entry) => Math.max(latest, Number(entry.timestamp) || 0), 0) || null;
  const headline = rawWithoutConsent.length
    ? 'Do not rely on outbound privacy until raw sends are reviewed'
    : rawEntries.length
      ? 'Raw sharing is visible and needs trust in the endpoint'
      : unverified.length
        ? 'Mostly useful, but some protection claims are unverified'
        : retained.length
          ? 'Retained outbound records are usable'
          : 'No retained outbound evidence yet';

  return {
    confidence,
    tone: confidence >= 85 ? 'ok' : confidence >= 65 ? 'warn' : retained.length ? 'error' : 'unknown',
    headline,
    retainedCount: retained.length,
    latestAt,
    protectedCount: protectedEntries.length,
    blockedCount: blockedEntries.length,
    rawCount: rawEntries.length,
    rawWithConsent,
    rawWithoutConsentCount: rawWithoutConsent.length,
    unverifiedCount: unverified.length,
    warningCount: warningEntries.length,
    enabledWithoutEvidenceCount: enabledWithoutEvidence.length,
    serviceSummaries,
    findings: findings.slice(0, 6),
    generatedAt: now,
  };
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
    outboundReadout: buildOutboundPrivacyReadout(entries, localSettings.get(), now),
  };
}

/**
 * @param {{
 *   score?: Record<string, any>,
 *   protections?: Array<Record<string, any>>,
 *   transmissions?: Record<string, any>,
 *   chainResult?: Record<string, any>,
 *   zoneSummary?: Record<string, any>,
 *   drivingReadout?: Record<string, any>
 * }} params
 */
export function buildPrivacyActionPlan({
  score = {},
  protections = [],
  transmissions = {},
  chainResult = {},
  zoneSummary = {},
  drivingReadout = {},
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
  if ((Number(zoneSummary.zoneCount) || 0) > 0 && (Number(drivingReadout.recentTripCount) || 0) > 0 && (Number(drivingReadout.recentProtectedTripCount) || 0) === 0) {
    issues.push({
      id: 'zones_not_matching_recent_drives',
      tone: 'warn',
      targetTab: 'zones',
      title: 'Zones are not matching recent drives',
      detail: `${drivingReadout.recentTripCount} recent trip${drivingReadout.recentTripCount === 1 ? '' : 's'} were analyzed, but none crossed a configured privacy zone.`,
      action: 'Review zones',
    });
  }
  if ((Number(drivingReadout.rawPointInsideZoneCount) || 0) > 0) {
    issues.push({
      id: 'raw_points_inside_zone',
      tone: 'error',
      targetTab: 'zones',
      title: 'Purge raw points inside zones',
      detail: `${drivingReadout.rawPointInsideZoneCount} saved route sample${drivingReadout.rawPointInsideZoneCount === 1 ? '' : 's'} still match a configured privacy-zone guard.`,
      action: 'Open zones',
    });
  }
  if ((Number(drivingReadout.untouchedZoneCount) || 0) > 0 && (Number(drivingReadout.tripCount) || 0) > 0) {
    issues.push({
      id: 'untouched_zones',
      tone: 'unknown',
      targetTab: 'zones',
      title: 'Some zones have never protected a trip',
      detail: `${drivingReadout.untouchedZoneCount} zone${drivingReadout.untouchedZoneCount === 1 ? '' : 's'} are configured but have no saved suppression activity.`,
      action: 'Review zones',
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

const timestampMs = (value) => {
  const parsed = new Date(value ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const itemReferencesZone = (item = {}) => Boolean(
  item?.masked_for_privacy === true ||
  item?.privacy_gap === true ||
  item?.privacy_boundary === true ||
  item?.privacy_live_redacted === true ||
  item?.privacy_purged === true ||
  item?.privacy_event_redacted === true ||
  item?.privacy_zone_id
);

const itemInsideZone = (item = {}, zones = []) => (
  itemReferencesZone(item) || Boolean(isPointInPrivacyZone(item, zones))
);

const endpointInsideZone = (point, zones = []) => (
  point ? itemInsideZone(point, zones) : false
);

export function buildDrivingPrivacyReadout(trips = [], zones = [], now = Date.now()) {
  const safeTrips = Array.isArray(trips) ? trips : [];
  const safeZones = Array.isArray(zones) ? zones : [];
  const recentCutoff = now - 30 * DAY_MS;
  const zoneSummaries = safeZones.map((zone) => ({
    id: zone.id,
    label: zone.label,
    radius_m: zone.radius_m,
    protectedRecords: (Number(zone?.allTime?.hidden) || 0) + (Number(zone?.allTime?.events) || 0),
    protectedWeek: (Number(zone?.week?.hidden) || 0) + (Number(zone?.week?.events) || 0),
    lastActive: zone.lastActive || null,
    status: zone.lastActive ? 'protecting' : 'ready',
  }));
  const untouchedZones = zoneSummaries.filter((zone) => !zone.lastActive);
  const staleZones = zoneSummaries.filter((zone) => (
    zone.lastActive && now - Number(zone.lastActive) > STALE_ZONE_MS
  ));

  let protectedPointCount = 0;
  let protectedEventCount = 0;
  let rawPointInsideZoneCount = 0;
  let tripsWithProtectedActivity = 0;
  let recentTripCount = 0;
  let recentProtectedTripCount = 0;
  let privateEndpointTripCount = 0;
  let latestTripAt = null;

  safeTrips.forEach((trip) => {
    const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
    const events = Array.isArray(trip?.driving_events) ? trip.driving_events : [];
    const tripAt = timestampMs(trip?.end_time ?? trip?.start_time);
    const isRecent = tripAt >= recentCutoff;
    let tripHasProtection = false;
    let tripHasPrivateEndpoint = false;

    if (tripAt) latestTripAt = Math.max(Number(latestTripAt) || 0, tripAt);
    if (isRecent) recentTripCount += 1;

    routePoints.forEach((point) => {
      if (itemReferencesZone(point)) {
        protectedPointCount += 1;
        tripHasProtection = true;
        return;
      }
      if (isPointInPrivacyZone(point, safeZones)) {
        rawPointInsideZoneCount += 1;
        tripHasProtection = true;
      }
    });

    events.forEach((event) => {
      if (!itemInsideZone(event, safeZones)) return;
      protectedEventCount += 1;
      tripHasProtection = true;
    });

    tripHasPrivateEndpoint = endpointInsideZone(routePoints[0], safeZones) ||
      endpointInsideZone(routePoints.at?.(-1), safeZones);
    if (tripHasPrivateEndpoint) privateEndpointTripCount += 1;
    if (tripHasProtection) {
      tripsWithProtectedActivity += 1;
      if (isRecent) recentProtectedTripCount += 1;
    }
  });

  const recommendedChecks = [];
  if (!safeZones.length && safeTrips.length) {
    recommendedChecks.push('Add home, work, or other sensitive-place zones so trip endpoints can be masked.');
  }
  if (safeZones.length && recentTripCount && !recentProtectedTripCount) {
    recommendedChecks.push('Recent trips did not cross a configured zone. Check that zone locations and radii match where you actually start or park.');
  }
  if (untouchedZones.length) {
    recommendedChecks.push(`${untouchedZones.length} zone${untouchedZones.length === 1 ? ' has' : 's have'} not protected a saved trip yet.`);
  }
  if (staleZones.length) {
    recommendedChecks.push(`${staleZones.length} zone${staleZones.length === 1 ? ' has' : 's have'} no protection activity in the last 90 days.`);
  }
  if (rawPointInsideZoneCount) {
    recommendedChecks.push(`${rawPointInsideZoneCount} saved local route sample${rawPointInsideZoneCount === 1 ? ' still sits' : 's still sit'} inside a configured zone and should be purged or redacted.`);
  }

  return {
    tripCount: safeTrips.length,
    recentTripCount,
    tripsWithProtectedActivity,
    recentProtectedTripCount,
    privateEndpointTripCount,
    protectedPointCount,
    protectedEventCount,
    rawPointInsideZoneCount,
    latestTripAt: latestTripAt || null,
    recentProtectionRate: recentTripCount ? Math.round((recentProtectedTripCount / recentTripCount) * 100) : null,
    untouchedZoneCount: untouchedZones.length,
    staleZoneCount: staleZones.length,
    zoneSummaries,
    recommendedChecks,
  };
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
  const tripsPromise = tripService.listAll({ sort: '-start_time' }).catch(() => []);
  const [trips, transmissions, chain, chainResult] = await Promise.all([
    tripsPromise,
    getTransmissionSummary(),
    loadPrivacyAuditChain(),
    verifyChain(),
  ]);
  const zones = await getZoneStats(trips);
  const recommendations = protections
    .filter((item) => ['error', 'warn', 'unknown'].includes(item.status))
    .sort((a, b) => (
      (RECOMMENDATION_PRIORITY[a.status] ?? 9) - (RECOMMENDATION_PRIORITY[b.status] ?? 9) ||
      (b.weight || 0) - (a.weight || 0)
    ))
    .slice(0, 4);
  const zoneSummary = summarizeZones(zones);
  const drivingReadout = buildDrivingPrivacyReadout(trips, zones);
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
    drivingReadout,
    transmissions,
    chain,
    chainResult,
    auditSummary: summarizeAudit(chain),
    actionPlan,
  };
}
