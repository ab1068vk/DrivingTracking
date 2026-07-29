import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { COACH_FOCUS_CATALOG } from '@/lib/coachPrograms';
import PremiumRecommendedProgramCard, {
  buildPremiumCoachRecommendationViewModel,
} from '@/components/PremiumRecommendedProgramCard';
import { EmptyMission } from '@/pages/DrivingCoach';

const focusCases = [
  ['harsh_brakes', 'braking', 'premium-coach-harsh-brakes.webp', 'premium-coach-cue-harsh-brakes.webp'],
  ['rapid_accel', 'acceleration', 'premium-coach-rapid-accel.webp', 'premium-coach-cue-rapid-accel.webp'],
  ['sharp_turns', 'turns', 'premium-coach-sharp-turns.webp', 'premium-coach-cue-sharp-turns.webp'],
  ['speeding', 'speed', 'premium-coach-speeding.webp', 'premium-coach-cue-speeding.webp'],
  ['phone_use', 'attention', 'premium-coach-phone-use.webp', 'premium-coach-cue-phone-use.webp'],
  ['fatigue', 'fatigue', 'premium-coach-fatigue.webp', 'premium-coach-cue-fatigue.webp'],
  ['consistency', 'consistency', 'premium-coach-consistency.webp', 'premium-coach-cue-consistency.webp'],
];

const recommendationFor = (focusId) => ({
  evidence: '12 measured events',
  focus: COACH_FOCUS_CATALOG[focusId],
  focusId,
  priority: 'high',
  reason: `Live evidence for ${focusId}`,
  whyNow: 'Selected from your latest measured driving pattern.',
});

describe('PremiumRecommendedProgramCard', () => {
  it.each(focusCases)('maps %s to distinct hero and cue artwork', (focusId, tone, assetName, cueAssetName) => {
    const model = buildPremiumCoachRecommendationViewModel(recommendationFor(focusId));

    expect(model).toMatchObject({
      actionLabel: 'Build my program',
      focusId,
      tone,
    });
    expect(model.artwork).toContain(assetName);
    expect(model.cueArtwork).toContain(cueAssetName);
    expect(model.cueArtwork).not.toBe(model.artwork);
  });

  it('renders live recommendation evidence, the coaching cue, artwork, and preserved action', () => {
    const recommendation = {
      ...recommendationFor('harsh_brakes'),
      evidence: '27 measured events across recent trips',
      reason: 'Braking accounts for 66% of recorded risk events.',
      whyNow: 'Adjusted using 3 previous programs on this focus.',
    };
    const html = renderToStaticMarkup(
      <PremiumRecommendedProgramCard recommendation={recommendation} onConfigure={vi.fn()} />,
    );

    expect(html).toContain('class="premium-coach-card"');
    expect(html).toContain('data-focus="harsh_brakes"');
    expect(html).toContain('Recommended next program');
    expect(html).toContain('Progressive Braking');
    expect(html).toContain('Braking accounts for 66% of recorded risk events.');
    expect(html).toContain('27 measured events across recent trips');
    expect(html).toContain('Adjusted using 3 previous programs on this focus.');
    expect(html).toContain(COACH_FOCUS_CATALOG.harsh_brakes.cue);
    expect(html).toContain('Build my program');
    expect(html.match(/premium-coach-harsh-brakes\.webp/g)).toHaveLength(1);
    expect(html.match(/premium-coach-cue-harsh-brakes\.webp/g)).toHaveLength(1);
  });

  it('gates the premium rendering while preserving the standard card branch', () => {
    const recommendation = recommendationFor('sharp_turns');
    const standardHtml = renderToStaticMarkup(
      <EmptyMission recommendation={recommendation} onConfigure={vi.fn()} premium={false} />,
    );
    const premiumHtml = renderToStaticMarkup(
      <EmptyMission recommendation={recommendation} onConfigure={vi.fn()} premium />,
    );

    expect(standardHtml).toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(standardHtml).not.toContain('premium-coach-card');
    expect(premiumHtml).toContain('class="premium-coach-card"');
    expect(premiumHtml).not.toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(standardHtml).toContain('Build my program');
    expect(premiumHtml).toContain('Build my program');
  });

  it('keeps the missing-measurement state explicit without inventing a recommendation', () => {
    const model = buildPremiumCoachRecommendationViewModel(null);
    const html = renderToStaticMarkup(
      <PremiumRecommendedProgramCard recommendation={null} onConfigure={vi.fn()} />,
    );

    expect(model).toMatchObject({
      evidence: null,
      focusId: 'evidence',
      tone: 'evidence',
    });
    expect(model.cueArtwork).toContain('premium-coach-cue-evidence.webp');
    expect(model.cueArtwork).not.toBe(model.artwork);
    expect(html).toContain('Historical evidence unavailable');
    expect(html).toContain('Road Sage will never turn a missing value into 0.');
    expect(html).toContain('Review trip evidence');
    expect(html).not.toContain('Build my program');
  });

  it('uses one semantic outer border without an inset card outline', () => {
    const cssSource = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(cssSource).toContain('.premium-coach-card {');
    expect(cssSource).not.toContain('.premium-coach-card::before');
    expect(cssSource).not.toContain('.premium-coach-card::after');
  });

  it('blends rectangular hero artwork into the card on every edge', () => {
    const cssSource = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(cssSource).toContain('-webkit-mask-composite: source-in;');
    expect(cssSource).toContain('mask-composite: intersect;');
  });

  it('preserves long dynamic values without truncating them in component logic', () => {
    const longReason = 'A measured recommendation reason '.repeat(18).trim();
    const longEvidence = '123456789 measured events from comparable real-world driving records';
    const model = buildPremiumCoachRecommendationViewModel({
      ...recommendationFor('phone_use'),
      evidence: longEvidence,
      reason: longReason,
    });

    expect(model.reason).toBe(longReason);
    expect(model.evidence).toBe(longEvidence);
  });
});
