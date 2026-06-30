import { signExport } from '@/lib/exportIntegrity';
import { exportAuditCheckpoint, verifyCheckpoint } from '@/lib/hashChainLog';
import { isNativePlatform } from '@/lib/nativePlatform';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { buildPrivacyRecommendations } from '@/lib/privacyIntelligence';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const PRIVACY_REPORT_HEADER = 'Privacy Intelligence is a local dashboard that reports app-recorded privacy activity, outbound location-sharing evidence, privacy-zone protection counts, local protection checks, and audit-chain consistency.';
export const PRIVACY_REPORT_FORMAT = 'road-sage-privacy-report';
export const PRIVACY_REPORT_VERSION = 1;
export const ENCRYPTED_PRIVACY_REPORT_FORMAT = 'road-sage-encrypted-privacy-report';
export const ENCRYPTED_PRIVACY_REPORT_VERSION = 1;
export const ENCRYPTED_PRIVACY_REPORT_KDF = 'PBKDF2-SHA-256';
export const ENCRYPTED_PRIVACY_REPORT_CIPHER = 'AES-256-GCM';
export const ENCRYPTED_PRIVACY_REPORT_EXTENSION = '.drivesenseprivacyreport';
export const ENCRYPTED_PRIVACY_REPORT_MIME_TYPE = 'application/vnd.road-sage.encrypted-privacy-report+json';
export const PRIVACY_REPORT_PASSWORD_MIN_LENGTH = 12;
export const PRIVACY_REPORT_KDF_ITERATIONS = 210_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const BASE64_CHUNK_SIZE = 0x8000;
const SENSITIVE_FIELD_NAME = /(^|[_-])(lat|lng|longitude|latitude|coordinate|coordinates|radius|radius_m|route_points|driving_events|address|email|phone|token|password|secret|sent_coords|sentCoords|privacy_zones|zones)($|[_-])/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g;
const TOKEN_PAIR_PATTERN = /\b(access_token|refresh_token|id_token|token|password|secret|code)=([^&\s]+)/gi;
const COORDINATE_PAIR_PATTERN = /\b-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g;
const NAMED_COORDINATE_PATTERN = /\b(lat(?:itude)?|lng|longitude)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?/gi;

const cryptoProvider = () => {
  const provider = globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== 'function') {
    throw new Error('Password-protected Privacy Report export requires Web Crypto support.');
  }
  return provider;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    const chunk = bytes.slice(index, index + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const safeReportString = (value, maxLength = 240) => String(value || '')
  .replace(EMAIL_PATTERN, '[redacted-email]')
  .replace(PHONE_PATTERN, '[redacted-phone]')
  .replace(BEARER_PATTERN, 'Bearer [redacted]')
  .replace(TOKEN_PAIR_PATTERN, '$1=[redacted]')
  .replace(COORDINATE_PAIR_PATTERN, '[redacted-coordinate]')
  .replace(NAMED_COORDINATE_PATTERN, '$1=[redacted-coordinate]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const safeNullableNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validateReportPassphrase = (passphrase) => {
  if (typeof passphrase !== 'string' || passphrase.length < PRIVACY_REPORT_PASSWORD_MIN_LENGTH) {
    throw new Error(`Privacy Report password must be at least ${PRIVACY_REPORT_PASSWORD_MIN_LENGTH} characters.`);
  }
};

async function derivePrivacyReportKey(passphrase, salt, iterations) {
  validateReportPassphrase(passphrase);
  const crypto = cryptoProvider();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const drivingHighlights = (readout = {}) => ({
  tripCount: readout.tripCount || 0,
  recentTripCount: readout.recentTripCount || 0,
  recentProtectedTripCount: readout.recentProtectedTripCount || 0,
  recentProtectionRate: readout.recentProtectionRate ?? null,
  privateEndpointTripCount: readout.privateEndpointTripCount || 0,
  protectedPointCount: readout.protectedPointCount || 0,
  protectedEventCount: readout.protectedEventCount || 0,
  rawPointInsideZoneCount: readout.rawPointInsideZoneCount || 0,
  untouchedZoneCount: readout.untouchedZoneCount || 0,
  staleZoneCount: readout.staleZoneCount || 0,
});

const reportScore = (score = {}) => ({
  overall: score.overall ?? null,
  label: score.label || 'Unavailable',
  tone: score.tone || 'unknown',
  layers: score.layers || [],
  summary: score.summary || {},
  webCapApplied: score.webCapApplied === true,
  capNote: score.webCapApplied ? score.capReason : null,
});

const reportProtectionSummary = (summary = {}) => ({
  active: safeNumber(summary.active),
  configured: safeNumber(summary.configured),
  warnings: safeNumber(summary.warnings),
  unknown: safeNumber(summary.unknown),
  errors: safeNumber(summary.errors),
  notApplicable: safeNumber(summary.notApplicable),
  findings: Array.isArray(summary.findings)
    ? summary.findings.slice(0, 12).map((item) => ({
      id: safeReportString(item.id, 80),
      label: safeReportString(item.label),
      status: safeReportString(item.status, 40),
      category: safeReportString(item.category, 60),
      evidence: safeReportString(item.evidence, 360),
      riskIfMissing: safeReportString(item.riskIfMissing, 360),
      userAction: safeReportString(item.userAction, 360),
    }))
    : [],
});

const reportZoneSummary = (summary = {}) => ({
  zoneCount: safeNumber(summary.zoneCount),
  activeZoneCount: safeNumber(summary.activeZoneCount),
  pointsToday: safeNumber(summary.pointsToday),
  pointsWeek: safeNumber(summary.pointsWeek),
  eventsToday: safeNumber(summary.eventsToday),
  eventsWeek: safeNumber(summary.eventsWeek),
  latestAt: safeNullableNumber(summary.latestAt),
});

const reportAuditResult = (chainResult = {}) => ({
  valid: chainResult.valid === true,
  length: safeNumber(chainResult.length),
  tip: safeReportString(chainResult.tip, 80),
  brokenAt: chainResult.brokenAt == null ? null : safeNumber(chainResult.brokenAt),
  reason: safeReportString(chainResult.reason, 240),
});

const removeSensitiveFields = (value) => {
  if (Array.isArray(value)) return value.map(removeSensitiveFields);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((acc, [key, item]) => {
    if (SENSITIVE_FIELD_NAME.test(key)) return acc;
    if (typeof item === 'string') acc[key] = safeReportString(item, 500);
    else if (item && typeof item === 'object') acc[key] = removeSensitiveFields(item);
    else acc[key] = item;
    return acc;
  }, {});
};

const buildAuditCheckpointSection = async () => {
  try {
    const checkpoint = await exportAuditCheckpoint();
    const checkpointVerification = await verifyCheckpoint(checkpoint);
    return {
      auditCheckpoint: checkpoint,
      signatureStatus: checkpointVerification.signatureStatus,
      checkpointAvailable: true,
      checkpointReason: '',
    };
  } catch (error) {
    if (!/audit chain is empty/i.test(error?.message || '')) {
      throw error;
    }
    return {
      auditCheckpoint: null,
      signatureStatus: 'unavailable',
      checkpointAvailable: false,
      checkpointReason: 'No audit checkpoint exists yet because the local privacy audit chain is empty.',
    };
  }
};

export async function buildPrivacyReportPayload(data = {}) {
  const checkpointSection = await buildAuditCheckpointSection();
  const recommendations = buildPrivacyRecommendations(data.protections || [], 5)
    .map((item) => ({
      id: safeReportString(item.id, 80),
      label: safeReportString(item.label),
      status: safeReportString(item.status, 40),
      category: safeReportString(item.category, 60),
      riskIfMissing: safeReportString(item.riskIfMissing, 360),
      userAction: safeReportString(item.userAction, 360),
    }));

  return {
    format: PRIVACY_REPORT_FORMAT,
    version: PRIVACY_REPORT_VERSION,
    header: PRIVACY_REPORT_HEADER,
    generatedAt: Date.now(),
    score: reportScore(data.score),
    protectionSummary: reportProtectionSummary(data.protectionSummary),
    recommendations,
    zoneSummary: reportZoneSummary(data.zoneSummary),
    drivingReadout: drivingHighlights(data.drivingReadout),
    audit: {
      chainResult: reportAuditResult(data.chainResult),
      signatureStatus: checkpointSection.signatureStatus,
      checkpointAvailable: checkpointSection.checkpointAvailable,
      checkpointReason: checkpointSection.checkpointReason,
    },
    auditCheckpoint: checkpointSection.auditCheckpoint,
  };
}

export async function exportPrivacyReport(data = {}) {
  return signExport(removeSensitiveFields(await buildPrivacyReportPayload(data)));
}

export async function encryptPrivacyReportText(plaintext, passphrase, { exportedAt = new Date().toISOString() } = {}) {
  const crypto = cryptoProvider();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await derivePrivacyReportKey(passphrase, salt, PRIVACY_REPORT_KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(String(plaintext))
  );

  return JSON.stringify({
    app: 'Road Sage',
    format: ENCRYPTED_PRIVACY_REPORT_FORMAT,
    format_version: ENCRYPTED_PRIVACY_REPORT_VERSION,
    payload_format: PRIVACY_REPORT_FORMAT,
    exported_at: exportedAt,
    kdf: ENCRYPTED_PRIVACY_REPORT_KDF,
    cipher: ENCRYPTED_PRIVACY_REPORT_CIPHER,
    iterations: PRIVACY_REPORT_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }, null, 2);
}

export async function decryptPrivacyReportText(encryptedText, passphrase) {
  validateReportPassphrase(passphrase);
  const envelope = typeof encryptedText === 'string' ? JSON.parse(encryptedText) : encryptedText;
  if (
    envelope?.app !== 'Road Sage' ||
    envelope?.format !== ENCRYPTED_PRIVACY_REPORT_FORMAT ||
    envelope?.format_version !== ENCRYPTED_PRIVACY_REPORT_VERSION ||
    envelope?.kdf !== ENCRYPTED_PRIVACY_REPORT_KDF ||
    envelope?.cipher !== ENCRYPTED_PRIVACY_REPORT_CIPHER
  ) {
    throw new Error('This encrypted Privacy Report format is not supported by this version of Road Sage.');
  }
  const key = await derivePrivacyReportKey(
    passphrase,
    base64ToBytes(envelope.salt),
    Number(envelope.iterations)
  );
  const plaintext = await cryptoProvider().subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

export async function exportEncryptedPrivacyReport(data = {}, passphrase) {
  validateReportPassphrase(passphrase);
  const report = await exportPrivacyReport(data);
  const plaintext = JSON.stringify(report, null, 2);
  const encryptedText = await encryptPrivacyReportText(plaintext, passphrase, {
    exportedAt: report.signed_at || new Date().toISOString(),
  });
  return { report, encryptedText };
}

const downloadTextFile = (filename, text, mimeType) => {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
};

export async function downloadPrivacyReport(data = {}, passphrase) {
  const { report, encryptedText } = await exportEncryptedPrivacyReport(data, passphrase);
  const filename = `road-sage-privacy-report-${new Date().toISOString().slice(0, 10)}${ENCRYPTED_PRIVACY_REPORT_EXTENSION}`;
  let nativeFallbackError = null;

  recordSystemEvent('privacy_report_export_started', {
    encrypted: true,
    signed: true,
    output_format: 'encrypted',
  }, { category: 'storage', title: 'Privacy Report export started' });

  if (isNativePlatform()) {
    try {
      const result = await saveExportToDownloads({
        filename,
        data: encryptedText,
        mimeType: ENCRYPTED_PRIVACY_REPORT_MIME_TYPE,
      });
      recordSystemEvent('privacy_report_export_completed', {
        native: true,
        encrypted: true,
        signed: true,
        byte_count: encryptedText.length,
      }, { category: 'storage', title: 'Privacy Report exported' });
      return { native: true, filename, uri: result.uri, report, encrypted: true, signed: true };
    } catch (error) {
      nativeFallbackError = error?.message || 'Native Privacy Report export failed.';
      logSystemFailure('privacy_report_native_export', error, {
        encrypted: true,
        byte_count: encryptedText.length,
      });
    }
  }

  downloadTextFile(filename, encryptedText, ENCRYPTED_PRIVACY_REPORT_MIME_TYPE);
  recordSystemEvent('privacy_report_export_completed', {
    native: false,
    native_fallback: Boolean(nativeFallbackError),
    encrypted: true,
    signed: true,
    byte_count: encryptedText.length,
  }, { category: 'storage', title: 'Privacy Report exported' });
  return {
    native: false,
    filename,
    report,
    encrypted: true,
    signed: true,
    nativeFallback: Boolean(nativeFallbackError),
    nativeFallbackError,
  };
}
