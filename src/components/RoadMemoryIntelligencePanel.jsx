import { useMemo, useState } from 'react';
import { BrainCircuit, Check, MapPin, Pencil, ShieldCheck, ThumbsDown } from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { getPrivacyZones } from '@/lib/privacyZones';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import {
  analyzeRoadMemoryIntelligence,
  buildRoadMemoryActivity,
} from '@/lib/roadMemoryIntelligence';
import { formatSpeed } from '@/lib/tripEngine';
import { convertDisplaySpeedToKmh, convertSpeedKmh, speedUnitLabel } from '@/lib/unitFormatting';

const modelStatus = (calibration = {}) => {
  if (calibration.status === 'validated') {
    return {
      label: 'Validated locally',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
      text: `Parked decisions agree with Road Memory ${Math.round(Number(calibration.exactRate) * 100)}% of the time. Only strong corridors may affect estimates, scores, and alerts.`,
    };
  }
  if (calibration.status === 'needs_tuning') {
    return {
      label: 'Needs tuning',
      className: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100',
      text: 'Your parked decisions show that the current behavior-based suggestions are not reliable enough. Every Road Memory corridor remains blocked from scores and alerts.',
    };
  }
  return {
    label: 'Learning in shadow mode',
    className: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
    text: calibration.parkedValidationPassed && !calibration.shadowValidationPassed
      ? `${calibration.shadowDriveCount} of ${calibration.shadowDriveTarget} private drives evaluated in shadow mode. Suggestions stay blocked until the drive sample is broad enough.`
      : calibration.feedbackCount > 0
      ? `${calibration.feedbackCount} of 8 parked decisions collected. Suggestions stay visible but cannot affect scores, voice alerts, or live speed until validation passes.`
      : 'Road Memory is finding repeated GPS corridors, but it has not been tested against any parked posted-sign decisions yet. Suggestions cannot affect scores or alerts.',
  };
};

export default function RoadMemoryIntelligencePanel({
  candidates = [],
  onChanged = null,
  onFocus = null,
}) {
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [busyId, setBusyId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [adjustedLimit, setAdjustedLimit] = useState('');
  const [message, setMessage] = useState('');
  const analysis = useMemo(() => analyzeRoadMemoryIntelligence(candidates, { reviewLimit: 5 }), [candidates]);
  const summary = analysis.summary;
  const queue = analysis.queue;
  const status = modelStatus(summary.calibration);
  const activity = useMemo(() => buildRoadMemoryActivity(candidates, { limit: 6 }), [candidates]);

  const startAdjust = (candidate) => {
    setEditingId(candidate.id);
    setAdjustedLimit(String(Math.round(convertSpeedKmh(candidate.limitKmh, units))));
    setMessage('');
  };

  const decide = async (candidate, action) => {
    if (busyId) return;
    const backendAction = action === 'confirm_adjusted_posted' ? 'confirm_posted' : action;
    let nextLimit = Number(candidate.limitKmh);
    if (action === 'adjust_estimate' || action === 'confirm_adjusted_posted') {
      const displayed = Number(adjustedLimit);
      nextLimit = convertDisplaySpeedToKmh(displayed, units);
      if (!Number.isFinite(nextLimit) || nextLimit <= 0 || nextLimit > MAX_SAVED_SPEED_LIMIT_KMH) {
        setMessage('Enter a valid road speed before saving the adjustment.');
        return;
      }
    }
    setBusyId(candidate.id);
    setMessage('');
    try {
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const result = await knowledge.reviewRoadMemoryCandidate(candidate.id, {
        action: backendAction,
        limitKmh: nextLimit,
        privacyZones: getPrivacyZones(settings),
      });
      if (!result) throw new Error('This decision could not be saved.');
      if (backendAction === 'confirm_posted' || backendAction === 'adjust_estimate') {
        await import('@/lib/localSpeedScoreRefresh')
          .then(({ refreshTripsForLocalSpeedCorrections }) => refreshTripsForLocalSpeedCorrections([
            candidate,
            ...(result.changedUsageCandidates || []),
          ]))
          .catch(() => null);
      } else if (result.changedUsageCandidates?.length) {
        await import('@/lib/localSpeedScoreRefresh')
          .then(({ refreshTripsForLocalSpeedCorrections }) => refreshTripsForLocalSpeedCorrections(result.changedUsageCandidates))
          .catch(() => null);
      }
      setEditingId('');
      setMessage(backendAction === 'confirm_posted'
        ? 'Posted limit saved. This confirmation also trained the private reliability check.'
        : action === 'adjust_estimate'
          ? 'Adjusted limit saved. The difference was recorded as private model feedback.'
          : 'Suggestion rejected. It will not affect this corridor, and the rejection will make future review ordering smarter.');
      await onChanged?.();
    } catch (error) {
      setMessage(error?.message || 'This decision could not be saved.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="rounded-2xl border border-sky-200 bg-card p-4 shadow-sm dark:border-sky-900/60" aria-label="Road Memory intelligence status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl bg-sky-100 p-2 text-sky-700 dark:bg-sky-950/60 dark:text-sky-200">
            <BrainCircuit className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-grotesk text-lg font-bold">Road Memory intelligence</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{status.text}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${status.className}`}>
          {status.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-secondary/50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Parked checks</div>
          <div className="mt-1 text-lg font-bold">{summary.calibration.feedbackCount}/8</div>
        </div>
        <div className="rounded-xl bg-secondary/50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Exact agreement</div>
          <div className="mt-1 text-lg font-bold">
            {summary.calibration.feedbackCount ? `${Math.round(summary.calibration.exactRate * 100)}%` : '—'}
          </div>
        </div>
        <div className="rounded-xl bg-secondary/50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Shadow drives</div>
          <div className="mt-1 text-lg font-bold">{summary.calibration.shadowDriveCount}/{summary.calibration.shadowDriveTarget}</div>
        </div>
        <div className="rounded-xl bg-secondary/50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Validated active</div>
          <div className="mt-1 flex items-center gap-1.5 text-lg font-bold">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />{summary.validatedCount}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-background/70 p-3" aria-label="Recent Road Memory activity">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Recent Road Memory activity</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Visible proof of what the system learned, paused, accepted, or dismissed.</p>
          </div>
          <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground">{activity.length} events</span>
        </div>
        {activity.length ? (
          <div className="mt-2 divide-y divide-border">
            {activity.map((entry) => (
              <div key={`${entry.id}:${entry.type}`} className="flex items-start gap-2 py-2 first:pt-1 last:pb-0">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  ['confirmed', 'adjusted'].includes(entry.type)
                    ? 'bg-emerald-500'
                    : ['warning', 'deferred'].includes(entry.type)
                      ? 'bg-amber-500'
                      : entry.type === 'rejected'
                        ? 'bg-rose-500'
                        : 'bg-sky-500'
                }`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-xs font-semibold">{entry.title}</span>
                    {entry.timestamp && <span className="text-[10px] text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span>}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{entry.detail}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 rounded-lg bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">No Road Memory activity yet. Completed public-corridor drives will appear here when evidence changes.</p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Most useful parked checks</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">At most five high-information corridors are shown; the full map evidence stays available in Filters.</p>
        </div>
        <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground">
          {queue.items.length} prioritized
        </span>
      </div>

      {queue.items.length === 0 ? (
        <div className="mt-2 rounded-xl border border-border bg-secondary/20 px-3 py-3 text-xs text-muted-foreground">
          No useful Road Memory check is ready. Normal trips will continue building private corridor evidence.
        </div>
      ) : (
        <div className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background/70">
          {queue.items.map(({ candidate, why, expectedImpact }) => {
            const editing = editingId === candidate.id;
            return (
              <article key={candidate.id} className="px-3 py-2.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{candidate.roadName || `Local corridor ${String(candidate.geohash || '').slice(0, 6)}`}</span>
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                        GPS behavior suggests {formatSpeed(candidate.limitKmh, units)}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{why} {expectedImpact}</p>
                    <div className="mt-1 text-[10px] font-semibold text-muted-foreground">
                      {Number(candidate.tripCount) || 0} drives · {Math.round((Number(candidate.agreement) || 0) * 100)}% agreement · {Math.round((Number(candidate.uncertainty) || 0) * 100)}% uncertainty · score and alerts {candidate.canAffectScoreAndAlerts ? 'active' : 'blocked'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onFocus?.(candidate)}
                    className="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-semibold hover:bg-secondary"
                  >
                    <MapPin className="h-3.5 w-3.5" /> Map
                  </button>
                </div>
                {editing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-secondary/40 px-2.5 py-2">
                    <label htmlFor={`memory-adjust-${candidate.id}`} className="text-[11px] font-semibold">Posted speed</label>
                    <input
                      id={`memory-adjust-${candidate.id}`}
                      type="number"
                      min="1"
                      max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units))}
                      inputMode="numeric"
                      value={adjustedLimit}
                      onChange={(event) => setAdjustedLimit(event.target.value)}
                      className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm"
                    />
                    <span className="text-[11px] text-muted-foreground">{speedUnitLabel(units)}</span>
                    <button
                      type="button"
                      disabled={Boolean(busyId)}
                      onClick={() => decide(candidate, 'confirm_adjusted_posted')}
                      className="min-h-9 rounded-lg bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
                    >Save correction</button>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => decide(candidate, 'confirm_posted')}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-sky-700 px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" /> Matches posted sign
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => startAdjust(candidate)}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-semibold disabled:opacity-50"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Different speed
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => decide(candidate, 'reject')}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold text-muted-foreground disabled:opacity-50"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" /> Not reliable
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {message && <p className="mt-2 text-xs font-semibold text-sky-800 dark:text-sky-200">{message}</p>}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Private model inputs: this device’s public-corridor GPS geometry, repeated-drive behavior, and your parked decisions. The shadow evaluator uses up to the latest 90 distinct evidence drives and requires at least 20. Road Memory calibration does not query or depend on OSM.
      </p>
    </section>
  );
}
