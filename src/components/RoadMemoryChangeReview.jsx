import { useState } from 'react';
import { AlertTriangle, CalendarClock, Check, History, MapPin, X } from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { getPrivacyZones } from '@/lib/privacyZones';
import { refreshTripsForLocalSpeedCorrections } from '@/lib/localSpeedScoreRefresh';
import { formatSpeed } from '@/lib/tripEngine';

const localDateInputValue = (value = Date.now()) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
};

export default function RoadMemoryChangeReview({
  candidates = [],
  onChanged = null,
  onFocus = null,
}) {
  const settings = useLocalSettings();
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [effectiveDates, setEffectiveDates] = useState({});
  const changes = candidates.filter((candidate) => candidate?.stage === 'change_review');
  const units = settings.units || 'metric';
  if (!changes.length) return null;

  const decide = async (candidate, action) => {
    if (busyId) return;
    setBusyId(candidate.id);
    setMessage('');
    try {
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const backendAction = action === 'accept_change' ? 'adjust_estimate' : action;
      const effectiveFromDate = effectiveDates[candidate.id] ||
        (candidate.changeDetection?.detectedAt
          ? localDateInputValue(candidate.changeDetection.detectedAt)
          : localDateInputValue());
      const result = await knowledge.reviewRoadMemoryCandidate(candidate.id, {
        action: backendAction,
        limitKmh: action === 'accept_change'
          ? Number(candidate.changeDetection?.proposedLimitKmh)
          : null,
        ...(action === 'accept_change' ? {
          effectiveFrom: new Date(`${effectiveFromDate}T00:00:00`).toISOString(),
          effectiveFromDate,
        } : {}),
        privacyZones: getPrivacyZones(settings),
      });
      if (!result) throw new Error('The Road Memory decision could not be saved.');
      let refreshedTrips = [];
      let refreshFailed = false;
      if (action !== 'defer') {
        try {
          refreshedTrips = await refreshTripsForLocalSpeedCorrections([
            candidate,
            ...(result.changedUsageCandidates || []),
          ]);
        } catch {
          refreshFailed = true;
        }
      }
      const refreshedCount = Array.isArray(refreshedTrips) ? refreshedTrips.length : 0;
      const queuedCount = Number(refreshedTrips ? Reflect.get(refreshedTrips, 'queuedTripCount') : 0) || 0;
      const rescoreText = refreshFailed
        ? 'The rule was saved, but matching-trip recalculation could not be verified.'
        : queuedCount > 0
          ? `${refreshedCount} trip score${refreshedCount === 1 ? '' : 's'} refreshed and ${queuedCount} queued.`
          : `${refreshedCount} matching trip score${refreshedCount === 1 ? '' : 's'} refreshed.`;
      setMessage(action === 'accept_change'
        ? `New estimate saved from ${new Date(`${effectiveFromDate}T00:00:00`).toLocaleDateString()}. Earlier trips keep the previous rule. ${rescoreText}`
        : action === 'keep_existing'
          ? `Change dismissed. The existing Road Memory speed remains in use. ${rescoreText}`
          : action === 'accept_time_profiles'
            ? `Time-specific pattern accepted. Road Memory will resolve the matching speed by time. ${rescoreText}`
            : 'Decision postponed. This corridor remains paused until reviewed.');
      await onChanged?.();
    } catch (error) {
      setMessage(error?.message || 'The Road Memory decision could not be saved.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/20">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 p-2 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div>
          <h2 className="font-grotesk text-lg font-bold">Possible speed changes</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Road Memory paused these corridors because recent independent drives disagree with the established speed. Nothing changes until you choose.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {changes.map((candidate) => {
          const change = candidate.changeDetection || {};
          const eligibleProfiles = (candidate.timeProfiles || []).filter((profile) => profile?.eligible === true);
          return (
            <article key={candidate.id} className="rounded-xl border border-amber-200 bg-background/85 p-3 dark:border-amber-900/50">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="font-semibold">{candidate.roadName || 'Local road corridor'}</div>
                  <div className="mt-1 text-sm font-bold">
                    {formatSpeed(Number(change.previousLimitKmh) || Number(candidate.limitKmh), units)} → {formatSpeed(Number(change.proposedLimitKmh) || 0, units)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1">
                      <History className="h-3 w-3" />
                      {Number(change.evidenceCount) || 0} recent supporting drives
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1">
                      <CalendarClock className="h-3 w-3" />
                      Detected {change.detectedAt ? new Date(change.detectedAt).toLocaleDateString() : 'recently'}
                    </span>
                    <span className="rounded-full bg-secondary px-2 py-1">
                      {candidate.directionLabel || 'Both directions'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onFocus?.(candidate)}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Show corridor
                </button>
              </div>
              {eligibleProfiles.length > 0 && (
                <div className="mt-2 rounded-lg bg-sky-50 px-2.5 py-2 text-[11px] text-sky-900 dark:bg-sky-950/30 dark:text-sky-100">
                  Stable time evidence: {eligibleProfiles.map((profile) => (
                    `${profile.bucket.replaceAll('_', ' ')} ${formatSpeed(profile.limitKmh, units)} (${profile.tripCount} drives)`
                  )).join(' · ')}
                </div>
              )}
              <label className="mt-3 grid max-w-xs gap-1 text-xs font-semibold text-amber-950 dark:text-amber-100">
                New speed effective from
                <input
                  type="date"
                  value={effectiveDates[candidate.id] || (
                    change.detectedAt
                      ? localDateInputValue(change.detectedAt)
                      : localDateInputValue()
                  )}
                  onChange={(event) => setEffectiveDates((current) => ({
                    ...current,
                    [candidate.id]: event.target.value,
                  }))}
                  className="rounded-lg border border-amber-300 bg-background px-2.5 py-2 text-foreground outline-none focus:border-amber-600 dark:border-amber-800"
                />
                <span className="font-normal text-muted-foreground">Earlier trips keep the previous speed; this date starts a new version.</span>
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => decide(candidate, 'accept_change')}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-amber-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  Accept {formatSpeed(Number(change.proposedLimitKmh) || 0, units)} estimate
                </button>
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => decide(candidate, 'keep_existing')}
                  className="min-h-10 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <X className="h-3.5 w-3.5" />
                    Dismiss change · keep {formatSpeed(Number(change.previousLimitKmh) || Number(candidate.limitKmh), units)}
                  </span>
                </button>
                {eligibleProfiles.length > 0 && (
                  <button
                    type="button"
                    disabled={Boolean(busyId)}
                    onClick={() => decide(candidate, 'accept_time_profiles')}
                    className="min-h-10 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
                  >
                    Use speeds by time
                  </button>
                )}
                <button
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => decide(candidate, 'defer')}
                  className="min-h-10 px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-50"
                >
                  Decide later
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {message && <p className="mt-3 text-xs font-semibold text-amber-900 dark:text-amber-100">{message}</p>}
    </section>
  );
}
