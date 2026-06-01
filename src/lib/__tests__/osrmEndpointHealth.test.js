import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOsrmEndpointHealth, readableOsrmHeader } from '@/lib/osrmEndpointHealth';

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
