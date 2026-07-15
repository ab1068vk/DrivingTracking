import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Eye, Flag, Gauge,
  ShieldCheck, Sparkles, TrendingDown, TrendingUp, ChevronRight,
} from 'lucide-react';
import { formatDistance } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import {
  DeltaBadge, MethodNote, Notice, PanelHeader, signed, toneStyles,
} from '@/components/insights/InsightPrimitives';

export function PriorityFinding({
  analysis, units, hasExperiment, onInspect, onStartExperiment, onOpenTrip,
}) {
  const finding = analysis.primaryFinding;
  const TrendIcon = finding.tone === 'good'
    ? TrendingUp
    : finding.tone === 'warn' ? TrendingDown : Activity;
  return (
    <section className="overflow-hidden rounded-3xl border border-primary/20 bg-card shadow-sm">
      <div className="grid lg:grid-cols-[1.35fr_0.65fr]">
        <div className="p-5 md:p-7">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-primary">
            <Sparkles className="h-4 w-4" />
            Priority insight
          </div>
          <h2 className="mt-3 max-w-4xl font-grotesk text-2xl font-bold leading-tight md:text-4xl">
            {finding.headline}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
            {finding.explanation}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {finding.evidence.map((item) => (
              <span key={item} className="rounded-full border border-border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground">
                {item}
              </span>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" onClick={onInspect} className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              <Eye className="h-4 w-4" />
              Inspect mapped evidence
            </button>
            {!hasExperiment && (
              <button type="button" onClick={onStartExperiment} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-secondary">
                <Flag className="h-4 w-4" />
                Start 5-drive experiment
              </button>
            )}
            {finding.action?.tripId && (
              <button type="button" onClick={() => onOpenTrip(finding.action.tripId)} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-secondary">
                Open evidence trip
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <div className={`grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-1 lg:border-l lg:border-t-0 ${toneStyles[finding.tone] || toneStyles.neutral}`}>
          <HeroMetric
            icon={TrendIcon}
            label={analysis.privacySafeSnapshot ? 'Snapshot score' : 'Current score'}
            value={formatEstimatedScore(analysis.currentScore)}
            detail={analysis.privacySafeSnapshot
              ? 'Stored score evidence; trend protected'
              : analysis.comparisonAvailable ? `${signed(analysis.scoreDelta, ' pts')} vs prior period` : 'Comparison building'}
          />
          <HeroMetric
            icon={AlertTriangle}
            label="Risk density"
            value={analysis.currentEventRate == null ? '-' : analysis.currentEventRate}
            detail={analysis.currentEventRate == null ? 'Distance needed' : `events per 100 km / ${formatDistance(analysis.riskRate.distance_km, units)}`}
          />
          <HeroMetric
            icon={ShieldCheck}
            label={analysis.privacySafeSnapshot ? 'Stored evidence' : 'Personal baseline'}
            value={analysis.privacySafeSnapshot
              ? `${analysis.dataQuality.availableEligibleTrips} trips`
              : formatEstimatedScore(analysis.baseline.baseline_avg)}
            detail={analysis.privacySafeSnapshot
              ? 'Privacy-masked trips loaded; baseline trend disabled'
              : analysis.baseline.baseline_avg == null
                ? 'More comparable trips needed'
                : `${analysis.baseline.baseline_trip_count} trips / ${analysis.baseline.baseline_confidence}`}
          />
        </div>
      </div>
    </section>
  );
}
function HeroMetric({ icon: Icon, label, value, detail }) {
  return (
    <div className="bg-card/90 p-4 md:p-5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 font-grotesk text-3xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

export function ScoreMovementPanel({ analysis }) {
  const hasStoredComponents = analysis.scoreMovement.some((row) => row.current != null);
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow={analysis.comparisonAvailable ? 'What changed' : 'Stored score evidence'}
        title={analysis.comparisonAvailable ? 'Headline score movement' : 'Headline score components'}
        description={analysis.comparisonAvailable
          ? 'Estimated component effects use the active scoring blend and comparable distance. Eco remains separately reported.'
          : 'Current stored component values remain useful even when a protected historical comparison is unavailable.'}
        icon={BarChart3}
      />
      {!hasStoredComponents ? (
        <Notice text="No stored component scores are available in the loaded trips." />
      ) : (
        <div className="mt-5 space-y-4">
          {analysis.scoreMovement.map((row) => (
            <div key={row.id}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm font-semibold">{row.label}</span>
                  {row.note && <span className="ml-2 text-[10px] text-muted-foreground">{row.note}</span>}
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground">
                    {analysis.comparisonAvailable
                      ? `${row.previous ?? '-'} to ${row.current ?? '-'}`
                      : `Stored ${row.current ?? '-'}`}
                  </span>
                  {analysis.comparisonAvailable && (
                    <DeltaBadge value={row.estimatedImpact ?? row.delta} suffix={row.estimatedImpact != null ? ' est.' : ''} />
                  )}
                </div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full ${
                    analysis.comparisonAvailable && row.delta > 0
                      ? 'bg-emerald-500'
                      : analysis.comparisonAvailable && row.delta < 0 ? 'bg-orange-500' : 'bg-primary'
                  }`}
                  style={{ width: `${Math.max(2, row.current || 0)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <MethodNote>
        {analysis.comparisonAvailable
          ? 'These are explainable associations from recorded score components, not claims that one behavior alone caused the full score change.'
          : 'These are recorded component values. No improvement or decline claim is made without an eligible comparison period.'}
      </MethodNote>
    </section>
  );
}
export function EventMovementPanel({ analysis, onOpenTrip }) {
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Why"
        title="Normalized risk drivers"
        description="Event rates are normalized per 100 km so longer weeks do not automatically look worse."
        icon={Gauge}
      />
      <div className="mt-5 space-y-2">
        {analysis.eventMovement.map((row) => (
          <button
            key={row.id}
            type="button"
            disabled={!row.latestTripId}
            onClick={() => row.latestTripId && onOpenTrip(row.latestTripId)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border p-3 text-left transition hover:border-primary/40 disabled:cursor-default"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">{row.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {row.currentCount} events / {row.currentRate == null ? 'rate unavailable' : `${row.currentRate}/100 km`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${
                row.direction === 'better'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : row.direction === 'worse'
                    ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                    : 'bg-secondary text-muted-foreground'
              }`}>
                {row.direction}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

export function EvidencePanel({ analysis, units, onOpenTrip }) {
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Proof"
        title="Trips behind this finding"
        description={analysis.topEvent
          ? `Trips with the most ${analysis.topEvent.label.toLowerCase()} evidence in this period.`
          : 'No dominant event needs inspection.'}
        icon={Eye}
      />
      {analysis.evidenceTrips.length === 0 ? (
        <Notice text="There are no event-heavy trips to inspect in the selected period." />
      ) : (
        <div className="mt-5 space-y-2">
          {analysis.evidenceTrips.map((trip, index) => (
            <button
              key={trip.id}
              type="button"
              onClick={() => onOpenTrip(trip.id)}
              className="flex w-full items-center gap-3 rounded-2xl border border-border p-3 text-left transition hover:border-primary/40 hover:bg-secondary/30"
            >
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-orange-100 text-sm font-bold text-orange-700 dark:bg-orange-950/40 dark:text-orange-300">
                {index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">
                  {new Date(trip.startTime).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDistance(trip.distanceKm, units)} ? score {formatEstimatedScore(trip.score)}
                </div>
              </div>
              <div className="text-right">
                <div className="font-grotesk text-xl font-bold">{trip.eventCount}</div>
                <div className="text-[10px] text-muted-foreground">events</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 rounded-2xl border border-border bg-secondary/25 p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended cue</div>
        <div className="mt-1 text-sm">{analysis.topEvent?.cue || 'Repeat the calm setup from a strong recent trip.'}</div>
      </div>
    </section>
  );
}
