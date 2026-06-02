import { registerPlugin } from '@capacitor/core';

const BiometricGate = registerPlugin('BiometricGate');

export async function authenticateBiometricGate() {
  const availability = await BiometricGate.isAvailable();
  if (!availability?.available) return { authenticated: false, unavailable: true };
  return BiometricGate.authenticate({
    title: 'Unlock Road Sage',
    description: 'Confirm your identity to access trip data.',
  });
}
