import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = {
  enqueue: vi.fn(),
  getResult: vi.fn(),
  remove: vi.fn(),
};
const platform = { android: true };

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => plugin,
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => platform.android,
}));

const importModule = () => import('@/lib/nativeRoadDataQueue');

describe('runNativeRoadDataRequest', () => {
  beforeEach(() => {
    platform.android = true;
    plugin.enqueue.mockReset().mockResolvedValue(undefined);
    plugin.getResult.mockReset();
    plugin.remove.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing off Android so the web build never queues native work', async () => {
    platform.android = false;
    const { runNativeRoadDataRequest } = await importModule();

    await expect(runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 0))
      .resolves.toBeNull();
    expect(plugin.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a request with no URL', async () => {
    const { runNativeRoadDataRequest } = await importModule();

    await expect(runNativeRoadDataRequest('overpass', {}, 0)).resolves.toBeNull();
    await expect(runNativeRoadDataRequest('overpass', null, 0)).resolves.toBeNull();
    expect(plugin.enqueue).not.toHaveBeenCalled();
  });

  it('returns parsed JSON and clears the queue entry on success', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: '{"ways":[1,2]}' });
    const { runNativeRoadDataRequest } = await importModule();

    const result = await runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 5000);

    expect(result).toEqual({ ways: [1, 2] });
    expect(plugin.remove).toHaveBeenCalledTimes(1);
  });

  it('passes the delay and request shape through to the native queue', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: 'null' });
    const { runNativeRoadDataRequest } = await importModule();

    await runNativeRoadDataRequest('weather', {
      url: 'https://example.test/w',
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: 'q=1',
    }, 12345);

    expect(plugin.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.test/w',
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: 'q=1',
      delayMs: 12345,
    }));
  });

  it('defaults method and body rather than sending undefined to native', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: 'null' });
    const { runNativeRoadDataRequest } = await importModule();

    await runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 0);

    expect(plugin.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      headers: {},
      body: null,
    }));
  });

  it('surfaces a native error and still clears the queue entry', async () => {
    plugin.getResult.mockResolvedValue({ status: 'error', error: 'provider unreachable' });
    const { runNativeRoadDataRequest } = await importModule();

    await expect(runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 0))
      .rejects.toThrow('provider unreachable');
    expect(plugin.remove).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid JSON body instead of returning junk', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: 'not json' });
    const { runNativeRoadDataRequest } = await importModule();

    await expect(runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 0))
      .rejects.toThrow('invalid JSON');
  });

  it('keeps polling while the native result is still pending', async () => {
    vi.useFakeTimers();
    plugin.getResult
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'success', body: '{"done":true}' });
    const { runNativeRoadDataRequest } = await importModule();

    const pending = runNativeRoadDataRequest('overpass', { url: 'https://example.test' }, 0);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ done: true });
    expect(plugin.getResult.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('reuses one stable request id for identical requests and differs for others', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: 'null' });
    const { runNativeRoadDataRequest } = await importModule();

    const request = { url: 'https://example.test/a', method: 'GET' };
    await runNativeRoadDataRequest('overpass', request, 0);
    await runNativeRoadDataRequest('overpass', request, 0);
    await runNativeRoadDataRequest('overpass', { url: 'https://example.test/b' }, 0);
    await runNativeRoadDataRequest('weather', request, 0);

    const ids = plugin.enqueue.mock.calls.map((call) => call[0].requestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
    expect(ids[0]).toMatch(/^road_overpass_[0-9a-f]+$/);
  });

  it('honours an explicitly supplied request id', async () => {
    plugin.getResult.mockResolvedValue({ status: 'success', body: 'null' });
    const { runNativeRoadDataRequest } = await importModule();

    await runNativeRoadDataRequest('overpass', { url: 'https://example.test', requestId: 'fixed-id' }, 0);

    expect(plugin.enqueue).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'fixed-id' }));
  });
});
