import { registerPlugin } from '@capacitor/core';

const BiometricGate = registerPlugin('BiometricGate');

export async function isBiometricGateAvailable() {
  try {
    const result = await BiometricGate.isAvailable();
    return result?.available === true;
  } catch {
    return false;
  }
}

export async function authenticateBiometricGate() {
  const result = await BiometricGate.authenticate();
  if (result?.status === 'unavailable') {
    throw new Error('unavailable');
  }
  if (result?.status === 'cancelled') {
    throw new Error('cancelled');
  }
  if (result?.status !== 'success') {
    throw new Error(result?.message || 'auth_failed');
  }
}
