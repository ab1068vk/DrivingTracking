import { describe, expect, it } from 'vitest';
import {
  getConfirmedPhoneUseCount,
  getPremiumTripEventCount,
  getPremiumTripScoreDelta,
  getPremiumTripScorePresentation,
  getPremiumTripSceneVariant,
  getPremiumTripTimePresentation,
} from '@/lib/premiumTripPresentation';

describe('premium trip presentation', () => {
  it.each([
    [5, 'dawn', 'Morning Drive'],
    [8, 'dawn', 'Morning Drive'],
    [9, 'day', 'Day Drive'],
    [16, 'day', 'Day Drive'],
    [17, 'dusk', 'Evening Drive'],
    [20, 'dusk', 'Evening Drive'],
    [21, 'night', 'Night Drive'],
    [4, 'night', 'Night Drive'],
  ])('maps local hour %i to the %s artwork', (hour, period, label) => {
    const date = new Date(2026, 6, 18, hour, 30);
    expect(getPremiumTripTimePresentation(date)).toMatchObject({ period, label });
  });

  it('uses a stable daytime fallback for an invalid timestamp', () => {
    expect(getPremiumTripTimePresentation('not-a-date')).toMatchObject({ period: 'day', hour: 12 });
  });

  it.each([
    [100, 'excellent', 360],
    [85, 'excellent', 306],
    [84, 'good', 302.4],
    [70, 'good', 252],
    [55, 'fair', 198],
    [40, 'poor', 144],
    [0, 'risky', 0],
    [-8, 'risky', 0],
  ])('maps score %i to a responsive %s ring', (score, tone, degrees) => {
    expect(getPremiumTripScorePresentation(score)).toMatchObject({ tone, degrees });
  });

  it('returns an unavailable gauge for missing scores', () => {
    expect(getPremiumTripScorePresentation(null)).toMatchObject({
      degrees: 0,
      normalizedScore: null,
      tone: 'unavailable',
    });
  });

  it.each([
    ['dusk', 'excellent', 'dusk'],
    ['dusk', 'good', 'dusk'],
    ['dusk', 'fair', 'dusk-caution'],
    ['dusk', 'poor', 'dusk-risk'],
    ['dusk', 'risky', 'dusk-risk'],
    ['night', 'fair', 'night'],
    ['day', 'risky', 'day'],
  ])('selects %s/%s artwork as %s', (period, tone, scene) => {
    expect(getPremiumTripSceneVariant(period, tone)).toBe(scene);
  });

  it('uses the red dusk city scene for a fair-scoring trip with dense safety events', () => {
    expect(getPremiumTripSceneVariant('dusk', 'fair', {
      eventCount: 4,
      distanceKm: 1.9,
    })).toBe('dusk-risk');

    expect(getPremiumTripSceneVariant('dusk', 'fair', {
      eventCount: 3,
      distanceKm: 3.2,
    })).toBe('dusk-caution');
  });

  it('counts only confirmed phone-use evidence in the event total', () => {
    const trip = {
      harsh_brakes_count: 1,
      sharp_turns_count: 2,
      phone_use_score_available: true,
      phone_use_window_count: 1,
      phone_use_events: [
        { type: 'phone_use', source: 'android_usage_access' },
        { type: 'phone_use', source: 'gps_proxy', diagnostic_only: true },
      ],
    };

    expect(getConfirmedPhoneUseCount(trip)).toBe(1);
    expect(getPremiumTripEventCount(trip)).toBe(4);
  });

  it('compares a trip with the previous scored trips in chronological order', () => {
    const trips = [
      { id: 'old-3', start_time: '2026-07-10T12:00:00Z', score_overall: 70 },
      { id: 'current', start_time: '2026-07-14T12:00:00Z', score_overall: 88 },
      { id: 'old-1', start_time: '2026-07-13T12:00:00Z', score_overall: 78 },
      { id: 'old-2', start_time: '2026-07-12T12:00:00Z', score_overall: 74 },
    ];

    expect(getPremiumTripScoreDelta(trips[1], trips)).toMatchObject({
      direction: 'up',
      insufficientBaseline: false,
      sampleCount: 3,
      delta: 14,
    });
  });

  it('reports when fewer than three prior scored trips exist', () => {
    const trips = [
      { id: 'current', start_time: '2026-07-14T12:00:00Z', score_overall: 88 },
      { id: 'old', start_time: '2026-07-13T12:00:00Z', score_overall: 78 },
    ];

    expect(getPremiumTripScoreDelta(trips[0], trips)).toMatchObject({
      insufficientBaseline: true,
      sampleCount: 1,
    });
  });
});
