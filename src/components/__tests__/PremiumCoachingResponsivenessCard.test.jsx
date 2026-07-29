import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumCoachingResponsivenessCard, {
  buildCoachingResponsivenessMetrics,
} from '@/components/PremiumCoachingResponsivenessCard';
import { CoachingResponsiveness } from '@/pages/DrivingCoach';

const program = (id, { graduated = false, improvement = null } = {}) => ({
  id,
  result: {
    graduated,
    improvement,
  },
});

describe('buildCoachingResponsivenessMetrics', () => {
  it('derives every count and progress value from the supplied program history', () => {
    const model = buildCoachingResponsivenessMetrics([
      program('graduated-and-improved', { graduated: true, improvement: 18 }),
      program('improved', { improvement: 3.5 }),
      program('declined', { improvement: -4 }),
      program('unchanged', { improvement: 0 }),
    ]);

    expect(model).toMatchObject({
      completed: 4,
      graduated: 1,
      improved: 2,
    });
    expect(model.metrics.map(({ id, progress, value }) => ({ id, progress, value }))).toEqual([
      { id: 'completed', progress: 100, value: 4 },
      { id: 'graduated', progress: 25, value: 1 },
      { id: 'improved', progress: 50, value: 2 },
    ]);
  });

  it('keeps malformed or empty history data-safe', () => {
    expect(buildCoachingResponsivenessMetrics(/** @type {any} */ (null))).toMatchObject({
      completed: 0,
      graduated: 0,
      improved: 0,
    });
    expect(buildCoachingResponsivenessMetrics([
      program('missing'),
      program('not-a-number', { improvement: /** @type {any} */ ('unknown') }),
    ])).toMatchObject({
      completed: 2,
      graduated: 0,
      improved: 0,
    });
  });
});

describe('PremiumCoachingResponsivenessCard', () => {
  it('renders real values, generated scenes, semantic icons, and proportional progress', () => {
    const html = renderToStaticMarkup(
      <PremiumCoachingResponsivenessCard
        programs={[
          program('graduated', { graduated: true, improvement: 12 }),
          program('steady', { improvement: 0 }),
        ]}
      />
    );

    expect(html).toContain('class="premium-coaching-responsiveness"');
    expect(html).toContain('Your completed programs');
    expect(html).toContain('premium-coaching-responsiveness-programs.jpg');
    expect(html).toContain('premium-coaching-responsiveness-graduated.jpg');
    expect(html).toContain('premium-coaching-responsiveness-improved.jpg');
    expect(html).toContain('aria-label="2 programs completed"');
    expect(html).toContain('aria-label="1 graduated programs"');
    expect(html).toContain('aria-label="1 improved programs"');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('aria-valuenow="50"');
  });

  it('uses explicit loading and empty states without inventing demonstration values', () => {
    const loadingHtml = renderToStaticMarkup(
      <PremiumCoachingResponsivenessCard programs={[]} loading />
    );
    const emptyHtml = renderToStaticMarkup(
      <PremiumCoachingResponsivenessCard programs={[]} />
    );

    expect(loadingHtml).toContain('aria-busy="true"');
    expect(loadingHtml).toContain('Loading coaching history');
    expect(loadingHtml).toContain('—');
    expect(emptyHtml).toContain('aria-busy="false"');
    expect(emptyHtml).toContain('Complete a program to measure what works');
    expect(emptyHtml).toContain('aria-label="0 programs completed"');
  });

  it('is gated behind premium mode while preserving the standard card markup', () => {
    const programs = [program('improved', { improvement: 8 })];
    const standardHtml = renderToStaticMarkup(
      <CoachingResponsiveness programs={programs} premium={false} />
    );
    const premiumHtml = renderToStaticMarkup(
      <CoachingResponsiveness programs={programs} premium />
    );

    expect(standardHtml).toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(standardHtml).toContain('grid grid-cols-3 gap-2');
    expect(standardHtml).not.toContain('premium-coaching-responsiveness');
    expect(premiumHtml).toContain('class="premium-coaching-responsiveness"');
    expect(premiumHtml).not.toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
  });

  it('stores all generated card artwork as optimized JPEG assets', () => {
    [
      'premium-coaching-responsiveness-programs.jpg',
      'premium-coaching-responsiveness-graduated.jpg',
      'premium-coaching-responsiveness-improved.jpg',
    ].forEach((assetName) => {
      const asset = readFileSync(new URL(`../../assets/${assetName}`, import.meta.url));
      expect([...asset.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(asset.length).toBeLessThan(150_000);
    });
  });
});
