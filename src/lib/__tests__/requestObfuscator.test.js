import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueLocationRequest,
  REQUEST_OBFUSCATION_TIMING,
  resetRequestObfuscatorForTests,
} from '@/lib/requestObfuscator';
import { localSettings } from '@/lib/trackingStore';

describe('request timing obfuscation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((values) => {
        values[0] = 0;
        return values;
      }),
    });
    localSettings.update({
      request_obfuscation_enabled: true,
      decoy_traffic_mode: 'off',
    });
  });

  afterEach(() => {
    resetRequestObfuscatorForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds real requests until the randomized batch window opens', async () => {
    const request = vi.fn(async () => 'weather-result');
    const resultPromise = enqueueLocationRequest('weather', request);

    await vi.advanceTimersByTimeAsync(REQUEST_OBFUSCATION_TIMING.batchMinMs - 1);
    expect(request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('weather-result');
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('batches requests, adds decoys, and preserves individual outcomes', async () => {
    const successful = vi.fn(async () => ({ ways: [1] }));
    const failed = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    const successfulPromise = enqueueLocationRequest('overpass', successful);
    const failedPromise = enqueueLocationRequest('weather', failed);
    const failedExpectation = expect(failedPromise).rejects.toThrow('provider unavailable');
    await vi.runAllTimersAsync();

    await expect(successfulPromise).resolves.toEqual({ ways: [1] });
    await failedExpectation;
    expect(successful).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only the existing Open-Meteo endpoint when first-party decoys are enabled', async () => {
    localSettings.update({ decoy_traffic_mode: 'first_party' });
    const resultPromise = enqueueLocationRequest('weather', async () => 'ok');
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(REQUEST_OBFUSCATION_TIMING.decoyMinCount);
    expect(fetch.mock.calls[0][0]).toContain('api.open-meteo.com');
    expect(fetch.mock.calls[0][0]).toContain('latitude=0&longitude=0');
  });
});
