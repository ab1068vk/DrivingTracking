import {
  Activity, ArrowRight, BrainCircuit, CheckCircle2, GitCompareArrows,
  ShieldAlert, Sparkles, TrendingDown, TrendingUp,
} from 'lucide-react';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { formatPerDistanceRate } from '@/lib/unitFormatting';
import { MiniMetric, Notice, PanelHeader, signed } from '@/components/insights/InsightPrimitives';

export function MatchedComparisonPanel({ matched, onOpenTrip, units = 'metric' }) {
  const tone = matched.scoreDelta > 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : matched.scoreDelta < 0 ? 'text-orange-600 dark:text-orange-400' : 'text-foreground';
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Controlled comparison"
        title="Matched trip pairs"
        description="Pairs prioritize the same route, time window, distance, road context, vehicle, and weekday class."
        icon={GitCompareArrows}
      />
      {matched.matchedTripCount === 0 ? (
        <Notice text="No sufficiently similar trips exist in both adjacent periods yet. Unmatched trips are not used to claim improvement." />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniMetric label="Matched pairs" value={`${matched.matchedTripCount}/${matched.eligibleTripCount}`} />
            <MiniMetric label="Coverage" value={`${matched.coveragePct}%`} />
            <MiniMetric label="Score change" value={signed(matched.scoreDelta, ' pts')} />
            <MiniMetric label="Confidence" value={matched.confidence} />
          </div>
          <div className="mt-4 rounded-2xl border border-border bg-secondary/25 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Matched result</div>
                <div className={`mt-1 font-grotesk text-3xl font-bold ${tone}`}>{signed(matched.scoreDelta, ' pts')}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatEstimatedScore(matched.baselineScore)} baseline to {formatEstimatedScore(matched.currentScore)} current
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Event density</div>
                <div className="mt-1 text-lg font-bold">{formatPerDistanceRate(matched.eventRateDelta, units, { digits: 1 })}</div>
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {matched.pairs.slice(0, 5).map((pair) => (
              <div key={`${pair.currentTripId}-${pair.baselineTripId}`} className="rounded-2xl border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{pair.matchQuality}% context match</div>
                    <div className="mt-1 text-xs text-muted-foreground">{pair.why.join(' / ')}</div>
                  </div>
                  <div className={`text-sm font-bold ${pair.scoreDelta > 0 ? 'text-emerald-600' : pair.scoreDelta < 0 ? 'text-orange-600' : ''}`}>
                    {signed(pair.scoreDelta, ' pts')}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => onOpenTrip(pair.currentTripId)} className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                    Current trip
                  </button>
                  <button type="button" onClick={() => onOpenTrip(pair.baselineTripId)} className="rounded-full border border-border px-3 py-1 text-xs font-semibold hover:bg-secondary">
                    Baseline trip
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function AttributionLedgerPanel({ attribution, onOpenTrip }) {
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Exact composition"
        title="Headline contribution ledger"
        description="Reconstructs the configured headline blend from stored component scores. Supporting drivers remain evidence, not invented point deductions."
        icon={BrainCircuit}
      />
      {attribution.rows.length === 0 ? (
        <Notice text="Stored component scores are unavailable for this period." />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <MiniMetric label="Recorded" value={formatEstimatedScore(attribution.recordedScore)} />
            <MiniMetric label="Reconstructed" value={formatEstimatedScore(attribution.reconstructedScore)} />
            <MiniMetric label="Difference" value={signed(attribution.reconstructionDelta, ' pts')} />
          </div>
          <div className={`mt-3 flex items-start gap-2 rounded-2xl border p-3 text-xs ${
            attribution.exactBlend
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-200'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-200'
          }`}>
            {attribution.exactBlend ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
            {attribution.exactBlend
              ? 'The stored components reproduce the recorded headline within rounding tolerance.'
              : 'Some historical trips are missing a component or use older provenance; the difference is shown instead of hidden.'}
          </div>
          <div className="mt-5 space-y-4">
            {attribution.rows.map((row) => (
              <div key={row.id}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-semibold">{row.label}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground">{row.availableTrips} trips</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-bold">{row.averageContribution} pts supplied</span>
                    <span className="ml-2 text-xs text-orange-600">{row.averageDeficit} missing</span>
                  </div>
                </div>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-secondary">
                  <div className="bg-primary" style={{ width: `${Math.max(0, row.averageContribution)}%` }} />
                  <div className="bg-orange-400" style={{ width: `${Math.max(0, row.averageDeficit)}%` }} />
                </div>
              </div>
            ))}
          </div>
          {attribution.supportingDrivers.length > 0 && (
            <div className="mt-5 border-t border-border pt-4">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Stored supporting evidence</div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {attribution.supportingDrivers.slice(0, 4).map((driver) => (
                  <button
                    key={driver.factor}
                    type="button"
                    disabled={!driver.tripIds[0]}
                    onClick={() => driver.tripIds[0] && onOpenTrip(driver.tripIds[0])}
                    className="rounded-2xl bg-secondary/35 p-3 text-left hover:bg-secondary"
                  >
                    <div className="text-sm font-semibold">{driver.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{driver.occurrences} trip occurrences / {driver.category}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ChangeForecastPanel({ changePoint, forecast, onOpenTrip }) {
  const ForecastIcon = forecast.riskLevel === 'low' ? TrendingUp : forecast.riskLevel === 'high' ? TrendingDown : Activity;
  return (
    <section className="grid gap-5 lg:grid-cols-2">
      <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
        <PanelHeader
          eyebrow="Persistent change"
          title={changePoint ? `Driving ${changePoint.direction}` : 'No persistent shift detected'}
          description="Scans rolling groups of comparable scored trips and reports only changes of at least five points."
          icon={Sparkles}
        />
        {!changePoint ? (
          <Notice text="Recent variation has not crossed the persistent-change threshold." />
        ) : (
          <div className="mt-5">
            <div className={`font-grotesk text-4xl font-bold ${changePoint.delta > 0 ? 'text-emerald-600' : 'text-orange-600'}`}>
              {signed(changePoint.delta, ' pts')}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Beginning {new Date(changePoint.at).toLocaleDateString()}, four-trip average moved from {changePoint.beforeScore} to {changePoint.afterScore}.
            </div>
            <div className="mt-3 rounded-2xl bg-secondary/40 p-3 text-xs">
              {changePoint.persisted ? 'The shift persisted in later trips.' : 'The shift is meaningful but has not persisted long enough to confirm.'}
            </div>
            <button type="button" onClick={() => onOpenTrip(changePoint.tripId)} className="mt-4 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-secondary">
              Open first changed trip <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-primary/20 bg-card p-5 shadow-sm">
        <PanelHeader
          eyebrow="Before the next drive"
          title="Readiness forecast"
          description="A probabilistic readiness estimate from personal time, day, trend, recent-trip, fatigue, route, and hotspot evidence."
          icon={ForecastIcon}
        />
        {forecast.readinessScore == null ? (
          <Notice text="Core personal-history signals are incomplete, so Road Sage is refusing to manufacture a readiness score." />
        ) : (
          <div className="mt-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="font-grotesk text-5xl font-bold">{forecast.readinessScore}</div>
                <div className="mt-1 text-xs text-muted-foreground">readiness / 100 / {forecast.riskLevel} risk</div>
              </div>
              <span className="rounded-full border border-border px-3 py-1 text-xs font-bold capitalize">{forecast.dataQuality.readinessEvidence} evidence</span>
            </div>
            <div className="mt-5 rounded-2xl bg-primary/5 p-4">
              <div className="text-xs font-bold uppercase tracking-wide text-primary">Primary concern</div>
              <div className="mt-1 text-sm font-semibold">{forecast.primaryConcern}</div>
              <div className="mt-1 text-xs text-muted-foreground">{forecast.tipText}</div>
            </div>
            {forecast.topSignals.length > 0 && (
              <div className="mt-4 space-y-2">
                {forecast.topSignals.map((signal) => (
                  <div key={signal.key} className="flex items-center justify-between rounded-xl bg-secondary/35 px-3 py-2 text-xs">
                    <span className="font-medium">{signal.label}</span>
                    <span className="font-bold">{signal.value}/100 risk</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
