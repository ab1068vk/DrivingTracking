import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Clock3,
  Crosshair,
  FlaskConical,
  Gauge,
  MapPin,
  Play,
  Route,
  ShieldCheck,
  Sparkles,
  Target,
  ThumbsUp,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  formatDistance,
  formatDuration,
  getTripComponentScore,
} from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import {
  buildCoachingEffectiveness,
  COACH_PROGRAM_CHANGED_EVENT,
  COACH_FOCUS_CATALOG,
  loadCoachProgramStore,
} from '@/lib/coachPrograms';
import {
  activatePostDriveFocus,
  savePostDriveRecommendationFeedback,
} from '@/lib/postDriveActions';
import { buildAdvancedPostDriveAnalysis } from '@/lib/postDriveAdvancedAnalysis';
import RoadMemoryQuickReview from '@/components/RoadMemoryQuickReview';
import SpeedSignEvidenceReview from '@/components/SpeedSignEvidenceReview';

const COMPONENTS = [
  { key: 'safety', label: 'Safety' },
  { key: 'smoothness', label: 'Smoothness' },
];

const numericCount = (trip, keys) => {
  let result = 0;
  for (const key of keys) {
    const value = Number(trip?.[key]);
    if (Number.isFinite(value)) result = Math.max(result, Math.max(0, Math.round(value)));
  }
  return result;
};

const routePointCount = (trip) => {
  if (Array.isArray(trip?.route_points)) return trip.route_points.length;
  return numericCount(trip, [
    'route_points_map_count',
    'route_point_count',
    'route_points_count',
    'route_points_retained',
  ]);
};

const eventTotal = (trip) => {
  if (Array.isArray(trip?.driving_events)) return trip.driving_events.length;
  return numericCount(trip, ['driving_events_count', 'event_count'])
    || numericCount(trip, ['harsh_brakes_count'])
      + numericCount(trip, ['rapid_accel_count'])
      + numericCount(trip, ['sharp_turns_count'])
      + numericCount(trip, ['speeding_events_count']);
};

const normalizedTags = (trip) => [
  ...(Array.isArray(trip?.tags) ? trip.tags : []),
  trip?.tag,
  trip?.auto_tag,
].filter(Boolean).map((tag) => String(tag).toLowerCase());

const comparisonSetForTrip = (trip, previousTrips = []) => {
  const candidates = (Array.isArray(previousTrips) ? previousTrips : [])
    .filter((item) => String(item?.id) !== String(trip?.id));
  const scoredCandidates = candidates.map((item) => {
    const sameRoute = Boolean(trip?.route_key && item?.route_key === trip.route_key);
    const sameRoadType = Boolean(
      trip?.dominant_road_type &&
      item?.dominant_road_type === trip.dominant_road_type
    );
    const tags = normalizedTags(trip);
    const itemTags = new Set(normalizedTags(item));
    const sharedTag = tags.find((tag) => itemTags.has(tag)) || null;
    return {
      item,
      label: sameRoute
        ? 'same-route drives'
        : sameRoadType
          ? `${String(trip.dominant_road_type).replaceAll('_', ' ')} drives`
          : sharedTag
            ? `${sharedTag.replaceAll('_', ' ')} trips`
            : 'recent drives',
      relevance: sameRoute ? 4 : sameRoadType ? 2 : sharedTag ? 1 : 0,
    };
  });
  const bestRelevance = Math.max(0, ...scoredCandidates.map(({ relevance }) => relevance));
  const relevant = scoredCandidates.filter(({ relevance }) => relevance === bestRelevance).slice(0, 5);
  return {
    label: relevant[0]?.label || 'recent drives',
    trips: relevant.map(({ item }) => item),
  };
};

const confidenceMeta = (evidence) => {
  if (evidence === 'high') {
    return {
      key: 'high',
      label: 'Strong evidence',
      note: 'The route and sensor evidence are strong enough for a useful comparison.',
    };
  }
  if (evidence === 'developing') {
    return {
      key: 'developing',
      label: 'Developing evidence',
      note: 'Treat the comparison as directional while Road Sage learns from more drives.',
    };
  }
  if (evidence === 'low') {
    return {
      key: 'low',
      label: 'Limited evidence',
      note: 'The score is tentative, so the review prioritizes directly recorded events.',
    };
  }
  return {
    key: 'unavailable',
    label: 'Capture saved',
    note: 'There was not enough reliable evidence for a driver score on this trip.',
  };
};

const opportunityForTrip = (trip, overallEvidence, coachStore = {}) => {
  const effectiveness = buildCoachingEffectiveness(coachStore);
  const opportunities = [
    {
      count: numericCount(trip, ['speeding_events_count']),
      label: 'Speed discipline',
      detailForCount: (count) => `${count} speeding event${count === 1 ? ' was' : 's were'} recorded. Ease off earlier as the limit or road context changes.`,
      focus: 'speeding',
      weight: 5,
    },
    {
      count: numericCount(trip, ['phone_use_window_count', 'phone_use_events_count']),
      label: 'Review foreground activity',
      detailForCount: (count) => `${count} foreground-app window${count === 1 ? ' needs' : 's need'} review. Confirm whether you were the driver; rejected windows are removed from scoring.`,
      focus: 'phone_use',
      weight: 6,
    },
    {
      count: numericCount(trip, ['harsh_brakes_count']),
      label: 'Earlier braking',
      detailForCount: (count) => `${count} harsh-braking event${count === 1 ? ' was' : 's were'} recorded. Create more space so braking can begin sooner and stay progressive.`,
      focus: 'harsh_brakes',
      weight: 4,
    },
    {
      count: numericCount(trip, ['rapid_accel_count']),
      label: 'Progressive acceleration',
      detailForCount: (count) => `${count} rapid-acceleration event${count === 1 ? ' was' : 's were'} recorded. Build speed more gradually on the next drive.`,
      focus: 'rapid_accel',
      weight: 3,
    },
    {
      count: numericCount(trip, ['sharp_turns_count']),
      label: 'Corner setup',
      detailForCount: (count) => `${count} sharp-turn event${count === 1 ? ' was' : 's were'} recorded. Set a comfortable speed before entering the turn.`,
      focus: 'sharp_turns',
      weight: 3,
    },
  ]
    .map((item) => {
      const feedback = effectiveness[item.focus];
      const learnedAdjustment = feedback?.feedbackScore == null
        ? 0
        : Number(feedback.feedbackScore) * 5;
      return {
        ...item,
        learnedAdjustment,
        priority: item.count * item.weight + learnedAdjustment,
      };
    })
    .sort((a, b) => b.priority - a.priority || b.count - a.count);
  const recordedOpportunities = opportunities.filter((item) => item.count > 0);

  if (recordedOpportunities[0]) {
    const selected = recordedOpportunities[0];
    return {
      ...selected,
      detail: selected.detailForCount(selected.count),
      reason: selected.learnedAdjustment
        ? `Prioritized from ${selected.count} directly recorded event${selected.count === 1 ? '' : 's'} and your past feedback on this coaching focus.`
        : `Prioritized from ${selected.count} directly recorded event${selected.count === 1 ? '' : 's'}.`,
    };
  }

  const scored = COMPONENTS
    .map((component) => ({
      ...component,
      value: getTripComponentScore(trip, component.key).value,
    }))
    .filter((component) => component.value != null)
    .sort((a, b) => a.value - b.value);

  if (['low', 'unavailable'].includes(overallEvidence) || !scored.length) {
    const points = routePointCount(trip);
    return {
      count: 0,
      label: 'Build a stronger sample',
      detail: points > 0
        ? `Only limited scoring evidence was available from ${points} retained route point${points === 1 ? '' : 's'}. Keep the phone secured and let the next drive collect naturally.`
        : 'This trip did not retain enough evidence for reliable coaching. Let the next drive collect naturally before changing your driving based on this score.',
      focus: 'consistency',
      reason: 'Selected because the trip score has limited evidence.',
    };
  }

  const weakest = scored[0];
  if (weakest?.key === 'smoothness') {
    return {
      count: 0,
      label: 'Smooth, predictable inputs',
      detail: `Smoothness was the lowest measured component at ${Math.round(weakest.value)}. Keep acceleration, steering and braking gradual on the next drive.`,
      focus: 'consistency',
      reason: 'Selected from the lowest reliable score component.',
    };
  }
  if (weakest?.key === 'eco') {
    return {
      count: 0,
      label: 'Efficient momentum',
      detail: `Efficiency was the lowest measured component at ${Math.round(weakest.value)}. Look farther ahead and reduce unnecessary speed changes.`,
      focus: 'consistency',
      reason: 'Selected from the lowest reliable score component.',
    };
  }
  if (weakest?.key === 'safety' && weakest.value < 90) {
    return {
      count: 0,
      label: 'More space, earlier decisions',
      detail: `Safety was the lowest measured component at ${Math.round(weakest.value)}. Add following space and make speed changes earlier on the next drive.`,
      focus: 'consistency',
      reason: 'Selected from the lowest reliable score component.',
    };
  }
  return {
    count: 0,
    label: 'Repeat the calm drive',
    detail: 'Use the same pace and spacing on the next comparable route.',
    focus: 'consistency',
    reason: 'No scored risk event stood out, so consistency is the best next experiment.',
  };
};

const strongestSignal = (trip, comparisonTrips = []) => {
  const strongest = COMPONENTS
    .map((component) => ({
      ...component,
      value: getTripComponentScore(trip, component.key).value,
    }))
    .filter((component) => component.value != null)
    .sort((a, b) => b.value - a.value)[0];

  if (!strongest) {
    return {
      label: trip?.privacy_mode === 'summary_only' ? 'Privacy protected' : 'Trip captured',
      detail: trip?.privacy_mode === 'summary_only'
        ? 'The trip summary was saved without retaining raw route coordinates.'
        : 'Your completed drive is stored locally and ready to inspect.',
    };
  }
  const priorValues = comparisonTrips
    .map((item) => getTripComponentScore(item, strongest.key).value)
    .filter((value) => value != null);
  const priorAverage = priorValues.length
    ? Math.round(priorValues.reduce((sum, value) => sum + value, 0) / priorValues.length)
    : null;
  const componentDelta = priorAverage == null ? null : Math.round(strongest.value - priorAverage);
  return {
    label: `${strongest.label} stood out`,
    detail: componentDelta == null
      ? `${strongest.label} scored ${Math.round(strongest.value)} and was the strongest measured part of this drive.`
      : componentDelta === 0
        ? `${strongest.label} scored ${Math.round(strongest.value)} and matched your comparison average.`
        : `${strongest.label} scored ${Math.round(strongest.value)}, ${Math.abs(componentDelta)} point${Math.abs(componentDelta) === 1 ? '' : 's'} ${componentDelta > 0 ? 'above' : 'below'} your comparison average.`,
  };
};

export function buildPostDriveReviewViewModel(trip, previousTrips = [], mode = 'coaching', coachStore = {}) {
  if (!trip) return null;
  const overall = getTripComponentScore(trip, 'overall');
  const comparison = comparisonSetForTrip(trip, previousTrips);
  const priorScores = comparison.trips
    .map((item) => getTripComponentScore(item, 'overall').value)
    .filter((value) => value != null)
    .slice(0, 5);
  const recentAverage = priorScores.length
    ? Math.round(priorScores.reduce((sum, value) => sum + value, 0) / priorScores.length)
    : null;
  const delta = overall.value == null || recentAverage == null
    ? null
    : Math.round(overall.value - recentAverage);
  const confidence = confidenceMeta(overall.evidence);
  const opportunity = opportunityForTrip(trip, overall.evidence, coachStore);
  const advanced = buildAdvancedPostDriveAnalysis(
    trip,
    previousTrips,
    opportunity.focus,
    coachStore
  );
  const strongest = strongestSignal(trip, comparison.trips);
  const technical = mode === 'tracking';
  const points = routePointCount(trip);
  const events = eventTotal(trip);

  return {
    delta,
    comparisonCount: priorScores.length,
    comparisonLabel: comparison.label,
    confidence,
    advanced,
    events,
    focus: opportunity.focus,
    opportunity,
    overallScore: overall.value,
    points,
    strongest,
    title: technical
      ? 'Trip saved and ready to inspect'
      : overall.value == null
        ? 'Your drive is saved'
        : delta != null && delta >= 3
          ? 'You moved in the right direction'
          : confidence.key === 'low'
            ? 'A tentative review is ready'
          : events === 0
            ? 'A clean drive to build on'
            : 'Your post-drive review is ready',
    subtitle: technical
      ? `${points} route point${points === 1 ? '' : 's'} retained · ${events} recorded observation${events === 1 ? '' : 's'}.`
      : delta == null
        ? `${confidence.note} Personal comparisons appear as relevant history grows.`
        : `${delta >= 0 ? '+' : ''}${delta} compared with your ${comparison.label} (${priorScores.length} drive${priorScores.length === 1 ? '' : 's'}).`,
  };
}

export default function PostDriveReviewCard({
  trip,
  previousTrips = [],
  units = 'metric',
  mode = 'coaching',
  onDismiss,
  onOpenTrip,
  onOpenNextAction,
}) {
  const [coachStore, setCoachStore] = useState(null);
  const [focusBusy, setFocusBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState('');
  const [feedbackRecord, setFeedbackRecord] = useState({
    focusId: trip?.post_drive_review_feedback?.focus_id || '',
    verdict: trip?.post_drive_review_feedback?.verdict || '',
  });
  const [actionStatus, setActionStatus] = useState('');

  useEffect(() => {
    let active = true;
    const load = () => {
      loadCoachProgramStore()
        .then((store) => {
          if (active) setCoachStore(store);
        })
        .catch(() => {
          if (active) setCoachStore(null);
        });
    };
    load();
    const onProgramChanged = (event) => {
      if (active) setCoachStore(event?.detail || null);
    };
    window.addEventListener(COACH_PROGRAM_CHANGED_EVENT, onProgramChanged);
    return () => {
      active = false;
      window.removeEventListener(COACH_PROGRAM_CHANGED_EVENT, onProgramChanged);
    };
  }, []);

  useEffect(() => {
    setFeedbackRecord({
      focusId: trip?.post_drive_review_feedback?.focus_id || '',
      verdict: trip?.post_drive_review_feedback?.verdict || '',
    });
    setActionStatus('');
  }, [
    trip?.id,
    trip?.post_drive_review_feedback?.focus_id,
    trip?.post_drive_review_feedback?.verdict,
  ]);

  const model = buildPostDriveReviewViewModel(trip, previousTrips, mode, coachStore || {});
  if (!model) return null;
  const technical = mode === 'tracking';
  const focusDefinition = COACH_FOCUS_CATALOG[model.focus] || COACH_FOCUS_CATALOG.consistency;
  const activeProgram = coachStore?.active?.status === 'active' ? coachStore.active : null;
  const focusAlreadyActive = activeProgram?.focusId === focusDefinition.id;

  const activateFocus = async () => {
    if (focusBusy || focusAlreadyActive) return;
    setFocusBusy(true);
    setActionStatus('');
    try {
      const result = await activatePostDriveFocus({
        trip,
        trips: previousTrips,
        focusId: focusDefinition.id,
      });
      setCoachStore(result.store);
      setActionStatus(
        result.replaced
          ? `${focusDefinition.label} replaced the previous focus and will be cued on the next drive.`
          : `${focusDefinition.label} is active for the next drive and will be measured across three comparable drives.`
      );
    } catch (error) {
      setActionStatus(error?.message || 'The next-drive focus could not be activated.');
    } finally {
      setFocusBusy(false);
    }
  };

  const submitFeedback = async (verdict) => {
    if (feedbackBusy) return;
    const reviewedFocusId = model.focus;
    setFeedbackBusy(verdict);
    setActionStatus('');
    try {
      const savedStore = await savePostDriveRecommendationFeedback({
        trip,
        focusId: reviewedFocusId,
        verdict,
      });
      setCoachStore(savedStore);
      setFeedbackRecord({ focusId: reviewedFocusId, verdict });
      setActionStatus(verdict === 'helpful'
        ? 'Saved. Helpful recommendations like this receive more weight in future reviews.'
        : verdict === 'not_relevant'
          ? 'Saved. This type of recommendation will be ranked lower for future reviews.'
          : 'Saved as questionable evidence. Similar detections receive less coaching weight; review the trip if the event itself needs correction.');
    } catch (error) {
      setActionStatus(error?.message || 'Your feedback could not be saved.');
    } finally {
      setFeedbackBusy('');
    }
  };

  return (
    <section
      aria-labelledby="post-drive-review-title"
      className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-emerald-500/5 p-5 shadow-sm sm:p-6"
    >
      <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss post-drive review"
        className="absolute right-3 top-3 z-10 rounded-full p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="relative">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Post-drive review
          </div>
          {!technical && (
            <div
              title={model.confidence.note}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/75 px-2.5 py-1 text-xs font-medium text-muted-foreground"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {model.confidence.label}
            </div>
          )}
        </div>
        <h2 id="post-drive-review-title" className="mt-3 pr-9 font-grotesk text-2xl font-bold">
          {model.title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{model.subtitle}</p>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <article className="rounded-2xl border border-border/80 bg-background/80 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {technical ? <Route className="h-4 w-4" /> : <Gauge className="h-4 w-4" />}
              {technical ? 'Capture' : 'Drive result'}
            </div>
            <div className="mt-2 font-grotesk text-3xl font-bold">
              {technical
                ? `${model.points} pts`
                : model.overallScore == null ? 'Saved' : formatEstimatedScore(model.overallScore)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {technical
                ? `${model.events} neutral observation${model.events === 1 ? '' : 's'} recorded`
                : model.delta == null
                  ? 'Personal comparison is still building'
                  : `${model.delta >= 0 ? '+' : ''}${model.delta} versus ${model.comparisonLabel}`}
            </p>
          </article>

          <article className="rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              {technical ? 'Available now' : 'What went well'}
            </div>
            <div className="mt-2 font-semibold">{technical ? 'Route and event evidence' : model.strongest.label}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {technical ? 'Open the trip to inspect the timeline, retained route and collection quality.' : model.strongest.detail}
            </p>
          </article>

          <article className="rounded-2xl border border-amber-200/70 bg-amber-50/70 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              <Target className="h-4 w-4" />
              {technical ? 'Suggested review' : 'Next-drive focus'}
            </div>
            <div className="mt-2 font-semibold">
              {technical ? (model.events > 0 ? 'Inspect recorded events' : 'Confirm collection quality') : model.opportunity.label}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {technical
                ? model.events > 0 ? 'Check where each observation occurred and whether the evidence looks accurate.' : 'Verify the route and sensor coverage before the next recording.'
                : model.opportunity.detail}
            </p>
            {!technical && (
              <p className="mt-2 border-t border-amber-200/70 pt-2 text-[11px] leading-relaxed text-amber-800/80 dark:border-amber-900/50 dark:text-amber-200/70">
                {model.opportunity.reason}
              </p>
            )}
          </article>
        </div>

        {technical ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenTrip}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm"
            >
              <ShieldCheck className="h-4 w-4" />
              Review this trip
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onOpenNextAction?.(model.focus)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-secondary"
            >
              <MapPin className="h-4 w-4" />
              Open recorded events
            </button>
            <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatDuration(trip.duration_seconds || 0)}</span>
              <span className="inline-flex items-center gap-1"><Route className="h-3.5 w-3.5" />{formatDistance(trip.distance_km || 0, units)}</span>
            </div>
          </div>
        ) : (
          <>
            <section
              aria-labelledby="advanced-post-drive-title"
              className="mt-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.04] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                    <Activity className="h-4 w-4" />
                    New analysis
                  </div>
                  <h3 id="advanced-post-drive-title" className="mt-1 font-grotesk text-lg font-bold">
                    Advanced drive intelligence
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    New conclusions derived locally from this event, comparable drives, route context, and completed coaching results.
                  </p>
                </div>
                <span className="rounded-full border border-cyan-500/20 bg-background/70 px-2.5 py-1 text-[11px] font-semibold capitalize text-cyan-700 dark:text-cyan-300">
                  {model.advanced.confidence} evidence
                </span>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <article className="rounded-xl border border-border/80 bg-background/75 p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <TrendingUp className="h-3.5 w-3.5" />
                    Recurring or one-off?
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.pattern.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.pattern.detail}
                  </p>
                </article>

                <article className="rounded-xl border border-border/80 bg-background/75 p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Crosshair className="h-3.5 w-3.5" />
                    Strongest exact moment
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.moment.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.moment.detail}
                  </p>
                </article>

                <article className="rounded-xl border border-border/80 bg-background/75 p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Brain className="h-3.5 w-3.5" />
                    Likely contributor
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold capitalize">
                      {model.advanced.cause.confidence}
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.cause.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.cause.detail}
                  </p>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    Evidence: {model.advanced.cause.evidence}
                  </p>
                </article>

                <article className="rounded-xl border border-border/80 bg-background/75 p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Target className="h-3.5 w-3.5" />
                    Measurable target
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.target.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.target.detail}
                  </p>
                </article>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <article className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    <TrendingUp className="h-3.5 w-3.5" />
                    Estimated upside
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.upside.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.upside.detail}
                  </p>
                </article>

                <article className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-3">
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                    <FlaskConical className="h-3.5 w-3.5" />
                    Before / after experiment
                  </div>
                  <div className="mt-2 text-sm font-semibold">{model.advanced.outcome.headline}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {model.advanced.outcome.detail}
                  </p>
                </article>
              </div>

              <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
                {model.advanced.limitation}
              </p>
            </section>

            <section className="mt-4 rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
                    <Brain className="h-4 w-4" />
                    Make this review affect the next drive
                  </div>
                  <h3 className="mt-1 font-semibold">{focusDefinition.label}</h3>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                    {focusDefinition.liveCue} Activating it adds a limited live cue on the next drive and measures progress across three comparable drives.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={focusBusy || focusAlreadyActive}
                  onClick={activateFocus}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm disabled:opacity-65"
                >
                  {focusAlreadyActive ? <CheckCircle2 className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {focusBusy
                    ? 'Activating...'
                    : focusAlreadyActive
                      ? 'Next-drive focus active'
                      : activeProgram
                        ? 'Replace active focus'
                        : 'Use this next drive'}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-primary/15 pt-3">
                <button
                  type="button"
                  onClick={onOpenTrip}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Review the evidence
                </button>
                {focusAlreadyActive && (
                  <button
                    type="button"
                    onClick={() => onOpenNextAction?.(model.focus)}
                    className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
                  >
                    <Target className="h-4 w-4" />
                    View active plan
                  </button>
                )}
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatDuration(trip.duration_seconds || 0)}</span>
                  <span className="inline-flex items-center gap-1"><Route className="h-3.5 w-3.5" />{formatDistance(trip.distance_km || 0, units)}</span>
                </div>
              </div>
            </section>

            <section className="mt-3 rounded-2xl border border-border/80 bg-background/65 p-4">
              <div className="text-xs font-semibold">Was this recommendation useful?</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Your answer is stored locally and changes how similar coaching is ranked and how strongly it prompts you.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'helpful'}
                  disabled={Boolean(feedbackBusy)}
                  onClick={() => submitFeedback('helpful')}
                  className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                    feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'helpful' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-background'
                  }`}
                >
                  <ThumbsUp className="h-4 w-4" />
                  Helpful
                </button>
                <button
                  type="button"
                  aria-pressed={feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'not_relevant'}
                  disabled={Boolean(feedbackBusy)}
                  onClick={() => submitFeedback('not_relevant')}
                  className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                    feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'not_relevant' ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-border bg-background'
                  }`}
                >
                  <X className="h-4 w-4" />
                  Not relevant
                </button>
                <button
                  type="button"
                  aria-pressed={feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'wrong_detection'}
                  disabled={Boolean(feedbackBusy)}
                  onClick={() => submitFeedback('wrong_detection')}
                  className={`inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                    feedbackRecord.focusId === model.focus && feedbackRecord.verdict === 'wrong_detection' ? 'border-red-500 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-border bg-background'
                  }`}
                >
                  <AlertTriangle className="h-4 w-4" />
                  Wrong detection
                </button>
              </div>
            </section>
          </>
        )}
        {actionStatus && (
          <p role="status" className="mt-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-foreground">
            {actionStatus}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          This review stays here while you explore. Dismiss it with the X; a newer completed trip will replace it.
        </p>
        <RoadMemoryQuickReview trip={trip} />
        <SpeedSignEvidenceReview trip={trip} className="mt-4" />
      </div>
    </section>
  );
}
