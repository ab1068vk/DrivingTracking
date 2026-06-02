import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOsrmHealthPatch, checkOsrmEndpointHealth, readableOsrmHeader } from '@/lib/osrmEndpointHealth';

describe('OSRM endpoint health', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a 200 OPTIONS response with an exposed OSRM header', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
      status: 200,
      headers: new Headers({ 'X-OSRM-Backend': 'osrm-backend' }),
      options,
    })));

    const result = await checkOsrmEndpointHealth('https://osrm.example/');

    expect(fetch).toHaveBeenCalledWith('https://osrm.example', expect.objectContaining({
      method: 'OPTIONS',
    }));
    expect(result).toMatchObject({
      ok: true,
      status: 'connected',
      header: 'x-osrm-backend',
      url: 'https://osrm.example',
      origin: 'https://osrm.example',
      domain: 'osrm.example',
    });
    expect(buildOsrmHealthPatch(result)).toMatchObject({
      osrm_verified_endpoint: 'https://osrm.example',
      osrm_verified_origin: 'https://osrm.example',
      osrm_verified_domain: 'osrm.example',
      osrm_health_status: 'connected',
    });
  });

  it('rejects untrusted endpoints before issuing a health request', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await checkOsrmEndpointHealth('http://osrm.example');

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 'unreachable',
    });
    expect(result.error).toContain('HTTPS');
    expect(buildOsrmHealthPatch(result)).toMatchObject({
      osrm_verified_endpoint: '',
      osrm_verified_origin: '',
      osrm_verified_domain: '',
      osrm_last_reachable_at: '',
    });
  });

  it('rejects endpoints that do not expose an OSRM-specific response header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: new Headers({ Server: 'nginx' }),
    })));

    const result = await checkOsrmEndpointHealth('https://not-osrm.example');

    expect(result).toMatchObject({
      ok: false,
      status: 'unreachable',
    });
    expect(result.error).toContain('X-OSRM');
  });

  it('can identify OSRM headers by name or value', () => {
    expect(readableOsrmHeader(new Headers({ 'X-OSRM-Version': '5.27' }))).toMatchObject({
      name: 'x-osrm-version',
    });
    expect(readableOsrmHeader(new Headers({ 'X-Service': 'private-osrm' }))).toMatchObject({
      name: 'x-service',
    });
  });
});
