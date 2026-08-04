import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = { android: true };
const nativePlugin = { recordAppExperienceCheckpoint: vi.fn() };

vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => platform.android }));
vi.mock('@/lib/driveSenseNativePlugin', () => ({ default: nativePlugin }));
vi.mock('@/lib/performanceTriage', () => ({
  PERFORMANCE_CHECKPOINT_EVENT: 'road-sage:performance-checkpoint',
}));

const CHECKPOINT_EVENT = 'road-sage:performance-checkpoint';

const makeWindow = () => {
  const handlers = new Map();
  return {
    location: { pathname: '/dashboard' },
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name) => handlers.delete(name),
    dispatch: (name, detail) => handlers.get(name)?.({ detail }),
    handlerCount: () => handlers.size,
  };
};

// The module keeps process-wide state, so each test reloads it fresh.
const loadFresh = async () => {
  vi.resetModules();
  return import('@/lib/nativeAppExperienceWatchdog');
};

describe('initializeNativeAppExperienceWatchdog', () => {
  let win;

  beforeEach(() => {
    platform.android = true;
    nativePlugin.recordAppExperienceCheckpoint.mockReset().mockResolvedValue(undefined);
    win = makeWindow();
    vi.stubGlobal('window', win);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing off Android so web builds never call the native plugin', async () => {
    platform.android = false;
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();

    expect(initializeNativeAppExperienceWatchdog()).toBe(false);
    expect(win.handlerCount()).toBe(0);
  });

  it('does nothing without a window', async () => {
    vi.stubGlobal('window', undefined);
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();

    expect(initializeNativeAppExperienceWatchdog()).toBe(false);
  });

  it('registers once and ignores repeat initialization', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();

    expect(initializeNativeAppExperienceWatchdog()).toBe(true);
    expect(initializeNativeAppExperienceWatchdog()).toBe(false);
    expect(win.handlerCount()).toBe(1);
  });

  it('records a startup checkpoint carrying the current pathname', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();
    initializeNativeAppExperienceWatchdog();
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());

    expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalledWith({
      operation: 'app.javascriptRuntime',
      phase: 'start',
      pathname: '/dashboard',
    });
  });

  it('forwards later checkpoint events to the native plugin', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();
    initializeNativeAppExperienceWatchdog();
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());
    nativePlugin.recordAppExperienceCheckpoint.mockClear();

    win.dispatch(CHECKPOINT_EVENT, { operation: 'trip.save', phase: 'end', pathname: '/trips/9' });
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());

    expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalledWith({
      operation: 'trip.save',
      phase: 'end',
      pathname: '/trips/9',
    });
  });

  it('bounds every field so a runaway string cannot be handed to native', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();
    initializeNativeAppExperienceWatchdog();
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());
    nativePlugin.recordAppExperienceCheckpoint.mockClear();

    win.dispatch(CHECKPOINT_EVENT, {
      operation: 'o'.repeat(5000),
      phase: 'p'.repeat(5000),
      pathname: '/'.repeat(5000),
    });
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());

    const sent = nativePlugin.recordAppExperienceCheckpoint.mock.calls.at(-1)[0];
    expect(sent.operation).toHaveLength(140);
    expect(sent.phase).toHaveLength(20);
    expect(sent.pathname).toHaveLength(160);
  });

  it('substitutes "unknown" for missing checkpoint fields', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();
    initializeNativeAppExperienceWatchdog();
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());
    nativePlugin.recordAppExperienceCheckpoint.mockClear();

    win.dispatch(CHECKPOINT_EVENT, { somethingElse: true });
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());

    expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalledWith({
      operation: 'unknown',
      phase: 'unknown',
      pathname: '',
    });
  });

  it('ignores an event with no usable detail', async () => {
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();
    initializeNativeAppExperienceWatchdog();
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());
    nativePlugin.recordAppExperienceCheckpoint.mockClear();

    win.dispatch(CHECKPOINT_EVENT, null);
    win.dispatch(CHECKPOINT_EVENT, 'not an object');

    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(nativePlugin.recordAppExperienceCheckpoint).not.toHaveBeenCalled();
  });

  it('keeps running after a native failure, since the watchdog is optional', async () => {
    nativePlugin.recordAppExperienceCheckpoint.mockRejectedValue(new Error('native unavailable'));
    const { initializeNativeAppExperienceWatchdog } = await loadFresh();

    expect(initializeNativeAppExperienceWatchdog()).toBe(true);
    await vi.waitFor(() => expect(nativePlugin.recordAppExperienceCheckpoint).toHaveBeenCalled());

    nativePlugin.recordAppExperienceCheckpoint.mockResolvedValue(undefined);
    win.dispatch(CHECKPOINT_EVENT, { operation: 'after.failure', phase: 'end' });
    await vi.waitFor(() => expect(
      nativePlugin.recordAppExperienceCheckpoint.mock.calls.some((call) => call[0].operation === 'after.failure')
    ).toBe(true));
  });
});
