// @ts-check
// The "Needs review" workspace of src/pages/SpeedLimits.jsx.
//
// Kept under src/components/speedLimits/ on purpose: the SpeedLimit* basename
// keeps numericDisplayConsistency's configuration-surface exemption applying,
// and the directory is what src/lib/__tests__/helpers/pageSourceBundle.js
// bundles with the page so the banned-wording and privacy scans keep reading
// this text instead of silently passing on nothing.
import { AlertTriangle, Gauge, HeartPulse, Search, ShieldCheck, Trash2 } from 'lucide-react';
import RoadMemoryChangeReview from '@/components/RoadMemoryChangeReview';
import SpeedSignEvidenceReview from '@/components/SpeedSignEvidenceReview';
import { formatSpeedLimit } from '@/components/speedLimits/speedRuleFormatting';
import { MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE } from '@/lib/scoring/learnedSourceReliability';

/**
 * Workspace block props-threaded out of the page body. Owns no state and
 * runs no hooks, so every value it renders arrives as a prop.
 */
export default function SpeedLimitReviewWorkspace({
  attentionItems,
  cleanExpiredSpeedKnowledge,
  firstConflictSection,
  focusAttentionItem,
  health,
  knowledgeQuery,
  learningInventoryRef,
  learningInventoryVirtualizer,
  learningMemoryCandidates,
  loadMapModel,
  mapModelLoaded,
  mapModelState,
  refreshRowsAndMap,
  reviewInventory,
  reviewInventoryRef,
  reviewInventoryVirtualizer,
  reviewWorkspaceRef,
  roadMemoryCandidates,
  rows,
  setCameraReviewCount,
  setKnowledgeQuery,
  setShowAllAttention,
  showAllAttention,
  units,
  visibleAttentionItems,
}) {
  // Plain derivation, not a hook: this workspace owns no state by design.
  // Sources with too little evidence are hidden rather than shown as a rate,
  // since one or two observations is not an accuracy figure.
  const sourceReliabilityRows = Object.entries(health?.sourceReliability || {})
    .map(([source, stats]) => ({ source, ...stats }))
    .filter((row) => Number(row.observations) >= MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE)
    .sort((a, b) => b.observations - a.observations)
    .slice(0, 6);

  return (
        <div ref={reviewWorkspaceRef} className="scroll-mt-24 space-y-4">
          <SpeedSignEvidenceReview
            showAll
            showEmpty
            onCountChange={setCameraReviewCount}
          />
          <RoadMemoryChangeReview
            candidates={roadMemoryCandidates}
            onChanged={() => refreshRowsAndMap({ silent: true, forceMap: true })}
            onFocus={(candidate) => focusAttentionItem({
              kind: 'memoryReview',
              section: {
                ...candidate,
                roadMemoryCandidate: true,
                source: 'local_road_memory',
                effectiveLimitKmh: Number(candidate.limitKmh) || null,
              },
            })}
          />
      {!mapModelLoaded && (
        <section className={`rounded-xl border px-3 py-2 text-sm font-medium ${
          mapModelState.status === 'error'
            ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'
            : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200'
        }`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {mapModelState.status === 'error'
                ? 'Map evidence could not load. Saved rules are still available.'
                : 'Loading trip evidence for conflicts and observed-only sections...'}
            </span>
            {mapModelState.status === 'error' && (
              <button
                type="button"
                onClick={() => loadMapModel({ force: true })}
                className="inline-flex items-center justify-center rounded-lg border border-current/30 px-2.5 py-1 text-xs font-semibold hover:bg-background/50"
              >
                Retry
              </button>
            )}
          </div>
        </section>
      )}
      <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 shadow-sm dark:border-sky-900/60 dark:bg-sky-950/20">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-sky-600" />
              <h2 className="font-grotesk text-lg font-bold">Learning automatically</h2>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                {learningMemoryCandidates.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              These corridors came from your own GPS trips. Driving behavior can suggest where a limit may be, but it cannot prove a posted law. Strong suggestions are tested in shadow mode against parked decisions before they can affect scores, voice checks, or live alerts.
            </p>
          </div>
          <span className="rounded-full bg-background/80 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
            No action required
          </span>
        </div>
        {learningMemoryCandidates.length === 0 ? (
          <div className="mt-3 rounded-xl border border-sky-200/80 bg-background/70 px-3 py-3 text-sm text-muted-foreground dark:border-sky-900/50">
            No corridors are currently in the learning stage. Complete a normal public-road trip and Road Memory will check it automatically.
          </div>
        ) : (
          <div
            ref={learningInventoryRef}
            className="mt-3 overflow-y-auto rounded-xl border border-sky-200 bg-background/80 thin-scrollbar dark:border-sky-900/60"
            style={{ height: `${Math.min(learningMemoryCandidates.length, 6) * 76}px` }}
            aria-label="Road Memory learning progress"
          >
            <div
              className="relative w-full"
              style={{ height: `${learningInventoryVirtualizer.getTotalSize()}px` }}
            >
              {learningInventoryVirtualizer.getVirtualItems().map((virtualItem) => {
                const candidate = learningMemoryCandidates[virtualItem.index];
                if (!candidate) return null;
                const tripCount = Math.max(0, Number(candidate.tripCount) || 0);
                const confidence = Math.max(0, Math.min(1, Number(candidate.confidence) || 0));
                const progress = Math.max(8, Math.min(100, tripCount / 3 * 100));
                const section = {
                  ...candidate,
                  saved: false,
                  roadMemoryCandidate: true,
                  source: 'local_road_memory',
                  observedLimitKmh: Number(candidate.limitKmh) || null,
                  effectiveLimitKmh: Number(candidate.limitKmh) || null,
                };
                return (
                  <button
                    key={candidate.id || candidate.sectionKey || virtualItem.index}
                    type="button"
                    onClick={() => focusAttentionItem({ kind: 'learning', section })}
                    className="absolute left-0 top-0 w-full border-b border-sky-100 px-3 py-2 text-left hover:bg-sky-100/60 dark:border-sky-900/40 dark:hover:bg-sky-950/40"
                    style={{
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {candidate.roadName || `Local corridor ${String(candidate.geohash || '').slice(0, 6)}`}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          Exploring {formatSpeedLimit(candidate.limitKmh, units)} · {tripCount} drive{tripCount === 1 ? '' : 's'} · {Math.round(confidence * 100)}% calibrated confidence
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
                        {candidate.usageStage === 'shadow' ? 'Shadow check' : candidate.stage === 'suggested' ? 'Almost ready' : 'Learning'}
                      </span>
                    </span>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-sky-100 dark:bg-sky-950/70">
                      <span className="block h-full rounded-full bg-sky-500" style={{ width: `${progress}%` }} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">All road knowledge</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {reviewInventory.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              One inventory for saved posted limits, estimates, active Road Memory, learning corridors, possible changes, and stale evidence. Each status says whether it can currently affect scores and alerts.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
            <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {rows.length} manual
            </span>
            <span className="rounded-full bg-sky-100 px-2 py-1 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
              {roadMemoryCandidates.length} Road Memory
            </span>
          </div>
        </div>
        <label className="relative mt-3 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            placeholder="Search every saved, active, or learning road..."
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-xs outline-none focus:border-primary"
          />
        </label>
        {reviewInventory.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
            {knowledgeQuery ? 'No road knowledge matches this search.' : 'No road knowledge exists yet.'}
          </div>
        ) : (
          <div
            ref={reviewInventoryRef}
            className="mt-3 overflow-y-auto rounded-xl border border-border bg-background/60 thin-scrollbar"
            style={{ height: `${Math.min(reviewInventory.length, 7) * 68}px` }}
            aria-label="Complete local road knowledge inventory"
          >
            <div
              className="relative w-full"
              style={{ height: `${reviewInventoryVirtualizer.getTotalSize()}px` }}
            >
              {reviewInventoryVirtualizer.getVirtualItems().map((virtualItem) => {
                const item = reviewInventory[virtualItem.index];
                if (!item) return null;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => focusAttentionItem({ kind: item.focusKind, section: item.section })}
                    className="absolute left-0 top-0 flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left hover:bg-secondary/60"
                    style={{
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                      item.tone === 'violet'
                        ? 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200'
                        : item.tone === 'amber'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
                          : item.tone === 'slate'
                            ? 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
                            : item.tone === 'cyan'
                              ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200'
                              : item.tone === 'sky'
                                ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                                : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                    }`}>
                      {item.badge}
                    </span>
                    <span className="text-[10px] font-semibold text-muted-foreground">
                      Score + alerts {item.intelligence.canAffectScore ? 'active' : 'blocked'}
                    </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
                <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              <h2 className="font-grotesk text-lg font-bold">Needs attention</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {attentionItems.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Only real conflicts, stale trusted evidence, confirmed trip zones, and saved rules with quality problems appear here. Ordinary learning roads do not require your input.
            </p>
          </div>
          {firstConflictSection && (
            <button
              type="button"
              onClick={() => focusAttentionItem({ kind: 'conflict', section: firstConflictSection })}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Review first conflict
            </button>
          )}
        </div>
        {attentionItems.length === 0 ? (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
            No road-speed decisions need your attention right now. Automatic learning can continue by itself.
          </div>
        ) : (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {visibleAttentionItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => focusAttentionItem(item)}
                className={`rounded-xl border p-3 text-left text-sm transition-colors hover:bg-secondary/70 ${
                  item.kind === 'conflict'
                    ? 'border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20'
                    : 'border-border bg-secondary/30'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{item.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{item.detail}</div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    item.kind === 'conflict'
                      ? 'bg-red-600 text-white'
                      : item.kind === 'voice'
                        ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
                      : item.kind === 'observed'
                        ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200'
                        : item.kind === 'memoryReview'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                        : item.kind === 'speedZone'
                          ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100'
                        : item.kind === 'review'
                          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-100'
                        : 'bg-secondary text-muted-foreground'
                  }`}>
                    {item.kind === 'conflict' ? 'Resolve' : item.kind === 'voice' ? 'Voice' : item.kind === 'speedZone' ? 'Zone' : item.kind === 'memoryReview' ? 'Review' : item.kind === 'review' ? 'Review' : 'Set'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
        {attentionItems.length > 24 && (
          <button
            type="button"
            onClick={() => setShowAllAttention((value) => !value)}
            className="mt-3 inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary"
          >
            {showAllAttention
              ? 'Show highest-priority items only'
              : `Show all ${attentionItems.length} attention items`}
          </button>
        )}
      </section>

      <section className={`rounded-xl border p-3 ${
        health?.healthy
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30'
          : 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
      }`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <HeartPulse className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">Local data health</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {health?.healthy
                  ? 'No conflicts, expired rules, stale evidence, invalid geometry, or road-level disagreements were found.'
                  : `${health?.issueCount || 0} issue${health?.issueCount === 1 ? '' : 's'} found: ${health?.counts?.high || 0} high, ${health?.counts?.medium || 0} medium, ${health?.counts?.low || 0} low.`}
              </p>
              {!health?.healthy && health?.issues?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                  {Object.entries(health.counts || {})
                    .filter(([key, count]) => !['high', 'medium', 'low'].includes(key) && count > 0)
                    .map(([key, count]) => (
                      <span key={key} className="rounded-full bg-background/80 px-2 py-1">
                        {String(key).replace(/_/g, ' ')} {count}
                      </span>
                    ))}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={cleanExpiredSpeedKnowledge}
            disabled={!health || (!health.counts?.expired_rule && !health.counts?.stale_cell)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clean expired
          </button>
        </div>
      </section>

      {sourceReliabilityRows.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">How often each source has been right</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Measured from your own saved road knowledge: how often a limit proposed by
                each source matched the limit the area settled on. Scoring still uses the
                fixed reference confidences, so these figures report accuracy rather than
                change your scores.
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {sourceReliabilityRows.map((row) => (
                  <li key={row.source} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-foreground">
                      {String(row.source).replace(/_/g, ' ')}
                    </span>
                    <span className="text-muted-foreground">
                      {Math.round(row.hitRate * 100)}% agreed over {row.observations}{' '}
                      observation{row.observations === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
        </div>
  );
}
