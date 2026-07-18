// @ts-check
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Gauge,
  History,
  MapPinned,
  Route,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import CalibrationStatusTag from '@/components/CalibrationStatusTag';
import premiumPreTripPlanner from '@/assets/premium-pretrip-planner.png';
import premiumPlannerActions from '@/assets/premium-planner-actions.png';
import premiumPlannerWindow from '@/assets/premium-planner-window.png';
import premiumPlannerSpeed from '@/assets/premium-planner-speed.png';
import premiumPlannerAreas from '@/assets/premium-planner-areas.png';

const INSIGHT_CARDS = Object.freeze([
  { id: 'actions', accent: 'cyan', art: premiumPlannerActions, icon: CheckCircle2, title: 'Before you start' },
  { id: 'window', accent: 'violet', art: premiumPlannerWindow, icon: Clock3, title: 'Better window' },
  { id: 'speed', accent: 'amber', art: premiumPlannerSpeed, icon: Gauge, title: 'Saved speed checks' },
  { id: 'areas', accent: 'coral', art: premiumPlannerAreas, icon: MapPinned, title: 'Watch road areas' },
]);

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

function InsightCard({ card, items }) {
  const Icon = card.icon;
  return (
    <article className="premium-planner-insight" data-accent={card.accent}>
      <img className="premium-planner-insight-art" src={card.art} alt="" aria-hidden="true" />
      <div className="premium-planner-insight-head">
        <span className="premium-planner-insight-icon"><Icon aria-hidden="true" /></span>
        <h3>{card.title}</h3>
      </div>
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
    </article>
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
      className="premium-planner"
      data-risk={riskLevel}
      aria-labelledby="premium-planner-title"
    >
      <div className="premium-planner-grid" aria-hidden="true" />
      <div className="premium-planner-route-art" aria-hidden="true">
        <span /><span /><span />
      </div>

      <header className="premium-planner-header">
        <div className="premium-planner-title-row">
          <span className="premium-planner-brand-icon"><Route aria-hidden="true" /></span>
          <div>
            <div className="premium-planner-eyebrow"><Sparkles aria-hidden="true" /> Pre-drive intelligence</div>
            <div className="premium-planner-heading-line">
              <h2 id="premium-planner-title">Pre-trip readiness planner</h2>
              {readinessApproximate && <CalibrationStatusTag />}
            </div>
          </div>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss readiness card" className="premium-planner-dismiss">
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="premium-planner-hero">
        <div className="premium-planner-hero-copy">
          <div className="premium-planner-badges">
            <span data-kind="status"><ShieldCheck aria-hidden="true" />{plannerTone.status}</span>
            <span data-kind="evidence">{readinessEvidence} evidence</span>
          </div>
          <h3>{plannerTone.headline}</h3>
          <p>{plannerTone.guidance}</p>
          {preTripRisk.primaryConcern !== 'Insufficient readiness evidence' && (
            <div className="premium-planner-concern">
              <AlertTriangle aria-hidden="true" />
              <span><small>Main reason</small><strong>{preTripRisk.primaryConcern}</strong></span>
            </div>
          )}
        </div>

        <div className="premium-planner-hero-art-shell" aria-hidden="true">
          <img className="premium-planner-hero-art" src={premiumPreTripPlanner} alt="" />
        </div>

        <div className="premium-planner-score-shell">
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
              <strong>{score == null ? 'Learning' : scoreText.replace('/100', '')}</strong>
              {score != null && <span>/ 100</span>}
              <small>Readiness</small>
            </div>
          </div>
          <div className="premium-planner-risk-label">
            {riskLevel === 'unavailable' ? 'Score withheld' : `${riskLevel} risk`}
          </div>
        </div>
      </div>

      <details className="premium-planner-details">
        <summary>
          <span>Advanced readiness details</span>
          <ChevronDown aria-hidden="true" />
        </summary>
        <div className="premium-planner-details-content">
      <div className="premium-planner-insights">
        {INSIGHT_CARDS.map((card) => (
          <InsightCard key={card.id} card={card} items={insightItems(card, insightProps)} />
        ))}
      </div>

      {factorSignals.length > 0 && (
        <section className="premium-planner-factors" aria-labelledby="premium-planner-factors-title">
          <div className="premium-planner-section-head">
            <div>
              <span className="premium-planner-section-icon"><AlertTriangle aria-hidden="true" /></span>
              <div><h3 id="premium-planner-factors-title">Risk factors ranked</h3><p>Highest personal signals first</p></div>
            </div>
          </div>
          <div className="premium-planner-factor-list">
            {factorSignals.map((signal, index) => {
              const value = clampScore(signal.value) || 0;
              return (
                <div key={signal.key} className="premium-planner-factor">
                  <span className="premium-planner-factor-rank">{index + 1}</span>
                  <div>
                    <div className="premium-planner-factor-title"><strong>{signal.label}</strong><b>{signal.value}</b></div>
                    <div className="premium-planner-factor-track" aria-hidden="true"><i style={{ width: `${value}%` }} /></div>
                    <p>{signal.tip}</p>
                  </div>
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
              <div>
                <span className="premium-planner-section-icon"><History aria-hidden="true" /></span>
                <div><h3>Historical context</h3><p>Not enough driving history</p></div>
              </div>
              <span className="premium-planner-history-pill">Building</span>
            </div>
            <p className="premium-planner-history-copy">
              Complete a scored trip with recorded distance before a historical-context estimate is shown.
            </p>
          </section>
        ) : (
          <section className="premium-planner-history" data-state={predictiveRouteRisk.riskLevel} aria-labelledby="premium-planner-history-title">
            <div className="premium-planner-section-head">
              <div>
                <span className="premium-planner-section-icon"><History aria-hidden="true" /></span>
                <div>
                  <div className="premium-planner-history-heading">
                    <h3 id="premium-planner-history-title">Estimated historical context</h3>
                    {routeRiskApproximate && <CalibrationStatusTag />}
                  </div>
                  <p>{historyStatus}</p>
                </div>
              </div>
              <span className="premium-planner-history-score">{predictiveRouteRisk.riskScore}<small>/100</small></span>
            </div>
            <div className="premium-planner-history-summary">
              <p>{predictiveRouteRisk.primaryFactor}</p>
              <p><Clock3 aria-hidden="true" />{predictiveRouteRisk.safestWindow}</p>
              {predictiveRouteRisk.nearbyDangerZoneCount > 0 && (
                <p data-kind="warning"><MapPinned aria-hidden="true" />
                  {predictiveRouteRisk.nearbyDangerZoneCount} repeated event area{predictiveRouteRisk.nearbyDangerZoneCount === 1 ? '' : 's'} from your history nearby
                </p>
              )}
            </div>
            <div className="premium-planner-contributions" aria-label="Estimated historical context component breakdown">
              <h4>Signal contributions</h4>
              {(predictiveRouteRisk.componentBreakdown || []).map((component) => (
                <div key={component.key}>
                  <span><strong>{component.label}</strong><small>{component.detail}</small></span>
                  <b>+{component.contribution}</b>
                </div>
              ))}
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
