import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEST_WINDOW_MIN_TRIPS,
  PERSONAL_BASELINE_INTERVAL_INSUFFICIENT_NOTE,
  PERSONAL_BASELINE_INTERVAL_METHOD,
  PERSONAL_BASELINE_MIXED_PROVENANCE_NOTE,
  PERSONAL_PERCENTILE_MIN_WEEKS,
  buildDrivingCoachInsights,
  computePersonalBaseline,
} from '@/lib/tripInsights';
import { SCORING_VERSION } from '@/lib/scoringConstants';

const trip = (startTime, score = 80, overrides = {}) => ({
  id: `trip-${startTime}`,
  status: 'completed',
  start_time: startTime,
  distance_km: 10,
  duration_seconds: 1800,
  score_overall: score,
  score_provenance: { scoring_version: SCORING_VERSION },
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  ...overrides,
});

describe('trip insight evidence gates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withholds personal percentile until enough recorded weeks exist', () => {
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));

    const oneWeek = computePersonalBaseline([
      trip('2026-05-24T08:00:00.000Z', 88),
      trip('2026-05-23T08:00:00.000Z', 84),
    ]);
    const fourWeeks = computePersonalBaseline([
      trip('2026-05-24T08:00:00.000Z', 88),
      trip('2026-05-17T08:00:00.000Z', 84),
      trip('2026-05-10T08:00:00.000Z', 78),
      trip('2026-05-03T08:00:00.000Z', 72),
    ]);

    expect(PERSONAL_PERCENTILE_MIN_WEEKS).toBe(4);
    expect(oneWeek.percentile).toBeNull();
    expect(oneWeek.percentile_label).toBe('Percentile among your recorded weeks');
    expect(fourWeeks.weeks_analyzed).toBeGreaterThanOrEqual(PERSONAL_PERCENTILE_MIN_WEEKS);
    expect(fourWeeks.percentile).not.toBeNull();
  });

  it('uses a bounded percentile interval for personal baseline scores', () => {
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));

    const scores = [75, 80, 82, 84, 86, 88, 90, 92, 95, 100];
    const baseline = computePersonalBaseline(scores.map((score, index) => (
      trip(`2026-05-${String(24 - index).padStart(2, '0')}T08:00:00.000Z`, score)
    )));
    const sparse = computePersonalBaseline(scores.slice(0, 9).map((score, index) => (
      trip(`2026-05-${String(24 - index).padStart(2, '0')}T08:00:00.000Z`, score)
    )));

    expect(baseline.baseline_confidence_interval).toEqual({ lower: 75, upper: 100 });
    expect(baseline.baseline_confidence_interval_label).toBe('75-100');
    expect(baseline.baseline_confidence_interval_method).toBe(PERSONAL_BASELINE_INTERVAL_METHOD);
    expect(sparse.baseline_confidence_interval).toBeNull();
    expect(sparse.baseline_confidence_interval_note).toBe(PERSONAL_BASELINE_INTERVAL_INSUFFICIENT_NOTE);
  });

  it('prefers current scoring provenance and labels mixed fallback baselines', () => {
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));

    const currentTrips = Array.from({ length: 10 }, (_, index) => (
      trip(`2026-05-${String(24 - index).padStart(2, '0')}T08:00:00.000Z`, 80 + index)
    ));
    const legacyTrips = Array.from({ length: 10 }, (_, index) => (
      trip(`2026-05-${String(14 - index).padStart(2, '0')}T08:00:00.000Z`, 20, {
        score_provenance: { scoring_version: '2.0.0' },
      })
    ));
    const filtered = computePersonalBaseline([...currentTrips, ...legacyTrips]);

    expect(filtered.baseline_score_version).toBe(SCORING_VERSION);
    expect(filtered.baseline_trip_count).toBe(10);
    expect(filtered.baseline_avg).toBeGreaterThan(80);
    expect(filtered.baseline_includes_older_scores).toBe(false);

    const mixed = computePersonalBaseline([
      ...currentTrips.slice(0, 4),
      ...legacyTrips,
    ]);

    expect(mixed.baseline_score_version).toBe('mixed');
    expect(mixed.baseline_includes_older_scores).toBe(true);
    expect(mixed.baseline_label).toBe(PERSONAL_BASELINE_MIXED_PROVENANCE_NOTE);
    expect(mixed.baseline_confidence_interval).toBeNull();
    expect(mixed.baseline_confidence_interval_note).toBe(PERSONAL_BASELINE_MIXED_PROVENANCE_NOTE);
  });

  it('requires minimum trips before selecting a best driving window', () => {
    const sparse = buildDrivingCoachInsights([
      trip('2026-05-24T08:00:00.000Z', 95),
      trip('2026-05-24T18:00:00.000Z', 70),
    ]);
    const sampled = buildDrivingCoachInsights([
      trip('2026-05-24T08:00:00.000', 95),
      trip('2026-05-23T08:00:00.000', 96),
      trip('2026-05-22T18:00:00.000', 82),
      trip('2026-05-21T18:00:00.000', 83),
      trip('2026-05-20T18:00:00.000', 84),
    ]);

    expect(BEST_WINDOW_MIN_TRIPS).toBe(3);
    expect(sparse.best_window).toBeNull();
    expect(sampled.best_window).toMatchObject({
      label: 'Evening',
      trips: 3,
    });
    expect(sampled.actions.some((action) => action.includes('(3 trips)'))).toBe(true);
  });

  it('builds a structured coach brief with drill, target, and risk patterns', () => {
    const insights = buildDrivingCoachInsights([
      trip('2026-05-24T08:00:00.000Z', 78, { harsh_brakes_count: 3, distance_km: 20 }),
      trip('2026-05-23T08:00:00.000Z', 82, { harsh_brakes_count: 2, distance_km: 20 }),
      trip('2026-05-22T08:00:00.000Z', 86, { rapid_accel_count: 1, distance_km: 20 }),
    ]);

    expect(insights.coach_brief).toMatchObject({
      title: 'Late braking',
      drill: {
        title: 'Five-stop anticipation drill',
      },
      target: {
        metric: 'Late braking count',
      },
    });
    expect(insights.coach_brief.evidence).toEqual(expect.arrayContaining([
      '3 completed trips',
      '60 km analyzed',
    ]));
    expect(insights.risk_patterns[0]).toMatchObject({
      key: 'harsh_brakes',
      label: 'Late braking',
      count: 5,
    });
  });
});
