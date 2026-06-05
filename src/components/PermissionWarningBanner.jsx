import { AlertTriangle, RefreshCw } from 'lucide-react';

function formatStatus(status) {
  if (!status || status === 'unknown') return 'Unable to verify';
  if (status === 'not_requested') return 'Not enabled';
  return String(status).replace(/_/g, ' ');
}

export function PermissionWarningBanner({ issues, onRecheck, isChecking = false }) {
  if (!issues.length) return null;

  return (
    <div
      className="rounded-3xl border border-amber-300 bg-amber-50 p-4 text-amber-950 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Background tracking may be unreliable</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {issues.length === 1
                  ? `${issues[0].label} needs attention.`
                  : `${issues.length} tracking requirements need attention.`}
              </p>
            </div>
            <button
              type="button"
              onClick={onRecheck}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-background/80 px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-background disabled:opacity-60 dark:border-amber-800"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              Re-check
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {issues.map((issue) => (
              <details key={issue.id} className="rounded-xl border border-amber-200 bg-background/70 px-3 py-2 text-xs dark:border-amber-900/60">
                <summary className="cursor-pointer font-semibold">
                  {issue.label}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {formatStatus(issue.status)}
                  </span>
                </summary>
                <p className="mt-2 text-muted-foreground">{issue.fixHint}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
