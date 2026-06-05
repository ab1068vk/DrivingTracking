import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck } from 'lucide-react';
import {
  CALIBRATION_LABEL_TARGET_COUNT,
  FATIGUE_SELF_REPORT_OPTIONS,
  FATIGUE_SELF_REPORT_QUESTION,
  SCORE_ACCURACY_OPTIONS,
  SURVEY_RATING_OPTIONS,
  TRIP_CONTEXT_TAG_OPTIONS,
  WAS_DRIVER_OPTIONS,
  getCalibrationMilestone,
  getNextCalibrationMilestone,
  shouldAskFatigueSelfReport,
} from '@/lib/calibrationLabeling';

const SCORE_ACCURACY_LABELS = {
  accurate: 'Felt about right',
  too_high: 'Score was too high',
  too_low: 'Score was too low',
};

const WAS_DRIVER_LABELS = {
  yes: 'I was driving',
  no: 'I was a passenger',
  unsure: 'Not sure',
};

const FATIGUE_SELF_REPORT_LABELS = {
  alert: 'Alert',
  normal: 'Normal',
  tired: 'Tired',
  very_tired: 'Very tired',
};

const CONTEXT_TAG_LABELS = {
  traffic: 'Traffic',
  weather: 'Weather',
  construction: 'Construction',
  fatigue: 'Fatigue',
  aggressive_drivers: 'Aggressive drivers',
  bad_road: 'Bad road',
  gps_issue: 'GPS issue',
  passenger: 'Passenger',
  other: 'Other',
};

const RATING_ICONS = {
  5: ShieldCheck,
  4: CheckCircle2,
  2: Gauge,
  1: AlertTriangle,
};

const targetScoreForRating = (rating) => {
  if (rating >= 5) return 100;
  if (rating === 4) return 75;
  if (rating === 3) return 50;
  if (rating === 2) return 25;
  return 0;
};

const scoreValue = (trip = {}) => {
  const value = Number(trip.score_overall ?? trip.overall_score);
  return Number.isFinite(value) ? value : null;
};

function shouldAskWasDriver(trip = {}) {
  const durationMin = Math.max(0, Number(trip.duration_seconds) || 0) / 60;
  const distanceKm = Math.max(0, Number(trip.distance_km) || 0);
  const harshEvents = Math.max(0,
    Number(trip.harsh_brakes_count) ||
    Number(trip.rapid_accel_count) ||
    Number(trip.sharp_turns_count) ||
    0
  );
  const eventRate = distanceKm > 0 ? (harshEvents / distanceKm) * 100 : 0;
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const speeds = points
    .map((point) => Number(point.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed > 15);
  const mean = speeds.length ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length : Number(trip.avg_running_speed_kmh ?? trip.avg_speed_kmh) || 0;
  const variance = speeds.length
    ? speeds.reduce((sum, speed) => sum + ((speed - mean) ** 2), 0) / speeds.length
    : 0;
  const speedCv = mean > 0 ? Math.sqrt(variance) / mean : 1;

  return durationMin >= 30 && mean >= 30 && eventRate <= 1 && speedCv <= 0.12;
}

export default function PostTripCalibrationSurvey({
  trip = {},
  status,
  labelCount,
  sharingEnabled,
  isPending,
  isSkipping,
  error,
  onSubmit,
  onSkip,
  variant = 'full',
}) {
  const [draft, setDraft] = useState({
    overallDriveRating: null,
    scoreAccuracy: '',
    wasDriver: 'yes',
    contextTags: [],
    fatigue_self_report: null,
    freeTextNote: '',
  });
  const submittedRating = Number(status?.rating);
  const submitted = Number.isInteger(submittedRating) && submittedRating >= 1 && submittedRating <= 5;
  const skipped = status?.skipped === true;
  const normalizedLabelCount = Number.isFinite(Number(labelCount)) ? Math.max(0, Math.floor(Number(labelCount))) : 0;
  const milestone = getCalibrationMilestone(normalizedLabelCount);
  const nextMilestone = getNextCalibrationMilestone(normalizedLabelCount);
  const disabled = isPending || isSkipping || submitted || skipped;
  const fullSurvey = variant === 'full';
  const selectedRating = submitted ? submittedRating : Number(draft.overallDriveRating);
  const somethingHappened = selectedRating === 1;
  const askDriver = useMemo(() => shouldAskWasDriver(trip), [trip]);
  const askFatigueSelfReport = useMemo(() => shouldAskFatigueSelfReport(trip), [trip]);
  const scoreMismatch = useMemo(() => {
    const score = scoreValue(trip);
    return fullSurvey && Number.isFinite(score) && Number.isInteger(selectedRating) && Math.abs(score - targetScoreForRating(selectedRating)) >= 20;
  }, [fullSurvey, selectedRating, trip]);
  const canSubmit = Number.isInteger(selectedRating) &&
    selectedRating >= 1 &&
    selectedRating <= 5 &&
    WAS_DRIVER_OPTIONS.includes(draft.wasDriver) &&
    !disabled;
  const toggleContextTag = (tag) => {
    setDraft((current) => ({
      ...current,
      contextTags: current.contextTags.includes(tag)
        ? current.contextTags.filter((item) => item !== tag)
        : [...current.contextTags, tag],
    }));
  };
  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      overallDriveRating: selectedRating,
      scoreAccuracy: fullSurvey && draft.scoreAccuracy ? draft.scoreAccuracy : null,
      wasDriver: askDriver ? draft.wasDriver : 'yes',
      contextTags: somethingHappened ? draft.contextTags : [],
      fatigue_self_report: askFatigueSelfReport ? draft.fatigue_self_report : null,
      freeTextNote: fullSurvey ? draft.freeTextNote : '',
    });
  };

  if (skipped) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.16 }}
      className="bg-card border border-border rounded-3xl p-5 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">How was that drive?</h2>
          <div className="mt-1 text-xs text-muted-foreground">
            One tap helps tune Road Sage to real drives.
          </div>
        </div>
        {fullSurvey && (
          <div className="text-xs text-muted-foreground sm:text-right">
            {milestone && (
              <span className="mr-1 font-medium text-emerald-600 dark:text-emerald-400">
                Reached: {milestone.label}.
              </span>
            )}
            {nextMilestone
              ? `${(nextMilestone.count - normalizedLabelCount).toLocaleString()} more labels to: ${nextMilestone.benefit}`
              : `Fully calibrated: ${CALIBRATION_LABEL_TARGET_COUNT.toLocaleString()} labeled trips reached`}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {SURVEY_RATING_OPTIONS.map((option) => {
          const selected = selectedRating === option.value;
          const Icon = RATING_ICONS[option.value] || CheckCircle2;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => setDraft((current) => ({ ...current, overallDriveRating: option.value }))}
              className={`min-h-16 rounded-xl border px-3 py-2 text-left transition-colors ${
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-secondary/50 hover:bg-secondary disabled:opacity-60'
              }`}
            >
              <Icon className="mb-1 h-4 w-4" />
              <span className="block text-sm font-semibold leading-tight">{option.label}</span>
            </button>
          );
        })}
      </div>

      {!submitted && somethingHappened && (
        <div className="mt-4">
          <div className="text-xs font-medium text-muted-foreground">What affected it?</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {TRIP_CONTEXT_TAG_OPTIONS.map((tag) => {
              const selected = draft.contextTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleContextTag(tag)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                  }`}
                >
                  {CONTEXT_TAG_LABELS[tag]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!submitted && fullSurvey && scoreMismatch && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Did the score feel right?</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {SCORE_ACCURACY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => setDraft((current) => ({ ...current, scoreAccuracy: option }))}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  draft.scoreAccuracy === option
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                }`}
              >
                {SCORE_ACCURACY_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
      )}

      {!submitted && askDriver && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Were you driving?</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {WAS_DRIVER_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => setDraft((current) => ({ ...current, wasDriver: option }))}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  draft.wasDriver === option
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                }`}
              >
                {WAS_DRIVER_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
      )}

      {!submitted && fullSurvey && (
        <label className="mt-4 block text-xs font-medium text-muted-foreground">
          Note
          <textarea
            value={draft.freeTextNote}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, freeTextNote: event.target.value }))}
            className="mt-1 min-h-20 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-sm text-foreground"
            placeholder="Optional. Stored locally only."
          />
        </label>
      )}

      {!submitted && askFatigueSelfReport && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">{FATIGUE_SELF_REPORT_QUESTION}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FATIGUE_SELF_REPORT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                disabled={disabled}
                onClick={() => setDraft((current) => ({
                  ...current,
                  fatigue_self_report: current.fatigue_self_report === option ? null : option,
                }))}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  draft.fatigue_self_report === option
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-secondary/50 text-muted-foreground hover:bg-secondary'
                }`}
              >
                {FATIGUE_SELF_REPORT_LABELS[option]}
              </button>
            ))}
          </div>
          {draft.fatigue_self_report && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDraft((current) => ({ ...current, fatigue_self_report: null }))}
              className="mt-2 text-xs font-semibold text-muted-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted-foreground">
          {submitted
            ? 'Rating saved for the calibration dataset.'
            : isPending
              ? 'Saving rating...'
              : sharingEnabled
                ? 'Sharing is on. Only anonymized summary features are uploaded when quality checks pass.'
                : 'Sharing is off. This label stays local unless you opt in from Settings.'}
        </div>
        {!submitted && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={onSkip}
              className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
            >
              {isSkipping ? 'Skipping...' : 'Skip'}
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              Save feedback
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">
          {error.message || 'Could not save calibration label.'}
        </div>
      )}
    </motion.div>
  );
}
