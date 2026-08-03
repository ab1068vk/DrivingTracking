import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react';
import { getRescoringQueueStatus } from '@/lib/rescoringQueue';
import { readSpeedKnowledgeData } from '@/lib/speedKnowledgeRepository';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';

const EMPTY_QUEUE = {
  activeJobs: 0,
  pendingTrips: 0,
  completedTrips: 0,
  totalTrips: 0,
  failedTrips: 0,
  latest: null,
};

const EMPTY = {
  queue: EMPTY_QUEUE,
  knowledge: null,
};

const finiteRevision = (...values) => {
  for (const value of values) {
    if (value == null || value === '') continue;
    const revision = Number(value);
    if (Number.isFinite(revision) && revision >= 0) return Math.floor(revision);
  }
  return null;
};

export function buildSpeedRescoreView(queue = EMPTY_QUEUE, knowledge = null) {
  const latest = queue?.latest || null;
  const active = Number(queue?.activeJobs) > 0;
  const knowledgeRevision = finiteRevision(
    knowledge?.knowledgeRevision,
    knowledge?.revision,
    knowledge?.metadata?.knowledgeRevision,
  );
  const historicalRevision = finiteRevision(
    latest?.knowledgeRevision,
    latest?.targetKnowledgeRevision,
    latest?.targetRevision,
  );
  const latestFailed = Math.max(
    0,
    Number(latest?.failed) || (Array.isArray(latest?.failedTripIds) ? latest.failedTripIds.length : 0),
  );
  const completedAt = Number(latest?.completedAt) || 0;
  const waitingForRevision = !active && knowledgeRevision != null && historicalRevision != null &&
    historicalRevision < knowledgeRevision;
  const revisionCurrent = !active && completedAt > 0 && knowledgeRevision != null &&
    historicalRevision != null && historicalRevision >= knowledgeRevision && latestFailed === 0;
  const tone = latestFailed || waitingForRevision
    ? 'warning'
    : active
      ? 'running'
      : revisionCurrent || completedAt
        ? 'current'
        : 'idle';

  let title = 'No historical score update is pending';
  if (active) {
    title = `Updating historical scores - ${Number(queue?.completedTrips) || 0} of ${Number(queue?.totalTrips) || 0}`;
  } else if (latestFailed) {
    title = `Historical score update has ${latestFailed} unresolved trip${latestFailed === 1 ? '' : 's'}`;
  } else if (waitingForRevision) {
    title = `Historical scores are waiting for road-speed revision ${knowledgeRevision}`;
  } else if (revisionCurrent) {
    title = `Historical scores match road-speed revision ${knowledgeRevision}`;
  } else if (completedAt) {
    title = 'Historical score update completed';
  }

  const updatedAt = knowledge?.knowledgeUpdatedAt ?? knowledge?.updatedAt ??
    knowledge?.metadata?.knowledgeUpdatedAt ?? null;
  const revisionDetail = knowledgeRevision == null
    ? 'This saved-speed data predates revision tracking; the next change will establish a revision.'
    : historicalRevision == null
      ? `Saved road-speed revision ${knowledgeRevision} is active. Historical revision proof is not available for this older queue entry.`
      : active
        ? `Saved road-speed revision ${knowledgeRevision}; the current history job targets revision ${historicalRevision}.`
        : waitingForRevision
          ? `Live resolution already uses revision ${knowledgeRevision}; completed trips still show revision ${historicalRevision} until the queued refresh finishes.`
          : `Saved road-speed revision ${knowledgeRevision}; historical scores were processed with revision ${historicalRevision}.`;

  return {
    active,
    completedAt,
    historicalRevision,
    knowledgeRevision,
    latestFailed,
    revisionCurrent,
    revisionDetail,
    title,
    tone,
    updatedAt,
    waitingForRevision,
  };
}

export default function SpeedRescoreStatus({ compact = false }) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const load = useCallback(async () => {
    const [queue, knowledge] = await Promise.all([
      getRescoringQueueStatus({
        reasonPrefix: 'speed_knowledge',
        knowledgeRevisionOnly: true,
      }).catch(() => EMPTY_QUEUE),
      readSpeedKnowledgeData().catch(() => null),
    ]);
    setSnapshot({ queue, knowledge });
  }, []);

  useEffect(() => {
    void load();
    const onProgress = () => void load();
    window.addEventListener(RESCORE_PROGRESS_EVENT, onProgress);
    window.addEventListener('speed-knowledge-changed', onProgress);
    window.addEventListener('focus', onProgress);
    return () => {
      window.removeEventListener(RESCORE_PROGRESS_EVENT, onProgress);
      window.removeEventListener('speed-knowledge-changed', onProgress);
      window.removeEventListener('focus', onProgress);
    };
  }, [load]);

  const view = buildSpeedRescoreView(snapshot.queue, snapshot.knowledge);
  if (!view.active && !view.latestFailed && !view.completedAt && view.knowledgeRevision == null && compact) return null;

  const toneClass = view.tone === 'warning'
    ? 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20'
    : view.tone === 'running'
      ? 'border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/20'
      : view.tone === 'idle'
        ? 'border-border bg-card'
        : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20';

  return (
    <section
      className={`rounded-xl border px-3 py-2.5 ${toneClass}`}
      aria-live="polite"
      data-testid="speed-rescore-status"
      data-freshness={view.tone}
    >
      <div className="flex items-start gap-2">
        {view.active ? (
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-700 dark:text-sky-300" />
        ) : view.tone === 'warning' ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">{view.title}</div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-semibold text-muted-foreground">
            {view.knowledgeRevision != null && (
              <span className="rounded-full bg-background/80 px-2 py-0.5">Live revision {view.knowledgeRevision}</span>
            )}
            {view.historicalRevision != null && (
              <span className="rounded-full bg-background/80 px-2 py-0.5">History revision {view.historicalRevision}</span>
            )}
            {view.updatedAt && (
              <span className="rounded-full bg-background/80 px-2 py-0.5">
                Knowledge saved {new Date(view.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
          {!compact && (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {view.revisionDetail}
              {' '}Speed changes are saved first, then affected completed trips are recalculated in a persistent queue that resumes after the app reopens.
              {view.completedAt ? ` Last queue completion ${new Date(view.completedAt).toLocaleString()}.` : ''}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
