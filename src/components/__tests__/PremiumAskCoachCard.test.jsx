import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumAskCoachCard, {
  PREMIUM_COACH_QUESTIONS,
  premiumCoachEvidenceCount,
} from '@/components/PremiumAskCoachCard';

const handlers = () => ({
  onAsk: vi.fn(),
  onOpenTrip: vi.fn(),
  onQuestionChange: vi.fn(),
});

describe('PremiumAskCoachCard', () => {
  it('renders the empty assistant with all real controls and distinct question artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumAskCoachCard question="" answer={null} {...handlers()} />,
    );

    expect(PREMIUM_COACH_QUESTIONS.map((item) => item.question)).toEqual([
      'Why this focus?',
      'Am I improving?',
      'Where do events repeat?',
      'What about fatigue?',
    ]);
    expect(html).toContain('class="premium-ask-coach group"');
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('premium-ask-coach-hero.webp');
    expect(html).toContain('premium-ask-coach-focus.webp');
    expect(html).toContain('premium-ask-coach-improving.webp');
    expect(html).toContain('premium-ask-coach-repeat.webp');
    expect(html).toContain('premium-ask-coach-fatigue.webp');
    expect(html).toContain('placeholder="Why did my focus change?"');
    expect(html).toContain('Question for Coach');
    expect(html.match(/type="button"/g)).toHaveLength(4);
    expect(html).toContain('Ready for your question');
    expect(html).not.toContain('Grounded answer');
  });

  it('renders dynamic answer, inference, limitation, and every linked trip without fake values', () => {
    const answer = {
      answer: 'Your measured braking rate improved across comparable drives.',
      inference: 'The direction is encouraging, while the sample is still small.',
      evidence: [
        { tripId: 'trip-dawn', label: 'Tuesday dawn commute' },
        { tripId: 'trip-rain', label: 'Friday rainy return' },
      ],
      limitation: 'Only trips with measured event evidence are included.',
    };
    const html = renderToStaticMarkup(
      <PremiumAskCoachCard question="Am I improving?" answer={answer} {...handlers()} />,
    );

    expect(premiumCoachEvidenceCount(answer.evidence)).toBe(2);
    expect(premiumCoachEvidenceCount(null)).toBe(0);
    expect(html).toContain('data-state="answered"');
    expect(html).toContain('2 linked trips');
    expect(html).toContain('Your measured braking rate improved across comparable drives.');
    expect(html).toContain('The direction is encouraging, while the sample is still small.');
    expect(html).toContain('Tuesday dawn commute');
    expect(html).toContain('Friday rainy return');
    expect(html).toContain('Only trips with measured event evidence are included.');
    expect(html).toContain('premium-ask-coach-answer.webp');
    expect(html).toContain('premium-ask-coach-evidence.webp');
    expect(html.match(/type="button"/g)).toHaveLength(6);
  });

  it('shows an honest answer evidence empty state when no trip links are returned', () => {
    const html = renderToStaticMarkup(
      <PremiumAskCoachCard
        question="Why this focus?"
        answer={{
          answer: 'The focus follows the strongest available signal.',
          inference: 'More comparable trips can change this recommendation.',
          evidence: [],
          limitation: 'No directly linked trip is available yet.',
        }}
        {...handlers()}
      />,
    );

    expect(html).toContain('0 linked trips');
    expect(html).toContain('No directly linked trips for this answer');
    expect(html).toContain('data-empty="true"');
    expect(html).not.toContain('Ready for your question');
  });
});
