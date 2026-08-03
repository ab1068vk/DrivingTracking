import { describe, expect, it } from 'vitest';
import { resolveParkedLocation } from '@/lib/parkedLocationResolver';

const point = (lat, lng, seconds, speed_kmh, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh,
  accuracy,
  timestamp: new Date(Date.UTC(2026, 6, 18, 18, 0, seconds)).toISOString(),
});

describe('parked location resolver', () => {
  it('uses the stable terminal cluster and avoids a noisy final GPS fix', () => {
    const points = [
      point(43.65, -79.38, 0, 35),
      point(43.651, -79.38, 10, 18),
      point(43.6512, -79.38, 20, 4, 7),
      point(43.65121, -79.38001, 35, 0, 6),
      point(43.65119, -79.38, 50, 0, 8),
      point(43.65155, -79.3803, 65, 0, 55),
    ];

    const result = resolveParkedLocation(points, { endTime: '2026-07-18T18:01:05.000Z' });

    expect(result.location.strategy).toBe('terminal_stop_cluster');
    expect(result.location.confidence).toBe('high');
    expect(result.location.lat).toBeCloseTo(43.6512, 4);
    expect(result.location.lat).not.toBe(points.at(-1).lat);
    expect(points).toContainEqual(expect.objectContaining({
      lat: result.location.lat,
      lng: result.location.lng,
    }));
  });

  it('returns an estimate when only the last trip point is usable', () => {
    const result = resolveParkedLocation([point(43.65, -79.38, 0, 20, 25)]);

    expect(result.location).toMatchObject({
      lat: 43.65,
      lng: -79.38,
      confidence: 'estimated',
      strategy: 'last_trip_point',
      sampleCount: 1,
    });
  });

  it('fails closed when the newest endpoint is privacy-redacted', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 30),
      { lat: null, lng: null, privacy_gap: true, masked_for_privacy: true },
    ]);

    expect(result).toEqual({ location: null, suppressionReason: 'privacy_zone' });
  });

  it('rejects null island instead of offering directions there', () => {
    const result = resolveParkedLocation([{ lat: 0, lng: 0, speed_kmh: 0 }]);

    expect(result.location).toBeNull();
    expect(result.suppressionReason).toBe('trip_end_unavailable');
  });

  it('does not offer directions from a stale trip endpoint', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 0, 8),
    ], { endTime: '2026-07-18T18:03:00.000Z' });

    expect(result).toEqual({
      location: null,
      suppressionReason: 'stale_trip_end',
    });
  });

  it('does not offer directions from a very inaccurate GPS fix', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 0, 120),
    ]);

    expect(result).toEqual({
      location: null,
      suppressionReason: 'low_accuracy_trip_end',
    });
  });

  it('raises confidence when activity, stop duration, and refined fixes agree', () => {
    const points = [
      point(43.65, -79.38, 0, 35),
      point(43.651, -79.38, 10, 18),
      { ...point(43.6512, -79.38, 20, 0, 7), parking_refinement: true },
      { ...point(43.65121, -79.38001, 35, 0, 6), parking_refinement: true },
      { ...point(43.65119, -79.38, 50, 0, 8), parking_refinement: true },
    ];

    const result = resolveParkedLocation(points, {
      endTime: '2026-07-18T18:00:50.000Z',
      parkingTimestamp: '2026-07-18T18:00:20.000Z',
      signals: {
        activity: { type: 'still', confidence: 90 },
        stoppedSeconds: 120,
        gpsDriftM: 4,
        lastMovingSpeedKmh: 35,
      },
    });

    expect(result.location).toMatchObject({
      confidence: 'high',
      strategy: 'post_stop_refinement',
      timestamp: '2026-07-18T18:00:20.000Z',
      refinementCount: 3,
    });
    expect(result.location.confidenceScore).toBeGreaterThanOrEqual(90);
    expect(result.location.evidence).toEqual(expect.arrayContaining([
      'activity_still',
      'sustained_stop',
      'post_stop_refinement',
      'vehicle_movement_before_stop',
    ]));
  });

  it('uses OBD ignition-off evidence when RPM drops after driving', () => {
    const points = [
      { ...point(43.65, -79.38, 0, 30), obd_rpm: 1800 },
      { ...point(43.651, -79.38, 10, 0), obd_rpm: 0 },
      { ...point(43.65101, -79.38, 30, 0), obd_rpm: 0 },
    ];

    const result = resolveParkedLocation(points, {
      endTime: '2026-07-18T18:00:30.000Z',
    });

    expect(result.location.evidence).toContain('obd_ignition_off');
  });

  it('does not replace parking for a strong drive-through creep signature', () => {
    const points = [
      point(43.65, -79.38, 0, 25),
      point(43.6502, -79.38, 10, 0.2),
      point(43.65021, -79.38, 20, 3),
      point(43.65022, -79.38, 30, 0),
      point(43.65023, -79.38, 40, 4),
      point(43.65024, -79.38, 50, 0),
      point(43.65025, -79.38, 60, 3),
      point(43.65026, -79.38, 70, 0),
    ];
    const result = resolveParkedLocation(points, {
      endTime: points.at(-1).timestamp,
      signals: {
        stoppedSeconds: 70,
        manualEnd: false,
        activity: { type: 'in_vehicle', confidence: 80 },
      },
    });
    expect(result.location).toBeNull();
    expect(result.ignoredReason).toBe('possible_drive_through');
    expect(result.suppressionReason).toBeNull();
  });

  it('allows a manually ended trip to override transient-stop protection', () => {
    const points = [
      point(43.65, -79.38, 0, 25),
      point(43.651, -79.38, 10, 0),
      point(43.65101, -79.38, 30, 0),
    ];
    const result = resolveParkedLocation(points, {
      endTime: points.at(-1).timestamp,
      signals: {
        stoppedSeconds: 30,
        manualEnd: true,
        activity: { type: 'in_vehicle', confidence: 90 },
      },
    });
    expect(result.location).not.toBeNull();
  });

  it('labels weak terminal garage GPS and retains the last reliable entrance', () => {
    const points = [
      point(43.65, -79.38, 0, 25, 8),
      point(43.6508, -79.38, 15, 10, 12),
      point(43.651, -79.38, 30, 0, 42),
      point(43.65102, -79.38002, 45, 0, 38),
      point(43.65101, -79.38001, 60, 0, 40),
    ];
    const result = resolveParkedLocation(points, {
      endTime: points.at(-1).timestamp,
      signals: {
        stoppedSeconds: 60,
        vehicleExitTransition: true,
      },
    });
    expect(result.location.indoorEstimated).toBe(true);
    expect(result.location.garageEntrance).toMatchObject({
      lat: 43.6508,
      lng: -79.38,
    });
    expect(result.location.evidence).toContain('activity_vehicle_exit_transition');
    expect(result.location.evidence).toContain('indoor_location_estimated');
  });

  it('uses local rejection feedback to preserve the prior car location for weak automatic stops', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 25, 8),
      point(43.6501, -79.38, 20, 0, 50),
    ], {
      endTime: '2026-07-18T18:00:20.000Z',
      signals: {
        activity: { type: 'still', confidence: 85 },
        stoppedSeconds: 70,
        stopReason: 'auto_stop',
        parkingLearningProfile: {
          feedback_count: 2,
          strictness_level: 2,
          short_stop_max_seconds: 65,
          in_vehicle_stop_max_seconds: 180,
          minimum_automatic_confidence: 60,
        },
      },
    });

    expect(result).toMatchObject({
      location: null,
      ignoredReason: 'learned_low_confidence_stop',
    });
  });

  it('does not let learned caution override strong vehicle-exit evidence', () => {
    const result = resolveParkedLocation([
      point(43.65, -79.38, 0, 25, 8),
      point(43.6501, -79.38, 20, 0, 50),
    ], {
      endTime: '2026-07-18T18:00:20.000Z',
      signals: {
        activity: { type: 'still', confidence: 85 },
        stoppedSeconds: 70,
        vehicleExitTransition: true,
        parkingLearningProfile: {
          feedback_count: 2,
          strictness_level: 2,
          minimum_automatic_confidence: 60,
        },
      },
    });

    expect(result.location).not.toBeNull();
    expect(result.location.evidence).toContain('personalized_parking_learning');
  });
});

