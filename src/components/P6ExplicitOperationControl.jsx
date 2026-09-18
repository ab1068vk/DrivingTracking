import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { P6_EXPLICIT_OPERATION_STATES } from '@/lib/p6Contracts';

const TERMINAL = new Set([
  P6_EXPLICIT_OPERATION_STATES.CANCELLED,
  P6_EXPLICIT_OPERATION_STATES.COMPLETED,
  P6_EXPLICIT_OPERATION_STATES.FAILED,
]);
const PAUSED = new Set([
  P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART,
  P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN,
  P6_EXPLICIT_OPERATION_STATES.WAITING_FOR_OWNER,
]);

const STATE_LABELS = Object.freeze({
  [P6_EXPLICIT_OPERATION_STATES.READY]: 'Ready to continue',
  [P6_EXPLICIT_OPERATION_STATES.RUNNING]: 'Running while this page is open',
  [P6_EXPLICIT_OPERATION_STATES.WAITING_FOR_OWNER]: 'Paused while another data task finishes',
  [P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN]: 'Paused when Road Sage was hidden',
  [P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART]: 'Paused after Road Sage restarted',
  [P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED]: 'Cancelling and cleaning up safely',
  [P6_EXPLICIT_OPERATION_STATES.CANCELLED]: 'Cancelled',
  [P6_EXPLICIT_OPERATION_STATES.COMPLETED]: 'Completed',
  [P6_EXPLICIT_OPERATION_STATES.FAILED]: 'Needs attention',
});

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

export function buildP6ExplicitOperationView(operation) {
  if (!operation) return {
    state: 'NOT_STARTED',
    stateLabel: 'Not started',
    active: false,
    completed: false,
    failed: false,
    canResume: false,
    canCancel: false,
    progressLabel: 'No durable operation has been started.',
    failureMessage: '',
  };
  const state = String(operation.state || P6_EXPLICIT_OPERATION_STATES.READY);
  const progress = operation.progress || {};
  return {
    state,
    stateLabel: STATE_LABELS[state] || state.replace(/_/g, ' ').toLowerCase(),
    active: !TERMINAL.has(state),
    completed: state === P6_EXPLICIT_OPERATION_STATES.COMPLETED,
    failed: state === P6_EXPLICIT_OPERATION_STATES.FAILED,
    canResume: PAUSED.has(state) || state === P6_EXPLICIT_OPERATION_STATES.READY,
    canCancel: !TERMINAL.has(state) && state !== P6_EXPLICIT_OPERATION_STATES.CANCEL_REQUESTED,
    progressLabel: `${Math.max(0, Number(progress.itemsWorked) || 0)} items · ${formatBytes(progress.bytesWorked)} · ${Math.max(0, Number(progress.turns) || 0)} bounded turns`,
    failureMessage: String(operation.failure?.message || ''),
  };
}

const newestForType = (operations, operationType) => (Array.isArray(operations) ? operations : [])
  .filter((operation) => operation?.type === operationType)
  .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;

/**
 * Foreground presentation for one of the frozen E1-E4 operations. The durable
 * runner remains the sole state machine; this component only asks it for one
 * turn at a time and yields between turns so pause/cancel controls stay live.
 */
export default function P6ExplicitOperationControl({
  operationType,
  title,
  description,
  startLabel = 'Start',
  repeatable = true,
  observedOperation = null,
}) {
  const [operation, setOperation] = useState(
    observedOperation?.type === operationType ? observedOperation : null,
  );
  const [running, setRunning] = useState(false);
  const [controlError, setControlError] = useState('');
  const mountedRef = useRef(true);
  const runningRef = useRef(false);

  const commit = useCallback((value) => {
    if (mountedRef.current) setOperation(value);
    return value;
  }, []);

  const refresh = useCallback(async () => {
    const { listP6ExplicitOperations } = await import('@/lib/p6ExplicitOperations');
    commit(newestForType(await listP6ExplicitOperations(), operationType));
  }, [commit, operationType]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh().catch(() => {});
    const onFocus = () => { void refresh().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (observedOperation?.type === operationType) commit(observedOperation);
  }, [commit, observedOperation, operationType]);

  const drive = useCallback(async ({ restart = false } = {}) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setControlError('');
    try {
      const api = await import('@/lib/p6ExplicitOperations');
      let current = operation;
      if (restart || !current || TERMINAL.has(current.state)) {
        current = await api.startKnownP6ExplicitOperation(operationType);
        commit(current);
      }
      if (PAUSED.has(current.state)) {
        current = await api.resumeP6ExplicitOperation(current.operationId);
        commit(current);
      }
      while (mountedRef.current && !TERMINAL.has(current.state) && !PAUSED.has(current.state)) {
        current = await api.runKnownP6ExplicitOperationTurn(current.operationId);
        commit(current);
        if (!TERMINAL.has(current.state) && !PAUSED.has(current.state)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      if (mountedRef.current) setControlError(error instanceof Error ? error.message : String(error));
      await refresh().catch(() => {});
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  }, [commit, operation, operationType, refresh]);

  const cancel = useCallback(async () => {
    if (!operation?.operationId) return;
    setControlError('');
    try {
      const { cancelP6ExplicitOperation, runKnownP6ExplicitOperationTurn } = await import('@/lib/p6ExplicitOperations');
      let current = await cancelP6ExplicitOperation(operation.operationId);
      commit(current);
      if (!runningRef.current) {
        runningRef.current = true;
        setRunning(true);
        while (mountedRef.current && !TERMINAL.has(current.state) && !PAUSED.has(current.state)) {
          current = await runKnownP6ExplicitOperationTurn(current.operationId);
          commit(current);
          if (!TERMINAL.has(current.state)) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        runningRef.current = false;
        if (mountedRef.current) setRunning(false);
      }
    } catch (error) {
      if (mountedRef.current) setControlError(error instanceof Error ? error.message : String(error));
    }
  }, [commit, operation]);

  const view = useMemo(() => buildP6ExplicitOperationView(operation), [operation]);
  const primaryLabel = running
    ? 'Running…'
    : view.failed
      ? 'Retry'
      : view.canResume
        ? 'Resume'
        : operation
          ? 'Run again'
          : startLabel;
  const showPrimary = !view.completed || repeatable;
  const tone = view.failed
    ? 'border-amber-300 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/20'
    : view.completed
      ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-900/70 dark:bg-emerald-950/20'
      : 'border-border bg-card';

  return (
    <section className={`rounded-xl border p-3 ${tone}`} data-p6-operation={operationType} aria-live="polite">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {running || view.active ? (
              <RefreshCw className={`h-4 w-4 shrink-0 ${running ? 'animate-spin' : ''}`} />
            ) : view.failed ? (
              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-700" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
            )}
            {title}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          <div className="mt-2 text-xs font-semibold">{view.stateLabel}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{view.progressLabel}</div>
          {(view.failureMessage || controlError) && (
            <div className="mt-1 text-xs text-amber-800 dark:text-amber-200" role="alert">
              {view.failureMessage || controlError}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {showPrimary && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={running}
              onClick={() => void drive({ restart: Boolean(operation && TERMINAL.has(operation.state)) })}
            >
              {primaryLabel}
            </Button>
          )}
          {view.canCancel && (
            <Button type="button" size="sm" variant="outline" onClick={() => void cancel()}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
