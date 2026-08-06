import { describe, expect, it } from 'vitest';
import {
  GPS_ONLY_LANE_CHANGE_FALSE_POSITIVE_NOTE,
  UNAVAILABLE,
  buildGpsCoverage,
  buildSessionEvidenceRows,
  buildSessionForensics,
  countAvailableForensics,
} from '@/lib/trackingSessionForensics';

const findRow = (trip, id) => buildSessionForensics(trip)
  .flatMap((group) => group.rows)
  .find((row) => row.id === id);

const nativeAutoTrip = {
  id: 'trip-native',
  status: 'completed',
  start_time: '2026-01-01T08:00:00.000Z',
  end_time: '2026-01-01T08:30:00.000Z',
  start_source: 'native_auto',
  duration_seconds: 1800,
  wall_clock_duration_seconds: 1800,
  native_auto_start_reason: 'activity_in_vehicle_confirmed',
  native_auto_stop_reason: 'sustained_stop_detected',
  native_candidate_started_at: '2026-01-01T07:59:40.000Z',
  native_candidate_confirmed_at: '2026-01-01T08:00:00.000Z',
  native_candidate_near_parked: false,
  native_tail_trimmed_points: 7,
  parking_stop_detected: true,
  route_gap_count: 0,
  data_quality_flags: [],
  sensor_fusion_summary: {
    sample_count: 4200,
    peak_linear_ms2: 6.42,
    peak_rotation_deg_s: 88.3,
    harsh_motion_count: 12,
    impact_like_count: 0,
    phone_movement_score: 18,
    quality: 'good',
    phone_orientation: {
      calibrated: true,
      longitudinal_axis: 'ax',
      longitudinal_correlation: 0.81,
      sample_count: 6,
      confidence: 'high',
    },
  },
};

const manualTrip = {
  id: 'trip-manual',
  status: 'completed',
  start_time: '2026-01-02T08:00:00.000Z',
  end_time: '2026-01-02T08:20:00.000Z',
  start_source: 'manual',
  duration_seconds: 1200,
};

describe('buildGpsCoverage', () => {
  it('reports full coverage when recorded time matches elapsed time', () => {
    expect(buildGpsCoverage({ duration_seconds: 1800, wall_clock_duration_seconds: 1800 }))
      .toMatchObject({ percent: 100, missingSeconds: 0 });
  });

  it('reports the shortfall when GPS covered less than the elapsed drive', () => {
    const coverage = buildGpsCoverage({ duration_seconds: 900, wall_clock_duration_seconds: 1800 });
    expect(coverage.percent).toBe(50);
    expect(coverage.missingSeconds).toBe(900);
  });

  it('returns a null percent rather than guessing when wall-clock time is missing', () => {
    expect(buildGpsCoverage({ duration_seconds: 900 }).percent).toBeNull();
    expect(buildGpsCoverage({}).percent).toBeNull();
  });

  it('clamps rather than reporting over 100% when recorded time exceeds elapsed time', () => {
    expect(buildGpsCoverage({ duration_seconds: 2000, wall_clock_duration_seconds: 1800 }).percent).toBe(100);
  });
});

describe('buildSessionForensics', () => {
  it('names both the start and stop reason for a native auto trip', () => {
    expect(findRow(nativeAutoTrip, 'start-reason').value).toBe('Activity In Vehicle Confirmed');
    expect(findRow(nativeAutoTrip, 'stop-reason').value).toBe('Sustained Stop Detected');
  });

  it('reports candidate-to-confirmed latency and trimmed tail samples', () => {
    expect(findRow(nativeAutoTrip, 'start-confirm-latency').value).toBe('20s');
    expect(findRow(nativeAutoTrip, 'stop-tail-trimmed').value).toBe('7');
  });

  it('surfaces motion counts that previously had no UI anywhere', () => {
    expect(findRow(nativeAutoTrip, 'motion-peak-rotation').value).toBe('88.3°/s');
    expect(findRow(nativeAutoTrip, 'motion-harsh-count').value).toBe('12');
    expect(findRow(nativeAutoTrip, 'motion-impact-count').value).toBe('0');
  });

  it('degrades to "source unavailable" for a manual trip instead of crashing or inventing values', () => {
    expect(() => buildSessionForensics(manualTrip)).not.toThrow();
    expect(findRow(manualTrip, 'start-reason').value).toBe('Manual');
    expect(findRow(manualTrip, 'stop-reason').value).toBe(UNAVAILABLE);
    expect(findRow(manualTrip, 'motion-peak-rotation').value).toBe(UNAVAILABLE);
    expect(findRow(manualTrip, 'coverage-percent').value).toBe(UNAVAILABLE);
  });

  it('never throws on empty, null, or non-object input', () => {
    expect(buildSessionForensics(null)).toEqual([]);
    expect(buildSessionForensics('nope')).toEqual([]);
    expect(() => buildSessionForensics({})).not.toThrow();
    // An absent trip still renders the full shape, so the pane explains absence
    // instead of vanishing. Every row reads unavailable except the flags row,
    // which legitimately reports "None recorded".
    for (const trip of [undefined, {}]) {
      const groups = buildSessionForensics(trip);
      expect(groups.length).toBe(6);
      const available = groups.flatMap((group) => group.rows).filter((row) => row.value !== UNAVAILABLE);
      expect(available.map((row) => row.id)).toEqual(['coverage-flags']);
      expect(countAvailableForensics(groups)).toBe(1);
    }
  });

  it('flags a coverage shortfall as a warning', () => {
    const row = findRow({ ...nativeAutoTrip, duration_seconds: 900 }, 'coverage-percent');
    expect(row.value).toBe('50%');
    expect(row.tone).toBe('warn');
    expect(row.detail).toContain('no recorded GPS');
  });

  it('states the lane-change consequence when phone orientation calibration failed', () => {
    const uncalibrated = {
      ...nativeAutoTrip,
      lane_change_count: 9,
      sensor_fusion_summary: {
        ...nativeAutoTrip.sensor_fusion_summary,
        phone_orientation: { calibrated: false, reason: 'insufficient_harsh_brake_axis_samples', sample_count: 1 },
      },
    };
    const consequence = findRow(uncalibrated, 'calibration-consequence');
    expect(consequence).toBeDefined();
    expect(consequence.value).toBe('9 detected via GPS-only fallback');
    expect(consequence.detail).toBe(GPS_ONLY_LANE_CHANGE_FALSE_POSITIVE_NOTE);
    expect(consequence.tone).toBe('warn');
  });

  it('omits the consequence row when calibration succeeded', () => {
    expect(findRow(nativeAutoTrip, 'calibration-consequence')).toBeUndefined();
    expect(findRow(nativeAutoTrip, 'calibration-state').value).toBe('Yes');
  });

  it('separates deliberate unlocks from an already-woken screen', () => {
    const trip = {
      ...nativeAutoTrip,
      native_phone_usage_access_granted: true,
      native_phone_usage_events: [
        { started_after_unlock: true, started_after_screen_on: true },
        { started_after_unlock: false, started_after_screen_on: true },
        { started_after_unlock: false, started_after_screen_on: true },
      ],
    };
    expect(findRow(trip, 'phone-after-unlock').value).toBe('1');
    expect(findRow(trip, 'phone-after-screen-on').value).toBe('2');
  });

  it('keeps the GPS proxy labelled as diagnostic rather than confirmed phone use', () => {
    const row = findRow({ ...nativeAutoTrip, native_phone_proxy_count: 4 }, 'phone-gps-proxy');
    expect(row.value).toBe('4');
    expect(row.detail).toContain('not counted as confirmed phone use');
  });

  it('explains any stretch where the low-power guard reduced capture', () => {
    const row = findRow(
      { ...nativeAutoTrip, capture_tier_seconds: { normal: 1400, battery_guard: 360 } },
      'capture-tier'
    );
    expect(row.value).toBe('6m reduced');
    expect(row.tone).toBe('warn');
    expect(row.detail).toContain('battery was at or below 15%');
    expect(row.detail).toContain('lower resolution, not missing data');
  });

  it('confirms a full-rate drive when the guard never engaged', () => {
    const row = findRow({ ...nativeAutoTrip, capture_tier_seconds: { normal: 1800 } }, 'capture-tier');
    expect(row.value).toBe('Never engaged');
    expect(row.tone).toBe('good');
  });

  it('leaves the capture-guard row unavailable on trips recorded before it existed', () => {
    expect(findRow(nativeAutoTrip, 'capture-tier').value).toBe(UNAVAILABLE);
  });

  it('states how much motion resolution retention traded away on a long drive', () => {
    const row = findRow({ ...nativeAutoTrip, native_motion_samples_dropped: 800 }, 'motion-retention');
    expect(row.value).toBe('800 of 5000 thinned');
    expect(row.tone).toBe('warn');
    expect(row.detail).toContain('spans the whole drive');
  });

  it('confirms full-rate motion capture when nothing was thinned', () => {
    const row = findRow({ ...nativeAutoTrip, native_motion_samples_dropped: 0 }, 'motion-retention');
    expect(row.value).toBe('Full rate kept');
    expect(row.tone).toBe('good');
  });

  it('leaves the retention row unavailable on trips recorded before it existed', () => {
    expect(findRow(nativeAutoTrip, 'motion-retention').value).toBe(UNAVAILABLE);
  });

  it('counts only the rows that actually carry evidence', () => {
    expect(countAvailableForensics(buildSessionForensics(nativeAutoTrip)))
      .toBeGreaterThan(countAvailableForensics(buildSessionForensics(manualTrip)));
  });
});

describe('buildSessionEvidenceRows', () => {
  it('flattens into the evidence-console row shape', () => {
    const rows = buildSessionEvidenceRows(nativeAutoTrip);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('label');
      expect(row).toHaveProperty('value');
      expect(row).toHaveProperty('confidence');
      expect(row.dataSourceLabel).toBe('recording session');
    }
  });

  it('marks missing evidence as unavailable rather than recorded', () => {
    const rows = buildSessionEvidenceRows(manualTrip);
    const stopReason = rows.find((row) => row.id === 'stop-reason');
    expect(stopReason.confidence).toBe('unavailable');
  });

  it('returns rows without coordinates so exports stay coordinate-free', () => {
    const serialized = JSON.stringify(buildSessionEvidenceRows(nativeAutoTrip));
    expect(serialized).not.toMatch(/"lat"|"lng"|"latitude"|"longitude"/);
  });
});
