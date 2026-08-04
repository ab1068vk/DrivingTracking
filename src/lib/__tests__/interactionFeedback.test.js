import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginInteractionTask,
  beginNavigationFeedback,
  endInteractionTask,
  endNavigationFeedback,
  subscribeToInteractionFeedback,
} from '@/lib/interactionFeedback';

// Module state is shared across tests, so every test drains its own tasks.
describe('interaction feedback store', () => {
  let unsubscribe = null;

  beforeEach(() => {
    vi.useFakeTimers();
    // The suite runs in node, and this module calls window.setTimeout directly.
    // Delegating at call time picks up the faked timers.
    vi.stubGlobal('window', {
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
    });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    endNavigationFeedback();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports an idle state immediately on subscribe', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    expect(states.at(-1)).toMatchObject({ busy: false, count: 0 });
  });

  it('goes busy while a task runs and idle again when it ends', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    const id = beginInteractionTask('Saving trip');
    expect(states.at(-1)).toMatchObject({ busy: true, count: 1, label: 'Saving trip' });

    endInteractionTask(id);
    expect(states.at(-1)).toMatchObject({ busy: false, count: 0 });
  });

  it('shows the most recent label while several tasks overlap', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    const first = beginInteractionTask('Loading trips');
    const second = beginInteractionTask('Exporting report');
    expect(states.at(-1)).toMatchObject({ busy: true, count: 2, label: 'Exporting report' });

    endInteractionTask(second);
    expect(states.at(-1)).toMatchObject({ busy: true, count: 1, label: 'Loading trips' });

    endInteractionTask(first);
    expect(states.at(-1)).toMatchObject({ busy: false, count: 0 });
  });

  it('auto-clears a task that never ends so the spinner cannot get stuck', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    beginInteractionTask('Stuck operation', { timeoutMs: 1000 });
    expect(states.at(-1)).toMatchObject({ busy: true });

    vi.advanceTimersByTime(1000);
    expect(states.at(-1)).toMatchObject({ busy: false, count: 0 });
  });

  it('does not fire a second idle update when a finished task later times out', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    const id = beginInteractionTask('Quick save', { timeoutMs: 1000 });
    endInteractionTask(id);
    const countAfterEnd = states.length;

    vi.advanceTimersByTime(5000);
    expect(states.length).toBe(countAfterEnd);
  });

  it('ignores an unknown or repeated end call', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    const id = beginInteractionTask('Save');
    endInteractionTask(id);
    const countAfterEnd = states.length;

    endInteractionTask(id);
    endInteractionTask('never-existed');
    expect(states.length).toBe(countAfterEnd);
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const states = [];
    const stop = subscribeToInteractionFeedback((state) => states.push(state));
    const countAtSubscribe = states.length;

    stop();
    const id = beginInteractionTask('After unsubscribe');
    endInteractionTask(id);

    expect(states.length).toBe(countAtSubscribe);
  });

  it('replaces the previous navigation task instead of stacking them', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    beginNavigationFeedback('Opening dashboard');
    beginNavigationFeedback('Opening settings');

    expect(states.at(-1)).toMatchObject({ busy: true, count: 1, label: 'Opening settings' });

    endNavigationFeedback();
    expect(states.at(-1)).toMatchObject({ busy: false, count: 0 });
  });

  it('treats a redundant navigation end as a no-op', () => {
    const states = [];
    unsubscribe = subscribeToInteractionFeedback((state) => states.push(state));

    beginNavigationFeedback('Opening insights');
    endNavigationFeedback();
    const countAfterEnd = states.length;

    endNavigationFeedback();
    expect(states.length).toBe(countAfterEnd);
  });
});
