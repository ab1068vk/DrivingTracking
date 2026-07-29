import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumPracticePlanCard, {
  buildPremiumPracticePlanViewModel,
  splitLiveCue,
  splitPracticeInstruction,
} from '@/components/PremiumPracticePlanCard';
import { COACH_FOCUS_CATALOG } from '@/lib/coachPrograms';

const braking = COACH_FOCUS_CATALOG.harsh_brakes;
const recommendation = {
  evidence: '4 measured trips',
  focus: braking,
  focusId: braking.id,
  reason: 'Recorded harsh-braking density is the highest-value measured focus.',
  whyNow: 'The recent comparison group has enough evidence for a real plan.',
};

describe('premium practice-plan copy helpers', () => {
  it('preserves changing instructions while creating a two-level hierarchy', () => {
    expect(splitPracticeInstruction('Lift off before applying the brake.')).toEqual({
      lead: 'Lift off',
      detail: 'before applying the brake.',
    });
    expect(splitPracticeInstruction('A deliberately long dynamic instruction that still needs to wrap safely.'))
      .toMatchObject({
        lead: 'A deliberately long dynamic instruction that still',
        detail: 'needs to wrap safely.',
      });
  });

  it('derives the live headline and detail from real cue text', () => {
    expect(splitLiveCue(
      'Today’s focus is progressive braking. Lift early and build pressure smoothly.',
      'Fallback cue',
    )).toEqual({
      headline: 'Today’s focus is progressive braking.',
      detail: 'Lift early and build pressure smoothly.',
    });
  });
});

describe('PremiumPracticePlanCard', () => {
  it('uses the selected focus data, generated step atlas, and semantic artwork', () => {
    const model = buildPremiumPracticePlanViewModel({
      definition: braking,
      recommendation,
    });
    const html = renderToStaticMarkup(
      <PremiumPracticePlanCard definition={braking} recommendation={recommendation} />,
    );

    expect(model).toMatchObject({
      empty: false,
      focusId: 'harsh_brakes',
      title: 'Progressive Braking',
    });
    expect(model.steps).toEqual(braking.drill);
    expect(html).toContain('class="premium-practice-plan"');
    expect(html).toContain('data-tone="braking"');
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('premium-practice-steps-harsh-brakes.webp');
    expect(html).toContain('premium-coach-cue-harsh-brakes.webp');
    expect(html).toContain('premium-coach-harsh-brakes.webp');
    expect(html).toContain('aria-label="Progressive Braking practice steps"');
    expect(html).toContain('Step 1: Choose the stop point earlier than usual.');
    expect(html.match(/class="premium-practice-step-art"/g)).toHaveLength(3);
    expect(html).toContain(braking.cue);
    expect(html).toContain('progressive braking.');
  });

  it('keeps long dynamic plan values available without truncating or replacing them', () => {
    const longStep = 'Choose a deliberately distant and context-appropriate reference point that can wrap safely on narrow screens without clipping any translated plan content.';
    const definition = {
      ...braking,
      label: 'A deliberately long translated practice-plan heading',
      cue: 'A long real-data coaching description remains readable and is never rendered into the background image.',
      drill: [longStep],
      liveCue: 'Today’s focus comes from live data. This complete dynamic cue remains in the document.',
    };
    const html = renderToStaticMarkup(
      <PremiumPracticePlanCard definition={definition} recommendation={{ ...recommendation, focus: definition }} />,
    );

    expect(html).toContain(definition.label);
    expect(html).toContain(definition.cue);
    expect(html).toContain(longStep);
    expect(html).toContain('This complete dynamic cue remains in the document.');
  });

  it('renders an honest evidence-building empty state without fake plan values', () => {
    const html = renderToStaticMarkup(
      <PremiumPracticePlanCard definition={braking} recommendation={null} />,
    );

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('No measured focus available');
    expect(html).toContain('Real evidence is still building');
    expect(html).toContain('do not become fake zeros here');
    expect(html).toContain('premium-practice-steps-evidence.webp');
    expect(html).not.toContain('<ol');
  });
});
