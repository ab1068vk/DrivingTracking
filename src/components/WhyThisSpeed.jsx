import { Clock3, GitBranch, Info, Volume2, Gauge } from 'lucide-react';
import { buildSpeedEvidenceDecision } from '@/lib/speedEvidenceReasoning';

const STATUS_PRESENTATION = {
  invalid_condition: {
    label: 'Condition incomplete',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
};

export default function WhyThisSpeed({ record = {}, context = {}, compact = true, className = '' }) {
  const decision = buildSpeedEvidenceDecision(record, context);
  const status = STATUS_PRESENTATION[decision.status] || {
    label: decision.status,
    className: 'border-transparent bg-secondary text-muted-foreground',
  };
  return (
    <details className={`rounded-xl border border-border/80 bg-background/70 ${compact ? 'px-3 py-2' : 'p-3'} ${className}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5"><Info className="h-3.5 w-3.5 text-primary" />Why this speed?</span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${status.className}`}>{status.label}</span>
      </summary>
      <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <p><strong className="text-foreground">Authority:</strong> {decision.authorityLabel}</p>
        <p>{decision.why}</p>
        <div className="rounded-lg border border-border/70 bg-secondary/35 px-2.5 py-2">
          <div className="inline-flex items-center gap-1.5 font-semibold text-foreground">
            <Clock3 className="h-3.5 w-3.5" />
            Applicability: {decision.applicability.label}
          </div>
          <p className="mt-1">{decision.applicability.detail}</p>
        </div>
        {decision.provenance.entries.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-secondary/35 px-2.5 py-2">
            <div className="inline-flex items-center gap-1.5 font-semibold text-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              Resolver provenance
            </div>
            <p className="mt-1">{decision.provenance.summary}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {decision.ledger.map((entry) => <span key={entry} className="rounded-full bg-secondary px-2 py-1">{entry}</span>)}
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />Score: {decision.canAffectScore ? 'active' : 'blocked'}</span>
          <span className="inline-flex items-center gap-1.5"><Volume2 className="h-3.5 w-3.5" />Alerts: {decision.canAffectVoiceAlerts ? 'active' : 'blocked'}</span>
        </div>
        <p>{decision.consequence}</p>
      </div>
    </details>
  );
}
