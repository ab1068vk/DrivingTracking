import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetLifecycleAuthorityForTests,
  getLifecycleSnapshot,
  isSupportedLifecycleSignal,
  recordLifecycleSignal,
  subscribeLifecycleSignals,
} from '@/lib/lifecycleAuthority';

beforeEach(() => {
  __resetLifecycleAuthorityForTests();
});

describe('production lifecycle authority', () => {
  it('V1: preserves both raw signals while one physical transition advances one epoch', () => {
    const observer = vi.fn();
    const unsubscribe = subscribeLifecycleSignals(observer);

    const documentEvent = recordLifecycleSignal('visibilitychange', 'hidden');
    const nativeEvent = recordLifecycleSignal('appStateChange', 'inactive');

    expect(documentEvent).toMatchObject({
      source: 'visibilitychange',
      state: 'hidden',
      sequence: 1,
      effectiveChanged: true,
      effectiveForeground: false,
      epoch: 1,
    });
    expect(nativeEvent).toMatchObject({
      source: 'appStateChange',
      state: 'inactive',
      sequence: 2,
      effectiveChanged: false,
      effectiveForeground: false,
      epoch: 1,
    });
    expect(observer.mock.calls.map(([event]) => [event.source, event.state, event.epoch])).toEqual([
      ['visibilitychange', 'hidden', 1],
      ['appStateChange', 'inactive', 1],
    ]);
    expect(getLifecycleSnapshot()).toMatchObject({
      documentVisible: false,
      nativeActive: false,
      effectiveForeground: false,
      epoch: 1,
      rawSequence: 2,
    });
    unsubscribe();
  });

  it('requires both raw authorities before effective foreground resumes', () => {
    recordLifecycleSignal('appStateChange', 'inactive');
    expect(getLifecycleSnapshot()).toMatchObject({ effectiveForeground: false, epoch: 1 });

    recordLifecycleSignal('visibilitychange', 'hidden');
    recordLifecycleSignal('appStateChange', 'active');
    expect(getLifecycleSnapshot()).toMatchObject({ effectiveForeground: false, epoch: 1 });

    recordLifecycleSignal('visibilitychange', 'visible');
    expect(getLifecycleSnapshot()).toMatchObject({ effectiveForeground: true, epoch: 2 });
  });

  it('does not let an observer failure block lifecycle advancement or later observers', () => {
    const later = vi.fn();
    subscribeLifecycleSignals(() => { throw new Error('observer failure'); });
    subscribeLifecycleSignals(later);

    expect(() => recordLifecycleSignal('visibilitychange', 'hidden')).not.toThrow();
    expect(getLifecycleSnapshot()).toMatchObject({ effectiveForeground: false, epoch: 1 });
    expect(later).toHaveBeenCalledOnce();
  });

  it.each([
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    null,
    undefined,
    42,
    { source: 'visibilitychange' },
  ])('F05: support predicate is total and false for hostile source %#', (source) => {
    expect(() => isSupportedLifecycleSignal(source, source)).not.toThrow();
    expect(isSupportedLifecycleSignal(source, source)).toBe(false);
  });

  it('keeps direct authority recording fail-closed for unsupported signals', () => {
    expect(() => recordLifecycleSignal('__proto__', 'hidden')).toThrow(TypeError);
  });
});
