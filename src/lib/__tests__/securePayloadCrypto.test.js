import { describe, expect, it } from 'vitest';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isEncryptedPayload,
} from '@/lib/securePayloadCrypto';

describe('securePayloadCrypto', () => {
  it('round-trips sensitive JSON without embedding plaintext coordinates', async () => {
    const value = {
      id: 'trip-1',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    };

    const encrypted = await encryptSensitiveValue(value, 'trip:trip-1');

    expect(isEncryptedPayload(encrypted)).toBe(true);
    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(JSON.stringify(encrypted)).not.toContain('43.6532');
    expect(JSON.stringify(encrypted)).not.toContain('-79.3832');
    await expect(decryptSensitiveValue(encrypted, 'trip:trip-1')).resolves.toEqual(value);
  });

  it('rejects modified ciphertext and mismatched record context', async () => {
    const encrypted = await encryptSensitiveValue({ lat: 43.65, lng: -79.38 }, 'trip:one');
    const finalCharacter = encrypted.ciphertext.at(-1);
    const tampered = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`,
    };

    await expect(decryptSensitiveValue(tampered, 'trip:one')).rejects.toThrow();
    await expect(decryptSensitiveValue(encrypted, 'trip:two')).rejects.toThrow();
  });
});
