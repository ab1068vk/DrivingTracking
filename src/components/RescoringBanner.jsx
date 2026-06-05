import { RefreshCw } from 'lucide-react';

export function RescoringBanner({ mismatchCount, onRescore, onDismiss, isRescoring = false }) {
  if (!mismatchCount || mismatchCount < 1) return null;

  return (
    <div className="sticky top-3 z-20 rounded-2xl border border-blue-300 bg-blue-50 p-3 text-sm shadow-sm dark:border-blue-700 dark:bg-blue-950/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-blue-800 dark:text-blue-200">
            {mismatchCount} recent trip{mismatchCount !== 1 ? 's' : ''} use older scoring
          </p>
          <p className="mt-0.5 text-xs text-blue-700 dark:text-blue-300">
            Your settings changed. Re-score to keep your history consistent.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={onRescore}
            disabled={isRescoring}
            className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRescoring ? 'animate-spin' : ''}`} />
            Re-score now
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg px-2 py-0.5 text-xs font-semibold text-blue-600 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/30"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
