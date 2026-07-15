import {
  Activity, AlertTriangle, CheckCircle2, CircleDot, Database, Flag,
  ShieldCheck, X, ArrowRight, ChevronRight,
} from 'lucide-react';
import {
  MiniMetric, Notice, PanelHeader, signed, toneStyles,
} from '@/components/insights/InsightPrimitives';

export function ExperimentPanel({
  candidate, experiment, progress, onStart, onCancel, onOpenTrip,
}) {
  const active = experiment || candidate;
  return (
    <section className="rounded-3xl border border-primary/20 bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow={experiment ? 'Active experiment' : 'Recommended experiment'}
        title={active.title}
        description="Only route/time/distance-comparable drives count. Results show exclusions, evidence validity, and a 95% effect interval when supported."
        icon={Flag}
        action={experiment ? (
          <button type="button" onClick={onCancel} aria-label="End experiment" className="rounded-full border border-border p-2 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      />
      <div className="mt-5 rounded-2xl bg-primary/5 p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-primary">Driving cue</div>
        <div className="mt-1 text-sm font-semibold">{active.cue}</div>
      </div>
      <ol className="mt-4 space-y-2">
        {(active.steps || []).map((step, index) => (
          <li key={step} className="flex items-start gap-3 text-sm">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold">{index + 1}</span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      {experiment && progress ? (
        <div className="mt-5 border-t border-border pt-5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">{progress.tripCount}/{progress.targetTrips} drives complete</span>
            <span className="capitalize text-muted-foreground">{progress.status}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full ${progress.targetMet ? 'bg-emerald-500' : 'bg-primary'}`}
              style={{ width: `${progress.progressPct}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <MiniMetric label="Baseline" value={experiment.baseline ?? '-'} />
            <MiniMetric label="Current" value={progress.currentValue ?? '-'} />
            <MiniMetric label="Improvement" value={progress.improvement == null ? 'Pending' : signed(progress.improvement)} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MiniMetric label="Evidence validity" value={progress.validity || 'collecting'} />
            <MiniMetric label="Excluded drives" value={progress.excludedTripCount || 0} />
          </div>
          {progress.confidenceInterval && (
            <div className="mt-3 rounded-2xl bg-secondary/35 p-3 text-xs text-muted-foreground">
              95% effect interval: {signed(progress.confidenceInterval.lower)} to {signed(progress.confidenceInterval.upper)}.
              {progress.statisticallyClear ? ' The observed direction is statistically clear.' : ' More matched distance is needed for a clear result.'}
            </div>
          )}
          {progress.tripIds.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {progress.tripIds.map((id, index) => (
                <button key={id} type="button" onClick={() => onOpenTrip(id)} className="rounded-full border border-border px-2.5 py-1 text-xs font-semibold hover:bg-secondary">
                  Drive {index + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={onStart} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
          Start matched experiment
          <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}

export function DriverSignaturePanel({ signature }) {
  const labels = {
    aggression: 'Aggression',
    smoothness: 'Smoothness',
    ecoMindedness: 'Eco-mindedness',
    powertrainStress: 'Powertrain stress',
    speedTolerance: 'Speed tolerance',
    brakingStyle: 'Braking control',
    consistencyIdx: 'Consistency',
  };
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Long-term pattern"
        title={signature ? String(signature.archetype).replace(/_/g, ' ') : 'Driving signature is developing'}
        description={signature
          ? `${signature.trip_count_used} recent trips shape this private, on-device profile.`
          : 'Complete five scored trips to build a stable multidimensional signature.'}
        icon={CircleDot}
      />
      {!signature ? (
        <Notice text="The signature waits for enough evidence instead of guessing from one or two drives." />
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {Object.entries(signature.dimensions).map(([key, value]) => (
            <div key={key} className="rounded-2xl bg-secondary/35 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{labels[key] || key}</span>
                <span className="font-bold">{value == null ? '-' : Math.round(value * 100)}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background">
                <div className="h-full rounded-full bg-primary" style={{ width: `${value == null ? 0 : value * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function SupportingFindings({ findings, onOpenTrip }) {
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Watch list"
        title="Supporting findings"
        description="Lower-priority changes stay visible without competing with the main recommendation."
        icon={Activity}
      />
      {findings.length === 0 ? (
        <Notice text="No secondary change has crossed the evidence threshold." />
      ) : (
        <div className="mt-5 grid gap-2">
          {findings.map((finding) => (
            <button
              key={finding.id}
              type="button"
              disabled={!finding.tripId}
              onClick={() => finding.tripId && onOpenTrip(finding.tripId)}
              className={`flex items-start gap-3 rounded-2xl border p-3 text-left ${toneStyles[finding.tone] || toneStyles.neutral}`}
            >
              {finding.tone === 'good'
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                : finding.tone === 'warn'
                  ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  : <Activity className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold capitalize">{finding.title}</span>
                <span className="mt-0.5 block text-xs opacity-80">{finding.detail}</span>
              </span>
              {finding.tripId && <ChevronRight className="mt-0.5 h-4 w-4" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function DataConfidence({ quality }) {
  const rows = [
    { label: 'Scored-trip coverage', value: quality.scoredCoveragePct, detail: `${quality.scoredTrips} scored trips` },
    { label: 'Route evidence', value: quality.routeCoveragePct, detail: `${quality.routeTrips} replayable routes` },
    { label: 'Phone-use evidence', value: quality.phoneCoveragePct, detail: `${quality.phoneMeasuredTrips} measured trips` },
  ];
  return (
    <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
      <PanelHeader
        eyebrow="Trust layer"
        title="Data confidence"
        description={quality.privacySafeSnapshot
          ? 'Stored trip evidence is loaded below. Protected time, day, baseline, and improvement trends remain disabled.'
          : 'Coverage and exclusions are shown so a precise-looking number never hides weak evidence.'}
        icon={Database}
      />
      {quality.privacySafeSnapshot && (
        <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm">
          <div className="font-semibold">{quality.availableEligibleTrips} existing trips are available</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Scores, event rates, component evidence, and masked routes can be inspected without using privacy-zone-touched days for historical trend claims.
          </div>
        </div>
      )}
      <div className="mt-5 space-y-4">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold">{row.label}</span>
              <span className="text-muted-foreground">{row.value}% / {row.detail}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary" style={{ width: `${row.value}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <MiniMetric label="Scoring evidence" value={String(quality.scoringConfidence || 'unknown').replace(/_/g, ' ')} />
        <MiniMetric label="Score version" value={quality.scoringVersion || 'mixed'} />
        <MiniMetric label="Trend-protected trips" value={quality.privacyExcludedTrips} />
        <MiniMetric label="Passenger exclusions" value={quality.passengerExcludedTrips} />
      </div>
      <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        {quality.privacySafeSnapshot
          ? 'Analysis remains local. Stored summaries and privacy-masked routes are shown, while protected historical trend categories stay excluded.'
          : 'Analysis remains local. Privacy-touched days and passenger trips are excluded from driver trends.'}
      </div>
    </section>
  );
}
