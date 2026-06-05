import { describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, API_ENDPOINT_CONFIGURED, apiClient } from '@/api/client';
import { shouldUseLocalStore as shouldUseLocalTripStore } from '@/api/trips';
import { shouldUseLocalStore as shouldUseLocalVehicleStore } from '@/api/vehicles';

describe('API backend fallback', () => {
  it('does not fall back to a localhost backend URL', () => {
    expect(API_BASE_URL).toBe('');
    expect(API_ENDPOINT_CONFIGURED).toBe(false);
    expect(API_BASE_URL).not.toBe('http://localhost:5000/api');
  });

  it('uses local stores when no backend URL is configured', () => {
    expect(shouldUseLocalTripStore()).toBe(true);
    expect(shouldUseLocalVehicleStore()).toBe(true);
  });

  it('fails backend requests before fetch when no backend URL is configured', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(apiClient.get('/trips')).rejects.toThrow('No backend API configured');
    expect(fetch).not.toHaveBeenCalled();
  });
});
