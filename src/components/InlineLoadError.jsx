import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function InlineLoadError({
  visible = true,
  message = 'Could not load this section.',
  onRetry = null,
}) {
  if (!visible) return null;
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-full bg-background/70 px-2 py-0.5 text-[11px] hover:bg-background"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}
