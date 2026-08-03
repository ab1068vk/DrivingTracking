import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Clock3, Gauge, Pencil, X } from 'lucide-react';
import useLocalSettings from '@/hooks/useLocalSettings';
import { getPrivacyZones } from '@/lib/privacyZones';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import { formatSpeed } from '@/lib/tripEngine';
import {
  convertDisplaySpeedToKmh,
  convertSpeedKmh,
  speedUnitLabel,
} from '@/lib/unitFormatting';

export const roadMemoryCandidateReviewableForTrip = (candidate, tripId) => {
  if (!candidate || !tripId) return false;
  if (!['suggested', 'operational', 'change_review'].includes(candidate.stage)) return false;
  if (!(candidate.tripIds || []).map(String).includes(String(tripId))) return false;
  if (['confirmed', 'adjusted', 'rejected'].includes(candidate.reviewState)) return false;
  if (
    ['deferred', 'kept_existing'].includes(candidate.reviewState) &&
    Number(candidate.tripCount) <= Number(candidate.lastPromptedTripCount)
  ) return false;
  return true;
};

const stageText = (candidate, units) => {
  if (candidate.stage === 'change_review') {
    return `Recent drives suggest ${formatSpeed(candidate.changeDetection?.proposedLimitKmh, units)} instead of ${formatSpeed(candidate.changeDetection?.previousLimitKmh, units)}. Scoring and alerts are paused for this section.`;
  }
  if (candidate.stage === 'operational') {
    return candidate.canAffectScoreAndAlerts
      ? 'This locally validated estimate can affect scoring and alerts at reduced authority until you confirm or adjust it.'
      : candidate.validationReason || 'This strong suggestion is still in shadow mode and cannot affect scoring or alerts.';
  }
  return 'This is still an exploration suggestion and does not affect scoring or alerts yet.';
};

export default function RoadMemoryQuickReview({ trip }) {
  const settings = useLocalSettings();
  const [candidates, setCandidates] = useState([]);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustedLimit, setAdjustedLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    if (!trip?.id) {
      setCandidates([]);
      return undefined;
    }
    const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
    knowledge.listRoadMemoryCandidates({ activeOnly: false })
      .then((items) => {
        if (!active) return;
        setCandidates(items
          .filter((candidate) => roadMemoryCandidateReviewableForTrip(candidate, trip.id))
          .sort((a, b) => (
            Number(b.stage === 'change_review') - Number(a.stage === 'change_review') ||
            Number(b.tripCount) - Number(a.tripCount)
          )));
      })
      .catch(() => {
        if (active) setCandidates([]);
      });
    return () => {
      active = false;
    };
  }, [trip?.id]);

  const candidate = candidates[0] || null;
  const suggestedLimit = useMemo(() => (
    Number(candidate?.changeDetection?.proposedLimitKmh) ||
    Number(candidate?.limitKmh) ||
    null
  ), [candidate]);

  useEffect(() => {
    setAdjusting(false);
    setAdjustedLimit(suggestedLimit
      ? String(Math.round(convertSpeedKmh(suggestedLimit, settings.units || 'metric')))
      : '');
    setStatus('');
  }, [candidate?.id, settings.units, suggestedLimit]);

  if (!candidate) return null;

  const finishCandidate = () => {
    setCandidates((current) => current.filter((item) => item.id !== candidate.id));
  };

  const review = async (action) => {
    if (busy) return;
    const displayLimit = Number(adjustedLimit);
    const nextLimit = action === 'adjust_estimate'
      ? convertDisplaySpeedToKmh(displayLimit, settings.units || 'metric')
      : suggestedLimit;
    if (action === 'adjust_estimate' && (!Number.isFinite(nextLimit) || nextLimit <= 0 || nextLimit > MAX_SAVED_SPEED_LIMIT_KMH)) {
      setStatus('Enter a valid road speed.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const result = await knowledge.reviewRoadMemoryCandidate(candidate.id, {
        action,
        limitKmh: nextLimit,
        privacyZones: getPrivacyZones(settings),
      });
      if (!result) {
        setStatus('This suggestion could not be updated.');
        return;
      }
      if (action !== 'defer') {
        await import('@/lib/localSpeedScoreRefresh')
          .then(({ refreshTripsForLocalSpeedCorrections }) => (
            refreshTripsForLocalSpeedCorrections([
              candidate,
              ...(result.changedUsageCandidates || []),
            ])
          ))
          .catch(() => null);
      }
      finishCandidate();
    } catch {
      setStatus('This suggestion could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 rounded-2xl border border-sky-200/80 bg-sky-50/80 p-4 dark:border-sky-900/60 dark:bg-sky-950/20">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-sky-100 p-2 text-sky-700 dark:bg-sky-900/50 dark:text-sky-200">
          {candidate.stage === 'change_review'
            ? <AlertTriangle className="h-4 w-4" />
            : <Gauge className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Parked Road Memory review
          </div>
          <h3 className="mt-1 font-semibold">
            {candidate.roadName || 'Repeated road section'}: {formatSpeed(suggestedLimit, settings.units || 'metric')} suggested
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {candidate.confidenceExplanation || candidate.contextLabel}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{stageText(candidate, settings.units || 'metric')}</p>
          {candidate.timeProfiles?.some((profile) => profile.eligible) && (
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
              <Clock3 className="h-3.5 w-3.5" />
              A stronger time-specific pattern is available for this section.
            </p>
          )}
        </div>
      </div>

      {adjusting && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold" htmlFor={`road-memory-limit-${candidate.id}`}>Adjusted estimate</label>
          <input
            id={`road-memory-limit-${candidate.id}`}
            type="number"
            min="1"
            max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, settings.units || 'metric'))}
            inputMode="numeric"
            value={adjustedLimit}
            onChange={(event) => setAdjustedLimit(event.target.value)}
            className="h-10 w-24 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <span className="text-xs text-muted-foreground">{speedUnitLabel(settings.units || 'metric')}</span>
        </div>
      )}

      {status && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">{status}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => review('confirm_posted')}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-sky-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          Confirm posted sign
        </button>
        {adjusting ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => review('adjust_estimate')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            Save adjustment
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setAdjusting(true)}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <Pencil className="h-4 w-4" />
            Adjust
          </button>
        )}
        {candidate.stage === 'change_review' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => review('keep_existing')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            Dismiss change
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => review('defer')}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Not sure
        </button>
        {candidates.length > 1 && (
          <span className="self-center text-xs text-muted-foreground">
            {candidates.length - 1} more suggestion{candidates.length === 2 ? '' : 's'}
          </span>
        )}
      </div>
    </section>
  );
}
