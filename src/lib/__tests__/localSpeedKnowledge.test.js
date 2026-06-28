import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geohashEncode, LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';

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

      expect(saved).toMatchObject({
        id: expect.any(String),
        geohash: correction.geohash,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        verificationStatus: 'confirmed_posted_sign',
      });
      expect(updated).toBe(true);
      expect(removed).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener.mock.calls[0][0].detail.correctionId).toBe(saved.id);
      expect(listener.mock.calls.map(([event]) => event.detail.action)).toEqual([
        'save_correction',
        'update_correction',
        'remove_correction',
      ]);
    } finally {
      window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, listener);
    }
  });

  it('matches adjacent user-labeled 50 and 60 km/h traced road sections with rule metadata', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.replaceData({
      cells: {},
      corrections: [
        {
          id: 'posted-50-section',
          geohash: geohashEncode(43.6532, -79.3857, 6),
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-06-23T12:00:00.000Z',
          sectionPoints: [
            { lat: 43.6532, lng: -79.3860 },
            { lat: 43.6532, lng: -79.3852 },
          ],
        },
        {
          id: 'posted-60-section',
          geohash: geohashEncode(43.6532, -79.3827, 6),
          limitKmh: 60,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-06-23T12:01:00.000Z',
          sectionPoints: [
            { lat: 43.6532, lng: -79.3830 },
            { lat: 43.6532, lng: -79.3822 },
          ],
        },
      ],
    });

    const firstHalf = await knowledge.getForPoint(43.6532, -79.38555);
    const secondHalf = await knowledge.getForPoint(43.6532, -79.38255);
    const gap = await knowledge.getForPoint(43.6532, -79.3841);

    expect(firstHalf).toMatchObject({
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      correctionId: 'posted-50-section',
      matchType: 'traced_section',
      matchReason: 'matched_traced_section',
    });
    expect(secondHalf).toMatchObject({
      limitKmh: 60,
      source: 'user_confirmed_posted_sign',
      correctionId: 'posted-60-section',
      matchType: 'traced_section',
      matchReason: 'matched_traced_section',
    });
    expect(gap).toBeNull();
  });

  it('updates imported section-key corrections instead of duplicating them', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.replaceData({
      cells: {},
      corrections: [{
        sectionKey: 'imported-section-key',
        geohash: geohashEncode(43.6532, -79.3832, 6),
        lat: 43.6532,
        lng: -79.3832,
        limitKmh: 50,
        source: 'user_entered_estimate',
        appliedAt: '2026-06-23T12:00:00.000Z',
      }],
    });

    const updated = await knowledge.updateUserCorrection(
      'imported-section-key',
      50,
      'user_confirmed_posted_sign',
      'Confirmed posted sign'
    );
    const data = await knowledge.exportData();

    expect(updated).toBe(true);
    expect(data.corrections).toHaveLength(1);
    expect(data.corrections[0]).toMatchObject({
      id: 'imported-section-key',
      sectionKey: 'imported-section-key',
      source: 'user_confirmed_posted_sign',
      verificationStatus: 'confirmed_posted_sign',
    });
  });
});
