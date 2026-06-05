export function SectionTitle({ children, id }) {
  return <div id={id} className="scroll-mt-24 text-xs font-bold uppercase tracking-widest text-muted-foreground px-1 mb-2 mt-6">{children}</div>;
}

export function SettingRow({ icon: Icon = null, label, sublabel = '', children = null, onClick = null, danger = false }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-3 px-1 border-b border-border/50 last:border-0 ${onClick ? 'cursor-pointer hover:bg-secondary/50 rounded-xl -mx-1 px-2 transition-colors' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {Icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${danger ? 'bg-red-50 dark:bg-red-950/30' : 'bg-secondary'}`}>
            <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-muted-foreground'}`} />
          </div>
        )}
        <div className="min-w-0">
          <div className={`break-words text-sm font-medium ${danger ? 'text-red-600 dark:text-red-400' : ''}`}>{label}</div>
          {sublabel && <div className="mt-0.5 break-words text-xs text-muted-foreground">{sublabel}</div>}
        </div>
      </div>
      <div className="flex-shrink-0 max-w-[46%]">{children}</div>
    </div>
  );
}

export function Toggle({ value, onChange, disabled = false }) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!value); }}
      className={`relative w-12 h-6 rounded-full transition-colors disabled:opacity-50 ${value ? 'bg-primary' : 'bg-secondary border border-border'}`}
    >
      <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${value ? 'left-6' : 'left-0.5'}`} />
    </button>
  );
}

export function PermissionBadge({ value, status, label }) {
  const resolvedStatus = status ?? value ?? 'unknown';
  const granted = resolvedStatus === 'granted';
  const unavailable = resolvedStatus === 'unavailable';
  const denied = resolvedStatus === 'denied';
  const needsSettings = resolvedStatus === 'needs_settings';
  return (
    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
      granted
        ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'
        : unavailable
          ? 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    }`}>
      {granted ? (label ?? 'Granted') : unavailable ? 'Unavailable' : needsSettings ? 'Open Settings' : denied ? 'Denied' : 'Needs setup'}
    </span>
  );
}

export function FeaturePermissionBadge({ value, status, label }) {
  const resolvedStatus = status ?? value;
  if (resolvedStatus == null) return null;
  if (resolvedStatus === 'none') {
    return (
      <span className="rounded-full bg-secondary px-2 py-1 text-xs font-semibold text-muted-foreground">
        No prompt
      </span>
    );
  }
  return <PermissionBadge status={resolvedStatus} label={label} />;
}
