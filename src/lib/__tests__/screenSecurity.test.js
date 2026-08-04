import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = { setSecure: vi.fn() };
const platform = { android: true };

vi.mock('@capacitor/core', () => ({ registerPlugin: () => plugin }));
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => platform.android }));

const load = () => import('@/lib/screenSecurity');

// The argument is "capture allowed" but the native flag is "secure", so the
// two are deliberately inverted. Getting that backwards would silently permit
// screenshots of trip routes, which is why the polarity is pinned here.
describe('setScreenCaptureAllowed', () => {
  beforeEach(() => {
    platform.android = true;
    plugin.setSecure.mockReset().mockResolvedValue({ secure: true });
  });

  it('marks the window secure when capture is NOT allowed', async () => {
    const { setScreenCaptureAllowed } = await load();
    await setScreenCaptureAllowed(false);

    expect(plugin.setSecure).toHaveBeenCalledWith({ secure: true });
  });

  it('drops the secure flag only for an explicit true', async () => {
    const { setScreenCaptureAllowed } = await load();
    await setScreenCaptureAllowed(true);

    expect(plugin.setSecure).toHaveBeenCalledWith({ secure: false });
  });

  it('fails closed for anything that is not exactly true', async () => {
    const { setScreenCaptureAllowed } = await load();

    for (const value of [undefined, null, 0, '', 'true', 1, {}]) {
      plugin.setSecure.mockClear();
      await setScreenCaptureAllowed(value);
      expect(plugin.setSecure, `value ${JSON.stringify(value)} weakened the guard`)
        .toHaveBeenCalledWith({ secure: true });
    }
  });

  it('reports the native result and flags it as native', async () => {
    plugin.setSecure.mockResolvedValue({ secure: true, extra: 'detail' });
    const { setScreenCaptureAllowed } = await load();

    await expect(setScreenCaptureAllowed(false)).resolves.toEqual({
      secure: true,
      extra: 'detail',
      native: true,
    });
  });

  it('reports no native protection off Android instead of pretending it is secure', async () => {
    platform.android = false;
    const { setScreenCaptureAllowed } = await load();

    await expect(setScreenCaptureAllowed(false)).resolves.toEqual({ secure: false, native: false });
    expect(plugin.setSecure).not.toHaveBeenCalled();
  });
});
