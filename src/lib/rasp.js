import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import { recordSystemEvent, logSystemFailure } from '@/lib/systemLog';
import { getBuildIntegrityInfo } from '@/lib/buildIntegrity';

const Rasp = registerPlugin('Rasp');

const MAX_THREAT_COUNT = 20;
const MAX_THREAT_LENGTH = 120;

export const RASP_STATUS_EVENT = 'roadsage-device-integrity-status-changed';

export function sanitizeIntegrityResult(result = {}) {
  const threats = Array.isArray(result.threats)
    ? result.threats
      .filter((threat) => typeof threat === 'string' && threat.trim())
      .map((threat) => threat.trim().slice(0, MAX_THREAT_LENGTH))
      .slice(0, MAX_THREAT_COUNT)
    : [];

  return {
    secure: result.secure === true && threats.length === 0,
    threats,
    checkedAt: typeof result.checkedAt === 'string' ? result.checkedAt : new Date().toISOString(),
    native: result.native === true,
    buildHash: typeof result.buildHash === 'string' && result.buildHash.trim()
      ? result.buildHash.trim()
      : getBuildIntegrityInfo().buildHash,
    buildHashAlgorithm: result.buildHashAlgorithm || getBuildIntegrityInfo().algorithm,
  };
}

export function integrityStatusFromSettings(settings = localSettings.get()) {
  const threats = Array.isArray(settings.rasp_threats) ? settings.rasp_threats : [];
  if (settings.rasp_secure === false || threats.length > 0) {
    return {
      secure: false,
      threats,
      checkedAt: settings.rasp_checked_at || '',
      native: settings.rasp_native === true,
    };
  }
  return {
    secure: true,
    threats: [],
    checkedAt: settings.rasp_checked_at || '',
    native: settings.rasp_native === true,
  };
}

export async function checkIntegrity({ persist = true } = {}) {
  if (!isAndroid()) {
    return sanitizeIntegrityResult({ secure: true, threats: [], native: false });
  }

  try {
    const result = sanitizeIntegrityResult({
      ...await Rasp.check(),
      native: true,
    });

    if (persist) {
      localSettings.update({
        rasp_secure: result.secure,
        rasp_threats: result.threats,
        rasp_checked_at: result.checkedAt,
        rasp_native: true,
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(RASP_STATUS_EVENT, { detail: result }));
      }
    }

    if (!result.secure) {
      recordSystemEvent('device_integrity_threat_detected', {
        threat_count: result.threats.length,
        threats: result.threats,
      }, {
        category: 'security',
        severity: 'warn',
        title: 'Device integrity concern detected',
      });
    }

    return result;
  } catch (error) {
    logSystemFailure('device_integrity_check_failed', error);
    throw error;
  }
}
