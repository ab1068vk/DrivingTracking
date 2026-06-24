import { RefreshCw } from 'lucide-react';

export default function InlineRefreshBadge({ visible, label = 'Refreshing' }) {
  if (!visible) return null;
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-muted-foreground shadow-sm"
    >
      <RefreshCw className="h-3 w-3 animate-spin" />
      {label}
    </span>
  );
}
