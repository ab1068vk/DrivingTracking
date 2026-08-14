/**
 * Privacy masking nulls an event's coordinates in place rather than deleting the
 * event, and the drop-filter that should remove it lets a null-latitude record
 * through. The clustering then read `Number(null)` as 0 and every masked event
 * in the history piled up at (0, 0), where enough of them would have formed a
 * "repeated event area" made entirely of the driver's private trips.
 *
 * These tests pin both halves: the coercion must not happen, and the guard must
 * not overreach onto a coordinate that is legitimately zero.
 */
import { describe, expect, it } from 'vitest';
import { eventPosition, hasUsablePosition, isRedactedEvent } from '@/lib/dangerZone/eventPositions';

describe('eventPosition', () => {
  it('does not read a null coordinate as zero', () => {
    // Number(null) === 0 and Number.isFinite(0) === true, which is how masked
    // events reached Null Island.
    expect(eventPosition({ type: 'harsh_brake', lat: null, lng: null })).toBeNull();
    expect(eventPosition({ type: 'harsh_brake', lat: null, lng: -0.12 })).toBeNull();
    expect(eventPosition({ type: 'harsh_brake', lat: 51.5, lng: null })).toBeNull();
  });

  it('rejects the other values that coerce to zero', () => {
    expect(eventPosition({ lat: '', lng: '' })).toBeNull();
    expect(eventPosition({ lat: false, lng: false })).toBeNull();
    expect(eventPosition({ lat: undefined, lng: undefined })).toBeNull();
  });

  it('still accepts a genuine zero coordinate', () => {
    // The guard is against null coercion, not against the equator or the prime
    // meridian. Over-correcting here would silently drop real events.
    expect(eventPosition({ lat: 0, lng: 0 })).toEqual({ lat: 0, lng: 0 });
    expect(eventPosition({ lat: 0, lng: 12.5 })).toEqual({ lat: 0, lng: 12.5 });
  });

  it('rejects every privacy redaction flag', () => {
    for (const flag of [
      'masked_for_privacy',
      'privacy_event_redacted',
      'privacy_purged',
      'privacy_live_redacted',
      'privacy_gap',
      'privacy_boundary',
    ]) {
      // Coordinates present but flagged: the flag has to win, because some
      // paths mask the record without clearing every coordinate field.
      expect(eventPosition({ lat: 51.5, lng: -0.12, [flag]: true })).toBeNull();
    }
  });

  it('treats a falsy flag as not redacted', () => {
    expect(eventPosition({ lat: 51.5, lng: -0.12, masked_for_privacy: false }))
      .toEqual({ lat: 51.5, lng: -0.12 });
  });

  it('rejects values outside coordinate range', () => {
    expect(eventPosition({ lat: 91, lng: 0 })).toBeNull();
    expect(eventPosition({ lat: 0, lng: 181 })).toBeNull();
    expect(eventPosition({ lat: 'x', lng: 2 })).toBeNull();
  });

  it('parses numeric strings, which is how imported events arrive', () => {
    expect(eventPosition({ lat: '51.5', lng: '-0.12' })).toEqual({ lat: 51.5, lng: -0.12 });
  });

  it('handles a missing event without throwing', () => {
    expect(eventPosition(null)).toBeNull();
    expect(eventPosition(undefined)).toBeNull();
  });
});

describe('isRedactedEvent / hasUsablePosition', () => {
  it('reports redaction independently of coordinates', () => {
    expect(isRedactedEvent({ masked_for_privacy: true })).toBe(true);
    expect(isRedactedEvent({ lat: 51.5, lng: -0.12 })).toBe(false);
  });

  it('agrees with eventPosition', () => {
    expect(hasUsablePosition({ lat: 51.5, lng: -0.12 })).toBe(true);
    expect(hasUsablePosition({ lat: null, lng: null })).toBe(false);
  });
});
