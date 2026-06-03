import { describe, expect, it } from 'vitest';
import { applyEventFeedbackToEvents, localTripRepository } from '@/lib/localTripRepository';
import { detectDrivingEvents, SCORING_VERSION } from '@/lib/tripEngine';

const feedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

const completedTrip = (routePoints, patch = {}) => ({
  id: `feedback_${Math.random().toString(36).slice(2)}`,
  status: 'completed',
  start_time: routePoints[0].timestamp,
  end_time: routePoints[routePoints.length - 1].timestamp,
  route_points: routePoints,
  needs_rescore: true,
  schema_version: 0,
  ...patch,
});

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

  it('counts a wrong detected event once during trip rescore', async () => {
    const routePoints = [
      { lat: 43.6500, lng: -79.3800, speed_kmh: 80, accuracy: 5, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6502, lng: -79.3800, speed_kmh: 80, accuracy: 5, timestamp: '2026-01-01T12:00:01.000Z' },
      { lat: 43.65028, lng: -79.3800, speed_kmh: 20, accuracy: 5, timestamp: '2026-01-01T12:00:02.000Z' },
      { lat: 43.65036, lng: -79.3800, speed_kmh: 20, accuracy: 5, timestamp: '2026-01-01T12:00:03.000Z' },
    ];
    const detection = detectDrivingEvents(routePoints);
    const reviewedEventIndex = detection.events.findIndex((event) => event.type !== 'phone_use');
    const reviewedEvent = detection.events[reviewedEventIndex];

    expect(reviewedEvent).toBeTruthy();

    const [rescored] = await localTripRepository.upsertMany([
      completedTrip(routePoints, {
        event_feedback: {
          [feedbackKey(reviewedEvent, reviewedEventIndex)]: { verdict: 'wrong' },
        },
      }),
    ]);

    expect(rescored.feedback_adjusted_events_count).toBe(1);
    expect(rescored.score_provenance).toMatchObject({
      scoring_version: SCORING_VERSION,
      components: expect.any(Object),
      constants_snapshot: expect.any(Object),
    });
    expect(rescored.score_provenance_change).toMatchObject({
      previous_scoring_version: null,
      current_scoring_version: SCORING_VERSION,
      reason: 'provenance_added',
    });
    expect(rescored.driving_events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        type: reviewedEvent.type,
        timestamp: reviewedEvent.timestamp,
      })])
    );
  });

  it('persists event feedback from the trip detail action and returns a rescored trip', async () => {
    const routePoints = [
      { lat: 43.6500, lng: -79.3800, speed_kmh: 80, accuracy: 5, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6502, lng: -79.3800, speed_kmh: 80, accuracy: 5, timestamp: '2026-01-01T12:00:01.000Z' },
      { lat: 43.65028, lng: -79.3800, speed_kmh: 20, accuracy: 5, timestamp: '2026-01-01T12:00:02.000Z' },
      { lat: 43.65036, lng: -79.3800, speed_kmh: 20, accuracy: 5, timestamp: '2026-01-01T12:00:03.000Z' },
    ];
    const detection = detectDrivingEvents(routePoints);
    const reviewedEventIndex = detection.events.findIndex((event) => event.type !== 'phone_use');
    const reviewedEvent = detection.events[reviewedEventIndex];
    const [saved] = await localTripRepository.upsertMany([completedTrip(routePoints)]);
    const eventKey = feedbackKey(reviewedEvent, reviewedEventIndex);

    const updated = await localTripRepository.markEventFeedback(saved.id, {
      eventKey,
      reviewedAt: '2026-01-01T12:05:00.000Z',
      record: {
        verdict: 'wrong',
        type: reviewedEvent.type,
        timestamp: reviewedEvent.timestamp,
        value: reviewedEvent.value,
      },
    });

    expect(updated.needs_rescore).toBe(false);
    expect(updated.event_feedback[eventKey]).toMatchObject({
      verdict: 'wrong',
      reviewed_at: '2026-01-01T12:05:00.000Z',
    });
    expect(updated.feedback_adjusted_events_count).toBe(1);
  });

  it('does not remove phone-use events added during the post-score merge', async () => {
    const routePoints = [
      { lat: 43.6500, lng: -79.3800, speed_kmh: 30, accuracy: 5, timestamp: '2026-01-01T12:00:00.000Z' },
      { lat: 43.6502, lng: -79.3800, speed_kmh: 30, accuracy: 5, timestamp: '2026-01-01T12:00:20.000Z' },
      { lat: 43.6504, lng: -79.3800, speed_kmh: 30, accuracy: 5, timestamp: '2026-01-01T12:00:40.000Z' },
    ];
    const phoneUseEvent = {
      type: 'phone_use',
      source: 'android_usage_access',
      timestamp: '2026-01-01T12:00:10.000Z',
      startTime: '2026-01-01T12:00:10.000Z',
      endTime: '2026-01-01T12:00:25.000Z',
      durationS: 15,
      duration_seconds: 15,
      confidence: 0.92,
      confidence_level: 'high',
      severity: 'medium',
      value: 0.92,
    };

    const [rescored] = await localTripRepository.upsertMany([
      completedTrip(routePoints, {
        phone_use_events: [phoneUseEvent],
        event_feedback: {
          [feedbackKey(phoneUseEvent, 0)]: { verdict: 'wrong' },
        },
      }),
    ]);

    expect(rescored.feedback_adjusted_events_count).toBe(0);
    expect(rescored.driving_events).toEqual(
      expect.arrayContaining([expect.objectContaining({
        type: 'phone_use',
        timestamp: phoneUseEvent.timestamp,
      })])
    );
  });
});
