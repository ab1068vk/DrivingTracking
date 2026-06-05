import { describe, expect, it } from 'vitest';
import {
  isLocalOrPrivateHostname,
  normalizeTrustedHttpsEndpoint,
  parseTrustedOrigins,
} from '@/lib/externalEndpointTrust';

describe('external endpoint trust', () => {
  it('normalizes trusted HTTPS endpoint records', () => {
    expect(normalizeTrustedHttpsEndpoint('https://api.example.test/v1/')).toMatchObject({
      ok: true,
      url: 'https://api.example.test/v1',
      origin: 'https://api.example.test',
      domain: 'api.example.test',
    });
  });

  it('rejects non-HTTPS, local, private, credentialed, and query-bearing endpoints', () => {
    expect(normalizeTrustedHttpsEndpoint('http://api.example.test').ok).toBe(false);
    expect(normalizeTrustedHttpsEndpoint('https://localhost:5000').ok).toBe(false);
    expect(normalizeTrustedHttpsEndpoint('https://192.168.1.10').ok).toBe(false);
    expect(normalizeTrustedHttpsEndpoint('https://8.8.8.8').ok).toBe(false);
    expect(normalizeTrustedHttpsEndpoint('https://user:pass@api.example.test').ok).toBe(false);
    expect(normalizeTrustedHttpsEndpoint('https://api.example.test?token=abc').ok).toBe(false);
  });

  it('detects common private network hostnames and addresses', () => {
    expect(isLocalOrPrivateHostname('localhost')).toBe(true);
    expect(isLocalOrPrivateHostname('10.1.2.3')).toBe(true);
    expect(isLocalOrPrivateHostname('172.20.1.1')).toBe(true);
    expect(isLocalOrPrivateHostname('192.168.1.1')).toBe(true);
    expect(isLocalOrPrivateHostname('[::1]')).toBe(true);
    expect(isLocalOrPrivateHostname('osrm.example.test')).toBe(false);
  });

  it('enforces explicit trusted origin allowlists when provided', () => {
    const allowlist = parseTrustedOrigins('https://api.example.test, osrm.example.test');

    expect(allowlist).toEqual(['https://api.example.test', 'https://osrm.example.test']);
    expect(normalizeTrustedHttpsEndpoint('https://api.example.test/v1', {
      allowedOrigins: allowlist,
    }).ok).toBe(true);
    expect(normalizeTrustedHttpsEndpoint('https://other.example.test/v1', {
      allowedOrigins: allowlist,
    }).error).toContain('allowlist');
  });
});
