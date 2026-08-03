// @ts-check
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  Camera,
  Gauge,
  Map,
  Plus,
  Route,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';

const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

export function buildRoadSpeedCommandState({
  cameraCount = 0,
  estimatedCount = 0,
  learningCount = 0,
  mapStatus = 'idle',
  postedCount = 0,
  reviewCount = 0,
  savedCount = 0,
} = {}) {
  const camera = count(cameraCount);
  const reviews = count(reviewCount);
  const saved = count(savedCount);
  const posted = count(postedCount);
  const estimates = count(estimatedCount);
  const learning = count(learningCount);

  if (camera > 0) {
    return {
      tone: 'violet',
      eyebrow: 'Action ready',
      title: `${camera} captured sign${camera === 1 ? '' : 's'} waiting for you`,
      detail: 'Confirm or reject the picture while parked. Nothing changes until you decide.',
      action: 'review',
      actionLabel: 'Review captured signs',
    };
  }
  if (reviews > 0) {
    return {
      tone: 'amber',
      eyebrow: 'Road evidence needs a decision',
      title: `${reviews} road section${reviews === 1 ? '' : 's'} need review`,
      detail: 'Resolve the highest-impact conflicts and estimates first.',
      action: 'review',
      actionLabel: 'Review next road',
    };
  }
  if (learning > 0 && saved === 0) {
    return {
      tone: 'sky',
      eyebrow: 'Learning automatically',
      title: `${learning} road corridor${learning === 1 ? '' : 's'} being learned`,
      detail: 'No action is required. A corridor becomes active after at least 3 consistent drives; until then it cannot change scores or alerts.',
      action: 'review',
      actionLabel: 'See learning progress',
    };
  }
  if (saved === 0) {
    return {
      tone: 'sky',
      eyebrow: 'Automatic local learning',
      title: 'Road Memory is ready to learn',
      detail: 'Drive normally. Repeated GPS evidence builds local estimates automatically; add a posted speed only when you know one.',
      action: 'map',
      actionLabel: 'View road memory',
    };
  }
  return {
    tone: 'emerald',
    eyebrow: 'Local road memory active',
    title: `${saved} saved road speed${saved === 1 ? '' : 's'} working for you`,
    detail: mapStatus === 'loading'
      ? 'Saved rules are active now. New trip evidence is being checked in the background.'
      : `${posted} posted and ${estimates} estimated rule${posted + estimates === 1 ? '' : 's'} feed trip scoring and alerts.`,
    action: 'saved',
    actionLabel: 'Manage saved roads',
  };
}

export default function RoadSpeedCommandCenter({
  cameraCount = 0,
  estimatedCount = 0,
  learningCount = 0,
  mapStatus = 'idle',
  onAdd,
  onOpenMap,
  onOpenReview,
  onOpenSaved,
  postedCount = 0,
  reviewCount = 0,
  savedCount = 0,
}) {
  const state = buildRoadSpeedCommandState({
    cameraCount,
    estimatedCount,
    learningCount,
    mapStatus,
    postedCount,
    reviewCount,
    savedCount,
  });
  const primaryAction = state.action === 'review'
    ? onOpenReview
    : state.action === 'add'
      ? onAdd
      : state.action === 'map'
        ? onOpenMap
        : onOpenSaved;

  return (
    <section
      className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm"
      data-testid="road-speed-command-center"
      data-tone={state.tone}
    >
      <div className="grid gap-0 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 p-5 text-white sm:p-6">
          <div className="absolute -right-12 -top-16 h-48 w-48 rounded-full bg-cyan-400/15 blur-3xl" />
          <div className="absolute -bottom-20 left-1/3 h-44 w-44 rounded-full bg-violet-500/15 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-200">
              <Sparkles className="h-4 w-4" />
              {state.eyebrow}
            </div>
            <h2 className="mt-2 max-w-2xl font-grotesk text-2xl font-bold tracking-tight sm:text-3xl">
              {state.title}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
              {state.detail}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={primaryAction}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition-opacity hover:opacity-90"
              >
                {state.action === 'review'
                  ? <AlertTriangle className="h-4 w-4" />
                  : state.action === 'add'
                    ? <Plus className="h-4 w-4" />
                    : state.action === 'map'
                      ? <Map className="h-4 w-4" />
                      : <ShieldCheck className="h-4 w-4" />}
                {state.actionLabel}
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={state.action === 'map' ? onAdd : onOpenMap}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/15"
              >
                {state.action === 'map' ? <Plus className="h-4 w-4" /> : <Map className="h-4 w-4" />}
                {state.action === 'map' ? 'Add a posted speed' : 'Open road map'}
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px bg-border">
          {[
            { label: 'Trusted rules', value: savedCount, Icon: ShieldCheck, tone: 'text-emerald-600' },
            { label: 'Learning roads', value: learningCount, Icon: Route, tone: 'text-cyan-600' },
            { label: 'Needs review', value: count(cameraCount) + count(reviewCount), Icon: AlertTriangle, tone: 'text-amber-600' },
            { label: 'Posted signs', value: postedCount, Icon: Camera, tone: 'text-violet-600' },
            { label: 'Local estimates', value: estimatedCount, Icon: Route, tone: 'text-sky-600' },
          ].map(({ label, value, Icon, tone }) => (
            <div key={label} className="bg-card p-4">
              <Icon className={`h-4 w-4 ${tone}`} />
              <div className="mt-2 font-grotesk text-2xl font-bold">{count(value)}</div>
              <div className="text-xs font-medium text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border px-4 py-4 sm:px-6">
        <div className="grid gap-2 sm:grid-cols-4">
          {[
            { number: '1', label: 'Capture', detail: 'Trip or camera evidence', Icon: Camera },
            { number: '2', label: 'Verify', detail: 'You or confidence gates', Icon: ShieldCheck },
            { number: '3', label: 'Apply', detail: 'Trusted rules update', Icon: Gauge },
            { number: '4', label: 'Reuse', detail: 'Future drives remember', Icon: BellRing },
          ].map(({ number, label, detail, Icon }) => (
            <div key={number} className="flex items-center gap-3 rounded-xl bg-secondary/45 px-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-xs font-bold shadow-sm">
                {number}
              </span>
              <Icon className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="text-xs font-bold">{label}</div>
                <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-medium text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" /> Trip scores</span>
          <span className="inline-flex items-center gap-1.5"><Volume2 className="h-3.5 w-3.5" /> Voice warnings</span>
          <span className="inline-flex items-center gap-1.5"><BellRing className="h-3.5 w-3.5" /> Live alerts</span>
          <span className="inline-flex items-center gap-1.5"><Route className="h-3.5 w-3.5" /> Speed analysis</span>
          <span className="text-foreground">Pending evidence changes nothing. Confirmed signs and trusted Road Memory rules update these features.</span>
        </div>
      </div>
    </section>
  );
}
