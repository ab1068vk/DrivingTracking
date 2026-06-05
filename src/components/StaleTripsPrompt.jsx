import { RefreshCw } from 'lucide-react';

export function StaleTripsPrompt({ staleCount, onRescore, isRescoring }) {
  if (!staleCount) return null;

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 shadow-sm dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between"
      role="status"
      aria-live="polite"
    >
      <div>
        <div className="text-sm font-semibold">
          {staleCount} {staleCount === 1 ? 'trip is' : 'trips are'} out of date
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your scoring settings changed. These trips still reflect older scoring inputs.
        </p>
      </div>
      <button
        type="button"
        onClick={onRescore}
        disabled={isRescoring}
        aria-busy={isRescoring}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRescoring ? 'animate-spin' : ''}`} />
        {isRescoring ? 'Re-scoring...' : 'Update now'}
      </button>
    </div>
  );
}
