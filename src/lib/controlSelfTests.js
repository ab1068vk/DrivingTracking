import {
  decryptSensitiveValue,
  encryptSensitiveValue,
} from '@/lib/securePayloadCrypto';
import { secureDelete } from '@/lib/encryptedStore';
import {
  maskRoutePointsForPrivacy,
  maskRoutePointsForPrivacyExport,
} from '@/lib/privacyZones';
import { privacyGatedFetch } from '@/lib/privacyGatedFetch';
import { DEFAULT_THRESHOLDS } from '@/lib/tripEngine';
import {
  assertScoreInputsDoNotContainRawZoneKinematics,
  hasPrivacyRedactionMarker,
  scoreTripWithPrivacyInputs,
} from '@/lib/scoreInputPrivacy';
import { getSecureGpsBufferZeroCallCount } from '@/lib/SecureGpsBuffer';
import { PINNED_GPS_HOSTS } from '@/lib/pinnedFetch';
import { secureCall } from '@/lib/secureBridge';
import { isNativePlatform } from '@/lib/nativePlatform';
import { getObfuscatorQueueStatus } from '@/lib/requestObfuscator';
import { noisyStat } from '@/lib/differentialPrivacy';
import { commitZoneForExport } from '@/lib/exportCommitment';
import { signExport, verifyExport } from '@/lib/exportIntegrity';
import { sanitizeCrashPayload } from '@/lib/crashSanitizer';
import {
  appendPrivacyEvent,
  loadPrivacyAuditChain,
  verifyChain,
} from '@/lib/hashChainLog';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

const result = (status, evidence) => ({ status, evidence });
const ok = (evidence) => result('ok', evidence);
const warn = (evidence) => result('warn', evidence);
const error = (evidence) => result('error', evidence);
const unknown = (evidence) => result('unknown', evidence);
const notApplicable = (evidence) => result('not_applicable', evidence);

async function withCache(key, check) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.lastCheckedAt < CACHE_TTL_MS) return cached;

  let checked;
  try {
    checked = await check();
  } catch (checkError) {
    checked = error(`Self-test threw: ${checkError?.message || 'unknown error'}`);
  }
  const completed = {
    ...checked,
    lastCheckedAt: Date.now(),
    source: key,
  };
  cache.set(key, completed);
  return completed;
}

export function invalidateSelfTestCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

export const selfTestStorageEncryption = () => withCache('storage_encryption', async () => {
  const canary = { selfTest: true, timestamp: Date.now(), nonce: Math.random() };
  const encrypted = await encryptSensitiveValue(canary, 'privacy-intelligence:self-test');
  if (!encrypted?.encrypted || encrypted.algorithm !== 'AES-256-GCM') {
    return error('Encrypted payload is missing AES-256-GCM metadata');
  }
  const decrypted = await decryptSensitiveValue(encrypted, 'privacy-intelligence:self-test');
  if (JSON.stringify(decrypted) !== JSON.stringify(canary)) {
    return error('AES-256-GCM canary round-trip did not reproduce the input');
  }
  return ok(`AES-256-GCM round-trip verified via ${encrypted.key_provider || 'unknown provider'}`);
});

export const selfTestMemoryZeroing = () => withCache('memory_zeroing', async () => {
  const before = getSecureGpsBufferZeroCallCount();
  maskRoutePointsForPrivacy([
    { lat: 1, lng: 1, timestamp: Date.now(), speed: 1, heading: 2 },
    { lat: 1.001, lng: 1.001, timestamp: Date.now() + 1000, speed: 2, heading: 3 },
  ], {
    privacy_zones: [{
      id: 'self-test-zone',
      label: 'Self test',
      lat: 1,
      lng: 1,
      radius_m: 100,
    }],
  });
  const after = getSecureGpsBufferZeroCallCount();
  return after > before
    ? ok(`SecureGpsBuffer.zero() call count increased from ${before} to ${after}`)
    : error('SecureGpsBuffer.zero() was not invoked by route masking');
});

const openSelfTestDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    resolve(null);
    return;
  }
  const request = indexedDB.open('drivesense_privacy_self_test', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('records')) {
      request.result.createObjectStore('records', { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const selfTestSecureDeletion = () => withCache('secure_deletion', async () => {
  const db = await openSelfTestDb();
  if (!db) return unknown('IndexedDB is unavailable, so secure deletion could not be exercised');
  const key = `self-test-${Date.now()}`;
  try {
    await idbRequest(db.transaction('records', 'readwrite').objectStore('records').put({
      id: key,
      canary: true,
    }));
    await secureDelete(db, 'records', key);
    const remaining = await idbRequest(
      db.transaction('records', 'readonly').objectStore('records').get(key)
    );
    return remaining == null
      ? ok('Canary record was overwritten and removed through secureDelete()')
      : error('Canary record remained readable after secureDelete()');
  } finally {
    db.close();
  }
});

export const selfTestCertPinning = () => withCache('cert_pinning', async () => {
  if (!isNativePlatform()) {
    return notApplicable('Certificate pinning applies only to the native network runtime');
  }
  if (!PINNED_GPS_HOSTS.length) return error('No certificate pins are configured');
  return ok(`${PINNED_GPS_HOSTS.length} external service hosts have configured certificate pins`);
});

export const selfTestBridgeEncryption = () => withCache('bridge_encryption', async () => {
  if (!isNativePlatform()) {
    return notApplicable('JavaScript-to-native bridge encryption applies only on native platforms');
  }
  const canary = Date.now();
  const echoed = await secureCall('SecureBridge', 'echo', { canary });
  return echoed?.canary === canary
    ? ok('Encrypted native bridge round-trip verified')
    : error('Encrypted native bridge returned the wrong canary value');
});

export const selfTestRequestObfuscation = () => withCache('request_obfuscation', async () => {
  const status = getObfuscatorQueueStatus();
  if (!status.enabled) return notApplicable('Request timing obfuscation is disabled');
  if (!status.initialized) return unknown('No obfuscation batch has completed this session');
  return ok(`Last batch processed ${status.lastBatchSize} request(s)`);
});

const selfTestRoute = () => {
  const timestamp = Date.now();
  const settings = {
    privacy_zones: [{
      id: 'self-test-zone',
      label: 'Self test',
      lat: 0,
      lng: 0,
      radius_m: 100,
    }],
  };
  const route = [
    { lat: 0, lng: 0, timestamp, speed: 42, heading: 270, bearing: 270, accuracy: 4, altitude: 100 },
    { lat: 0.002, lng: 0.002, timestamp: timestamp + 60_000, speed: 30, heading: 180 },
  ];
  const masked = maskRoutePointsForPrivacy(route, settings);
  return {
    boundaryTimestamp: masked.find((point) => point?.privacy_boundary)?.timestamp || null,
    exported: maskRoutePointsForPrivacyExport(route, settings, `self-test-${Math.random()}`),
  };
};

export const selfTestTimestampFuzzing = () => withCache('timestamp_fuzzing', async () => {
  const { boundaryTimestamp, exported } = selfTestRoute();
  const boundary = exported.find((point) => point?.privacy_export_placeholder);
  if (!boundary) return error('Privacy export did not create a boundary placeholder');
  const exportedTimestamp = new Date(boundary.timestamp).getTime();
  const originalTimestamp = new Date(boundaryTimestamp).getTime();
  if (!Number.isFinite(exportedTimestamp) || !Number.isFinite(originalTimestamp)) {
    return error('Boundary placeholder has no valid timestamp');
  }
  const delta = Math.abs(exportedTimestamp - originalTimestamp);
  if (delta > 3 * 60 * 1000) return warn(`Boundary timestamp changed by ${delta}ms, outside the expected range`);
  return delta === 0
    ? error('Boundary timestamp was not fuzzed')
    : ok(`Boundary timestamp was fuzzed by ${delta}ms`);
});

export const selfTestKinematicNulling = () => withCache('kinematic_nulling', async () => {
  const { exported } = selfTestRoute();
  const boundary = exported.find((point) => point?.privacy_export_placeholder);
  if (!boundary) return error('Privacy export did not create a boundary placeholder');
  const fields = ['speed', 'speed_kmh', 'heading', 'bearing', 'accuracy', 'altitude'];
  const leaked = fields.filter((field) => boundary[field] != null);
  return leaked.length
    ? error(`Boundary placeholder retained kinematic fields: ${leaked.join(', ')}`)
    : ok('Boundary placeholder contains no speed, heading, bearing, accuracy, or altitude');
});

export const selfTestPrivacyZoneProtection = () => withCache('privacy_zone_protection', async () => {
  const timestamp = new Date().toISOString();
  const settings = {
    privacy_zones: [{
      id: 'zone-protection-self-test',
      label: 'Self test',
      lat: 43,
      lng: -79,
      radius_m: 120,
    }],
  };
  const masked = maskRoutePointsForPrivacy([
    { lat: 43, lng: -79, timestamp, speed_kmh: 48, heading: 90, accuracy: 4 },
  ], settings);
  const protectedPoint = masked[0];
  if (
    protectedPoint?.lat != null ||
    protectedPoint?.lng != null ||
    protectedPoint?.speed_kmh != null ||
    protectedPoint?.masked_for_privacy !== true
  ) {
    return error('Synthetic private GPS was not fully redacted before storage');
  }

  const outbound = await privacyGatedFetch('privacy-self-test', { url: 'https://invalid.local/self-test' }, {
    type: 'Privacy-zone outbound self-test',
    coordinateDisclosure: 'blocked',
    block: {
      reason: 'privacy_zone_self_test',
      privacyVerificationEvidence: ['synthetic privacy-zone request blocked before network send'],
      protections: ['privacy-zone outbound guard'],
    },
  });
  if (outbound?.blocked !== true || Number(outbound?.logRecord?.bytesOut ?? 0) !== 0) {
    return error('Synthetic outbound request was not blocked with zero bytes sent');
  }
  return ok('Synthetic private GPS was redacted and a synthetic outbound request was blocked with zero bytes sent');
});

export const selfTestScoreInputMasking = () => withCache('score_input_masking', async () => {
  const timestamp = Date.now();
  const settings = {
    privacy_zones: [{
      id: 'score-input-zone',
      label: 'Score input self test',
      lat: 43,
      lng: -79,
      radius_m: 120,
    }],
  };
  const routePoints = [
    { lat: 43, lng: -79, timestamp: new Date(timestamp).toISOString(), speed_kmh: 42, heading: 270, accuracy: 4 },
    { lat: 43.003, lng: -79.003, timestamp: new Date(timestamp + 60_000).toISOString(), speed_kmh: 35, heading: 180, accuracy: 5 },
  ];
  /** @type {null | {routePoints: Array<Record<string, any>>, privacyZones: Array<Record<string, any>>}} */
  let scoreInput = null;
  const scored = scoreTripWithPrivacyInputs({
    trip: {
      start_time: routePoints[0].timestamp,
      end_time: routePoints.at(-1).timestamp,
    },
    routePoints,
    thresholds: DEFAULT_THRESHOLDS,
    settings,
    endTime: routePoints.at(-1).timestamp,
    onScoreInput: (input) => {
      scoreInput = input;
    },
  });

  if (!scoreInput) return error('Score self-test did not reach the scoring input hook');
  try {
    assertScoreInputsDoNotContainRawZoneKinematics(scoreInput.routePoints, scoreInput.privacyZones);
  } catch (leakError) {
    return error(leakError?.message || 'Raw privacy-zone kinematics reached scoring input');
  }
  if (!scoreInput.routePoints.some(hasPrivacyRedactionMarker)) {
    return error('Privacy-zone crossing did not create a masked score-input gap');
  }
  return scored.scoreInputPrivacy?.touchedPrivacyZone
    ? ok('Real scoring path received masked privacy-zone inputs, not raw kinematic points')
    : error('Score input masking did not mark the privacy-zone crossing');
});

export const selfTestDifferentialPrivacy = () => withCache('differential_privacy', async () => {
  const samples = Array.from({ length: 20 }, () => noisyStat(10, 'distance_km'));
  if (samples.every((sample) => sample === 10)) {
    return error('Differential privacy returned the input unchanged across 20 samples');
  }
  if (samples.some((sample) => Math.abs(sample - 10) > 5)) {
    return warn('Differential privacy noise exceeded the expected canary range');
  }
  return ok('Differential privacy produced varying output across 20 samples');
});

export const selfTestCommitmentScheme = () => withCache('commitment_scheme', async () => {
  const zone = { id: 'self-test-zone', label: 'Self test', lat: 12.345678, lng: 98.765432, radius_m: 100 };
  const first = await commitZoneForExport(zone, 'self-test-a');
  const second = await commitZoneForExport(zone, 'self-test-b');
  if ('lat' in first || 'lng' in first || 'latitude' in first || 'longitude' in first) {
    return error('Zone commitment contains raw coordinate fields');
  }
  return first.commitment !== second.commitment
    ? ok('Distinct exports produced different coordinate-free commitments')
    : error('Distinct exports produced the same zone commitment');
});

export const selfTestExportSigning = () => withCache('export_signing', async () => {
  const signed = await signExport({ selfTest: true, value: 123 });
  if (!(await verifyExport(signed)).valid) return error('Freshly signed canary failed verification');
  const tampered = {
    ...signed,
    payload: { ...signed.payload, value: 999 },
  };
  return (await verifyExport(tampered)).valid
    ? error('Tampered export passed HMAC verification')
    : ok('Signed canary verified and tampered payload was rejected');
});

export const selfTestCrashScrubbing = () => withCache('crash_scrubbing', async () => {
  const serialized = JSON.stringify(sanitizeCrashPayload({
    rawGpsPoints: [{ latitude: 42.3601, longitude: -71.0589 }],
    parkedLocation: { latitude: 42.3601, longitude: -71.0589 },
  }));
  return serialized.includes('42.3601') || serialized.includes('-71.0589')
    ? error('Canary GPS values survived crash-payload sanitization')
    : ok('Canary GPS values were removed from the crash payload');
});

export const selfTestAuditLog = () => withCache('audit_log', async () => {
  const before = await loadPrivacyAuditChain();
  await appendPrivacyEvent({ op: 'SELF_TEST' });
  const after = await loadPrivacyAuditChain();
  if (after.length !== before.length + 1) return error('Audit append did not extend the chain');
  const verification = await verifyChain();
  return verification.valid
    ? ok(`Audit chain extended to ${after.length} entries and verified`)
    : error(`Audit chain failed verification: ${verification.reason}`);
});

export async function runAllSelfTests() {
  const tests = {
    storage_encryption: selfTestStorageEncryption,
    memory_zeroing: selfTestMemoryZeroing,
    secure_deletion: selfTestSecureDeletion,
    cert_pinning: selfTestCertPinning,
    bridge_encryption: selfTestBridgeEncryption,
    request_obfuscation: selfTestRequestObfuscation,
    timestamp_fuzzing: selfTestTimestampFuzzing,
    kinematic_nulling: selfTestKinematicNulling,
    privacy_zone_protection: selfTestPrivacyZoneProtection,
    score_input_masking: selfTestScoreInputMasking,
    differential_privacy: selfTestDifferentialPrivacy,
    commitment_scheme: selfTestCommitmentScheme,
    export_signing: selfTestExportSigning,
    crash_scrubbing: selfTestCrashScrubbing,
    audit_log: selfTestAuditLog,
  };
  return Object.fromEntries(await Promise.all(
    Object.entries(tests).map(async ([key, check]) => [key, await check()])
  ));
}
