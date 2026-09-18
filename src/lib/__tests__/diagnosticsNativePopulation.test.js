import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const health = vi.hoisted(() => vi.fn());
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => true, isNativePlatform: () => true, getNativePlatform: () => 'android' }));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: { diagnosticsHealth: health } }));

describe('Diagnostics native population scalar', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    health.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([0, 1, 20, 21, 100, 128, 500, 1000, 3000, 5000, 10000])('reports %i records from one catalog scalar read', async (total) => {
    health.mockResolvedValue({ liveCount: total, archiveGeneration: 'g', lastCommittedSeq: 9 });
    const { readDiagnosticsTripPopulation } = await import('@/api/trips');
    expect(await readDiagnosticsTripPopulation()).toMatchObject({
      available: true, totalTripCount: total, completedTripCount: null,
      snapshot: { authority: 'native', generation: 'g', revision: 9 },
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('does not turn a missing native scalar into an empty population', async () => {
    health.mockResolvedValue({ archiveGeneration: 'g' });
    const { readDiagnosticsTripPopulation } = await import('@/api/trips');
    expect(await readDiagnosticsTripPopulation()).toMatchObject({ available: false, reason: 'native_health_unavailable' });
  });
});
