import { registerPlugin } from '@capacitor/core';

const NativeSecureKey = registerPlugin('SecureKey');

export const SecureKey = {
  encrypt: (payload) => NativeSecureKey.encrypt(payload),
  decrypt: (payload) => NativeSecureKey.decrypt(payload),
  keyBacking: () => NativeSecureKey.keyBacking(),
  wipeAllFiles: () => NativeSecureKey.wipeAllFiles(),
};
