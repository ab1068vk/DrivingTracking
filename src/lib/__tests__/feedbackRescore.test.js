import { describe, expect, it } from 'vitest';
import { applyEventFeedbackToEvents } from '@/lib/localTripRepository';

describe('feedback-driven rescoring helpers', () => {
  it('removes fake wrong events while keeping accurate reviewed events', () => {
    const events = [
      { type: 'harsh_brake', timestamp: '2026-01-01T12:00:10.000Z', value: 5.12 },
      { type: 'sharp_turn', timestamp: '2026-01-01T12:00:20.000Z', value: 0.42 },
      { type: 'speeding', timestamp: '2026-01-01T12:00:30.000Z', value: 18 },
    ];
    const feedback = {
      'harsh_brake|2026-01-01T12:00:10.000Z|5.12': { verdict: 'wrong' },
      'sharp_turn|2026-01-01T12:00:20.000Z|0.42': { verdict: 'accurate' },
    };

    const result = applyEventFeedbackToEvents(events, feedback);

    expect(result.removed).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(['sharp_turn', 'speeding']);
  });
});
