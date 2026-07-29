// @ts-check
import {
  ArrowRight,
  Brain,
  ChevronRight,
  Lightbulb,
  MapPinned,
  MoonStar,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import premiumAskCoachHero from '@/assets/premium-ask-coach-hero.webp';
import premiumAskCoachFocus from '@/assets/premium-ask-coach-focus.webp';
import premiumAskCoachImproving from '@/assets/premium-ask-coach-improving.webp';
import premiumAskCoachRepeat from '@/assets/premium-ask-coach-repeat.webp';
import premiumAskCoachFatigue from '@/assets/premium-ask-coach-fatigue.webp';
import premiumAskCoachAnswer from '@/assets/premium-ask-coach-answer.webp';
import premiumAskCoachEvidence from '@/assets/premium-ask-coach-evidence.webp';

export const PREMIUM_COACH_QUESTIONS = Object.freeze([
  {
    question: 'Why this focus?',
    eyebrow: 'Focus logic',
    detail: 'See why this habit was selected',
    tone: 'violet',
    Icon: Target,
    artwork: premiumAskCoachFocus,
  },
  {
    question: 'Am I improving?',
    eyebrow: 'Progress',
    detail: 'Compare your measured direction',
    tone: 'emerald',
    Icon: TrendingUp,
    artwork: premiumAskCoachImproving,
  },
  {
    question: 'Where do events repeat?',
    eyebrow: 'Patterns',
    detail: 'Find recurring event areas',
    tone: 'amber',
    Icon: MapPinned,
    artwork: premiumAskCoachRepeat,
  },
  {
    question: 'What about fatigue?',
    eyebrow: 'Drive time',
    detail: 'Review your learned fatigue onset',
    tone: 'blue',
    Icon: MoonStar,
    artwork: premiumAskCoachFatigue,
  },
]);

/** @param {unknown} value */
export function premiumCoachEvidenceCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Premium presentation for the same local evidence assistant used by the
 * standard Coaching details card.
 * @param {{
 *  question?: string,
 *  answer?: Record<string, any> | null,
 *  onQuestionChange: (value: string) => void,
 *  onAsk: (question?: string) => void,
 *  onOpenTrip: (tripId: string) => void,
 * }} props
 */
export default function PremiumAskCoachCard({
  question = '',
  answer = null,
  onQuestionChange,
  onAsk,
  onOpenTrip,
}) {
  const evidence = Array.isArray(answer?.evidence) ? answer.evidence : [];
  const evidenceCount = premiumCoachEvidenceCount(evidence);

  return (
    <details className="premium-ask-coach group" data-state={answer ? 'answered' : 'ready'}>
      <summary className="premium-ask-coach-summary">
        <img className="premium-ask-coach-hero" src={premiumAskCoachHero} alt="" aria-hidden="true" />
        <span className="premium-ask-coach-hero-veil" aria-hidden="true" />
        <span className="premium-ask-coach-summary-copy">
          <span className="premium-ask-coach-heading-row">
            <span className="premium-ask-coach-mark" aria-hidden="true"><Brain /></span>
            <span className="premium-ask-coach-heading">
              <span className="premium-ask-coach-eyebrow">Ask Coach</span>
              <span className="premium-ask-coach-title">Ask about your own evidence</span>
            </span>
          </span>
          <span className="premium-ask-coach-rule" aria-hidden="true"><span /></span>
          <span className="premium-ask-coach-description">
            Open the local evidence assistant for a deeper explanation.
          </span>
          <span className="premium-ask-coach-status">
            {answer ? <ShieldCheck aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {answer ? `${evidenceCount} linked ${evidenceCount === 1 ? 'trip' : 'trips'}` : 'Private · on device'}
          </span>
        </span>
        <span className="premium-ask-coach-toggle" aria-hidden="true"><ChevronRight /></span>
      </summary>

      <div className="premium-ask-coach-expanded">
        <form
          className="premium-ask-coach-form"
          onSubmit={(event) => {
            event.preventDefault();
            onAsk();
          }}
        >
          <label className="premium-ask-coach-input-wrap">
            <Brain aria-hidden="true" />
            <span className="sr-only">Question for Coach</span>
            <input
              value={question}
              onChange={(event) => onQuestionChange(event.target.value)}
              placeholder="Why did my focus change?"
            />
          </label>
          <button type="submit" className="premium-ask-coach-submit">
            <Send aria-hidden="true" />
            Ask Coach
          </button>
        </form>

        <div className="premium-ask-coach-prompts" aria-label="Suggested questions">
          {PREMIUM_COACH_QUESTIONS.map(({ question: suggestedQuestion, eyebrow, detail, tone, Icon, artwork }) => (
            <button
              key={suggestedQuestion}
              type="button"
              className="premium-ask-coach-prompt"
              data-tone={tone}
              onClick={() => onAsk(suggestedQuestion)}
              aria-label={`${suggestedQuestion} ${detail}`}
            >
              <img src={artwork} alt="" aria-hidden="true" />
              <span className="premium-ask-coach-prompt-veil" aria-hidden="true" />
              <span className="premium-ask-coach-prompt-icon" aria-hidden="true"><Icon /></span>
              <span className="premium-ask-coach-prompt-copy">
                <small>{eyebrow}</small>
                <strong>{suggestedQuestion}</strong>
                <span>{detail}</span>
              </span>
              <ChevronRight className="premium-ask-coach-prompt-arrow" aria-hidden="true" />
            </button>
          ))}
        </div>

        {answer ? (
          <article className="premium-ask-coach-answer" aria-live="polite">
            <img src={premiumAskCoachAnswer} alt="" className="premium-ask-coach-answer-art" aria-hidden="true" />
            <span className="premium-ask-coach-answer-veil" aria-hidden="true" />
            <div className="premium-ask-coach-answer-copy">
              <div className="premium-ask-coach-answer-kicker"><Sparkles aria-hidden="true" /> Grounded answer</div>
              <p>{answer.answer}</p>
            </div>

            <div className="premium-ask-coach-answer-grid">
              <section className="premium-ask-coach-inference">
                <span className="premium-ask-coach-subcard-icon" aria-hidden="true"><Lightbulb /></span>
                <div>
                  <h3>Inference</h3>
                  <p>{answer.inference}</p>
                </div>
              </section>

              <section className="premium-ask-coach-evidence" data-empty={evidenceCount === 0 ? 'true' : 'false'}>
                <img src={premiumAskCoachEvidence} alt="" aria-hidden="true" />
                <span className="premium-ask-coach-evidence-veil" aria-hidden="true" />
                <div className="premium-ask-coach-evidence-head">
                  <span className="premium-ask-coach-subcard-icon" aria-hidden="true"><Route /></span>
                  <div>
                    <h3>Trip evidence</h3>
                    <p>{evidenceCount ? `${evidenceCount} source ${evidenceCount === 1 ? 'trip' : 'trips'} you can inspect` : 'No directly linked trips for this answer'}</p>
                  </div>
                </div>
                {evidenceCount > 0 && (
                  <div className="premium-ask-coach-evidence-links">
                    {evidence.map((item) => (
                      <button key={item.tripId} type="button" onClick={() => onOpenTrip(item.tripId)}>
                        <span>{item.label}</span>
                        <ArrowRight aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <p className="premium-ask-coach-limitation">
              <ShieldCheck aria-hidden="true" />
              <span><strong>Evidence boundary</strong>{answer.limitation}</span>
            </p>
          </article>
        ) : (
          <div className="premium-ask-coach-empty" role="status">
            <span aria-hidden="true"><Brain /></span>
            <div>
              <strong>Ready for your question</strong>
              <p>Choose a suggestion or ask in your own words. Answers stay grounded in the trips stored on this device.</p>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
