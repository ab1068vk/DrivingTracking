import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from '@/lib/nativePlatform';

const PlayIntegrity = registerPlugin('PlayIntegrity');

const textToBase64Url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export function createIntegrityNonce(action = 'sensitive-action') {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return textToBase64Url(`road-sage:${action}:${random}`);
}

export async function requestPlayIntegrityAttestation(action = 'sensitive-action') {
  if (!isNativePlatform()) return null;
  const nonce = createIntegrityNonce(action);
  const cloudProjectNumber = import.meta.env.VITE_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER || undefined;
  return PlayIntegrity.requestAttestation({
    nonce,
    ...(cloudProjectNumber ? { cloudProjectNumber } : {}),
  });
}

export async function assertPlayIntegrityForSensitiveAction(action = 'sensitive-action') {
  if (!isNativePlatform()) return null;
  const result = await requestPlayIntegrityAttestation(action);
  if (!result?.token) {
    throw new Error('Play Integrity attestation did not return a token.');
  }
  if (
    result.requiresServerVerification === true &&
    import.meta.env.VITE_ALLOW_UNVERIFIED_PLAY_INTEGRITY !== 'true'
  ) {
    throw new Error('Play Integrity attestation must be verified by a trusted backend before this native sensitive action can continue.');
  }
  return result;
}
