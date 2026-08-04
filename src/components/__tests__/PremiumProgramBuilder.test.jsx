import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { COACH_FOCUS_CATALOG } from '@/lib/coachPrograms';
import PremiumProgramBuilder, {
  buildPremiumProgramOptions,
} from '@/components/PremiumProgramBuilder';

const focusCases = [
  ['harsh_brakes', 'braking', 'premium-program-builder-braking.webp', 'premium-program-builder-icon-braking.webp'],
  ['rapid_accel', 'acceleration', 'premium-program-builder-acceleration-v2.webp', 'premium-program-builder-icon-acceleration-v2.webp'],
  ['sharp_turns', 'turns', 'premium-program-builder-turns-v2.webp', 'premium-program-builder-icon-turns-v2.webp'],
  ['speeding', 'speed', 'premium-program-builder-speed.webp', 'premium-program-builder-icon-speed.webp'],
  ['phone_use', 'attention', 'premium-program-builder-attention.webp', 'premium-program-builder-icon-attention.webp'],
  ['fatigue', 'fatigue', 'premium-program-builder-fatigue-v2.webp', 'premium-program-builder-icon-fatigue-v2.webp'],
  ['consistency', 'consistency', 'premium-program-builder-consistency.webp', 'premium-program-builder-icon-consistency.webp'],
];

const recommendationFor = (focusId, priority = 'low') => ({
  evidence: `${focusId} measured evidence`,
  focus: COACH_FOCUS_CATALOG[focusId],
  focusId,
  priority,
  reason: `Live reason for ${focusId}`,
  whyNow: `Live why-now for ${focusId}`,
});

function collectElements(node, predicate, matches = []) {
  if (node == null || typeof node === 'boolean') return matches;
  if (Array.isArray(node)) {
    node.forEach((child) => collectElements(child, predicate, matches));
    return matches;
  }
  if (typeof node !== 'object' || !node.props) return matches;
  if (predicate(node)) matches.push(node);
  collectElements(node.props.children, predicate, matches);
  return matches;
}

describe('PremiumProgramBuilder', () => {
  it.each(focusCases)('maps %s to its distinct generated artwork', (focusId, tone, assetName, iconAssetName) => {
    const [model] = buildPremiumProgramOptions([recommendationFor(focusId)], focusId);

    expect(model).toMatchObject({
      focusId,
      priorityLabel: 'Recommended',
      selected: true,
      tone,
    });
    expect(model.artwork).toContain(assetName);
    expect(model.iconArtwork).toContain(iconAssetName);
  });

  it('renders live recommendations, evidence, why-now copy, priorities, and selection', () => {
    const recommendations = [
      recommendationFor('harsh_brakes', 'high'),
      recommendationFor('speeding', 'high'),
      recommendationFor('consistency', 'medium'),
    ];
    const html = renderToStaticMarkup(
      <PremiumProgramBuilder
        recommendations={recommendations}
        selectedFocus="speeding"
        onSelect={vi.fn()}
      />,
    );

    expect(html).toContain('class="premium-program-builder"');
    expect(html).toContain('Choose one habit to practise');
    expect(html).toContain('data-priority="recommended"');
    expect(html).toContain('data-priority="high"');
    expect(html).toContain('data-priority="medium"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Live reason for speeding');
    expect(html).toContain('speeding measured evidence');
    expect(html).toContain('Live why-now for speeding');
    expect(html).toContain('premium-program-builder-speed.webp');
    expect(html).toContain('premium-program-builder-icon-speed.webp');
  });

  it('preserves the focus-selection interaction on every option', () => {
    const onSelect = vi.fn();
    const recommendations = focusCases.slice(0, 3).map(([focusId], index) => (
      recommendationFor(focusId, index === 0 ? 'high' : 'low')
    ));
    const tree = PremiumProgramBuilder({
      recommendations,
      selectedFocus: 'harsh_brakes',
      onSelect,
    });
    const buttons = collectElements(tree, (node) => node.type === 'button');

    expect(buttons).toHaveLength(3);
    buttons.forEach((button) => button.props.onClick());
    expect(onSelect.mock.calls).toEqual([
      ['harsh_brakes'],
      ['rapid_accel'],
      ['sharp_turns'],
    ]);
  });

  it('keeps long dynamic recommendation values intact', () => {
    const longReason = 'A live measured coaching reason '.repeat(20).trim();
    const longEvidence = '123456789 measured events from comparable real-world driving records';
    const longWhyNow = 'Adjusted from a long local coaching history '.repeat(10).trim();
    const [model] = buildPremiumProgramOptions([{
      ...recommendationFor('phone_use'),
      evidence: longEvidence,
      reason: longReason,
      whyNow: longWhyNow,
    }], 'phone_use');

    expect(model.reason).toBe(longReason);
    expect(model.evidence).toBe(longEvidence);
    expect(model.whyNow).toBe(longWhyNow);
  });

  it('renders the real empty state and active-program heading', () => {
    const emptyHtml = renderToStaticMarkup(
      <PremiumProgramBuilder recommendations={[]} onSelect={vi.fn()} />,
    );
    const activeHtml = renderToStaticMarkup(
      <PremiumProgramBuilder
        activeProgram={{ id: 'active-program' }}
        recommendations={[recommendationFor('consistency')]}
        selectedFocus="consistency"
        onSelect={vi.fn()}
      />,
    );

    expect(emptyHtml).toContain('data-empty="true"');
    expect(emptyHtml).toContain('fewer than two trips contain a comparable measurement');
    expect(activeHtml).toContain('Change program');
  });

  it('is gated by the persisted premium setting while retaining the standard selector branch', () => {
    const pageSource = readFileSync(new URL('../../pages/DrivingCoach.jsx', import.meta.url), 'utf8');

    expect(pageSource).toContain("settings.premium_visual_experience === true ? (");
    expect(pageSource).toContain('<PremiumProgramBuilder');
    expect(pageSource).toContain("className={`rounded-2xl border p-4 text-left transition ${selected");
    expect(pageSource).toContain("onClick={() => setSelectedFocus(recommendation.focusId)}");
  });
});
