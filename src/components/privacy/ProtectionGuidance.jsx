import { ChevronRight } from 'lucide-react';

const REVIEW_STATUSES = new Set(['error', 'warn', 'unknown']);

export function shouldShowProtectionGuidance(status) {
  return REVIEW_STATUSES.has(status);
}

export default function ProtectionGuidance({
  item,
  expanded,
  onToggle,
  onOpenSettings,
  showDeveloperActions = false,
}) {
  if (!shouldShowProtectionGuidance(item?.status)) return null;

  return (
    <div className="basis-full pl-7">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2"
      >
        What should I do?
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="mt-3 rounded-xl border border-current/20 bg-background/60 p-3 text-xs">
          <div className="font-semibold">Why this matters</div>
          <p className="mt-1 opacity-85">{item.riskIfMissing}</p>
          <div className="mt-3 font-semibold">What you can do</div>
          <p className="mt-1 opacity-85">{item.userAction}</p>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-3 rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground"
            >
              Open settings
            </button>
          )}
          {showDeveloperActions && item.developerAction && (
            <div className="mt-3 border-t border-current/15 pt-3">
              <div className="font-semibold">Developer action</div>
              <p className="mt-1 opacity-75">{item.developerAction}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
