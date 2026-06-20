import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';

vi.mock('@/lib/privacyZones', () => ({
  isInsidePrivacyZone: vi.fn(() => false),
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

function memoryStore() {
  const values = new Map();
  return {
    get: vi.fn(async (key, fallback) => values.get(key) ?? fallback),
    set: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
}

describe('LocalSpeedKnowledge events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const target = new EventTarget();
    vi.stubGlobal('CustomEvent', class CustomEvent extends Event {
      constructor(type, params = {}) {
        super(type);
        this.detail = params.detail;
      }
    });
    vi.stubGlobal('window', {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    });
  });

  it('emits a shared change event when user speed corrections are saved, updated, and removed', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const listener = vi.fn();
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, listener);

    try {
      const saved = await knowledge.saveUserCorrection(
        43.6501,
        -79.3801,
        50,
        '',
        null,
        [],
        'user_confirmed_posted_sign'
      );
      const [correction] = await knowledge.listUserCorrections();
      const updated = await knowledge.updateUserCorrection(correction.geohash, 60, 'user_entered_estimate');
      const removed = await knowledge.removeUserCorrection(correction.geohash);

      expect(saved).toBe(true);
      expect(updated).toBe(true);
      expect(removed).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener.mock.calls.map(([event]) => event.detail.action)).toEqual([
        'save_correction',
        'update_correction',
        'remove_correction',
      ]);
    } finally {
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, listener);
    }
  });
});
