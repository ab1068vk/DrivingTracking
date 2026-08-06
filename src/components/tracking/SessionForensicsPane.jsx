import { useMemo } from 'react';
import { ClipboardList } from 'lucide-react';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import {
  UNAVAILABLE,
  buildSessionForensics,
  countAvailableForensics,
} from '@/lib/trackingSessionForensics';

const toneClass = (tone) => {
  if (tone === 'warn') return 'text-amber-700 dark:text-amber-300';
  if (tone === 'good') return 'text-emerald-700 dark:text-emerald-300';
  if (tone === 'muted') return 'text-muted-foreground';
  return 'text-foreground';
};

function ForensicsBody({ trip }) {
  const groups = useMemo(() => buildSessionForensics(trip), [trip]);
  const available = useMemo(() => countAvailableForensics(groups), [groups]);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card/60">
      <div className="flex items-start gap-2 border-b border-border bg-secondary/30 px-3 py-2">
        <ClipboardList className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Session forensics</h2>
          <p className="text-xs text-muted-foreground">
            {available} of {total} signals recorded. Why recording started and stopped, how much of the drive GPS
            covered, and which detectors degraded. Read from stored evidence — nothing here re-runs scoring.
          </p>
        </div>
      </div>
      <div className="divide-y divide-border/70">
        {groups.map((group) => (
          <div key={group.id} className="px-3 py-3">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{group.title}</h3>
            <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {group.rows.map((row) => (
                <div key={row.id} className="min-w-0 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className={`text-right font-mono font-semibold ${toneClass(row.tone)}`}>{row.value}</dd>
                  </div>
                  {row.detail && (
                    <p className={`mt-1 leading-relaxed ${row.value === UNAVAILABLE ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>
                      {row.detail}
                    </p>
                  )}
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function SessionForensicsPane({ trip }) {
  if (!trip) return null;
  return (
    <SectionErrorBoundary
      context="tracking_session_forensics"
      title="Session forensics unavailable"
      message="Something went wrong while reading this trip's recording evidence. The rest of the trip is still available."
      resetKey={trip.id}
    >
      <ForensicsBody trip={trip} />
    </SectionErrorBoundary>
  );
}
