import { Info } from 'lucide-react';

export const toneStyles = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-200',
  warn: 'border-orange-200 bg-orange-50 text-orange-900 dark:border-orange-900/60 dark:bg-orange-950/25 dark:text-orange-200',
  neutral: 'border-border bg-secondary/35 text-foreground',
};

export const signed = (value, suffix = '') => {
  if (value == null) return 'No comparison';
  return `${value > 0 ? '+' : ''}${value}${suffix}`;
};

export function PanelHeader({ eyebrow, title, description, icon: Icon, action = null }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-primary">
          <Icon className="h-4 w-4" />
          {eyebrow}
        </div>
        <h2 className="mt-2 font-grotesk text-xl font-bold capitalize">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function DeltaBadge({ value, suffix = '' }) {
  const tone = value > 0
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : value < 0
      ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
      : 'bg-secondary text-muted-foreground';
  return (
    <span className={`min-w-16 rounded-full px-2 py-1 text-center font-bold ${tone}`}>
      {value == null ? '?' : signed(value, suffix)}
    </span>
  );
}

export function MiniMetric({ label, value }) {
  return (
    <div className="rounded-2xl bg-secondary/40 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-bold capitalize">{value}</div>
    </div>
  );
}

export function Notice({ text }) {
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-border bg-secondary/25 p-4 text-sm text-muted-foreground">
      {text}
    </div>
  );
}

export function MethodNote({ children }) {
  return (
    <div className="mt-5 flex items-start gap-2 rounded-2xl bg-secondary/40 p-3 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}
