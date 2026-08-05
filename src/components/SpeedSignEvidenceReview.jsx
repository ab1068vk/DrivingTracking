import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Pencil,
  ShieldCheck,
  X,
} from 'lucide-react';
import { tripService } from '@/api/trips';
import useLocalSettings from '@/hooks/useLocalSettings';
import { isAndroid, openNativeSettings } from '@/lib/nativePlatform';
import { getPrivacyZones } from '@/lib/privacyZones';
import { refreshTripsForLocalSpeedCorrections } from '@/lib/localSpeedScoreRefresh';
import { MAX_SAVED_SPEED_LIMIT_KMH } from '@/lib/speedKnowledgeCellPolicy';
import {
  listSpeedSignEvidence,
  reviewSpeedSignEvidence,
  SPEED_SIGN_EVIDENCE_CHANGED_EVENT,
  syncNativeSpeedSignEvidence,
} from '@/lib/speedSignEvidence';
import {
  getSpeedSignEvidenceImage,
  getSpeedSignScannerStatus,
  requestSpeedSignCameraPermission,
} from '@/lib/speedSignScanner';
import {
  convertDisplaySpeedToKmh,
  convertSpeedKmh,
  speedUnitLabel,
} from '@/lib/unitFormatting';

const displayLimit = (evidence, units) => (
  Math.round(convertSpeedKmh(Number(evidence?.limitKmh) || 0, units))
);
const minutesFromTime = (value) => {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isInteger(hours) && hours >= 0 && hours <= 23 &&
    Number.isInteger(minutes) && minutes >= 0 && minutes <= 59
    ? hours * 60 + minutes
    : NaN;
};
const qualifierLabel = (value) => ({
  regulatory_text_no_qualifiers: 'always active',
  conditional_school_when_flashing: 'school-zone schedule',
  conditional_school: 'school-zone condition',
  conditional_temporary_work_zone: 'temporary work-zone expiry',
  conditional_daytime: 'daytime schedule',
  conditional_night: 'night schedule',
}[value] || 'unverified condition');

export const emptySpeedSignConditionDraft = () => ({
  days: '',
  start: '',
  end: '',
  expiry: '',
});

export const SPEED_SIGN_CONDITION_INSTRUCTION =
  'No schedule is guessed. Copy every required condition from the sign yourself. “When flashing” cannot be verified by the camera, so enter known active hours or keep the candidate for later.';

export const speedSignConditionDraftError = (evidence, draft = {}, nowMs = Date.now()) => {
  if (!evidence?.conditional) return '';
  if (evidence.qualifierStatus === 'conditional_temporary_work_zone') {
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(draft.expiry || ''))
      ? new Date(`${draft.expiry}T23:59:59.999`).getTime()
      : NaN;
    return Number.isFinite(expiry) && expiry > Number(nowMs)
      ? ''
      : 'Choose a future expiry date printed for this temporary work-zone sign before confirming.';
  }
  if (!['weekdays', 'daily'].includes(draft.days)) {
    return 'Choose the active days printed on this conditional sign before confirming.';
  }
  const startMinutes = minutesFromTime(draft.start);
  const endMinutes = minutesFromTime(draft.end);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
    return 'Enter both active times printed on this conditional sign before confirming.';
  }
  if (startMinutes === endMinutes) {
    return 'Start and end times must be different before confirming this conditional sign.';
  }
  return '';
};

export default function SpeedSignEvidenceReview({
  trip = null,
  showAll = false,
  showEmpty = false,
  className = '',
  onCountChange = null,
}) {
  const settings = useLocalSettings();
  const [items, setItems] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [adjustingId, setAdjustingId] = useState('');
  const [adjustedValue, setAdjustedValue] = useState('');
  const [message, setMessage] = useState('');
  const [reviewImage, setReviewImage] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [scannerStatus, setScannerStatus] = useState(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lastOutcome, setLastOutcome] = useState('');
  const [replacementConflict, setReplacementConflict] = useState(null);
  const [conditionDays, setConditionDays] = useState('');
  const [conditionStart, setConditionStart] = useState('');
  const [conditionEnd, setConditionEnd] = useState('');
  const [conditionExpiry, setConditionExpiry] = useState('');

  const load = useCallback(async () => {
    await syncNativeSpeedSignEvidence();
    const next = await listSpeedSignEvidence({
      tripId: showAll ? null : trip?.id,
      pendingOnly: false,
    });
    setItems(next);
    onCountChange?.(next.length);
    return next;
  }, [onCountChange, showAll, trip?.id]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      load().catch(() => {
        if (active) {
          setItems([]);
          onCountChange?.(0);
        }
      });
      if (isAndroid()) {
        getSpeedSignScannerStatus().then((next) => {
          if (active) setScannerStatus(next);
        });
      }
    };
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      active = false;
      window.removeEventListener(SPEED_SIGN_EVIDENCE_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [load, onCountChange]);

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, items.length - 1)));
  }, [items.length]);

  const evidence = items[selectedIndex] || null;
  const pendingCount = items.filter((item) => item.reviewState === 'pending').length;
  const snoozedCount = items.filter((item) => item.reviewState === 'deferred').length;
  const units = settings.units || 'metric';
  const proposedDisplayLimit = useMemo(
    () => evidence ? displayLimit(evidence, units) : 0,
    [evidence, units]
  );
  const formatReviewLimit = useCallback((limitKmh) => (
    `${Math.round(convertSpeedKmh(Number(limitKmh) || 0, units))} ${speedUnitLabel(units)}`
  ), [units]);

  useEffect(() => {
    setAdjustingId('');
    setAdjustedValue(proposedDisplayLimit ? String(proposedDisplayLimit) : '');
    setMessage('');
    setReplacementConflict(null);
  }, [evidence?.id, proposedDisplayLimit]);

  useEffect(() => {
    const empty = emptySpeedSignConditionDraft();
    setConditionDays(empty.days);
    setConditionStart(empty.start);
    setConditionEnd(empty.end);
    setConditionExpiry(empty.expiry);
  }, [evidence?.id]);

  useEffect(() => {
    let active = true;
    setReviewImage('');
    if (!evidence?.reviewImageAvailable) {
      setImageLoading(false);
      return () => {
        active = false;
      };
    }
    setImageLoading(true);
    getSpeedSignEvidenceImage(evidence.id)
      .then((dataUrl) => {
        if (active) setReviewImage(dataUrl || '');
      })
      .finally(() => {
        if (active) setImageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [evidence?.id, evidence?.reviewImageAvailable]);

  const requestCameraAccess = async () => {
    if (permissionBusy || !isAndroid()) return;
    setPermissionBusy(true);
    setMessage('');
    try {
      const next = await requestSpeedSignCameraPermission();
      setScannerStatus(next);
      if (next?.cameraPermission !== 'granted') {
        setMessage('Camera access was not granted. You can enable it in Android app settings.');
      }
    } catch (error) {
      setMessage(error?.message || 'Camera permission could not be requested.');
    } finally {
      setPermissionBusy(false);
    }
  };

  if (!evidence && !showEmpty) return null;

  if (!evidence) {
    const enabled = settings.speed_sign_scanner_enabled === true;
    const lastScanSummary = scannerStatus?.lastScanSummary;
    const permission = scannerStatus?.cameraPermission || (isAndroid() ? 'checking' : 'unavailable');
    const permissionLabel = permission === 'granted'
      ? 'Camera granted'
      : permission === 'denied'
        ? 'Camera denied'
        : permission === 'prompt'
          ? 'Camera not requested'
          : isAndroid() ? 'Checking camera' : 'Android app only';
    return (
      <section
        data-testid="speed-sign-review-workspace"
        className={`rounded-2xl border border-cyan-200 bg-cyan-50/75 p-4 dark:border-cyan-900/60 dark:bg-cyan-950/20 ${className}`}
      >
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-cyan-100 p-2 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200">
            <Camera className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
              Camera sign review
            </div>
            <h3 className="mt-1 font-semibold">No speed-sign pictures are waiting</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The Android scanner first isolates and enlarges a sign-like target, then requires matching regulatory wording and speed across repeated frames. Its one encrypted crop appears here for confirmation; nothing appears until that full pipeline succeeds.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
              <span className={`rounded-full px-2 py-1 ${
                enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'bg-secondary text-muted-foreground'
              }`}>
                Scanner {enabled ? 'enabled' : 'disabled'}
              </span>
              <span className={`rounded-full px-2 py-1 ${
                permission === 'granted'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              }`}>
                {permissionLabel}
              </span>
              <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">
                {Number(scannerStatus?.pendingEvidenceCount) || 0} pending
              </span>
              {enabled && (
                <span className="rounded-full bg-secondary px-2 py-1 text-muted-foreground">
                  Mounted scan {scannerStatus?.armedForNextTrip === true ? 'armed' : 'not armed'}
                </span>
              )}
              {enabled && scannerStatus?.mode === 'local_sign_proposal_v1' && (
                <span className="rounded-full bg-cyan-100 px-2 py-1 text-cyan-800 dark:bg-cyan-950/50 dark:text-cyan-200">
                  Sign isolation + repeated OCR
                </span>
              )}
            </div>
          </div>
        </div>
        {Number(lastScanSummary?.framesChecked) > 0 && (
          <div className="mt-3 rounded-xl border border-cyan-200 bg-background/75 px-3 py-2 text-xs dark:border-cyan-900/60">
            <div className="font-semibold">Last scanner funnel</div>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {Number(lastScanSummary.framesChecked) || 0} frames checked → {Number(lastScanSummary.signTargets) || 0} sign-like targets → {Number(lastScanSummary.readableTextFrames) || 0} readable-text frames → {Number(lastScanSummary.regulatoryMatches) || 0} regulatory matches → {Number(lastScanSummary.savedCandidates) || 0} saved candidates.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {String(lastScanSummary.focusMode || 'Forward focus status unavailable')}. These counters contain no picture, recognized text, or road location.
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {!enabled && (
            <Link
              to="/settings?section=settings-speed-warning"
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold"
            >
              <Camera className="h-4 w-4" />
              Enable scanner in Settings
            </Link>
          )}
          {isAndroid() && enabled && permission !== 'granted' && permission !== 'denied' && (
            <button
              type="button"
              disabled={permissionBusy}
              onClick={requestCameraAccess}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-cyan-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Camera className="h-4 w-4" />
              {permissionBusy ? 'Requesting…' : 'Grant camera access'}
            </button>
          )}
          {isAndroid() && enabled && permission === 'denied' && (
            <button
              type="button"
              onClick={() => openNativeSettings().catch(() => null)}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold"
            >
              <ExternalLink className="h-4 w-4" />
              Open Android app settings
            </button>
          )}
        </div>
        {!isAndroid() && (
          <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-200">
            A desktop or browser build cannot request the phone’s Android camera permission. Install and open the rebuilt Android app to use scanning.
          </p>
        )}
        {lastOutcome && (
          <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            {lastOutcome}
          </p>
        )}
        {message && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">{message}</p>}
      </section>
    );
  }

  const review = async (action, { replaceExistingConfirmed = false } = {}) => {
    if (busyId) return;
    const confirming = action === 'confirm_posted' || action === 'adjust_and_confirm';
    const conditionError = speedSignConditionDraftError(evidence, {
      days: conditionDays,
      start: conditionStart,
      end: conditionEnd,
      expiry: conditionExpiry,
    });
    if (confirming && conditionError) {
      setMessage(conditionError);
      return;
    }
    setBusyId(evidence.id);
    setMessage('');
    try {
      const matchingTrip = trip && String(trip.id) === String(evidence.tripId)
        ? trip
        : await tripService.getById(evidence.tripId);
      const numericDisplayLimit = Number(adjustedValue);
      const limitKmh = convertDisplaySpeedToKmh(numericDisplayLimit, units);
      if (
        action === 'adjust_and_confirm' &&
        (!Number.isFinite(limitKmh) || limitKmh <= 0 || limitKmh > MAX_SAVED_SPEED_LIMIT_KMH)
      ) {
        setMessage('Enter a valid posted speed.');
        return;
      }
      const result = await reviewSpeedSignEvidence(evidence.id, {
        action,
        trip: matchingTrip,
        limitKmh,
        privacyZones: getPrivacyZones(settings),
        replaceExistingConfirmed,
        condition: evidence.conditional ? {
          days: conditionDays === 'daily'
            ? [0, 1, 2, 3, 4, 5, 6]
            : conditionDays === 'weekdays' ? [1, 2, 3, 4, 5] : [],
          startMinutes: minutesFromTime(conditionStart),
          endMinutes: minutesFromTime(conditionEnd),
          expiresAt: conditionExpiry ? `${conditionExpiry}T23:59:59` : null,
        } : null,
      });
      if (result?.requiresReplacementConfirmation) {
        setReplacementConflict(result);
        setMessage(result.qualifierChanged
          ? `This road already has a confirmed ${formatReviewLimit(result.existingCorrection?.limitKmh)} rule (${qualifierLabel(result.existingQualifierStatus)}). Nothing changed. Replace it only if you personally verified the new ${qualifierLabel(result.proposedQualifierStatus)}.`
          : `This road already has your confirmed ${formatReviewLimit(result.existingCorrection?.limitKmh)} posted limit. Nothing changed. Replace it only if you personally saw that the posted sign is now ${formatReviewLimit(result.proposedLimitKmh)}.`);
        return;
      }
      if (result?.correction) {
        const refreshedTrips = await refreshTripsForLocalSpeedCorrections([result.correction]).catch(() => []);
        const tripCount = refreshedTrips.length;
        setLastOutcome(
          `${result.reverifiedExisting ? 'Reverified the existing confirmed posted rule.' : result.replacedExisting ? result.qualifierChanged ? 'Replaced the previous sign conditions after your second confirmation.' : `Replaced the previous ${formatReviewLimit(result.previousLimitKmh)} confirmed limit after your second confirmation.` : 'Saved as a confirmed posted limit.'} ${tripCount} completed trip${tripCount === 1 ? '' : 's'} recalculated; future scores, voice warnings, and live alerts can now reuse it.`
        );
      } else if (action === 'reject') {
        setLastOutcome('Candidate removed. It did not change any trip score, warning, or saved road speed.');
      } else if (action === 'defer') {
        setLastOutcome('Candidate snoozed. Its one encrypted crop remains available until the 24-hour expiry; nothing was applied to scoring or alerts.');
      }
      setSelectedIndex(0);
      await load();
    } catch (error) {
      setMessage(error?.message || 'This candidate could not be reviewed.');
    } finally {
      setBusyId('');
    }
  };

  const conditionError = speedSignConditionDraftError(evidence, {
    days: conditionDays,
    start: conditionStart,
    end: conditionEnd,
    expiry: conditionExpiry,
  });

  return (
    <section className={`rounded-2xl border border-violet-200 bg-violet-50/80 p-4 dark:border-violet-900/60 dark:bg-violet-950/20 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-violet-200/80 bg-background/70 px-3 py-2 dark:border-violet-800/70">
        <div>
          <div className="text-xs font-semibold">Camera review queue</div>
          <div className="text-[11px] text-muted-foreground">
            Candidate {selectedIndex + 1} of {items.length} · {pendingCount} new · {snoozedCount} snoozed
          </div>
        </div>
        {items.length > 1 && (
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Previous camera candidate"
              disabled={selectedIndex === 0 || Boolean(busyId)}
              onClick={() => setSelectedIndex((current) => Math.max(0, current - 1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next camera candidate"
              disabled={selectedIndex >= items.length - 1 || Boolean(busyId)}
              onClick={() => setSelectedIndex((current) => Math.min(items.length - 1, current + 1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background disabled:opacity-35"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-violet-100 p-2 text-violet-700 dark:bg-violet-900/50 dark:text-violet-200">
          <Camera className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            {evidence.reviewState === 'deferred' ? 'Snoozed camera candidate' : 'Parked camera candidate'}
          </div>
          <h3 className="mt-1 font-semibold">
            {proposedDisplayLimit} {speedUnitLabel(units)} appeared across {evidence.frameCount} frames
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The offline scanner found repeated regulatory wording{evidence.conditional ? ' and preserved a conditional qualifier for you to define safely' : ' with no understood qualifier'}. {evidence.reviewImageAvailable
              ? 'It retained only one encrypted sign crop for this parked review; full frames and recognized text were discarded.'
              : 'The temporary sign crop is unavailable; full frames and recognized text were discarded.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
            <span className="rounded-full bg-background px-2 py-1 text-muted-foreground">
              {evidence.visualQualityLabel} · {Math.round((evidence.visualQuality || 0) * 100)}%
            </span>
            <span className="rounded-full bg-background px-2 py-1 text-muted-foreground">
              {evidence.scanPolicyLabel}
            </span>
            <span className="rounded-full bg-background px-2 py-1 text-muted-foreground">
              {evidence.signTargetFound
                ? `Sign isolated · ${Math.round((evidence.signTargetScore || 0) * 100)}%`
                : 'Regulatory text fallback'}
            </span>
            {evidence.conditional && (
              <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
                Conditional sign — never applied all day automatically
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">
            This has not affected your score, speed page, or voice alerts. Confirm only if you personally saw it as the posted limit for this road.
          </p>
          {evidence.reviewState === 'deferred' && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              <Clock3 className="h-3.5 w-3.5" />
              Snoozed · picture expires {evidence.reviewImageExpiresAt
                ? new Date(evidence.reviewImageExpiresAt).toLocaleString()
                : 'when its private retention period ends'}
            </p>
          )}
        </div>
      </div>

      {(imageLoading || reviewImage) && (
        <div className="mt-3 overflow-hidden rounded-xl border border-violet-200 bg-black/90 dark:border-violet-800">
          {reviewImage ? (
            <img loading="lazy"
              src={reviewImage}
              alt={`Temporary camera crop for the proposed ${proposedDisplayLimit} ${speedUnitLabel(units)} sign`}
              draggable={false}
              onContextMenu={(event) => event.preventDefault()}
              className="max-h-64 w-full select-none object-contain"
            />
          ) : (
            <div className="flex min-h-32 items-center justify-center px-4 text-xs text-white/70">
              Decrypting the private sign crop…
            </div>
          )}
          <div className="border-t border-white/10 px-3 py-2 text-[11px] text-white/70">
            Temporary on-device crop · deleted after your decision and unavailable after 24 hours
          </div>
        </div>
      )}

      {evidence.reviewImageAvailable && !imageLoading && !reviewImage && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          The temporary crop is unavailable or has expired. Confirm only if you personally remember the posted sign.
        </p>
      )}

      {adjustingId === evidence.id && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold" htmlFor={`camera-sign-limit-${evidence.id}`}>
            Posted speed you saw
          </label>
          <input
            id={`camera-sign-limit-${evidence.id}`}
            type="number"
            min="1"
            max={Math.floor(convertSpeedKmh(MAX_SAVED_SPEED_LIMIT_KMH, units))}
            inputMode="numeric"
            value={adjustedValue}
            onChange={(event) => setAdjustedValue(event.target.value)}
            className="h-10 w-24 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <span className="text-xs text-muted-foreground">{speedUnitLabel(units)}</span>
        </div>
      )}

      {evidence.conditional && (
        <fieldset className="mt-3 rounded-xl border border-amber-300 bg-amber-50/80 p-3 dark:border-amber-800 dark:bg-amber-950/25">
          <legend className="px-1 text-xs font-semibold">When does this sign apply?</legend>
          {evidence.qualifierStatus === 'conditional_temporary_work_zone' ? (
            <label className="mt-1 block text-xs font-medium">
              Temporary rule expiry
              <input
                type="date"
                value={conditionExpiry}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(event) => setConditionExpiry(event.target.value)}
                className="mt-1 block h-10 rounded-lg border border-border bg-background px-3"
              />
            </label>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-xs font-medium">Days
                <select value={conditionDays} onChange={(event) => setConditionDays(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-2">
                  <option value="" disabled>Choose days</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="daily">Every day</option>
                </select>
              </label>
              <label className="text-xs font-medium">Starts
                <input type="time" value={conditionStart} onChange={(event) => setConditionStart(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-2" />
              </label>
              <label className="text-xs font-medium">Ends
                <input type="time" value={conditionEnd} onChange={(event) => setConditionEnd(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border bg-background px-2" />
              </label>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-200">
            {SPEED_SIGN_CONDITION_INSTRUCTION}
          </p>
          {conditionError && (
            <p className="mt-2 text-[11px] font-semibold text-red-700 dark:text-red-300" role="alert">
              {conditionError}
            </p>
          )}
        </fieldset>
      )}

      {lastOutcome && (
        <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          {lastOutcome}
        </p>
      )}
      {message && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">{message}</p>}

      {replacementConflict && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="text-xs font-semibold text-amber-950 dark:text-amber-100">Possible posted-rule change</div>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
            Existing confirmed: {formatReviewLimit(replacementConflict.existingCorrection?.limitKmh)} ({qualifierLabel(replacementConflict.existingQualifierStatus)}). Camera candidate: {formatReviewLimit(replacementConflict.proposedLimitKmh)} ({qualifierLabel(replacementConflict.proposedQualifierStatus)}). The existing rule still controls scores and alerts.
          </p>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
            If you replace it, the new speed starts at the time this sign was recorded ({new Date(evidence.timestamp).toLocaleString()}). The previous version stays read-only in Saved road speeds so older trips keep the rule that applied then.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busyId) || Boolean(conditionError)}
              onClick={() => review(adjustingId === evidence.id ? 'adjust_and_confirm' : 'confirm_posted', { replaceExistingConfirmed: true })}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-amber-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              Yes, replace with the new posted rule
            </button>
            <button
              type="button"
              disabled={Boolean(busyId)}
              onClick={() => {
                setReplacementConflict(null);
                setMessage('Kept the existing confirmed posted limit. The camera candidate is still waiting for a decision.');
              }}
              className="inline-flex min-h-10 items-center rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              Keep existing
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={Boolean(busyId) || Boolean(conditionError)}
          onClick={() => review('confirm_posted')}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-violet-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          <ShieldCheck className="h-4 w-4" />
          I saw this posted sign
        </button>
        {adjustingId === evidence.id ? (
          <button
            type="button"
            disabled={Boolean(busyId) || Boolean(conditionError)}
            onClick={() => review('adjust_and_confirm')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            Confirm adjusted speed
          </button>
        ) : (
          <button
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => setAdjustingId(evidence.id)}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
          >
            <Pencil className="h-4 w-4" />
            Different number
          </button>
        )}
        <button
          type="button"
          disabled={Boolean(busyId)}
          onClick={() => review('reject')}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Not a posted limit
        </button>
        {evidence.reviewState !== 'deferred' && (
          <button
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => review('defer')}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-xs font-semibold text-muted-foreground disabled:opacity-50"
          >
            Not sure — keep for later
          </button>
        )}
      </div>
    </section>
  );
}
