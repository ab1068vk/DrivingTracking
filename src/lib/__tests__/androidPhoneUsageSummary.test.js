import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPhoneUsageSummary: vi.fn(),
  isAndroid: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: mocks.isAndroid,
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: {
    getPhoneUsageSummary: mocks.getPhoneUsageSummary,
  },
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
  recordSystemEvent: mocks.recordSystemEvent,
}));

vi.mock('@/lib/permissions', () => ({
  requestActivityRecognitionPermission: vi.fn(),
}));

vi.mock('@/lib/tripEngine', () => ({
  haversineDistance: vi.fn(),
}));

const emptySummary = {
  usage_access_granted: false,
  events: [],
  event_count: 0,
  total_seconds: 0,
};

describe('getAndroidPhoneUsageSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAndroid.mockReturnValue(true);
    mocks.getPhoneUsageSummary.mockResolvedValue({
      usage_access_granted: true,
      events: [],
      event_count: 0,
      total_seconds: 0,
    });
  });

  it('does not call the Android plugin when the time window is missing', async () => {
    const { getAndroidPhoneUsageSummary } = await import('@/lib/activityRecognition');

    await expect(getAndroidPhoneUsageSummary()).resolves.toEqual(emptySummary);

    expect(mocks.getPhoneUsageSummary).not.toHaveBeenCalled();
    expect(mocks.logSystemFailure).not.toHaveBeenCalled();
  });

  it('does not call the Android plugin when the time window is invalid', async () => {
    const { getAndroidPhoneUsageSummary } = await import('@/lib/activityRecognition');

    await expect(getAndroidPhoneUsageSummary(Number.NaN, Date.now())).resolves.toEqual(emptySummary);
    await expect(getAndroidPhoneUsageSummary(2000, 1000)).resolves.toEqual(emptySummary);

    expect(mocks.getPhoneUsageSummary).not.toHaveBeenCalled();
    expect(mocks.logSystemFailure).not.toHaveBeenCalled();
  });

  it('passes a normalized finite time window to the Android plugin', async () => {
    const { getAndroidPhoneUsageSummary } = await import('@/lib/activityRecognition');

    await getAndroidPhoneUsageSummary('1000', '4000');

    expect(mocks.getPhoneUsageSummary).toHaveBeenCalledWith({ startMs: 1000, endMs: 4000 });
    expect(mocks.recordSystemEvent).toHaveBeenCalledWith(
      'android_phone_usage_summary_loaded',
      expect.objectContaining({ window_seconds: 3 }),
      expect.any(Object)
    );
  });

  it('treats the native missing-window rejection as empty usage data without logging a failure', async () => {
    mocks.getPhoneUsageSummary.mockRejectedValueOnce(new Error('startMs and endMs are required.'));
    const { getAndroidPhoneUsageSummary } = await import('@/lib/activityRecognition');

    await expect(getAndroidPhoneUsageSummary(1000, 4000)).resolves.toEqual(emptySummary);

    expect(mocks.logSystemFailure).not.toHaveBeenCalled();
  });
});
