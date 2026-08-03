import { describe, expect, it, vi } from 'vitest';
import { collectParkingRefinementFixes } from '@/lib/trackingService';

const point = (lat, lng, speed_kmh = 0, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh,
  accuracy,
  timestamp: '2026-07-29T12:00:00.000Z',
});

const fakeClock = () => {
  let value = 0;
  return {
    now: () => value,
    wait: async (ms) => {
      value += ms;
    },
  };
};

describe('parking refinement fixes', () => {
  it('collects a bounded stable post-stop cluster without changing the trip route', async () => {
    const clock = fakeClock();
    const getPosition = vi.fn()
      .mockResolvedValueOnce(point(43.65000, -79.38000))
      .mockResolvedValueOnce(point(43.65001, -79.38000))
      .mockResolvedValueOnce(point(43.65000, -79.38001))
      .mockResolvedValueOnce(point(43.65001, -79.38001))
      .mockResolvedValueOnce(point(43.65000, -79.38000))
      .mockResolvedValueOnce(point(43.65001, -79.38000));

    const result = await collectParkingRefinementFixes({
      anchorPoint: point(43.65, -79.38),
      getPosition,
      wait: clock.wait,
      now: clock.now,
    });

    expect(result.status).toBe('completed');
    expect(result.fixes).toHaveLength(6);
    expect(result.fixes.every((fix) => fix.parking_refinement === true)).toBe(true);
    expect(getPosition).toHaveBeenCalledTimes(6);
  });

  it('cancels refinement when the vehicle starts moving again', async () => {
    const clock = fakeClock();

    const result = await collectParkingRefinementFixes({
      anchorPoint: point(43.65, -79.38),
      getPosition: vi.fn(async () => point(43.65, -79.38, 12)),
      wait: clock.wait,
      now: clock.now,
    });

    expect(result).toMatchObject({
      status: 'cancelled_movement',
      fixes: [],
    });
  });

  it('cancels refinement when fixes drift away from the parked-car area', async () => {
    const clock = fakeClock();

    const result = await collectParkingRefinementFixes({
      anchorPoint: point(43.65, -79.38),
      getPosition: vi.fn(async () => point(43.651, -79.38, 0, 8)),
      wait: clock.wait,
      now: clock.now,
    });

    expect(result).toMatchObject({
      status: 'cancelled_drift',
      fixes: [],
    });
  });
});
