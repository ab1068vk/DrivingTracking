import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COACH_FEEDBACK_OPTIONS } from '@/lib/coachPrograms';
import PremiumPostDriveReviewCard, {
  buildPremiumPostDriveReviewViewModel,
} from '@/components/PremiumPostDriveReviewCard';

const program = {
  focusId: 'harsh_brakes',
  targetMetric: 3.2,
};

const progressFor = (overrides = {}) => ({
  focus: { id: 'harsh_brakes' },
  latestReview: {
    distanceKm: 16.0934,
    metTarget: true,
    metric: 2.4,
    score: 91.4,
    startTime: '2026-07-20T12:00:00.000Z',
    tripId: 'trip-review-1',
    ...overrides,
  },
});

describe('PremiumPostDriveReviewCard', () => {
  it('renders the reference-matched awaiting state without invented values', () => {
    const model = buildPremiumPostDriveReviewViewModel(null, program, 'metric');
    const html = renderToStaticMarkup(
      <PremiumPostDriveReviewCard
        progress={null}
        program={program}
        onReviewTrip={vi.fn()}
        onFeedback={vi.fn()}
      />,
    );

    expect(model).toMatchObject({
      dateLabel: null,
      distanceLabel: null,
      metricLabel: 'Awaiting drive',
      state: 'awaiting',
      title: 'Your next result will appear here',
    });
    expect(model.artwork).toContain('premium-post-drive-awaiting.webp');
    expect(html).toContain('data-state="awaiting"');
    expect(html).toContain('Measured after your next eligible drive');
    expect(html).toContain('premium-post-drive-evidence.webp');
    expect(html).not.toContain('Mission metric</span>');
    expect(html).not.toContain('Was this coaching useful?');
  });

  it('uses real imperial distance, score, metric, target, and success artwork', () => {
    const progress = progressFor();
    const model = buildPremiumPostDriveReviewViewModel(progress, program, 'imperial');
    const html = renderToStaticMarkup(
      <PremiumPostDriveReviewCard
        progress={progress}
        program={program}
        units="imperial"
        feedbackValue="helpful"
        onReviewTrip={vi.fn()}
        onFeedback={vi.fn()}
      />,
    );

    expect(model).toMatchObject({
      distanceLabel: '10.0 mi',
      metricLabel: '2.4 / 100 km',
      scoreLabel: '~91',
      state: 'success',
      targetLabel: '3.2 / 100 km',
    });
    expect(model.artwork).toContain('premium-post-drive-success.webp');
    expect(html).toContain('Target reached on this drive');
    expect(html).toContain('Score ~91');
    expect(html).toContain('Review trip evidence');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('premium-post-drive-feedback.webp');
  });

  it('uses the coaching state for a missed target and safely disables missing evidence navigation', () => {
    const progress = progressFor({ metTarget: false, score: null, tripId: null });
    const model = buildPremiumPostDriveReviewViewModel(progress, program, 'metric');
    const html = renderToStaticMarkup(
      <PremiumPostDriveReviewCard
        progress={progress}
        program={program}
        onReviewTrip={vi.fn()}
        onFeedback={vi.fn()}
      />,
    );

    expect(model.state).toBe('practice');
    expect(model.scoreLabel).toBeNull();
    expect(model.artwork).toContain('premium-post-drive-practice.webp');
    expect(html).toContain('Keep practising this focus');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Score ~');
  });

  it('preserves every coaching feedback control and its busy state', () => {
    const html = renderToStaticMarkup(
      <PremiumPostDriveReviewCard
        progress={progressFor()}
        program={program}
        feedbackBusy
        onReviewTrip={vi.fn()}
        onFeedback={vi.fn()}
      />,
    );

    Object.values(COACH_FEEDBACK_OPTIONS).forEach((option) => {
      expect(html).toContain(option.label);
    });
    expect(html.match(/disabled=""/g)).toHaveLength(Object.keys(COACH_FEEDBACK_OPTIONS).length);
    expect(html).toContain('Incorrect detections remain reviewable in Trip Detail.');
  });

  it('keeps long dynamic metric labels available to wrapping instead of truncating them', () => {
    const longMetric = Number('123456789.123');
    const model = buildPremiumPostDriveReviewViewModel(
      progressFor({ metric: longMetric }),
      { ...program, targetMetric: longMetric },
      'metric',
    );

    expect(model.metricLabel).toContain('123456789.1');
    expect(model.targetLabel).toContain('123456789.1');
  });
});
