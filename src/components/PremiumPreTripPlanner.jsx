// @ts-check
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudSun,
  Gauge,
  History,
  MapPinned,
  X,
} from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import premiumPreTripHero from '@/assets/premium-pretrip-hero-v2.jpg';
import premiumPlannerActions from '@/assets/premium-planner-before-start-v2.jpg';
import premiumPlannerWindow from '@/assets/premium-planner-window-v2.jpg';
import premiumPlannerSpeed from '@/assets/premium-planner-speed-v2.jpg';
import premiumPlannerAreas from '@/assets/premium-planner-areas-v2.jpg';
import premiumPlannerHistory from '@/assets/premium-planner-history-v2.jpg';
import premiumPlannerGaugeIcon from '@/assets/premium-planner-icon-gauge-v3.png';
import premiumPlannerClockIcon from '@/assets/premium-planner-icon-clock-v3.png';
import premiumPlannerWindowIcon from '@/assets/premium-planner-icon-window-v3.png';
import premiumPlannerWindowRecommended from '@/assets/premium-planner-window-recommended-v4.jpg';
import premiumPlannerWindowLateNight from '@/assets/premium-planner-window-late-night-v4.jpg';
import premiumPlannerWindowLearning from '@/assets/premium-planner-window-learning-v4.jpg';
import premiumPlannerWindowDisabled from '@/assets/premium-planner-window-disabled-v4.jpg';
import premiumPlannerWindowRecommendedIcon from '@/assets/premium-planner-icon-window-recommended-v4.png';
import premiumPlannerWindowLateNightIcon from '@/assets/premium-planner-icon-window-late-night-v4.png';
import premiumPlannerWindowLearningIcon from '@/assets/premium-planner-icon-window-learning-v4.png';
import premiumPlannerWindowDisabledIcon from '@/assets/premium-planner-icon-window-disabled-v4.png';
import premiumPlannerSpeedIcon from '@/assets/premium-planner-icon-speed-v3.png';
import premiumPlannerShieldIcon from '@/assets/premium-planner-icon-shield-v3.png';

const INSIGHT_CARDS = Object.freeze([
  { id: 'actions', accent: 'green', art: premiumPlannerActions, emblem: premiumPlannerClockIcon, title: 'Before you start' },
  { id: 'window', accent: 'amber', art: premiumPlannerWindow, emblem: premiumPlannerWindowIcon, title: 'Better window' },
  { id: 'speed', accent: 'blue', art: premiumPlannerSpeed, emblem: premiumPlannerSpeedIcon, title: 'Saved speed checks' },
  { id: 'areas', accent: 'violet', art: premiumPlannerAreas, emblem: premiumPlannerShieldIcon, title: 'Watch road areas' },
]);

const BETTER_WINDOW_VISUALS = Object.freeze({
  acceptable: { art: premiumPlannerWindow, emblem: premiumPlannerWindowIcon, accent: 'green' },
  recommended: { art: premiumPlannerWindowRecommended, emblem: premiumPlannerWindowRecommendedIcon, accent: 'amber' },
  'late-night': { art: premiumPlannerWindowLateNight, emblem: premiumPlannerWindowLateNightIcon, accent: 'red' },
  learning: { art: premiumPlannerWindowLearning, emblem: premiumPlannerWindowLearningIcon, accent: 'blue' },
  disabled: { art: premiumPlannerWindowDisabled, emblem: premiumPlannerWindowDisabledIcon, accent: 'muted' },
});

const CONTRIBUTION_ICONS = Object.freeze({
  baseline: BarChart3,
  events: Gauge,
  zones: MapPinned,
  weather: CloudSun,
  time: Clock3,
});

function clampScore(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function insightItems(card, props) {
  if (card.id === 'actions') return props.actions;
  if (card.id === 'window') return [props.saferWindow];
  if (card.id === 'speed') {
    return props.localSpeedItems.length
      ? props.localSpeedItems.map((item) => ({
        key: item.key,
        title: item.title,
        detail: item.detail,
        tone: item.tone,
      }))
      : [props.localSpeedEmptyText];
  }
  return props.watchZoneItems.length ? props.watchZoneItems : [props.watchZoneEmptyText];
}

export function getBetterWindowVisualState(message) {
  const normalized = String(message || '').trim().toLowerCase();
  if (normalized.includes('disabled in settings')) return 'disabled';
  if (normalized.includes('late night') || normalized.includes('higher risk')) return 'late-night';
  if (
    normalized.includes('complete more scored trips')
    || normalized.includes('hours vary')
    || normalized.includes('more history')
  ) return 'learning';
  if (
    normalized.includes('current time looks acceptable')
    || normalized.includes('current time looks as good')
    || normalized.includes('current departure window is typical')
  ) return 'acceptable';
  return 'recommended';
}

function InsightCard({ card, items, saferWindow }) {
  const visualState = card.id === 'window' ? getBetterWindowVisualState(saferWindow) : null;
  const visual = visualState ? BETTER_WINDOW_VISUALS[visualState] : card;

  return (
    <article
      className="premium-planner-insight"
      data-accent={visual.accent || card.accent}
      data-visual-state={visualState || undefined}
    >
      <div className="premium-planner-insight-visual">
        <img className="premium-planner-insight-art" src={visual.art} alt="" aria-hidden="true" />
        <span className="premium-planner-insight-icon">
          <img src={visual.emblem} alt="" aria-hidden="true" />
        </span>
      </div>
      <div className="premium-planner-insight-body">
        <h3>{card.title}</h3>
        <div className="premium-planner-insight-list">
          {items.map((item, index) => {
            const normalized = typeof item === 'string' ? { detail: item } : item;
            return (
              <div key={normalized.key || `${card.id}-${index}`} data-tone={normalized.tone || 'default'}>
                {normalized.title && <strong>{normalized.title}</strong>}
                {normalized.detail && <span>{normalized.detail}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function LikelyRange({ preTripRisk, score }) {
  const low = clampScore(preTripRisk.readinessRange?.low);
  const high = clampScore(preTripRisk.readinessRange?.high);
  const confidence = clampScore(preTripRisk.dataQuality?.confidenceScore);
  const rangeAvailable = low != null && high != null;
  const middle = score ?? (rangeAvailable ? Math.round((low + high) / 2) : null);
  const rangeLabel = rangeAvailable ? `${low}–${high}` : 'Learning';
  const confidenceLabel = confidence == null ? 'Core evidence needed' : `${confidence}% confidence`;
  const riskLabel = preTripRisk.riskLevel === 'unavailable' ? 'Range withheld' : `${preTripRisk.riskLevel} risk`;

  return (
    <section
      className="premium-planner-range"
      data-available={rangeAvailable ? 'true' : 'false'}
      aria-label={`Likely readiness range ${rangeLabel}`}
    >
      <div className="premium-planner-range-copy">
        <span className="premium-planner-range-icon">
          <img src={premiumPlannerGaugeIcon} alt="" aria-hidden="true" />
        </span>
        <div>
          <span>Likely range</span>
          <strong>{rangeLabel}</strong>
          <small>{confidenceLabel}<i aria-hidden="true">•</i>{riskLabel}</small>
        </div>
      </div>
      <div className="premium-planner-range-chart" data-available={rangeAvailable ? 'true' : 'false'}>
        <svg viewBox="0 0 360 104" preserveAspectRatio="none" role="img" aria-label={rangeAvailable
          ? `Readiness range from ${low} to ${high}, centered near ${middle}`
          : 'Likely range is still learning'}>
          <defs>
            <linearGradient id="premium-planner-range-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.46" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path className="premium-planner-range-gridline" d="M12 82H348M12 55H348M12 28H348" />
          {rangeAvailable ? (
            <>
              <path className="premium-planner-range-area" d="M12 82 C72 80 96 44 150 30 C194 18 226 36 258 38 C298 40 320 24 348 12 L348 82 Z" />
              <path className="premium-planner-range-line" d="M12 82 C72 80 96 44 150 30 C194 18 226 36 258 38 C298 40 320 24 348 12" />
              <circle className="premium-planner-range-dot" cx="348" cy="12" r="4" />
            </>
          ) : (
            <path className="premium-planner-range-learning" d="M12 72 C82 58 112 72 176 52 S286 34 348 40" />
          )}
        </svg>
        <div className="premium-planner-range-labels" aria-hidden="true">
          <span>{low ?? '—'}</span>
          <span>{middle ?? '—'}</span>
          <span>{high ?? '—'}</span>
        </div>
      </div>
    </section>
  );
}

function SignalContributions({ components }) {
  return (
    <div className="premium-planner-contributions" aria-label="Estimated historical context component breakdown">
      <h4>Signal contributions</h4>
      {components.map((component) => {
        const Icon = CONTRIBUTION_ICONS[component.key] || BarChart3;
        const normalizedRisk = clampScore(component.normalizedRisk);
        const contribution = Number.isFinite(Number(component.contribution))
          ? Number(component.contribution)
          : 0;
        return (
          <div className="premium-planner-contribution" key={component.key}>
            <span className="premium-planner-contribution-icon"><Icon aria-hidden="true" /></span>
            <span className="premium-planner-contribution-copy">
              <strong>{component.label}</strong>
              <small>{component.detail}</small>
            </span>
            <span
              className="premium-planner-contribution-track"
              role="progressbar"
              aria-label={`${component.label} signal strength`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={normalizedRisk ?? 0}
            >
              <i style={{ width: `${normalizedRisk ?? 0}%` }} />
            </span>
            <b>{contribution > 0 ? '+' : ''}{contribution}</b>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Premium-only presentation for the existing dashboard readiness planner.
 * All values and actions are prepared by DashboardRiskPanel from live app state.
 *
 * @param {{
 *   actions: string[],
 *   historicalContextEnabled: boolean,
 *   historyStatus: string,
 *   localSpeedEmptyText: string,
 *   localSpeedItems: Array<Record<string, any>>,
 *   onDismiss: () => void,
 *   plannerTone: Record<string, any>,
 *   predictiveRouteRisk: Record<string, any>,
 *   preTripRisk: Record<string, any>,
 *   readinessApproximate?: boolean,
 *   readinessEvidence: string,
 *   routeRiskApproximate?: boolean,
 *   saferWindow: string,
 *   scoreText: string,
 *   watchZoneEmptyText: string,
 *   watchZoneItems: Array<Record<string, any>>,
 * }} props
 */
export default function PremiumPreTripPlanner({
  actions,
  historicalContextEnabled,
  historyStatus,
  localSpeedEmptyText,
  localSpeedItems,
  onDismiss,
  plannerTone,
  predictiveRouteRisk,
  preTripRisk,
  readinessApproximate = false,
  readinessEvidence,
  routeRiskApproximate = false,
  saferWindow,
  scoreText,
  watchZoneEmptyText,
  watchZoneItems,
}) {
  const score = clampScore(preTripRisk.readinessScore);
  const riskLevel = preTripRisk.riskLevel || 'unavailable';
  const factorSignals = preTripRisk.topSignals || [];
  const insightProps = {
    actions,
    localSpeedEmptyText,
    localSpeedItems,
    saferWindow,
    watchZoneEmptyText,
    watchZoneItems,
  };

  return (
    <section
      className="premium-planner premium-planner-reference"
      data-risk={riskLevel}
      aria-labelledby="premium-planner-title"
    >
      <header className="premium-planner-hero">
        <img className="premium-planner-hero-art" src={premiumPreTripHero} alt="" aria-hidden="true" />
        <div className="premium-planner-hero-shade" aria-hidden="true" />
        <div className="premium-planner-hero-heading">
          <div
            className="premium-planner-score"
            data-available={score == null ? 'false' : 'true'}
            style={/** @type {import('react').CSSProperties & Record<string, string>} */ ({
              '--planner-score': `${score == null ? 18 : score * 3.6}deg`,
            })}
            role="img"
            aria-label={score == null ? 'Readiness score learning' : `Readiness score ${scoreText}`}
          >
            <div>
              <strong>{score == null ? '—' : scoreText.replace('/100', '')}</strong>
              <span>/100</span>
            </div>
          </div>
          <div className="premium-planner-title-copy">
            <div className="premium-planner-heading-line">
              <h2 id="premium-planner-title">Pre-trip readiness planner</h2>
              {readinessApproximate && <CalibrationStatusTag />}
            </div>
            <div className="premium-planner-hero-status">
              <span data-kind="status"><CheckCircle2 aria-hidden="true" />{plannerTone.status}</span>
              <span data-kind="evidence"><BarChart3 aria-hidden="true" />{readinessEvidence} evidence</span>
            </div>
          </div>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss readiness card" className="premium-planner-dismiss">
          <X aria-hidden="true" />
        </button>
        <div className="premium-planner-hero-copy">
          <h3>{plannerTone.headline}</h3>
          <p>{plannerTone.guidance}</p>
          {preTripRisk.primaryConcern !== 'Insufficient readiness evidence' && (
            <p className="premium-planner-concern">
              <span>Main reason:</span> <strong>{preTripRisk.primaryConcern}</strong>
            </p>
          )}
        </div>
      </header>

      <LikelyRange preTripRisk={preTripRisk} score={score} />

      <details className="premium-planner-details">
        <summary>
          <span>Advanced readiness details</span>
          <ChevronDown aria-hidden="true" />
        </summary>
        <div className="premium-planner-details-content">
          <div className="premium-planner-insights">
            {INSIGHT_CARDS.map((card) => (
              <InsightCard
                key={card.id}
                card={card}
                items={insightItems(card, insightProps)}
                saferWindow={saferWindow}
              />
            ))}
          </div>

          {factorSignals.length > 0 && (
            <section className="premium-planner-factors" aria-labelledby="premium-planner-factors-title">
              <div className="premium-planner-section-head">
                <span className="premium-planner-section-icon"><AlertTriangle aria-hidden="true" /></span>
                <h3 id="premium-planner-factors-title">Risk factors ranked</h3>
              </div>
              <div className="premium-planner-factor-list">
                {factorSignals.map((signal, index) => {
                  const value = clampScore(signal.value) || 0;
                  return (
                    <div key={signal.key} className="premium-planner-factor" data-rank={Math.min(index + 1, 3)}>
                      <span className="premium-planner-factor-rank">{index + 1}</span>
                      <div className="premium-planner-factor-copy">
                        <strong>{signal.label}</strong>
                        <p>{signal.tip}</p>
                      </div>
                      <span className="premium-planner-factor-track" aria-hidden="true"><i style={{ width: `${value}%` }} /></span>
                      <b>{signal.value}</b>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {historicalContextEnabled && (
            predictiveRouteRisk.insufficientHistory ? (
              <section className="premium-planner-history" data-state="learning">
                <div className="premium-planner-section-head">
                  <span className="premium-planner-section-icon"><History aria-hidden="true" /></span>
                  <div><h3>Historical context</h3><p>Not enough driving history</p></div>
                  <span className="premium-planner-history-pill">Building</span>
                </div>
                <p className="premium-planner-history-copy">
                  Complete a scored trip with recorded distance before a historical-context estimate is shown.
                </p>
              </section>
            ) : (
              <section className="premium-planner-history" data-state={predictiveRouteRisk.riskLevel} aria-labelledby="premium-planner-history-title">
                <div className="premium-planner-section-head">
                  <span className="premium-planner-section-icon premium-planner-section-icon-generated">
                    <img src={premiumPlannerShieldIcon} alt="" aria-hidden="true" />
                  </span>
                  <div>
                    <div className="premium-planner-history-heading">
                      <h3 id="premium-planner-history-title">Estimated historical context</h3>
                      {routeRiskApproximate && <CalibrationStatusTag />}
                    </div>
                    <p>{historyStatus}</p>
                  </div>
                  <span className="premium-planner-history-score">{predictiveRouteRisk.riskScore}<small>/100</small></span>
                </div>
                <div className="premium-planner-history-layout">
                  <img className="premium-planner-history-art" src={premiumPlannerHistory} alt="" aria-hidden="true" />
                  <div className="premium-planner-history-data">
                    <div className="premium-planner-history-summary">
                      <p>{predictiveRouteRisk.primaryFactor}</p>
                      <p><Clock3 aria-hidden="true" />{predictiveRouteRisk.safestWindow}</p>
                      {predictiveRouteRisk.nearbyDangerZoneCount > 0 && (
                        <p data-kind="warning"><MapPinned aria-hidden="true" />
                          {predictiveRouteRisk.nearbyDangerZoneCount} repeated event area{predictiveRouteRisk.nearbyDangerZoneCount === 1 ? '' : 's'} from your history nearby
                        </p>
                      )}
                    </div>
                    <SignalContributions components={predictiveRouteRisk.componentBreakdown || []} />
                  </div>
                </div>
                <p className="premium-planner-disclaimer">
                  Internal historical-context estimate only. No planned route is known, and signal thresholds are not validated against collision or casualty outcomes.
                </p>
              </section>
            )
          )}
        </div>
      </details>
    </section>
  );
}
