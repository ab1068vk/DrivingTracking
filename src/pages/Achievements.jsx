// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import confetti from 'canvas-confetti';
import {
  Activity, Award, BadgeCheck, Brain, CalendarClock, CarFront, Check, ChevronRight,
  CircleGauge, Gauge, History, Leaf, LockKeyhole, Medal, Route, ShieldCheck,
  SlidersHorizontal, Sparkles, Target, TrendingDown, TrendingUp, Trophy, Zap,
} from 'lucide-react';
import { limitedTripSummaryQueryOptions, tripSummaryQueryOptions } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import useLocalSettings from '@/hooks/useLocalSettings';
import { formatDistance } from '@/lib/tripEngine';
import {
  convertDistanceKm,
  convertPerDistanceRate,
  distanceUnitLabel,
} from '@/lib/unitFormatting';
import { calculateAchievementBadges } from '@/lib/tripInsights';
import {
  buildDriverProgression,
  acknowledgeDriverProgressionCelebration,
  loadDriverProgressionLedger,
  syncDriverProgressionLedger,
  updateDriverProgressionMissionSelection,
} from '@/lib/driverProgression';
import { syncAchievementNotifications } from '@/lib/notificationService';
import InlineRefreshBadge from '@/components/InlineRefreshBadge';
import InlineLoadError from '@/components/InlineLoadError';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

const TRACK_ICONS = {
  braking: ShieldCheck,
  acceleration: Zap,
  cornering: Route,
  speed: Gauge,
  consistency: Activity,
  focus: Brain,
  eco: Leaf,
};

const TIER_COLORS = {
  bronze: 'border-amber-700/40 bg-amber-700/10 text-amber-700 dark:text-amber-300',
  silver: 'border-slate-400/50 bg-slate-400/10 text-slate-600 dark:text-slate-200',
  gold: 'border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
  platinum: 'border-cyan-400/50 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300',
  master: 'border-violet-500/50 bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

const STATUS_STYLES = {
  complete: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  on_track: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  at_risk: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
  building_evidence: 'bg-secondary text-muted-foreground',
};

const STATUS_LABELS = {
  complete: 'Complete',
  on_track: 'On track',
  at_risk: 'Needs attention',
  building_evidence: 'Building evidence',
};

const formatNumber = (value, digits = 0) => {
  if (value == null || !Number.isFinite(Number(value))) return 'No evidence';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
};

const formatDate = (value) => {
  if (!value) return 'Recorded history';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recorded history' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function RequirementRow({ item, units }) {
  const digits = String(item.unit).includes('100') ? 2 : 1;
  let displayValue = item.value;
  let displayTarget = item.target;
  let displayUnit = item.unit;
  if (item.unit === 'km') {
    displayValue = convertDistanceKm(item.value, units);
    displayTarget = convertDistanceKm(item.target, units);
    displayUnit = distanceUnitLabel(units);
  } else if (String(item.unit).includes('100 km')) {
    displayValue = convertPerDistanceRate(item.value, units);
    displayTarget = convertPerDistanceRate(item.target, units);
    displayUnit = String(item.unit).replace('100 km', `100 ${distanceUnitLabel(units)}`);
  }
  const current = formatNumber(displayValue, digits);
  const target = formatNumber(displayTarget, digits);
  return (
    <div className="rounded-xl border border-border/70 bg-background/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full ${item.met ? 'bg-emerald-500 text-white' : 'bg-secondary text-muted-foreground'}`}>
            {item.met ? <Check className="h-3 w-3" /> : <span className="text-[9px] font-bold">{Math.round(item.progress)}</span>}
          </div>
          <span className="text-sm font-medium">{item.label}</span>
        </div>
        <span className={`whitespace-nowrap text-xs font-semibold ${item.met ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground'}`}>
          {current}{displayUnit ? ` ${displayUnit}` : ''} {item.direction === 'max' ? '≤' : '≥'} {target}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${item.met ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${item.progress}%` }} />
      </div>
    </div>
  );
}
function MissionCard({ mission, index, onOpen }) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      onClick={() => onOpen({ type: 'mission', item: mission })}
      className="group w-full rounded-2xl border border-border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-10 w-10 flex-none items-center justify-center rounded-xl ${mission.completed ? 'bg-emerald-500 text-white' : 'bg-primary/10 text-primary'}`}>
            {mission.completed ? <BadgeCheck className="h-5 w-5" /> : <Target className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{mission.title}</h3>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[mission.status]}`}>
                {STATUS_LABELS[mission.status]}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{mission.description}</p>
          </div>
        </div>
        <ChevronRight className="mt-2 h-4 w-4 flex-none text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
      <div className="mt-4 flex items-center justify-between text-xs">
        <span className="font-semibold text-primary">{mission.difficulty} · {mission.reward} XP</span>
        <span className="text-muted-foreground">{Math.round(mission.progress)}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${mission.completed ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${mission.progress}%` }} />
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" />
        Next: {mission.nextAction}
      </div>
    </motion.button>
  );
}

function MasteryCard({ track, index, onOpen }) {
  const Icon = TRACK_ICONS[track.icon] || CircleGauge;
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.2) }}
      onClick={() => onOpen({ type: 'mastery', item: track })}
      className="group w-full rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{track.label}</h3>
              <div className="mt-1 flex items-center gap-2">
                {track.currentTier ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TIER_COLORS[track.currentTier.id]}`}>
                    {track.currentTier.label}
                  </span>
                ) : <span className="text-[11px] font-medium text-muted-foreground">Unranked</span>}
                <span className="text-xs text-muted-foreground">Form {track.score ?? '—'}</span>
              </div>
            </div>
            <div className={`flex items-center gap-1 text-[11px] font-semibold ${track.trend.direction === 'improving' ? 'text-emerald-600 dark:text-emerald-300' : track.trend.direction === 'declining' ? 'text-orange-600 dark:text-orange-300' : 'text-muted-foreground'}`}>
              {track.trend.direction === 'improving' ? <TrendingUp className="h-3.5 w-3.5" /> : track.trend.direction === 'declining' ? <TrendingDown className="h-3.5 w-3.5" /> : null}
              {track.trend.label}
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{track.description}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-1.5">
        {track.tiers.map((tier) => (
          <div key={tier.id} className={`h-2 flex-1 rounded-full ${tier.unlocked ? 'bg-primary' : tier === track.nextTier ? 'bg-primary/35' : 'bg-secondary'}`} title={`${tier.label}: ${tier.unlocked ? 'unlocked' : `${tier.progress}%`}`} />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>{track.nextTier ? `Next: ${track.nextTier.label}` : 'Mastery complete'}</span>
        <span>{track.nextTier ? `${track.nextTier.progress}%` : '100%'}</span>
      </div>
    </motion.button>
  );
}

function ProgressionDetail({ selection, units }) {
  if (!selection) return null;
  const isMission = selection.type === 'mission';
  const item = selection.item;
  const tier = isMission ? null : (item.nextTier || item.currentTier || item.tiers[0]);
  const requirements = isMission ? item.requirements : tier.requirements;
  const Icon = isMission ? Target : (TRACK_ICONS[item.icon] || CircleGauge);
  return (
    <>
      <DialogHeader className="pr-10 text-left">
        <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></div>
        <DialogTitle>{item.title || item.label}</DialogTitle>
        <DialogDescription>{item.description}</DialogDescription>
      </DialogHeader>
      {!isMission && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {item.tiers.map((trackTier) => (
              <span key={trackTier.id} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${trackTier.unlocked ? TIER_COLORS[trackTier.id] : 'border-border bg-secondary/50 text-muted-foreground'}`}>
                {trackTier.unlocked ? <Check className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />}{trackTier.label}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/70 bg-secondary/30 p-3 text-xs">
            <div><span className="text-muted-foreground">Evidence</span><div className="mt-1 font-semibold">{item.evidence.confidence}</div></div>
            <div><span className="text-muted-foreground">{item.id === 'focus' ? 'Usage Access measured' : 'Metric measured'}</span><div className="mt-1 font-semibold">{item.evidence.measuredTrips}/{item.evidence.totalTrips} trips</div></div>
            <div><span className="text-muted-foreground">Distance</span><div className="mt-1 font-semibold">{formatDistance(item.evidence.distanceKm, units)}</div></div>
            <div><span className="text-muted-foreground">Source</span><div className="mt-1 font-semibold">{item.evidence.source}</div></div>
          </div>
        </div>
      )}
      <div className="rounded-2xl bg-secondary/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-primary">{isMission ? `${item.difficulty} mission` : `${tier.label} requirements`}</div>
            <div className="mt-1 text-sm font-semibold">{isMission ? STATUS_LABELS[item.status] : tier.unlocked ? 'Tier unlocked' : `${tier.progress}% complete`}</div>
          </div>
          <div className="font-grotesk text-2xl font-bold">{isMission ? `${item.reward} XP` : `${tier.points} XP`}</div>
        </div>
      </div>
      <div className="space-y-2">
        {requirements.map((itemRequirement) => <RequirementRow key={itemRequirement.id} item={itemRequirement} units={units} />)}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Progress uses qualifying trips, normalized event rates, and available measurement coverage. Permanent mastery remains unlocked after it is earned; Current Form can still rise or fall.
      </p>
      {!isMission && item.id === 'focus' && <p className="text-xs leading-relaxed text-muted-foreground">“Measured” here means Android Usage Access verified phone-use evidence. It does not mean your GPS trips are missing.</p>}
    </>
  );
}

function FormTrendChart({ points }) {
  if (!points || points.length < 2) {
    return <div className="flex h-28 items-center justify-center rounded-xl bg-secondary/30 text-xs text-muted-foreground">Two qualifying trips are needed for a form chart.</div>;
  }
  const minScore = Math.max(0, Math.min(...points.map((point) => point.score)) - 5);
  const maxScore = Math.min(100, Math.max(...points.map((point) => point.score)) + 5);
  const range = Math.max(1, maxScore - minScore);
  const linePoints = points.map((point, index) => `${(index / Math.max(1, points.length - 1)) * 100},${36 - ((point.score - minScore) / range) * 30}`).join(' ');
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">30-trip form trace</h3><p className="mt-1 text-xs text-muted-foreground">Every point is an eligible trip score.</p></div><TrendingUp className="h-5 w-5 text-primary" /></div>
      <svg viewBox="0 0 100 40" className="h-32 w-full overflow-visible" role="img" aria-label="Recent eligible trip scores">
        {[10, 20, 30].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="currentColor" className="text-border" strokeWidth="0.35" />)}
        <polyline points={linePoints} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => <circle key={`${point.tripId}-${index}`} cx={(index / Math.max(1, points.length - 1)) * 100} cy={36 - ((point.score - minScore) / range) * 30} r="1.2" fill="hsl(var(--primary))"><title>{`${formatDate(point.date)}: ${point.score}`}</title></circle>)}
      </svg>
      <div className="flex justify-between text-[10px] font-medium text-muted-foreground"><span>{formatDate(points[0].date)}</span><span>{formatDate(points.at(-1).date)}</span></div>
    </div>
  );
}

function MissionPicker({ progression, selectedIds, onToggle, onSave }) {
  return (
    <>
      <DialogHeader className="pr-10 text-left"><DialogTitle>Choose this week&apos;s missions</DialogTitle><DialogDescription>Choose exactly three challenges. Saving locks the plan for the rest of the week so its targets and rewards stay fair.</DialogDescription></DialogHeader>
      <div className="rounded-xl bg-primary/5 px-3 py-2 text-xs font-semibold text-primary">{selectedIds.length}/3 selected</div>
      <div className="space-y-2">
        {progression.missionCandidates.map((mission) => {
          const selected = selectedIds.includes(mission.id);
          return <button key={mission.id} type="button" onClick={() => onToggle(mission.id)} className={`w-full rounded-xl border p-3 text-left transition ${selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
            <div className="flex items-start gap-3"><div className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded ${selected ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>{selected && <Check className="h-3.5 w-3.5" />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{mission.title}</span><span className="text-[10px] font-bold uppercase tracking-wide text-primary">{mission.difficulty} · {mission.reward} XP</span></div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{mission.description}</p></div></div>
          </button>;
        })}
      </div>
      <button type="button" disabled={selectedIds.length !== 3} onClick={onSave} className="min-h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">Lock selected missions</button>
    </>
  );
}

export default function Achievements() {
  const settings = useLocalSettings();
  const reduceMotion = useReducedMotion();
  const units = settings.units || 'metric';
  const [selection, setSelection] = useState(null);
  const [missionPickerOpen, setMissionPickerOpen] = useState(false);
  const [selectedMissionIds, setSelectedMissionIds] = useState([]);
  const [ledger, setLedger] = useState(() => loadDriverProgressionLedger());
  const {
    data: recentCompleted = [], isLoading, isFetching: recentFetching, isSuccess: recentTripsLoaded,
    isError: recentTripsError, refetch: refetchRecentTrips,
  } = useQuery({
    ...limitedTripSummaryQueryOptions(50),
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const {
    data: fullHistoryCompleted = [], isFetching: fullHistoryFetching,
    isError: fullHistoryError, refetch: refetchFullHistory,
  } = useQuery({
    ...tripSummaryQueryOptions(), enabled: recentTripsLoaded,
    select: (trips) => trips.filter((trip) => trip.status === 'completed'),
  });
  const completed = fullHistoryCompleted.length > 0 ? fullHistoryCompleted : recentCompleted;
  const isFetching = recentFetching || fullHistoryFetching;
  const { data: vehicles = [] } = useQuery({
    queryKey: ['achievement-vehicles'], queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const progression = useMemo(
    () => buildDriverProgression(completed, settings, { ledger }),
    [completed, settings, ledger]
  );
  const notificationBadges = useMemo(
    () => calculateAchievementBadges(completed, settings, vehicles),
    [completed, settings, vehicles]
  );

  useEffect(() => {
    const result = syncDriverProgressionLedger(progression, ledger);
    if (result.changed) setLedger(result.ledger);
    if (result.newUnlocks.length > 0) {
      syncAchievementNotifications(result.newUnlocks.map((unlock) => ({
        id: `progression_${unlock.id}`,
        label: unlock.title,
        description: `${unlock.detail}. +${unlock.xp} XP`,
        earned: true,
      })), { requestPermission: false }).catch(() => {});
    }
  }, [progression, ledger]);

  useEffect(() => {
    syncAchievementNotifications(notificationBadges, { requestPermission: false }).catch(() => {});
  }, [notificationBadges]);

  useEffect(() => {
    if (!progression.pendingCelebration || reduceMotion) return;
    confetti({ particleCount: 110, spread: 75, origin: { y: 0.65 }, colors: ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b'] });
  }, [progression.pendingCelebration, reduceMotion]);

  const openMissionPicker = () => {
    setSelectedMissionIds(progression.missionPlan.activeMissionIds);
    setMissionPickerOpen(true);
  };
  const toggleMission = (id) => {
    setSelectedMissionIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 3 ? [...current, id] : current);
  };
  const saveMissionSelection = () => {
    if (selectedMissionIds.length !== 3) return;
    setLedger(updateDriverProgressionMissionSelection(progression.missionPlan.weekKey, selectedMissionIds, ledger));
    setMissionPickerOpen(false);
  };
  const closeCelebration = () => {
    if (!progression.pendingCelebration) return;
    setLedger(acknowledgeDriverProgressionCelebration(progression.pendingCelebration.id, ledger));
  };

  const unlockedTiers = progression.masteryTracks.reduce((sum, track) => sum + track.tiers.filter((tier) => tier.unlocked).length, 0);
  const totalTiers = progression.masteryTracks.reduce((sum, track) => sum + track.tiers.length, 0);
  const recommendedMission = [...progression.missions]
    .filter((mission) => !mission.completed)
    .sort((a, b) => b.progress - a.progress)[0] || progression.missions[0] || null;
  const milestoneLoadFailed = recentTripsError && completed.length === 0;


  return (
    <MotionConfig reducedMotion="user">
    <div className="space-y-6 pb-6">
      <PageHeader
        title="Milestones"
        description="Driver progression through adaptive missions, permanent mastery, current form, and verified personal records"
        icon={Trophy}
        backTo="/"
        backLabel="Back to dashboard"
        status={(
          <div className="flex flex-wrap items-center gap-2">
            <InlineRefreshBadge visible={isFetching && !isLoading} label="Refreshing milestones" />
            <InlineLoadError
              visible={fullHistoryError && !recentTripsError}
              message="Full milestone history could not refresh."
              onRetry={refetchFullHistory}
            />
          </div>
        )}
      />

      {isLoading ? (
        <div className="space-y-4">
          <div className="h-56 animate-pulse rounded-3xl bg-secondary/60" />
          <div className="grid gap-3 md:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-secondary/60" />)}</div>
        </div>
      ) : milestoneLoadFailed ? (
        <section className="rounded-2xl border border-amber-300/70 bg-amber-50 p-6 dark:border-amber-900/60 dark:bg-amber-950/20">
          <h2 className="font-grotesk text-xl font-bold">Milestones could not be loaded</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Your trip history is still stored locally. Retry the read before starting another trip.</p>
          <button type="button" onClick={() => refetchRecentTrips()} className="mt-4 min-h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Retry loading milestones</button>
        </section>
      ) : completed.length === 0 ? (
        <PageEmptyState icon={CarFront} title="Your progression starts with a real trip" description="Complete a tracked trip to begin building a driving baseline. Advanced missions unlock only after Road Sage has enough trustworthy evidence." />
      ) : (
        <>
          <section className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/15 via-card to-card p-5 sm:p-6">
            <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
            <div className="relative grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-primary/30 bg-background/70 px-3 py-1 text-xs font-bold uppercase tracking-wider text-primary">
                    Level {progression.xp.level}
                  </span>
                  <span className="rounded-full bg-background/70 px-3 py-1 text-xs font-semibold text-muted-foreground">
                    {progression.eligibility.confidence} evidence
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
                  <div>
                    <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Current form</div>
                    <h2 className="mt-1 font-grotesk text-3xl font-bold sm:text-4xl">{progression.currentForm.rank.label}</h2>
                  </div>
                  <div className="pb-1 font-grotesk text-3xl font-bold text-primary">{progression.currentForm.score ?? '—'}</div>
                  <span className={`mb-1.5 inline-flex items-center gap-1 text-xs font-semibold ${progression.currentForm.trend.direction === 'improving' ? 'text-emerald-600 dark:text-emerald-300' : progression.currentForm.trend.direction === 'declining' ? 'text-orange-600 dark:text-orange-300' : 'text-muted-foreground'}`}>
                    {progression.currentForm.trend.direction === 'improving' ? <TrendingUp className="h-4 w-4" /> : progression.currentForm.trend.direction === 'declining' ? <TrendingDown className="h-4 w-4" /> : null}
                    {progression.currentForm.trend.label}
                  </span>
                </div>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  Form uses your latest 20 eligible trips and can move in either direction. Mastery tiers stay permanent once earned.
                </p>
                {recommendedMission && (
                  <button
                    type="button"
                    onClick={() => setSelection({ type: 'mission', item: recommendedMission })}
                    className="group mt-5 w-full rounded-2xl border border-primary/25 bg-background/80 p-4 text-left shadow-sm transition hover:border-primary/50 hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">Recommended next step</div>
                        <div className="mt-1 font-semibold">{recommendedMission.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{recommendedMission.nextAction}</p>
                      </div>
                      <ChevronRight className="mt-4 h-5 w-5 flex-none text-primary transition group-hover:translate-x-0.5" />
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${recommendedMission.progress}%` }} /></div>
                      <span className="text-xs font-semibold text-primary">{Math.round(recommendedMission.progress)}%</span>
                    </div>
                  </button>
                )}
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold">
                    <span>{progression.xp.current} / {progression.xp.target} XP to Level {progression.xp.level + 1}</span>
                    <span>{progression.xp.total.toLocaleString()} lifetime XP</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-background/80">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${progression.xp.progress}%` }} />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-border/70 bg-background/70 p-4 backdrop-blur">
                  <Medal className="mb-3 h-5 w-5 text-primary" />
                  <div className="font-grotesk text-2xl font-bold">{unlockedTiers}/{totalTiers}</div>
                  <div className="text-xs text-muted-foreground">mastery tiers</div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/70 p-4 backdrop-blur">
                  <Sparkles className="mb-3 h-5 w-5 text-primary" />
                  <div className="font-grotesk text-2xl font-bold">{progression.missions.filter((mission) => mission.completed).length}/3</div>
                  <div className="text-xs text-muted-foreground">active missions</div>
                </div>
                <div className="col-span-2 rounded-2xl border border-border/70 bg-background/70 p-4 backdrop-blur">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-grotesk text-xl font-bold">{progression.eligibility.eligibleTrips}/{progression.eligibility.completedTrips} qualifying trips</div>
                      <div className="mt-1 text-xs text-muted-foreground">{formatDistance(progression.eligibility.distanceKm, units)} evidence · {progression.eligibility.excludedTrips} excluded low-evidence trip{progression.eligibility.excludedTrips === 1 ? '' : 's'}</div>
                    </div>
                    <CircleGauge className="h-7 w-7 text-primary" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {progression.eligibility.excludedTrips > 0 && (
            <section className={`rounded-2xl border p-4 sm:p-5 ${progression.eligibility.eligibleTrips === 0 ? 'border-orange-500/40 bg-orange-500/10' : 'border-border bg-card'}`}>
              <div className="flex items-start gap-3">
                <CircleGauge className={`mt-0.5 h-5 w-5 flex-none ${progression.eligibility.eligibleTrips === 0 ? 'text-orange-600 dark:text-orange-300' : 'text-primary'}`} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold">{progression.eligibility.eligibleTrips === 0 ? 'Why your existing trips are not qualifying' : 'Trips excluded from progression'}</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">A trip is counted when it is completed, at least {formatDistance(progression.eligibility.minimumTripKm, units)}, at least {Math.ceil(progression.eligibility.minimumTripSeconds / 60)} minutes, and has a usable overall score.</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {progression.eligibility.exclusionReasons.filter((reason) => reason.count > 0).map((reason) => <div key={reason.id} className="rounded-xl bg-background/70 p-3"><div className="text-sm font-semibold">{reason.count} · {reason.label}</div><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{reason.detail}</p></div>)}
                  </div>
                </div>
              </div>
            </section>
          )}

          {progression.eligibility.privacyLimitedTrips > 0 && (
            <section className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-primary" /><div><h2 className="text-sm font-semibold">Privacy-safe progression is active</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{progression.eligibility.privacyLimitedTrips} privacy-zone trip{progression.eligibility.privacyLimitedTrips === 1 ? '' : 's'} contribute aggregate scores, distance, events, mastery, and XP. Their route identity and location-context evidence remain excluded from route-specific missions.</p></div></div>
            </section>
          )}

          <Tabs defaultValue="overview" className="space-y-5">
            <TabsList className="grid h-auto w-full grid-cols-4 rounded-2xl bg-secondary/70 p-1">
              <TabsTrigger value="overview" className="rounded-xl py-2 text-xs sm:text-sm">Missions</TabsTrigger>
              <TabsTrigger value="mastery" className="rounded-xl py-2 text-xs sm:text-sm">Mastery</TabsTrigger>
              <TabsTrigger value="records" className="rounded-xl py-2 text-xs sm:text-sm">Records</TabsTrigger>
              <TabsTrigger value="history" className="rounded-xl py-2 text-xs sm:text-sm">History</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-0 space-y-6">
              <details className="group rounded-2xl border border-primary/20 bg-primary/5">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 marker:content-none sm:p-5">
                  <div className="flex items-start gap-3"><Zap className="mt-0.5 h-5 w-5 flex-none text-primary" /><div><h2 className="font-grotesk text-lg font-bold">How XP is earned</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">XP is awarded once when every evidence requirement for an unlock is met.</p></div></div>
                  <ChevronRight className="mt-1 h-5 w-5 flex-none text-primary transition group-open:rotate-90" />
                </summary>
                <div className="border-t border-primary/15 p-4 sm:p-5">
                  <div className="grid gap-3 md:grid-cols-3">
                    {progression.xp.sources.map((source) => <div key={source.id} className="rounded-xl border border-border/70 bg-background/75 p-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{source.label}</span><span className="text-[10px] font-bold uppercase tracking-wide text-primary">{source.rewards}</span></div><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{source.detail}</p></div>)}
                  </div>
                  <p className="mt-3 text-[11px] font-medium text-muted-foreground">Trips do not award XP just for existing. Tap any progression card to see its exact live values, targets, and remaining requirement.</p>
                </div>
              </details>
              <section>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div><h2 className="font-grotesk text-xl font-bold">Adaptive missions</h2><p className="mt-1 text-xs text-muted-foreground">Targets recalibrate from your previous 28-day baseline.</p></div>
                  <button type="button" onClick={openMissionPicker} disabled={progression.missionPlan.selectionLocked} className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-primary transition hover:border-primary/40 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60"><SlidersHorizontal className="h-3.5 w-3.5" />{progression.missionPlan.selectionLocked ? 'Plan locked' : 'Choose missions'}</button>
                </div>
                <div className="grid gap-3 lg:grid-cols-3">{progression.missions.map((mission, index) => <MissionCard key={mission.id} mission={mission} index={index} onOpen={setSelection} />)}</div>
              </section>
              <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-bold uppercase tracking-[0.16em] text-primary">{progression.season.label} season</div><h2 className="mt-1 font-grotesk text-xl font-bold">Seasonal campaign</h2><p className="mt-1 text-xs text-muted-foreground">Monthly challenges reset; permanent mastery never does.</p></div><div className="rounded-xl bg-primary/10 px-3 py-2 text-center"><div className="font-grotesk text-xl font-bold text-primary">{progression.season.completedCount}/3</div><div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">complete</div></div></div>
                <div className="mt-4 grid gap-3 lg:grid-cols-3">{progression.season.challenges.map((challenge) => <button key={challenge.id} type="button" onClick={() => setSelection({ type: 'mission', item: challenge })} className="rounded-xl bg-secondary/40 p-3 text-left transition hover:bg-secondary/70"><div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{challenge.title}</span>{challenge.completed ? <BadgeCheck className="h-4 w-4 text-emerald-500" /> : <span className="text-xs font-bold text-primary">{challenge.progress}%</span>}</div><p className="mt-1 text-xs text-muted-foreground">{challenge.description}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background"><div className={`h-full rounded-full ${challenge.completed ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${challenge.progress}%` }} /></div></button>)}</div>
              </section>
              <FormTrendChart points={progression.formSeries} />
              <section>
                <div className="mb-3"><h2 className="font-grotesk text-xl font-bold">Skill form</h2><p className="mt-1 text-xs text-muted-foreground">Recent skill ratings reveal strengths and weaknesses before they become permanent habits.</p></div>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
                    {progression.masteryTracks.map((track) => {
                      const Icon = TRACK_ICONS[track.icon] || CircleGauge;
                      return <button key={track.id} type="button" onClick={() => setSelection({ type: 'mastery', item: track })} className="group text-left">
                        <div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 text-primary" />{track.label}</span><span className="font-grotesk text-base font-bold">{track.score ?? '—'}</span></div>
                        <div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all group-hover:bg-primary/80" style={{ width: `${track.score || 0}%` }} /></div>
                      </button>;
                    })}
                  </div>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="mastery" className="mt-0">
              <div className="mb-3"><h2 className="font-grotesk text-xl font-bold">Permanent mastery</h2><p className="mt-1 text-xs text-muted-foreground">Each tier combines trip count, measured distance, quality, normalized event rate, and severe-event control.</p></div>
              <div className="grid gap-3 md:grid-cols-2">{progression.masteryTracks.map((track, index) => <MasteryCard key={track.id} track={track} index={index} onOpen={setSelection} />)}</div>
            </TabsContent>

            <TabsContent value="records" className="mt-0">
              <div className="mb-3"><h2 className="font-grotesk text-xl font-bold">Personal records</h2><p className="mt-1 text-xs text-muted-foreground">Quality records compare you with your own strongest verified driving—not a misleading global leaderboard.</p></div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {progression.records.map((record, index) => (
                  <motion.div key={record.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className="rounded-2xl border border-border bg-card p-4">
                    <Award className="mb-4 h-5 w-5 text-primary" /><div className="font-grotesk text-2xl font-bold">{record.value}</div><h3 className="mt-1 text-sm font-semibold">{record.label}</h3><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{record.detail}</p>{record.date && <div className="mt-3 text-[11px] font-medium text-muted-foreground">{formatDate(record.date)}</div>}
                  </motion.div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="history" className="mt-0">
              <div className="mb-3"><h2 className="font-grotesk text-xl font-bold">XP transaction ledger</h2><p className="mt-1 text-xs text-muted-foreground">Every mastery, mission, and seasonal XP award is recorded once with its source and timestamp.</p></div>
              {progression.history.length ? <div className="rounded-2xl border border-border bg-card p-4">
                <div className="space-y-1">{progression.history.map((entry, index) => <div key={entry.id} className="relative flex gap-3 pb-5 last:pb-0"><div className="relative z-10 mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">{entry.type === 'mission' ? <Target className="h-4 w-4" /> : <Trophy className="h-4 w-4" />}</div>{index < progression.history.length - 1 && <div className="absolute bottom-0 left-[15px] top-8 w-px bg-border" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="text-sm font-semibold">{entry.title}</div><div className="mt-1 text-xs text-muted-foreground">{entry.detail}</div></div><span className="text-[11px] font-medium text-muted-foreground">{formatDate(entry.earnedAt)}</span></div></div></div>)}</div>
              </div> : <div className="rounded-2xl border border-dashed border-border p-8 text-center"><History className="mx-auto h-8 w-8 text-muted-foreground" /><p className="mt-3 text-sm font-semibold">Your first advanced unlock is ahead</p><p className="mt-1 text-xs text-muted-foreground">Meet every evidence requirement in a mastery tier or adaptive mission.</p></div>}
            </TabsContent>
          </Tabs>
        </>
      )}

      <Dialog open={Boolean(selection)} onOpenChange={(open) => !open && setSelection(null)}>
        <DialogContent className="max-w-xl"><ProgressionDetail selection={selection} units={units} /></DialogContent>
      </Dialog>
      <Dialog open={missionPickerOpen} onOpenChange={setMissionPickerOpen}>
        <DialogContent className="max-w-2xl"><MissionPicker progression={progression} selectedIds={selectedMissionIds} onToggle={toggleMission} onSave={saveMissionSelection} /></DialogContent>
      </Dialog>
      <Dialog open={Boolean(progression.pendingCelebration)} onOpenChange={(open) => !open && closeCelebration()}>
        <DialogContent className="max-w-md overflow-hidden text-center">
          {progression.pendingCelebration && <><div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-white shadow-xl"><Trophy className="h-10 w-10" /></div><DialogHeader className="text-center"><div className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Progression unlocked</div><DialogTitle className="font-grotesk text-2xl">{progression.pendingCelebration.title}</DialogTitle><DialogDescription>{progression.pendingCelebration.detail}</DialogDescription></DialogHeader><div className="font-grotesk text-3xl font-bold text-primary">+{progression.pendingCelebration.xp} XP</div><button type="button" onClick={closeCelebration} className="min-h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Continue progression</button></>}
        </DialogContent>
      </Dialog>
    </div>
    </MotionConfig>
  );
}
