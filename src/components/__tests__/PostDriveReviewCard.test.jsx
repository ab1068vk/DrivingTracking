import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PostDriveReviewCard, {
  buildPostDriveReviewViewModel,
} from '@/components/PostDriveReviewCard';

const completedTrip = {
  id: 'trip-new',
  status: 'completed',
  start_time: '2026-07-29T12:00:00.000Z',
  end_time: '2026-07-29T12:24:00.000Z',
  duration_seconds: 1440,
  distance_km: 18.4,
  score_overall: 88,
  score_confidence_label: 'high',
  score_safety: 92,
  score_safety_confidence: 'high',
  score_smoothness: 84,
  score_smoothness_confidence: 'high',
  score_eco: 87,
  score_eco_confidence: 'high',
  harsh_brakes_count: 1,
  route_points_map_count: 38,
};

describe('PostDriveReviewCard', () => {
  it('turns a completed trip into an immediate result, win, and next-drive focus', () => {
    const model = buildPostDriveReviewViewModel(completedTrip, [
      { id: 'older-1', score_overall: 80, score_confidence_label: 'high' },
      { id: 'older-2', score_overall: 82, score_confidence_label: 'high' },
    ]);

    expect(model.delta).toBe(7);
    expect(model.strongest.label).toBe('Safety stood out');
    expect(model.opportunity.label).toBe('Earlier braking');
    expect(model.title).toBe('You moved in the right direction');
  });

  it('keeps advanced tracking neutral while exposing retained evidence', () => {
    const html = renderToStaticMarkup(
      <PostDriveReviewCard
        trip={completedTrip}
        previousTrips={[]}
        mode="tracking"
        onDismiss={vi.fn()}
        onOpenTrip={vi.fn()}
        onOpenNextAction={vi.fn()}
      />
    );

    expect(html).toContain('Trip saved and ready to inspect');
    expect(html).toContain('38 pts');
    expect(html).toContain('neutral observation');
    expect(html).not.toContain('Next-drive focus');
  });

  it('explains the privacy benefit when a private trip has no score', () => {
    const model = buildPostDriveReviewViewModel({
      id: 'private-trip',
      privacy_mode: 'summary_only',
      status: 'completed',
      duration_seconds: 600,
      distance_km: 4,
    });

    expect(model.overallScore).toBeNull();
    expect(model.strongest.label).toBe('Privacy protected');
    expect(model.strongest.detail).toContain('without retaining raw route coordinates');
  });

  it('routes detected foreground activity into driver and event calibration', () => {
    const model = buildPostDriveReviewViewModel({
      ...completedTrip,
      harsh_brakes_count: 0,
      phone_use_window_count: 2,
    });

    expect(model.opportunity).toMatchObject({
      focus: 'phone_use',
      label: 'Review foreground activity',
    });
    expect(model.opportunity.detail).toContain('whether you were the driver');
    expect(model.opportunity.detail).toContain('removed from scoring');
  });

  it('compares against the same route before unrelated recent drives', () => {
    const model = buildPostDriveReviewViewModel({
      ...completedTrip,
      route_key: 'home|work',
    }, [
      { id: 'unrelated', route_key: 'other|route', score_overall: 99, score_confidence_label: 'high' },
      { id: 'same-route', route_key: 'home|work', score_overall: 70, score_confidence_label: 'high' },
    ]);

    expect(model.delta).toBe(18);
    expect(model.comparisonLabel).toBe('same-route drives');
    expect(model.subtitle).toContain('same-route drives (1 drive)');
  });

  it('prioritizes higher-impact evidence instead of the largest unweighted count', () => {
    const model = buildPostDriveReviewViewModel({
      ...completedTrip,
      harsh_brakes_count: 0,
      sharp_turns_count: 1,
      speeding_events_count: 1,
      phone_use_window_count: 1,
    });

    expect(model.opportunity).toMatchObject({
      focus: 'phone_use',
      label: 'Review foreground activity',
      count: 1,
    });
    expect(model.opportunity.reason).toContain('directly recorded event');
  });

  it('avoids behavior coaching when the score evidence is limited and no event was recorded', () => {
    const model = buildPostDriveReviewViewModel({
      ...completedTrip,
      score_confidence_label: 'low',
      harsh_brakes_count: 0,
      route_points_map_count: 12,
    });

    expect(model.title).toBe('A tentative review is ready');
    expect(model.confidence.label).toBe('Limited evidence');
    expect(model.opportunity.label).toBe('Build a stronger sample');
    expect(model.opportunity.detail).toContain('12 retained route points');
  });

  it('explains that navigation does not dismiss the review', () => {
    const html = renderToStaticMarkup(
      <PostDriveReviewCard
        trip={completedTrip}
        previousTrips={[]}
        onDismiss={vi.fn()}
        onOpenTrip={vi.fn()}
        onOpenNextAction={vi.fn()}
      />
    );

    expect(html).toContain('This review stays here while you explore');
    expect(html).toContain('Dismiss it with the X');
    expect(html).toContain('a newer completed trip will replace it');
  });

  it('provides an inline action that changes the next drive instead of only linking elsewhere', () => {
    const html = renderToStaticMarkup(
      <PostDriveReviewCard
        trip={completedTrip}
        previousTrips={[]}
        onDismiss={vi.fn()}
        onOpenTrip={vi.fn()}
        onOpenNextAction={vi.fn()}
      />
    );

    expect(html).toContain('Make this review affect the next drive');
    expect(html).toContain('Advanced drive intelligence');
    expect(html).toContain('Recurring or one-off?');
    expect(html).toContain('Strongest exact moment');
    expect(html).toContain('Likely contributor');
    expect(html).toContain('Measurable target');
    expect(html).toContain('Estimated upside');
    expect(html).toContain('Before / after experiment');
    expect(html).toContain('Use this next drive');
    expect(html).toContain('measures progress across three comparable drives');
    expect(html).toContain('Was this recommendation useful?');
    expect(html).toContain('Wrong detection');
    expect(html).not.toContain('>Open Coach<');
  });

  it('uses prior coaching feedback to rerank equally recent event evidence', () => {
    const coachStore = {
      history: [],
      feedback: [
        { focusId: 'phone_use', verdict: 'wrong_detection' },
        { focusId: 'speeding', verdict: 'helpful' },
      ],
    };
    const model = buildPostDriveReviewViewModel({
      ...completedTrip,
      harsh_brakes_count: 0,
      phone_use_window_count: 1,
      speeding_events_count: 1,
    }, [], 'coaching', coachStore);

    expect(model.opportunity.focus).toBe('speeding');
    expect(model.opportunity.reason).toContain('past feedback');
  });
});
