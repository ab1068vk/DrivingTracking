import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tripService } from '@/api/trips';
import {
  consumeStealthNextTrip,
  endEphemeralTrip,
  getEphemeralTripModeState,
  isEphemeralModeActive,
  setStealthNextTrip,
  wipeTripObject,
} from '@/lib/ephemeralTripMode';
import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';
import { activeTripStore, saveLastMapCenter, saveLastParkedLocation } from '@/lib/trackingStore';

describe('ephemeral trip mode', () => {
  beforeEach(() => {
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
      key: (index) => Array.from(values.keys())[index] || null,
      get length() {
        return values.size;
      },
    };
  });

  afterEach(async () => {
    await endEphemeralTrip({ current: null });
    localStorage.clear();
    delete globalThis.localStorage;
  });

  it('consumes the armed next-trip flag and clears persisted active-trip artifacts', async () => {
    localStorage.setItem('road_sage_active_trip', JSON.stringify({ id: 'persisted', route_points: [{ lat: 43.651234, lng: -79.381234 }] }));
    localStorage.setItem('drivesense_active_trip', JSON.stringify({ id: 'legacy' }));
    localStorage.setItem('road_sage_tracking_diagnostics', JSON.stringify([{ type: 'auto_start' }]));

    expect(setStealthNextTrip(true)).toBe(true);
    expect(await consumeStealthNextTrip()).toBe(true);

    expect(getEphemeralTripModeState()).toEqual({ stealthNextTrip: false, ephemeralActive: true });
    expect(localStorage.getItem('road_sage_active_trip')).toBeNull();
    expect(localStorage.getItem('drivesense_active_trip')).toBeNull();
    expect(localStorage.getItem('road_sage_tracking_diagnostics')).toBeNull();
  });

  it('blocks active trip, map center, parked location, diagnostics, and trip service writes while active', async () => {
    setStealthNextTrip(true);
    await consumeStealthNextTrip();

    activeTripStore.set({ id: 'active', route_points: [{ lat: 43.651234, lng: -79.381234 }] });
    activeTripStore.addPoint({ lat: 43.651999, lng: -79.381999 });
    expect(activeTripStore.get()).toBeNull();

    await saveLastMapCenter({ lat: 43.65, lng: -79.38, source: 'trip_playback' });
    await saveLastParkedLocation({ lat: 43.65, lng: -79.38, address: 'Sensitive address' });
    expect(localStorage.getItem('road_sage_settings')).toBeNull();
    expect(localStorage.getItem('road_sage_last_parked')).toBeNull();

    expect(recordTrackingDiagnostic({ type: 'trip_started' })).toBeNull();
    expect(localStorage.getItem('road_sage_tracking_diagnostics')).toBeNull();

    const saved = await tripService.create({
      start_time: '2026-06-01T12:00:00.000Z',
      status: 'completed',
      route_points: [{ lat: 43.651234, lng: -79.381234 }],
    });
    expect(saved).toMatchObject({ ephemeral_trip: true });
    expect(saved.id).toMatch(/^ephemeral_/);
  });

  it('zeros coordinate-bearing arrays before releasing an ephemeral trip reference', async () => {
    const routePoint = { lat: 43.651234, lng: -79.381234, alt: 104, altitude: 105 };
    const rawPoint = { lat: 43.651999, lng: -79.381999, alt: 106 };
    const event = { type: 'hard_brake', lat: 43.652, lng: -79.382 };
    const tripRef = {
      current: {
        route_points: [routePoint],
        raw_route_points: [rawPoint],
        driving_events: [event],
      },
    };

    wipeTripObject(tripRef.current);
    expect(routePoint).toMatchObject({ lat: 0, lng: 0, alt: 0, altitude: 0 });
    expect(rawPoint).toMatchObject({ lat: 0, lng: 0, alt: 0 });
    expect(event).toMatchObject({ lat: 0, lng: 0 });
    expect(tripRef.current.route_points).toEqual([]);
    expect(tripRef.current.raw_route_points).toEqual([]);
    expect(tripRef.current.driving_events).toEqual([]);

    setStealthNextTrip(true);
    await consumeStealthNextTrip();
    await endEphemeralTrip(tripRef);
    expect(isEphemeralModeActive()).toBe(false);
    expect(tripRef.current).toBeNull();
  });
});
