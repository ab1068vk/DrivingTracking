// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Flag,
  Gauge,
  History,
  MapPinned,
  Play,
  Route,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripDetailQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import { formatDistance } from '@/lib/tripEngine';
import useLocalSettings from '@/hooks/useLocalSettings';
import {
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  buildDrivingCoachInsights,
  buildDriverSignature,
  calculateNoHarshBrakeStreak,
  calculateWeeklyDrivingGoals,
} from '@/lib/tripInsights';
import { buildOnDeviceDriverModel, scoreTripAnomaly } from '@/lib/driverAnomaly';
import { buildHabitProfile } from '@/lib/habitProfile';
import { buildDangerZones } from '@/lib/dangerZoneEngine';
import { buildRouteComparisons } from '@/lib/mediumInsights';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import { setJson } from '@/lib/mobileStorage';
import {
  COACH_FEEDBACK_OPTIONS,
  COACH_FOCUS_CATALOG,
  COACH_PROGRAM_CHANGED_EVENT,
  buildCoachEvidenceAudit,
  buildCoachRouteOptions,
  buildCoachSegmentInsights,
  buildCoachProgramProgress,
  buildCoachRecommendations,
  buildGroundedCoachAnswer,
  buildPreTripBriefing,
  createCoachProgram,
  difficultyLabel,
  emptyCoachProgramStore,
  finishCoachProgram,
  formatCoachMetric,
  loadCoachProgramStore,
  recommendCoachDifficulty,
  reconcileCoachProgramStore,
  recordCoachFeedback,
  saveCoachProgramStore,
} from '@/lib/coachPrograms';
import { logError } from '@/lib/errorReporting';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import DeferredRecharts from '@/components/DeferredRecharts';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CARD = 'min-w-0 overflow-hidden rounded-3xl border border-border bg-card p-5 shadow-sm';
const CoachSelect = /** @type {any} */ (Select);
const CoachSelectContent = /** @type {any} */ (SelectContent);
const CoachSelectItem = /** @type {any} */ (SelectItem);
const CoachSelectTrigger = /** @type {any} */ (SelectTrigger);
const CoachSelectValue = /** @type {any} */ (SelectValue);
const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';

const eventTypeLabel = (value) => ({
  harsh_brake: 'harsh braking',
  sharp_turn: 'sharp turns',
  speeding: 'speeding',
}[value] || String(value || 'mixed events').replaceAll('_', ' '));

function Stat({ label, value, detail = null, className = '' }) {
  return (
    <div className="min-w-0 rounded-2xl bg-secondary/50 p-3">
      <div className={`break-words font-grotesk text-xl font-bold ${className}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail && <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function SectionHeading({ icon: Icon = null, eyebrow = null, title, description = null, action = null }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex min-w-0 items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
            {Icon && <Icon className="h-4 w-4" />}
            {eyebrow}
          </div>
        )}
        <h2 className="font-grotesk text-xl font-bold">{title}</h2>
        {description && <p className="mt-1 max-w-2xl break-words text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function MetricComparison({ focusId, baseline, current, target }) {
  return (
    <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-3">
      <Stat label="baseline" value={baseline == null ? 'Not measured' : formatCoachMetric(baseline, focusId)} />
      <Stat label="current" value={current == null ? 'Awaiting drive' : formatCoachMetric(current, focusId)} className={current == null ? 'text-muted-foreground' : 'text-primary'} />
      <Stat label="target" value={target == null ? 'Unavailable' : formatCoachMetric(target, focusId)} className={target == null ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-300'} />
    </div>
  );
}

function EmptyMission({ recommendation, onConfigure }) {
  if (!recommendation) {
    return (
      <section className={CARD}>
        <div className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-bold uppercase text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          Historical evidence unavailable
        </div>
        <h2 className="mt-3 font-grotesk text-2xl font-bold">Your trips are here, but their Coach measurements are not.</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Older trip records without score or event measurements are excluded. Road Sage will never turn a missing value into 0.
        </p>
        <button type="button" onClick={onConfigure} className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold hover:bg-secondary">
          Review trip evidence <ArrowRight className="h-4 w-4" />
        </button>
      </section>
    );
  }
  const focus = recommendation.focus;
  return (
    <section className={CARD}>
      <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Recommended next program
          </div>
          <h2 className="mt-3 font-grotesk text-3xl font-bold">{focus.label}</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {recommendation?.reason || focus.cue}
          </p>
          <div className="mt-4 rounded-2xl bg-secondary/50 p-4 text-sm font-semibold">{focus.cue}</div>
        </div>
        <button
          type="button"
          onClick={onConfigure}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 font-semibold text-primary-foreground"
        >
          Build my program
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

function CoachFeedback({ value = null, busy = false, onSelect }) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Was this coaching useful?</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {Object.values(COACH_FEEDBACK_OPTIONS).map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            onClick={() => onSelect(option.id)}
            className={`min-h-9 rounded-xl border px-3 text-xs font-semibold transition ${value === option.id ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary'}`}
          >
            {value === option.id && <Check className="mr-1 inline h-3.5 w-3.5" />}
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        This rates the coaching, not your driving. Incorrect detections remain reviewable in Trip Detail.
      </p>
    </div>
  );
}

export default function DrivingCoach() {
  const navigate = useNavigate();
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const [activeTab, setActiveTab] = useState('today');
  const [programStore, setProgramStore] = useState(emptyCoachProgramStore());
  const [programsLoaded, setProgramsLoaded] = useState(false);
  const [programBusy, setProgramBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [selectedFocus, setSelectedFocus] = useState('consistency');
  const [selectedDifficulty, setSelectedDifficulty] = useState('adaptive');
  const [selectedTripCount, setSelectedTripCount] = useState('5');
  const [selectedContext, setSelectedContext] = useState('comparable');
  const [coachQuestion, setCoachQuestion] = useState('');
  const [coachAnswer, setCoachAnswer] = useState(/** @type {any} */ (null));
  const [selectedRouteKey, setSelectedRouteKey] = useState('');

  const {
    data: recentCompleted = [],
    isLoading,
    isFetching: recentFetching,
    isSuccess: recentTripsLoaded,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(50),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: fullHistoryCompleted = [],
    isFetching: fullHistoryFetching,
  } = useQuery({
    ...tripSummaryQueryOptions(),
    enabled: recentTripsLoaded,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = fullHistoryCompleted.length > 0 ? fullHistoryCompleted : recentCompleted;
  const driverCompleted = useMemo(() => completed.filter(isDriverMetricEligible), [completed]);
  const isFetching = recentFetching || fullHistoryFetching;

  const coach = useMemo(() => buildDrivingCoachInsights(driverCompleted, settings), [driverCompleted, settings]);
  const activeProgram = programStore.active;
  const recommendations = useMemo(() => buildCoachRecommendations(coach, driverCompleted, programStore), [coach, driverCompleted, programStore]);
  const evidenceAudit = useMemo(() => buildCoachEvidenceAudit(completed, driverCompleted), [completed, driverCompleted]);
  const selectedRecommendation = recommendations.find((item) => item.focusId === selectedFocus) || null;
  const programProgress = useMemo(
    () => buildCoachProgramProgress(activeProgram, driverCompleted),
    [activeProgram, driverCompleted]
  );
  const driverSignature = useMemo(() => buildDriverSignature(driverCompleted), [driverCompleted]);
  const driverModel = useMemo(() => buildOnDeviceDriverModel(driverCompleted), [driverCompleted]);
  const latestTrip = driverCompleted[0] || null;
  const latestAnomaly = latestTrip && driverModel ? scoreTripAnomaly(latestTrip, driverModel) : null;
  const habitProfile = useMemo(() => buildHabitProfile(driverCompleted), [driverCompleted]);
  const routes = useMemo(() => buildRouteComparisons(driverCompleted), [driverCompleted]);
  const programRoutes = useMemo(() => buildCoachRouteOptions(driverCompleted), [driverCompleted]);
  const intelligenceRouteKey = activeProgram?.context?.routeKey || selectedRouteKey || programRoutes[0]?.routeKey || null;
  const intelligenceRoute = programRoutes.find((route) => route.routeKey === intelligenceRouteKey) || null;
  const detailedRouteTripQueries = useQueries({
    queries: (intelligenceRoute?.tripIds || []).slice(0, 5).map((tripId) => ({
      ...tripDetailQueryOptions(tripId),
      enabled: activeTab === 'patterns' && Boolean(tripId),
    })),
  });
  const detailedRouteTrips = detailedRouteTripQueries.map((query) => query.data).filter(Boolean);
  const segmentInsights = buildCoachSegmentInsights(
    detailedRouteTrips.length ? detailedRouteTrips : driverCompleted,
    intelligenceRouteKey,
    activeProgram?.focusId || selectedFocus
  );
  const preTripBriefing = useMemo(() => buildPreTripBriefing(activeProgram, driverCompleted), [activeProgram, driverCompleted]);
  const dangerZones = useMemo(() => buildDangerZones(driverCompleted), [driverCompleted]);
  const timeOfDay = useMemo(() => analyzeTimeOfDay(driverCompleted), [driverCompleted]);
  const dayOfWeek = useMemo(() => analyzeDayOfWeek(driverCompleted), [driverCompleted]);
  const weeklyGoals = useMemo(() => calculateWeeklyDrivingGoals(driverCompleted, settings), [driverCompleted, settings]);
  const noHarshBrakeStreak = useMemo(() => calculateNoHarshBrakeStreak(driverCompleted), [driverCompleted]);

  const bestTime = [...timeOfDay]
    .filter((row) => row.avgScore != null && row.trips >= 2)
    .sort((a, b) => b.avgScore - a.avgScore)[0] || null;
  const weakestTime = [...timeOfDay]
    .filter((row) => row.avgScore != null && row.trips >= 2)
    .sort((a, b) => a.avgScore - b.avgScore)[0] || null;
  const weakestDay = [...dayOfWeek]
    .filter((row) => row.avgScore != null && row.trips >= 2)
    .sort((a, b) => a.avgScore - b.avgScore)[0] || null;
  const routeOpportunity = routes.find((route) => route.trend === 'declining') || routes
    .filter((route) => route.avg_score != null)
    .sort((a, b) => a.avg_score - b.avg_score)[0] || null;
  const currentFocus = activeProgram
    ? COACH_FOCUS_CATALOG[activeProgram.focusId] || COACH_FOCUS_CATALOG.consistency
    : recommendations[0]?.focus || COACH_FOCUS_CATALOG.consistency;
  const selectedDefinition = COACH_FOCUS_CATALOG[selectedFocus] || COACH_FOCUS_CATALOG.consistency;
  const lastResultProgram = programStore.lastResult;
  const lastResultFocus = lastResultProgram
    ? COACH_FOCUS_CATALOG[lastResultProgram.focusId] || COACH_FOCUS_CATALOG.consistency
    : null;
  const latestFeedback = activeProgram && programProgress?.latestReview
    ? programStore.feedback.find((item) => item.programId === activeProgram.id && item.tripId === programProgress.latestReview.tripId)
    : null;
  const lastResultFeedback = lastResultProgram ? programStore.feedback.find((item) => item.programId === lastResultProgram.id && item.tripId === lastResultProgram.result?.latestTripId) : null;

  useEffect(() => {
    let active = true;
    loadCoachProgramStore()
      .then((store) => {
        if (active) setProgramStore(store);
      })
      .catch((error) => logError('coach_program_load', error))
      .finally(() => {
        if (active) setProgramsLoaded(true);
      });
    const handleChange = (event) => setProgramStore(event.detail || emptyCoachProgramStore());
    window.addEventListener(COACH_PROGRAM_CHANGED_EVENT, handleChange);
    return () => {
      active = false;
      window.removeEventListener(COACH_PROGRAM_CHANGED_EVENT, handleChange);
    };
  }, []);

  useEffect(() => {
    if (!activeProgram && recommendations[0]?.focusId) setSelectedFocus(recommendations[0].focusId);
  }, [activeProgram, recommendations]);

  useEffect(() => {
    if (!driverSignature) return;
    setJson(DRIVER_SIGNATURE_KEY, driverSignature).catch((error) => {
      logError('driver_signature_save', error, {
        trip_count: driverCompleted.length,
        style_shift_count: driverSignature.style_shifts?.length || 0,
      });
    });
  }, [driverSignature, driverCompleted.length]);

  const commitStore = async (nextStore) => {
    setProgramBusy(true);
    try {
      const saved = await saveCoachProgramStore(nextStore);
      setProgramStore(saved);
    } catch (error) {
      logError('coach_program_save', error, { active_program_id: nextStore?.active?.id || null });
    } finally {
      setProgramBusy(false);
    }
  };

  const startProgram = async () => {
    const next = createCoachProgram({
      focusId: selectedFocus,
      difficulty: selectedDifficulty,
      targetTripCount: Number(selectedTripCount),
      contextMode: selectedContext === 'route' ? 'comparable' : selectedContext,
      routeKey: selectedContext === 'route' ? selectedRouteKey || programRoutes[0]?.routeKey : null,
      contextSignature: selectedContext === 'route' ? programRoutes.find((route) => route.routeKey === (selectedRouteKey || programRoutes[0]?.routeKey))?.signature : null,
      contextLabel: selectedContext === 'route' ? programRoutes.find((route) => route.routeKey === (selectedRouteKey || programRoutes[0]?.routeKey))?.label : null,
      store: programStore,
      trips: driverCompleted,
    });
    const history = activeProgram
      ? [finishCoachProgram(activeProgram, driverCompleted, 'replaced'), ...programStore.history]
      : programStore.history;
    await commitStore({ ...programStore, active: next, history });
    setActiveTab('today');
  };

  const endProgram = async () => {
    if (!activeProgram) return;
    const finished = finishCoachProgram(activeProgram, driverCompleted, 'completed');
    await commitStore({ ...programStore, active: null, history: [finished, ...programStore.history] });
    setSelectedFocus(recommendations[0]?.focusId || 'consistency');
    setActiveTab('program');
  };

  const openProgramBuilder = () => {
    if (recommendations[0]?.focusId) setSelectedFocus(recommendations[0].focusId);
    setActiveTab('program');
  };

  const submitCoachFeedback = async (program, tripId, verdict) => {
    if (!program || !COACH_FEEDBACK_OPTIONS[verdict]) return;
    setFeedbackBusy(true);
    try {
      await commitStore(recordCoachFeedback(programStore, { program, tripId, verdict }));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const dismissLastResult = async () => {
    await commitStore({ ...programStore, lastResult: null });
  };

  const askCoach = (question = coachQuestion) => {
    const nextQuestion = String(question || '').trim();
    if (!nextQuestion) return;
    setCoachQuestion(nextQuestion);
    setCoachAnswer(buildGroundedCoachAnswer(nextQuestion, {
      trips: driverCompleted,
      program: activeProgram,
      progress: programProgress,
      recommendations,
    }));
  };

  useEffect(() => {
    if (!programsLoaded || !activeProgram) return;
    const reconciled = reconcileCoachProgramStore(programStore, driverCompleted);
    if (reconciled.active !== programStore.active) commitStore(reconciled);
  }, [
    activeProgram,
    driverCompleted,
    programsLoaded,
    programStore,
  ]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Driving Coach" description="Building your personal coaching workspace" icon={Target} />
        {[1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-3xl bg-secondary/60" />)}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden pb-6">
      <PageHeader
        title="Driving Coach"
        description="One active habit, measured across comparable drives"
        icon={Target}
        status={<InlineRefreshBadge visible={isFetching} label="Refreshing coaching" />}
      />

      {completed.length === 0 ? (
        <PageEmptyState
          icon={Target}
          title="Your coach is ready to learn"
          description="Complete a few normal trips. Road Sage will build a personal baseline, recommend one focus, and measure it across comparable drives."
        />
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
          <div className="overflow-x-auto pb-1">
            <TabsList className="min-w-max rounded-full border border-border bg-card p-1">
              <TabsTrigger value="today" className="rounded-full px-4">Today</TabsTrigger>
              <TabsTrigger value="program" className="rounded-full px-4">Program</TabsTrigger>
              <TabsTrigger value="patterns" className="rounded-full px-4">Patterns</TabsTrigger>
              <TabsTrigger value="profile" className="rounded-full px-4">Driver Model</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="today" className="mt-0 space-y-5">
            {!programsLoaded ? (
              <div className="h-48 animate-pulse rounded-3xl bg-secondary/60" />
            ) : lastResultProgram ? (
              <section className={`${CARD} overflow-hidden border-emerald-500/40 bg-emerald-500/5`}>
                <div className="grid gap-5 xl:grid-cols-[1fr_320px] xl:items-center">
                  <div>
                    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-bold uppercase text-emerald-700 dark:text-emerald-300">
                      <Trophy className="h-4 w-4" /> Program graduated automatically
                    </div>
                    <h2 className="mt-3 font-grotesk text-3xl font-bold">{lastResultFocus?.label}</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      You met the target across the full comparison group. Road Sage archived the program and stopped its mission prompts.
                    </p>
                    <div className="mt-4">
                      <MetricComparison
                        focusId={lastResultProgram.focusId}
                        baseline={lastResultProgram.result?.baselineMetric}
                        current={lastResultProgram.result?.currentMetric}
                        target={lastResultProgram.result?.targetMetric}
                      />
                    </div>
                    <CoachFeedback
                      value={lastResultFeedback?.verdict}
                      busy={feedbackBusy}
                      onSelect={(verdict) => submitCoachFeedback(lastResultProgram, lastResultProgram.result?.latestTripId, verdict)}
                    />
                  </div>
                  <div className="rounded-2xl border border-emerald-500/25 bg-card p-4">
                    <div className="text-xs font-bold uppercase text-emerald-700 dark:text-emerald-300">Measured change</div>
                    <div className="mt-2 font-grotesk text-4xl font-bold">
                      {lastResultProgram.result?.improvement == null ? 'Target met' : `${lastResultProgram.result.improvement > 0 ? '+' : ''}${lastResultProgram.result.improvement}${lastResultProgram.result.improvementUnit === '%' ? '%' : ' pts'}`}
                    </div>
                    <div className="mt-4 grid gap-2">
                      <button type="button" onClick={() => { dismissLastResult(); openProgramBuilder(); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 font-semibold text-primary-foreground">
                        Choose next mission <ArrowRight className="h-4 w-4" />
                      </button>
                      <button type="button" onClick={dismissLastResult} className="min-h-10 rounded-xl border border-border px-3 text-sm font-semibold">
                        Dismiss result
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            ) : !activeProgram ? (
              <EmptyMission recommendation={recommendations[0]} onConfigure={openProgramBuilder} />
            ) : (
              <section className={`${CARD} overflow-hidden border-primary/30`}>
                <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase text-primary">Active mission</span>
                      <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground">
                        {difficultyLabel(activeProgram.difficulty)} {'\u00b7'} {activeProgram.context?.label}
                      </span>
                    </div>
                    <h2 className="mt-3 font-grotesk text-3xl font-bold">{currentFocus.label}</h2>
                    <p className="mt-2 text-sm text-muted-foreground">{currentFocus.cue}</p>

                    <div className="mt-5">
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="font-semibold">Drive {programProgress?.completedCount || 0} of {activeProgram.targetTripCount}</span>
                        <span className="text-muted-foreground">{programProgress?.confidence || 'early'} evidence</span>
                      </div>
                      <div className="h-3 overflow-hidden rounded-full bg-primary/20" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={programProgress?.progressPercent || 0}>
                        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${programProgress?.progressPercent || 0}%` }} />
                      </div>
                    </div>

                    <div className="mt-5">
                      <MetricComparison
                        focusId={activeProgram.focusId}
                        baseline={programProgress?.baselineMetric}
                        current={programProgress?.currentMetric}
                        target={programProgress?.targetMetric}
                      />
                    </div>
                  </div>

                  <div className="rounded-3xl bg-primary p-5 text-primary-foreground">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase opacity-80">
                      <Play className="h-4 w-4" />
                      Before the next drive
                    </div>
                    <div className="mt-3 text-xl font-grotesk font-bold">{currentFocus.shortLabel}</div>
                    <p className="mt-2 text-sm opacity-90">{currentFocus.liveCue}</p>
                    <button
                      type="button"
                      onClick={() => navigate('/')}
                      className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 font-semibold text-slate-950"
                    >
                      Start coached drive
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                  <button type="button" onClick={() => setActiveTab('program')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-secondary">
                    <Target className="h-4 w-4" /> Change focus
                  </button>
                  <button type="button" disabled={programBusy} onClick={endProgram} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-secondary">
                    <Flag className="h-4 w-4" /> End program
                  </button>
                </div>
              </section>
            )}

            {activeProgram && preTripBriefing && (
              <section className={CARD}>
                <SectionHeading
                  icon={ShieldCheck}
                  eyebrow="Pre-trip briefing"
                  title={preTripBriefing.title}
                  description={`${preTripBriefing.context} \u00b7 ${preTripBriefing.confidence} evidence`}
                />
                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  {preTripBriefing.bullets.map((bullet, index) => (
                    <div key={bullet} className="flex gap-3 rounded-2xl bg-secondary/50 p-3 text-sm">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">{index + 1}</span>
                      <span className="text-muted-foreground">{bullet}</span>
                    </div>
                  ))}
                </div>
                {dangerZones.length > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">{dangerZones.length} recurring event area{dangerZones.length === 1 ? '' : 's'} remains visible in Patterns; this does not claim a road cause.</p>
                )}
              </section>
            )}

            <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
              <section className={CARD}>
                <SectionHeading
                  icon={Activity}
                  eyebrow="Post-drive review"
                  title={programProgress?.latestReview ? 'What changed on the last mission drive' : 'Your next result will appear here'}
                  description={programProgress?.latestReview
                    ? 'This result is measured against the active program target, not a generic all-time score.'
                    : 'Complete an eligible drive after starting the program to begin measuring progress.'}
                />
                {programProgress?.latestReview ? (
                  <div className="mt-4 rounded-2xl border border-border bg-secondary/30 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className={`flex items-center gap-2 font-semibold ${programProgress.latestReview.metTarget ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                          {programProgress.latestReview.metTarget ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
                          {programProgress.latestReview.metTarget ? 'Target reached on this drive' : 'Keep practising this focus'}
                        </div>
                        <div className="mt-2 text-sm text-muted-foreground">
                          {new Date(programProgress.latestReview.startTime).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                          {' \u00b7 '}{formatDistance(programProgress.latestReview.distanceKm, units)}
                          {programProgress.latestReview.score == null ? '' : ` \u00b7 score ${formatEstimatedScore(programProgress.latestReview.score)}`}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-grotesk text-2xl font-bold">{formatCoachMetric(programProgress.latestReview.metric, activeProgram?.focusId)}</div>
                        <div className="text-xs text-muted-foreground">mission metric</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => programProgress.latestReview.tripId && navigate(`/trips/${programProgress.latestReview.tripId}`)}
                      disabled={!programProgress.latestReview.tripId}
                      className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-semibold disabled:opacity-50"
                    >
                      Review trip evidence <ArrowRight className="h-4 w-4" />
                    </button>
                    <CoachFeedback
                      value={latestFeedback?.verdict}
                      busy={feedbackBusy}
                      onSelect={(verdict) => submitCoachFeedback(activeProgram, programProgress.latestReview.tripId, verdict)}
                    />
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">
                    The coach will show the exact trip metric, whether it met the target, and a direct link to review detected events.
                  </div>
                )}
              </section>

              <section className={CARD}>
                <SectionHeading icon={ShieldCheck} eyebrow="Drive readiness" title="Personal context" />
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Stat value={`${Math.round(habitProfile.confidence * 100)}%`} label="model confidence" />
                  <Stat value={`${habitProfile.fatigueOnsetMinutes} min`} label="learned fatigue onset" />
                  <Stat value={bestTime?.label || 'Learning'} label="strongest window" />
                  <Stat value={noHarshBrakeStreak} label="clean-braking day streak" />
                </div>
                {weakestTime && bestTime && weakestTime.id !== bestTime.id && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {weakestTime.label} trips average {formatEstimatedScore(weakestTime.avgScore)}, versus {formatEstimatedScore(bestTime.avgScore)} in your strongest window.
                  </p>
                )}
              </section>
            </div>

            <details className={`${CARD} group`}>
              <summary className="cursor-pointer list-none">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
                      <Flag className="h-4 w-4" /> Connected goals
                    </span>
                    <span className="mt-2 block font-grotesk text-xl font-bold">This week</span>
                    <span className="mt-1 block text-sm text-muted-foreground">Open your supporting weekly goals when you want a wider progress check.</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </span>
              </summary>
              <div className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-3 xl:grid-cols-5">
                {weeklyGoals.map((goal) => (
                  <div key={goal.id} className={`rounded-2xl border p-3 ${goal.met ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{goal.label}</span>
                      {goal.met ? <Check className="h-4 w-4 text-emerald-500" /> : <Target className="h-4 w-4 text-amber-500" />}
                    </div>
                    <div className="mt-2 font-grotesk text-xl font-bold">{goal.value}/{goal.target}{goal.unit ? ` ${goal.unit}` : ''}</div>
                  </div>
                ))}
              </div>
            </details>

            <details className={`${CARD} group`}>
              <summary className="cursor-pointer list-none">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-primary">
                      <Brain className="h-4 w-4" /> Ask Coach
                    </span>
                    <span className="mt-2 block font-grotesk text-xl font-bold">Ask about your own evidence</span>
                    <span className="mt-1 block text-sm text-muted-foreground">Open the local evidence assistant for a deeper explanation.</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                </span>
              </summary>
              <form className="mt-4 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row" onSubmit={(event) => { event.preventDefault(); askCoach(); }}>
                <input
                  value={coachQuestion}
                  onChange={(event) => setCoachQuestion(event.target.value)}
                  placeholder="Why did my focus change?"
                  className="min-h-11 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                />
                <button type="submit" className="min-h-11 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground">Ask Coach</button>
              </form>
              <div className="mt-2 flex flex-wrap gap-2">
                {['Why this focus?', 'Am I improving?', 'Where do events repeat?', 'What about fatigue?'].map((question) => (
                  <button key={question} type="button" onClick={() => askCoach(question)} className="min-h-8 rounded-full border border-border px-3 text-xs font-semibold hover:bg-secondary">{question}</button>
                ))}
              </div>
              {coachAnswer && (
                <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                  <div className="text-sm font-semibold">{coachAnswer.answer}</div>
                  <div className="mt-3 rounded-xl bg-card p-3 text-xs text-muted-foreground">
                    <span className="font-bold uppercase text-primary">Inference</span>
                    <p className="mt-1">{coachAnswer.inference}</p>
                  </div>
                  {coachAnswer.evidence.length > 0 && (
                    <div className="mt-3">
                      <div className="text-xs font-bold uppercase text-muted-foreground">Trip evidence</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {coachAnswer.evidence.map((item) => (
                          <button key={item.tripId} type="button" onClick={() => navigate(`/trips/${item.tripId}`)} className="min-h-9 rounded-xl border border-border bg-card px-3 text-xs font-semibold">
                            {item.label} <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="mt-3 text-[11px] text-muted-foreground">{coachAnswer.limitation}</p>
                </div>
              )}
            </details>
          </TabsContent>

          <TabsContent value="program" className="mt-0 space-y-5">
            <section className={CARD}>
              <SectionHeading icon={ShieldCheck} eyebrow="Historical evidence audit" title="What the Coach can actually measure" description="A numeric 0 appears only when a trip explicitly recorded zero events. Missing legacy values are labelled unavailable and excluded." />
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <Stat value={evidenceAudit.totalCompleted || 'None'} label="completed trips found" />
                <Stat value={evidenceAudit.driverEligible || 'None eligible'} label="driver trips eligible" />
                <Stat value={evidenceAudit.scoreReady ? `${evidenceAudit.scoreReady} trips` : 'Not measured'} label="score evidence" />
                <Stat value={evidenceAudit.eventReady ? `${evidenceAudit.eventReady} trips` : 'Not measured'} label="event evidence" />
                <Stat value={evidenceAudit.routeReady ? `${evidenceAudit.routeReady} trips` : 'No route key'} label="route evidence" />
              </div>
              {(evidenceAudit.missingCoachMeasurements > 0 || evidenceAudit.excludedDriver > 0 || evidenceAudit.excludedPrivacy > 0) && (
                <div className="mt-4 space-y-1 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs text-muted-foreground">
                  {evidenceAudit.missingCoachMeasurements > 0 && <p><span className="font-semibold text-foreground">{evidenceAudit.missingCoachMeasurements} historical trips:</span> no reliable score or Coach event measurement; excluded, never counted as 0.</p>}
                  {evidenceAudit.excludedDriver > 0 && <p><span className="font-semibold text-foreground">{evidenceAudit.excludedDriver} trips:</span> passenger or manually excluded from driver metrics.</p>}
                  {evidenceAudit.excludedPrivacy > 0 && <p><span className="font-semibold text-foreground">{evidenceAudit.excludedPrivacy} trips from privacy-protected days:</span> excluded only from cross-trip Coach trends because at least one trip that day touched a privacy zone. They remain in Trip History.</p>}
                </div>
              )}
            </section>

            <section className={CARD}>
              <SectionHeading
                icon={Target}
                eyebrow={activeProgram ? 'Change program' : 'Build a program'}
                title="Choose one habit to practise"
                description="Road Sage recommends the highest-value focus, but you remain in control. Starting a new program archives the current one."
              />
              <div className="mt-5 grid gap-3 lg:grid-cols-3">
                {recommendations.map((recommendation, index) => {
                  const selected = selectedFocus === recommendation.focusId;
                  return (
                    <button
                      key={recommendation.focusId}
                      type="button"
                      onClick={() => setSelectedFocus(recommendation.focusId)}
                      className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/40'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-bold uppercase text-primary">{index === 0 ? 'Recommended' : recommendation.priority}</div>
                          <div className="mt-1 font-semibold">{recommendation.focus.label}</div>
                        </div>
                        {selected && <CheckCircle2 className="h-5 w-5 text-primary" />}
                      </div>
                      <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{recommendation.reason}</p>
                      {recommendation.evidence && <div className="mt-3 text-xs font-semibold">{recommendation.evidence}</div>}
                      <div className="mt-3 rounded-xl bg-secondary/50 p-2 text-[11px] text-muted-foreground">
                        <span className="font-semibold text-foreground">Why now: </span>
                        {recommendation.whyNow}
                      </div>
                    </button>
                  );
                })}
                {recommendations.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground lg:col-span-3">
                    No focus is recommended yet because fewer than two trips contain a comparable measurement. Complete a newly measured drive; old missing fields will remain excluded.
                  </div>
                )}
              </div>
            </section>

            <div className="grid min-w-0 gap-5 xl:grid-cols-[1fr_0.85fr]">
              <section className={CARD}>
                <SectionHeading title="Program settings" description="Control the challenge, duration, and comparison group." />
                <div className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
                  <label className="min-w-0 space-y-2 text-sm font-semibold">
                    Difficulty
                    <CoachSelect value={selectedDifficulty} onValueChange={setSelectedDifficulty}>
                      <CoachSelectTrigger className="h-11 w-full min-w-0 overflow-hidden rounded-xl [&>span]:truncate"><CoachSelectValue /></CoachSelectTrigger>
                      <CoachSelectContent>
                        <CoachSelectItem value="adaptive">Adaptive</CoachSelectItem>
                        <CoachSelectItem value="gentle">Gentle</CoachSelectItem>
                        <CoachSelectItem value="standard">Standard</CoachSelectItem>
                        <CoachSelectItem value="intensive">Intensive</CoachSelectItem>
                      </CoachSelectContent>
                    </CoachSelect>
                    <span className="block text-xs font-normal text-muted-foreground">Adaptive uses only completed, measured programs. Targets range from 15% to 35%.</span>
                  </label>
                  <label className="min-w-0 space-y-2 text-sm font-semibold">
                    Program length
                    <CoachSelect value={selectedTripCount} onValueChange={setSelectedTripCount}>
                      <CoachSelectTrigger className="h-11 w-full min-w-0 overflow-hidden rounded-xl [&>span]:truncate"><CoachSelectValue /></CoachSelectTrigger>
                      <CoachSelectContent>
                        <CoachSelectItem value="3">3 drives</CoachSelectItem>
                        <CoachSelectItem value="5">5 drives</CoachSelectItem>
                        <CoachSelectItem value="10">10 drives</CoachSelectItem>
                      </CoachSelectContent>
                    </CoachSelect>
                    <span className="block text-xs font-normal text-muted-foreground">Use 5 drives for a balanced check; 3 is exploratory and 10 is stronger evidence.</span>
                  </label>
                  <label className="min-w-0 space-y-2 text-sm font-semibold sm:col-span-2">
                    Compare against
                    <CoachSelect value={selectedContext} onValueChange={setSelectedContext}>
                      <CoachSelectTrigger className="h-11 w-full min-w-0 overflow-hidden rounded-xl [&>span]:truncate"><CoachSelectValue /></CoachSelectTrigger>
                      <CoachSelectContent>
                        <CoachSelectItem value="route" disabled={programRoutes.length === 0}>Specific repeated route</CoachSelectItem>
                        <CoachSelectItem value="comparable">Comparable drives</CoachSelectItem>
                        <CoachSelectItem value="urban">Urban drives</CoachSelectItem>
                        <CoachSelectItem value="highway">Highway drives</CoachSelectItem>
                        <CoachSelectItem value="all">All eligible drives</CoachSelectItem>
                      </CoachSelectContent>
                    </CoachSelect>
                    <span className="block text-xs font-normal text-muted-foreground">Comparable matches route and driving context when that evidence exists.</span>
                  </label>
                  {selectedContext === 'route' && (
                    <label className="min-w-0 space-y-2 text-sm font-semibold sm:col-span-2">
                      Repeated route
                      <CoachSelect value={selectedRouteKey || programRoutes[0]?.routeKey || ''} onValueChange={setSelectedRouteKey}>
                        <CoachSelectTrigger className="h-11 w-full min-w-0 overflow-hidden rounded-xl [&>span]:truncate"><CoachSelectValue placeholder="Choose a repeated route" /></CoachSelectTrigger>
                        <CoachSelectContent>
                          {programRoutes.map((route) => (
                            <CoachSelectItem key={route.routeKey} value={route.routeKey}>
                              {route.label} - {route.tripCount} drives
                            </CoachSelectItem>
                          ))}
                        </CoachSelectContent>
                      </CoachSelect>
                    </label>
                  )}
                </div>
                {selectedDifficulty === 'adaptive' && (
                  <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Suggested {recommendCoachDifficulty(selectedFocus, programStore).difficulty}: </span>
                    {recommendCoachDifficulty(selectedFocus, programStore).reason}
                  </div>
                )}
                <button
                  type="button"
                  disabled={programBusy || driverCompleted.length === 0 || !selectedRecommendation}
                  onClick={startProgram}
                  className="mt-5 inline-flex min-h-12 w-full min-w-0 items-center justify-center gap-2 rounded-2xl bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-60"
                >
                  <Play className="h-4 w-4" />
                  <span className="sm:hidden">{activeProgram ? 'Replace mission' : 'Start mission'}</span>
                  <span className="hidden sm:inline">{activeProgram ? `Replace with ${selectedDefinition.label}` : `Start ${selectedDefinition.label}`}</span>
                </button>
                {!selectedRecommendation && <p className="mt-2 text-xs text-muted-foreground">Start is disabled until this focus has at least two measured historical trips.</p>}
              </section>

              <section className={CARD}>
                {selectedRecommendation ? (
                  <>
                    <SectionHeading icon={Activity} eyebrow="Practice plan" title={selectedDefinition.label} description={selectedDefinition.cue} />
                    <div className="mt-4 space-y-2">
                      {selectedDefinition.drill.map((step, index) => (
                        <div key={step} className="flex gap-3 rounded-2xl bg-secondary/50 p-3 text-sm">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">{index + 1}</span>
                          <span className="text-muted-foreground">{step}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                      <div className="text-xs font-bold uppercase text-primary">Live cue</div>
                      <p className="mt-1 text-sm font-semibold">{selectedDefinition.liveCue}</p>
                      <p className="mt-2 text-xs text-muted-foreground">Live coaching keeps safety-critical warnings and limits habit prompts using the selected difficulty.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <SectionHeading icon={Activity} eyebrow="Practice plan" title="No measured focus available" description="Road Sage needs comparable measurements before it can make a real plan." />
                    <div className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">The next newly recorded trip can qualify. Historical trips with missing Coach fields stay visible in your trip history but do not become fake zeros here.</div>
                  </>
                )}
              </section>
            </div>

            <section className={CARD}>
              <SectionHeading icon={History} eyebrow="Program history" title="What coaching has worked" description="Completed and replaced programs stay local on this device." />
              {programStore.history.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">Finish your first program to build a coaching-effectiveness history.</div>
              ) : (
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {programStore.history.slice(0, 6).map((program) => {
                    const focus = COACH_FOCUS_CATALOG[program.focusId] || COACH_FOCUS_CATALOG.consistency;
                    return (
                      <div key={program.id} className="rounded-2xl border border-border p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{focus.label}</span>
                          {program.result?.graduated ? <Trophy className="h-4 w-4 text-amber-500" /> : <History className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {program.result?.completedCount || 0}/{program.targetTripCount} drives {'\u00b7'} {program.status}
                        </div>
                        <div className="mt-3 font-grotesk text-xl font-bold">
                          {program.result?.improvement == null ? 'No measured change' : `${program.result.improvement > 0 ? '+' : ''}${program.result.improvement}${program.result.improvementUnit === '%' ? '%' : ' pts'}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="patterns" className="mt-0 space-y-5">
            <section className={CARD}>
              <SectionHeading
                icon={MapPinned}
                eyebrow="Context intelligence"
                title="Where and when your driving changes"
                description="Patterns are separated from the active mission so the coach can monitor secondary risks without constantly changing your focus."
                action={(
                  <button type="button" onClick={() => navigate('/map')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-secondary">
                    Open map <ArrowRight className="h-4 w-4" />
                  </button>
                )}
              />
              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <Stat value={routes.length || 'Not enough evidence'} label="repeated routes" detail="matched by similar start and end areas" />
                <Stat value={dangerZones.length || 'Not enough evidence'} label="repeated event areas" detail="harsh braking, speeding, or sharp-turn clusters" />
                <Stat value={weakestTime?.label || 'Learning'} label="highest-pressure window" detail={weakestTime ? `average ${formatEstimatedScore(weakestTime.avgScore)}` : 'needs comparable trips'} />
              </div>
            </section>

            <div className="grid gap-5 xl:grid-cols-2">
              <section className={CARD}>
                <SectionHeading icon={Route} eyebrow="Route opportunity" title={routeOpportunity?.label || 'Build a repeated-route baseline'} description={routeOpportunity
                  ? `${routeOpportunity.trip_count} matched trips \u00b7 ${routeOpportunity.trend} trend \u00b7 strongest near ${routeOpportunity.safest_time}`
                  : 'Drive the same route twice to unlock route-specific coaching.'}
                />
                {routeOpportunity && (
                  <>
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      <Stat value={formatEstimatedScore(routeOpportunity.avg_score)} label="average score" />
                      <Stat value={routeOpportunity.best_score ?? '-'} label="best score" />
                      <Stat value={`${routeOpportunity.avg_duration_minutes} min`} label="average time" />
                    </div>
                    <button type="button" disabled={!routeOpportunity.last_trip_id} onClick={() => routeOpportunity.last_trip_id && navigate(`/trips/${routeOpportunity.last_trip_id}`)} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold disabled:opacity-50">
                      Review latest matched trip <ArrowRight className="h-4 w-4" />
                    </button>
                  </>
                )}
              </section>

              <section className={CARD}>
                <SectionHeading icon={Clock3} eyebrow="Pressure windows" title="Personal time pattern" />
                <div className="mt-4 space-y-3">
                  {timeOfDay.map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-3 rounded-2xl bg-secondary/50 p-3">
                      <div>
                        <div className="font-semibold">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.trips} trips {'\u00b7'} {row.events} risk events</div>
                      </div>
                      <div className="font-grotesk text-2xl font-bold">{formatEstimatedScore(row.avgScore)}</div>
                    </div>
                  ))}
                </div>
                {weakestDay && <p className="mt-3 text-xs text-muted-foreground">Your weakest sufficiently sampled day is {weakestDay.day}, averaging {formatEstimatedScore(weakestDay.avgScore)}.</p>}
              </section>
            </div>

            <section className={CARD}>
              <SectionHeading icon={AlertTriangle} eyebrow="Repeated event areas" title={dangerZones.length ? `${dangerZones.length} local areas need attention` : 'No repeated event area has enough evidence yet'} description="Coordinates stay in the existing private map workflow; this summary only explains the pattern." />
              {dangerZones.length > 0 && (
                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {dangerZones.slice(0, 6).map((zone) => (
                    <div key={zone.id} className="rounded-2xl border border-border p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold capitalize">{eventTypeLabel(zone.dominantType)}</span>
                        <span className={`rounded-full px-2 py-1 text-xs font-bold uppercase ${zone.riskLevel === 'critical' || zone.riskLevel === 'high' ? 'bg-red-500/10 text-red-600 dark:text-red-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>{zone.riskLevel}</span>
                      </div>
                      <div className="mt-2 text-sm text-muted-foreground">{zone.eventCount} events in an approximately {Math.round(zone.radiusM)} m area.</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className={CARD}>
              <SectionHeading icon={Gauge} eyebrow="Evidence explorer" title="What is driving the recommendation" />
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {(coach.risk_patterns || []).map((pattern) => (
                  <div key={pattern.key} className="rounded-2xl bg-secondary/50 p-4">
                    <div className="font-semibold">{pattern.label}</div>
                    <div className="mt-2 font-grotesk text-2xl font-bold">{pattern.events_per_100km ?? '-'} / 100 km</div>
                    <div className="mt-1 text-xs text-muted-foreground">{pattern.share_percent}% of recorded risk events</div>
                  </div>
                ))}
                {(coach.risk_patterns || []).length === 0 && <div className="text-sm text-muted-foreground">No dominant risk event is currently strong enough to display.</div>}
              </div>
            </section>

            <section className={CARD}>
              <SectionHeading
                icon={Route}
                eyebrow="Segment intelligence"
                title={intelligenceRoute?.label || 'Choose a repeated route'}
                description={segmentInsights.explanation}
                action={intelligenceRoute?.lastTripId ? (
                  <button type="button" onClick={() => navigate(`/trips/${intelligenceRoute.lastTripId}`)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold">
                    Open route evidence <ArrowRight className="h-4 w-4" />
                  </button>
                ) : null}
              />
              {programRoutes.length > 1 && !activeProgram?.context?.routeKey && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {programRoutes.slice(0, 5).map((route) => (
                    <button key={route.routeKey} type="button" onClick={() => setSelectedRouteKey(route.routeKey)} className={`min-h-9 rounded-xl border px-3 text-xs font-semibold ${route.routeKey === intelligenceRouteKey ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
                      {route.label}
                    </button>
                  ))}
                </div>
              )}
              {intelligenceRoute ? (
                <div className="mt-4">
                  <div className="mb-3 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-secondary px-3 py-1 font-semibold">{segmentInsights.tripCount} detailed drives</span>
                    <span className="rounded-full bg-secondary px-3 py-1 font-semibold">{segmentInsights.locatedEvents} located events</span>
                    <span className="rounded-full bg-secondary px-3 py-1 font-semibold">{segmentInsights.evidenceLevel} evidence</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {segmentInsights.sections.map((section) => (
                      <div key={section.id} className={`rounded-2xl border p-4 ${segmentInsights.strongestSection?.id === section.id && section.eventCount ? 'border-amber-500/35 bg-amber-500/5' : 'border-border'}`}>
                        <div className="text-sm font-semibold">{section.label}</div>
                        <div className="mt-2 font-grotesk text-2xl font-bold">{section.eventCount}</div>
                        <div className="text-xs text-muted-foreground">events {'\u00b7'} repeated on {section.repeatRate}% of detailed drives</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="mt-4 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">Complete the same route twice to unlock section-by-section comparisons.</div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="profile" className="mt-0 space-y-5">
            <section className={CARD}>
              <SectionHeading
                icon={Brain}
                eyebrow="Operational driver model"
                title={driverSignature ? driverSignature.archetype.replaceAll('_', ' ') : 'Building your personal model'}
                description={driverSignature
                  ? `Built locally from ${driverSignature.trip_count_used} recent trips. Each signal below explains how it changes coaching.`
                  : 'Complete at least five scored trips to unlock your driver signature.'}
              />
              {driverSignature && (
                <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                  <div className="rounded-2xl bg-secondary/30 p-3">
                    <DeferredRecharts height={260}>
                      {({ ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar, Tooltip }) => {
                        const data = [
                          ['Aggression', driverSignature.dimensions.aggression],
                          ['Smoothness', driverSignature.dimensions.smoothness],
                          ['Eco', driverSignature.dimensions.ecoMindedness],
                          ['Speed tolerance', driverSignature.dimensions.speedTolerance],
                          ['Consistency', driverSignature.dimensions.consistencyIdx],
                        ].map(([dimension, value]) => ({ dimension, value: Math.round(Number(value) * 100) }));
                        return (
                          <ResponsiveContainer width="100%" height={260}>
                            <RadarChart data={data} outerRadius={86}>
                              <PolarGrid />
                              <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10 }} />
                              <Radar dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.24} />
                              <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 10, fontSize: 11 }} />
                            </RadarChart>
                          </ResponsiveContainer>
                        );
                      }}
                    </DeferredRecharts>
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-border p-4">
                      <div className="text-xs font-bold uppercase text-primary">Stable strength</div>
                      <div className="mt-1 font-semibold">{bestTime ? `${bestTime.label} driving` : 'Still calibrating'}</div>
                      <p className="mt-1 text-xs text-muted-foreground">{bestTime ? `${bestTime.trips} trips average ${formatEstimatedScore(bestTime.avgScore)}. The coach uses this as a personal reference set.` : 'More repeated contexts are needed before naming a stable strength.'}</p>
                    </div>
                    <div className="rounded-2xl border border-border p-4">
                      <div className="text-xs font-bold uppercase text-primary">Developing weakness</div>
                      <div className="mt-1 font-semibold">{recommendations[0]?.focus.label || 'Consistency'}</div>
                      <p className="mt-1 text-xs text-muted-foreground">{recommendations[0]?.reason || currentFocus.cue}</p>
                    </div>
                    <div className="rounded-2xl border border-border p-4">
                      <div className="text-xs font-bold uppercase text-primary">Fatigue response</div>
                      <div className="mt-1 font-semibold">Performance change estimated near {habitProfile.fatigueOnsetMinutes} minutes</div>
                      <p className="mt-1 text-xs text-muted-foreground">This is learned from your local multi-trip history and is not a medical fatigue measurement.</p>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <div className="grid gap-5 xl:grid-cols-2">
              <section className={CARD}>
                <SectionHeading icon={TrendingUp} eyebrow="Recent shift" title={latestAnomaly?.anomaly_level && latestAnomaly.anomaly_level !== 'unknown' ? `${latestAnomaly.anomaly_level} difference from your norm` : 'No unusual recent shift'} />
                {latestAnomaly?.anomaly_level && latestAnomaly.anomaly_level !== 'unknown' ? (
                  <div className="mt-4">
                    <div className="font-grotesk text-3xl font-bold">{formatEstimatedScore(latestAnomaly.anomaly_score)}/100</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Last trip compared with {latestAnomaly.model_trip_count} local trips.
                      {latestAnomaly.reasons.length ? ` Unusual signals: ${latestAnomaly.reasons.join(', ').replaceAll('_', ' ')}.` : ''}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">A difference means the trip was unusual for you, not necessarily unsafe.</p>
                  </div>
                ) : <p className="mt-4 text-sm text-muted-foreground">The latest trip is within the normal range of your local driver model.</p>}
              </section>

              <section className={CARD}>
                <SectionHeading icon={Trophy} eyebrow="Coaching responsiveness" title={programStore.history.length ? 'Your completed programs' : 'Complete a program to measure what works'} />
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Stat value={programStore.history.length} label="programs" />
                  <Stat value={programStore.history.filter((item) => item.result?.graduated).length} label="graduated" />
                  <Stat value={programStore.history.filter((item) => Number(item.result?.improvement) > 0).length} label="improved" />
                </div>
                <p className="mt-3 text-xs text-muted-foreground">Road Sage can use this history to show which drills and difficulty levels produce measurable changes for you.</p>
              </section>
            </div>

            <section className={CARD}>
              <SectionHeading icon={ShieldCheck} eyebrow="Model transparency" title="Evidence and limitations" />
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <Stat value={driverCompleted.length} label="eligible driver trips" />
                <Stat value={`${Math.round(habitProfile.confidence * 100)}%`} label="habit-model confidence" />
                <Stat value={formatDistance(coach.risk_rate.distance_km, units)} label="coaching distance" />
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                Scores, event detections, readiness, repeated areas, and coaching targets are personal GPS/sensor estimates. They are not validated collision-risk, medical, legal, or insurance assessments. Review incorrect events from Trip Detail so future evidence is based on corrected trips.
              </p>
            </section>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
