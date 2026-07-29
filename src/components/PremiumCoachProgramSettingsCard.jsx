// @ts-check
import {
  CheckCircle2,
  GitCompareArrows,
  Play,
  Route,
  SlidersHorizontal,
  Sparkles,
  TimerReset,
} from 'lucide-react';
import premiumProgramDifficulty from '@/assets/premium-coach-program-difficulty.jpg';
import premiumProgramLength from '@/assets/premium-coach-program-length.jpg';
import premiumProgramContext from '@/assets/premium-coach-program-context.jpg';
import premiumProgramRoute from '@/assets/premium-coach-program-route.jpg';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CoachSelect = /** @type {any} */ (Select);
const CoachSelectContent = /** @type {any} */ (SelectContent);
const CoachSelectItem = /** @type {any} */ (SelectItem);
const CoachSelectTrigger = /** @type {any} */ (SelectTrigger);
const CoachSelectValue = /** @type {any} */ (SelectValue);

const DIFFICULTY_LABELS = Object.freeze({
  adaptive: 'Adaptive',
  gentle: 'Gentle',
  standard: 'Standard',
  intensive: 'Intensive',
});

const CONTEXT_LABELS = Object.freeze({
  route: 'Specific repeated route',
  comparable: 'Comparable drives',
  urban: 'Urban drives',
  highway: 'Highway drives',
  all: 'All eligible drives',
});

/**
 * Derives premium presentation labels from the same values used by the
 * standard Program settings controls.
 * @param {{
 *  selectedDifficulty?: string,
 *  selectedTripCount?: string,
 *  selectedContext?: string,
 *  selectedRouteKey?: string,
 *  programRoutes?: Array<Record<string, any>>,
 *  adaptiveRecommendation?: Record<string, any> | null,
 * }} values
 */
export function buildPremiumCoachProgramSettingsViewModel({
  selectedDifficulty = 'adaptive',
  selectedTripCount = '5',
  selectedContext = 'comparable',
  selectedRouteKey = '',
  programRoutes = [],
  adaptiveRecommendation = null,
} = {}) {
  const tripCount = Math.max(0, Number(selectedTripCount) || 0);
  const routeKey = selectedRouteKey || programRoutes[0]?.routeKey || '';
  const route = programRoutes.find((item) => item.routeKey === routeKey) || null;
  const strength = tripCount <= 3
    ? 'Exploratory check'
    : tripCount >= 10
      ? 'Stronger evidence'
      : 'Balanced check';

  return {
    adaptive: selectedDifficulty === 'adaptive',
    contextLabel: CONTEXT_LABELS[selectedContext] || CONTEXT_LABELS.comparable,
    difficultyLabel: DIFFICULTY_LABELS[selectedDifficulty] || DIFFICULTY_LABELS.adaptive,
    routeKey,
    routeLabel: route ? `${route.label} · ${route.tripCount} drives` : 'Choose a repeated route',
    strength,
    suggestionDifficulty: adaptiveRecommendation?.difficulty || null,
    suggestionReason: adaptiveRecommendation?.reason || null,
    tripCount,
    tripLabel: `${tripCount} ${tripCount === 1 ? 'drive' : 'drives'}`,
  };
}

/**
 * @param {{
 *  activeProgram?: Record<string, any> | null,
 *  adaptiveRecommendation?: Record<string, any> | null,
 *  driverTripCount: number,
 *  onDifficultyChange: (value: string) => void,
 *  onStart: () => void,
 *  onContextChange: (value: string) => void,
 *  onRouteKeyChange: (value: string) => void,
 *  onTripCountChange: (value: string) => void,
 *  programBusy?: boolean,
 *  programRoutes?: Array<Record<string, any>>,
 *  selectedDefinition: Record<string, any>,
 *  selectedDifficulty: string,
 *  selectedContext: string,
 *  selectedRecommendation?: Record<string, any> | null,
 *  selectedRouteKey?: string,
 *  selectedTripCount: string,
 * }} props
 */
export default function PremiumCoachProgramSettingsCard({
  activeProgram = null,
  adaptiveRecommendation = null,
  driverTripCount,
  onDifficultyChange,
  onStart,
  onContextChange,
  onRouteKeyChange,
  onTripCountChange,
  programBusy = false,
  programRoutes = [],
  selectedDefinition,
  selectedDifficulty,
  selectedContext,
  selectedRecommendation = null,
  selectedRouteKey = '',
  selectedTripCount,
}) {
  const model = buildPremiumCoachProgramSettingsViewModel({
    selectedDifficulty,
    selectedTripCount,
    selectedContext,
    selectedRouteKey,
    programRoutes,
    adaptiveRecommendation,
  });

  return (
    <section
      className="premium-program-settings"
      aria-labelledby="premium-program-settings-title"
      data-context={selectedContext}
      data-difficulty={selectedDifficulty}
    >
      <div className="premium-program-settings-grid" aria-hidden="true" />
      <header className="premium-program-settings-head">
        <div className="premium-program-settings-kicker"><Sparkles /> Mission controls</div>
        <h2 id="premium-program-settings-title">Program settings</h2>
        <p>Control the challenge, duration, and comparison group.</p>
        <div className="premium-program-settings-summary" aria-label="Selected program settings">
          <span><SlidersHorizontal /> {model.difficultyLabel}</span>
          <span><TimerReset /> {model.tripLabel}</span>
          <span><GitCompareArrows /> {model.contextLabel}</span>
        </div>
      </header>

      <div className="premium-program-settings-controls">
        <article className="premium-program-setting-tile" data-tone="difficulty">
          <img src={premiumProgramDifficulty} alt="" aria-hidden="true" className="premium-program-setting-art" />
          <div className="premium-program-setting-shade" aria-hidden="true" />
          <div className="premium-program-setting-content">
            <div className="premium-program-setting-label">
              <span className="premium-program-setting-icon"><SlidersHorizontal /></span>
              <span>
                <strong>Difficulty</strong>
                <small>{model.difficultyLabel} challenge</small>
              </span>
            </div>
            <CoachSelect value={selectedDifficulty} onValueChange={onDifficultyChange}>
              <CoachSelectTrigger
                className="premium-program-select"
                aria-label="Program difficulty"
              >
                <CoachSelectValue />
              </CoachSelectTrigger>
              <CoachSelectContent>
                <CoachSelectItem value="adaptive">Adaptive</CoachSelectItem>
                <CoachSelectItem value="gentle">Gentle</CoachSelectItem>
                <CoachSelectItem value="standard">Standard</CoachSelectItem>
                <CoachSelectItem value="intensive">Intensive</CoachSelectItem>
              </CoachSelectContent>
            </CoachSelect>
            <p>Adaptive uses only completed, measured programs. Targets range from 15% to 35%.</p>
          </div>
        </article>

        <article className="premium-program-setting-tile" data-tone="length">
          <img src={premiumProgramLength} alt="" aria-hidden="true" className="premium-program-setting-art" />
          <div className="premium-program-setting-shade" aria-hidden="true" />
          <div className="premium-program-setting-content">
            <div className="premium-program-setting-label">
              <span className="premium-program-setting-icon"><TimerReset /></span>
              <span>
                <strong>Program length</strong>
                <small>{model.strength}</small>
              </span>
            </div>
            <CoachSelect value={selectedTripCount} onValueChange={onTripCountChange}>
              <CoachSelectTrigger
                className="premium-program-select"
                aria-label="Program length"
              >
                <CoachSelectValue />
              </CoachSelectTrigger>
              <CoachSelectContent>
                <CoachSelectItem value="3">3 drives</CoachSelectItem>
                <CoachSelectItem value="5">5 drives</CoachSelectItem>
                <CoachSelectItem value="10">10 drives</CoachSelectItem>
              </CoachSelectContent>
            </CoachSelect>
            <p>Use 5 drives for a balanced check; 3 is exploratory and 10 is stronger evidence.</p>
          </div>
        </article>

        <article className="premium-program-setting-tile premium-program-setting-context" data-tone="context">
          <img src={premiumProgramContext} alt="" aria-hidden="true" className="premium-program-setting-art" />
          <div className="premium-program-setting-shade" aria-hidden="true" />
          <div className="premium-program-setting-content">
            <div className="premium-program-setting-label">
              <span className="premium-program-setting-icon"><GitCompareArrows /></span>
              <span>
                <strong>Compare against</strong>
                <small>{model.contextLabel}</small>
              </span>
            </div>
            <CoachSelect value={selectedContext} onValueChange={onContextChange}>
              <CoachSelectTrigger
                className="premium-program-select"
                aria-label="Program comparison group"
              >
                <CoachSelectValue />
              </CoachSelectTrigger>
              <CoachSelectContent>
                <CoachSelectItem value="route" disabled={programRoutes.length === 0}>Specific repeated route</CoachSelectItem>
                <CoachSelectItem value="comparable">Comparable drives</CoachSelectItem>
                <CoachSelectItem value="urban">Urban drives</CoachSelectItem>
                <CoachSelectItem value="highway">Highway drives</CoachSelectItem>
                <CoachSelectItem value="all">All eligible drives</CoachSelectItem>
              </CoachSelectContent>
            </CoachSelect>
            <p>Comparable matches route and driving context when that evidence exists.</p>
          </div>
        </article>

        {selectedContext === 'route' && (
          <article className="premium-program-setting-tile premium-program-setting-route" data-tone="route">
            <img src={premiumProgramRoute} alt="" aria-hidden="true" className="premium-program-setting-art" />
            <div className="premium-program-setting-shade" aria-hidden="true" />
            <div className="premium-program-setting-content">
              <div className="premium-program-setting-label">
                <span className="premium-program-setting-icon"><Route /></span>
                <span>
                  <strong>Repeated route</strong>
                  <small>{model.routeLabel}</small>
                </span>
              </div>
              <CoachSelect value={model.routeKey} onValueChange={onRouteKeyChange}>
                <CoachSelectTrigger
                  className="premium-program-select"
                  aria-label="Repeated route"
                >
                  <CoachSelectValue placeholder="Choose a repeated route" />
                </CoachSelectTrigger>
                <CoachSelectContent>
                  {programRoutes.map((route) => (
                    <CoachSelectItem key={route.routeKey} value={route.routeKey}>
                      {route.label} - {route.tripCount} drives
                    </CoachSelectItem>
                  ))}
                </CoachSelectContent>
              </CoachSelect>
            </div>
          </article>
        )}
      </div>

      {model.adaptive && (
        <div className="premium-program-suggestion" role="status">
          <span className="premium-program-suggestion-icon" aria-hidden="true"><Sparkles /></span>
          <span>
            <strong>Suggested {model.suggestionDifficulty}:</strong>{' '}
            {model.suggestionReason}
          </span>
          <CheckCircle2 aria-hidden="true" />
        </div>
      )}

      <button
        type="button"
        disabled={programBusy || driverTripCount === 0 || !selectedRecommendation}
        onClick={onStart}
        className="premium-program-start"
      >
        <span className="premium-program-start-icon" aria-hidden="true"><Play /></span>
        <span className="sm:hidden">{activeProgram ? 'Replace mission' : 'Start mission'}</span>
        <span className="hidden sm:inline">
          {activeProgram ? `Replace with ${selectedDefinition.label}` : `Start ${selectedDefinition.label}`}
        </span>
      </button>

      {!selectedRecommendation && (
        <p className="premium-program-disabled-note">
          Start is disabled until this focus has at least two measured historical trips.
        </p>
      )}
    </section>
  );
}
