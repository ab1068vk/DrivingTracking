import { verifyChain, loadPrivacyAuditChain } from '@/lib/hashChainLog';
import { checkIntegrity } from '@/lib/rasp';
import { getZoneStatsSnapshot } from '@/lib/privacyZones';
import { loadTransmissionLog } from '@/lib/transmissionLog';
import { tripService } from '@/api/trips';
import { localSettings } from '@/lib/trackingStore';
import {
  getBiometricType,
  getDaysSinceKeyRotation,
  getDaysUntilKeyRotation,
  getKeyVersion,
  getPinnedEndpointCount,
  getScrubbedCrashCount,
  isAuditLogEnabled,
  isBiometricGateEnabled,
  isBridgeEncryptionEnabled,
  isCertPinningEnabled,
  isCommitmentSchemeEnabled,
  isCrashScrubbingEnabled,
  isDifferentialPrivacyEnabled,
  isHmacExportEnabled,
  isKinematicNullingEnabled,
  isMemoryZeroingEnabled,
  isOsrmConsentOutdated,
  isOsrmEnabled,
  isOsrmEnabledWithoutZoneGuard,
  isRequestObfuscationEnabled,
  isScreenSecureEnabled,
  isSecureDeletionEnabled,
  isStorageEncrypted,
  isTimestampFuzzingEnabled,
} from '@/lib/deviceStatus';

const clampScore = (score) => Math.max(0, Math.min(100, Math.round(score)));
const DAY_MS = 24 * 60 * 60 * 1000;

const scoreBand = (score) => {
  if (score >= 90) return { label: 'Strong', tone: 'ok', detail: 'Core privacy protections are active.' };
  if (score >= 75) return { label: 'Good', tone: 'ok', detail: 'Protection is solid with a few items to review.' };
  if (score >= 55) return { label: 'Needs review', tone: 'warn', detail: 'Some privacy protections need attention.' };
  return { label: 'At risk', tone: 'error', detail: 'Important privacy protections are unavailable or failing.' };
};

export async function computePrivacyScore() {
  const [deviceScore, networkScore, inferenceScore, integrityScore] = await Promise.all([
    scoreDevice(),
    scoreNetwork(),
    scoreInference(),
    scoreIntegrity(),
  ]);

  const overall = clampScore(
      deviceScore * 0.3 +
      networkScore * 0.25 +
      inferenceScore * 0.25 +
      integrityScore * 0.2
    );
  return {
    overall,
    ...scoreBand(overall),
    layers: [
      { id: 'device', label: 'Device', score: deviceScore, color: '#10b981' },
      { id: 'network', label: 'Network', score: networkScore, color: '#0ea5e9' },
      { id: 'inference', label: 'Inference', score: inferenceScore, color: '#8b5cf6' },
      { id: 'integrity', label: 'Integrity', score: integrityScore, color: '#f59e0b' },
    ],
  };
}

async function scoreDevice() {
  let score = 100;
  const integrity = await checkIntegrity().catch(() => ({ secure: true, threats: [] }));
  if (!integrity.secure) score -= 30;
  if (!isStorageEncrypted()) score -= 25;
  if (!isBiometricGateEnabled()) score -= 10;
  if (!isScreenSecureEnabled()) score -= 10;
  if (getDaysUntilKeyRotation() <= 0) score -= 15;
  else if (getDaysUntilKeyRotation() <= 7) score -= 5;
  return clampScore(score);
}

async function scoreNetwork() {
  let score = 100;
  if (!isCertPinningEnabled()) score -= 20;
  if (!isBridgeEncryptionEnabled()) score -= 10;
  if (!isRequestObfuscationEnabled()) score -= 10;
  if (isOsrmEnabledWithoutZoneGuard()) score -= 15;
  if (isOsrmConsentOutdated()) score -= 10;
  return clampScore(score);
}

async function scoreInference() {
  let score = 100;
  if (!isTimestampFuzzingEnabled()) score -= 25;
  if (!isKinematicNullingEnabled()) score -= 25;
  if (!isDifferentialPrivacyEnabled()) score -= 20;
  if (!isCommitmentSchemeEnabled()) score -= 20;
  return clampScore(score);
}

async function scoreIntegrity() {
  let score = 100;
  const chainResult = await verifyChain().catch((error) => ({ valid: false, reason: error?.message }));
  if (!chainResult.valid) score -= 40;
  if (!isHmacExportEnabled()) score -= 30;
  if (!isCrashScrubbingEnabled()) score -= 20;
  if (!isAuditLogEnabled()) score -= 10;
  return clampScore(score);
}

const protection = (id, category, label, value, detail, ok, warn = false, action = 'Review privacy settings') => ({
  id,
  category,
  label,
  value,
  detail,
  status: ok ? 'ok' : warn ? 'warn' : 'error',
  action: ok ? null : action,
});

export async function getProtectionStatus() {
  const [integrity, chainResult] = await Promise.all([
    checkIntegrity().catch((error) => ({ secure: false, threats: [error?.message || 'Integrity check unavailable'] })),
    verifyChain().catch((error) => ({ valid: false, reason: error?.message || 'Audit chain unavailable' })),
  ]);
  const daysToRotation = getDaysUntilKeyRotation();
  const osrmConsentOld = isOsrmConsentOutdated();
  const chainLength = 'length' in chainResult ? chainResult.length : 0;
  const chainTip = 'tip' in chainResult ? chainResult.tip : '';

  return [
    protection('storage', 'Device', 'Storage encryption', isStorageEncrypted() ? 'AES-256-GCM' : 'Not active', `Key v${getKeyVersion()} - rotated ${getDaysSinceKeyRotation()} days ago`, isStorageEncrypted()),
    protection('key_rotation', 'Device', 'Key rotation', daysToRotation > 0 ? `${daysToRotation} days until next` : 'Overdue', '30-day rotation target', daysToRotation > 7, daysToRotation > 0),
    protection('memory_zeroing', 'Inference', 'Memory zeroing', isMemoryZeroingEnabled() ? 'Active' : 'Inactive', 'Sensitive route buffers are cleared after processing', isMemoryZeroingEnabled(), true),
    protection('secure_deletion', 'Device', 'Secure deletion', isSecureDeletionEnabled() ? 'Active' : 'Standard delete only', 'Applied when private GPS is purged', isSecureDeletionEnabled(), true),
    protection('certificate_pinning', 'Network', 'Certificate pinning', isCertPinningEnabled() ? `${getPinnedEndpointCount()} service hosts pinned` : 'Web runtime fallback', 'Open-Meteo, Overpass, and Nominatim are pinned on Android', isCertPinningEnabled(), !isCertPinningEnabled()),
    protection('bridge_encryption', 'Network', 'Bridge encryption', isBridgeEncryptionEnabled() ? 'Native channel protected' : 'Web runtime', 'Sensitive JavaScript-to-Android payloads use an encrypted bridge', isBridgeEncryptionEnabled(), !isBridgeEncryptionEnabled()),
    protection('screenshots', 'Device', 'Screenshot prevention', isScreenSecureEnabled() ? 'Active' : 'Screenshots allowed', 'Sensitive Android screens use FLAG_SECURE', isScreenSecureEnabled(), true),
    protection('biometric_gate', 'Device', 'Biometric gate', isBiometricGateEnabled() ? getBiometricType() : 'Inactive', 'Controls app lock and Privacy Intelligence access', isBiometricGateEnabled(), true),
    protection('root_detection', 'Integrity', 'Root detection', integrity.secure ? 'Clean' : `Threats: ${integrity.threats.join(', ')}`, `${integrity.threats.length} threat(s) detected`, integrity.secure),
    protection('request_obfuscation', 'Network', 'Request timing protection', isRequestObfuscationEnabled() ? 'Active' : 'Inactive', 'Road and weather lookups use randomized delayed scheduling', isRequestObfuscationEnabled(), true),
    protection('crash_scrubbing', 'Integrity', 'Crash report scrubbing', isCrashScrubbingEnabled() ? 'Active' : 'Inactive', `${getScrubbedCrashCount()} coordinates scrubbed from the latest report`, isCrashScrubbingEnabled()),
    protection('osrm_consent', 'Network', 'OSRM zone consent', isOsrmEnabledWithoutZoneGuard() ? 'Some zones shared' : osrmConsentOld ? 'Review needed' : isOsrmEnabled() ? 'Zone guard active' : 'Disabled', isOsrmEnabledWithoutZoneGuard() ? 'At least one privacy zone allows OSRM coordinate sharing' : osrmConsentOld ? 'A privacy zone changed since consent' : 'Route snapping excludes protected zone interiors', !osrmConsentOld && !isOsrmEnabledWithoutZoneGuard(), true),
    protection('audit_chain', 'Integrity', 'Audit chain integrity', chainResult.valid ? `Verified - ${chainLength || 0} entries` : 'Chain broken', chainResult.valid ? `Tip ${String(chainTip || '').slice(0, 16)}` : chainResult.reason, chainResult.valid),
    protection('export_signing', 'Integrity', 'Export HMAC signing', isHmacExportEnabled() ? 'Active' : 'Inactive', 'Backup exports are signed so later changes can be detected', isHmacExportEnabled(), true),
  ];
}

export async function getZoneStats() {
  const trips = await tripService.listAll({ sort: '-start_time' }).catch(() => []);
  return getZoneStatsSnapshot(localSettings.get(), trips);
}

export function transmissionPrivacyLevel(entry = {}) {
  if (entry.status === 'blocked') return 'blocked';
  if (!entry.sentCoords) return 'none';
  const protections = Array.isArray(entry.protections) ? entry.protections : [];
  return protections.some((item) => /zone|round|bbox|scrub|commitment|mask|privacy/i.test(item))
    ? 'protected'
    : 'raw';
}

export async function getTransmissionSummary() {
  const log = await loadTransmissionLog();
  const byService = {};
  const entries = log.map((entry) => ({ ...entry, privacyLevel: transmissionPrivacyLevel(entry) }));
  entries.forEach((entry) => {
    byService[entry.service] = (byService[entry.service] || 0) + 1;
  });
  const now = Date.now();
  const statusCounts = entries.reduce((counts, entry) => ({
    ...counts,
    [entry.status]: (counts[entry.status] || 0) + 1,
  }), { safe: 0, blocked: 0, warning: 0 });
  return {
    entries: entries.slice().sort((a, b) => b.timestamp - a.timestamp),
    totalRawCoords: entries.filter((entry) => entry.privacyLevel === 'raw').length,
    protectedTotal: entries.filter((entry) => entry.privacyLevel === 'protected').length,
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
  const [score, protections, zones, transmissions, chain, chainResult] = await Promise.all([
    computePrivacyScore(),
    getProtectionStatus(),
    getZoneStats(),
    getTransmissionSummary(),
    loadPrivacyAuditChain(),
    verifyChain(),
  ]);
  const recommendations = protections
    .filter((item) => item.status !== 'ok')
    .sort((a, b) => (a.status === 'error' ? -1 : 1) - (b.status === 'error' ? -1 : 1))
    .slice(0, 4);
  return {
    generatedAt: Date.now(),
    score,
    protections,
    protectionSummary: {
      active: protections.filter((item) => item.status === 'ok').length,
      warnings: protections.filter((item) => item.status === 'warn').length,
      errors: protections.filter((item) => item.status === 'error').length,
    },
    recommendations,
    zones,
    zoneSummary: summarizeZones(zones),
    transmissions,
    chain,
    chainResult,
    auditSummary: summarizeAudit(chain),
  };
}
