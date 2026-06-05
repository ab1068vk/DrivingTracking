import { registerPlugin } from '@capacitor/core';

const EncryptedCapacitorPlugin = registerPlugin('EncryptedCapacitorPlugin');

export const encryptedCapacitorStorage = {
  async get({ key }) {
    return EncryptedCapacitorPlugin.get({ key });
  },
  async set({ key, value }) {
    return EncryptedCapacitorPlugin.set({ key, value });
  },
  async remove({ key }) {
    return EncryptedCapacitorPlugin.remove({ key });
  },
  async clear() {
    return EncryptedCapacitorPlugin.clear();
  },
};
