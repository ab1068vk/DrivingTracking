import { describe, expect, it, vi } from 'vitest';
import {
  createNativeManualTripId,
  findNativeManualCompletion,
  isNativeManualCompletionForActiveTrip,
} from '@/lib/nativeManualTripIdentity';

describe('native manual trip identity', () => {
  const activeTrip = {
    id: 'manual_trip_shared',
    manual_session_id: 'manual_trip_shared',
    start_time: '2026-06-18T16:28:00.000Z',
    status: 'active',
    native_manual_background: true,
  };

  it('matches the native completion by the shared trip id', () => {
    expect(isNativeManualCompletionForActiveTrip({
      id: 'manual_trip_shared',
      start_source: 'native_manual',
      start_time: '2026-06-18T16:28:00.000Z',
      end_time: '2026-06-18T16:32:00.000Z',
    }, activeTrip)).toBe(true);
  });

  it('matches legacy manual trips by their overlapping start window', () => {
    expect(isNativeManualCompletionForActiveTrip({
      id: 'native_trip_legacy',
      start_source: 'native_manual',
      start_time: '2026-06-18T16:28:02.000Z',
      end_time: '2026-06-18T16:32:00.000Z',
    }, {
      ...activeTrip,
      id: null,
      manual_session_id: null,
    })).toBe(true);
  });

  it('does not match unrelated or native auto trips', () => {
    expect(findNativeManualCompletion([
      {
        id: 'native_auto_trip',
        start_source: 'native_auto',
        start_time: activeTrip.start_time,
        end_time: '2026-06-18T16:32:00.000Z',
      },
      {
        id: 'other_manual_trip',
        start_source: 'native_manual',
        start_time: '2026-06-18T18:28:00.000Z',
        end_time: '2026-06-18T18:32:00.000Z',
      },
    ], activeTrip)).toBeNull();
  });

  it('creates stable manual-trip id prefixes with unique suffixes', () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second');

    expect(createNativeManualTripId(123)).toBe('manual_trip_123_first');
    expect(createNativeManualTripId(123)).toBe('manual_trip_123_second');
    randomUuid.mockRestore();
  });
});
