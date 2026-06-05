const BADGE_CONFIG = {
  scored: {
    label: 'Scored',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
    title: 'This event affects your trip score.',
  },
  diagnostic: {
    label: 'Diagnostic',
    className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300',
    title: 'Recorded for your information only - does not affect score.',
  },
  beta: {
    label: 'Beta',
    className: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300',
    title: 'Experimental detection - thresholds are not yet validated.',
  },
};

export function EventStatusBadge({ status }) {
  const cfg = BADGE_CONFIG[status] || BADGE_CONFIG.diagnostic;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cfg.className}`}
      title={cfg.title}
    >
      {cfg.label}
    </span>
  );
}

export { BADGE_CONFIG };
