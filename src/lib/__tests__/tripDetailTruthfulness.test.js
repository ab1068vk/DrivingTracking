import { describe, expect, it } from 'vitest';

import {
  applyEventFeedbackToEvents,
  eventFeedbackKey,
  reconcileEventFeedbackKeys,
} from '@/lib/eventFeedbackKeys';
import {
  formatConfidence,
  formatEventValue,
  formatMeasured,
  NOT_MEASURED,
} from '@/lib/measurementDisplay';
import {
  CALIBRATION_KM_TARGET,
  CALIBRATION_MILESTONE_IDS,
  CALIBRATION_TRIPS_TARGET,
  evaluateCalibrationMilestones,
  summarizeCalibrationProgress,
} from '@/lib/calibrationMilestones';
import { buildRouteRiskIndex } from '@/lib/routeRiskIndex';
import { inferTripTags } from '@/lib/tripTagIntelligence';
import { maskTripForPrivacy } from '@/lib/privacyZones';

describe('event feedback keys', () => {
  it('keeps an event the driver flagged as a detection note only', () => {
    const events = [{ type: 'heading_deviation', timestamp: 't1', value: 4 }];
    const feedback = {
      [eventFeedbackKey(events[0], 0)]: { verdict: 'wrong', affects_score: false, type: 'heading_deviation', timestamp: 't1' },
    };

    const result = applyEventFeedbackToEvents(events, feedback);

    // The UI promises a detection note does not change the score, so it must
    // not silently delete the event at the next rescore either.
    expect(result.events).toHaveLength(1);
    expect(result.removed).toBe(0);
    expect(result.flagged).toBe(1);
  });

  it('removes a score-affecting wrong verdict', () => {
    const events = [{ type: 'harsh_brake', timestamp: 't1', value: 4.2 }];
    const feedback = {
      [eventFeedbackKey(events[0], 0)]: { verdict: 'wrong', affects_score: true },
    };

    expect(applyEventFeedbackToEvents(events, feedback).removed).toBe(1);
  });

  it('follows an event whose magnitude changed instead of orphaning the verdict', () => {
    const before = { type: 'speeding', timestamp: 't1', value: 68 };
    const after = { type: 'speeding', timestamp: 't1', value: 74 };
    const feedback = {
      [eventFeedbackKey(before, 0)]: { verdict: 'wrong', type: 'speeding', timestamp: 't1', value: 68 },
    };

    const reconciled = reconcileEventFeedbackKeys(feedback, [after]);

    expect(reconciled.remapped).toBe(1);
    expect(reconciled.pruned).toBe(0);
    expect(applyEventFeedbackToEvents([after], reconciled.feedback).removed).toBe(1);
  });

  it('drops a verdict whose event no longer exists at all', () => {
    const gone = { type: 'harsh_brake', timestamp: 't9', value: 5 };
    const feedback = {
      [eventFeedbackKey(gone, 0)]: { verdict: 'wrong', type: 'harsh_brake', timestamp: 't9', value: 5 },
    };

    const reconciled = reconcileEventFeedbackKeys(feedback, [
      { type: 'harsh_brake', timestamp: 't1', value: 5 },
    ]);

    expect(reconciled.pruned).toBe(1);
    expect(Object.keys(reconciled.feedback)).toHaveLength(0);
  });
});

describe('measurement display', () => {
  it('uses the unit each event type actually stores', () => {
    // sharp_turn.value is lateral g; everything used to be suffixed m/s2.
    expect(formatEventValue({ type: 'sharp_turn', value: 0.42 })).toBe('0.42 g');
    expect(formatEventValue({ type: 'harsh_brake', value: 4.25 })).toBe('4.3 m/s²');
    expect(formatEventValue({ type: 'heading_deviation', value: 12.4 })).toBe('12.4 °/s');
    expect(formatEventValue({ type: 'idle', value: 95 })).toBe('1m 35s');
    expect(formatEventValue({ type: 'speeding', value: 68 })).toBe('68 km/h');
    expect(formatEventValue({ type: 'speeding', value: 100 }, 'imperial')).toBe('62 mph');
    expect(formatEventValue({ type: 'near_miss', value: 3 })).toBeNull();
    expect(formatEventValue({ type: 'harsh_brake', value: null })).toBeNull();
  });

  it('never invents a confidence word', () => {
    expect(formatConfidence(0.92)).toBe('high');
    expect(formatConfidence(0.4)).toBe('low');
    expect(formatConfidence('medium')).toBe('medium');
    expect(formatConfidence(null)).toBeNull();
    expect(formatConfidence(undefined)).toBeNull();
    expect(formatConfidence('')).toBeNull();
  });

  it('separates a measured zero from a missing reading', () => {
    expect(formatMeasured(0, (value) => `${value}%`)).toBe('0%');
    expect(formatMeasured(null, (value) => `${value}%`)).toBe(NOT_MEASURED);
    expect(formatMeasured(NaN, (value) => `${value}%`)).toBe(NOT_MEASURED);
  });
});

describe('route risk index', () => {
  it('counts one trip through one area as a single pass', () => {
    // Many consecutive samples inside one ~110 m cell used to each increment
    // tripCount, producing "you have driven here 12 times" after one drive.
    const routePoints = Array.from({ length: 12 }, (_, index) => ({
      lat: 43.6532 + index * 0.00002,
      lng: -79.3832,
      speed_kmh: 30,
      accuracy: 5,
      timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
    }));

    const index = buildRouteRiskIndex([
      { id: 'trip-1', status: 'completed', route_points: routePoints, driving_events: [] },
    ], []);

    expect(index.size).toBeGreaterThan(0);
    for (const item of index.values()) {
      expect(item.tripCount).toBe(1);
    }
  });
});

describe('trip tag intelligence', () => {
  it('makes no time-based claim about a trip with no recorded start time', () => {
    const suggestions = inferTripTags({ id: 't1', status: 'completed', distance_km: 12 }, []);
    const tags = [
      ...(suggestions.recommended_tags || []),
      ...(suggestions.candidates || []).map((candidate) => candidate.tag),
    ];

    // Falling back to Date.now() tagged such a trip from whenever the page was
    // open, which is a fabricated fact about the drive.
    expect(tags).not.toContain('night');
    expect(tags).not.toContain('commute');
  });

  it('defers to the recorded solar classification rather than the clock window', () => {
    const suggestions = inferTripTags({
      id: 't2',
      status: 'completed',
      distance_km: 12,
      // 22:30 local, inside the fixed night-risk window, but recorded as day.
      start_time: new Date(2026, 5, 1, 22, 30).toISOString(),
      night_driving: false,
      night_classification: { method: 'sunset', is_night: false },
    }, []);
    const tags = (suggestions.candidates || []).map((candidate) => candidate.tag);

    expect(tags).not.toContain('night');
  });
});

describe('calibration milestones', () => {
  it('reports each milestone once and only when actually reached', () => {
    const early = summarizeCalibrationProgress([
      { status: 'completed', distance_km: 5 },
    ]);
    expect(evaluateCalibrationMilestones(early)).toEqual([]);

    const ready = summarizeCalibrationProgress(
      Array.from({ length: CALIBRATION_TRIPS_TARGET }, () => ({ status: 'completed', distance_km: 1 }))
    );
    const ids = evaluateCalibrationMilestones(ready).map((item) => item.id);

    expect(ids).toContain(CALIBRATION_MILESTONE_IDS.TRIPS_READY);
    // Halfway is superseded once the real target is met, so it is not emitted.
    expect(ids).not.toContain(CALIBRATION_MILESTONE_IDS.HALFWAY);
    // Stable ids let the caller's dedupe store deliver each exactly once.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('counts distance progress toward calibration, not only trip count', () => {
    const progress = summarizeCalibrationProgress([
      { status: 'completed', distance_km: CALIBRATION_KM_TARGET },
    ]);

    expect(progress.kmNeeded).toBe(0);
    expect(evaluateCalibrationMilestones(progress).map((item) => item.id))
      .toContain(CALIBRATION_MILESTONE_IDS.DISTANCE_READY);
  });

  it('ignores trips that were never completed', () => {
    const progress = summarizeCalibrationProgress([
      { status: 'recording', distance_km: 500 },
    ]);

    expect(progress.tripsAnalyzed).toBe(0);
    expect(progress.kmAnalyzed).toBe(0);
  });
});

describe('privacy export masking', () => {
  it('masks event feedback for an event that was itself masked', () => {
    const settings = {
      privacy_zones: [{ id: 'home', lat: 43.6532, lng: -79.3832, radius_m: 200, name: 'Home' }],
    };
    const inZoneEvent = { type: 'harsh_brake', timestamp: 't1', value: 5.1, lat: 43.6532, lng: -79.3832 };
    const trip = {
      id: 'trip-1',
      status: 'completed',
      route_points: [],
      driving_events: [inZoneEvent],
      event_feedback: {
        [eventFeedbackKey(inZoneEvent, 0)]: {
          verdict: 'wrong',
          type: 'harsh_brake',
          timestamp: 't1',
          value: 5.1,
        },
      },
    };

    const masked = maskTripForPrivacy(trip, settings);

    // Feedback entries repeat the event's exact timestamp and magnitude, so
    // leaving them behind defeated the point of masking the event.
    expect(masked.driving_events).toHaveLength(0);
    expect(Object.keys(masked.event_feedback)).toHaveLength(0);
  });
});
